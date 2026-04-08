'use strict';

/**
 * FxRack — Manages a dynamic, ordered collection of FxSlot instances.
 *
 * Responsibilities:
 *  - Create / remove slots dynamically (add/remove buttons)
 *  - Enforce min / max slot count
 *  - Handle drag & drop reordering
 *  - Expose aggregated step values for the extraction API
 *  - Notify the host app on any change via a single callback
 *  - Update duplicate labels (e.g. "Threshold #2" when same effect appears twice)
 */
class FxRack {

  /**
   * Effect metadata — icon, i18n label key, slider range, default value, default on/off.
   * This is the single source of truth for slot appearance.
   */
  static EFFECTS = {
    threshold:      { icon: 'sun',         labelKey: 'threshold.name',      min: 50,  max: 250, off: 220, defaultOn: true },
    blue_tolerance: { icon: 'droplet',     labelKey: 'blue_tolerance.name', min: 20,  max: 200, off: 80,  defaultOn: true },
    contrast:       { icon: 'circle-half', labelKey: 'contrast.name',       min: 0,   max: 100, off: 0,   defaultOn: false },
    smoothing:      { icon: 'waves',       labelKey: 'smoothing.name',      min: 0,   max: 100, off: 30,  defaultOn: true },
  };

  static MIN_SLOTS = 1;
  static MAX_SLOTS = 7;

  /**
   * @param {HTMLElement} el        — the .rack container (includes .rack-header)
   * @param {object}      opts
   * @param {function}    opts.onChange — called on any slot value/toggle/order/add/remove change
   */
  constructor(el, { onChange = () => {} } = {}) {
    this.el        = el;
    this._onChange  = onChange;
    this._idCounter = 0;

    /** @type {FxSlot[]} ordered list of slots */
    this.slots = [];

    // Header controls (inside .rack)
    this._headerEl     = el.querySelector('.rack-header');
    this._effectSelect = this._headerEl.querySelector('.rack-effect-select');
    this._addBtn       = this._headerEl.querySelector('[data-action="add-slot"]');

    this._collapseBtn = this._headerEl.querySelector('[data-action="toggle-rack"]');
    this._countEl     = this._headerEl.querySelector('.rack-count');

    this._addBtn.addEventListener('click', () => {
      const effect = this._effectSelect.value;
      if (effect) this.addSlot(effect);
    });

    this._collapseBtn.addEventListener('click', () => {
      this.el.classList.toggle('collapsed');
    });

    this._initDragAndDrop();
  }

  /* -- Public API -------------------------------------------------------- */

  /**
   * Add a new slot for the given effect.
   * @param {string} effect — effect name
   * @param {number} [value] — initial value (defaults to effect's off value)
   * @param {boolean} [enabled] — initial toggle state (defaults to effect's defaultOn)
   * @returns {FxSlot|null} the created slot, or null if max reached
   */
  addSlot(effect, value, enabled) {
    if (this.slots.length >= FxRack.MAX_SLOTS) return null;
    const meta = FxRack.EFFECTS[effect];
    if (!meta) return null;

    const id = `${effect}_${this._idCounter++}`;
    const label = typeof i18n !== 'undefined' ? i18n.t(meta.labelKey) : meta.labelKey;
    const slotMeta = { ...meta, label };

    const slot = new FxSlot(effect, id, slotMeta, {
      onChange: () => { this._syncCount(); this._onChange(); },
      onRemove: (s) => this.removeSlot(s.id),
    });

    if (value !== undefined) slot.setValue(value);
    if (enabled !== undefined) slot.setEnabled(enabled);

    this.slots.push(slot);
    this.el.appendChild(slot.el);

    // Inject SVG icons into the new slot
    if (typeof Icon !== 'undefined') Icon.inject(slot.el);

    this._syncLabels();
    this._syncButtons();
    this._onChange();
    return slot;
  }

