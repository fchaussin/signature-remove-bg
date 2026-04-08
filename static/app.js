'use strict';

const t = i18n.t.bind(i18n);

/* =====================================================================
 *  app.js — Signature extraction tool (frontend)
 *
 *  Table of contents
 *  -----------------
 *   0. i18n alias           — t() shorthand (i18n.js loaded before this file)
 *   1. Constants            — BG_STYLES, ZOOM_SIZE, MIN_CROP, validation sets
 *   2. (moved to ui.js)     — generic UI helpers
 *   3. DOM references       — single unified `dom` object
 *   4. Mutable state        — every `let` in one block, grouped by feature
 *   5. Core functions       — loadFile, checkResolution, extractSignature,
 *                             updateExtracted, getMimeType, downloadExtracted
 *   6. Presets              — save / load / delete, dirty state, API doc
 *   7. Render mode          — live / manual / auto
 *   8. Effects rack         — FxRack instance (see fx-rack.js, fx-slot.js)
 *   9. initZoom()           — zoom popup logic
 *  10. initCrop()           — crop overlay logic
 *  11. initBase64()         — base64 export popup
 *  12. Bootstrap            — upload events, paste, init calls, bg-pickers
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

// Centralized parameter ranges — single source of truth (must match server PARAM_RANGES)
const PARAM_RANGES = {
  threshold:      { min: 50,  max: 250, off: 220 },
  blue_tolerance: { min: 20,  max: 200, off: 80 },
  smoothing:      { min: 0,   max: 100, off: 0 },
  contrast:       { min: 0,   max: 100, off: 0 },
};

// Valid effect names (must match server VALID_EFFECTS)
const VALID_EFFECTS = new Set(Object.keys(PARAM_RANGES));


/* ===================================================================
 *  2. Helpers — see ui.js for generic UI utilities
 *     (debounce, toggleCollapse, dialog, safeObjectURL, fitScale,
 *      drawCheckerboard, initBgPicker)
 * =================================================================== */


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
  savePresetOverlay: document.getElementById('save-preset'),
  deletePresetOverlay: document.getElementById('delete-preset'),

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

// Presets
dom.presetSelect   = dom.editor.querySelector('[data-param="preset"]');
dom.savePresetBtn  = dom.editor.querySelector('[data-action="save-preset"]');
dom.deletePresetBtn = dom.editor.querySelector('[data-action="delete-preset"]');
dom.presetNameInput   = dom.savePresetOverlay.querySelector('.preset-name-input');
dom.confirmSaveBtn    = dom.savePresetOverlay.querySelector('[data-action="confirm-save"]');
dom.deletePresetMsg   = dom.deletePresetOverlay.querySelector('.delete-preset-msg');
dom.confirmDeleteBtn  = dom.deletePresetOverlay.querySelector('[data-action="confirm-delete"]');

// API doc
dom.apiDoc           = dom.editor.querySelector('.api-doc');
dom.apiEndpoint      = dom.editor.querySelector('.api-doc-endpoint');
dom.apiParamsBody    = dom.editor.querySelector('.api-doc-params tbody');
dom.apiResponseMime  = dom.editor.querySelector('.api-doc-response-mime');
dom.apiDetails       = dom.editor.querySelector('.api-doc-details');
dom.apiToggleBtn     = dom.editor.querySelector('[data-action="toggle-api"]');
dom.apiExpandBtn     = dom.editor.querySelector('[data-action="expand-api"]');
dom.apiCopyBtn       = dom.editor.querySelector('[data-action="copy-curl"]');

// Render mode
dom.liveToggle       = dom.editor.querySelector('[data-action="toggle-live"]');
dom.renderBtn        = dom.editor.querySelector('[data-action="render"]');


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

// Presets — dirty state
let presetSnapshot = null;  // serialized query string when a preset was loaded (null = none)
let activePresetName = '';  // name of the currently loaded preset ('' = Default)
let defaultPresetQs = null; // snapshot of server defaults (captured after /config loads)

