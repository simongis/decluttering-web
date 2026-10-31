// DC-135 (ADR 0014): the optional console look. One attribute on <html> (`data-skin="console"`) plus
// Calcite's dark mode; src/styles/skin-console.css does the rest. Remembered per browser (decluttering:skin). Nothing but
// the styling and the header toggle reads it: data, scoring, sending and owner emails never change.
import { Settings, type StorageLike } from '../../cache/settings';

export type Skin = 'standard' | 'console';

export const SKIN_COPY = {
  /** The header switch's name; on means the console look. */
  name: 'Console look',
  badge: 'Switch to the console look',
  back: 'Standard look',
  backLabel: 'Back to the standard look',
} as const;

/** What applySkin touches: the page root, the body, and a way to add the heading font once. */
export interface DocLike {
  documentElement: ElLike; body: ElLike;
  getElementById(id: string): unknown;
  addFontLink(id: string, href: string): void;
}
interface ElLike {
  classList: { add(c: string): void; remove(c: string): void };
  setAttribute(k: string, v: string): void; removeAttribute(k: string): void;
}

const FONT_ID = 'dc-skin-font';
/** Antonio: a free condensed typeface (SIL Open Font License). Google Fonts is already allowed by the CSP. */
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Antonio:wght@400;600&display=swap';

const browser = (): StorageLike | null => { try { return localStorage; } catch { return null; } };
const listeners = new Set<() => void>();
/** This page's choice, so blocked storage still honours a click until reload. */
let memory: Skin | null = null;

const domDoc = (): DocLike => ({
  documentElement: document.documentElement, body: document.body,
  getElementById: (id) => document.getElementById(id),
  addFontLink: (id, href) => {
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  },
});

/** The stored choice; standard when nothing (or junk) is stored or storage is blocked. */
export function storedSkin(storage: StorageLike | null = browser()): Skin {
  if (!storage) return 'standard';
  try { return new Settings(storage).get('skin') === 'console' ? 'console' : 'standard'; } catch { return 'standard'; }
}

/** The look in force: this page's click first, then the stored one. */
export const currentSkin = (storage?: StorageLike | null): Skin => memory ?? storedSkin(storage === undefined ? browser() : storage);

/** Puts a look on the page. The standard look is exactly the page as built (light mode, no attribute). */
export function applySkin(skin: Skin, doc: DocLike = domDoc()): void {
  const on = skin === 'console';
  for (const e of [doc.documentElement, doc.body]) {
    e.classList.remove(on ? 'calcite-mode-light' : 'calcite-mode-dark');
    e.classList.add(on ? 'calcite-mode-dark' : 'calcite-mode-light');
  }
  if (on) doc.documentElement.setAttribute('data-skin', 'console');
  else doc.documentElement.removeAttribute('data-skin');
  if (on && !doc.getElementById(FONT_ID)) doc.addFontLink(FONT_ID, FONT_HREF);
}

/** Switches the look: remembered (best effort), applied, and every listener told. */
export function setSkin(skin: Skin, storage: StorageLike | null = browser(), doc: DocLike = domDoc()): void {
  try {
    if (storage) {
      const s = new Settings(storage);
      if (skin === 'console') s.set('skin', 'console'); else s.remove('skin');
    }
  } catch { /* private window or blocked storage: the choice lasts until the page is reloaded */ }
  memory = skin;
  applySkin(skin, doc);
  for (const fn of listeners) fn();
}

export function onSkinChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Test hook: forget this page's click. */
export function resetSkinMemory(): void { memory = null; }
