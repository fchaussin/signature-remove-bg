#!/usr/bin/env python3
"""
Regenerate golden files from fixtures using auto-detected presets.

Run from project root:  python3 tests/regenerate_golden.py

Each fixture image is processed with detect_presets() → extract_signature().
The output PNG is saved in tests/golden/ with the same base name.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image
from backend.app import extract_signature, detect_presets

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"


def process_fixture(path):
    """Load image, auto-detect, extract, return result."""
    img = Image.open(path).convert("RGB")
    presets = detect_presets(img)
    mode = presets["mode"]
    steps = [(s["effect"], s["value"]) for s in presets["steps"]]
    result, _ = extract_signature(img, mode=mode, steps=steps)
    return result


def main():
    GOLDEN_DIR.mkdir(exist_ok=True)
    fixtures = sorted(FIXTURES_DIR.glob("*"))
    fixtures = [f for f in fixtures if f.is_file() and f.suffix.lower() in (
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".avif",
    )]

    if not fixtures:
        print("No fixture images found.")
        return

    print(f"Regenerating {len(fixtures)} golden files...\n")

    for path in fixtures:
        name = path.stem + ".png"
        out = GOLDEN_DIR / name
        try:
            result = process_fixture(path)
            result.save(out, format="PNG")
            w, h = result.size
            print(f"  {name:<40} {w}x{h}")
        except Exception as e:
            print(f"  {name:<40} ERROR: {e}")

    print(f"\nGolden files written to {GOLDEN_DIR}")


if __name__ == "__main__":
    main()
