'use strict';

/**
 * DOMPurify configuration — strict whitelist for i18n HTML strings.
 * Only formatting tags allowed, no attributes (blocks onclick, onerror, href, etc.).
 */
const I18N_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['strong', 'em', 'br', 'kbd', 'b', 'i', 'span'],
  ALLOWED_ATTR: [],
};

window.i18n = {
  lang: 'en',
  locale: {},
  fallback: {},

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
      el.innerHTML = DOMPurify.sanitize(this.t(el.dataset.i18nHtml), I18N_PURIFY_CONFIG);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
    document.documentElement.lang = this.lang;
  },

  /** Detect browser language, load locale, apply to DOM, emit ready event. */
  async init() {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    await this.load(lang);
    this.apply();
    this.ready = true;
    document.dispatchEvent(new Event('i18n:ready'));
  }
};
