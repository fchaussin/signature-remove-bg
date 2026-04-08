'use strict';

/**
 * utils.js — Pure utility functions (no DOM, no state).
 *
 * Table of contents:
 *  1. debounce          — cancel-aware debounce
 *  2. safeObjectURL     — blob URL with auto-revoke
 *  3. fitScale          — scale factor to fit dimensions
 *  4. drawCheckerboard  — canvas checker pattern
 *  5. postWithProgress  — XHR POST with upload progress and abort support
 *  6. Validation        — validateFile, safeErrorCode, isValidParam
 *  7. formatBase64      — format a data URI into various output templates
 */


/* ===================================================================
 *  1. Debounce
 * =================================================================== */

/** Debounce helper returning a cancel-aware wrapper. */
function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}


/* ===================================================================
 *  2. Object URL management
 * =================================================================== */

/**
 * Create a blob URL and revoke the previous one stored under the same key.
 * Prevents memory leaks from accumulated object URLs.
 */
const _objectURLs = Object.create(null);
function safeObjectURL(key, blob) {
  if (_objectURLs[key]) URL.revokeObjectURL(_objectURLs[key]);
  const url = URL.createObjectURL(blob);
  _objectURLs[key] = url;
  return url;
}


/* ===================================================================
 *  3. Scaling
 * =================================================================== */

/** Compute a scale factor to fit `imgW x imgH` within `maxW x maxH` (never upscale). */
function fitScale(imgW, imgH, maxW, maxH) {
  return Math.min(1, maxW / imgW, maxH / imgH);
}


/* ===================================================================
 *  4. Canvas
 * =================================================================== */

/** Draw a checkerboard pattern on a canvas context. */
function drawCheckerboard(ctx, w, h) {
  const size = 8;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#ddd' : '#fff';
      ctx.fillRect(x, y, size, size);
    }
  }
}


/* ===================================================================
 *  5. XHR POST with progress
 * =================================================================== */

/**
 * POST FormData to `url` with upload progress and abort support.
 * Returns a Promise resolving to { ok, status, blob?, json? }.
 *
 * @param {string}   url        — target URL
 * @param {FormData} formData   — body
 * @param {object}   opts
 * @param {AbortSignal} [opts.signal]     — abort signal
 * @param {function}    [opts.onProgress] — called with ratio 0–1
 * @param {number}      [opts.timeout]    — request timeout in ms
 */
function postWithProgress(url, formData, { signal, onProgress, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });

    // Signal upload complete when progress reaches 100%
    xhr.upload.addEventListener('load', () => {
      if (onProgress) onProgress(1);
    });

    xhr.addEventListener('load', async () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      const ct = xhr.getResponseHeader('Content-Type') || '';
      const headers = { getResponseHeader: h => xhr.getResponseHeader(h) };
      if (ct.includes('application/json')) {
        // responseType is 'blob', so parse JSON from the blob
        const text = await xhr.response.text();
        let json;
        try { json = JSON.parse(text); } catch { json = {}; }
        resolve({ ok, status: xhr.status, json, headers });
      } else {
        resolve({ ok, status: xhr.status, blob: xhr.response, headers });
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('timeout', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    });

    // Wire AbortController → xhr.abort()
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.responseType = 'blob';
    xhr.timeout = timeout;
    xhr.send(formData);
  });
}


/* ===================================================================
 *  6. Validation helpers
 * =================================================================== */

/** Validate file client-side before upload. */
function validateFile(f) {
  if (!f) return null;
  if (!ALLOWED_TYPES.includes(f.type)) return 'INVALID_FILE';
  if (f.size > MAX_CLIENT_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/** Validate a server error code against the whitelist. */
function safeErrorCode(raw) {
  return VALID_ERROR_CODES.has(raw) ? raw : 'UNKNOWN';
}

/** Validate an integer param against its range. */
function isValidParam(name, value) {
  const r = PARAM_RANGES[name];
  return r && Number.isInteger(value) && value >= r.min && value <= r.max;
}


/* ===================================================================
 *  7. Base64 formatting
 * =================================================================== */

/**
 * Format a validated data URI into the requested output template.
 *
 * @param {string} dataUri    — validated data URI (data:image/…;base64,…)
 * @param {string} fmt        — output format key
 * @param {Set}    validFmts  — whitelist of allowed format keys
 * @param {Set}    validMimes — whitelist of allowed MIME types
 * @returns {string} formatted output, or '' on invalid input
 */
function formatBase64(dataUri, fmt, validFmts, validMimes) {
  if (!validFmts.has(fmt)) return '';
  // Parse parts from data URI: "data:image/png;base64,iVBOR..."
  const semiIdx  = dataUri.indexOf(';');
  const commaIdx = dataUri.indexOf(',');
  if (semiIdx < 0 || commaIdx < 0) return '';
  const mime = dataUri.substring(5, semiIdx);       // "image/png"
  if (!validMimes.has(mime)) return '';
  const raw  = dataUri.substring(commaIdx + 1);     // raw base64 string

  switch (fmt) {
    case 'txt':                  return raw;
    case 'uri':                  return dataUri;
    case 'css_background_image': return `background-image: url(${dataUri});`;
    case 'html_favicon':         return `<link rel="icon" type="${mime}" href="${dataUri}" />`;
    case 'html_hyperlink':       return `<a href="${dataUri}">Download</a>`;
    case 'html_img':             return `<img src="${dataUri}" alt="signature" />`;
    case 'html_iframe':          return `<iframe src="${dataUri}"></iframe>`;
    case 'javascript_image':     return `const img = new Image();\nimg.src = "${dataUri}";`;
    case 'javascript_popup':     return `window.open("${dataUri}");`;
    case 'json':                 return JSON.stringify({ image: { mime, data: raw } }, null, 2);
    case 'xml':                  return `<image mime="${mime}">\n  ${raw}\n</image>`;
    default:                     return dataUri;
  }
}
