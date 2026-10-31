// Localisation (ADR 0015): a small typed message catalogue plus Intl formatters. English is bundled; other languages load as
// same-origin chunks (the CSP forbids anything else). t() is synchronous and falls back to English, so a slow chunk never blanks the UI.
import { en, type Message, type MessageKey, type PluralForms } from './en';

export type { MessageKey } from './en';

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
/** Each language's own name, for the picker. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', es: 'Español' };
export const STORAGE_KEY = 'decluttering:locale';

type Catalogue = Record<MessageKey, Message>;
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<Catalogue>> = {
  es: async () => (await import('./es')).es,
};

const catalogues = new Map<Locale, Catalogue>([['en', en]]);
const listeners = new Set<() => void>();
let current: Locale = DEFAULT_LOCALE;

export function isLocale(v: unknown): v is Locale { return typeof v === 'string' && (LOCALES as readonly string[]).includes(v); }

/** The best supported language for a browser's language list ("es-MX" gives "es"), or English. */
export function matchLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

function readStored(): Locale | null {
  try { const v = localStorage.getItem(STORAGE_KEY); return isLocale(v) ? v : null; } catch { return null; }
}

export function getLocale(): Locale { return current; }

/** Subscribe to language changes; returns the unsubscribe function. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function load(locale: Locale): Promise<void> {
  if (catalogues.has(locale) || locale === 'en') return;
  try { catalogues.set(locale, await loaders[locale]()); } catch { /* offline or blocked: keep showing English */ }
}

/** Switch language: load it, update <html lang>, optionally remember the choice, and tell subscribers. */
export async function setLocale(locale: Locale, persist = true): Promise<void> {
  await load(locale);
  current = catalogues.has(locale) ? locale : DEFAULT_LOCALE;
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  if (persist) { try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage blocked: the choice lasts until reload */ } }
  for (const fn of [...listeners]) fn();
}

/** The saved choice, else the browser's language, else English. Call once at start-up, before the first render. */
export async function initLocale(): Promise<void> {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
  await setLocale(readStored() ?? matchLocale(preferred), false);
}

/** The first supported language of the user's then the org's ArcGIS Online `culture` (e.g. "es-MX"), or null when neither is. */
export function profileLocale(userCulture?: string | null, orgCulture?: string | null): Locale | null {
  for (const c of [userCulture, orgCulture]) {
    const base = c?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/**
 * After sign-in: the ArcGIS Online profile (then org) language beats the browser's, but never a choice the admin made here.
 * Not saved, so a later profile change still takes effect.
 */
export async function applyProfileLocale(userCulture?: string | null, orgCulture?: string | null): Promise<void> {
  if (readStored()) return;
  const l = profileLocale(userCulture, orgCulture);
  if (l && l !== current) await setLocale(l, false);
}

function fill(text: string, params?: Record<string, string | number>): string {
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

function lookup(key: MessageKey): Message { return catalogues.get(current)?.[key] ?? en[key]; }

/** A message by key, with {placeholders} filled. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const m = lookup(key);
  return fill(typeof m === 'string' ? m : m.other, params);
}

/** A plural message: picks the form for `count` with Intl.PluralRules; {count} is filled in automatically. */
export function tn(key: MessageKey, count: number, params?: Record<string, string | number>): string {
  const m = lookup(key);
  if (typeof m === 'string') return fill(m, { count, ...params });
  const forms: PluralForms = m;
  const form = new Intl.PluralRules(current).select(count) as keyof PluralForms;
  return fill(forms[form] ?? forms.other, { count, ...params });
}

/**
 * A plural message cut at the placeholders `params` leaves out, for templates that wrap a value in markup (bold, links).
 * Even entries are text, odd entries the placeholder names, in the language's own word order.
 */
export function tnParts(key: MessageKey, count: number, params?: Record<string, string | number>): string[] {
  return tn(key, count, params).split(/\{(\w+)\}/);
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(current, opts).format(n); }
export function formatDate(d: Date | number, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: 'UTC' }): string {
  return new Intl.DateTimeFormat(current, opts).format(d);
}
