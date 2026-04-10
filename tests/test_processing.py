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

    def test_opaque_black_stays_black(self):
        img = Image.new("RGBA", (10, 10), (0, 0, 0, 255))
        out, had_alpha = _flatten_alpha(img)
        assert had_alpha is True
        assert out.getpixel((0, 0)) == (0, 0, 0)

    def test_mixed_alpha_zones(self):
        """Image with opaque ink + transparent background."""
        img = Image.new("RGBA", (20, 20), (255, 255, 255, 0))  # transparent bg
        px = np.array(img)
        px[5:15, 5:15] = [30, 30, 30, 255]  # opaque dark ink
        img = Image.fromarray(px)
        out, had_alpha = _flatten_alpha(img)
        assert had_alpha is True
        # Background → white
        assert out.getpixel((0, 0)) == (255, 255, 255)
        # Ink → dark
        r, g, b = out.getpixel((10, 10))
        assert r < 50 and g < 50 and b < 50

    def test_pa_mode(self):
        """PA (palette + alpha) should be composited on white."""
        rgba = Image.new("RGBA", (10, 10), (0, 0, 0, 128))
        img = rgba.convert("PA")
        out, had_alpha = _flatten_alpha(img)
        assert out.mode == "RGB"
        assert had_alpha is True


# ── Alpha channel through full pipeline ──────────────────────────────────────

class TestAlphaPipeline:
    def test_rgba_ink_on_transparent_bg(self):
        """RGBA image with dark ink on transparent bg → ink preserved after flatten + extract."""
        img = Image.new("RGBA", (50, 50), (255, 255, 255, 0))
        px = np.array(img)
        px[15:35, 15:35] = [30, 30, 30, 255]
        img = Image.fromarray(px)
        result, had_alpha = extract_signature(img)
        assert had_alpha is True
        rpx = np.array(result)
        # Centre (ink area) should have alpha > 0
        assert rpx[25, 25, 3] > 0
        # Corner (was transparent → flattened to white → transparent after extract)
        assert rpx[0, 0, 3] == 0

    def test_semi_transparent_ink(self):
        """Semi-transparent dark ink on white bg → should still be detected."""
        img = Image.new("RGBA", (50, 50), (255, 255, 255, 255))
        px = np.array(img)
        px[15:35, 15:35] = [30, 30, 30, 128]  # semi-transparent ink
        img = Image.fromarray(px)
        result, had_alpha = extract_signature(img)
        assert had_alpha is True
        rpx = np.array(result)
        # After flatten: semi-transparent black on white → grey
        # Grey should be detected by threshold
        assert rpx[25, 25, 3] > 0

    def test_fully_transparent_image(self):
        """Fully transparent RGBA → flatten to white → fully transparent output."""
        img = Image.new("RGBA", (30, 30), (0, 0, 0, 0))
        result, had_alpha = extract_signature(img)
        assert had_alpha is True
        rpx = np.array(result)
        assert rpx[:, :, 3].max() == 0

    def test_blue_ink_on_transparent_bg(self):
        """RGBA with blue ink on transparent bg → detected in auto mode."""
        img = Image.new("RGBA", (50, 50), (255, 255, 255, 0))
        px = np.array(img)
        px[15:35, 15:35] = [30, 30, 180, 255]
        img = Image.fromarray(px)
        result, _ = extract_signature(img, mode=MODE_AUTO)
        rpx = np.array(result)
        assert rpx[25, 25, 3] > 0

    def test_detect_presets_on_alpha_image(self):
        """detect_presets on RGBA with ink → should return valid presets."""
        img = Image.new("RGBA", (50, 50), (255, 255, 255, 0))
        px = np.array(img)
        px[15:35, 15:35] = [30, 30, 30, 255]
        img = Image.fromarray(px)
        presets = detect_presets(img)
        assert presets["mode"] in (MODE_DARK, MODE_AUTO)
        assert len(presets["steps"]) > 0


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
        r, g, b, _, alpha = _make_arrays((180, 30, 30))
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

    def test_contrast_reduced_when_high_natural_gap(self):
        """Well-separated ink/bg (large gap) should yield low contrast boost."""
        img = Image.new("RGB", (200, 200), (255, 255, 255))
        px = img.load()
        for x in range(40, 160):
            for y in range(80, 120):
                px[x, y] = (80, 80, 80)  # dark ink, gap ~175
        presets = detect_presets(img)
        contrast = next(s["value"] for s in presets["steps"] if s["effect"] == "contrast")
        assert contrast < 15, f"High-gap image should have low contrast, got {contrast}"

    def test_contrast_reduced_when_noisy_bg(self):
        """Noisy background should reduce contrast to avoid amplifying grain."""
        rng = np.random.RandomState(42)
        # Noisy grey background (std ~12)
        bg = rng.normal(210, 12, (200, 200)).clip(0, 255).astype(np.uint8)
        px = np.stack([bg, bg, bg], axis=-1)
        # Faint ink stripe
        px[80:120, 40:160] = [130, 130, 130]
        img = Image.fromarray(px)
        presets = detect_presets(img)
        contrast = next(s["value"] for s in presets["steps"] if s["effect"] == "contrast")
        assert contrast < 60, f"Noisy bg should cap contrast, got {contrast}"

    def test_contrast_high_when_faint_ink_clean_bg(self):
        """Faint ink on a clean white background with small gap should get high contrast."""
        img = Image.new("RGB", (200, 200), (255, 255, 255))
        px = img.load()
        for x in range(40, 160):
            for y in range(80, 120):
                px[x, y] = (170, 170, 170)  # very faint ink
        presets = detect_presets(img)
        contrast = next(s["value"] for s in presets["steps"] if s["effect"] == "contrast")
        assert contrast >= 30, f"Faint ink on clean bg should get contrast boost, got {contrast}"

    def test_grey_paper_threshold_not_over_refined(self):
        """Grey paper with clear ink/paper gap: threshold should not cut lighter strokes.

        Simulates a notebook page where paper is grey (~190) and ink ranges
        from very dark (~30) to lighter strokes (~100), with a clear gap
        between ink (max ~120) and paper (min ~160).
        """
        rng = np.random.RandomState(7)
        # Grey paper background (lum ~190, no pixels above 220)
        bg = rng.normal(190, 4, (300, 400)).clip(160, 215).astype(np.uint8)
        px = np.stack([bg, bg, bg], axis=-1)
        # Ink with realistic noise — continuous gradient from dark to lighter
        for y in range(80, 220):
            for x in range(50, 350):
                base = 30 + int(40 * abs(y - 150) / 70)  # 30 at center, ~70 at edges
                v = max(0, min(130, base + rng.randint(-10, 10)))
                px[y, x] = [v, v, v]
        img = Image.fromarray(px)
        presets = detect_presets(img)
        threshold = next(s["value"] for s in presets["steps"] if s["effect"] == "threshold")
        # Threshold must be high enough to capture lighter strokes (lum ~80-100)
        assert threshold > 70, f"Grey paper threshold should capture lighter strokes, got {threshold}"

    def test_smoothing_floor_on_noisy_bg(self):
        """Noisy background should raise the smoothing floor."""
        rng = np.random.RandomState(42)
        bg = rng.normal(220, 10, (200, 200)).clip(0, 255).astype(np.uint8)
        px = np.stack([bg, bg, bg], axis=-1)
        px[80:120, 40:160] = [30, 30, 30]
        img = Image.fromarray(px)
        presets = detect_presets(img)
        smoothing = next(s["value"] for s in presets["steps"] if s["effect"] == "smoothing")
        assert smoothing >= 15, f"Noisy bg should raise smoothing floor, got {smoothing}"

    def test_faint_blue_on_tinted_bg_detected_as_blue(self):
        """Faint blue ink (low chrominance) with high ratio must be detected as blue."""
        img = Image.new("RGB", (200, 200), (240, 235, 230))  # light tinted background
        # Draw faint blue ink — B dominates but chrominance is ~35 (below 40)
        px = img.load()
        for x in range(40, 160):
            for y in range(80, 120):
                px[x, y] = (60, 70, 105)  # B-max(R,G) = 35, darker so Otsu picks it up
        presets = detect_presets(img)
        assert presets["mode"] == MODE_BLUE


