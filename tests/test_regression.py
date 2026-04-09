"""Tests de non-régression — compare le pipeline actuel aux golden files."""

import numpy as np
import pytest
from pathlib import Path
from PIL import Image

from backend.app import extract_signature, detect_presets

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

# Max average per-pixel difference tolerated (accounts for float rounding)
TOLERANCE = 1.0  # out of 255


def _fixture_ids():
    """List fixture base names that have a corresponding golden file."""
    if not GOLDEN_DIR.exists():
        return []
    golden_names = {f.stem for f in GOLDEN_DIR.glob("*.png")}
    fixtures = []
    for f in sorted(FIXTURES_DIR.glob("*")):
        if f.is_file() and f.stem in golden_names:
            fixtures.append(f)
    return fixtures


def _process(path):
    """Same pipeline as regenerate_golden.py."""
    img = Image.open(path).convert("RGB")
    presets = detect_presets(img)
    mode = presets["mode"]
    steps = [(s["effect"], s["value"]) for s in presets["steps"]]
    result, _ = extract_signature(img, mode=mode, steps=steps)
    return result


@pytest.fixture(params=_fixture_ids(), ids=lambda p: p.stem)
def fixture_path(request):
    return request.param


class TestRegression:
    def test_output_matches_golden(self, fixture_path):
        golden_path = GOLDEN_DIR / (fixture_path.stem + ".png")
        assert golden_path.exists(), f"Golden file missing: {golden_path.name}"

        result = _process(fixture_path)
        golden = Image.open(golden_path)

        # Dimensions must match exactly
        assert result.size == golden.size, (
            f"Size mismatch: {result.size} vs golden {golden.size}"
        )

        # Compare pixel data
        result_px = np.array(result, dtype=np.float64)
        golden_px = np.array(golden, dtype=np.float64)
        diff = np.abs(result_px - golden_px).mean()

        assert diff <= TOLERANCE, (
            f"{fixture_path.name}: mean pixel diff = {diff:.2f} "
            f"(tolerance = {TOLERANCE})"
        )
