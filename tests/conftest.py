"""Shared fixtures — synthetic images generated in code, no external files needed."""

import io

import numpy as np
import pytest
from PIL import Image


@pytest.fixture
def white_image():
    """100x100 pure white RGB image (no ink)."""
    return Image.new("RGB", (100, 100), (255, 255, 255))


@pytest.fixture
def dark_stroke_image():
    """100x100 white image with a horizontal dark stroke (rows 40-60, cols 20-80)."""
    img = Image.new("RGB", (100, 100), (255, 255, 255))
    px = np.array(img)
    px[40:60, 20:80] = [30, 30, 30]  # near-black ink
    return Image.fromarray(px)


@pytest.fixture
def blue_stroke_image():
    """100x100 white image with a horizontal blue stroke (rows 40-60, cols 20-80)."""
    img = Image.new("RGB", (100, 100), (255, 255, 255))
    px = np.array(img)
    px[40:60, 20:80] = [30, 30, 180]  # blue ink
    return Image.fromarray(px)


@pytest.fixture
def rgba_image():
    """100x100 RGBA image with semi-transparent dark stroke."""
    img = Image.new("RGBA", (100, 100), (255, 255, 255, 255))
    px = np.array(img)
    px[40:60, 20:80] = [30, 30, 30, 200]
    return Image.fromarray(px)


@pytest.fixture
def tiny_png_bytes():
    """Minimal valid PNG as bytes (10x10 white)."""
    img = Image.new("RGB", (10, 10), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def tiny_jpg_bytes():
    """Minimal valid JPEG as bytes (10x10 white)."""
    img = Image.new("RGB", (10, 10), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def dark_stroke_png_bytes(dark_stroke_image):
    """PNG bytes of the dark stroke image."""
    buf = io.BytesIO()
    dark_stroke_image.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def blue_stroke_png_bytes(blue_stroke_image):
    """PNG bytes of the blue stroke image."""
    buf = io.BytesIO()
    blue_stroke_image.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def rgba_png_bytes(rgba_image):
    """PNG bytes of the RGBA image."""
    buf = io.BytesIO()
    rgba_image.save(buf, format="PNG")
    return buf.getvalue()
