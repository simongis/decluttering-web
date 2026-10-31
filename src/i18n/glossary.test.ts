import { describe, expect, it } from 'vitest';
import { es } from './es';

// docs/i18n/glossary-es.md: the terms a Spanish change must not slip back to. Each rule says why; a key listed in `allow`
// may use the word (it is the right term there).
const RULES: { word: RegExp; why: string; allow?: RegExp }[] = [
  { word: /obsolet/i, why: '"obsoleto" is Esri\'s word for Deprecated; stale is "sin uso reciente"', allow: /^review\.filter\.status\./ },
  { word: /añad/i, why: 'Esri writes "agregar"' },
  { word: /limpi/i, why: 'tidy up is "ordenar" (tone guide: never clean up)' },
  { word: /\bajustes\b/i, why: 'Settings is "Configuración"' },
  { word: /\bIntro\b/, why: 'the key is "Enter"' },
  { word: /\bcordial/i, why: 'friendly is "amable"' },
];

const text = (m: unknown): string => (typeof m === 'string' ? m : Object.values(m as object).join(' '));

describe('Spanish glossary', () => {
  for (const r of RULES) {
    it(`no ${r.word} (${r.why})`, () => {
      const hits = Object.entries(es).filter(([k, m]) => r.word.test(text(m)) && !r.allow?.test(k)).map(([k]) => k);
      expect(hits).toEqual([]);
    });
  }
});
