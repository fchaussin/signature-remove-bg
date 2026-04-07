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
 *   7. Editor controls      — slider bindings, debounced re-extract
 *   8. initZoom()           — zoom popup logic
 *   9. initCrop()           — crop overlay logic
 *  10. initBase64()         — base64 export popup
 *  11. initContrast()       — contrast / darken overlay logic
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
const MAX_CLIENT_BYTES = 50 * 1024 * 1024; // 50 MB — must match server MAX_UPLOAD_MB


/* ===================================================================
 *  2. Helpers
 * =================================================================== */

/** Attach a bg-picker inside `container`, applying styles to `target`. */
function initBgPicker(container, target) {
  const picker = container.querySelector('.bg-picker') || container.querySelector('.zoom-bg-picker');
  if (!picker) return;
  picker.addEventListener('click', e => {
    const swatch = e.target.closest('.bg-swatch');
    if (!swatch) return;
    const bg = swatch.dataset.bg;
    if (!VALID_BG_KEYS.has(bg)) return; // reject unknown keys (OWASP A03)
    e.stopPropagation();
    picker.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    target.style.background = BG_STYLES[bg];
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
 *  3. Overlay manager — open / close any overlay + Escape handling
 * =================================================================== */

const overlays = [];

function registerOverlay(el, onClose) {
  overlays.push({ el, close: onClose || (() => el.classList.remove('visible')) });
}

function openOverlay(el) {
  el.classList.add('visible');
}

function closeOverlay(el) {
  el.classList.remove('visible');
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (overlays[i].el.classList.contains('visible')) {
      overlays[i].close();
      return;
    }
  }
});


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
  contrastOverlay: document.getElementById('contrast'),

  // Dynamic lookups — whitelisted to prevent selector injection (OWASP A03)
  _VALID_PARAMS: new Set(['mode', 'threshold', 'blue_tolerance', 'smoothing', 'format']),
  _VALID_DISPLAYS: new Set(['threshold', 'blue_tolerance', 'smoothing', 'intensity']),
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

  // Contrast children
  contrastCanvas:  null,
  contrastPreview: null,
  contrastSlider:  null,
  contrastLabel:   null,
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
dom.extractedImg = dom.extractedPanel.querySelector('.preview-img');
dom.extractedBg  = dom.extractedPanel.querySelector('.preview-bg');
dom.statusLabel  = dom.extractedPanel.querySelector('.status');

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

// Contrast children
dom.contrastCanvas  = dom.contrastOverlay.querySelector('canvas');
dom.contrastPreview = dom.contrastOverlay.querySelector('.tool-preview');
dom.contrastSlider  = dom.contrastOverlay.querySelector('[data-param="intensity"]');
dom.contrastLabel   = dom.contrastOverlay.querySelector('[data-display="intensity"]');


/* ===================================================================
 *  5. Mutable state — grouped by feature
 * =================================================================== */

// Core
let currentFile       = null;
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

// Contrast
let contrastImg      = new Image();
let contrastOrigData = null;
let contrastScale    = 1;


/* ===================================================================
 *  6. Core functions
 * =================================================================== */

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
  };
  dom.editor.classList.add('visible');
  extractSignature();
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
  dom.statusLabel.textContent = t('status.processing');

  const fd = new FormData();
  fd.append('file', currentFile);
  const params = new URLSearchParams({
    mode:           dom.param('mode').value,
    threshold:      dom.param('threshold').value,
    blue_tolerance: dom.param('blue_tolerance').value,
    smoothing:      dom.param('smoothing').value,
    format:         dom.param('format').value
  });

  try {
    const res = await fetch(`/extract?${params}`, { method: 'POST', body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const code = data.code || 'UNKNOWN';
      dom.statusLabel.textContent = t('error.' + code);
      return;
    }
    lastExtractedBlob = await res.blob();
    dom.extractedImg.src = safeObjectURL('extracted', lastExtractedBlob);
    dom.statusLabel.textContent = '';
  } catch {
    dom.statusLabel.textContent = t('error.NETWORK');
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


/* ===================================================================
 *  7. Editor controls (debounced re-extract)
 * =================================================================== */

const debouncedExtract = debounce(extractSignature, 300);

function bindSlider(paramName) {
  const slider = dom.param(paramName);
  const label  = dom.display(paramName);
  slider.oninput = () => {
    label.textContent = slider.value;
    debouncedExtract();
  };
}


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

      openOverlay(dom.zoomOverlay);
      zoomIsFit = isFit;
      zoomImgW  = img.naturalWidth;
      zoomImgH  = img.naturalHeight;
    };
    img.src = src;
  }

  // Pan on mousemove
  dom.zoomViewport.addEventListener('mousemove', e => {
    if (!dom.zoomOverlay.classList.contains('visible') || zoomIsFit) return;
    const rect = dom.zoomViewport.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / ZOOM_SIZE;
    const ry = (e.clientY - rect.top) / ZOOM_SIZE;
    dom.zoomImg.style.left = (-rx * Math.max(0, zoomImgW - ZOOM_SIZE)) + 'px';
    dom.zoomImg.style.top  = (-ry * Math.max(0, zoomImgH - ZOOM_SIZE)) + 'px';
  });

  // Close buttons
  dom.zoomCloseBtn.onclick = e => {
    e.stopPropagation();
    closeOverlay(dom.zoomOverlay);
  };
  dom.zoomOverlay.onclick = e => {
    if (e.target === dom.zoomOverlay) closeOverlay(dom.zoomOverlay);
  };

  // Click preview images to open zoom
  dom.originalImg.onclick  = () => { if (dom.originalImg.src) openZoom(dom.originalImg.src); };
  dom.extractedImg.onclick = () => { if (dom.extractedImg.src) openZoom(dom.extractedImg.src); };

  initBgPicker(dom.zoomOverlay, dom.zoomViewport);
  registerOverlay(dom.zoomOverlay);
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
      openOverlay(dom.cropOverlay);
    };
    cropImg.src = safeObjectURL('cropSrc', currentFile);
  };

  // Cancel
  dom.cropOverlay.querySelector('[data-action="cancel"]').onclick = () => closeOverlay(dom.cropOverlay);

  // Apply
  dom.cropOverlay.querySelector('[data-action="apply"]').onclick = () => {
    const sx = Math.round(cropEdges.left / cropScale);
    const sy = Math.round(cropEdges.top / cropScale);
    const sw = Math.round((cropCanvasW - cropEdges.left - cropEdges.right) / cropScale);
    const sh = Math.round((cropCanvasH - cropEdges.top - cropEdges.bottom) / cropScale);

    if (sw < 5 || sh < 5) {
      closeOverlay(dom.cropOverlay);
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
      };
      closeOverlay(dom.cropOverlay);
      extractSignature();
    }, 'image/png');
  };

  registerOverlay(dom.cropOverlay);
}


