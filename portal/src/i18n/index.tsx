/*
 * Language switching for the PSU Data Hub portal.
 *
 * The strings live one module per language in this folder. th.ts is the
 * reference: en.ts is typed against it, so a missing or extra key fails the
 * build.
 *
 * Pages are prerendered in Thai (the default), and the reader's choice is
 * applied after hydration. Reading localStorage during render would make the
 * prerendered markup disagree with the first client render.
 *
 * Adding a language:
 *   1. copy th.ts, translate the values, keep every key
 *   2. add it to STRINGS below
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import en from './en';
import th from './th';
import type { MessageKey } from './th';

export type { MessageKey };
export type Language = 'th' | 'en';
export type Replacements = Record<string, string | number>;

const STRINGS: Record<Language, Record<MessageKey, string>> = { th, en };
const SUPPORTED: readonly Language[] = ['th', 'en'];
const DEFAULT_LANGUAGE: Language = 'th';
const STORAGE_KEY = 'psu-data-hub-language';

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(th, key);
}

function format(text: string, replacements?: Replacements): string {
  if (!replacements) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(replacements, name) ? String(replacements[name]) : match);
}

function readStoredLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return SUPPORTED.includes(stored as Language) ? (stored as Language) : null;
  } catch {
    // Private browsing can disable storage. The page still works, it just
    // starts in the default language every time.
    return null;
  }
}

/**
 * The stored choice wins, then the browser's own preference, then Thai.
 * Only the primary subtag is read, so en-GB and en-US both mean English.
 */
function detectLanguage(): Language {
  const stored = readStoredLanguage();
  if (stored) {
    return stored;
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const primary = String(tag || '').toLowerCase().split('-')[0] as Language;
    if (SUPPORTED.includes(primary)) {
      return primary;
    }
  }
  return DEFAULT_LANGUAGE;
}

interface I18nValue {
  language: Language;
  other: Language;
  /** A key known at compile time. */
  t: (key: MessageKey, replacements?: Replacements) => string;
  /**
   * A key built at run time (`tier.${tier}`, an API error code). Unknown keys
   * fall back to `fallback`, or to an empty string -- never to the key itself.
   */
  tx: (key: string, replacements?: Replacements, fallback?: MessageKey) => string;
  /** A deployment string that is either plain or a per-language map. */
  pick: (value: string | Partial<Record<Language, string>> | undefined) => string;
  setLanguage: (language: Language) => void;
  toggle: () => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);

  useEffect(() => {
    setLanguageState(detectLanguage());
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    if (!SUPPORTED.includes(next)) {
      return;
    }
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice is a convenience; the page works without it persisting.
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const table = STRINGS[language];
    const t = (key: MessageKey, replacements?: Replacements) => format(table[key], replacements);
    const tx = (key: string, replacements?: Replacements, fallback?: MessageKey) => {
      if (isMessageKey(key)) {
        return t(key, replacements);
      }
      return fallback ? t(fallback, replacements) : '';
    };
    const pick: I18nValue['pick'] = (entry) => {
      if (!entry) return '';
      if (typeof entry === 'string') return entry;
      return entry[language] ?? entry[DEFAULT_LANGUAGE] ?? '';
    };
    const other: Language = language === 'th' ? 'en' : 'th';
    return {
      language,
      other,
      t,
      tx,
      pick,
      setLanguage,
      toggle: () => setLanguage(other),
    };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return value;
}
