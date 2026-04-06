# Dependencies

This document explains **why** each dependency is used, **how** it integrates, and **what to watch out for** when upgrading or replacing it.

---

## Python

All Python dependencies are pinned in `requirements.txt` for reproducible builds.

### FastAPI `0.115.6`

- **Why**: Lightweight async web framework with built-in request validation (Query params with `enum`, `ge`, `le`), automatic OpenAPI schema, and native Starlette middleware support.
- **How**: Single `app.py` — defines routes (`/extract`, `/config`, `/health`, `/`) and middlewares (CORS, security headers).
- **Watch out**: FastAPI follows Starlette closely. Major Starlette upgrades can introduce breaking changes in middleware or response handling. Always test the security headers middleware after upgrading.

### Uvicorn `0.34.0`

- **Why**: ASGI server to run FastAPI. Fast, lightweight, production-ready.
- **How**: Used as the CMD in Dockerfile and in `__main__` for local dev. Single-worker by default (sufficient for this lightweight service).
- **Watch out**: For multi-worker deployments, switch to `gunicorn` with `uvicorn.workers.UvicornWorker`. Not needed here given the low resource footprint.

### python-multipart `0.0.20`

- **Why**: Required by FastAPI to parse `multipart/form-data` file uploads (`UploadFile`).
- **How**: Implicit — FastAPI imports it internally when handling file uploads. Not imported directly in `app.py`.
- **Watch out**: This is a mandatory peer dependency of FastAPI for file uploads. If removed, `/extract` will crash at runtime with an import error.

### Pillow `11.1.0`

- **Why**: Image loading, format conversion (RGB/RGBA), verification (`image.verify()`), and output encoding (PNG/WebP).
- **How**: Used in `extract_signature()` and `open_image()`. Also provides `Image.MAX_IMAGE_PIXELS` for decompression bomb protection.
- **Watch out**:
  - Pillow has a history of CVEs related to malformed image parsing. **Always upgrade promptly** when security patches are released.
  - `Image.MAX_IMAGE_PIXELS` must be set **before** any `Image.open()` call — currently done at module level.
  - The `verify()` + re-open pattern is intentional: `verify()` checks file integrity but invalidates the image object, so we must re-open for processing.

### NumPy `2.2.1`

- **Why**: Fast pixel-level operations for signature extraction (luminosity calculation, channel comparison, mask building). Orders of magnitude faster than pure Python loops.
- **How**: Used in `extract_signature()` — converts PIL image to array, applies vectorized operations, then converts back.
- **Watch out**: NumPy 2.x introduced breaking changes vs 1.x (dtype behavior, deprecated APIs). If downgrading to 1.x, test the `int16` dtype cast and boolean mask operations.

### python-dotenv `1.1.0`

- **Why**: Load `.env` file for local development without polluting system environment. Docker deployments pass env vars directly — dotenv is a dev convenience.
- **How**: `load_dotenv()` is called at startup before reading `os.environ`. It **does not override** existing env vars (system/Docker env takes priority).
- **Watch out**: `load_dotenv()` must be called **before** any `os.environ.get()`. Currently placed right after stdlib imports, before FastAPI imports, which is intentional.

### secure `1.0.1`

- **Why**: Sets HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) using typed builders instead of error-prone raw strings. Zero external dependencies.
- **How**: `Secure()` object configured with `ContentSecurityPolicy`, `PermissionsPolicy`, `XFrameOptions` builders. Applied via `set_headers_async()` in a Starlette middleware.
- **Watch out**:
  - Default headers from `secure` are strict. Our custom CSP allows `'unsafe-inline'` for styles and `blob:` for images — both are required for the app to function.
  - When upgrading, verify that new default headers don't break functionality (e.g., a future default `Strict-Transport-Security` header would enforce HTTPS, which may not be configured in dev).

---

## JavaScript (frontend)

No build step, no bundler. All JS is loaded via `<script>` tags in `index.html`.

### DOMPurify `3.2.4`

- **Where**: `static/vendor/purify.min.js` (~22 KB, vendored locally)
- **Why**: Sanitizes HTML strings from translation files (`data-i18n-html`) before insertion via `innerHTML`. Prevents XSS from malicious or corrupted language files.
- **How**: Called in `i18n.js` via `DOMPurify.sanitize(html, config)` with a strict whitelist: only `<strong>`, `<em>`, `<br>`, `<kbd>`, `<b>`, `<i>`, `<span>` allowed, zero attributes allowed.
- **Watch out**:
  - The file is **vendored** (not loaded from CDN) to comply with the `Content-Security-Policy: script-src 'self'` header. If switching to a CDN, the CSP must be updated.
  - To upgrade: download the new version from [npmjs.com/package/dompurify](https://www.npmjs.com/package/dompurify) and replace `static/vendor/purify.min.js`.
  - DOMPurify is the only JS dependency. The rest of the frontend (`app.js`, `i18n.js`) is vanilla JS with no external dependencies.

---

## Docker

### Base image: `python:3.12-slim`

- **Why**: Minimal Debian-based image with Python 3.12. Slim variant keeps the image small (~120 MB final) while still providing pip and essential system libraries.
- **Watch out**: `slim` images don't include build tools (`gcc`, `make`). If a future Python dependency requires compilation (e.g., C extensions), switch to the full `python:3.12` image for the build stage, or use a multi-stage build.

### System package: `curl`

- **Why**: Required for the `HEALTHCHECK` directive (`curl -f http://localhost:8000/health`).
- **How**: Installed via `apt-get` in the Dockerfile, with cache cleaned immediately after.
- **Watch out**: `curl` adds ~5 MB to the image. An alternative is `wget` (already present in some base images) or a Python-based health check script, but `curl` is the most standard approach for Docker health checks.

---

## Upgrade checklist

When upgrading any dependency:

1. Read the changelog for breaking changes
2. `docker compose build --no-cache` to rebuild with fresh packages
3. Test all features: upload, crop, contrast, zoom, download
4. Verify security headers: `curl -I http://localhost:8000/` — check CSP, X-Frame-Options, etc.
5. Check browser console for CSP violations or blocked resources
