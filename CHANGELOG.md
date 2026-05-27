# Changelog

All notable changes since v0.1.2.

## [0.3.10] — 2026-05-27

This release is a UX-only update aimed squarely at the Docker Desktop "Run an image" workflow, where the host port is not published unless the user expands the Optional settings panel — a step most people miss, leaving them with `ERR_CONNECTION_REFUSED` on `localhost:8000` and the misleading `Uvicorn running on http://0.0.0.0:8000` line as their only clue. Two fixes ship together:

### UX — clear startup URL in container logs
- Uvicorn's default startup banner reads `Uvicorn running on http://0.0.0.0:<port>`. `0.0.0.0` is the *bind* address (all interfaces); browsers reject it as a destination with `ERR_ADDRESS_INVALID`. The app now installs a `logging.Filter` on `uvicorn.error` that rewrites that single record in place at emission time into `Ready — open http://localhost:<port> in your browser`, which is what a user on the host actually needs to open. Every other uvicorn log line is left untouched. The bind address is unchanged — the service still listens on `0.0.0.0` so Docker port mapping continues to work.

### UX — one-line installer scripts
- New `install.sh` (Linux / macOS / Git-Bash on Windows) and `install.ps1` (native Windows PowerShell). They:
  1. verify Docker is installed and running (clear error otherwise),
  2. pull `fchaussin/signature-remove-bg:latest` (or `$TAG`),
  3. remove any prior `signature-remove-bg` container so the script is idempotent,
  4. `docker run -d -p 8000:8000 --restart unless-stopped …` — port published correctly, **the** step Docker Desktop's UI misses by default,
  5. poll `/health` up to 30 s,
  6. open `http://localhost:8000` in the default browser.
- Documented as the recommended path on the Docker Hub overview (`README.md`). One-liner:
  ```bash
  curl -sL https://raw.githubusercontent.com/fchaussin/signature-remove-bg/main/install.sh | bash
  ```
- The container then appears in Docker Desktop's Containers tab with the port mapped — UI start / stop / logs work normally from there, so the friction is contained to the first run.

---

## [0.3.9] — 2026-05-27

No runtime change vs `0.3.8`. This release ships only CI hardening and documentation improvements, retagged so the rolling tags (`:latest`, `:0`, `:0.3`) point at a known-good build under the new release notes.

### CI
- **Smoke-test gate before publish** (`docker-publish.yml`) — a new `smoke-test` job builds the image for `linux/amd64`, runs it, and probes `/health` for up to 30 s before the multi-arch `build-and-push` job runs. A container that crashes at boot is no longer published to Docker Hub. This catches exactly the class of regression that shipped in `0.3.6`/`0.3.7` (the `uvicorn` `ModuleNotFoundError` fixed in `0.3.8`).
- **Docker Hub overview auto-sync** (`dockerhub-description.yml`) — pushes `README.md` to the Docker Hub repository overview on every commit to `main` that touches `README.md` (or via `workflow_dispatch`). Avoids the overview going stale relative to the repo.
- **Docker Hub tag cleanup workflow** (`dockerhub-cleanup.yml`) — manual `workflow_dispatch` action that deletes a user-supplied list of tags via the Docker Hub v2 API, with safety guards refusing protected rolling names and any alias of `latest`. Used to retire `0.3.7`, `0.3.6`, `0.3.4`, `0.3.2`.

### Documentation
- **README intro reframed** around the actual input scope — "Optimized for photos and scans of handwritten signatures" — with Web UI and REST API surfaced in the lead sentence (previously buried at the end of the paragraph).
- **Docker Desktop quick-start rewritten** — leads with the built-in `>_` terminal (zero-confusion path: explicit `docker run -p 8000:8000` sidesteps the unpublished-port footgun) and documents the UI-only path as a clear three-step recipe with the easy-to-miss "Optional settings" step flagged.
- **All image paths and the LICENSE link converted to absolute URLs** — the README is the source of the Docker Hub overview, which renders markdown in isolation; relative paths broke the demo gif and screenshots on Docker Hub.
- **New "Docker Hub version" badge** alongside the GitHub release badge — surfaces any drift between a tagged release and the image actually published.

---

## [0.3.8] — 2026-05-27

