import type { Thresholds } from '../domain/types';
import type { KeyValueStore } from './store';

export const PREFIX = 'decluttering:';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export interface SettingsShape {
  thresholds: Thresholds;
  splashDismissed: boolean;
  templateEdits: Record<string, string>;
  /** DC-086: per org id, "Count days when everything was touched at once" (absent: off). */
  countSweeps: Record<string, boolean>;
  /** DC-135 (ADR 0014): the optional console look; absent means the standard look. */
  skin: 'console';
}

export class Settings {
  constructor(private storage: StorageLike = localStorage) {}

  get<K extends keyof SettingsShape>(name: K): SettingsShape[K] | undefined {
    const raw = this.storage.getItem(PREFIX + name);
    if (raw === null) return undefined;
    try { return JSON.parse(raw) as SettingsShape[K]; } catch { return undefined; }
  }

  set<K extends keyof SettingsShape>(name: K, value: SettingsShape[K]): void {
    this.storage.setItem(PREFIX + name, JSON.stringify(value));
  }

  remove(name: keyof SettingsShape): void { this.storage.removeItem(PREFIX + name); }
}

// ---------- DC-086: "Count days when everything was touched at once", per org ----------
const browser = (): StorageLike | null => { try { return localStorage; } catch { return null; } };
const listeners = new Set<() => void>();
/** This page's choices, so a blocked store still honours a click until reload. */
const memory = new Map<string, boolean>();

/** Whether this org counts sweep days and hours as use. Off by default, and off when storage is blocked. */
export function countSweepsFor(orgId: string | undefined, storage: StorageLike | null = browser()): boolean {
  if (!orgId || !storage) return false;
  try { return new Settings(storage).get('countSweeps')?.[orgId] === true; } catch { return false; }
}

/** Remembers the choice for this org (best effort) and tells every listener, so all screens follow at once. */
export function setCountSweeps(orgId: string, on: boolean, storage: StorageLike | null = browser()): void {
  try {
    if (storage) {
      const s = new Settings(storage);
      const all = { ...(s.get('countSweeps') ?? {}) };
      if (on) all[orgId] = true; else delete all[orgId];
      s.set('countSweeps', all);
    }
  } catch { /* private window or blocked storage: the choice lasts until the page is reloaded */ }
  memory.set(orgId, on);
  for (const fn of listeners) fn();
}
/** The choice in force: this page's click first, then the stored one. */
export const countSweeps = (orgId: string | undefined, storage?: StorageLike | null): boolean =>
  (orgId && memory.has(orgId) ? memory.get(orgId) === true : countSweepsFor(orgId, storage === undefined ? browser() : storage));
export function onCountSweepsChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Clears every `decluttering:` localStorage key and the whole scan cache. */
export async function clearSavedData(storage: StorageLike, cache: KeyValueStore): Promise<void> {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(PREFIX)) doomed.push(k);
  }
  doomed.forEach((k) => storage.removeItem(k));
  await cache.clear();
}
