'use strict';

/**
 * FxRack — Manages an ordered collection of FxSlot instances.
 *
 * Responsibilities (SRP):
 *  - Instantiate FxSlot (or subclasses) from DOM .rack-slot elements
 *  - Handle drag & drop reordering (handle-only to avoid slider conflicts)
 *  - Expose aggregated values for all slots (used by extractSignature)
 *  - Notify the host app on any change via a single callback
 *
 * Separation of Concerns:
 *  - FxRack does NOT know about the extraction API or the DOM outside .rack
 *  - FxSlot does NOT know about other slots or the rack container
 *  - app.js orchestrates both via the onChange callback
 *
 * Open/Closed Principle:
 *  - New effects = new FxSlot subclass + HTML slot — no FxRack changes needed
 *  - Custom slot types can be registered via slotTypes map
 */
class FxRack {

  /**
   * @param {HTMLElement} el        — the .rack container element
   * @param {object}      opts
   * @param {object}      opts.defaults    — { effectName: { off: number } }
   * @param {object}      opts.slotTypes   — { effectName: FxSlotSubclass } (optional overrides)
   * @param {function}    opts.onChange     — called on any slot value/toggle/order change
   */
  constructor(el, { defaults = {}, slotTypes = {}, onChange = () => {} } = {}) {
    this.el        = el;
    this._defaults = defaults;
    this._onChange  = onChange;

    /** @type {FxSlot[]} ordered list of slots */
    this.slots = [];

    // Instantiate slots from DOM order
    el.querySelectorAll('.rack-slot').forEach(slotEl => {
      const name = slotEl.dataset.effect;
      if (!name) return;
      const Ctor = slotTypes[name] || FxSlot;
      const off  = (defaults[name] && defaults[name].off) ?? 0;
      const slot = new Ctor(slotEl, {
        offValue: off,
        onChange: () => this._onChange(),
      });
      this.slots.push(slot);
    });

    this._initDragAndDrop();
  }

  /* -- Public API -------------------------------------------------------- */

  /**
   * Get a slot by effect name.
   * @param {string} name
   * @returns {FxSlot|undefined}
   */
  get(name) {
    return this.slots.find(s => s.name === name);
  }

  /**
   * Return a plain object of { effectName: effectiveValue } for all slots.
   * Values respect toggle state (disabled → offValue).
   */
  getValues() {
    const values = {};
    for (const slot of this.slots) {
      values[slot.name] = slot.value;
    }
    return values;
  }

  /**
   * Return the current effect order as an array of names.
   * @returns {string[]}
   */
  getOrder() {
    return this.slots.map(s => s.name);
  }

  /* -- Private: drag & drop ---------------------------------------------- */

  _initDragAndDrop() {
    const rack = this.el;
    let draggedSlot = null;

    // Only enable draggable when grabbing the handle (avoids slider conflict)
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
      e.dataTransfer.setData('text/plain', '');  // required for Firefox
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

      // Rebuild slots array to match new DOM order
      const ordered = [...rack.querySelectorAll('.rack-slot')];
      this.slots.sort((a, b) => ordered.indexOf(a.el) - ordered.indexOf(b.el));
    });
  }
}

// Export for consumption by app.js
window.FxRack = FxRack;