// Render mode
let renderModeSetting = 'auto';  // server setting: 'auto', 'live', 'manual'
let autoManualPixels  = 4_000_000;
let livePreview       = true;    // current client-side state
let renderStale       = false;   // true when settings changed but not rendered (manual mode)

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
    clearRenderStale();
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

/** Build extraction URLSearchParams from current controls. Optional extra params merged in. */
function buildExtractParams(extra) {
  const steps = fxRack ? fxRack.serializeSteps() : '';
  return new URLSearchParams({
    mode:   dom.param('mode').value,
    steps,
    format: dom.param('format').value,
    ...extra,
  });
}

/** Validate a server error code against the whitelist (A03). */
function safeErrorCode(raw) {
  return VALID_ERROR_CODES.has(raw) ? raw : 'UNKNOWN';
}

/** Sync blue_tolerance slot visibility based on the current mode. */
function syncBlueSlotVisibility() {
  if (!fxRack) return;
  const mode = dom.param('mode').value;
  const hide = mode !== 'auto' && mode !== 'blue';
  for (const slot of fxRack.getByEffect('blue_tolerance')) {
    slot.el.style.display = hide ? 'none' : '';
  }
}

/** Validate an integer param from an external source (A08). */
function isValidParam(name, value) {
  const r = PARAM_RANGES[name];
  return r && Number.isInteger(value) && value >= r.min && value <= r.max;
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
    autoSwitchRenderMode();
    syncCompareBeforeImg();
  };
  dom.editor.classList.add('visible');
  clearRenderStale();
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
  const params = buildExtractParams();

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
      dom.statusLabel.textContent = t('error.' + safeErrorCode((res.json && res.json.code) || ''));
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
    // A03/A08 — validate returned presets against whitelists and ranges
    if (!data || typeof data !== 'object') return;
    if (!VALID_MODES.has(data.mode)) return;
    if (!Array.isArray(data.steps)) return;
    for (const step of data.steps) {
      if (!step || !VALID_EFFECTS.has(step.effect)) return;
      if (!isValidParam(step.effect, step.value)) return;
    }

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

  dom.param('mode').value = p.mode;

  // Rebuild rack from detected steps
  loadStepsIntoRack(p.steps);
  syncBlueSlotVisibility();

  // Auto-detect always imposes dirty state
  markPresetDirty();

  // Re-extract with the new parameters (presets stay available until next upload)
  requestExtract();
}


/* ===================================================================
 *  6b. Presets — save / load / delete, localStorage + URL sync
 * =================================================================== */

const PRESETS_STORAGE_KEY = 'sig-presets';

/** Read all saved presets from localStorage. */
function loadPresetsMap() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return {};
    const map = JSON.parse(raw);
    return (map && typeof map === 'object') ? map : {};
  } catch {
    return {};
  }
}

/** Persist the full presets map to localStorage. */
function savePresetsMap(map) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(map));
}

/**
 * Serialize the current form state to a JSON string.
 * Includes mode, format, and the full steps pipeline.
 */
function serializePreset() {
  if (!fxRack) return '';
  return JSON.stringify({
    mode: dom.param('mode').value,
    format: dom.param('format').value,
    steps: fxRack.slots.map(s => ({
      effect: s.effect,
      value: s._slider ? Number(s._slider.value) : s._offValue,
      enabled: s.enabled,
    })),
  });
}

/**
 * Load steps into the rack — clear existing slots and rebuild from an array.
 * @param {Array<{effect: string, value: number, enabled?: boolean}>} steps
 */
function loadStepsIntoRack(steps) {
  if (!fxRack || !Array.isArray(steps)) return;
  fxRack.clear();
  for (const step of steps) {
    if (!VALID_EFFECTS.has(step.effect)) continue;
    const enabled = step.enabled !== undefined ? step.enabled : true;
    fxRack.addSlot(step.effect, step.value, enabled);
  }
}

