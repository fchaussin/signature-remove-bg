'use strict';

const t = i18n.t.bind(i18n);

/* =====================================================================
 *  app.js — Signature extraction tool (frontend)
 *
 *  Table of contents
 *  -----------------
 *   0. i18n alias           — t() shorthand (i18n.js loaded before this file)
 *   1. Constants            — BG_STYLES, ZOOM_SIZE, MIN_CROP, validation sets
 *   2. Helpers              — drawCheckerboard, fitScale, debounce, initBgPicker,
 *                             safeObjectURL, revokeObjectURL
 *   3. Overlay manager      — register / open / close overlays, Escape key
 *   4. DOM references       — single unified `dom` object
 *   5. Mutable state        — every `let` in one block, grouped by feature
 *   6. Core functions       — loadFile, checkResolution, extractSignature,
 *                             updateExtracted, getMimeType, downloadExtracted
 *   7. Effects rack         — FxRack instance (see fx-rack.js, fx-slot.js)
 *   8. initZoom()           — zoom popup logic
 *   9. initCrop()           — crop overlay logic
 *  10. initBase64()         — base64 export popup
 *  11. Bootstrap            — upload events, paste, init calls, bg-pickers
 * ===================================================================== */


/* ===================================================================
 *  1. Constants
 * =================================================================== */

const BG_STYLES = {
  white:   '#fff',
  checker: 'repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50%/16px 16px',
  dark:    '#333',
  blue:    '#dbeafe'
};

const ZOOM_SIZE = 400;
const MIN_CROP  = 20;

// Whitelists for input validation (OWASP A03/A08)
const VALID_BG_KEYS    = new Set(Object.keys(BG_STYLES));
const VALID_EDGES      = new Set(['top', 'bottom', 'left', 'right']);
const VALID_FORMATS    = new Set(['png', 'webp']);
const VALID_MODES      = new Set(['auto', 'dark', 'blue']);
const ALLOWED_TYPES    = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff'];
const VALID_B64_FMTS   = new Set(['txt', 'uri', 'css_background_image', 'html_favicon', 'html_hyperlink', 'html_img', 'html_iframe', 'javascript_image', 'javascript_popup', 'json', 'xml']);
const VALID_B64_MIMES  = new Set(['image/png', 'image/webp']);                       // A03 — whitelist mime types
const B64_URI_RE       = /^data:image\/(png|webp);base64,[A-Za-z0-9+/\n]+=*$/;      // A08 — strict data URI pattern
const MAX_CLIENT_BYTES = 50 * 1024 * 1024; // 50 MB — must match server MAX_UPLOAD_MB
const XHR_TIMEOUT_MS   = 120_000;         // A05 — cap request duration (upload + processing)

// A03 — whitelist error codes accepted from the server
const VALID_ERROR_CODES = new Set([
  'FILE_REQUIRED', 'INVALID_FILE', 'FILE_TOO_LARGE',
  'IMAGE_TOO_LARGE', 'PROCESSING_FAILED', 'UNKNOWN', 'NETWORK',
]);

// A04 — whitelist MIME types accepted in extraction responses
const VALID_RESPONSE_MIMES = new Set(['image/png', 'image/webp']);

// Effects rack defaults (consumed by FxRack / FxSlot)
const FX_DEFAULTS = {
  threshold:      { off: 220 },
  blue_tolerance: { off: 80 },
  smoothing:      { off: 0 },
  contrast:       { off: 0 },
};


/* ===================================================================
 *  2. Helpers
 * =================================================================== */

/**
 * Attach a bg-picker inside `container`, applying styles to `target`.
 * Pickers registered in the same sync group stay in sync.
 */
const _bgPickerGroups = {};

function initBgPicker(container, target, syncGroup) {
  const picker = container.querySelector('.bg-picker') || container.querySelector('.zoom-bg-picker');
  if (!picker) return;

  // Register in sync group
  if (syncGroup) {
    if (!_bgPickerGroups[syncGroup]) _bgPickerGroups[syncGroup] = [];
    _bgPickerGroups[syncGroup].push({ picker, target });
  }

  picker.addEventListener('click', e => {
    const swatch = e.target.closest('.bg-swatch');
    if (!swatch) return;
    const bg = swatch.dataset.bg;
    if (!VALID_BG_KEYS.has(bg)) return; // reject unknown keys (OWASP A03)
    e.stopPropagation();

    // Apply to all pickers in the same sync group
    const peers = syncGroup ? _bgPickerGroups[syncGroup] : [{ picker, target }];
    for (const peer of peers) {
      peer.picker.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
      peer.picker.querySelector(`[data-bg="${bg}"]`).classList.add('active');
      peer.target.style.background = BG_STYLES[bg];
    }
  });
}

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

