"""Niveau B — Tests unitaires de validation des entrées."""

import asyncio
import io

import numpy as np
import pytest
from PIL import Image
from unittest.mock import AsyncMock

from backend.app import (
    open_image,
    read_upload,
    _parse_steps,
    _clamp,
    MAX_UPLOAD_BYTES,
    MAX_IMAGE_DIMENSION,
    PARAM_RANGES,
    VALID_EFFECTS,
    MAX_PIPELINE_STEPS,
)


# ── open_image ───────────────────────────────────────────────────────────────

class TestOpenImage:
    def test_valid_png(self, tiny_png_bytes):
        img, err = open_image(tiny_png_bytes, "test.png")
        assert img is not None
        assert err is None

    def test_valid_jpeg(self, tiny_jpg_bytes):
        img, err = open_image(tiny_jpg_bytes, "test.jpg")
        assert img is not None
        assert err is None

    def test_valid_webp(self):
        buf = io.BytesIO()
        Image.new("RGB", (10, 10), (255, 255, 255)).save(buf, format="WEBP")
        img, err = open_image(buf.getvalue(), "test.webp")
        assert img is not None
        assert err is None

    def test_invalid_magic_bytes(self):
        img, err = open_image(b"not an image at all", "fake.png")
        assert img is None
        assert err == "INVALID_FILE"

    def test_empty_bytes(self):
        img, err = open_image(b"", "empty.png")
        assert img is None
        assert err == "INVALID_FILE"

    def test_truncated_png(self):
        """PNG header but truncated body."""
        img, err = open_image(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, "broken.png")
        assert img is None
        assert err == "INVALID_FILE"

    def test_oversized_dimension(self):
        """Image exceeding MAX_IMAGE_DIMENSION."""
        big = Image.new("RGB", (MAX_IMAGE_DIMENSION + 1, 10), (255, 255, 255))
        buf = io.BytesIO()
        big.save(buf, format="PNG")
        img, err = open_image(buf.getvalue(), "big.png")
        assert img is None
        assert err == "IMAGE_TOO_LARGE"


# ── read_upload ──────────────────────────────────────────────────────────────

class TestReadUpload:
    def _make_upload(self, data: bytes):
        """Create a mock UploadFile that yields data in chunks."""
        mock = AsyncMock()
        chunks = [data[i:i+1024] for i in range(0, len(data), 1024)]
        chunks.append(b"")  # EOF
        mock.read = AsyncMock(side_effect=chunks)
        return mock

    def test_small_file_ok(self):
        data = b"x" * 100
        mock = self._make_upload(data)
        result = asyncio.get_event_loop().run_until_complete(
            read_upload(mock, "small.bin")
        )
        assert result == data

    def test_empty_file(self):
        mock = self._make_upload(b"")
        result = asyncio.get_event_loop().run_until_complete(
            read_upload(mock, "empty.bin")
        )
        assert result == b""

    def test_oversized_file_returns_none(self):
        """File larger than MAX_UPLOAD_BYTES should return None."""
        mock = AsyncMock()
        # Return one huge chunk that exceeds the limit
        mock.read = AsyncMock(side_effect=[b"x" * (MAX_UPLOAD_BYTES + 1), b""])
        result = asyncio.get_event_loop().run_until_complete(
            read_upload(mock, "huge.bin")
        )
        assert result is None


# ── _parse_steps ─────────────────────────────────────────────────────────────

class TestParseSteps:
    def test_valid_single_step(self):
        result = _parse_steps("threshold:200")
        assert result == [("threshold", 200)]

    def test_valid_multiple_steps(self):
        result = _parse_steps("threshold:200,smoothing:30,contrast:10")
        assert len(result) == 3

    def test_empty_string_returns_none(self):
        assert _parse_steps("") is None

    def test_unknown_effect_returns_none(self):
        assert _parse_steps("unknown_effect:50") is None

    def test_missing_colon_returns_none(self):
        assert _parse_steps("threshold200") is None

    def test_non_numeric_value_returns_none(self):
        assert _parse_steps("threshold:abc") is None

    def test_value_below_range_returns_none(self):
        rng = PARAM_RANGES["threshold"]
        assert _parse_steps(f"threshold:{rng['min'] - 1}") is None

    def test_value_above_range_returns_none(self):
        rng = PARAM_RANGES["threshold"]
        assert _parse_steps(f"threshold:{rng['max'] + 1}") is None

    def test_too_many_steps_returns_none(self):
        steps = ",".join(f"threshold:{150}" for _ in range(MAX_PIPELINE_STEPS + 1))
        assert _parse_steps(steps) is None

    def test_duplicate_effects_allowed(self):
        """Same effect can appear multiple times (by design)."""
        result = _parse_steps("threshold:200,threshold:180")
        assert result is not None
        assert len(result) == 2

    def test_all_valid_effects_accepted(self):
        parts = [f"{name}:{PARAM_RANGES[name]['default']}" for name in VALID_EFFECTS]
        result = _parse_steps(",".join(parts))
        assert result is not None
        assert len(result) == len(VALID_EFFECTS)


# ── _clamp ───────────────────────────────────────────────────────────────────

class TestClamp:
    def test_within_range(self):
        assert _clamp(100, "threshold") == 100

    def test_below_min(self):
        rng = PARAM_RANGES["threshold"]
        assert _clamp(0, "threshold") == rng["min"]

    def test_above_max(self):
        rng = PARAM_RANGES["threshold"]
        assert _clamp(999, "threshold") == rng["max"]

    def test_at_boundaries(self):
        rng = PARAM_RANGES["smoothing"]
        assert _clamp(rng["min"], "smoothing") == rng["min"]
        assert _clamp(rng["max"], "smoothing") == rng["max"]
