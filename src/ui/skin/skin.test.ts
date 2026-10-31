// DC-135 (ADR 0014): the console look. Remembered per browser, applied as one attribute plus Calcite's dark mode.
import { beforeEach, describe, expect, it } from 'vitest';
import { applySkin, currentSkin, onSkinChange, resetSkinMemory, setSkin, storedSkin, type DocLike } from './skin';
import type { StorageLike } from '../../cache/settings';

function memStore(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map, get length() { return map.size; },
    getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
  };
}
function el() {
  const classes = new Set<string>(['calcite-mode-light']);
  const attrs = new Map<string, string>();
  return {
    classes, attrs,
    classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); }, contains: (c: string) => classes.has(c) },
    setAttribute: (k: string, v: string) => { attrs.set(k, v); }, removeAttribute: (k: string) => { attrs.delete(k); },
  };
}
function fakeDoc() {
  const html = el(), body = el();
  const links: string[] = [];
  const doc: DocLike = {
    documentElement: html, body,
    getElementById: (id) => (links.includes(id) ? {} : null),
    addFontLink: (id) => { links.push(id); },
  };
  return { doc, html, body, links };
}

beforeEach(() => resetSkinMemory());

describe('skin', () => {
  it('is standard by default, and when storage is blocked or holds junk', () => {
    expect(storedSkin(memStore())).toBe('standard');
    expect(storedSkin(null)).toBe('standard');
    const s = memStore(); s.setItem('decluttering:skin', '"warp"');
    expect(storedSkin(s)).toBe('standard');
  });

  it('remembers the console look per browser, and the way back', () => {
    const s = memStore(), d = fakeDoc();
    setSkin('console', s, d.doc);
    expect(s.map.get('decluttering:skin')).toBe('"console"');
    expect(storedSkin(s)).toBe('console');
    setSkin('standard', s, d.doc);
    expect(s.map.has('decluttering:skin')).toBe(false);
    expect(storedSkin(s)).toBe('standard');
  });

  it('a click still works when storage is blocked, until reload', () => {
    const d = fakeDoc();
    setSkin('console', null, d.doc);
    expect(currentSkin(null)).toBe('console');
    expect(d.html.attrs.get('data-skin')).toBe('console');
  });

  it('applies as data-skin plus dark mode on html and body, loads the font once, and undoes cleanly', () => {
    const d = fakeDoc();
    applySkin('console', d.doc);
    applySkin('console', d.doc);
    for (const e of [d.html, d.body]) { expect(e.classes.has('calcite-mode-dark')).toBe(true); expect(e.classes.has('calcite-mode-light')).toBe(false); }
    expect(d.html.attrs.get('data-skin')).toBe('console');
    expect(d.links).toEqual(['dc-skin-font']);
    applySkin('standard', d.doc);
    for (const e of [d.html, d.body]) { expect([...e.classes]).toEqual(['calcite-mode-light']); }
    expect(d.html.attrs.has('data-skin')).toBe(false);
  });

  it('tells listeners, so the header and the badge follow at once', () => {
    const seen: string[] = [];
    const off = onSkinChange(() => seen.push(currentSkin(null)));
    setSkin('console', null, fakeDoc().doc);
    off();
    setSkin('standard', null, fakeDoc().doc);
    expect(seen).toEqual(['console']);
  });
});