  /**
   * Remove a slot by instance ID.
   * @param {string} id
   */
  removeSlot(id) {
    if (this.slots.length <= FxRack.MIN_SLOTS) return;
    const idx = this.slots.findIndex(s => s.id === id);
    if (idx === -1) return;
    const slot = this.slots[idx];
    slot.el.remove();
    this.slots.splice(idx, 1);
    this._syncLabels();
    this._syncButtons();
    this._onChange();
  }

  /** Remove all slots (used before loading a new configuration). */
  clear() {
    for (const slot of this.slots) slot.el.remove();
    this.slots = [];
    this._syncButtons();
  }

  /**
   * Return the current pipeline as an array of {effect, value} objects.
   * Respects toggle state (disabled → offValue).
   */
  getSteps() {
    return this.slots.map(s => ({ effect: s.effect, value: s.value }));
  }

  /**
   * Serialize the pipeline to API query format: "effect:value,effect:value,..."
   */
  serializeSteps() {
    return this.getSteps().map(s => `${s.effect}:${s.value}`).join(',');
  }

  /**
   * Get all slots for a given effect name.
   * @param {string} effect
   * @returns {FxSlot[]}
   */
  getByEffect(effect) {
    return this.slots.filter(s => s.effect === effect);
  }

  /* -- Private ----------------------------------------------------------- */

  /** Update labels to show index when duplicates exist (e.g. "Threshold #2"). */
  _syncLabels() {
    const counts = {};
    for (const s of this.slots) {
      counts[s.effect] = (counts[s.effect] || 0) + 1;
    }
    const seen = {};
    for (const s of this.slots) {
      const meta = FxRack.EFFECTS[s.effect];
      const label = typeof i18n !== 'undefined' ? i18n.t(meta.labelKey) : meta.labelKey;
      seen[s.effect] = (seen[s.effect] || 0) + 1;
      if (counts[s.effect] > 1) {
        s.setLabel(`${label} #${seen[s.effect]}`);
      } else {
        s.setLabel(label);
      }
    }
  }

  /** Enable/disable add and remove buttons based on slot count. */
  _syncButtons() {
    const atMax = this.slots.length >= FxRack.MAX_SLOTS;
    const atMin = this.slots.length <= FxRack.MIN_SLOTS;
    this._addBtn.disabled = atMax;
    for (const s of this.slots) {
      s.setRemovable(!atMin);
    }
    this._syncCount();
  }

  /** Update the "active / total" counter in the header. */
  _syncCount() {
    const total = this.slots.length;
    const active = this.slots.filter(s => s.enabled).length;
    this._countEl.textContent = `${active}/${total}`;
  }

  _initDragAndDrop() {
    const rack = this.el;
    let draggedSlot = null;

    rack.addEventListener('mousedown', e => {
      const handle = e.target.closest('.rack-handle');
      if (!handle) return;
      const slotEl = handle.closest('.rack-slot');
      if (slotEl) slotEl.draggable = true;
    });

    rack.addEventListener('dragstart', e => {
      const slotEl = e.target.closest('.rack-slot');
      if (!slotEl) return;
      draggedSlot = slotEl;
      slotEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    rack.addEventListener('dragover', e => {
      e.preventDefault();
      const slotEl = e.target.closest('.rack-slot');
      if (!slotEl || slotEl === draggedSlot) return;

      rack.querySelectorAll('.drag-over').forEach(s => s.classList.remove('drag-over'));
      slotEl.classList.add('drag-over');

      const rect = slotEl.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        rack.insertBefore(draggedSlot, slotEl);
      } else {
        rack.insertBefore(draggedSlot, slotEl.nextSibling);
      }
    });

    rack.addEventListener('dragend', () => {
      if (draggedSlot) {
        draggedSlot.classList.remove('dragging');
        draggedSlot.draggable = false;
        draggedSlot = null;
      }
      rack.querySelectorAll('.drag-over').forEach(s => s.classList.remove('drag-over'));

      // Rebuild slots array to match new DOM order, then notify
      const ordered = [...rack.querySelectorAll('.rack-slot')];
      this.slots.sort((a, b) => ordered.indexOf(a.el) - ordered.indexOf(b.el));
      this._onChange();
    });
  }
}

// Export for consumption by app.js
window.FxRack = FxRack;