/**
 * Apply a JSON preset string to the form controls.
 * Returns true if the preset was valid and applied.
 */
function loadPreset(raw) {
  if (!fxRack || !raw) return false;
  let preset;
  try { preset = JSON.parse(raw); } catch { return false; }
  if (!preset || typeof preset !== 'object') return false;

  // A03 — validate mode and format against whitelists
  if (preset.mode && VALID_MODES.has(preset.mode)) {
    dom.param('mode').value = preset.mode;
  }
  if (preset.format && VALID_FORMATS.has(preset.format)) {
    dom.param('format').value = preset.format;
  }

  // Rebuild rack from steps
  if (Array.isArray(preset.steps)) {
    loadStepsIntoRack(preset.steps);
  }

  syncBlueSlotVisibility();
  return true;
}

/** Populate the preset <select> from localStorage. */
function refreshPresetSelect() {
  const map = loadPresetsMap();
  // Remove all non-default options
  while (dom.presetSelect.options.length > 1) {
    dom.presetSelect.remove(1);
  }
  for (const name of Object.keys(map)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    dom.presetSelect.appendChild(opt);
  }
  dom.presetSelect.value = '';
}

/** Save the current state as a named preset. */
function savePreset(name) {
  if (!name) return;
  const qs = serializePreset();
  const map = loadPresetsMap();
  map[name] = qs;
  savePresetsMap(map);
  activePresetName = name;
  presetSnapshot = qs;
  refreshPresetSelect();
  syncPresetUI();
}

/** Delete a preset by name. */
function deletePreset(name) {
  if (!name) return;
  const map = loadPresetsMap();
  delete map[name];
  savePresetsMap(map);
  activePresetName = '';
  presetSnapshot = null;
  refreshPresetSelect();
  syncPresetUI();
}

/* ---- Preset dirty-state tracking ---- */

/**
 * Compare current form state against the snapshot taken when a preset was loaded.
 * Returns true if settings have changed (or no preset is loaded but settings were modified).
 */
function isPresetDirty() {
  if (!fxRack) return false;
  if (!presetSnapshot) return false; // no preset loaded, no snapshot → clean
  return serializePreset() !== presetSnapshot;
}

/**
 * Update the preset select label and button states based on dirty state.
 * Called after every parameter change and after preset load/save/delete.
 */
function syncPresetUI() {
  const dirty = isPresetDirty();
  const hasPreset = activePresetName !== '';
  const dirtyOpt = dom.presetSelect.querySelector('[data-dirty]');

  if (dirty) {
    // Show "Enregistrer..." in the select
    if (!dirtyOpt) {
      const opt = document.createElement('option');
      opt.dataset.dirty = '1';
      opt.value = '__dirty__';
      opt.textContent = t('preset.unsaved');
      dom.presetSelect.prepend(opt);
    }
    dom.presetSelect.value = '__dirty__';
  } else {
    // Remove dirty option if present
    if (dirtyOpt) dirtyOpt.remove();
    dom.presetSelect.value = activePresetName;
  }

  // Save button: active only when dirty
  dom.savePresetBtn.disabled = !dirty;

  // Delete button: active only when a preset is loaded AND state is clean
  dom.deletePresetBtn.disabled = !(hasPreset && !dirty);

  syncApiDoc();
}

/**
 * Mark the current preset as dirty (e.g. after Auto-detect applies values).
 */
function markPresetDirty() {
  if (!presetSnapshot) {
    // No preset was loaded — create a snapshot of the state *before* the change
    // so that isPresetDirty() returns true on next check.
    // We use a sentinel value that can never match serializePreset().
    presetSnapshot = '__force_dirty__';
  }
  syncPresetUI();
}


/* ---- API doc — live request preview ---- */

