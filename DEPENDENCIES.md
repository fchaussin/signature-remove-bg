# Dependencies

This document explains **why** each dependency is used, **how** it integrates, and **what to watch out for** when upgrading or replacing it.

---

## Python

All Python dependencies are pinned in `requirements.txt` for reproducible builds.

### FastAPI `0.135.3`

- **Why**: Lightweight async web framework with built-in request validation (Query params with `enum`, `ge`, `le`), automatic OpenAPI schema, and native Starlette middleware support.
- **How**: Single `backend/app.py` — defines routes (`/extract`, `/config`, `/health`, `/`) and middlewares (CORS, security headers).
- **Watch out**: FastAPI follows Starlette closely. Major Starlette upgrades can introduce breaking changes in middleware or response handling. Always test the security headers middleware after upgrading.

### Uvicorn `0.44.0`

- **Why**: ASGI server to run FastAPI. Fast, lightweight, production-ready.
- **How**: Used as the CMD in Dockerfile and in `__main__` for local dev. Single-worker by default (sufficient for this lightweight service).
- **Watch out**: For multi-worker deployments, switch to `gunicorn` with `uvicorn.workers.UvicornWorker`. Not needed here given the low resource footprint.

### python-multipart `0.0.24`

- **Why**: Required by FastAPI to parse `multipart/form-data` file uploads (`UploadFile`).
- **How**: Implicit — FastAPI imports it internally when handling file uploads. Not imported directly in `backend/app.py`.
- **Watch out**: This is a mandatory peer dependency of FastAPI for file uploads. If removed, `/extract` will crash at runtime with an import error.

### Pillow `12.2.0`

- **Why**: Image loading, format conversion (RGB/RGBA), verification (`image.verify()`), and output encoding (PNG/WebP).
- **How**: Used in `backend/app.py` (`extract_signature()` and `open_image()`). Also provides `Image.MAX_IMAGE_PIXELS` for decompression bomb protection.
- **Watch out**:
  - Pillow has a history of CVEs related to malformed image parsing. **Always upgrade promptly** when security patches are released.
  - `Image.MAX_IMAGE_PIXELS` must be set **before** any `Image.open()` call — currently done at module level.
  - The `verify()` + re-open pattern is intentional: `verify()` checks file integrity but invalidates the image object, so we must re-open for processing.

### NumPy `2.4.4`

- **Why**: Fast pixel-level operations for signature extraction (luminosity calculation, channel comparison, mask building). Orders of magnitude faster than pure Python loops.
- **How**: Used in `backend/app.py` — converts PIL image to array, applies vectorized operations, then converts back.
- **Watch out**: NumPy 2.x introduced breaking changes vs 1.x (dtype behavior, deprecated APIs). If downgrading to 1.x, test the `int16` dtype cast and boolean mask operations.

### opencv-python-headless `4.11.0.86`

- **Why**: Morphological operations for ruled line / grid pattern detection and removal (`clean_lines` effect). The headless variant avoids pulling in GUI dependencies (Qt/GTK).
- **How**: Used in `backend/app.py` — `cv2.morphologyEx()` with horizontal/vertical kernels to detect line structures, `cv2.connectedComponents()` for line counting in auto-detection, `cv2.threshold()` for binarization.
- **Watch out**:
  - The headless variant (`opencv-python-headless`) must **not** be installed alongside `opencv-python` — they conflict. Use only one.
  - Adds ~50 MB to the Docker image. If line removal is not needed, the dependency can be removed and the `clean_lines` effect disabled.

### python-dotenv `1.2.2`

- **Why**: Load `.env` file for local development without polluting system environment. Docker deployments pass env vars directly — dotenv is a dev convenience.
- **How**: `load_dotenv()` is called at startup before reading `os.environ`. It **does not override** existing env vars (system/Docker env takes priority).
- **Watch out**: `load_dotenv()` must be called **before** any `os.environ.get()`. Currently placed right after stdlib imports, before FastAPI imports, which is intentional.

### base64 (stdlib)

- **Why**: Encode extracted images as base64 data URIs for the `output=base64` API response. Part of the Python standard library — no external package required.
- **How**: `base64.b64encode()` converts the in-memory PNG/WebP buffer to an ASCII string, wrapped in a `data:image/…;base64,…` URI and returned as JSON.
- **Watch out**:
  - Base64 encoding increases payload size by ~33%. A dedicated `MAX_BASE64_MB` env var (default 10 MB) caps the encoded response size and returns `FILE_TOO_LARGE` if exceeded.
  - The response includes `Cache-Control: no-store` to prevent caching of image data.
  - On the frontend, the data URI is validated against a strict regex and the mime type is whitelisted. The textarea is cleared on popup close.

### secure `1.0.1`