/** Compute a scale factor to fit `imgW x imgH` within `maxW x maxH` (never upscale). */
function fitScale(imgW, imgH, maxW, maxH) {
  return Math.min(1, maxW / imgW, maxH / imgH);
}

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

/**
 * Create a blob URL and revoke the previous one stored under the same key.
 * Prevents memory leaks from accumulated object URLs (OWASP A04).
 */
const _objectURLs = Object.create(null);
function safeObjectURL(key, blob) {
  if (_objectURLs[key]) URL.revokeObjectURL(_objectURLs[key]);
  const url = URL.createObjectURL(blob);
  _objectURLs[key] = url;
  return url;
}


/* ===================================================================
 *  3. Dialog helpers — native <dialog> with showModal / close
 * =================================================================== */

/**
 * Register a <dialog> with an optional onClose callback.
 * The native `cancel` event (Escape key) is handled automatically.
 */
function registerDialog(dialog, onClose) {
  dialog.addEventListener('cancel', e => {
    e.preventDefault(); // prevent default close to run our callback
    if (onClose) onClose();
    else dialog.close();
  });
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}


/* ===================================================================
 *  4. DOM references — single unified object
 * =================================================================== */

const dom = {
  // Root sections
  dropzone:        document.getElementById('dropzone'),
  editor:          document.getElementById('editor'),
  zoomOverlay:     document.getElementById('zoom'),
  cropOverlay:     document.getElementById('crop'),
  base64Overlay:   document.getElementById('base64'),

  // Dynamic lookups — whitelisted to prevent selector injection (OWASP A03)
  _VALID_PARAMS: new Set(['mode', 'format']),
  _VALID_DISPLAYS: new Set([]),
  param(name) {
    if (!this._VALID_PARAMS.has(name)) return null;
    return this.editor.querySelector(`[data-param="${name}"]`);
  },
  display(name) {
    if (!this._VALID_DISPLAYS.has(name)) return null;
    return this.editor.querySelector(`[data-display="${name}"]`);
  },

  // Populated below after root refs exist
  fileInput:       null,

  // Original panel
  originalPanel:   null,
  originalImg:     null,
  resInfo:         null,
  resHint:         null,

  // Extracted panel
  extractedPanel:  null,
  extractedImg:    null,
  extractedBg:     null,
  statusLabel:     null,

  // Zoom children
  zoomViewport:    null,
  zoomImg:         null,
  zoomHint:        null,
  zoomCloseBtn:    null,

  // Crop children
  cropArea:        null,
  cropCanvas:      null,
  cropShades:      {},
  cropHandles:     {},

  // Base64 children
  base64Textarea:  null,
  base64CopyBtn:   null,
  base64Format:    null,

};

// Dropzone
dom.fileInput = dom.dropzone.querySelector('.file-input');

// Editor panels
dom.originalPanel  = dom.editor.querySelector('[data-role="original"]');
dom.extractedPanel = dom.editor.querySelector('[data-role="extracted"]');

// Original panel children
dom.originalImg = dom.originalPanel.querySelector('.preview-img');
dom.resInfo     = dom.originalPanel.querySelector('.res-info');
dom.resHint     = dom.originalPanel.querySelector('.res-hint');

// Extracted panel children
dom.extractedImg     = dom.extractedPanel.querySelector('.preview-img');
dom.extractedBg      = dom.extractedPanel.querySelector('.preview-bg');
dom.statusLabel      = dom.extractedPanel.querySelector('.status');
dom.progressBar      = dom.extractedPanel.querySelector('.progress-bar');
dom.compareSlider    = dom.extractedPanel.querySelector('.compare-slider');
dom.compareBefore    = dom.extractedPanel.querySelector('.compare-before');
dom.compareBeforeImg = dom.extractedPanel.querySelector('.compare-before-img');
dom.compareHandle    = dom.extractedPanel.querySelector('.compare-handle');

// Zoom children
dom.zoomViewport = dom.zoomOverlay.querySelector('.zoom-viewport');
dom.zoomImg      = dom.zoomOverlay.querySelector('.zoom-img');
dom.zoomHint     = dom.zoomOverlay.querySelector('.zoom-hint');
dom.zoomCloseBtn = dom.zoomOverlay.querySelector('.zoom-close');