### Fix
- **Docker image runtime crash** (`ModuleNotFoundError: No module named 'uvicorn'`) — the multi-stage Dockerfile installed deps with `pip install --prefix=/install` then copied to `/usr/local`, which worked on `python:3.14-slim` (Python rooted at `/usr/local`) but breaks on `dhi.io/python:3.14-debian13` (Python rooted at `/usr`, so `/usr/local/lib/python3.14/site-packages` is not on `sys.path`). The runtime `uvicorn` script was present but its `import uvicorn` failed. Switched the builder to a real venv at `/opt/venv` and copy it whole into the runtime image, with `PATH` + `VIRTUAL_ENV` set accordingly. This is layout-agnostic and survives Python minor-version bumps.

---

## [0.3.7] — 2026-05-25

### Security
- **starlette `0.49.1` → `1.1.0`** — fixes PYSEC-2026-161 (Host header URL-reconstruction can lead to auth bypass when authentication depends on the reconstructed path). Reported by the weekly `pip-audit` workflow.
- **DOMPurify `3.2.4` → `3.4.5`** (vendored, `frontend/vendor/purify.min.js`) — clears several medium-severity advisories (CVE-2026-41238/41239/41240, GHSA-cjmm-f4jc-qw8r, others). Not exploitable in the project's strict `ALLOWED_TAGS`-only sanitize config, but keeps the vendored file current.

### Dependencies
- `fastapi 0.135.3 → 0.136.3`
- `uvicorn 0.44.0 → 0.48.0`
- `python-multipart 0.0.27 → 0.0.29`
- `numpy 2.4.4 → 2.4.6`
- `opencv-python-headless 4.11.0.86 → 4.13.0.92`
- `secure 1.0.1 → 2.0.1` (verified at runtime — security headers intact)
- `pytest 8.3.5 → 9.0.3` (146/146 tests green)

### Documentation
- `DEPENDENCIES.md` — version headers synced with new pins, Docker section rewritten to reflect the DHI base images and Python `urllib.request` healthcheck (was stale, still referenced `python:3.12-slim` + `curl`).

---

## [0.3.6] — 2026-05-07

### Infrastructure
- **Back to single-image multi-arch on DHI** — base switched to `dhi.io/python:3.14-debian13` which is now multi-arch (amd64 + arm64) natively. The hybrid arm64-standard / amd64-DHI strategy from `0.3.5` is no longer needed.
- **Multi-stage Dockerfile** — builder stage uses `dhi.io/python:3.14-debian13-dev` (with pip + build tools), runtime stage uses `dhi.io/python:3.14-debian13` (minimal, non-root, near-zero CVEs, signed SBOMs, SLSA L3 provenance).
- **Removed `Dockerfile.hardened`** — only one `Dockerfile` again.
- **Removed `:hardened` / `:X.Y.Z-hardened` tags** — `:X.Y.Z` *is* the hardened image now.
- **Single CI job** — multi-arch build via `docker/build-push-action@v6` with `linux/amd64,linux/arm64`.

### Note about `0.3.5`
The hybrid distribution shipped in `0.3.5` was never actually published to Docker Hub — the CI failed because `dhi.io/python:3.13-slim` was no longer in the catalogue. `0.3.6` is the first effective release since `0.3.4` on Docker Hub.

---

## [0.3.5] — 2026-05-07

### Infrastructure
- **Hybrid multi-arch distribution** — `:X.Y.Z` and `:latest` now ship a multi-arch manifest combining **arm64 standard** (`python:3.14-slim`) and **amd64 hardened** (`dhi.io/python:3.13-slim`). Users get the most secure variant available for their platform automatically.
- **`:X.Y.Z-hardened` / `:hardened` tags** — single-arch amd64 DHI image for users who want to force the hardened variant explicitly.
- **`Dockerfile.hardened`** — restored alongside `Dockerfile`, with `ARG DHI_IMAGE` for easy override.
- **3-job CI pipeline** — `build-standard-arm64` and `build-hardened-amd64` push by digest; `publish` assembles manifests via `docker buildx imagetools create`. Each job gated on tag refs (`startsWith(github.ref, 'refs/tags/v')`) so `workflow_dispatch` on `main` no longer pollutes Docker Hub.
- **`dhi.io` registry login** — added in the hardened build job (reuses Docker Hub credentials).

