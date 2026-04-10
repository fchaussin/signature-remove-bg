"""
Signature Remove Background — Extract dark/blue signatures from white backgrounds.
Lightweight FastAPI service, OpenCV for line removal.

Sections
--------
 1. Imports            — config, processing, FastAPI
 2. Logging            — logger setup, filename sanitizer
 3. App setup          — FastAPI instance, CORS, security headers, static files
 4. Upload helpers     — read_upload, open_image, _validate_and_open
 5. Routes             — /health, /config, /extract, /analyze, /
 6. Entrypoint         — uvicorn
"""

# ---------------------------------------------------------------------------
#  1. Imports
# ---------------------------------------------------------------------------

import asyncio
import base64
import io
import logging
import re
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from secure import Secure
from secure.headers import (
    ContentSecurityPolicy,
    StrictTransportSecurity,
    XContentTypeOptions,
    XFrameOptions,
    ReferrerPolicy,
)

from backend.config import (
    APP_VERSION,
    HOST, PORT,
    VALID_EFFECTS,
    MAX_PIPELINE_STEPS, ALLOWED_CONTENT_TYPES,
    PARAM_RANGES,
    DEFAULT_MODE, DEFAULT_FORMAT,
    DEFAULT_THRESHOLD, DEFAULT_BLUE_TOLERANCE,
    DEFAULT_SMOOTHING, DEFAULT_CONTRAST, DEFAULT_CLEAN_LINES,
    MAX_UPLOAD_MB, MAX_UPLOAD_BYTES, MAX_IMAGE_DIMENSION,
    MAX_PROCESS_PIXELS, MAX_BASE64_BYTES,
    UPLOAD_CHUNK_SIZE, MAX_CONCURRENT_OPS,
    RENDER_MODE, AUTO_MANUAL_PIXELS, ANALYZE_ON_UPLOAD,
    CORS_ORIGINS,
    _build_config_warnings,
)
from backend.processing import extract_signature, detect_presets


# ---------------------------------------------------------------------------
#  2. Logging
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
#  3. App setup
# ---------------------------------------------------------------------------

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
#  4. Upload helpers
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


def _check_process_limit(image: Image.Image, safe_name: str) -> JSONResponse | None:
    """Return an error response if the image exceeds MAX_PROCESS_PIXELS, else None."""
    w, h = image.size
    if w * h > MAX_PROCESS_PIXELS:
        logger.info("Image too large for processing: %dx%d (%d px) for %s — crop first",
                     w, h, w * h, safe_name)
        return JSONResponse({"code": "IMAGE_NEEDS_CROP"}, status_code=400)
    return None


# ---------------------------------------------------------------------------
#  5. Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check for monitoring and Docker HEALTHCHECK."""
    return {"status": "ok"}


@app.get("/config")
async def config(request: Request):
    """Expose non-sensitive extraction defaults to the frontend."""
    client_ip = request.client.host if request.client else None
    return JSONResponse({
        "version":        APP_VERSION,
        "warnings":       _build_config_warnings(client_ip),
        "mode":           DEFAULT_MODE,
        "format":         DEFAULT_FORMAT,
        "render_mode":    RENDER_MODE,
        "max_process_pixels": MAX_PROCESS_PIXELS,
        "auto_manual_pixels": AUTO_MANUAL_PIXELS,
        "analyze_on_upload": ANALYZE_ON_UPLOAD,
        "max_steps":      MAX_PIPELINE_STEPS,
        "steps": [
            {"effect": "threshold",      "value": DEFAULT_THRESHOLD},
            {"effect": "blue_tolerance", "value": DEFAULT_BLUE_TOLERANCE},
            {"effect": "clean_lines",    "value": DEFAULT_CLEAN_LINES},
            {"effect": "contrast",       "value": DEFAULT_CONTRAST},
            {"effect": "smoothing",      "value": DEFAULT_SMOOTHING},
        ],
    }, headers={
        "Cache-Control": "public, max-age=3600",      # A04 — immutable defaults, safe to cache
    })


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

    err = _check_process_limit(image, safe_name)
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

    err = _check_process_limit(image, safe_name)
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


_CACHE_BUST = f"?_={int(__import__('time').time())}"  # set once at startup


@app.get("/", response_class=HTMLResponse)
async def ui():
    """Serve the minimal web UI with cache-busted static assets."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('.css"', f'.css{_CACHE_BUST}"')
    html = html.replace('.js"', f'.js{_CACHE_BUST}"')
    return html


# ---------------------------------------------------------------------------
#  6. Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
