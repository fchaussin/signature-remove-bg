"""Niveau C — Tests d'intégration des endpoints API via TestClient."""

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import app


@pytest.fixture
def client():
    return TestClient(app)


def _upload(client, endpoint, image_bytes, filename="test.png", **params):
    """Helper: POST multipart upload."""
    return client.post(
        endpoint,
        files={"file": (filename, io.BytesIO(image_bytes), "image/png")},
        params=params,
    )


# ── GET /health ──────────────────────────────────────────────────────────────

class TestHealth:
    def test_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# ── GET /config ──────────────────────────────────────────────────────────────

class TestConfig:
    def test_returns_expected_keys(self, client):
        resp = client.get("/config")
        assert resp.status_code == 200
        data = resp.json()
        for key in ("version", "warnings", "mode", "format", "render_mode", "steps", "max_steps"):
            assert key in data, f"Missing key: {key}"

    def test_warnings_is_list(self, client):
        data = client.get("/config").json()
        assert isinstance(data["warnings"], list)

    def test_warnings_have_level_and_key(self, client):
        data = client.get("/config").json()
        for w in data["warnings"]:
            assert "level" in w
            assert "key" in w
            assert w["level"] in ("warning", "danger")

    def test_steps_structure(self, client):
        data = client.get("/config").json()
        for step in data["steps"]:
            assert "effect" in step
            assert "value" in step

    def test_cache_header(self, client):
        resp = client.get("/config")
        assert "max-age" in resp.headers.get("cache-control", "")


# ── POST /extract ────────────────────────────────────────────────────────────

class TestExtract:
    def test_valid_image_returns_png(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        # Verify the response is a valid PNG
        img = Image.open(io.BytesIO(resp.content))
        assert img.mode == "RGBA"

    def test_output_dimensions_match_input(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes)
        img = Image.open(io.BytesIO(resp.content))
        assert img.size == (100, 100)

    def test_webp_format(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes, format="webp")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/webp"

    def test_base64_output(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes, output="base64")
        assert resp.status_code == 200
        data = resp.json()
        assert "base64" in data
        assert data["base64"].startswith("data:image/png;base64,")

    def test_no_file_returns_422(self, client):
        """FastAPI returns 422 when required file is missing."""
        resp = client.post("/extract")
        assert resp.status_code == 422

    def test_invalid_file_returns_400(self, client):
        resp = _upload(client, "/extract", b"not an image", filename="bad.png")
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_FILE"

    def test_dark_mode(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes, mode="dark")
        assert resp.status_code == 200

    def test_blue_mode(self, client, blue_stroke_png_bytes):
        resp = _upload(client, "/extract", blue_stroke_png_bytes, mode="blue")
        assert resp.status_code == 200

    def test_custom_steps(self, client, dark_stroke_png_bytes):
        resp = _upload(
            client, "/extract", dark_stroke_png_bytes,
            steps="threshold:200,smoothing:50",
        )
        assert resp.status_code == 200

    def test_rgba_input_accepted(self, client, rgba_png_bytes):
        resp = _upload(client, "/extract", rgba_png_bytes)
        assert resp.status_code == 200
        assert "x-alpha-composited" in resp.headers

    def test_no_cache_header(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/extract", dark_stroke_png_bytes)
        assert resp.headers.get("cache-control") == "no-store"


# ── POST /analyze ────────────────────────────────────────────────────────────

class TestAnalyze:
    def test_valid_image_returns_presets(self, client, dark_stroke_png_bytes):
        resp = _upload(client, "/analyze", dark_stroke_png_bytes)
        assert resp.status_code == 200
        data = resp.json()
        assert "mode" in data
        assert "steps" in data

    def test_mode_is_valid(self, client, dark_stroke_png_bytes):
        data = _upload(client, "/analyze", dark_stroke_png_bytes).json()
        assert data["mode"] in ("auto", "dark", "blue")

    def test_steps_have_valid_effects(self, client, dark_stroke_png_bytes):
        data = _upload(client, "/analyze", dark_stroke_png_bytes).json()
        valid = {"threshold", "blue_tolerance", "contrast", "smoothing"}
        for step in data["steps"]:
            assert step["effect"] in valid

    def test_invalid_file_returns_400(self, client):
        resp = _upload(client, "/analyze", b"garbage data", filename="bad.png")
        assert resp.status_code == 400

    def test_blue_image_analysis(self, client, blue_stroke_png_bytes):
        data = _upload(client, "/analyze", blue_stroke_png_bytes).json()
        assert data["mode"] in ("auto", "blue")


# ── Edge cases ───────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_max_pipeline_steps(self, client, dark_stroke_png_bytes):
        """7 steps (max) should be accepted."""
        steps = ",".join(["threshold:200"] * 7)
        resp = _upload(client, "/extract", dark_stroke_png_bytes, steps=steps)
        assert resp.status_code == 200

    def test_over_max_pipeline_falls_back(self, client, dark_stroke_png_bytes):
        """8 steps (over max) → invalid, falls back to defaults, still 200."""
        steps = ",".join(["threshold:200"] * 8)
        resp = _upload(client, "/extract", dark_stroke_png_bytes, steps=steps)
        assert resp.status_code == 200  # falls back to defaults

    def test_bmp_input(self, client):
        """BMP format accepted via /extract."""
        buf = io.BytesIO()
        Image.new("RGB", (10, 10), (30, 30, 30)).save(buf, format="BMP")
        resp = _upload(client, "/extract", buf.getvalue(), filename="test.bmp")
        assert resp.status_code == 200

    def test_tiff_input(self, client):
        """TIFF format accepted via /extract."""
        buf = io.BytesIO()
        Image.new("RGB", (10, 10), (30, 30, 30)).save(buf, format="TIFF")
        resp = _upload(client, "/extract", buf.getvalue(), filename="test.tiff")
        assert resp.status_code == 200

    def test_empty_steps_uses_defaults(self, client, dark_stroke_png_bytes):
        """Empty steps string → server defaults."""
        resp = _upload(client, "/extract", dark_stroke_png_bytes, steps="")
        assert resp.status_code == 200

    def test_oversized_image_needs_crop(self, client):
        """Image exceeding MAX_PROCESS_PIXELS → IMAGE_NEEDS_CROP."""
        import backend.app as app_module
        original = app_module.MAX_PROCESS_PIXELS
        try:
            # Set limit very low so our 10x10 test image exceeds it
            app_module.MAX_PROCESS_PIXELS = 50
            buf = io.BytesIO()
            Image.new("RGB", (10, 10), (30, 30, 30)).save(buf, format="PNG")
            resp = _upload(client, "/extract", buf.getvalue())
            assert resp.status_code == 400
            assert resp.json()["code"] == "IMAGE_NEEDS_CROP"
        finally:
            app_module.MAX_PROCESS_PIXELS = original

    def test_oversized_image_analyze_needs_crop(self, client):
        """Analyze also blocked by MAX_PROCESS_PIXELS."""
        import backend.app as app_module
        original = app_module.MAX_PROCESS_PIXELS
        try:
            app_module.MAX_PROCESS_PIXELS = 50
            buf = io.BytesIO()
            Image.new("RGB", (10, 10), (30, 30, 30)).save(buf, format="PNG")
            resp = _upload(client, "/analyze", buf.getvalue())
            assert resp.status_code == 400
            assert resp.json()["code"] == "IMAGE_NEEDS_CROP"
        finally:
            app_module.MAX_PROCESS_PIXELS = original
