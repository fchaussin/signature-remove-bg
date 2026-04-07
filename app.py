"""
Signature Remove Background — Extract dark/blue signatures from white backgrounds.
Lightweight FastAPI service (~30-50 MB RAM), no ML.

Sections
--------
 1. Imports
 2. Configuration      — env vars, validation, constants
 3. Logging            — logger setup, filename sanitizer
 4. App setup          — FastAPI instance, CORS, security headers, static files
 5. Extraction logic   — extract_signature()
 6. Upload helpers     — read_upload()
 7. Routes             — /health, /config, /extract, /
 8. Entrypoint         — uvicorn
"""

# ---------------------------------------------------------------------------
#  1. Imports
# ---------------------------------------------------------------------------

import base64
import io
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
import numpy as np
from PIL import Image
from secure import Secure
from secure.headers import (
    ContentSecurityPolicy,
    PermissionsPolicy,
    XFrameOptions,
    ReferrerPolicy,
)


# ---------------------------------------------------------------------------
#  2. Configuration
# ---------------------------------------------------------------------------

VALID_MODES = {"auto", "dark", "blue"}
VALID_FORMATS = {"png", "webp"}
VALID_OUTPUTS = {"binary", "base64"}
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"}


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
UPLOAD_CHUNK_SIZE   = 64 * 1024  # 64 KB per read

# -- Extraction defaults (exposed to frontend via /config) -------------------
DEFAULT_MODE           = _choice_env("DEFAULT_MODE", "auto", VALID_MODES)
DEFAULT_FORMAT         = _choice_env("DEFAULT_FORMAT", "png", VALID_FORMATS)
DEFAULT_THRESHOLD      = max(50, min(250, _int_env("DEFAULT_THRESHOLD", 220)))
DEFAULT_BLUE_TOLERANCE = max(20, min(200, _int_env("DEFAULT_BLUE_TOLERANCE", 80)))
DEFAULT_SMOOTHING      = max(0, min(100, _int_env("DEFAULT_SMOOTHING", 30)))

# -- CORS --------------------------------------------------------------------
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

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

_SAFE_FILENAME_RE = re.compile(r"[^a-zA-Z0-9._\-]")


def _safe_filename(name: str | None) -> str:
    """Sanitize a user-supplied filename for safe logging (OWASP A03)."""
    if not name:
        return "<empty>"
    return _SAFE_FILENAME_RE.sub("_", name)[:100]


# ---------------------------------------------------------------------------
#  4. App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Signature Remove Background",
    version="0.2.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# -- CORS --------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# -- Security headers (OWASP A05 — via `secure` library) --------------------

secure_headers = Secure(
    csp=ContentSecurityPolicy()
        .default_src("'self'")
        .style_src("'self'", "'unsafe-inline'")
        .img_src("'self'", "blob:")
        .script_src("'self'"),
    permissions=PermissionsPolicy()
        .camera("'none'")
        .microphone("'none'")
        .geolocation("'none'"),
    xfo=XFrameOptions().deny(),
    referrer=ReferrerPolicy().strict_origin_when_cross_origin(),
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    secure_headers.set_headers(response)
    return response


# -- Static files ------------------------------------------------------------

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
#  5. Extraction logic
# ---------------------------------------------------------------------------

def extract_signature(
    image: Image.Image,
    mode: str = "auto",
    threshold: int = 220,
    blue_tolerance: int = 80,
    smoothing: int = 30,
) -> Image.Image:
    """
    Extract signature pixels and make the background transparent.

    Modes
    -----
    - ``"dark"``  — capture all dark pixels (black ink, classic pen)
    - ``"blue"``  — capture blue-tinted pixels only
    - ``"auto"``  — combine dark + blue to catch both

    The *smoothing* parameter controls the width (in luminosity units)
    of the soft transition zone around the threshold.  ``0`` reverts to
    a hard binary cut-off; ``30`` (default) gives natural anti-aliased
    edges that preserve stroke thickness.
    """
    img = image.convert("RGB")
    pixels = np.array(img, dtype=np.int16)
    r, g, b = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]

    sm = max(smoothing, 1)  # avoid division by zero

    # "Dark" alpha: soft transition around luminosity threshold (BT.601)
    luminosity = 0.299 * r + 0.587 * g + 0.114 * b
    alpha_dark = np.clip((threshold - luminosity) * 255 / sm, 0, 255)

    # "Blue" alpha: soft transition based on blue channel dominance
    blue_strength = np.minimum(np.minimum(b - blue_tolerance, b - r - 30), b - g - 20)
    alpha_blue = np.clip(blue_strength * 255 / sm, 0, 255)

    # Combine based on mode
    if mode == "dark":
        alpha = alpha_dark
    elif mode == "blue":
        alpha = alpha_blue
    else:
        alpha = np.maximum(alpha_dark, alpha_blue)

    # Build RGBA output
    result = np.array(img.convert("RGBA"))
    result[:, :, 3] = alpha.astype(np.uint8)
    return Image.fromarray(result)