// Crop children
dom.cropArea   = dom.cropOverlay.querySelector('.crop-area');
dom.cropCanvas = dom.cropArea.querySelector('canvas');
['top', 'bottom', 'left', 'right'].forEach(edge => {
  dom.cropShades[edge]  = dom.cropArea.querySelector(`.crop-shade[data-edge="${edge}"]`);
  dom.cropHandles[edge] = dom.cropArea.querySelector(`.crop-handle[data-edge="${edge}"]`);
});

// Base64 children
dom.base64Textarea = dom.base64Overlay.querySelector('.base64-textarea');
dom.base64CopyBtn  = dom.base64Overlay.querySelector('[data-action="copy"]');
dom.base64Format   = dom.base64Overlay.querySelector('[data-param="base64-format"]');

// Auto-detect
dom.autoDetectBtn  = dom.editor.querySelector('[data-action="auto-detect"]');


/* ===================================================================
 *  5. Mutable state — grouped by feature
 * =================================================================== */

// Core
let currentFile       = null;
let extractController = null;  // AbortController for in-flight extraction
let naturalW          = 0;
let naturalH          = 0;
let lastExtractedBlob = null;

// Zoom
let zoomIsFit = false;
let zoomImgW  = 0;
let zoomImgH  = 0;

// Crop
let cropImg      = new Image();
let cropScale    = 1;
let cropCanvasW  = 0;
let cropCanvasH  = 0;
let cropEdges    = { top: 0, bottom: 0, left: 0, right: 0 };
let activeHandle = null;
let dragStartX   = 0;
let dragStartY   = 0;
let dragStartVal = 0;

// Base64
let base64DataUri = '';

// Auto-detect
let pendingPresets = null;  // presets from /analyze, awaiting user click

// Rack — initialized in Bootstrap
let fxRack = null;


/* ===================================================================
 *  6. Core functions
 * =================================================================== */

/** Toggle busy state — disables controls and shows progress bar. */
function setBusy(busy) {
  dom.editor.classList.toggle('busy', busy);
  dom.extractedPanel.setAttribute('aria-busy', busy);
  if (!busy) {
    dom.progressBar.style.width = '';
    dom.progressBar.classList.remove('indeterminate');
  }
}

/** Set the progress bar to a determinate percentage (0-100). */
function setProgress(pct) {
  dom.progressBar.classList.remove('indeterminate');
  dom.progressBar.style.width = Math.round(pct) + '%';
}

/** Switch the progress bar to indeterminate (processing phase). */
function setIndeterminate() {
  dom.progressBar.style.width = '';
  dom.progressBar.classList.add('indeterminate');
}

/**
 * POST FormData to `url` with upload progress and abort support.
 * Returns a Promise resolving to { ok, status, blob?, json? }.
 */
function postWithProgress(url, formData, { signal, onProgress }) {
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
      if (ct.includes('application/json')) {
        // responseType is 'blob', so parse JSON from the blob
        const text = await xhr.response.text();
        let json;
        try { json = JSON.parse(text); } catch { json = {}; }
        resolve({ ok, status: xhr.status, json });
      } else {
        resolve({ ok, status: xhr.status, blob: xhr.response });
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('timeout', () => reject(new Error('Network error')));  // A05
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
    xhr.timeout = XHR_TIMEOUT_MS;                                               // A05
    xhr.send(formData);
  });
}

