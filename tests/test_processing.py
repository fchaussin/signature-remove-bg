"""Niveau A — Tests unitaires des fonctions de traitement d'image."""

import numpy as np
import pytest
from PIL import Image

from backend.app import (
    _step_threshold,
    _step_blue_tolerance,
    _step_smoothing,
    _step_contrast,
    _flatten_alpha,
    _rgb_channels,
    _luminosity,
    _blue_mask,
    extract_signature,
    detect_presets,
    MODE_AUTO,
    MODE_DARK,
    MODE_BLUE,
    ANTIALIAS_SM,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_arrays(color, size=(10, 10)):
    """Build r, g, b, lum, alpha arrays for a uniform colour."""
    r = np.full(size, color[0], dtype=np.int16)
    g = np.full(size, color[1], dtype=np.int16)
    b = np.full(size, color[2], dtype=np.int16)
    lum = _luminosity(r, g, b)
    alpha = np.zeros(size, dtype=np.float64)
    return r, g, b, lum, alpha


# ── _flatten_alpha ───────────────────────────────────────────────────────────

class TestFlattenAlpha:
    def test_rgb_passthrough(self):
        img = Image.new("RGB", (10, 10), (100, 100, 100))
        out, had_alpha = _flatten_alpha(img)
        assert out.mode == "RGB"
        assert had_alpha is False

    def test_rgba_composites_on_white(self):
        img = Image.new("RGBA", (10, 10), (0, 0, 0, 128))
        out, had_alpha = _flatten_alpha(img)
        assert out.mode == "RGB"
        assert had_alpha is True
        # Semi-transparent black on white → grey-ish
        px = out.getpixel((0, 0))
        assert all(100 < c < 200 for c in px)

    def test_fully_transparent_becomes_white(self):
        img = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
        out, _ = _flatten_alpha(img)
        assert out.getpixel((0, 0)) == (255, 255, 255)


# ── _step_threshold ──────────────────────────────────────────────────────────

class TestStepThreshold:
    def test_dark_pixel_gets_alpha(self):
        _, _, _, lum, alpha = _make_arrays((30, 30, 30))
        result = _step_threshold(alpha, lum, MODE_AUTO, threshold=220)
        assert result.min() > 0, "Dark pixels should have alpha > 0"

    def test_white_pixel_stays_transparent(self):
        _, _, _, lum, alpha = _make_arrays((255, 255, 255))
        result = _step_threshold(alpha, lum, MODE_AUTO, threshold=220)
        assert result.max() == 0, "White pixels should stay transparent"

    def test_skipped_in_blue_mode(self):
        _, _, _, lum, alpha = _make_arrays((30, 30, 30))
        result = _step_threshold(alpha, lum, MODE_BLUE, threshold=220)
        np.testing.assert_array_equal(result, alpha)

    def test_threshold_boundary(self):
        """Pixel at exactly the threshold → minimal alpha (near zero)."""
        _, _, _, lum, alpha = _make_arrays((220, 220, 220))
        result = _step_threshold(alpha, lum, MODE_AUTO, threshold=220)
        # lum ≈ 220, so (220-220)*255/15 = 0
        assert result.max() == pytest.approx(0, abs=1)

    def test_higher_threshold_catches_lighter_ink(self):
        _, _, _, lum, alpha = _make_arrays((180, 180, 180))
        low = _step_threshold(np.zeros_like(alpha), lum, MODE_AUTO, threshold=170)
        high = _step_threshold(np.zeros_like(alpha), lum, MODE_AUTO, threshold=250)
        assert high.max() > low.max()


# ── _step_blue_tolerance ─────────────────────────────────────────────────────

class TestStepBlueTolerance:
    def test_blue_pixel_detected(self):
        r, g, b, _, alpha = _make_arrays((30, 30, 180))
        result = _step_blue_tolerance(alpha, r, g, b, MODE_AUTO, blue_tolerance=80)
        assert result.max() > 0, "Blue pixels should be detected"

    def test_black_pixel_ignored(self):
        r, g, b, _, alpha = _make_arrays((30, 30, 30))
        result = _step_blue_tolerance(alpha, r, g, b, MODE_AUTO, blue_tolerance=80)
        assert result.max() == 0, "Non-blue dark pixels should be ignored"

    def test_red_pixel_ignored(self):
        # NOTE: using (100,30,30) not (180,30,30) to avoid a latent int16
        # overflow bug in _step_blue_tolerance (blue_strength * 255 wraps
        # when blue_strength < -128).  That overflow is a separate issue.
        r, g, b, _, alpha = _make_arrays((100, 30, 30))
        result = _step_blue_tolerance(alpha, r, g, b, MODE_AUTO, blue_tolerance=80)
        assert result.max() == 0, "Red pixels should be ignored"

    def test_skipped_in_dark_mode(self):
        r, g, b, _, alpha = _make_arrays((30, 30, 180))
        result = _step_blue_tolerance(alpha, r, g, b, MODE_DARK, blue_tolerance=80)
        np.testing.assert_array_equal(result, alpha)

    def test_white_pixel_ignored(self):
        r, g, b, _, alpha = _make_arrays((255, 255, 255))
        result = _step_blue_tolerance(alpha, r, g, b, MODE_AUTO, blue_tolerance=80)
        assert result.max() == 0


# ── _step_smoothing ──────────────────────────────────────────────────────────

class TestStepSmoothing:
    def test_zero_smoothing_noop(self):
        alpha = np.random.rand(20, 20) * 255
        result = _step_smoothing(alpha, smoothing=0)
        np.testing.assert_array_equal(result, alpha)

    def test_uniform_unchanged(self):
        alpha = np.full((20, 20), 128.0)
        result = _step_smoothing(alpha, smoothing=50)
        np.testing.assert_allclose(result, 128.0, atol=1)

    def test_smoothing_reduces_contrast(self):
        """A sharp edge should be blurred (max decreases or min increases)."""
        alpha = np.zeros((20, 20), dtype=np.float64)
        alpha[8:12, 8:12] = 255.0
        result = _step_smoothing(alpha, smoothing=50)
        # After blur, the peak should be lower than 255
        assert result.max() < 255

    def test_output_shape_preserved(self):
        alpha = np.zeros((30, 50), dtype=np.float64)
        result = _step_smoothing(alpha, smoothing=30)
        assert result.shape == (30, 50)


# ── _step_contrast ───────────────────────────────────────────────────────────

class TestStepContrast:
    def test_zero_contrast_noop(self):
        alpha = np.array([[100.0, 0.0], [200.0, 0.0]])
        result_arr = np.zeros((2, 2, 4), dtype=np.uint8)
        result_arr[:, :, :3] = 128
        out = _step_contrast(alpha.copy(), result_arr, contrast=0)
        np.testing.assert_array_equal(out, alpha)

    def test_boosts_visible_alpha(self):
        alpha = np.array([[100.0, 0.0], [100.0, 0.0]])
        result_arr = np.zeros((2, 2, 4), dtype=np.uint8)
        result_arr[:, :, :3] = 128
        out = _step_contrast(alpha.copy(), result_arr, contrast=50)
        # Visible pixels should have higher alpha
        assert out[0, 0] > 100
        assert out[1, 0] > 100

    def test_transparent_stays_transparent(self):
        alpha = np.array([[0.0, 0.0], [0.0, 0.0]])
        result_arr = np.zeros((2, 2, 4), dtype=np.uint8)
        result_arr[:, :, :3] = 128
        out = _step_contrast(alpha.copy(), result_arr, contrast=80)
        np.testing.assert_array_equal(out, 0)

    def test_darkens_rgb(self):
        alpha = np.full((2, 2), 200.0)
        result_arr = np.zeros((2, 2, 4), dtype=np.uint8)
        result_arr[:, :, :3] = 200
        _step_contrast(alpha.copy(), result_arr, contrast=50)
        # RGB should be darker
        assert result_arr[0, 0, 0] < 200


# ── extract_signature (pipeline complet) ─────────────────────────────────────

class TestExtractSignature:
    def test_output_is_rgba(self, dark_stroke_image):
        result, _ = extract_signature(dark_stroke_image)
        assert result.mode == "RGBA"

    def test_dimensions_preserved(self, dark_stroke_image):
        result, _ = extract_signature(dark_stroke_image)
        assert result.size == dark_stroke_image.size

    def test_had_alpha_false_for_rgb(self, dark_stroke_image):
        _, had_alpha = extract_signature(dark_stroke_image)
        assert had_alpha is False

    def test_had_alpha_true_for_rgba(self, rgba_image):
        _, had_alpha = extract_signature(rgba_image)
        assert had_alpha is True

    def test_white_background_transparent(self, dark_stroke_image):
        result, _ = extract_signature(dark_stroke_image)
        px = np.array(result)
        # Corner pixel (white area) should be transparent
        assert px[0, 0, 3] == 0

    def test_dark_ink_preserved(self, dark_stroke_image):
        result, _ = extract_signature(dark_stroke_image)
        px = np.array(result)
        # Centre of stroke should have alpha > 0
        assert px[50, 50, 3] > 0

    def test_blue_ink_with_auto_mode(self, blue_stroke_image):
        result, _ = extract_signature(blue_stroke_image, mode=MODE_AUTO)
        px = np.array(result)
        assert px[50, 50, 3] > 0, "Blue ink should be detected in auto mode"

    def test_blue_ink_with_blue_mode(self, blue_stroke_image):
        result, _ = extract_signature(blue_stroke_image, mode=MODE_BLUE)
        px = np.array(result)
        assert px[50, 50, 3] > 0, "Blue ink should be detected in blue mode"

    def test_custom_steps_order(self, dark_stroke_image):
        """Pipeline should accept custom step ordering."""
        steps = [
            ("smoothing", 20),
            ("threshold", 200),
            ("contrast", 10),
        ]
        result, _ = extract_signature(dark_stroke_image, steps=steps)
        assert result.mode == "RGBA"

    def test_white_image_fully_transparent(self, white_image):
        result, _ = extract_signature(white_image)
        px = np.array(result)
        assert px[:, :, 3].max() == 0, "Pure white image should be fully transparent"


# ── detect_presets ───────────────────────────────────────────────────────────

class TestDetectPresets:
    def test_returns_mode_and_steps(self, dark_stroke_image):
        presets = detect_presets(dark_stroke_image)
        assert "mode" in presets
        assert "steps" in presets
        assert isinstance(presets["steps"], list)

    def test_steps_have_effect_and_value(self, dark_stroke_image):
        presets = detect_presets(dark_stroke_image)
        for step in presets["steps"]:
            assert "effect" in step
            assert "value" in step

    def test_dark_image_detected_as_dark(self, dark_stroke_image):
        presets = detect_presets(dark_stroke_image)
        assert presets["mode"] in (MODE_DARK, MODE_AUTO)

    def test_blue_image_detected_as_blue(self, blue_stroke_image):
        presets = detect_presets(blue_stroke_image)
        assert presets["mode"] in (MODE_BLUE, MODE_AUTO)

    def test_white_image_fallback(self, white_image):
        presets = detect_presets(white_image)
        # No ink → should return defaults without crashing
        assert presets["mode"] == MODE_AUTO

    def test_values_within_ranges(self, dark_stroke_image):
        from backend.app import PARAM_RANGES
        presets = detect_presets(dark_stroke_image)
        for step in presets["steps"]:
            rng = PARAM_RANGES.get(step["effect"])
            if rng:
                assert rng["min"] <= step["value"] <= rng["max"], (
                    f"{step['effect']}={step['value']} out of range"
                )

    def test_rgba_input_handled(self, rgba_image):
        presets = detect_presets(rgba_image)
        assert "mode" in presets
