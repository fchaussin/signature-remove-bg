"""
Signature Remove Background — Extract dark/blue signatures from white backgrounds.
Lightweight FastAPI service (~30-50 MB RAM), no ML.

Sections
--------
 1. Imports
 2. Configuration      — env vars, validation, constants, PARAM_RANGES
 3. Logging            — logger setup, filename sanitizer
 4. App setup          — FastAPI instance, CORS, security headers, static files
 5. Image analysis     — _rgb_channels, _luminosity, _blue_mask (shared helpers)
 5b. Extraction logic  — extract_signature()
 5c. Preset detection  — _otsu_threshold, _detect_mode/blue/smoothing/contrast, detect_presets
 6. Upload helpers     — read_upload, open_image, _validate_and_open
 7. Routes             — /health, /config, /extract, /analyze, /
 8. Entrypoint         — uvicorn
"""

# ---------------------------------------------------------------------------
#  1. Imports
# ---------------------------------------------------------------------------

import asyncio
import base64
import io
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
import numpy as np
from PIL import Image
from secure import Secure
from secure.headers import (
    ContentSecurityPolicy,
    StrictTransportSecurity,
    XContentTypeOptions,
    XFrameOptions,
    ReferrerPolicy,
)


# ---------------------------------------------------------------------------
#  2. Configuration
# ---------------------------------------------------------------------------

MODE_AUTO = "auto"
MODE_DARK = "dark"
MODE_BLUE = "blue"
VALID_MODES = {MODE_AUTO, MODE_DARK, MODE_BLUE}
VALID_FORMATS = {"png", "webp"}
VALID_EFFECTS = {"threshold", "blue_tolerance", "contrast", "smoothing"}
MAX_PIPELINE_STEPS = 7
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"}

# BT.601 luminosity coefficients
BT601_R, BT601_G, BT601_B = 0.299, 0.587, 0.114

# Blue chrominance detection thresholds
BLUE_CHROMA_R_OFFSET = 30   # B must exceed R by this much
BLUE_CHROMA_G_OFFSET = 20   # B must exceed G by this much

# Fixed anti-aliasing transition width (used when smoothing is a separate step)
ANTIALIAS_SM = 15

# Blue ratio thresholds for mode detection
BLUE_RATIO_HIGH = 0.4       # above → MODE_BLUE
BLUE_RATIO_LOW  = 0.25      # below → MODE_DARK (raised to avoid JPEG chroma noise false positives)

# Minimum ink pixels for reliable analysis
MIN_INK_PIXELS = 50

# Centralized parameter ranges — single source of truth for config, Query, presets, clamp
PARAM_RANGES = {
    "threshold":      {"min": 50,  "max": 250, "default_env": "DEFAULT_THRESHOLD",      "default": 220},
    "blue_tolerance": {"min": 20,  "max": 200, "default_env": "DEFAULT_BLUE_TOLERANCE",  "default": 80},
    "smoothing":      {"min": 0,   "max": 100, "default_env": "DEFAULT_SMOOTHING",       "default": 30},
    "contrast":       {"min": 0,   "max": 100, "default_env": "DEFAULT_CONTRAST",        "default": 0},
}


def _int_env(name: str, default: int) -> int:
    """Read an integer from env, fall back to *default* on missing or invalid input."""
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _choice_env(name: str, default: str, choices: set[str]) -> str:
    """Read a string from env, fall back to *default* if value is not in *choices*."""
    raw = os.environ.get(name, default)
    return raw if raw in choices else default


# -- Server ------------------------------------------------------------------
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _int_env("PORT", 8000)

# -- Upload limits -----------------------------------------------------------
MAX_UPLOAD_MB       = _int_env("MAX_UPLOAD_MB", 50)
MAX_UPLOAD_BYTES    = MAX_UPLOAD_MB * 1024 * 1024
MAX_IMAGE_PIXELS    = _int_env("MAX_IMAGE_PIXELS", 50_000_000)   # ~7 000 × 7 000
MAX_IMAGE_DIMENSION = _int_env("MAX_IMAGE_DIMENSION", 10_000)
MAX_BASE64_BYTES    = _int_env("MAX_BASE64_MB", 10) * 1024 * 1024  # A04 — cap base64 response size
UPLOAD_CHUNK_SIZE   = 64 * 1024  # 64 KB per read
MAX_CONCURRENT_OPS  = _int_env("MAX_CONCURRENT_OPS", 4)  # A04 — cap parallel CPU-heavy requests

# -- Extraction defaults (exposed to frontend via /config) -------------------
DEFAULT_MODE   = _choice_env("DEFAULT_MODE", "auto", VALID_MODES)
DEFAULT_FORMAT = _choice_env("DEFAULT_FORMAT", "png", VALID_FORMATS)