/** Validate file client-side before upload (OWASP A04 — early rejection). */
function validateFile(f) {
  if (!f) return null;
  if (!ALLOWED_TYPES.includes(f.type)) return 'INVALID_FILE';
  if (f.size > MAX_CLIENT_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

function loadFile(f) {
  if (!f) return;
  const err = validateFile(f);
  if (err) {
    dom.editor.classList.add('visible');
    dom.statusLabel.textContent = t('error.' + err);
    return;
  }
  currentFile = f;
  dom.originalImg.src = safeObjectURL('original', f);
  dom.originalImg.onload = () => {
    naturalW = dom.originalImg.naturalWidth;
    naturalH = dom.originalImg.naturalHeight;
    checkResolution();
    syncCompareBeforeImg();
  };
  dom.editor.classList.add('visible');
  extractSignature();
  analyzeImage();  // parallel — suggests optimal presets via ✦ Auto button
}

function checkResolution() {
  dom.resInfo.textContent = `(${naturalW}\u00d7${naturalH})`;
  const ratio = naturalW / dom.originalImg.clientWidth;

  dom.resHint.style.display = 'none';
  dom.resHint.className = 'res-hint';

  if (ratio < 0.8) {
    dom.resHint.className = 'res-hint warn-small';
    dom.resHint.textContent = t('hint.small_image', { w: naturalW, h: naturalH });
    dom.resHint.style.display = 'block';
  } else if (ratio > 2.5) {
    dom.resHint.className = 'res-hint warn-large';
    dom.resHint.textContent = t('hint.large_image', { w: naturalW, h: naturalH });
    dom.resHint.style.display = 'block';
  }
}

async function extractSignature() {
  if (!currentFile) return;

  // Abort any in-flight extraction
  if (extractController) extractController.abort();
  extractController = new AbortController();

  setBusy(true);
  dom.statusLabel.textContent = t('status.uploading');
  setProgress(0);

  const fd = new FormData();
  fd.append('file', currentFile);
  const fx = fxRack ? fxRack.getValues() : {};
  const params = new URLSearchParams({
    mode:           dom.param('mode').value,
    threshold:      fx.threshold      ?? 220,
    blue_tolerance: fx.blue_tolerance ?? 80,
    smoothing:      fx.smoothing      ?? 0,
    contrast:       fx.contrast       ?? 0,
    format:         dom.param('format').value
  });

  try {
    const res = await postWithProgress(`/extract?${params}`, fd, {
      signal: extractController.signal,
      onProgress(ratio) {
        setProgress(ratio * 100);
        if (ratio >= 1) {
          dom.statusLabel.textContent = t('status.processing');
          setIndeterminate();
        }
      },
    });
    if (!res.ok) {
      const raw = (res.json && res.json.code) || '';
      const code = VALID_ERROR_CODES.has(raw) ? raw : 'UNKNOWN';               // A03
      dom.statusLabel.textContent = t('error.' + code);
      setBusy(false);
      return;
    }
    if (!res.blob || !VALID_RESPONSE_MIMES.has(res.blob.type)) {               // A04
      dom.statusLabel.textContent = t('error.UNKNOWN');
      setBusy(false);
      return;
    }
    lastExtractedBlob = res.blob;
    dom.extractedImg.src = safeObjectURL('extracted', lastExtractedBlob);
    dom.statusLabel.textContent = '';
    setBusy(false);
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer request
    dom.statusLabel.textContent = t('error.NETWORK');
    setBusy(false);
  }
}

function updateExtracted(blob) {
  lastExtractedBlob = blob;
  dom.extractedImg.src = safeObjectURL('extracted', blob);
}

function getMimeType() {
  return dom.param('format').value === 'webp' ? 'image/webp' : 'image/png';
}

function downloadExtracted() {
  const fmt = dom.param('format').value;
  if (!VALID_FORMATS.has(fmt)) return; // reject tampered value (OWASP A03)
  const a = document.createElement('a');
  a.href = dom.extractedImg.src;
  a.download = `signature.${fmt}`;
  a.click();
}

/**
 * POST the current file to /analyze and store the suggested presets.
 * Called in parallel with extractSignature() on upload.
 * When complete, the "Auto" button pulses to signal readiness.
 */
async function analyzeImage() {
  if (!currentFile) return;
  pendingPresets = null;
  dom.autoDetectBtn.classList.remove('ready');

  const fd = new FormData();
  fd.append('file', currentFile);

  try {
    const res = await fetch('/analyze', { method: 'POST', body: fd });
    if (!res.ok) return;
    const data = await res.json();
    // A03 — validate returned presets against whitelists and ranges
    if (!data || typeof data !== 'object') return;
    if (!VALID_MODES.has(data.mode)) return;
    if (!Number.isInteger(data.threshold)      || data.threshold < 50       || data.threshold > 250) return;
    if (!Number.isInteger(data.blue_tolerance)  || data.blue_tolerance < 20  || data.blue_tolerance > 200) return;
    if (!Number.isInteger(data.smoothing)       || data.smoothing < 0        || data.smoothing > 100) return;
    if (!Number.isInteger(data.contrast)        || data.contrast < 0         || data.contrast > 100) return;

    pendingPresets = data;
    dom.autoDetectBtn.classList.add('ready');
  } catch {
    // Analysis is optional — silently ignore failures
  }
}

/**
 * Apply pending presets to the mode select and effect rack,
 * then re-trigger extraction with the new values.
 */
function applyPresets() {
  if (!pendingPresets || !fxRack) return;
  const p = pendingPresets;

  // Mode
  dom.param('mode').value = p.mode;
  // Sync blue_tolerance visibility
  const blueSlot = fxRack.get('blue_tolerance');
  if (blueSlot) {
    const hidden = p.mode !== 'auto' && p.mode !== 'blue';
    blueSlot.el.style.display = hidden ? 'none' : '';
  }

  // Effect sliders
  const presetSlots = { threshold: p.threshold, blue_tolerance: p.blue_tolerance, smoothing: p.smoothing, contrast: p.contrast };
  for (const [name, value] of Object.entries(presetSlots)) {
    const slot = fxRack.get(name);
    if (slot) slot.setValue(value);
  }

  pendingPresets = null;
  dom.autoDetectBtn.classList.remove('ready');

  // Re-extract with the new parameters
  extractSignature();
}


/* ===================================================================
 *  7. Effects rack — FxRack instance (see fx-rack.js, fx-slot.js)
 * =================================================================== */

const debouncedExtract = debounce(extractSignature, 300);


/* ===================================================================
 *  8. initZoom() — zoom popup logic
 * =================================================================== */

function initZoom() {

  function openZoom(src) {
    const img = new Image();
    img.onload = () => {
      dom.zoomImg.src          = src;
      dom.zoomImg.style.width  = img.naturalWidth + 'px';
      dom.zoomImg.style.height = img.naturalHeight + 'px';

      const isFit = img.naturalWidth <= ZOOM_SIZE && img.naturalHeight <= ZOOM_SIZE;
      dom.zoomImg.style.left = ((ZOOM_SIZE - img.naturalWidth) / 2) + 'px';
      dom.zoomImg.style.top  = ((ZOOM_SIZE - img.naturalHeight) / 2) + 'px';

      dom.zoomViewport.style.cursor = isFit ? 'default' : 'grab';
      const sizeParams = { w: img.naturalWidth, h: img.naturalHeight };
      dom.zoomHint.textContent = isFit
        ? t('zoom.actual_size', sizeParams)
        : t('zoom.actual_size_pan', sizeParams);

      openDialog(dom.zoomOverlay);
      zoomIsFit = isFit;
      zoomImgW  = img.naturalWidth;
      zoomImgH  = img.naturalHeight;
    };
    img.src = src;
  }

  // Pan on mousemove
  dom.zoomViewport.addEventListener('mousemove', e => {
    if (!dom.zoomOverlay.open || zoomIsFit) return;
    const rect = dom.zoomViewport.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / ZOOM_SIZE;
    const ry = (e.clientY - rect.top) / ZOOM_SIZE;
    dom.zoomImg.style.left = (-rx * Math.max(0, zoomImgW - ZOOM_SIZE)) + 'px';
    dom.zoomImg.style.top  = (-ry * Math.max(0, zoomImgH - ZOOM_SIZE)) + 'px';
  });

  // Close buttons
  dom.zoomCloseBtn.onclick = e => {
    e.stopPropagation();
    closeDialog(dom.zoomOverlay);
  };
  // Click on backdrop (the dialog element itself) closes
  dom.zoomOverlay.onclick = e => {
    if (e.target === dom.zoomOverlay) closeDialog(dom.zoomOverlay);
  };

  // Zoom buttons
  dom.originalPanel.querySelector('[data-action="zoom"]').onclick = () => {
    if (dom.originalImg.src) openZoom(dom.originalImg.src);
  };
  dom.extractedPanel.querySelector('[data-action="zoom"]').onclick = () => {
    if (dom.extractedImg.src) openZoom(dom.extractedImg.src);
  };

  initBgPicker(dom.zoomOverlay, dom.zoomViewport, 'extracted');
  registerDialog(dom.zoomOverlay);
}


/* ===================================================================
 *  9. initCrop() — crop overlay logic
 * =================================================================== */

function initCrop() {
  const cropCtx = dom.cropCanvas.getContext('2d');

  function drawCropCanvas() {
    drawCheckerboard(cropCtx, cropCanvasW, cropCanvasH);
    cropCtx.drawImage(cropImg, 0, 0, cropCanvasW, cropCanvasH);
  }

  function updateCropUI() {
    const { top: t, bottom: b, left: l, right: r } = cropEdges;

    dom.cropShades.top.style.cssText    = `top:0;left:0;right:0;height:${t}px`;
    dom.cropShades.bottom.style.cssText = `bottom:0;left:0;right:0;height:${b}px`;
    dom.cropShades.left.style.cssText   = `top:${t}px;bottom:${b}px;left:0;width:${l}px`;
    dom.cropShades.right.style.cssText  = `top:${t}px;bottom:${b}px;right:0;width:${r}px`;

    for (const [edge, el] of Object.entries(dom.cropHandles)) {
      if (edge === 'top' || edge === 'bottom') {
        el.style[edge] = cropEdges[edge] + 'px';
        el.style.left  = l + 'px';
        el.style.right = r + 'px';
      } else {
        el.style[edge]   = cropEdges[edge] + 'px';
        el.style.top     = t + 'px';
        el.style.bottom  = b + 'px';
      }
    }
  }

  // Handle drag — validate edge against whitelist (OWASP A08)
  dom.cropArea.addEventListener('mousedown', e => {
    const handle = e.target.closest('.crop-handle');
    if (!handle) return;
    const edge = handle.dataset.edge;
    if (!VALID_EDGES.has(edge)) return;
    e.preventDefault();
    activeHandle = edge;
    dragStartX   = e.clientX;
    dragStartY   = e.clientY;
    dragStartVal = cropEdges[activeHandle];
  });

  window.addEventListener('mousemove', e => {
    if (!activeHandle) return;
    const isVertical = activeHandle === 'top' || activeHandle === 'bottom';
    const isInverted = activeHandle === 'bottom' || activeHandle === 'right';
    const delta = isVertical ? (e.clientY - dragStartY) : (e.clientX - dragStartX);
    const opposite = isVertical
      ? (activeHandle === 'top' ? 'bottom' : 'top')
      : (activeHandle === 'left' ? 'right' : 'left');
    const totalSize = isVertical ? cropCanvasH : cropCanvasW;
    const maxVal = totalSize - cropEdges[opposite] - MIN_CROP;

    cropEdges[activeHandle] = Math.max(0, Math.min(dragStartVal + (isInverted ? -delta : delta), maxVal));
    updateCropUI();
  });

  window.addEventListener('mouseup', () => { activeHandle = null; });

  // Open crop overlay (operates on the original image)
  dom.originalPanel.querySelector('[data-action="crop"]').onclick = () => {
    if (!currentFile) return;
    cropImg.onload = () => {
      cropScale   = fitScale(cropImg.width, cropImg.height, window.innerWidth * 0.85, window.innerHeight * 0.7);
      cropCanvasW = Math.round(cropImg.width * cropScale);
      cropCanvasH = Math.round(cropImg.height * cropScale);
      dom.cropCanvas.width  = cropCanvasW;
      dom.cropCanvas.height = cropCanvasH;
      drawCropCanvas();
      cropEdges = { top: 0, bottom: 0, left: 0, right: 0 };
      updateCropUI();
      openDialog(dom.cropOverlay);
    };
    cropImg.src = safeObjectURL('cropSrc', currentFile);
  };

  // Cancel
  dom.cropOverlay.querySelector('[data-action="cancel"]').onclick = () => closeDialog(dom.cropOverlay);

  // Apply
  dom.cropOverlay.querySelector('[data-action="apply"]').onclick = () => {
    const sx = Math.round(cropEdges.left / cropScale);
    const sy = Math.round(cropEdges.top / cropScale);
    const sw = Math.round((cropCanvasW - cropEdges.left - cropEdges.right) / cropScale);
    const sh = Math.round((cropCanvasH - cropEdges.top - cropEdges.bottom) / cropScale);

    if (sw < 5 || sh < 5) {
      closeDialog(dom.cropOverlay);
      return;
    }

    const out = document.createElement('canvas');
    out.width  = sw;
    out.height = sh;
    const outCtx = out.getContext('2d');
    outCtx.drawImage(cropImg, sx, sy, sw, sh, 0, 0, sw, sh);

    out.toBlob(blob => {
      currentFile = new File([blob], 'cropped.png', { type: blob.type });
      dom.originalImg.src = safeObjectURL('original', blob);
      dom.originalImg.onload = () => {
        naturalW = dom.originalImg.naturalWidth;
        naturalH = dom.originalImg.naturalHeight;
        checkResolution();
        syncCompareBeforeImg();
      };
      closeDialog(dom.cropOverlay);
      extractSignature();
    }, 'image/png');
  };

  registerDialog(dom.cropOverlay);
}


/* ===================================================================
 *  10. initBase64() — base64 export popup
 * =================================================================== */

function initBase64() {

  /**
   * Format the raw data URI according to the selected output template.
   * The dataUri is already validated (A08) before being stored.
   */
  function formatBase64(dataUri, fmt) {
    if (!VALID_B64_FMTS.has(fmt)) return '';        // A03 — reject unknown format
    // Parse parts from data URI: "data:image/png;base64,iVBOR..."
    const semiIdx  = dataUri.indexOf(';');
    const commaIdx = dataUri.indexOf(',');
    if (semiIdx < 0 || commaIdx < 0) return '';     // A08 — malformed URI
    const mime = dataUri.substring(5, semiIdx);      // "image/png"
    if (!VALID_B64_MIMES.has(mime)) return '';        // A03 — reject unexpected mime
    const raw  = dataUri.substring(commaIdx + 1);    // raw base64 string

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

  function updateTextarea() {
    if (!base64DataUri) return;
    dom.base64Textarea.value = formatBase64(base64DataUri, dom.base64Format.value);
  }

  async function openBase64() {
    if (!currentFile) return;

    if (extractController) extractController.abort();
    extractController = new AbortController();

    setBusy(true);
    dom.statusLabel.textContent = t('status.uploading');
    setProgress(0);

    const fd = new FormData();
    fd.append('file', currentFile);
    const fx = fxRack ? fxRack.getValues() : {};
    const params = new URLSearchParams({
      mode:           dom.param('mode').value,
      threshold:      fx.threshold      ?? 220,
      blue_tolerance: fx.blue_tolerance ?? 80,
      smoothing:      fx.smoothing      ?? 0,
      contrast:       fx.contrast       ?? 0,
      format:         dom.param('format').value,
      output:         'base64'
    });

    try {
      const res = await postWithProgress(`/extract?${params}`, fd, {
        signal: extractController.signal,
        onProgress(ratio) {
          setProgress(ratio * 100);
          if (ratio >= 1) {
            dom.statusLabel.textContent = t('status.processing');
            setIndeterminate();
          }
        },
      });
      if (!res.ok) {
        const raw = (res.json && res.json.code) || '';
        const code = VALID_ERROR_CODES.has(raw) ? raw : 'UNKNOWN';             // A03
        dom.statusLabel.textContent = t('error.' + code);
        setBusy(false);
        return;
      }
      const data = res.json;
      // A08 — strict validation: must be data:image/(png|webp);base64, with valid chars only
      if (!data || typeof data.base64 !== 'string' || !B64_URI_RE.test(data.base64)) {
        dom.statusLabel.textContent = t('error.UNKNOWN');
        setBusy(false);
        return;
      }
      base64DataUri = data.base64;
      updateTextarea();
      dom.statusLabel.textContent = '';
      setBusy(false);
      openDialog(dom.base64Overlay);
    } catch (err) {
      if (err.name === 'AbortError') return;
      dom.statusLabel.textContent = t('error.NETWORK');
      setBusy(false);
    }
  }

  // Re-format when the output format changes
  dom.base64Format.onchange = updateTextarea;

  // Copy to clipboard
  dom.base64CopyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(dom.base64Textarea.value);
      const original = dom.base64CopyBtn.textContent;
      dom.base64CopyBtn.textContent = t('btn.copied');
      setTimeout(() => { dom.base64CopyBtn.textContent = original; }, 1500);
    } catch {
      dom.base64Textarea.select();
    }
  };

  // Open via button
  dom.extractedPanel.querySelector('[data-action="base64"]').onclick = openBase64;

  // Close & clear (A04 — don't leave image data in DOM)
  function closeBase64() {
    closeDialog(dom.base64Overlay);
    dom.base64Textarea.value = '';
    base64DataUri = '';
  }

  dom.base64Overlay.querySelector('[data-action="cancel"]').onclick = closeBase64;

  registerDialog(dom.base64Overlay, closeBase64);
}


/* ===================================================================
 *  11. Comparison slider — before/after image overlay
 * =================================================================== */

function initCompareSlider() {
  let dragging = false;
  const toggle = dom.extractedPanel.querySelector('[data-action="toggle-compare"]');

  function isActive() {
    return !dom.compareSlider.classList.contains('off');
  }

  function setPosition(pct) {
    pct = Math.max(0, Math.min(100, pct));
    dom.compareBefore.style.width = pct + '%';
    dom.compareHandle.style.left  = pct + '%';
    // The before image must span the full slider width so it aligns with the after image
    if (pct > 0) {
      dom.compareBeforeImg.style.width = dom.compareSlider.offsetWidth + 'px';
    }
  }

  function posFromEvent(e) {
    const rect = dom.compareSlider.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return ((clientX - rect.left) / rect.width) * 100;
  }

  // Toggle on/off
  toggle.onchange = () => {
    dom.compareSlider.classList.toggle('off', !toggle.checked);
  };

  dom.compareSlider.addEventListener('pointerdown', e => {
    if (!isActive()) return;
    dragging = true;
    dom.compareSlider.setPointerCapture(e.pointerId);
    setPosition(posFromEvent(e));
  });

  dom.compareSlider.addEventListener('pointermove', e => {
    if (!dragging) return;
    setPosition(posFromEvent(e));
  });

  dom.compareSlider.addEventListener('pointerup', () => { dragging = false; });
  dom.compareSlider.addEventListener('pointercancel', () => { dragging = false; });

  // Keyboard support on the handle
  dom.compareHandle.addEventListener('keydown', e => {
    const step = 2;
    if (e.key === 'ArrowLeft')  setPosition(parseFloat(dom.compareHandle.style.left) - step);
    else if (e.key === 'ArrowRight') setPosition(parseFloat(dom.compareHandle.style.left) + step);
  });

  // Initialize fully showing the extracted image
  setPosition(0);
}

/** Sync the comparison "before" image with the current original source. */
function syncCompareBeforeImg() {
  if (dom.originalImg.src) {
    dom.compareBeforeImg.src = dom.originalImg.src;
  }
}


/* ===================================================================
 *  12. Bootstrap — wire everything up
 * =================================================================== */

// Upload: click, drag & drop
dom.dropzone.onclick = () => dom.fileInput.click();
dom.dropzone.ondragover = e => {
  e.preventDefault();
  dom.dropzone.classList.add('dragover');
};
dom.dropzone.ondragleave = () => dom.dropzone.classList.remove('dragover');
dom.dropzone.ondrop = e => {
  e.preventDefault();
  dom.dropzone.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
};
dom.fileInput.onchange = () => {
  loadFile(dom.fileInput.files[0]);
  dom.fileInput.value = '';
};

// Upload: paste
document.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      loadFile(item.getAsFile());
      return;
    }
  }
});

