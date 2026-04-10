'use strict';

/**
 * constants.js — Shared constants (validation whitelists, ranges, limits).
 *
 * Table of contents:
 *  1. UI constants        — BG_STYLES, ZOOM_SIZE, MIN_CROP, VALID_EDGES
 *  2. Validation sets     — file types, modes, formats, effects, error codes
 *  3. Parameter ranges    — slider min/max/off per effect (must match server)
 *  4. Base64 validation   — format keys, MIME whitelist, URI pattern
 *  5. Limits              — upload size, XHR timeout
 */


/* ===================================================================
 *  1. UI constants
 * =================================================================== */

const BG_STYLES = {
  white:   '#fff',
  checker: 'repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50%/16px 16px',
  dark:    '#333',
  blue:    '#dbeafe'
};

const ZOOM_SIZE = 400;
const MIN_CROP  = 20;

const VALID_BG_KEYS = new Set(Object.keys(BG_STYLES));
const VALID_EDGES   = new Set(['top', 'bottom', 'left', 'right']);


/* ===================================================================
 *  2. Validation whitelists
 * =================================================================== */

const VALID_FORMATS    = new Set(['png', 'webp']);
const VALID_MODES      = new Set(['auto', 'dark', 'blue']);
const ALLOWED_TYPES    = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff'];

// Whitelist error codes accepted from the server
const VALID_ERROR_CODES = new Set([
  'FILE_REQUIRED', 'INVALID_FILE', 'FILE_TOO_LARGE',
  'IMAGE_TOO_LARGE', 'PROCESSING_FAILED', 'UNKNOWN', 'NETWORK',
]);

// Whitelist MIME types accepted in extraction responses
const VALID_RESPONSE_MIMES = new Set(['image/png', 'image/webp']);


/* ===================================================================
 *  3. Parameter ranges — single source of truth (must match server)
 * =================================================================== */

const PARAM_RANGES = {
  threshold:      { min: 50,  max: 250, off: 220 },
  blue_tolerance: { min: 20,  max: 200, off: 80 },
  smoothing:      { min: 0,   max: 100, off: 0 },
  contrast:       { min: 0,   max: 100, off: 0 },
  clean_lines:    { min: 0,   max: 100, off: 0 },
};

// Valid effect names (must match server VALID_EFFECTS)
const VALID_EFFECTS = new Set(Object.keys(PARAM_RANGES));


/* ===================================================================
 *  4. Base64 validation
 * =================================================================== */

const VALID_B64_FMTS  = new Set(['txt', 'uri', 'css_background_image', 'html_favicon', 'html_hyperlink', 'html_img', 'html_iframe', 'javascript_image', 'javascript_popup', 'json', 'xml']);
const VALID_B64_MIMES = new Set(['image/png', 'image/webp']);
const B64_URI_RE      = /^data:image\/(png|webp);base64,[A-Za-z0-9+/\n]+=*$/;


/* ===================================================================
 *  5. Limits
 * =================================================================== */

const MAX_CLIENT_BYTES = 50 * 1024 * 1024; // 50 MB — must match server MAX_UPLOAD_MB