/** Refresh the API doc block with current parameter values. */
function syncApiDoc() {
  if (!fxRack || dom.apiDoc.classList.contains('collapsed')) return;
  const params = buildExtractParams();
  dom.apiEndpoint.textContent = '/extract?' + params.toString();

  // Params table — show mode, then each step, then format
  const rows = [];
  rows.push(`<tr><td>mode</td><td>${dom.param('mode').value}</td><td>string</td><td>—</td></tr>`);
  for (const step of fxRack.getSteps()) {
    const range = PARAM_RANGES[step.effect];
    rows.push(`<tr><td>${step.effect}</td><td>${step.value}</td><td>int</td><td>${range ? range.min + '–' + range.max : '—'}</td></tr>`);
  }
  rows.push(`<tr><td>format</td><td>${dom.param('format').value}</td><td>string</td><td>—</td></tr>`);
  dom.apiParamsBody.innerHTML = rows.join('');

  // Response mime
  const fmt = dom.param('format').value;
  dom.apiResponseMime.textContent = 'image/' + (fmt === 'webp' ? 'webp' : 'png');
}


/* ---- Render mode — live / manual / auto ---- */

/**
 * Set live preview on or off. Updates UI toggle, render button, and stale state.
 */
function setLivePreview(on) {
  livePreview = on;
  dom.liveToggle.checked = on;
  dom.renderBtn.hidden = on;
  if (on) {
    // Switching to live — immediately render if stale
    if (renderStale) {
      renderStale = false;
      dom.editor.classList.remove('stale');
      dom.renderBtn.classList.remove('stale');
      extractSignature();
    }
  }
}

/**
 * Mark the preview as stale (manual mode only).
 * Called instead of extractSignature() when live preview is off.
 */
function markRenderStale() {
  if (livePreview) return;
  renderStale = true;
  dom.editor.classList.add('stale');
  dom.renderBtn.classList.add('stale');
}

/** Clear the stale indicator after a successful render. */
function clearRenderStale() {
  renderStale = false;
  dom.editor.classList.remove('stale');
  dom.renderBtn.classList.remove('stale');
}

/**
 * Auto-switch to manual mode if the image exceeds the pixel threshold.
 * Called after loading a new image (when renderModeSetting === 'auto').
 */
function autoSwitchRenderMode() {
  if (renderModeSetting !== 'auto') return;
  const pixels = naturalW * naturalH;
  if (pixels > autoManualPixels && livePreview) {
    setLivePreview(false);
  } else if (pixels <= autoManualPixels && !livePreview) {
    setLivePreview(true);
  }
}

/**
 * Debounced extract wrapper — respects render mode.
 * In live mode: extracts immediately (debounced). In manual mode: marks stale.
 */
function requestExtract() {
  if (livePreview) {
    debouncedExtract();
  } else {
    markRenderStale();
  }
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

  initBgPicker(dom.zoomOverlay, dom.zoomViewport, 'extracted', BG_STYLES, VALID_BG_KEYS);
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
    const params = buildExtractParams({ output: 'base64' });

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
        dom.statusLabel.textContent = t('error.' + safeErrorCode((res.json && res.json.code) || ''));
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
  syncBlueSlotVisibility();
  syncPresetUI();
  requestExtract();
};
dom.param('format').onchange = () => {
  syncPresetUI();
  requestExtract();
};

// Auto-detect button
dom.autoDetectBtn.onclick = applyPresets;

// Effects rack — dynamic slots, add/remove, drag & drop
fxRack = new FxRack(document.querySelector('.rack'), {
  onChange: () => { syncPresetUI(); requestExtract(); },
});

// Presets — wire after fxRack is ready
refreshPresetSelect();
syncPresetUI();

dom.presetSelect.onchange = () => {
  const name = dom.presetSelect.value;
  if (name === '__dirty__') return; // ignore selecting the dirty placeholder
  if (!name) {
    // "Default" selected — reload default preset
    if (defaultPresetQs) loadPreset(defaultPresetQs);
    activePresetName = '';
    presetSnapshot = defaultPresetQs;
    syncPresetUI();
    requestExtract();
    return;
  }
  const map = loadPresetsMap();
  if (map[name]) {
    loadPreset(map[name]);
    activePresetName = name;
    presetSnapshot = serializePreset(); // snapshot after applying (accounts for clamping)
    syncPresetUI();
    requestExtract();
  }
};