---

## [0.3.4] — 2026-04-13

### Documentation
- Documentation refresh.

---

## [0.3.3] — 2026-04-11

### Infrastructure
- **Docker Hardened Images** — base image switched from `python:3.14-slim` to `dhi.io/python:3.13-slim` (stable Python, near-zero CVEs, signed SBOMs, SLSA L3 provenance).
- **Removed `curl` dependency** — healthcheck rewritten as a Python one-liner (`urllib.request`).
- **Removed `useradd`/`USER appuser`** — DHI images already run as non-root by default.
- **Version from git tag** — `APP_VERSION` is now injected at build time via Docker `ARG`/`ENV` from the git tag (no more hardcoded value). Falls back to `dev` for local builds.
- **GHA workflow** — added `dhi.io` registry login + `build-args: APP_VERSION` pass-through.

---

## [0.3.2] — 2026-04-10

### Web UI
- **FX rack number input** — slot values can now be edited directly via `<input type="number">` instead of read-only display.
- **Auto-detect button rework** — animated striped border during processing (`aria-busy`), distinct "ready" state, no longer blocked during busy.
- **Settings toggle animated** — smooth collapse/expand using shared `toggleCollapse()` instead of instant `display: none`.
- **CSS cleanup** — various minor tweaks and simplifications.

---

## [0.3.1] — 2026-04-10

### Features

#### Backend
- **Clean lines effect** — new `clean_lines` pipeline step (0–100) that removes ruled lines and grid patterns using OpenCV morphological operations. Auto-detected by `/analyze` when 4+ parallel lines are found.
- **New dependency**: `opencv-python-headless` for morphological image processing.

#### Web UI
- **Eraser tool** — paint white over the original image to manually remove noise, stains, or unwanted marks before extraction. Adjustable brush size (5–80 px), up to 30 undo levels, touch support.
- **Auto button redesigned** — full-width accent gradient button with glow effect, placed prominently between dropzone and controls. Animated gradient border (conic-gradient spin) during processing.
- **Settings toggle** — gear button next to Auto hides/shows controls and effects rack. Hidden by default for a cleaner initial view.
- **Controls reorganized** — single compact horizontal bar replacing the two-column layout. Inline labels, vertical separators between groups.
- **Crop/Eraser visibility** — buttons only shown when image exceeds 400px in either dimension.
- **API button relocated** — moved from premium position to discrete link in controls bar, between presets and render.
- **Global `box-sizing: border-box`** applied.
- **Rack header** — subtle glass-style border (`rgb(255 255 255 / .3)`).