# -- Render mode (live / manual / auto) ----------------------------------------
VALID_RENDER_MODES = {"live", "manual", "auto"}
RENDER_MODE        = _choice_env("RENDER_MODE", "auto", VALID_RENDER_MODES)
AUTO_MANUAL_PIXELS = _int_env("AUTO_MANUAL_PIXELS", 4_000_000)  # 4 Mpx — auto-switch threshold
ANALYZE_ON_UPLOAD  = os.environ.get("ANALYZE_ON_UPLOAD", "true").lower() in ("true", "1", "yes")


def _clamp(value: int, name: str) -> int:
    """Clamp *value* to the valid range for parameter *name*."""
    r = PARAM_RANGES[name]
    return max(r["min"], min(r["max"], value))


# Build defaults from env using centralized ranges
DEFAULTS = {
    name: _clamp(_int_env(cfg["default_env"], cfg["default"]), name)
    for name, cfg in PARAM_RANGES.items()
}
DEFAULT_THRESHOLD      = DEFAULTS["threshold"]
DEFAULT_BLUE_TOLERANCE = DEFAULTS["blue_tolerance"]
DEFAULT_SMOOTHING      = DEFAULTS["smoothing"]
DEFAULT_CONTRAST       = DEFAULTS["contrast"]

# -- CORS (A05 — set CORS_ORIGINS in production, wildcard is dev-only) ------
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

# -- Config warnings (shown in WebUI unless HIDE_CONFIG_WARNINGS=true) ------
HIDE_CONFIG_WARNINGS = os.environ.get("HIDE_CONFIG_WARNINGS", "false").lower() in ("true", "1", "yes")


def _build_config_warnings() -> list[dict]:
    """Return a list of {level, key} warnings about the current configuration."""
    if HIDE_CONFIG_WARNINGS:
        return []
    warnings = []
    if "*" in CORS_ORIGINS:
        warnings.append({"level": "danger", "key": "warn.cors_wildcard"})
    if MAX_CONCURRENT_OPS < 2:
        warnings.append({"level": "warning", "key": "warn.low_concurrency"})
    if MAX_UPLOAD_MB > 100:
        warnings.append({"level": "warning", "key": "warn.high_upload_limit"})
    return warnings


# -- Pillow safety -----------------------------------------------------------
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


# ---------------------------------------------------------------------------
#  3. Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("signature-remove-bg")

_SAFE_LOG_RE = re.compile(r"[^\x20-\x7E]")  # A03 — strip non-printable / newlines


def _safe_log(value: str | None, max_len: int = 100) -> str:
    """Sanitize any user-supplied string for safe logging (OWASP A03 — log injection)."""
    if not value:
        return "<empty>"
    return _SAFE_LOG_RE.sub("_", value)[:max_len]


# ---------------------------------------------------------------------------
#  4. App setup
# ---------------------------------------------------------------------------

APP_VERSION = "0.3.0"