- **Why**: Sets HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) using typed builders instead of error-prone raw strings. Zero external dependencies.
- **How**: `Secure()` object configured with `ContentSecurityPolicy`, `XFrameOptions`, `ReferrerPolicy` builders. Applied via `set_headers()` (synchronous) in a Starlette middleware. `Permissions-Policy` is set manually as a raw header.
- **Watch out**:
  - The `Secure()` constructor uses short parameter names that differ from the header names: `xfo` (X-Frame-Options), `referrer` (Referrer-Policy), `csp` (Content-Security-Policy), `permissions` (Permissions-Policy), `xcto` (X-Content-Type-Options). Refer to the [source](https://github.com/TypeError/secure) for the full list.
  - Default headers from `secure` are strict. Our custom CSP allows `'unsafe-inline'` for styles and `blob:` for images — both are required for the app to function.
  - When upgrading, verify that new default headers don't break functionality (e.g., a future default `Strict-Transport-Security` header would enforce HTTPS, which may not be configured in dev).

---

## JavaScript (frontend)

No build step, no bundler. All JS is loaded via `<script>` tags in `index.html`.

### DOMPurify `3.2.4`

- **Where**: `frontend/vendor/purify.min.js` (~22 KB, vendored locally)
- **Why**: Sanitizes HTML strings from translation files (`data-i18n-html`) before insertion via `innerHTML`. Prevents XSS from malicious or corrupted language files.
- **How**: Called in `i18n.js` via `DOMPurify.sanitize(html, config)` with a strict whitelist: only `<strong>`, `<em>`, `<br>`, `<kbd>`, `<b>`, `<i>`, `<span>` allowed, zero attributes allowed.
- **Watch out**:
  - The file is **vendored** (not loaded from CDN) to comply with the `Content-Security-Policy: script-src 'self'` header. If switching to a CDN, the CSP must be updated.
  - To upgrade: download the new version from [npmjs.com/package/dompurify](https://www.npmjs.com/package/dompurify) and replace `frontend/vendor/purify.min.js`.
  - DOMPurify is the only external JS dependency. The rest of the frontend is vanilla JS split across: `constants.js` (shared constants), `utils.js` (pure functions), `ui.js` (UI components), `app.js` (state + orchestration), `fx-slot.js`/`fx-rack.js` (effects).

### Icon (`icons.js`, project code)

- **Where**: `frontend/icons.js`
- **Why**: Lightweight SVG icon provider using Lucide-style stroke-based icons. Renders icons inline via `data-icon` attributes — no external icon font or CDN.
- **How**: `Icon.inject()` scans all `[data-icon]` elements in the DOM and replaces them with inline SVGs at the specified size. Icons use `currentColor` to inherit the parent text color.
- **Watch out**: Adding new icons requires adding a path entry to the `PATHS` object in `icons.js`. All icons use a 24×24 viewBox.

### FxSlot / FxRack (`fx-slot.js`, `fx-rack.js`, project code)

- **Where**: `frontend/fx-slot.js`, `frontend/fx-rack.js`
- **Why**: Encapsulate effect slot UI (toggle + slider + display) and rack management (ordering, drag & drop) using SRP. `app.js` orchestrates via a single `onChange` callback.
- **How**: `FxRack` creates `FxSlot` instances dynamically (no static HTML) and manages drag & drop reordering. Each slot exposes `setValue()`, `value`, `enabled`, and `name`. The rack is initialized from server defaults via `/config`.
- **Watch out**: New effects require an entry in `PARAM_RANGES` (constants.js) and `FxRack.EFFECTS` (fx-rack.js), plus a `<option>` in the rack `<select>` in HTML.

### Clipboard API (browser built-in)

- **Where**: `frontend/app.js` — Base64 popup copy button + API doc cURL copy button
- **Why**: Copy content to the clipboard (base64 data URIs, cURL commands). Uses the standard `navigator.clipboard.writeText()` API — no external library.
- **How**: Async call to `navigator.clipboard.writeText()`. The text value is captured before the async call to avoid race conditions with dialog close. In the Base64 popup, on success the button shows "Copied!" feedback for 1.5 s; on failure, falls back to `textarea.select()` for manual Ctrl+C.
- **Watch out**: `navigator.clipboard` requires a secure context (HTTPS or localhost). This is already satisfied by typical deployments.

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
3. Test all features: upload, crop, eraser, effects rack (toggles, sliders, reorder, clean_lines), presets (save, load, delete, auto-detect), zoom, download, base64 export (all output formats), API doc helper
4. Verify security headers: `curl -I http://localhost:8000/` — check CSP, X-Frame-Options, etc.
5. Verify base64 response headers: `Cache-Control: no-store` present on `output=base64` responses
6. Check browser console for CSP violations or blocked resources
