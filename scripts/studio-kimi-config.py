#!/usr/bin/env python3
"""Generate the isolated Kimi Code config used by Happier's 9Router profile.

Usage: studio-kimi-config.py /absolute/path/config.toml
The profile supplies KIMI_CODE_HOME and the existing router auth environment.
Provider credentials stay in 9Router; this file contains no API key.
"""
import json
import os
import pathlib
import re
import sys


def build_config(source):
    models = re.findall(r'id: "(moonshot/[^\"]+)", provider: "moonshot", name: "([^\"]+)"', source)
    efforts = re.search(r'MOONSHOT_K3_EFFORTS = (\[[^;]+\]);', source)
    context = re.search(r'MOONSHOT_K3_CONTEXT = (\d+);', source)
    if len(models) != 2 or not efforts or not context:
        raise ValueError("Kimi model metadata is incomplete")
    levels = json.loads(efforts[1])
    if "high" not in levels:
        raise ValueError("Kimi's default thinking level is missing")
    lines = [
        '# Kimi API Platform through the Happier 9Router profile.',
        f'default_model = {json.dumps(models[0][0])}',
        'telemetry = false', '', '[providers.studio-router]',
        'type = "kimi"', 'base_url = "http://127.0.0.1:20128/v1"',
        'api_key_env = "ANTHROPIC_AUTH_TOKEN"', '', '[thinking]',
        'enabled = true', 'effort = "high"',
    ]
    for model, name in models:
        lines += [
            '', f'[models.{json.dumps(model)}]', 'provider = "studio-router"',
            f'model = {json.dumps(model)}', f'display_name = {json.dumps(name)}',
            f'max_context_size = {int(context[1])}',
            'capabilities = ["thinking", "always_thinking", "image_in", "tool_use"]',
            f'support_efforts = {json.dumps(levels)}', 'default_effort = "high"',
        ]
    return '\n'.join(lines) + '\n'


def main():
    destination, = sys.argv[1:]
    path = pathlib.Path(destination)
    if not path.is_absolute():
        raise SystemExit("Destination must be absolute")
    root = pathlib.Path(__file__).resolve().parents[1]
    content = build_config((root / "open-sse/config/moonshot.js").read_text())
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(content)
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    print(json.dumps({"path": str(path), "agent": "kimi", "credentialSource": "9Router profile environment"}))


if __name__ == "__main__":
    main()
