'use strict';

window.i18n = {
  lang: 'en',
  locale: {},
  fallback: {},

  /** Allowed HTML tags in data-i18n-html values (whitelist). */
  _ALLOWED_TAGS: ['strong', 'em', 'br', 'kbd', 'b', 'i', 'span'],

  /** Sanitize HTML: strip all tags except whitelisted ones, remove all attributes. */
  _sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = this._ALLOWED_TAGS;

    function walk(node) {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!allowed.includes(child.tagName.toLowerCase())) {
            // Replace forbidden tag with its text content
            child.replaceWith(document.createTextNode(child.textContent));
          } else {
            // Strip all attributes from allowed tags
            while (child.attributes.length > 0) {
              child.removeAttribute(child.attributes[0].name);
            }
            walk(child);
          }
        } else {
          child.remove();
        }
      }
    }

    walk(doc.body);
    return doc.body.innerHTML;
  },

  /** Escape HTML entities in a string (for safe param interpolation). */
  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /** Translate a key, with optional {param} interpolation. Returns the key itself if not found. */
  t(key, params) {
    let str = this.locale[key] || this.fallback[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), this._escape(v));
      }
    }
    return str;
  },

  /** Fetch a locale JSON file. Returns the parsed object or {} on failure. */
  async _fetch(lang) {
    // Sanitize lang code: only allow lowercase letters (OWASP A03 — path traversal)
    if (!/^[a-z]{2,3}$/.test(lang)) return {};
    try {
      const res = await fetch(`/static/lang/${lang}.json`);
      if (!res.ok) return {};
      return await res.json();
    } catch {
      return {};
    }
  },

  /** Load the requested language + English fallback. */
  async load(lang) {
    this.fallback = await this._fetch('en');
    if (lang !== 'en') {
      const data = await this._fetch(lang);
      if (Object.keys(data).length) {
        this.locale = data;
        this.lang = lang;
      } else {
        this.locale = this.fallback;
        this.lang = 'en';
      }
    } else {
      this.locale = this.fallback;
      this.lang = 'en';
    }
  },

  /** Apply translations to all elements with data-i18n, data-i18n-html, data-i18n-title. */
  apply() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = this._sanitize(this.t(el.dataset.i18nHtml));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
    document.documentElement.lang = this.lang;
  },

  /** Detect browser language, load locale, apply to DOM. */
  async init() {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    await this.load(lang);
    this.apply();
  }
};
