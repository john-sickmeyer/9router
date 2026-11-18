#!/usr/bin/env python3
"""Generate a Studio Kimi profile from 9Router's model definitions."""
import os
from pathlib import Path
import sys

if __name__ == "__main__":
    entry = Path(__file__).with_suffix(".mjs")
    os.execvp("node", ["node", str(entry), *sys.argv[1:]])