# ── Edge cases ───────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_single_pixel_image(self):
        """1x1 image must not crash (blur, gradient, etc.)."""
        img = Image.new("RGB", (1, 1), (30, 30, 30))
        result, _ = extract_signature(img)
        assert result.size == (1, 1)
        assert result.mode == "RGBA"

    def test_single_pixel_detect(self):
        img = Image.new("RGB", (1, 1), (30, 30, 30))
        presets = detect_presets(img)
        assert "mode" in presets

    def test_all_black_image(self):
        """All-black image → fully opaque (no division by zero)."""
        img = Image.new("RGB", (50, 50), (0, 0, 0))
        result, _ = extract_signature(img)
        px = np.array(result)
        assert px[:, :, 3].min() > 0, "All-black should be fully opaque"

    def test_all_blue_image(self):
        """All-blue image → detected in blue mode."""
        img = Image.new("RGB", (50, 50), (20, 20, 180))
        result, _ = extract_signature(img, mode=MODE_BLUE)
        px = np.array(result)
        assert px[:, :, 3].min() > 0, "All-blue should be opaque in blue mode"

    def test_grayscale_input(self):
        """Grayscale (mode L) image should be handled."""
        img = Image.new("L", (50, 50), 128)
        result, _ = extract_signature(img)
        assert result.mode == "RGBA"
        assert result.size == (50, 50)

    def test_flatten_alpha_la_mode(self):
        """LA (grayscale + alpha) image should be composited on white."""
        img = Image.new("LA", (10, 10), (0, 128))
        out, had_alpha = _flatten_alpha(img)
        assert out.mode == "RGB"
        assert had_alpha is True

    def test_pipeline_order_matters(self, dark_stroke_image):
        """Different step orderings should produce different results."""
        steps_a = [("threshold", 200), ("smoothing", 50)]
        steps_b = [("smoothing", 50), ("threshold", 200)]
        result_a, _ = extract_signature(dark_stroke_image, steps=steps_a)
        result_b, _ = extract_signature(dark_stroke_image, steps=steps_b)
        px_a = np.array(result_a)[:, :, 3]
        px_b = np.array(result_b)[:, :, 3]
        assert not np.array_equal(px_a, px_b), "Step order should affect the result"

    def test_repeated_effect(self):
        """Same effect applied twice should differ from single application (RGB darkening)."""
        img = Image.new("RGB", (100, 100), (255, 255, 255))
        px = np.array(img)
        px[40:60, 20:80] = [160, 160, 160]
        img_a = Image.fromarray(px.copy())
        img_b = Image.fromarray(px.copy())
        steps_single = [("threshold", 220), ("contrast", 20)]
        steps_double = [("threshold", 220), ("contrast", 10), ("contrast", 10)]
        result_s, _ = extract_signature(img_a, steps=steps_single)
        result_d, _ = extract_signature(img_b, steps=steps_double)
        # Contrast darkens RGB cumulatively — two passes of 10% != one pass of 20%
        rgb_s = np.array(result_s)[:, :, :3]
        rgb_d = np.array(result_d)[:, :, :3]
        assert not np.array_equal(rgb_s, rgb_d), "Repeated contrast should darken RGB differently"