/* ===================================================================
 *  10. initBase64() — base64 export popup
 * =================================================================== */

function initBase64() {

  async function openBase64() {
    if (!currentFile) return;
    dom.statusLabel.textContent = t('status.processing');

    const fd = new FormData();
    fd.append('file', currentFile);
    const params = new URLSearchParams({
      mode:           dom.param('mode').value,
      threshold:      dom.param('threshold').value,
      blue_tolerance: dom.param('blue_tolerance').value,
      smoothing:      dom.param('smoothing').value,
      format:         dom.param('format').value,
      output:         'base64'
    });

    try {
      const res = await fetch(`/extract?${params}`, { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        dom.statusLabel.textContent = t('error.' + (data.code || 'UNKNOWN'));
        return;
      }
      const data = await res.json();
      // A08 — validate response shape before use
      if (!data || typeof data.base64 !== 'string' || !data.base64.startsWith('data:image/')) {
        dom.statusLabel.textContent = t('error.UNKNOWN');
        return;
      }
      dom.base64Textarea.value = data.base64;
      dom.statusLabel.textContent = '';
      openOverlay(dom.base64Overlay);
    } catch {
      dom.statusLabel.textContent = t('error.NETWORK');
    }
  }

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
    closeOverlay(dom.base64Overlay);
    dom.base64Textarea.value = '';
  }

  dom.base64Overlay.querySelector('[data-action="cancel"]').onclick = closeBase64;

  registerOverlay(dom.base64Overlay, closeBase64);
}


/* ===================================================================
 *  11. initContrast() — contrast / darken overlay logic
 * =================================================================== */

