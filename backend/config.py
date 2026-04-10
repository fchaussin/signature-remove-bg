"""
Centralized configuration — env vars, constants, parameter ranges, defaults.

All configuration is read from environment variables at import time.
"""

import ipaddress
import os
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


# ---------------------------------------------------------------------------
#  Constants
# ---------------------------------------------------------------------------

MODE_AUTO = "auto"
MODE_DARK = "dark"
MODE_BLUE = "blue"
VALID_MODES = {MODE_AUTO, MODE_DARK, MODE_BLUE}
VALID_FORMATS = {"png", "webp"}
VALID_EFFECTS = {"threshold", "blue_tolerance", "contrast", "smoothing", "clean_lines"}
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
    "clean_lines":    {"min": 0,   "max": 100, "default_env": "DEFAULT_CLEAN_LINES",     "default": 0},
}


# ---------------------------------------------------------------------------
#  Env helpers
# ---------------------------------------------------------------------------

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


def _clamp(value: int, name: str) -> int:
    """Clamp *value* to the valid range for parameter *name*."""
    r = PARAM_RANGES[name]
    return max(r["min"], min(r["max"], value))


# ---------------------------------------------------------------------------
#  Derived configuration
# ---------------------------------------------------------------------------

# -- Server ------------------------------------------------------------------
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _int_env("PORT", 8000)

# -- Upload limits -----------------------------------------------------------
MAX_UPLOAD_MB       = _int_env("MAX_UPLOAD_MB", 50)
MAX_UPLOAD_BYTES    = MAX_UPLOAD_MB * 1024 * 1024
MAX_IMAGE_PIXELS    = _int_env("MAX_IMAGE_PIXELS", 50_000_000)   # ~7 000 × 7 000
MAX_IMAGE_DIMENSION = _int_env("MAX_IMAGE_DIMENSION", 10_000)
MAX_PROCESS_PIXELS  = _int_env("MAX_PROCESS_PIXELS", 4_000_000)  # extract/analyze limit — crop first
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

# Build defaults from env using centralized ranges
DEFAULTS = {
    name: _clamp(_int_env(cfg["default_env"], cfg["default"]), name)
    for name, cfg in PARAM_RANGES.items()
}
DEFAULT_THRESHOLD      = DEFAULTS["threshold"]
DEFAULT_BLUE_TOLERANCE = DEFAULTS["blue_tolerance"]
DEFAULT_SMOOTHING      = DEFAULTS["smoothing"]
DEFAULT_CONTRAST       = DEFAULTS["contrast"]
DEFAULT_CLEAN_LINES    = DEFAULTS["clean_lines"]

# -- CORS (A05 — set CORS_ORIGINS in production, wildcard is dev-only) ------
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

# -- Config warnings (shown in WebUI unless HIDE_CONFIG_WARNINGS=true) ------
HIDE_CONFIG_WARNINGS = os.environ.get("HIDE_CONFIG_WARNINGS", "false").lower() in ("true", "1", "yes")


def _is_local_ip(ip: str | None) -> bool:
    """Return True if *ip* looks like a local/private/loopback address."""
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_loopback or addr.is_private or addr.is_link_local


def _build_config_warnings(client_ip: str | None = None) -> list[dict]:
    """Return a list of {level, key} warnings about the current configuration."""
    if HIDE_CONFIG_WARNINGS:
        return []
    warnings = []
    if "*" in CORS_ORIGINS and not _is_local_ip(client_ip):
        warnings.append({"level": "danger", "key": "warn.cors_wildcard"})
    if MAX_CONCURRENT_OPS < 2:
        warnings.append({"level": "warning", "key": "warn.low_concurrency"})
    if MAX_UPLOAD_MB > 100:
        warnings.append({"level": "warning", "key": "warn.high_upload_limit"})
    return warnings


# -- Pillow safety -----------------------------------------------------------
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# -- App version -------------------------------------------------------------
APP_VERSION = "0.3.1"
