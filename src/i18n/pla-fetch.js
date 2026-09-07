// Shared main/renderer module: fetches Portable-Linux-Apps resources with an
// automatic language prefix and English fallback.
//
// Loaded by the main process (require) and the renderer (<script> tag).
// No language list to maintain: the UI's preferred language is tried first,
// then en/ on failure (404, network error…).
(function registerPlaFetch() {
  'use strict';

  const PLA_BASE = 'https://portable-linux-apps.github.io';

  function normalizeLang(lang) {
    const base = String(lang || 'en').slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(base) ? base : 'en';
  }

  // Creates a language-prefixed fetch.
  // - getLang() → UI's preferred language (e.g. 'fr', 'en')
  // - fetchFn   → fetch function (undici on main, global fetch on renderer)
  function createPlaFetch(getLang, fetchFn) {
    const resolve = typeof getLang === 'function' ? getLang : () => 'en';
    const doFetch = typeof fetchFn === 'function' ? fetchFn : ((u, o) => fetch(u, o));
    return async function fetchPla(path, options) {
      const lang = normalizeLang(resolve());
      const candidates = lang === 'en' ? ['en'] : [lang, 'en'];
      let lastErr = null;
      for (const l of candidates) {
        try {
          const res = await doFetch(`${PLA_BASE}/${l}/${path}`, options);
          if (res.ok || res.status === 304) return res;
          lastErr = new Error('HTTP ' + res.status);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('PLA fetch failed');
    };
  }

  const api = { PLA_BASE, createPlaFetch };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.plaFetch = api;
  }
})();
