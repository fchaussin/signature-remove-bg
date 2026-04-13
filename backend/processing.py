"""
Signature extraction pipeline and preset detection.

Sections
--------
 1. Image analysis helpers  — _flatten_alpha, _rgb_channels, _luminosity, _blue_mask
 2. Extraction logic        — _step_threshold, _step_blue_tolerance, _step_smoothing,
                               _step_contrast, _step_clean_lines, extract_signature()
 3. Preset detection        — _otsu_threshold, _detect_mode/blue/smoothing/contrast/clean_lines,
                               detect_presets
"""

import cv2
import numpy as np
from PIL import Image

from backend.config import (
    MODE_AUTO, MODE_DARK, MODE_BLUE,
    BT601_R, BT601_G, BT601_B,
    BLUE_CHROMA_R_OFFSET, BLUE_CHROMA_G_OFFSET,
    ANTIALIAS_SM,
    BLUE_RATIO_HIGH, BLUE_RATIO_LOW,
    MIN_INK_PIXELS,
    DEFAULT_THRESHOLD, DEFAULT_BLUE_TOLERANCE,
    DEFAULT_SMOOTHING, DEFAULT_CONTRAST, DEFAULT_CLEAN_LINES,
    PARAM_RANGES,
)


# ---------------------------------------------------------------------------
#  1. Image analysis helpers
# ---------------------------------------------------------------------------

def _flatten_alpha(image: Image.Image) -> tuple[Image.Image, bool]:
    """Composite onto white if the image has an alpha channel. Returns (image, had_alpha)."""
    if image.mode in ("RGBA", "LA", "PA"):
        bg = Image.new("RGBA", image.size, (255, 255, 255, 255))
        bg.paste(image, mask=image.split()[-1])
        return bg.convert("RGB"), True
    return image, False


def _rgb_channels(image: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Convert a PIL image to int16 R, G, B channel arrays."""
    pixels = np.array(image.convert("RGB"), dtype=np.int16)
    return pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]


def _luminosity(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    """BT.601 luminosity from R, G, B int16 arrays → float64."""
    return (BT601_R * r + BT601_G * g + BT601_B * b).astype(np.float64)


def _blue_mask(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Boolean mask of pixels with dominant blue chrominance."""
    return (b > r + BLUE_CHROMA_R_OFFSET) & (b > g + BLUE_CHROMA_G_OFFSET)


def _clamp(value: int, name: str) -> int:
    """Clamp *value* to the valid range for parameter *name*."""
    r = PARAM_RANGES[name]
    return max(r["min"], min(r["max"], value))


# ---------------------------------------------------------------------------
#  2. Extraction logic
# ---------------------------------------------------------------------------

def _step_threshold(alpha: np.ndarray, lum: np.ndarray, mode: str,
                     threshold: int, **_) -> np.ndarray:
    """Pipeline step: compute dark-ink alpha and merge into current alpha."""
    if mode == MODE_BLUE:
        return alpha  # skip — blue-only mode
    alpha_dark = np.clip((threshold - lum) * 255 / ANTIALIAS_SM, 0, 255)
    return np.maximum(alpha, alpha_dark)


def _step_blue_tolerance(alpha: np.ndarray, r: np.ndarray, g: np.ndarray,
                         b: np.ndarray, mode: str,
                         blue_tolerance: int, **_) -> np.ndarray:
    """Pipeline step: compute blue-ink alpha and merge into current alpha."""
    if mode == MODE_DARK:
        return alpha  # skip — dark-only mode
    blue_strength = np.minimum(
        np.minimum(b - blue_tolerance, b - r - BLUE_CHROMA_R_OFFSET),
        b - g - BLUE_CHROMA_G_OFFSET,
    ).astype(np.float64)
    alpha_blue = np.clip(blue_strength * 255 / ANTIALIAS_SM, 0, 255)
    return np.maximum(alpha, alpha_blue)


def _box_blur_1d(arr: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """1D box blur along *axis* using cumsum. Output shape == input shape."""
    k = 2 * radius + 1
    padded = np.pad(arr, [(radius + 1, radius) if i == axis else (0, 0)
                          for i in range(arr.ndim)], mode='edge')
    cum = np.cumsum(padded, axis=axis)
    slc_hi = [slice(None)] * arr.ndim
    slc_lo = [slice(None)] * arr.ndim
    slc_hi[axis] = slice(k, None)
    slc_lo[axis] = slice(None, -k)
    return (cum[tuple(slc_hi)] - cum[tuple(slc_lo)]) / k


def _step_smoothing(alpha: np.ndarray, smoothing: int, **_) -> np.ndarray:
    """Pipeline step: box-blur the alpha channel for softer edges."""
    if smoothing <= 0:
        return alpha
    radius = max(1, int(smoothing / 10))
    return _box_blur_1d(_box_blur_1d(alpha, radius, axis=1), radius, axis=0)


def _step_contrast(alpha: np.ndarray, result: np.ndarray,
                   contrast: int, **_) -> np.ndarray:
    """Pipeline step: darken visible strokes and boost alpha."""
    if contrast <= 0:
        return alpha
    c = contrast / 100
    a = alpha.astype(np.float64)
    visible = a > 0
    rgb = result[:, :, :3].astype(np.float64)
    rgb[visible] *= (1 - c)
    result[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return np.where(visible, np.clip(a + (255 - a) * c, 0, 255), 0)


def _step_clean_lines(alpha: np.ndarray, lum: np.ndarray,
                      clean_lines: int, **_) -> np.ndarray:
    """Pipeline step: remove ruled lines / grid patterns via morphological detection.

    Uses horizontal and vertical morphological opening to isolate line structures,
    then subtracts them from the alpha channel.  The *clean_lines* value (0-100)
    controls aggressiveness: higher values use shorter kernels, catching more lines.
    """
    if clean_lines <= 0:
        return alpha

    # Binarize luminosity — lines are typically dark on light background
    lum8 = np.clip(lum, 0, 255).astype(np.uint8)
    _, binary = cv2.threshold(lum8, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Kernel length: high aggressiveness (100) → shorter kernel (15px) detects more;
    # low aggressiveness (1) → longer kernel (80px) detects only long lines.
    kernel_len = max(15, int(80 - clean_lines * 0.65))

    # Detect horizontal lines
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_len, 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel, iterations=1)

    # Detect vertical lines
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, kernel_len))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel, iterations=1)

    # Combine and dilate slightly to cover anti-aliased edges
    line_mask = cv2.add(h_lines, v_lines)
    dilate_k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    line_mask = cv2.dilate(line_mask, dilate_k, iterations=1)

    # Subtract line pixels from alpha (strength proportional to slider)
    strength = clean_lines / 100.0
    return np.clip(alpha - line_mask.astype(np.float64) * strength, 0, 255)


