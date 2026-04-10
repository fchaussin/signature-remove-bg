'use strict';

/**
 * FxSlot — Single effect slot in the rack.
 *
 * Responsibilities (SRP):
 *  - Build its own DOM from effect metadata
 *  - Own toggle, slider, display label, remove button
 *  - Expose its current value (respecting toggle state)
 *  - Notify the rack on value change or remove request via callbacks
 */
class FxSlot {

  /**
   * @param {string}   effect    — effect name (e.g. "threshold")
   * @param {string}   id        — unique instance ID (e.g. "threshold_0")
   * @param {object}   meta      — { icon, label, min, max, off, defaultOn }
   * @param {object}   opts
   * @param {function} opts.onChange  — called on any value/toggle change
   * @param {function} opts.onRemove — called when user clicks remove
   */
  constructor(effect, id, meta, { onChange = () => {}, onRemove = () => {} } = {}) {
    this.effect    = effect;
    this.id        = id;
    this._meta     = meta;
    this._offValue = meta.off;
    this._onChange  = onChange;
    this._onRemove = onRemove;

    this.el = this._buildDOM(meta);

    // DOM children
    this._checkbox = this.el.querySelector('.rack-toggle input');
    this._slider   = this.el.querySelector('[data-param]');
    this._display  = this.el.querySelector('[data-display]');
    this._label    = this.el.querySelector('.rack-label');
    this._removeBtn = this.el.querySelector('[data-action="remove-slot"]');

    // Initial state
    this._enabled = this._checkbox ? this._checkbox.checked : true;
    this._applyDisabledState();

    // Bind events
    if (this._checkbox) this._checkbox.addEventListener('change', () => this._onToggleChange());
    if (this._slider) this._slider.addEventListener('input', () => this._onSliderInput());
    if (this._display) this._display.addEventListener('input', () => this._onNumberInput());
    if (this._removeBtn) this._removeBtn.addEventListener('click', () => this._onRemove(this));
  }

  /* -- Public API -------------------------------------------------------- */

  /** Effect name (e.g. "threshold") — may appear on multiple slots. */
  get name() { return this.effect; }

  /** Current effective value (offValue when disabled). */
  get value() {
    if (!this._enabled) return this._offValue;
    return this._slider ? Number(this._slider.value) : this._offValue;
  }

  /** Whether the effect is enabled. */
  get enabled() { return this._enabled; }

  /** Programmatically set the slider value + display. */
  setValue(v) {
    if (this._slider) this._slider.value = v;
    if (this._display) this._display.value = v;
  }

  /** Programmatically set the enabled/disabled toggle state. */
  setEnabled(on) {
    if (this._checkbox) {
      this._checkbox.checked = on;
      this._enabled = on;
      this._applyDisabledState();
    }
  }

  /** Update the visible label (e.g. add "#2" for duplicates). */
  setLabel(text) {
    if (this._label) this._label.textContent = text;
  }

  /** Enable or disable the remove button. */
  setRemovable(can) {
    if (this._removeBtn) this._removeBtn.disabled = !can;
  }

  /* -- Private ----------------------------------------------------------- */

  _buildDOM(meta) {
    const el = document.createElement('div');
    el.className = 'rack-slot';
    el.dataset.effect = this.effect;
    el.dataset.slotId = this.id;
    el.setAttribute('role', 'listitem');
    el.innerHTML = `
      <span class="rack-handle" aria-label="Drag to reorder" data-icon="grip" data-icon-size="14"></span>
      <span class="rack-icon" data-icon="${meta.icon}" data-icon-size="16"></span>
      <label class="rack-toggle"><input type="checkbox"${meta.defaultOn ? ' checked' : ''} aria-label="Enable ${meta.label}"><span class="rack-toggle-mark"></span></label>
      <div class="rack-body">
        <label><span class="rack-label"></span> <input class="rack-number" type="number" data-display="${this.effect}" min="${meta.min}" max="${meta.max}" value="${meta.off}"></label>
        <input type="range" data-param="${this.effect}" min="${meta.min}" max="${meta.max}" value="${meta.off}">
      </div>
      <button class="btn-remove-slot" data-action="remove-slot" aria-label="Remove" data-icon="close" data-icon-size="12"></button>
    `;
    // Set text content safely (no HTML injection)
    el.querySelector('.rack-label').textContent = meta.label;
    return el;
  }

  _onSliderInput() {
    if (this._display) this._display.value = this._slider.value;
    this._onChange(this);
  }

  _onNumberInput() {
    const min = this._meta.min;
    const max = this._meta.max;
    let v = parseInt(this._display.value, 10);
    if (isNaN(v)) return;
    v = Math.max(min, Math.min(max, v));
    if (this._slider) this._slider.value = v;
    this._onChange(this);
  }

  _onToggleChange() {
    this._enabled = this._checkbox.checked;
    this._applyDisabledState();
    this._onChange(this);
  }

  _applyDisabledState() {
    this.el.classList.toggle('disabled', !this._enabled);
  }
}

// Export for consumption by fx-rack.js and app.js
window.FxSlot = FxSlot;
