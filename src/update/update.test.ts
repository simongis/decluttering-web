import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_KEY, freshStartForBuild, isOutdated, latestBuild, reloadUrl, watchForUpdates, withoutReloadParam } from './update';

const memStorage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const fakeIdb = (names: string[]) => {
  const deleted: string[] = [];
  return {
    deleted,
    databases: async () => names.map((name) => ({ name })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req = {} as IDBOpenDBRequest;
      queueMicrotask(() => (req.onsuccess as unknown as (() => void) | null)?.());
      return req;
    },
  };
};
const fakeCaches = (names: string[]) => {
  const deleted: string[] = [];
  return { deleted, keys: async () => names, delete: async (k: string) => { deleted.push(k); return true; } };
};

describe('freshStartForBuild', () => {
  it('on a new build: deletes only the app’s databases and caches, then records the build', async () => {
    const storage = memStorage({ [BUILD_KEY]: 'old', 'decluttering:locale': 'es' });
    const idb = fakeIdb(['decluttering', 'other-app']);
    const cs = fakeCaches(['decluttering-assets', 'someone-else']);
    expect(await freshStartForBuild('new', { storage, idb, caches: cs })).toBe(true);
    expect(idb.deleted).toEqual(['decluttering']);
    expect(cs.deleted).toEqual(['decluttering-assets']);
    expect(storage.m.get(BUILD_KEY)).toBe('new');
    expect(storage.m.get('decluttering:locale')).toBe('es'); // settings stay
  });
  it('also clears for a browser that never recorded a build (an older version saved a scan)', async () => {
    const storage = memStorage();
    const idb = fakeIdb(['decluttering']);
    expect(await freshStartForBuild('b1', { storage, idb })).toBe(true);
    expect(idb.deleted).toEqual(['decluttering']);
  });
  it('does nothing on the build that already ran', async () => {
    const idb = fakeIdb(['decluttering']);
    expect(await freshStartForBuild('same', { storage: memStorage({ [BUILD_KEY]: 'same' }), idb })).toBe(false);
    expect(idb.deleted).toEqual([]);
  });
  it('without a database list, deletes the known name', async () => {
    const idb = fakeIdb([]);
    delete (idb as { databases?: unknown }).databases;
    await freshStartForBuild('x', { storage: memStorage(), idb });
    expect(idb.deleted).toEqual(['decluttering']);
  });
});

describe('latestBuild and isOutdated', () => {
  it('reads version.json without the cache', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ build: 'abc-1', commit: 'abc' }), { status: 200 }));
    expect(await latestBuild(f as unknown as typeof fetch, '/app/')).toBe('abc-1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/app\/version\.json\?t=\d+$/);
    expect(init.cache).toBe('no-store');
  });
  it('null when missing, not JSON, or offline', async () => {
    expect(await latestBuild((async () => new Response('', { status: 404 })) as unknown as typeof fetch)).toBeNull();
    expect(await latestBuild((async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await latestBuild((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
  it('outdated only when the server has another build', () => {
    expect(isOutdated('a', 'b')).toBe(true);
    expect(isOutdated('a', 'a')).toBe(false);
    expect(isOutdated('a', null)).toBe(false);
    expect(isOutdated('dev', 'b')).toBe(false);
  });
});

describe('reload address', () => {
  it('adds ?b= and keeps the hash; removes it again later, keeping other parameters', () => {
    expect(reloadUrl('https://x.io/app/#/review', 'n1')).toBe('https://x.io/app/?b=n1#/review');
    expect(reloadUrl('https://x.io/app/?b=old#/r', 'n2')).toBe('https://x.io/app/?b=n2#/r');
    expect(withoutReloadParam('https://x.io/app/?b=n1#/review')).toBe('/app/#/review');
    expect(withoutReloadParam('https://x.io/app/?code=1&b=n1')).toBe('/app/?code=1');
    expect(withoutReloadParam('https://x.io/app/#/review')).toBeNull();
  });
});

describe('watchForUpdates', () => {
  // No DOM in these tests: a document and window with just what the watcher uses.
  beforeEach(() => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (i: number) => clearInterval(i) }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('looks at once and tells once when a newer build is served', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => 'new');
    const onNewer = vi.fn();
    const stop = watchForUpdates(onNewer, { running: 'old', check, everyMs: 1000, minGapMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onNewer).toHaveBeenCalledWith('new');
    await vi.advanceTimersByTimeAsync(5000);
    expect(onNewer).toHaveBeenCalledTimes(1);
    stop();
  });
  it('keeps looking while the build is the same, and stops when told', async () => {
    vi.useFakeTimers();
    let served = 'same';
    const check = vi.fn(async () => served);
    const onNewer = vi.fn();
    const stop = watchForUpdates(onNewer, { running: 'same', check, everyMs: 1000, minGapMs: 0 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(onNewer).not.toHaveBeenCalled();
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3);
    served = 'newer';
    await vi.advanceTimersByTimeAsync(1000);
    expect(onNewer).toHaveBeenCalledWith('newer');
    stop();
    const n = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(check.mock.calls.length).toBe(n);
  });
});