# Pipeline step registry — maps effect names to functions
_PIPELINE_STEPS = {
    "threshold":      _step_threshold,
    "blue_tolerance": _step_blue_tolerance,
    "smoothing":      _step_smoothing,
    "contrast":       _step_contrast,
    "clean_lines":    _step_clean_lines,
}


def extract_signature(
    image: Image.Image,
    mode: str = MODE_AUTO,
    steps: list[tuple[str, int]] | None = None,
) -> tuple[Image.Image, bool]:
    """
    Extract signature pixels and make the background transparent.

    *steps* is an ordered list of ``(effect_name, value)`` tuples.
    The same effect may appear multiple times.
    Each step reads/modifies the alpha channel of the result.

    Returns ``(result_image, had_alpha)``.
    """
    if steps is None:
        steps = [
            ("threshold", DEFAULT_THRESHOLD),
            ("blue_tolerance", DEFAULT_BLUE_TOLERANCE),
            ("clean_lines", DEFAULT_CLEAN_LINES),
            ("contrast", DEFAULT_CONTRAST),
            ("smoothing", DEFAULT_SMOOTHING),
        ]

    image, had_alpha = _flatten_alpha(image)
    r, g, b = _rgb_channels(image)
    lum = _luminosity(r, g, b)

    result = np.array(image.convert("RGBA"))
    alpha = np.zeros(lum.shape, dtype=np.float64)

    ctx = dict(r=r, g=g, b=b, lum=lum, result=result, mode=mode)

    for effect_name, value in steps:
        fn = _PIPELINE_STEPS.get(effect_name)
        if fn:
            alpha = fn(alpha=alpha, **ctx, **{effect_name: value})

    result[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(result), had_alpha


# ---------------------------------------------------------------------------
#  3. Preset detection (SRP — one function per parameter)
# ---------------------------------------------------------------------------

def _otsu_once(values: np.ndarray, n_bins: int, fallback: int) -> int:
    """Run Otsu's method on *values* and return the optimal threshold."""
    hist, _ = np.histogram(values.ravel(), bins=n_bins, range=(0, n_bins))
    total = hist.sum()
    if total == 0:
        return fallback

    sum_all = np.dot(np.arange(n_bins), hist)
    sum_bg = 0.0
    w_bg = 0
    best_t = fallback
    best_var = -1.0

    for t in range(n_bins):
        w_bg += hist[t]
        if w_bg == 0:
            continue
        w_fg = total - w_bg
        if w_fg == 0:
            break
        sum_bg += t * hist[t]
        mean_bg = sum_bg / w_bg
        mean_fg = (sum_all - sum_bg) / w_fg
        var = w_bg * w_fg * (mean_bg - mean_fg) ** 2
        if var > best_var:
            best_var = var
            best_t = t
    return best_t


def _otsu_threshold(lum: np.ndarray) -> tuple[int, int]:
    """
    Two-pass threshold detection.
    Returns (refined, coarse) — refined for extraction, coarse for analysis.

    On grey paper (few bright pixels) with a clear valley at the coarse
    threshold, the second Otsu pass tends to split *within* the ink rather
    than separating ink from paper.  In that case we use the midpoint between
    refined and coarse so lighter strokes are not lost.
    """
    # Pass 1 — coarse: separate foreground from background (pixels < 220)
    dark_lum = lum[lum < 220]
    if dark_lum.size == 0:
        return DEFAULT_THRESHOLD, DEFAULT_THRESHOLD

    coarse = _otsu_once(dark_lum, 220, DEFAULT_THRESHOLD)

    # Pass 2 — refined: separate ink from gray paper (pixels below coarse)
    ink = lum[lum < coarse]
    if ink.size < MIN_INK_PIXELS:
        return _clamp(coarse, "threshold"), _clamp(coarse, "threshold")

    refined = _otsu_once(ink, coarse, coarse)

    # Grey-paper correction: if the paper is grey (< 5 % of pixels above 220)
    # and there is a clear valley at the coarse threshold (low density in a
    # ±10 window), the coarse split is reliable but refined over-segments the
    # ink.  Use the midpoint to recover lighter strokes.
    bright_frac = (lum > 220).sum() / lum.size
    if bright_frac < 0.05 and coarse > refined:
        window = 10
        near = ((lum >= coarse - window) & (lum < coarse + window)).sum()
        density = near / lum.size
        if density < 0.03:
            # Use coarse with a small safety margin — the anti-alias
            # transition (ANTIALIAS_SM=15) naturally fades paper pixels
            return _clamp(coarse - 5, "threshold"), _clamp(coarse, "threshold")

    return _clamp(refined, "threshold"), _clamp(coarse, "threshold")


def _detect_mode(ink_b_mask: np.ndarray, ink_count: int,
                 b: np.ndarray, r: np.ndarray, g: np.ndarray) -> str:
    """Determine dominant ink colour from blue chrominance ratio and strength.

    A dark ballpoint pen may have slight blue chrominance but should be treated
    as dark ink. We require both a minimum ratio of blue pixels AND a minimum
    median blue chrominance (B - max(R,G)) to classify as blue.
    """
    blue_count = int(np.count_nonzero(ink_b_mask))
    ratio = blue_count / ink_count

    if ratio < BLUE_RATIO_LOW:
        return MODE_DARK

    # Check that blue pixels are actually vivid (not just dark-ish blue tint).
    # When the ratio is overwhelming (>0.8) the ink is almost certainly blue,
    # so we accept a lower chrominance (faint blue on tinted paper).
    if blue_count >= MIN_INK_PIXELS:
        chroma = b[ink_b_mask] - np.maximum(r[ink_b_mask], g[ink_b_mask])
        median_chroma = float(np.median(chroma))
        chroma_floor = 20 if ratio > 0.8 else 40
        if median_chroma < chroma_floor:
            return MODE_DARK  # weak blue — treat as dark ink (e.g. dark ballpoint)

    if ratio > BLUE_RATIO_HIGH:
        return MODE_BLUE
    return MODE_AUTO


def _detect_blue_tolerance(b: np.ndarray, r: np.ndarray, g: np.ndarray,
                           ink_b_mask: np.ndarray) -> int:
    """Optimal blue tolerance from median chrominance of blue ink pixels."""
    if int(np.count_nonzero(ink_b_mask)) < MIN_INK_PIXELS:
        return DEFAULT_BLUE_TOLERANCE
    blue_chroma = b[ink_b_mask] - np.maximum(r[ink_b_mask], g[ink_b_mask])
    return _clamp(int(np.median(blue_chroma)), "blue_tolerance")


_SMOOTHING_REF_SIZE = 1000  # reference image dimension (long edge) for gradient normalization

def _detect_smoothing(lum: np.ndarray, ink_mask: np.ndarray,
                      bg_lum_bright: np.ndarray) -> int:
    """Optimal smoothing from edge sharpness and background noise.

    Gradients are normalized to a reference resolution so that the same
    physical signature at different scan resolutions yields similar smoothing.
    A noisy background (measured on bright pixels only) raises the smoothing
    floor to reduce grain artifacts.
    """
    gy = np.abs(lum[2:, 1:-1] - lum[:-2, 1:-1])
    gx = np.abs(lum[1:-1, 2:] - lum[1:-1, :-2])
    grad = np.sqrt(gx ** 2 + gy ** 2)
    edge_mask = ink_mask[1:-1, 1:-1]
    if np.count_nonzero(edge_mask) < MIN_INK_PIXELS:
        return DEFAULT_SMOOTHING
    median_grad = float(np.median(grad[edge_mask]))

    # Normalize gradient to reference resolution — smaller images have
    # proportionally weaker gradients for the same physical edge
    long_edge = max(lum.shape[0], lum.shape[1])
    scale = _SMOOTHING_REF_SIZE / long_edge if long_edge > 0 else 1.0
    normalized_grad = median_grad * scale

    smoothing = int(30 - normalized_grad * 1.5)

    # Noisy background → raise floor to reduce grain artifacts
    if bg_lum_bright.size >= MIN_INK_PIXELS:
        bg_std = float(np.std(bg_lum_bright))
        if bg_std > 6:
            smoothing = max(smoothing, int(bg_std * 2))

    return _clamp(smoothing, "smoothing")


def _detect_contrast(ink_lum: np.ndarray, bg_lum_all: np.ndarray,
                     bg_lum_bright: np.ndarray) -> int:
    """Optimal contrast from ink luminosity, ink/bg gap, and background noise.

    *bg_lum_all* — all non-ink pixels (used for gap measurement).
    *bg_lum_bright* — only bright pixels >200 (used for noise measurement,
    avoids anti-alias edge inflation).

    Base scale: lum 50 → 0, lum 80 → ~30, lum 150 → ~100.
    Reduced when the natural gap between ink and background is already large
    (good contrast without boosting) or when the gap is very small
    (ink/bg overlap — boosting amplifies noise).
    """
    median = float(np.median(ink_lum))
    if median < 50:
        return 0  # ink is already dark enough

    base = int(median - 50)

    # Scale by ink/background separation (gap)
    median_bg = float(np.median(bg_lum_all))
    gap = median_bg - median
    if gap > 120:
        base = int(base * 0.3)   # excellent natural contrast
    elif gap > 80:
        base = int(base * 0.6)   # good natural contrast
    elif gap < 60:
        # Ink and background overlap — high noise amplification risk.
        # Scale down linearly: gap 60 → full, gap 0 → zero.
        base = int(base * gap / 120)

    # Noisy background → cap boost to avoid amplifying grain
    if bg_lum_bright.size >= MIN_INK_PIXELS:
        bg_std = float(np.std(bg_lum_bright))
        if bg_std > 8:
            base = int(base * 0.7)

    return _clamp(base, "contrast")


def _may_have_lines(binary: np.ndarray, min_lines: int = 3,
                    fill_fraction: float = 0.3) -> bool:
    """Cheap O(n) pre-filter: check if enough rows or columns are mostly dark.

    A ruled line spans a large fraction of the image width (or height),
    so rows containing a line have a high dark-pixel fraction.
    Returns True if at least *min_lines* rows or columns exceed *fill_fraction*.
    """
    h, w = binary.shape
    row_fracs = binary.sum(axis=1) / (w * 255)
    col_fracs = binary.sum(axis=0) / (h * 255)
    return (int(np.count_nonzero(row_fracs > fill_fraction)) >= min_lines or
            int(np.count_nonzero(col_fracs > fill_fraction)) >= min_lines)


def _detect_clean_lines(lum: np.ndarray) -> int:
    """Detect presence of ruled lines or grid patterns.

    Uses a cheap projection pre-filter (row/column dark-pixel fractions) to
    bail out early on images without line structures, then falls back to
    morphological opening for confirmation and counting.
    Returns a suggested clean_lines value (0 = none detected).
    """
    h, w = lum.shape
    if min(h, w) < 100:
        return 0

    lum8 = np.clip(lum, 0, 255).astype(np.uint8)
    _, binary = cv2.threshold(lum8, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    dark_pixels = int(np.count_nonzero(binary))
    if dark_pixels < MIN_INK_PIXELS:
        return 0

    # Fast pre-filter: bail out if no rows/columns look like lines
    if not _may_have_lines(binary):
        return 0

    # Confirmed candidate — run morphological analysis
    h_kernel_len = max(60, w // 4)
    v_kernel_len = max(60, h // 4)

    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (h_kernel_len, 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel, iterations=1)

    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_kernel_len))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel, iterations=1)

    h_count = 0
    if np.any(h_lines):
        h_count = cv2.connectedComponents(h_lines)[0] - 1
    v_count = 0
    if np.any(v_lines):
        v_count = cv2.connectedComponents(v_lines)[0] - 1

    if h_count < 3 and v_count < 3:
        return 0

    h_pixels = int(np.count_nonzero(h_lines))
    v_pixels = int(np.count_nonzero(v_lines))

    max_thickness = max(5, int(min(h, w) * 0.015))
    total_area = h * w
    best_dir_count = 0

    if h_count >= 4:
        avg_thickness = h_pixels / max(h_count * w, 1)
        coverage = h_pixels / total_area
        if avg_thickness < max_thickness and coverage < 0.10:
            best_dir_count = max(best_dir_count, h_count)
    if v_count >= 4:
        avg_thickness = v_pixels / max(v_count * h, 1)
        coverage = v_pixels / total_area
        if avg_thickness < max_thickness and coverage < 0.10:
            best_dir_count = max(best_dir_count, v_count)

    if best_dir_count < 4:
        return 0

    value = int(min(30 + best_dir_count * 5, 80))
    return _clamp(value, "clean_lines")


def detect_presets(image: Image.Image) -> dict:
    """
    Analyse an image and return optimal extraction parameters.

    Returns ``{mode, steps: [{effect, value}, ...]}``.
    """
    image, _ = _flatten_alpha(image)
    r, g, b = _rgb_channels(image)
    lum = _luminosity(r, g, b)

    threshold, coarse = _otsu_threshold(lum)
    # Use coarse threshold for analysis (includes lighter ink strokes)
    # Use refined threshold for the extraction step value
    ink_mask = lum < coarse
    ink_count = int(np.count_nonzero(ink_mask))

    clean_lines = _detect_clean_lines(lum)

    if ink_count < MIN_INK_PIXELS:
        return {
            "mode": MODE_AUTO,
            "steps": [
                {"effect": "threshold",      "value": threshold},
                {"effect": "blue_tolerance", "value": DEFAULT_BLUE_TOLERANCE},
                {"effect": "clean_lines",    "value": clean_lines},
                {"effect": "contrast",       "value": DEFAULT_CONTRAST},
                {"effect": "smoothing",      "value": DEFAULT_SMOOTHING},
            ],
        }

    ri, gi, bi = r[ink_mask], g[ink_mask], b[ink_mask]
    ink_b_mask = _blue_mask(ri, gi, bi)
    bg_lum_all = lum[~ink_mask]            # all non-ink (for gap measurement)
    bg_lum_bright = lum[lum > 200]         # bright only (for noise measurement)

    return {
        "mode": _detect_mode(ink_b_mask, ink_count, bi, ri, gi),
        "steps": [
            {"effect": "threshold",      "value": threshold},
            {"effect": "blue_tolerance", "value": _detect_blue_tolerance(bi, ri, gi, ink_b_mask)},
            {"effect": "clean_lines",    "value": clean_lines},
            {"effect": "contrast",       "value": _detect_contrast(lum[ink_mask], bg_lum_all, bg_lum_bright)},
            {"effect": "smoothing",      "value": _detect_smoothing(lum, ink_mask, bg_lum_bright)},
        ],
    }
