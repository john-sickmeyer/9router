"""Run with the Headroom venv: python -m unittest discover -s tests/python -p test_headroom_lossless.py."""
import importlib.util
import json
import os
import pathlib
import unittest
import urllib.request
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verified", pathlib.Path(__file__).resolve().parents[2] / "scripts/studio-headroom.py")
verified = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verified)


class LosslessTests(unittest.TestCase):
    def restore(self, text):
        if text.startswith(verified.PREFIX):
            return verified.expand_compacted(text[len(verified.PREFIX):])
        return json.loads(text)

    def test_2050_invoices_and_exact_total(self):
        rows = [{"invoice_id": f"INV-{i + 1:06d}", "amount_usd": "100.00",
                 "quantity": 1, "location": "MAIN", "status": "posted"} for i in range(2050)]
        original = json.dumps(rows, indent=2)
        payload = {"verification": verified.MODE, "messages": [
            {"role": "tool", "tool_call_id": "ledger", "content": original}]}
        if os.environ.get("HEADROOM_TEST_URL"):
            request = urllib.request.Request(os.environ["HEADROOM_TEST_URL"] + "/v1/compress",
                json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=3) as response:
                result = json.load(response)
        else:
            result = verified.compress(payload)
        restored = self.restore(result["messages"][0]["content"])
        self.assertEqual(restored, rows)
        self.assertEqual(len(restored), 2050)
        self.assertEqual(sum(Decimal(row["amount_usd"]) for row in restored), Decimal("205000.00"))
        self.assertGreater(result["tokens_saved"] / result["tokens_before"], 0.65)
        self.assertEqual(result["proofs"][0]["original_sha256"], verified.digest(original))
        print({key: result[key] for key in ("tokens_before", "tokens_after", "tokens_saved")})

    def test_duplicates_types_unicode_nested_and_large_integers(self):
        cases = [
            {"amount": "12345678901234567890.1234567890", "quantity": 9007199254740993},
            {"a": True, "b": False, "c": None, "d": "", "e": "null", "f": "001.00"},
            {"text": 'a,"b"\nline\r\n\u00e9\U0001f600', "nested": {"amount": "-0.00", "items": [1, None, False]}},
            {"a.b": "literal dot", "a": {"b": "nested"}},
            {"a": None}, {}, {"a": "@status=[0]"},
        ]
        for row in cases:
            with self.subTest(row=row):
                rows = [row] * 100
                original = json.dumps(rows, indent=2)
                actual = self.restore(verified.verified_text(original))
                self.assertEqual(verified.exact_json(json.dumps(actual)), verified.exact_json(original))

    def test_ambiguous_numbers_and_keys_preserve_original_bytes(self):
        for row in ['{"amount":0.1}', '{"amount":100.00}', '{"amount":1e1000}',
                    '{"amount":0.123456789012345678901}', '{"a":1,"a":2}',
                    '{"a":NaN}', '{"a":Infinity}']:
            original = "[" + ",".join([row] * 100) + "]"
            self.assertEqual(verified.verified_text(original), original)
        for text in ["plain text\n" * 100, '[{"bad":}]', 'null', '[]', '']:
            self.assertEqual(verified.verified_text(text), text)

    def test_verifier_rejects_mutation_truncation_and_type_changes(self):
        original = json.dumps([{"value": 1}] * 100, indent=2)
        for candidate in ["[99]{value:int}\n" + "1\n" * 99,
                          "[100]{value:bool}\n" + "true\n" * 100,
                          "[100]{value:int}\n" + "2\n" * 100,
                          "[100]{value:int} __dropped:1\n" + "1\n" * 100,
                          "<<ccr:missing>>", "malformed"]:
            fake = SimpleNamespace(messages=[{"content": candidate}], lossless=True)
            with patch.object(verified, "densify", return_value=fake):
                self.assertEqual(verified.verified_text(original), original)
        with patch.object(verified, "densify", side_effect=RuntimeError("offline")):
            self.assertEqual(verified.verified_text(original), original)

    def test_request_boundary(self):
        for payload in [{}, {"verification": verified.MODE, "messages": [
                {"role": "user", "tool_call_id": "x", "content": "private"}]},
                {"verification": verified.MODE, "messages": [None]}]:
            with self.assertRaises(ValueError):
                verified.compress(payload)

    def test_no_inflation(self):
        original = '[{"value":1}]'
        fake = SimpleNamespace(messages=[{"content": "[1]{value:int}\n1"}], lossless=True)
        with patch.object(verified, "densify", return_value=fake):
            self.assertEqual(verified.verified_text(original), original)


if __name__ == "__main__":
    unittest.main()
