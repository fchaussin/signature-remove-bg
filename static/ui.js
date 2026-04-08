'use strict';

/**
 * ui.js — Reusable UI components (no business logic, no state).
 *
 * Table of contents:
 *  1. toggleCollapse    — animated collapse/expand via .collapsed class
 *  2. Dialog helpers    — registerDialog, openDialog, closeDialog
 *  3. initBgPicker      — background color picker with sync groups
 *  4. initCompareSlider — before/after comparison slider
 */


/* ===================================================================
 *  1. Collapse / Expand
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
 *  2. Dialog helpers — native <dialog> with showModal / close
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
 *  3. Background picker
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


/* ===================================================================
 *  4. Compare slider — before/after image overlay
 * =================================================================== */

/**
 * Initialize a before/after comparison slider.
 * @param {object} els — { slider, before, beforeImg, handle, toggle }
 */
function initCompareSlider(els) {
  let dragging = false;

  function isActive() {
    return !els.slider.classList.contains('off');
  }

  function setPosition(pct) {
    pct = Math.max(0, Math.min(100, pct));
    els.before.style.width = pct + '%';
    els.handle.style.left  = pct + '%';
    // The before image must span the full slider width so it aligns with the after image
    if (pct > 0) {
      els.beforeImg.style.width = els.slider.offsetWidth + 'px';
    }
  }

  function posFromEvent(e) {
    const rect = els.slider.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return ((clientX - rect.left) / rect.width) * 100;
  }

  // Toggle on/off
  els.toggle.onchange = () => {
    els.slider.classList.toggle('off', !els.toggle.checked);
  };

  els.slider.addEventListener('pointerdown', e => {
    if (!isActive()) return;
    dragging = true;
    els.slider.setPointerCapture(e.pointerId);
    setPosition(posFromEvent(e));
  });

  els.slider.addEventListener('pointermove', e => {
    if (!dragging) return;
    setPosition(posFromEvent(e));
  });

  els.slider.addEventListener('pointerup', () => { dragging = false; });
  els.slider.addEventListener('pointercancel', () => { dragging = false; });

  // Keyboard support on the handle
  els.handle.addEventListener('keydown', e => {
    const step = 2;
    if (e.key === 'ArrowLeft')  setPosition(parseFloat(els.handle.style.left) - step);
    else if (e.key === 'ArrowRight') setPosition(parseFloat(els.handle.style.left) + step);
  });

  // Initialize fully showing the extracted image
  setPosition(0);
}
