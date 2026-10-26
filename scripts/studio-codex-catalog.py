#!/usr/bin/env python3
"""Write two Codex model families with three speed choices from the official CLI catalog.

Usage: studio-codex-catalog.py 0.162.1 /absolute/path/models.json
Run again when upgrading the Studio's Codex CLI. Existing output is replaced
only after both complete model entries have been found and validated.
"""
import copy
import json
import pathlib
import re
import sys
import urllib.request

def build_catalog(catalog, config):
    # The central Studio config owns membership and speeds. Clone full native
    # metadata so aliases retain tools, instructions, context, and effort support.
    models = re.findall(r'id: "cx/([^"]+)", provider: "codex", name: "([^"]+)"', config)
    speed_match = re.search(r'STUDIO_CODEX_PICKER_SPEEDS = (\[[^;]+\]);', config)
    if not speed_match:
        raise ValueError("Studio picker speeds are missing")
    speeds = json.loads(speed_match[1])
    available = {model["slug"]: model for model in catalog["models"]}
    if len(models) != 2 or any(slug not in available for slug, _ in models):
        raise ValueError("The matching Codex release does not contain both Studio models")
    selected = []
    for slug, name in models:
        original = available[slug]
        if not original.get("supported_reasoning_levels"):
            raise ValueError("Codex model metadata is incomplete")
        for speed in speeds:
            entry = copy.deepcopy(original)
            entry["slug"] = f"{slug}@{speed}"
            entry["display_name"] = name if speed == "standard" else f"{name} {speed.capitalize()}"
            entry["description"] = f"{speed.capitalize()} speed via 9Router. Choose Thinking separately."
            entry["priority"] = len(selected) + 1
            # The alias selects speed. Do not expose a second, conflicting speed
            # control or let a catalog default override the router selection.
            entry["default_service_tier"] = None
            entry["service_tiers"] = []
            entry["additional_speed_tiers"] = []
            selected.append(entry)
    return {"models": selected}


def main():
    version, destination = sys.argv[1:]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Expected a stable Codex CLI version such as 0.162.1")
    path = pathlib.Path(destination)
    if not path.is_absolute():
        raise SystemExit("Destination must be absolute")
    source = f"https://raw.githubusercontent.com/openai/codex/rust-v{version}/codex-rs/models-manager/models.json"
    with urllib.request.urlopen(source, timeout=30) as response:
        catalog = json.load(response)
    root = pathlib.Path(__file__).resolve().parents[1]
    config = (root / "open-sse/config/studioControls.js").read_text()
    selected = build_catalog(catalog, config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(json.dumps(selected, indent=2) + "\n")
    temporary.replace(path)
    print(json.dumps({"source": source, "path": str(path), "models": [m["slug"] for m in selected["models"]]}))


if __name__ == "__main__":
    main()