# ---------------------------------------------------------------------------
#  6. Upload helpers
# ---------------------------------------------------------------------------

async def read_upload(file: UploadFile, safe_name: str) -> bytes | None:
    """
    Read an uploaded file with streaming size check.

    Returns the file contents on success, or ``None`` after sending
    an error response to the caller (signalled by raising).
    """
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


def open_image(contents: bytes, safe_name: str) -> Image.Image | None:
    """Open and verify an image from raw bytes. Returns ``None`` on failure."""
    try:
        image = Image.open(io.BytesIO(contents))
        image.verify()
        image = Image.open(io.BytesIO(contents))
    except Exception:
        logger.warning("Invalid image: %s", safe_name)
        return None

    w, h = image.size
    if w > MAX_IMAGE_DIMENSION or h > MAX_IMAGE_DIMENSION:
        logger.warning("Image too large: %dx%d for %s", w, h, safe_name)
        return None

    return image


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
    return {
        "mode":           DEFAULT_MODE,
        "threshold":      DEFAULT_THRESHOLD,
        "blue_tolerance": DEFAULT_BLUE_TOLERANCE,
        "smoothing":      DEFAULT_SMOOTHING,
        "format":         DEFAULT_FORMAT,
    }


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    mode: str = Query(DEFAULT_MODE, enum=["auto", "dark", "blue"]),
    threshold: int = Query(DEFAULT_THRESHOLD, ge=50, le=250),
    blue_tolerance: int = Query(DEFAULT_BLUE_TOLERANCE, ge=20, le=200),
    smoothing: int = Query(DEFAULT_SMOOTHING, ge=0, le=100),
    format: str = Query(DEFAULT_FORMAT, enum=["png", "webp"]),
    output: str = Query("binary", enum=["binary", "base64"]),
):
    """Extract the signature from an uploaded image and return a transparent PNG/WebP."""
    safe_name = _safe_filename(file.filename)

    # 1. Validate content-type
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        logger.warning("Rejected content-type %s for %s", file.content_type, safe_name)
        return JSONResponse({"code": "INVALID_FILE"}, status_code=400)

    # 2. Read with streaming size limit
    contents = await read_upload(file, safe_name)
    if contents is None:
        return JSONResponse({"code": "FILE_TOO_LARGE"}, status_code=400)
    if not contents:
        return JSONResponse({"code": "FILE_REQUIRED"}, status_code=400)

    # 3. Open and validate image
    image = open_image(contents, safe_name)
    if image is None:
        return JSONResponse({"code": "INVALID_FILE"}, status_code=400)

    # 4. Extract signature
    try:
        result = extract_signature(image, mode=mode, threshold=threshold, blue_tolerance=blue_tolerance, smoothing=smoothing)
    except Exception:
        logger.exception("Extraction failed for %s", safe_name)
        return JSONResponse({"code": "PROCESSING_FAILED"}, status_code=500)

    # 5. Encode and return
    buf = io.BytesIO()
    result.save(buf, format=format.upper(), optimize=True)
    buf.seek(0)

    media_type = "image/png" if format == "png" else "image/webp"

    if output == "base64":
        b64 = base64.b64encode(buf.read()).decode("ascii")
        data_uri = f"data:{media_type};base64,{b64}"
        return JSONResponse({"base64": data_uri}, headers={
            "X-Response-Code": "OK",
            "Cache-Control": "no-store",           # A04 — prevent caching of image data
        })

    return StreamingResponse(buf, media_type=media_type, headers={
        "Content-Disposition": f"inline; filename=signature.{format}",
        "X-Response-Code": "OK",
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
