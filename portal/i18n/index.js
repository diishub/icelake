/*
 * Language switching for the PSU Data Hub portal.
 *
 * Behaviour only. The strings live one file per language in this folder and
 * register themselves on window.PSU_I18N_STRINGS before this file runs, which
 * is why the script tags in index.html are in that order. Keeping them as
 * plain scripts rather than fetched JSON keeps the first paint synchronous:
 * the page is never briefly in the wrong language.
 *
 * The markup still ships readable Thai. If this file fails to load, the page
 * is a working Thai page rather than a shell of empty elements.
 *
 * Adding a language:
 *   1. copy th.js, translate the values, keep every key
 *   2. add it to SUPPORTED below
 *   3. add a script tag for it in index.html, before this file
 *   4. run scripts/test-portal-i18n.sh
 */
(() => {
  "use strict";

  const STORAGE_KEY = "psu-data-hub-language";
  const SUPPORTED = ["th", "en"];
  const DEFAULT_LANGUAGE = "th";

  const strings = window.PSU_I18N_STRINGS || {};
  for (const language of SUPPORTED) {
    if (!strings[language]) {
      console.error(`[i18n] no strings loaded for ${language}`);
      strings[language] = {};
    }
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------

  const readStoredLanguage = () => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(stored) ? stored : null;
    } catch (_error) {
      // Private browsing can disable storage. The page still works, it just
      // starts in the default language every time.
      return null;
    }
  };

  /**
   * The stored choice wins, then the browser's own preference, then Thai.
   * Only the primary subtag is read, so en-GB and en-US both mean English.
   */
  const detectLanguage = () => {
    const stored = readStoredLanguage();
    if (stored) {
      return stored;
    }
    for (const tag of navigator.languages || [navigator.language]) {
      const primary = String(tag || "").toLowerCase().split("-")[0];
      if (SUPPORTED.includes(primary)) {
        return primary;
      }
    }
    return DEFAULT_LANGUAGE;
  };

  let current = detectLanguage();
  const listeners = new Set();

  /**
   * Looks a key up in the active language. A missing key falls back to Thai
   * rather than to the key itself: an English reader seeing one Thai line has
   * lost less than one seeing "catalog.owner".
   */
  function translate(key, replacements) {
    const table = strings[current] || strings[DEFAULT_LANGUAGE];
    let text = table[key];
    if (text === undefined) {
      text = strings[DEFAULT_LANGUAGE][key];
      if (text === undefined) {
        console.warn(`[i18n] no string for ${key}`);
        return "";
      }
      console.warn(`[i18n] ${key} is missing in ${current}; used ${DEFAULT_LANGUAGE}`);
    }
    if (!replacements) {
      return text;
    }
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(replacements, name) ? String(replacements[name]) : match);
  }

  /**
   * Writes every marked string into the document. data-i18n sets the text;
   * data-i18n-attr carries "attribute:key" pairs for placeholders, labels and
   * titles, which are just as visible to a reader as the text is.
   */
  function applyToDocument(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = translate(node.dataset.i18n);
    });

    root.querySelectorAll("[data-i18n-attr]").forEach((node) => {
      for (const pair of node.dataset.i18nAttr.split(",")) {
        const [attribute, key] = pair.split(":").map((part) => part.trim());
        if (attribute && key) {
          node.setAttribute(attribute, translate(key));
        }
      }
    });

    document.documentElement.lang = current;
    const description = document.querySelector('meta[name="description"]');
    if (description) {
      description.setAttribute("content", translate("meta.description"));
    }
  }

  function setLanguage(language) {
    if (!SUPPORTED.includes(language) || language === current) {
      return;
    }
    current = language;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch (_error) {
      // The choice is a convenience; the page works without it persisting.
    }
    applyToDocument();
    // Anything rendered from data rather than from markup re-renders itself.
    listeners.forEach((listener) => listener(current));
  }

  window.PSU_I18N = Object.freeze({
    supported: SUPPORTED,
    get language() {
      return current;
    },
    other: () => (current === "th" ? "en" : "th"),
    t: translate,
    apply: applyToDocument,
    set: setLanguage,
    toggle: () => setLanguage(current === "th" ? "en" : "th"),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });

  // Applied before app.js runs so the first paint is already in the right
  // language rather than flipping once scripts finish.
  document.documentElement.lang = current;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyToDocument(), { once: true });
  } else {
    applyToDocument();
  }
})();
