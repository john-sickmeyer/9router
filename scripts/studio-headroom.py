#!/usr/bin/env python3
"""Local Headroom adapter: tool JSON only, independently verified before use."""
import argparse
import copy
import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import version

import tiktoken
from headroom import densify
from headroom.transforms.compaction_codec import contains_removal_marker, expand_compacted, is_compacted

MODE = "verified-lossless-v1"
MAX_BYTES = 16 * 1024 * 1024
ENCODING = tiktoken.get_encoding("cl100k_base")
PREFIX = (
    "Lossless JSON table: [N] is row count; schema gives column names/types. "
    "@column=[...] is a dictionary; cells in that column are zero-based indexes. "
    "Rows use CSV escaping and schema types. Empty cells mean missing keys; bare null means JSON null; "
    "quoted empty/null cells mean strings.\n"
)


def reject_number(_value):
    # ponytail: fractional JSON numbers bypass compression until the codec supports Decimal end to end.
    raise ValueError("Non-integer JSON numbers require the original text")


def object_pairs(pairs):
    if len({key for key, _ in pairs}) != len(pairs):
        raise ValueError("Duplicate object keys require the original text")
    return ("object", tuple(sorted(pairs)))


def exact_json(text):
    return json.loads(text, object_pairs_hook=object_pairs,
                      parse_int=lambda value: ("integer", value),
                      parse_float=reject_number, parse_constant=reject_number)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def token_count(text):
    return len(ENCODING.encode(text, disallowed_special=()))


def verified_text(original):
    try:
        expected = exact_json(original)
        if not isinstance(expected, list) or not expected:
            return original
        source = [{"role": "tool", "tool_call_id": "verified", "content": original}]
        result = densify(copy.deepcopy(source), model="gpt-4o", model_limit=128000, protect_recent=0)
        candidate = result.messages[0]["content"]
        if not result.lossless or not is_compacted(candidate) or contains_removal_marker(candidate):
            return original
        expanded = expand_compacted(candidate)
        if exact_json(json.dumps(expanded, ensure_ascii=True, allow_nan=False)) != expected:
            return original
        candidate = PREFIX + candidate
        if len(candidate.encode("utf-8")) >= len(original.encode("utf-8")):
            return original
        if token_count(candidate) >= token_count(original):
            return original
        return candidate
    except Exception:
        return original


def compress(payload):
    messages = payload.get("messages")
    if payload.get("verification") != MODE or not isinstance(messages, list) or len(messages) > 1024:
        raise ValueError("Expected verified tool messages")
    for message in messages:
        if (not isinstance(message, dict) or set(message) != {"role", "tool_call_id", "content"}
                or message["role"] != "tool" or not isinstance(message["tool_call_id"], str)
                or not isinstance(message["content"], str)):
            raise ValueError("Expected tool message with string ID and content")
    output, proofs = [], []
    before = after = 0
    for message in messages:
        original = message["content"]
        candidate = verified_text(original)
        output.append({**message, "content": candidate})
        proofs.append({"original_sha256": digest(original), "compressed_sha256": digest(candidate)})
        before += token_count(original)
        after += token_count(candidate)
    return {"messages": output, "verification": MODE, "proofs": proofs,
            "tokens_before": before, "tokens_after": after, "tokens_saved": before - after,
            "tokenizer": "cl100k_base", "lossless": True}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, data):
        encoded = json.dumps(data, ensure_ascii=True, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": "Not found"})
            return
        self.reply(200, {"status": "healthy", "mode": MODE, "version": version("headroom-ai"),
                         "checks": {"kompress": {"enabled": False}, "code_aware": {"enabled": False}}})

    def do_POST(self):
        if self.path != "/v1/compress":
            self.reply(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BYTES:
                self.reply(413, {"error": "Invalid request size"})
                return
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected object")
            result = compress(payload)
        except (ValueError, TypeError):
            self.reply(400, {"error": "Invalid verified compression request"})
            return
        except Exception:
            self.reply(503, {"error": "Compression unavailable; retain original"})
            return
        self.reply(200, result)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    # Warm the deterministic pipeline before advertising readiness.
    verified_text(json.dumps([{"id": i, "status": "ready"} for i in range(100)]))
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
