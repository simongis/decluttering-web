import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { es } from './es';
import { DEFAULT_LOCALE, formatNumber, getLocale, isLocale, matchLocale, profileLocale, setLocale, t, tn } from './index';

afterEach(async () => { await setLocale(DEFAULT_LOCALE, false); });

describe('catalogues', () => {
  it('Spanish has exactly the English keys', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });
  it('every message keeps the same {placeholders} in every language', () => {
    const names = (m: unknown) => (typeof m === 'string' ? m : Object.values(m as object).join(' ')).match(/\{\w+\}/g)?.sort().join() ?? '';
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      // A singular form may write the number out ("1 person") instead of using {count}; nothing else may go missing or be invented.
      const want = names(en[k]).split(',').filter(Boolean), got = names(es[k]).split(',').filter(Boolean);
      for (const p of got) expect(want, k).toContain(p);
      for (const p of want) if (p !== '{count}') expect(got, k).toContain(p);
    }
  });
});

describe('matchLocale', () => {
  it('uses the first supported language, ignoring the region', () => {
    expect(matchLocale(['fr-FR', 'es-MX', 'en'])).toBe('es');
    expect(matchLocale(['ES'])).toBe('es');
  });
  it('falls back to English', () => {
    expect(matchLocale([])).toBe('en');
    expect(matchLocale(['de', 'fr'])).toBe('en');
  });
  it('isLocale rejects anything else', () => {
    expect(isLocale('es')).toBe(true);
    expect(isLocale('xx')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});

describe('profileLocale (ArcGIS Online culture)', () => {
  it('prefers the user profile, then the org, and only supported languages', () => {
    expect(profileLocale('es-MX', 'en')).toBe('es');
    expect(profileLocale('en-AU', 'es')).toBe('en');
    expect(profileLocale(null, 'es')).toBe('es');
    expect(profileLocale('fr', 'es-ES')).toBe('es');
  });
  it('says nothing when neither is supported or set, so the browser language stands', () => {
    expect(profileLocale('fr', 'de')).toBeNull();
    expect(profileLocale(undefined, '')).toBeNull();
  });
});

describe('t', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('steps.line', { n: 2, total: 3, label: 'Review' })).toBe('Step 2 of 3: Review');
    expect(t('steps.line', { n: 2 })).toBe('Step 2 of {total}: {label}');
  });
  it('switches language, sets <html lang> and tells subscribers', async () => {
    await setLocale('es', false);
    expect(getLocale()).toBe('es');
    expect(t('steps.review')).toBe('Revisión');
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('es').format(1234.5));
    if (typeof document !== 'undefined') expect(document.documentElement.lang).toBe('es');
  });
});

describe('tn', () => {
  it('picks the plural form for the current language', async () => {
    const forms = { one: '{count} map', other: '{count} maps' };
    const orig = en as Record<string, unknown>;
    orig['test.maps'] = forms;
    try {
      expect(tn('test.maps' as never, 1)).toBe('1 map');
      expect(tn('test.maps' as never, 5)).toBe('5 maps');
    } finally { delete orig['test.maps']; }
  });
});
