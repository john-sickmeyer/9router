#!/usr/bin/env python3
"""Write the two-model Codex catalog from the matching official CLI release.

Usage: studio-codex-catalog.py 0.162.1 /absolute/path/models.json
Run again when upgrading the Studio's Codex CLI. Existing output is replaced
only after both complete model entries have been found and validated.
"""
import json
import pathlib
import re
import sys
import urllib.request

version, destination = sys.argv[1:]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("Expected a stable Codex CLI version such as 0.162.1")
source = f"https://raw.githubusercontent.com/openai/codex/rust-v{version}/codex-rs/models-manager/models.json"
with urllib.request.urlopen(source, timeout=30) as response:
    catalog = json.load(response)
root = pathlib.Path(__file__).resolve().parents[1]
config = (root / "open-sse/config/studioControls.js").read_text()
# The central Studio catalog owns membership; preserve all native metadata.
slugs = re.findall(r'id: "cx/([^"]+)", provider: "codex"', config)
available = {model["slug"]: model for model in catalog["models"]}
if len(slugs) != 2 or any(slug not in available for slug in slugs):
    raise SystemExit("The matching Codex release does not contain both Studio models")
selected = [available[slug] for slug in slugs]
if any(not model.get("supported_reasoning_levels") for model in selected):
    raise SystemExit("Codex model metadata is incomplete")
path = pathlib.Path(destination)
if not path.is_absolute():
    raise SystemExit("Destination must be absolute")
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_suffix(path.suffix + ".next")
temporary.write_text(json.dumps({"models": selected}, indent=2) + "\n")
temporary.replace(path)
print(json.dumps({"source": source, "path": str(path), "models": slugs}))