app = FastAPI(
    title="Signature Remove Background",
    version=APP_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# -- CORS --------------------------------------------------------------------

if "*" in CORS_ORIGINS:
    logger.warning("CORS_ORIGINS includes wildcard '*' — restrict in production (A05)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# -- Concurrency limiter (A04 — prevent CPU saturation DoS) -----------------
_processing_semaphore = asyncio.Semaphore(MAX_CONCURRENT_OPS)

# -- Security headers (OWASP A05 — via `secure` library) --------------------

secure_headers = Secure(
    csp=ContentSecurityPolicy()
        .default_src("'self'")
        .style_src("'self'", "'unsafe-inline'")
        .img_src("'self'", "blob:", "data:")
        .script_src("'self'")
        .base_uri("'self'")
        .form_action("'self'")
        .frame_ancestors("'none'")
        .object_src("'none'"),
    hsts=StrictTransportSecurity()
        .max_age(63072000)
        .include_subdomains(),
    xcto=XContentTypeOptions(),
    xfo=XFrameOptions().deny(),
    referrer=ReferrerPolicy().strict_origin_when_cross_origin(),
)

# Permissions-Policy — set manually (secure lib emits 'none' instead of spec-compliant ())
_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()"


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    secure_headers.set_headers(response)
    response.headers["Permissions-Policy"] = _PERMISSIONS_POLICY
    return response


# -- Static files ------------------------------------------------------------

STATIC_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
#  5. Image analysis helpers
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


# ---------------------------------------------------------------------------
#  5b. Extraction logic
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


# Pipeline step registry — maps effect names to functions
_PIPELINE_STEPS = {
    "threshold":      _step_threshold,
    "blue_tolerance": _step_blue_tolerance,
    "smoothing":      _step_smoothing,
    "contrast":       _step_contrast,
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
#  5c. Preset detection (SRP — one function per parameter)
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

    # Check that blue pixels are actually vivid (not just dark-ish blue tint)
    if blue_count >= MIN_INK_PIXELS:
        chroma = b[ink_b_mask] - np.maximum(r[ink_b_mask], g[ink_b_mask])
        median_chroma = float(np.median(chroma))
        if median_chroma < 40:
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

def _detect_smoothing(lum: np.ndarray, ink_mask: np.ndarray) -> int:
    """Optimal smoothing from edge sharpness (gradient magnitude).

    Gradients are normalized to a reference resolution so that the same
    physical signature at different scan resolutions yields similar smoothing.
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

    return _clamp(int(30 - normalized_grad * 1.5), "smoothing")


def _detect_contrast(ink_lum: np.ndarray) -> int:
    """Optimal contrast from median ink luminosity (faded ink → more boost).

    Scale: lum 50 → 0 (already dark), lum 80 → ~30, lum 120 → ~70, lum 150+ → ~100.
    """
    median = float(np.median(ink_lum))
    if median < 50:
        return 0  # ink is already dark enough
    return _clamp(int((median - 50) * 1.0), "contrast")


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

    if ink_count < MIN_INK_PIXELS:
        return {
            "mode": MODE_AUTO,
            "steps": [
                {"effect": "threshold",      "value": threshold},
                {"effect": "blue_tolerance", "value": DEFAULT_BLUE_TOLERANCE},
                {"effect": "contrast",       "value": DEFAULT_CONTRAST},
                {"effect": "smoothing",      "value": DEFAULT_SMOOTHING},
            ],
        }

    ri, gi, bi = r[ink_mask], g[ink_mask], b[ink_mask]
    ink_b_mask = _blue_mask(ri, gi, bi)

    return {
        "mode": _detect_mode(ink_b_mask, ink_count, bi, ri, gi),
        "steps": [
            {"effect": "threshold",      "value": threshold},
            {"effect": "blue_tolerance", "value": _detect_blue_tolerance(bi, ri, gi, ink_b_mask)},
            {"effect": "contrast",       "value": _detect_contrast(lum[ink_mask])},
            {"effect": "smoothing",      "value": _detect_smoothing(lum, ink_mask)},
        ],
    }


# ---------------------------------------------------------------------------
#  6. Upload helpers
# ---------------------------------------------------------------------------

async def read_upload(file: UploadFile, safe_name: str) -> bytes | None:
    """Read an uploaded file with streaming size check. Returns None if too large."""
    chunks: list[bytes] = []
    total = 0

    while True:
        chunk = await file.read(UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            logger.warning("Upload rejected: >%d MB for %s", MAX_UPLOAD_MB, safe_name)
            return None
        chunks.append(chunk)

    return b"".join(chunks)


# A03 — magic-byte signatures (don't trust Content-Type header alone)
_IMAGE_MAGIC = (
    b"\xff\xd8\xff",          # JPEG
    b"\x89PNG\r\n\x1a\n",    # PNG
    b"RIFF",                  # WebP (RIFF....WEBP)
    b"BM",                    # BMP
    b"II",                    # TIFF (little-endian)
    b"MM",                    # TIFF (big-endian)
)


def open_image(contents: bytes, safe_name: str) -> tuple[Image.Image | None, str | None]:
    """
    Open and verify an image from raw bytes.

    Returns ``(image, None)`` on success or ``(None, error_code)`` on failure.
    """
    if not any(contents.startswith(sig) for sig in _IMAGE_MAGIC):
        logger.warning("Rejected unknown magic bytes for %s", safe_name)
        return None, "INVALID_FILE"
    try:
        image = Image.open(io.BytesIO(contents))
        image.verify()
        image = Image.open(io.BytesIO(contents))
    except Exception:
        logger.warning("Invalid image: %s", safe_name)
        return None, "INVALID_FILE"

    w, h = image.size
    if w > MAX_IMAGE_DIMENSION or h > MAX_IMAGE_DIMENSION:
        logger.warning("Image too large: %dx%d for %s", w, h, safe_name)
        return None, "IMAGE_TOO_LARGE"

    return image, None


# ---------------------------------------------------------------------------
#  7. Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check for monitoring and Docker HEALTHCHECK."""
    return {"status": "ok"}


@app.get("/config")
async def config():
    """Expose non-sensitive extraction defaults to the frontend."""
    return JSONResponse({
        "version":        APP_VERSION,
        "warnings":       _build_config_warnings(),
        "mode":           DEFAULT_MODE,
        "format":         DEFAULT_FORMAT,
        "render_mode":    RENDER_MODE,
        "auto_manual_pixels": AUTO_MANUAL_PIXELS,
        "analyze_on_upload": ANALYZE_ON_UPLOAD,
        "max_steps":      MAX_PIPELINE_STEPS,
        "steps": [
            {"effect": "threshold",      "value": DEFAULT_THRESHOLD},
            {"effect": "blue_tolerance", "value": DEFAULT_BLUE_TOLERANCE},
            {"effect": "contrast",       "value": DEFAULT_CONTRAST},
            {"effect": "smoothing",      "value": DEFAULT_SMOOTHING},
        ],
    }, headers={
        "Cache-Control": "public, max-age=3600",      # A04 — immutable defaults, safe to cache
    })


async def _validate_and_open(file: UploadFile) -> tuple[Image.Image | None, str, JSONResponse | None]:
    """
    Shared upload pipeline: validate content-type, read bytes, open image.

    Returns ``(image, safe_name, None)`` on success
    or ``(None, safe_name, error_response)`` on failure.
    """
    safe_name = _safe_log(file.filename)

    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        logger.warning("Rejected content-type %s for %s", _safe_log(file.content_type), safe_name)
        return None, safe_name, JSONResponse({"code": "INVALID_FILE"}, status_code=400)

    contents = await read_upload(file, safe_name)
    if contents is None:
        return None, safe_name, JSONResponse({"code": "FILE_TOO_LARGE"}, status_code=400)
    if not contents:
        return None, safe_name, JSONResponse({"code": "FILE_REQUIRED"}, status_code=400)

    image, err = open_image(contents, safe_name)
    if err:
        return None, safe_name, JSONResponse({"code": err}, status_code=400)

    return image, safe_name, None


def _parse_steps(raw: str) -> list[tuple[str, int]] | None:
    """
    Parse and validate a pipeline steps string (A03 — whitelist).

    Format: ``effect:value,effect:value,...``
    Example: ``threshold:200,blue_tolerance:80,smoothing:30``
    Returns None on invalid input (caller uses defaults).
    """
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) > MAX_PIPELINE_STEPS:
        return None
    steps = []
    for part in parts:
        if ":" not in part:
            return None
        name, raw_val = part.split(":", 1)
        if name not in VALID_EFFECTS:
            return None
        try:
            val = int(raw_val)
        except ValueError:
            return None
        rng = PARAM_RANGES.get(name)
        if rng and not (rng["min"] <= val <= rng["max"]):
            return None
        steps.append((name, val))
    return steps if steps else None


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    mode: str = Query(DEFAULT_MODE, enum=["auto", "dark", "blue"]),
    steps: str = Query("", description="Pipeline steps: effect:value,effect:value,..."),
    format: str = Query(DEFAULT_FORMAT, enum=["png", "webp"]),
    output: str = Query("binary", enum=["binary", "base64"]),
):
    """Extract the signature from an uploaded image and return a transparent PNG/WebP."""
    image, safe_name, err = await _validate_and_open(file)
    if err:
        return err

    parsed_steps = _parse_steps(steps)

    def _extract_and_encode():
        result, had_alpha = extract_signature(image, mode=mode, steps=parsed_steps)
        buf = io.BytesIO()
        result.save(buf, format=format.upper(), optimize=True)
        buf.seek(0)
        return buf, had_alpha

    async with _processing_semaphore:
        try:
            buf, had_alpha = await asyncio.to_thread(_extract_and_encode)
        except Exception:
            logger.exception("Extraction failed for %s", safe_name)
            return JSONResponse({"code": "PROCESSING_FAILED"}, status_code=500)

    media_type = "image/png" if format == "png" else "image/webp"
    extra_headers = {}
    if had_alpha:
        extra_headers["X-Alpha-Composited"] = "true"

    if output == "base64":
        raw = buf.read()
        if len(raw) > MAX_BASE64_BYTES:
            logger.warning("Base64 output too large (%d bytes) for %s", len(raw), safe_name)
            return JSONResponse({"code": "FILE_TOO_LARGE"}, status_code=400)
        b64 = base64.b64encode(raw).decode("ascii")
        data_uri = f"data:{media_type};base64,{b64}"
        return JSONResponse({"base64": data_uri}, headers={
            "X-Response-Code": "OK",
            "Cache-Control": "no-store",
            **extra_headers,
        })

    return StreamingResponse(buf, media_type=media_type, headers={
        "Content-Disposition": f"inline; filename=signature.{format}",
        "X-Response-Code": "OK",
        "Cache-Control": "no-store",
        **extra_headers,
    })


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    """Analyse an image and return optimal extraction presets."""
    image, safe_name, err = await _validate_and_open(file)
    if err:
        return err

    async with _processing_semaphore:                    # A04 — limit concurrent CPU work
        try:
            presets = await asyncio.to_thread(detect_presets, image)
        except Exception:
            logger.exception("Analysis failed for %s", safe_name)
            return JSONResponse({"code": "PROCESSING_FAILED"}, status_code=500)

    return JSONResponse(presets, headers={
        "Cache-Control": "no-store",
    })


@app.get("/", response_class=HTMLResponse)
async def ui():
    """Serve the minimal web UI."""
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
#  8. Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
