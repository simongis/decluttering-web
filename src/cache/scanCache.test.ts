import { describe, expect, it } from 'vitest';
import type { Data } from '../domain/types';
import { CACHE_TTL_DAYS, ScanCache, depsToRecheck, mapsToRead, sizesToReuse, staleness, type FetchedAt } from './scanCache';
import { MemoryStore } from './store';

const DAY = 86_400_000;
const t0 = new Date('2026-10-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const iso = (d: Date) => d.toISOString();

const data: Data = {
  org: { id: 'o1', name: 'Org', urlKey: 'org', scannedAt: iso(t0) },
  owners: [{ username: 'amy', fullName: 'Amy', email: 'amy@example.com', disabled: false, thumbnail: null, lastNotified: null }],
  services: [],
};
const fetched = (d: Date): FetchedAt => ({ services: iso(d), usage: iso(d), users: iso(d), dependencies: iso(d) });

describe('ScanCache', () => {
  it('DC-083: keeps lastViewed (including blank), numViews and usageComplete; an old entry without them stays without', async () => {
    const cache = new ScanCache(new MemoryStore(), () => t0);
    const svc = { id: 's', title: 'S', owner: 'amy', created: iso(t0), modified: iso(t0), sizeMB: 1, access: 'org', isView: false, sourceId: null, usage: [], dependencies: [] };
    const withUse: Data = { ...data, usageComplete: false, services: [{ ...svc, lastViewed: iso(t0), numViews: 585557 }, { ...svc, id: 'b', lastViewed: null }] };
    await cache.save('o1', 'admin', withUse, fetched(t0));
    const got = (await cache.load('o1', 'admin'))!.data;
    expect(got.usageComplete).toBe(false);
    expect(got.services.map((s) => [s.lastViewed, s.numViews])).toEqual([[iso(t0), 585557], [null, undefined]]);
    await cache.save('o1', 'old', { ...data, services: [svc] }, fetched(t0));
    const old = (await cache.load('o1', 'old'))!.data;
    expect('lastViewed' in old.services[0]!).toBe(false);
    expect(old.usageComplete).toBeUndefined();
  });

  it('round-trips and expires after 7 days, discarding the entry', async () => {
    const store = new MemoryStore();
    let now = t0;
    const cache = new ScanCache(store, () => now);
    await cache.save('o1', 'admin', data, fetched(t0));
    now = at(CACHE_TTL_DAYS);
    expect((await cache.load('o1', 'admin'))?.data.org.id).toBe('o1');
    now = at(CACHE_TTL_DAYS + 0.01);
    expect(await cache.load('o1', 'admin')).toBeUndefined();
    expect(await store.keys()).toEqual([]);
  });

  it('keys per org and user', async () => {
    const cache = new ScanCache(new MemoryStore(), () => t0);
    await cache.save('o1', 'admin', data, fetched(t0));
    expect(await cache.load('o1', 'other')).toBeUndefined();
    expect(await cache.load('o2', 'admin')).toBeUndefined();
    expect(await cache.load('o1', 'admin')).toBeDefined();
  });

  it('never stores owner emails, and leaves the input untouched', async () => {
    const store = new MemoryStore();
    const cache = new ScanCache(store, () => t0);
    await cache.save('o1', 'admin', data, fetched(t0));
    const raw = JSON.stringify(await store.get((await store.keys())[0]!));
    expect(raw).not.toContain('amy@example.com');
    expect(raw).not.toContain('"email"');
    expect(data.owners[0]!.email).toBe('amy@example.com');
  });
});

describe('staleness', () => {
  it('words the age of the oldest part', () => {
    const f = { ...fetched(at(3)), usage: iso(at(1)) };
    expect(staleness({ fetchedAt: f }, at(4))).toBe('from your last scan, 3 days ago');
    expect(staleness({ fetchedAt: fetched(at(3)) }, at(4))).toBe('from your last scan, 1 day ago');
    expect(staleness({ fetchedAt: fetched(at(4)) }, at(4))).toBe('from your last scan, today');
  });
});

describe('depsToRecheck', () => {
  it('returns only items modified after the cached fetch', () => {
    const items = [
      { id: 'old', modified: iso(at(1)) },
      { id: 'same', modified: iso(at(2)) },
      { id: 'new', modified: iso(at(3)) },
    ];
    expect(depsToRecheck({ fetchedAt: iso(at(2)) }, items).map((i) => i.id)).toEqual(['new']);
  });
});

describe('partial scans (DC-053)', () => {
  it('saves and loads the per-map read times and the incomplete marker', async () => {
    const cache = new ScanCache(new MemoryStore(), () => t0);
    await cache.save('o1', 'admin', data, fetched(t0), { depsReadAt: { m1: iso(t0) }, incomplete: { unmeasured: 3, deps: true } });
    const e = await cache.load('o1', 'admin');
    expect(e?.depsReadAt).toEqual({ m1: iso(t0) });
    expect(e?.incomplete).toEqual({ unmeasured: 3, deps: true });
    await cache.save('o1', 'admin', data, fetched(t0));
    expect((await cache.load('o1', 'admin'))?.incomplete).toBeUndefined();
  });

  it('mapsToRead: never-read maps, and maps changed since they were read; falls back to fetchedAt without readAt', () => {
    const items = [
      { id: 'read-unchanged', modified: iso(at(1)) },
      { id: 'read-changed', modified: iso(at(3)) },
      { id: 'never-read', modified: iso(at(0)) },
    ];
    const readAt = { 'read-unchanged': iso(at(2)), 'read-changed': iso(at(2)) };
    expect(mapsToRead({ fetchedAt: iso(at(5)), readAt }, items).map((i) => i.id)).toEqual(['read-changed', 'never-read']);
    expect(mapsToRead({ fetchedAt: iso(at(2)) }, items).map((i) => i.id)).toEqual(['read-changed']);
  });

  it('sizesToReuse: measured before and not modified since; unknown or changed ones are measured again', () => {
    const svc = (id: string, sizeMB: number | null, modified: string) => ({ id, sizeMB, attachmentMB: 0, modified });
    const prev = { services: [svc('a', 5, iso(at(1))), svc('b', null, iso(at(1))), svc('c', 7, iso(at(1)))] } as unknown as Data;
    const cur = [svc('a', null, iso(at(1))), svc('b', null, iso(at(1))), svc('c', null, iso(at(2))), svc('d', null, iso(at(1)))];
    expect([...sizesToReuse(cur, prev)]).toEqual([['a', { sizeMB: 5, attachmentMB: 0 }]]);
    expect(sizesToReuse(cur, undefined).size).toBe(0);
  });
});

describe('DC-105: the last full scan is kept with the entry', () => {
  it('saves and loads fullScan, and leaves it out when there is none', async () => {
    const cache = new ScanCache(new MemoryStore(), () => t0);
    await cache.save('o1', 'admin', data, fetched(t0), { fullScan: { ms: 90_000, items: 300 } });
    expect((await cache.load('o1', 'admin'))!.fullScan).toEqual({ ms: 90_000, items: 300 });
    await cache.save('o1', 'admin', data, fetched(t0));
    expect((await cache.load('o1', 'admin'))!.fullScan).toBeUndefined();
  });
});