// Global controls (outside rack)
dom.param('mode').onchange = () => {
  const blueSlot = fxRack.get('blue_tolerance');
  if (blueSlot) {
    const mode = dom.param('mode').value;
    const hidden = mode !== 'auto' && mode !== 'blue';
    blueSlot.el.style.display = hidden ? 'none' : '';
  }
  debouncedExtract();
};
dom.param('format').onchange = debouncedExtract;

// Auto-detect button
dom.autoDetectBtn.onclick = applyPresets;

// Effects rack (FxRack scans DOM slots and wires toggles + sliders + drag & drop)
fxRack = new FxRack(document.querySelector('.rack'), {
  defaults: FX_DEFAULTS,
  onChange: debouncedExtract,
});

// Extracted panel: bg picker & download
initBgPicker(dom.extractedPanel, dom.extractedBg, 'extracted');
dom.extractedPanel.querySelector('[data-action="download"]').onclick = downloadExtracted;

// Comparison slider
initCompareSlider();

// Feature overlays
initZoom();
initCrop();
initBase64();

// i18n — detect browser language and apply translations
// Inject SVG icons into all [data-icon] placeholders
Icon.inject();

i18n.init();

// Load server defaults and apply to controls (OWASP A08 — validate response shape)
fetch('/config')
  .then(res => res.ok ? res.json() : null)
  .then(cfg => {
    if (!cfg || typeof cfg !== 'object') return;

    if (VALID_MODES.has(cfg.mode)) {
      dom.param('mode').value = cfg.mode;
      dom.param('mode').onchange();
    }
    if (VALID_FORMATS.has(cfg.format)) {
      dom.param('format').value = cfg.format;
    }
    // Apply server defaults to rack slots via FxSlot.setValue()
    const cfgSlots = {
      threshold:      { min: 50,  max: 250 },
      blue_tolerance: { min: 20,  max: 200 },
      smoothing:      { min: 0,   max: 100 },
      contrast:       { min: 0,   max: 100 },
    };
    for (const [name, range] of Object.entries(cfgSlots)) {
      if (Number.isInteger(cfg[name]) && cfg[name] >= range.min && cfg[name] <= range.max) {
        const slot = fxRack.get(name);
        if (slot) slot.setValue(cfg[name]);
      }
    }
  })
  .catch(() => {});
