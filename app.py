"""
Signature Remove Background — Extract dark/blue signatures from white backgrounds.
Lightweight FastAPI service (~30-50 MB RAM), no ML.
"""

import io
import logging
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import numpy as np
from PIL import Image, UnidentifiedImageError

# ---------------------------------------------------------------------------
# Configuration (environment variables with sensible defaults)
# ---------------------------------------------------------------------------

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "20"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("signature-remove-bg")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Signature Remove Background", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Extraction logic
# ---------------------------------------------------------------------------

def extract_signature(
    image: Image.Image,
    mode: str = "auto",
    threshold: int = 220,
    blue_tolerance: int = 80,
) -> Image.Image:
    """
    Extract signature pixels and make the background transparent.

    Modes:
      - "dark"  : capture all dark pixels (black ink, classic pen)
      - "blue"  : capture blue-tinted pixels only
      - "auto"  : combine dark + blue to catch both
    """
    img = image.convert("RGB")
    pixels = np.array(img, dtype=np.int16)
    r, g, b = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]

    # "Dark" mask: pixels whose luminosity falls below the threshold
    luminosity = 0.299 * r + 0.587 * g + 0.114 * b
    mask_dark = luminosity < threshold

    # "Blue" mask: blue channel clearly dominates the others
    mask_blue = (
        (b > blue_tolerance)
        & (b - r > 30)
        & (b - g > 20)
    )

    if mode == "dark":
        mask = mask_dark
    elif mode == "blue":
        mask = mask_blue
    else:  # auto
        mask = mask_dark | mask_blue

    # Build RGBA: signature pixels opaque, everything else transparent
    alpha = np.where(mask, 255, 0).astype(np.uint8)

    result = img.convert("RGBA")
    result_pixels = np.array(result)
    result_pixels[:, :, 3] = alpha
    return Image.fromarray(result_pixels)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check endpoint for monitoring and Docker HEALTHCHECK."""
    return {"status": "ok"}


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    mode: str = Query("auto", enum=["auto", "dark", "blue"]),
    threshold: int = Query(220, ge=50, le=250, description="Luminosity threshold (dark mode)"),
    blue_tolerance: int = Query(80, ge=20, le=200, description="Blue sensitivity"),
    format: str = Query("png", enum=["png", "webp"]),
):
    """Extract the signature from a scanned image and return a transparent PNG/WebP."""
    contents = await file.read()
    if not contents:
        return JSONResponse({"code": "FILE_REQUIRED"}, status_code=400)

    if len(contents) > MAX_UPLOAD_BYTES:
        logger.warning("Upload rejected: %d bytes (limit %d MB)", len(contents), MAX_UPLOAD_MB)
        return JSONResponse({"code": "FILE_TOO_LARGE"}, status_code=400)

    try:
        image = Image.open(io.BytesIO(contents))
        image.verify()
        image = Image.open(io.BytesIO(contents))
    except Exception:
        logger.warning("Invalid image upload: %s", file.filename)
        return JSONResponse({"code": "INVALID_FILE"}, status_code=400)

    try:
        result = extract_signature(image, mode=mode, threshold=threshold, blue_tolerance=blue_tolerance)
    except Exception:
        logger.exception("Extraction failed for %s", file.filename)
        return JSONResponse({"code": "PROCESSING_FAILED"}, status_code=500)

    buf = io.BytesIO()
    result.save(buf, format=format.upper(), optimize=True)
    buf.seek(0)

    media_type = "image/png" if format == "png" else "image/webp"
    return StreamingResponse(buf, media_type=media_type, headers={
        "Content-Disposition": f"inline; filename=signature.{format}",
        "X-Response-Code": "OK",
    })


@app.get("/", response_class=HTMLResponse)
async def ui():
    """Serve the minimal web UI."""
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