### Configuration

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_CLEAN_LINES` | `0` | Line removal strength (0–100) |

### Dependencies

- Added: `opencv-python-headless 4.11.0.86`

---

## [0.3.0] — 2026-04-09

### Breaking changes

- **Pipeline API redesigned** — `/extract` no longer accepts individual parameters (`threshold`, `blue_tolerance`, `smoothing`, `contrast`). Use a single `steps` parameter instead: `steps=threshold:200,blue_tolerance:80,smoothing:30`. Same effect can appear multiple times.
- **`/analyze` response format changed** — returns `{mode, steps: [{effect, value}, ...]}` instead of flat parameters.
- **`/config` response format changed** — returns `steps: [{effect, value}, ...]` + `max_steps` instead of individual default values.
- **Project structure reorganized** — backend and frontend separated into `backend/` and `frontend/` directories. Docker image runs as non-root `appuser`.

### Features

#### Backend
- **Edge smoothing** — new `smoothing` parameter (0–100) with progressive alpha gradient (replaces binary mask).
- **Contrast enhancement** — new `contrast` pipeline step to boost faint/washed-out signatures.
- **Auto-detection** (`POST /analyze`) — Otsu's method for threshold, blue chrominance analysis, gradient-based smoothing, median luminosity contrast detection.
- **Base64 output** — `output=base64` on `/extract` returns JSON with data URI.
- **Configurable pipeline** — effects are ordered, reorderable, and the same effect can appear multiple times (max 7 steps).
- **Concurrency limiter** — `MAX_CONCURRENT_OPS` caps parallel CPU-heavy requests (DoS protection).
- **Config warnings** — `/config` returns `warnings` array when configuration is not production-ready (CORS wildcard, low concurrency, high upload limit). Controllable via `HIDE_CONFIG_WARNINGS`.
- **Version exposed** — `APP_VERSION` exposed via `/config` and displayed in the web UI footer (since 0.3.3, injected from git tag at build time).
- **Alpha channel handling** — images with existing transparency are composited onto white before extraction. `X-Alpha-Composited` header signals this to the client.

#### Web UI
- **Effects rack** — draggable, reorderable effect slots with toggle, slider, and drag handle. Add/remove effects dynamically.
- **Auto-detect button** — analyzes the image and suggests optimal settings. Re-analyzes after crop.
- **Presets** — save/load/delete named presets in localStorage. Built-in presets (e.g. "Low res / Low contrast") always available.
- **API request helper** — Swagger-style panel showing live `POST /extract` endpoint with copy cURL button.
- **Before/after comparison slider** — side-by-side view with draggable handle.
- **Crop tool** — 4-edge crop with real-time preview. Cropped image replaces current file for subsequent operations.
- **Base64 export popup** — 11 output formats (plain, data URI, CSS, HTML, JS, JSON, XML...).
- **Render modes** — live (auto re-extract), manual (button/Ctrl+Enter), auto (switches based on image size).
- **Background picker** — white, checker, dark, light blue preview backgrounds.
- **Actual-size zoom** — 1:1 popup with mouse pan for large images.
- **Resolution warnings** — non-blocking banners for small/large images.
- **Internationalization** — English + French, auto-detected from browser language.
- **Config warnings** — dismissible banners (per-session) for non-production config.
- **Loading gate** — UI hidden until both i18n and `/config` are ready (no flash of untranslated content).
- **Copy feedback** — translated "Copied!" confirmation on copy buttons.

#### Infrastructure
- **Tests** — 99 tests (pytest): processing pipeline, input validation, API endpoints.
- **Benchmarks** — processing time and memory by resolution, API throughput under concurrency.
- **Docker Hub** — multi-arch build (amd64 + arm64), automated publish on tag via GitHub Actions.
- **Security** — CSP headers, input whitelisting, magic bytes verification, log injection protection, DOMPurify for i18n HTML. Weekly pip-audit via GitHub Actions. Dependabot for pip + Docker.

#### Accessibility
- `aria-label` on all icon-only buttons
- `<main>` landmark, skip navigation link
- Focus outline restored on dropzone
- `aria-valuenow/min/max` on comparison slider
- Labeled toggle checkboxes in effects rack
- Translated accessible labels

### Bug fixes

- **int16 overflow in `_step_blue_tolerance`** — `blue_strength * 255` wrapped on strongly non-blue pixels (e.g. red). Fixed with `.astype(np.float64)` before multiplication.
- **Auto-detect after crop** — clicking Auto/Detect now re-analyzes the current (cropped) image instead of reusing stale presets from the original.
- **Alpha channel images** — files with existing transparency no longer crash the pipeline.

### Configuration

New environment variables:

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_SMOOTHING` | `30` | Edge smoothing (0–100) |
| `DEFAULT_CONTRAST` | `0` | Contrast boost (0–100) |
| `RENDER_MODE` | `auto` | `live`, `manual`, or `auto` |
| `AUTO_MANUAL_PIXELS` | `4000000` | Auto-switch threshold |
| `ANALYZE_ON_UPLOAD` | `true` | Auto-detect on upload |
| `MAX_CONCURRENT_OPS` | `4` | Parallel request limit |
| `MAX_IMAGE_DIMENSION` | `10000` | Max width/height |
| `MAX_BASE64_MB` | `10` | Max base64 response size |
| `HIDE_CONFIG_WARNINGS` | `false` | Hide WebUI warnings |

### Dependencies

- Python 3.12 → 3.14-slim (Docker base image, later migrated to DHI 3.13 in 0.3.3)
- Added: `secure` (security headers)
- Frontend: DOMPurify vendored locally

---

## [0.2.0] — Edge smoothing

- New `smoothing` parameter with progressive alpha gradient
- Anti-aliasing on signature edges (replaces binary mask)
- Configurable via env, API, and web UI

---

## [0.1.2] — Baseline

Initial stable release with dark/blue signature extraction, web UI, and REST API.
