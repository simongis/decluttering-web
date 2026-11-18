// Keeping the open app up to date with the build that is served, and starting a new build clean.
//   - Every build and every dev-server start has its own id (vite.config.ts), baked in as BUILD_ID and published as
//     <base>version.json. The app compares the two and, when they differ, offers a reload.
//   - The first load of a new build clears what the old build saved and the new one might read wrongly: the saved scan
//     (IndexedDB) and any Cache Storage of the app's. Sign-in and settings stay.
// Vite names every script and stylesheet by its content hash, so a reload that fetches a fresh index.html gets the new
// build. GitHub Pages caches index.html for 10 minutes, so the reload adds ?b=<build> to fetch it again.
import { BUILD_ID } from '../version';

export const BUILD_KEY = 'decluttering:build';
const DB_PREFIX = 'decluttering';
const CACHE_PREFIX = 'decluttering';
/** The reload's cache-busting parameter; removed from the address bar once the app has loaded. */
export const RELOAD_PARAM = 'b';

export interface FreshDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  idb?: Pick<IDBFactory, 'deleteDatabase'> & { databases?: () => Promise<{ name?: string }[]> };
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
}

function deleteDb(idb: NonNullable<FreshDeps['idb']>, name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(name);
      const done = () => resolve();
      req.onsuccess = done; req.onerror = done; req.onblocked = done; // blocked: another tab has it open; it goes when that closes
      setTimeout(done, 2000);
    } catch { resolve(); }
  });
}

/**
 * Call once before the app starts. When this is not the build that last ran in this browser, removes the saved scan and the
 * app's Cache Storage, then records this build. Returns true when it cleared. Never throws.
 */
export async function freshStartForBuild(id: string = BUILD_ID, deps: FreshDeps = {}): Promise<boolean> {
  const storage = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  let prev: string | null;
  try { prev = storage?.getItem(BUILD_KEY) ?? null; } catch { return false; }
  if (prev === id) return false;
  const idb = deps.idb ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (idb) {
    let names: string[] = [DB_PREFIX];
    try { const all = await idb.databases?.(); if (all) names = all.map((d) => d.name ?? '').filter((n) => n.startsWith(DB_PREFIX)); } catch { /* no list: the known name */ }
    await Promise.all(names.map((n) => deleteDb(idb, n)));
  }
  const cs = deps.caches ?? (typeof caches !== 'undefined' ? caches : undefined);
  if (cs) {
    try { for (const k of await cs.keys()) if (k.startsWith(CACHE_PREFIX)) await cs.delete(k); } catch { /* not available */ }
  }
  try { storage?.setItem(BUILD_KEY, id); } catch { /* storage blocked: it clears again next time, which is harmless */ }
  return true;
}

/** The build the server has now, or null when it can't be read (offline, a host without version.json). */
export async function latestBuild(fetchFn: typeof fetch = fetch, base: string = import.meta.env.BASE_URL): Promise<string | null> {
  try {
    const res = await fetchFn(`${base}version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const body = await res.json() as { build?: unknown };
    return typeof body.build === 'string' && body.build ? body.build : null;
  } catch { return null; }
}

/** True when the server has a build other than the one running. A build without an id (tests) never asks. */
export function isOutdated(running: string, latest: string | null): boolean {
  return !!latest && running !== 'dev' && latest !== running;
}

/** Where "Reload" goes: the same page with ?b=<build>, so a cached index.html is not reused. The hash is kept. */
export function reloadUrl(href: string, build: string): string {
  const u = new URL(href);
  u.searchParams.set(RELOAD_PARAM, build);
  return u.toString();
}

/** The address without ?b=, for after the app has loaded. Other parameters (an OAuth return) stay. */
export function withoutReloadParam(href: string): string | null {
  const u = new URL(href);
  if (!u.searchParams.has(RELOAD_PARAM)) return null;
  u.searchParams.delete(RELOAD_PARAM);
  return u.pathname + (u.search === '?' ? '' : u.search) + u.hash;
}

export interface WatchOptions {
  running?: string;
  /** How often to look while the tab is open and visible. */
  everyMs?: number;
  /** At most one look per this, however often the tab is shown or focused. */
  minGapMs?: number;
  check?: () => Promise<string | null>;
}

/** Looks for a newer build now, every few minutes, and when the tab is shown again. Calls `onNewer` once. Returns stop. */
export function watchForUpdates(onNewer: (build: string) => void, o: WatchOptions = {}): () => void {
  const running = o.running ?? BUILD_ID, every = o.everyMs ?? 5 * 60_000, gap = o.minGapMs ?? 30_000, check = o.check ?? (() => latestBuild());
  let last = -Infinity, stopped = false, told = false;
  const look = async (force = false) => {
    if (stopped || told) return;
    const now = Date.now();
    if (!force && now - last < gap) return;
    last = now;
    const latest = await check();
    if (!stopped && !told && isOutdated(running, latest)) { told = true; onNewer(latest as string); }
  };
  const onShow = () => { if (document.visibilityState === 'visible') void look(); };
  document.addEventListener('visibilitychange', onShow);
  window.addEventListener('focus', onShow);
  const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void look(true); }, every);
  void look(true);
  return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow); };
}
