'use strict';

/**
 * ui.js — Reusable UI helpers (no business logic).
 *
 * Table of contents:
 *  1. debounce        — cancel-aware debounce
 *  2. toggleCollapse  — animated collapse/expand via .collapsed class
 *  3. Dialog helpers  — registerDialog, openDialog, closeDialog
 *  4. safeObjectURL   — blob URL with auto-revoke
 *  5. fitScale        — scale factor to fit dimensions
 *  6. drawCheckerboard — canvas checker pattern
 *  7. initBgPicker    — background color picker with sync groups
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
 *  2. Collapse / Expand
 * =================================================================== */

/**
 * Toggle a `.collapsed` class on `target`. Optionally toggle an active class on a trigger button.
 * Returns true if the element is now expanded (was collapsed).
 */
function toggleCollapse(target, triggerEl, activeClass) {
  const wasCollapsed = target.classList.contains('collapsed');
  target.classList.toggle('collapsed');
  if (triggerEl && activeClass) triggerEl.classList.toggle(activeClass, wasCollapsed);
  return wasCollapsed;
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
    e.preventDefault();
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
 *  4. Object URL management
 * =================================================================== */

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
 *  5. Scaling
 * =================================================================== */

/** Compute a scale factor to fit `imgW x imgH` within `maxW x maxH` (never upscale). */
function fitScale(imgW, imgH, maxW, maxH) {
  return Math.min(1, maxW / imgW, maxH / imgH);
}


/* ===================================================================
 *  6. Canvas
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
 *  7. Background picker
 * =================================================================== */

/**
 * Attach a bg-picker inside `container`, applying styles to `target`.
 * Pickers registered in the same sync group stay in sync.
 *
 * @param {HTMLElement} container — element containing .bg-picker or .zoom-bg-picker
 * @param {HTMLElement} target    — element to apply background style to
 * @param {string}      syncGroup — group name for synced pickers
 * @param {object}      styles    — { key: cssValue } map of background styles
 * @param {Set}         validKeys — whitelist of allowed keys (OWASP A03)
 */
const _bgPickerGroups = {};

function initBgPicker(container, target, syncGroup, styles, validKeys) {
  const picker = container.querySelector('.bg-picker') || container.querySelector('.zoom-bg-picker');
  if (!picker) return;

  if (syncGroup) {
    if (!_bgPickerGroups[syncGroup]) _bgPickerGroups[syncGroup] = [];
    _bgPickerGroups[syncGroup].push({ picker, target });
  }

  picker.addEventListener('click', e => {
    const swatch = e.target.closest('.bg-swatch');
    if (!swatch) return;
    const bg = swatch.dataset.bg;
    if (!validKeys.has(bg)) return;
    e.stopPropagation();

    const peers = syncGroup ? _bgPickerGroups[syncGroup] : [{ picker, target }];
    for (const peer of peers) {
      peer.picker.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
      peer.picker.querySelector(`[data-bg="${bg}"]`).classList.add('active');
      peer.target.style.background = styles[bg];
    }
  });
}