function initContrast() {
  const contrastCtx = dom.contrastCanvas.getContext('2d');

  function applyContrastPixels(src, dst, intensity) {
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) {
        dst[i]     = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = 0;
      } else {
        dst[i]     = Math.round(src[i]     * (1 - intensity));
        dst[i + 1] = Math.round(src[i + 1] * (1 - intensity));
        dst[i + 2] = Math.round(src[i + 2] * (1 - intensity));
        dst[i + 3] = Math.round(a + (255 - a) * intensity);
      }
    }
  }

  function renderContrastPreview() {
    const intensity = dom.contrastSlider.value / 100;
    const out = contrastCtx.createImageData(dom.contrastCanvas.width, dom.contrastCanvas.height);
    applyContrastPixels(contrastOrigData.data, out.data, intensity);
    contrastCtx.putImageData(out, 0, 0);
  }

  const debouncedContrast = debounce(renderContrastPreview, 30);

  dom.contrastSlider.oninput = () => {
    dom.contrastLabel.textContent = dom.contrastSlider.value;
    debouncedContrast();
  };

  // Open contrast overlay
  dom.extractedPanel.querySelector('[data-action="contrast"]').onclick = () => {
    if (!lastExtractedBlob) return;
    contrastImg.onload = () => {
      contrastScale = fitScale(contrastImg.width, contrastImg.height, window.innerWidth * 0.85, window.innerHeight * 0.55);
      dom.contrastCanvas.width  = Math.round(contrastImg.width * contrastScale);
      dom.contrastCanvas.height = Math.round(contrastImg.height * contrastScale);

      contrastCtx.drawImage(contrastImg, 0, 0, dom.contrastCanvas.width, dom.contrastCanvas.height);
      contrastOrigData = contrastCtx.getImageData(0, 0, dom.contrastCanvas.width, dom.contrastCanvas.height);

      dom.contrastSlider.value = 15;
      dom.contrastLabel.textContent = '15';
      renderContrastPreview();
      openOverlay(dom.contrastOverlay);
    };
    contrastImg.src = safeObjectURL('contrastSrc', lastExtractedBlob);
  };

  // Cancel
  dom.contrastOverlay.querySelector('[data-action="cancel"]').onclick = () => closeOverlay(dom.contrastOverlay);

  // Apply
  dom.contrastOverlay.querySelector('[data-action="apply"]').onclick = () => {
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width  = contrastImg.naturalWidth;
    fullCanvas.height = contrastImg.naturalHeight;
    const fullCtx = fullCanvas.getContext('2d');
    fullCtx.drawImage(contrastImg, 0, 0);

    const fullData = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
    applyContrastPixels(fullData.data, fullData.data, dom.contrastSlider.value / 100);
    fullCtx.putImageData(fullData, 0, 0);

    fullCanvas.toBlob(blob => {
      updateExtracted(blob);
      closeOverlay(dom.contrastOverlay);
    }, getMimeType());
  };

  initBgPicker(dom.contrastOverlay, dom.contrastPreview);
  registerOverlay(dom.contrastOverlay);
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

// Editor sliders & selects
bindSlider('threshold');
bindSlider('blue_tolerance');
bindSlider('smoothing');
dom.param('mode').onchange   = debouncedExtract;
dom.param('format').onchange = debouncedExtract;

// Extracted panel: bg picker & download
initBgPicker(dom.extractedPanel, dom.extractedBg);
dom.extractedPanel.querySelector('[data-action="download"]').onclick = downloadExtracted;

// Feature overlays
initZoom();
initCrop();
initBase64();
initContrast();

// i18n — detect browser language and apply translations
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
    if (Number.isInteger(cfg.threshold) && cfg.threshold >= 50 && cfg.threshold <= 250) {
      dom.param('threshold').value = cfg.threshold;
      dom.display('threshold').textContent = cfg.threshold;
    }
    if (Number.isInteger(cfg.blue_tolerance) && cfg.blue_tolerance >= 20 && cfg.blue_tolerance <= 200) {
      dom.param('blue_tolerance').value = cfg.blue_tolerance;
      dom.display('blue_tolerance').textContent = cfg.blue_tolerance;
    }
    if (Number.isInteger(cfg.smoothing) && cfg.smoothing >= 0 && cfg.smoothing <= 100) {
      dom.param('smoothing').value = cfg.smoothing;
      dom.display('smoothing').textContent = cfg.smoothing;
    }
  })
  .catch(() => {});
