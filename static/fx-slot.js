'use strict';

/**
 * FxSlot — Single effect slot in the rack.
 *
 * Responsibilities (SRP):
 *  - Own its DOM element, toggle, slider, display label
 *  - Expose its current value (respecting toggle state)
 *  - Notify the rack on value change via a callback
 *
 * The slot reads its configuration from the DOM:
 *  - data-effect      → effect name (e.g. "threshold")
 *  - [data-param]     → range input
 *  - [data-display]   → value display label
 *  - .rack-toggle     → on/off checkbox
 *
 * Subclass to add custom controls beyond a single slider.
 */
class FxSlot {

  /**
   * @param {HTMLElement} el        — the .rack-slot element
   * @param {object}      opts
   * @param {number}      opts.offValue  — value sent when toggled off
   * @param {function}    opts.onChange   — called on any value/toggle change
   */
  constructor(el, { offValue = 0, onChange = () => {} } = {}) {
    this.el       = el;
    this.name     = el.dataset.effect;
    this._offValue = offValue;
    this._onChange = onChange;

    // DOM children
    this._checkbox = el.querySelector('.rack-toggle input');
    this._slider   = el.querySelector('[data-param]');
    this._display  = el.querySelector('[data-display]');

    // Initial state
    this._enabled = this._checkbox ? this._checkbox.checked : true;
    this._applyDisabledState();

    // Bind events
    this._bindToggle();
    this._bindSlider();
  }

  /* -- Public API -------------------------------------------------------- */

  /** Current effective value (offValue when disabled). */
  get value() {
    if (!this._enabled) return this._offValue;
    return this._slider ? this._slider.value : this._offValue;
  }

  /** Whether the effect is enabled. */
  get enabled() {
    return this._enabled;
  }

  /** Programmatically set the slider value + display (e.g. from /config). */
  setValue(v) {
    if (this._slider) this._slider.value = v;
    if (this._display) this._display.textContent = v;
  }

  /* -- Protected (override in subclasses) -------------------------------- */

  /** Called when the slider moves. Override for custom behaviour. */
  _onSliderInput() {
    if (this._display) this._display.textContent = this._slider.value;
    this._onChange(this);
  }

  /** Called when the toggle changes. Override for custom behaviour. */
  _onToggleChange() {
    this._enabled = this._checkbox.checked;
    this._applyDisabledState();
    this._onChange(this);
  }

  /* -- Private ----------------------------------------------------------- */

  _bindToggle() {
    if (!this._checkbox) return;
    this._checkbox.addEventListener('change', () => this._onToggleChange());
  }

  _bindSlider() {
    if (!this._slider) return;
    this._slider.addEventListener('input', () => this._onSliderInput());
  }

  _applyDisabledState() {
    this.el.classList.toggle('disabled', !this._enabled);
  }
}

// Export for consumption by fx-rack.js and app.js
window.FxSlot = FxSlot;
