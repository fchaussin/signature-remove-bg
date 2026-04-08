'use strict';

/**
 * Icon — Lightweight SVG icon provider.
 *
 * Usage:
 *   Icon.get('sun')            → SVG string at default size (16)
 *   Icon.get('sun', 20)        → SVG string at 20×20
 *   Icon.inject()              → replaces all <span data-icon="name"> in the DOM
 *
 * All icons use a 24×24 viewBox with stroke-based drawing (Lucide style).
 * `currentColor` is inherited so icons follow the parent text color.
 */
const Icon = (() => {

  const PATHS = {

    /* -- FxSlot effects --------------------------------------------------- */

    // Sun — luminosity threshold
    sun: [
      '<circle cx="12" cy="12" r="4"/>',
      '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41',
      'M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    ],

    // Droplet — blue tolerance
    droplet: [
      '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"/>',
    ],

    // Waves — edge smoothing
    waves: [
      '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
      '<path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
      '<path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
    ],

    // Circle-half — contrast
    'circle-half': [
      '<circle cx="12" cy="12" r="9"/>',
      '<path d="M12 3v18" fill="none"/>',
      '<path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" stroke="none"/>',
    ],

    /* -- UI chrome -------------------------------------------------------- */

    // Grip dots — drag handle
    grip: [
      '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/>',
      '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>',
      '<circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    ],

    // Magnifying glass — zoom
    search: [
      '<circle cx="11" cy="11" r="7"/>',
      '<line x1="16.5" y1="16.5" x2="21" y2="21"/>',
    ],

    // X mark — close
    close: [
      '<line x1="18" y1="6" x2="6" y2="18"/>',
      '<line x1="6" y1="6" x2="18" y2="18"/>',
    ],

    // Left-right arrows — compare slider knob
    'arrows-h': [
      '<polyline points="7 9 4 12 7 15"/>',
      '<polyline points="17 9 20 12 17 15"/>',
      '<line x1="4" y1="12" x2="20" y2="12"/>',
    ],

    // Save — floppy disk
    save: [
      '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>',
      '<polyline points="17 21 17 13 7 13 7 21"/>',
      '<polyline points="7 3 7 8 15 8"/>',
    ],

    // Download arrow
    download: [
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
      '<polyline points="7 10 12 15 17 10"/>',
      '<line x1="12" y1="15" x2="12" y2="3"/>',
    ],

    // Crop / scissors frame
    crop: [
      '<path d="M6 2v14a2 2 0 0 0 2 2h14"/>',
      '<path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    ],

    // Code brackets — base64
    code: [
      '<polyline points="16 18 22 12 16 6"/>',
      '<polyline points="8 6 2 12 8 18"/>',
    ],

    // Chevron down — expand/collapse
    'chevron-down': [
      '<polyline points="6 9 12 15 18 9"/>',
    ],

    // Clipboard — copy
    clipboard: [
      '<rect x="8" y="2" width="8" height="4" rx="1"/>',
      '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    ],

    // Split columns — compare toggle
    columns: [
      '<rect x="3" y="3" width="18" height="18" rx="2"/>',
      '<line x1="12" y1="3" x2="12" y2="21"/>',
    ],
  };

  /**
   * Return an SVG string for the given icon name.
   * @param {string} name   — icon key (see PATHS)
   * @param {number} [size] — width & height in px (default 16)
   * @returns {string} inline SVG markup
   */
  function get(name, size) {
    const parts = PATHS[name];
    if (!parts) return '';
    const s = size != null ? ` width="${size}" height="${size}"` : '';
    return `<svg class="icon icon-${name}"${s} viewBox="0 0 24 24" fill="none" `
         + `stroke="currentColor" stroke-width="2" stroke-linecap="round" `
         + `stroke-linejoin="round" aria-hidden="true">${parts.join('')}</svg>`;
  }

  /**
   * Replace every <span data-icon="name"> (optionally data-icon-size="N")
   * in the document with the corresponding inline SVG.
   */
  function inject() {
    document.querySelectorAll('[data-icon]').forEach(el => {
      const name = el.dataset.icon;
      const size = el.dataset.iconSize;
      const svg  = get(name, size ? Number(size) : undefined);
      if (svg) el.innerHTML = svg;
    });
  }

  return { get, inject };

})();

// Export for consumption by other scripts
window.Icon = Icon;