dom.savePresetBtn.onclick = () => {
  dom.presetNameInput.value = activePresetName;
  openDialog(dom.savePresetOverlay);
  dom.presetNameInput.focus();
};

dom.confirmSaveBtn.onclick = () => {
  const name = dom.presetNameInput.value.trim();
  if (!name) return;
  savePreset(name);
  closeDialog(dom.savePresetOverlay);
};

// Enter key confirms save
dom.presetNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dom.confirmSaveBtn.click();
  }
});

dom.savePresetOverlay.querySelector('[data-action="cancel"]').onclick = () => {
  closeDialog(dom.savePresetOverlay);
};
registerDialog(dom.savePresetOverlay);

dom.deletePresetBtn.onclick = () => {
  if (!activePresetName) return;
  dom.deletePresetMsg.textContent = t('preset.confirm_delete', { name: activePresetName });
  openDialog(dom.deletePresetOverlay);
};

dom.confirmDeleteBtn.onclick = () => {
  closeDialog(dom.deletePresetOverlay);
  deletePreset(activePresetName);
};

dom.deletePresetOverlay.querySelector('[data-action="cancel"]').onclick = () => {
  closeDialog(dom.deletePresetOverlay);
};
registerDialog(dom.deletePresetOverlay);

// API doc — toggle, expand, copy
dom.apiToggleBtn.onclick = () => {
  if (toggleCollapse(dom.apiDoc, dom.apiToggleBtn, 'active')) syncApiDoc();
};

dom.apiExpandBtn.onclick = () => {
  toggleCollapse(dom.apiDetails, dom.apiExpandBtn, 'expanded');
};

dom.apiCopyBtn.onclick = () => {
  const params = buildExtractParams();
  const curl = `curl -X POST "${location.origin}/extract?${params}" -F "file=@image.png"`;
  navigator.clipboard.writeText(curl);
};

// Render mode — toggle, button, Ctrl+Enter
dom.liveToggle.onchange = () => setLivePreview(dom.liveToggle.checked);

dom.renderBtn.onclick = () => {
  clearRenderStale();
  extractSignature();
};

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter' && !livePreview && currentFile) {
    e.preventDefault();
    dom.renderBtn.click();
  }
});

// Extracted panel: bg picker & download
initBgPicker(dom.extractedPanel, dom.extractedBg, 'extracted', BG_STYLES, VALID_BG_KEYS);
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
    }
    if (VALID_FORMATS.has(cfg.format)) {
      dom.param('format').value = cfg.format;
    }

    // Build initial rack from server default steps
    if (Array.isArray(cfg.steps)) {
      const validSteps = cfg.steps.filter(s => s && VALID_EFFECTS.has(s.effect) && isValidParam(s.effect, s.value));
      loadStepsIntoRack(validSteps);
    }
    syncBlueSlotVisibility();

    // Render mode from server config
    const VALID_RENDER = new Set(['live', 'manual', 'auto']);
    if (VALID_RENDER.has(cfg.render_mode)) {
      renderModeSetting = cfg.render_mode;
      if (renderModeSetting === 'manual') setLivePreview(false);
      else if (renderModeSetting === 'live') setLivePreview(true);
      // 'auto' stays as default (live) until image loaded
    }
    if (typeof cfg.auto_manual_pixels === 'number' && cfg.auto_manual_pixels > 0) {
      autoManualPixels = cfg.auto_manual_pixels;
    }

    // Capture server defaults as the "Default" preset
    defaultPresetQs = serializePreset();
    presetSnapshot = defaultPresetQs;
    syncPresetUI();

    // URL sync removed — presets now use JSON format, not query strings
  })
  .catch(() => {});
