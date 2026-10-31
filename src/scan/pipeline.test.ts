import { describe, expect, it, vi } from 'vitest';
import { evaluate } from '../domain/stale';
import { BlockedRequest } from './guard';
import { SEARCH_CAP, mergeUsageWindow, scanOrg } from './pipeline';
import type { RequestFn, ScanProgress } from './types';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const DAY = 864e5;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const PARKS = hex(0xa1), PARKS_VIEW = hex(0xa2), ROADS = hex(0xa3), MAP1 = hex(0xb1), DASH = hex(0xb2), BROKEN = hex(0xb3);
const ORG = 'AbCdEfGh12345678';
const SVC = (name: string) => `https://services1.arcgis.com/X/arcgis/rest/services/${name}/FeatureServer`;

// Small hand-written fixtures, modelled on docs/research/agol-notify-usage.md.
const searchServices = [
  { id: PARKS, owner: 'alice', title: 'Parks', size: -1, access: 'org', created: NOW - 900 * DAY, modified: NOW - 400 * DAY, url: SVC('Parks'), typeKeywords: ['Hosted Service'], lastViewed: NOW - 3 * 3600_000, numViews: 585557 },
  { id: PARKS_VIEW, owner: 'alice', title: 'Parks public', size: -1, access: 'public', created: NOW - 800 * DAY, modified: NOW - 300 * DAY, url: SVC('Parks_View'), typeKeywords: ['Hosted Service', 'View Service'] },
  { id: ROADS, owner: 'carol', title: 'Roads', size: -1, access: 'private', created: NOW - 700 * DAY, modified: NOW - 200 * DAY, url: SVC('Roads'), typeKeywords: ['Hosted Service'], lastViewed: -1 },
];
const itemDetails: Record<string, object> = {
  [PARKS]: { ...searchServices[0], size: 2 * 1048576, description: '<p>Park assets</p>', snippet: 'Parks layer', tags: ['parks', 'assets'] },
  [PARKS_VIEW]: { ...searchServices[1], size: 4096, tags: [] },
  [ROADS]: { ...searchServices[2], size: 524288 },
};
const searchMaps = [
  { id: MAP1, title: 'Park map', type: 'Web Map', owner: 'alice' },
  { id: DASH, title: 'Roads board', type: 'Dashboard', owner: 'bob' },
  { id: BROKEN, title: 'Broken app', type: 'Form', owner: 'bob' },
];
const mapData: Record<string, string> = {
  [MAP1]: JSON.stringify({ operationalLayers: [{ itemId: PARKS, url: SVC('Parks') + '/0' }] }),
  [DASH]: JSON.stringify({ widgets: [{ url: SVC('ROADS').replace('ROADS', 'roads') + '/0' }] }),
};
const users = [
  { username: 'alice', fullName: 'Alice A', email: 'alice@example.org', role: 'org_publisher', disabled: false, thumbnail: 'a.png', lastLogin: 1 },
  { username: 'bob', fullName: 'Bob B', email: 'bob@example.org', disabled: true, thumbnail: null },
];
const usageWindow = (a: number, b: number) => ({
  data: [
    // Parks used 5 days ago (30 requests) and 200 days ago (7); name case differs from the url.
    { name: 'parks', num: [[NOW - 5 * DAY, '30'], [NOW - 200 * DAY, '7'], [NOW - 201 * DAY, '0']].filter(([t]) => (t as number) >= a && (t as number) <= b) },
    { name: 'Parks_View', num: [[NOW - 10 * DAY, '2']].filter(([t]) => (t as number) >= a && (t as number) <= b) },
  ],
});

interface Calls { path: string; params: Record<string, string | number>; method?: string }
function fakeOrg(over: Partial<Record<string, RequestFn>> = {}) {
  const calls: Calls[] = [];
  let inFlight = 0, maxInFlight = 0;
  const request: RequestFn = async (path, params = {}, options = {}) => {
    calls.push({ path, params, method: options.method });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const hook = over[path];
      if (hook) return await hook(path, params, options);
      if (path === 'search') {
        const q = String(params.q);
        return { total: q.includes('Feature Service') ? 3 : 3, nextStart: -1, results: q.includes('Feature Service') ? searchServices : searchMaps };
      }
      let m = /^content\/items\/([0-9a-f]{32})$/.exec(path);
      if (m) return itemDetails[m[1]];
      m = /^content\/items\/([0-9a-f]{32})\/relatedItems$/.exec(path);
      if (m) return { relatedItems: m[1] === PARKS_VIEW ? [{ id: PARKS }] : [] };
      m = /^content\/items\/([0-9a-f]{32})\/data$/.exec(path);
      if (m) { if (!(m[1] in mapData)) throw Object.assign(new Error('nope'), { status: 400 }); return mapData[m[1]]; }
      if (path === 'portals/self/usage') return usageWindow(Number(params.startTime), Number(params.endTime));
      if (path === 'portals/self/users') return { total: 2, nextStart: -1, users };
      throw new Error(`unexpected ${path}`);
    } finally { inFlight--; }
  };
  return { request, calls, maxInFlight: () => maxInFlight };
}
const opts = { portal: 'https://www.arcgis.com', orgId: ORG, now: () => NOW, sleep: async () => {}, random: () => 0 };
const find = (r: { data: { services: { id: string }[] } }, id: string) => r.data.services.find((s) => s.id === id) as ReturnType<typeof Object>;

describe('scanOrg mapping', () => {
  it('returns the domain Data shape with the org header', async () => {
    const { data } = await scanOrg(fakeOrg().request, { ...opts, orgName: 'Lakeside', urlKey: 'lakeside' });
    expect(data.org).toEqual({ id: ORG, name: 'Lakeside', urlKey: 'lakeside', scannedAt: '2026-10-10T00:00:00.000Z' });
    expect(data.services).toHaveLength(3);
  });

  it('converts sizes from bytes to MB and dates to ISO', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    const parks = find(r, PARKS) as unknown as { sizeMB: number; modified: string; created: string };
    expect(parks.sizeMB).toBe(2);
    expect(parks.modified).toBe(new Date(NOW - 400 * DAY).toISOString());
    expect(parks.created).toBe(new Date(NOW - 900 * DAY).toISOString());
    expect((find(r, ROADS) as unknown as { sizeMB: number }).sizeMB).toBe(0.5);
  });

  it('includes description, snippet and tags when present and omits them otherwise', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect(find(r, PARKS)).toMatchObject({ description: '<p>Park assets</p>', snippet: 'Parks layer', tags: ['parks', 'assets'] });
    const roads = find(r, ROADS);
    expect(roads).not.toHaveProperty('description');
    expect(roads).not.toHaveProperty('snippet');
    expect(roads).not.toHaveProperty('tags');
  });

  it('keeps only the fields the domain needs on each service', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect(Object.keys(find(r, ROADS)).sort()).toEqual(['access', 'attachmentMB', 'created', 'dependencies', 'depsChecked', 'id','isView', 'lastViewed', 'modified', 'owner', 'sizeMB', 'sourceId', 'title', 'usage']);
  });

  it('DC-083: keeps lastViewed (ISO, or null when blank) and numViews from the search row', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect(find(r, PARKS)).toMatchObject({ lastViewed: new Date(NOW - 3 * 3600_000).toISOString(), numViews: 585557 });
    expect(find(r, ROADS)).toMatchObject({ lastViewed: null });
    expect(find(r, ROADS)).not.toHaveProperty('numViews');
    expect(find(r, PARKS_VIEW)).toMatchObject({ lastViewed: null }); // the field is missing: blank
    expect(r.data.usageComplete).toBe(true);
  });

  it('maps owners with disabled, fullName, email and a thumbnail url, and no lastLogin', async () => {
    const { data } = await scanOrg(fakeOrg().request, opts);
    const alice = data.owners.find((o) => o.username === 'alice');
    expect(alice).toEqual({
      username: 'alice', fullName: 'Alice A', email: 'alice@example.org', role: 'org_publisher', disabled: false,
      thumbnail: 'https://www.arcgis.com/sharing/rest/community/users/alice/info/a.png', lastNotified: null,
    });
    expect(data.owners.find((o) => o.username === 'bob')).toMatchObject({ disabled: true, thumbnail: null });
    expect(JSON.stringify(data.owners)).not.toContain('lastLogin');
  });

  it('adds a disabled placeholder for an owner missing from the user list, with a warning', async () => {
    const { data, warnings } = await scanOrg(fakeOrg().request, opts);
    const carol = data.owners.find((o) => o.username === 'carol');
    expect(carol).toMatchObject({ disabled: true, fullName: 'carol', thumbnail: null });
    expect(warnings.some((w) => w.includes('carol'))).toBe(true);
  });

  it('produces data the domain can evaluate', async () => {
    const { data } = await scanOrg(fakeOrg().request, opts);
    const ev = evaluate(data, { minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 5 });
    expect(ev.totals.families + ev.totals.unreachableFamilies).toBeGreaterThan(0);
  });
});

describe('views', () => {
  it('sets isView and sourceId from relatedItems (reverse)', async () => {
    const f = fakeOrg();
    const r = await scanOrg(f.request, opts);
    expect(find(r, PARKS_VIEW)).toMatchObject({ isView: true, sourceId: PARKS });
    expect(find(r, PARKS)).toMatchObject({ isView: false, sourceId: null });
    const rel = f.calls.filter((c) => c.path.endsWith('/relatedItems'));
    expect(rel).toHaveLength(1);
    expect(rel[0].params).toMatchObject({ relationshipType: 'Service2Service', direction: 'reverse' });
  });

  it('leaves sourceId null when the lookup fails, without failing the scan', async () => {
    const f = fakeOrg({ [`content/items/${PARKS_VIEW}/relatedItems`]: async () => { throw Object.assign(new Error('x'), { status: 400 }); } });
    const r = await scanOrg(f.request, opts);
    expect(find(r, PARKS_VIEW)).toMatchObject({ isView: true, sourceId: null });
  });

  it('retries a failed source lookup once, and links the view when the retry works (user, 2026-10-23)', async () => {
    let n = 0;
    const f = fakeOrg({ [`content/items/${PARKS_VIEW}/relatedItems`]: async () => {
      n++; if (n === 1) throw Object.assign(new Error('x'), { status: 500 }); return { relatedItems: [{ id: PARKS }] };
    } });
    const r = await scanOrg(f.request, opts);
    expect(n).toBe(2);
    expect(find(r, PARKS_VIEW)).toMatchObject({ isView: true, sourceId: PARKS });
  });

  it('retries an empty lookup once too, and stops after that one retry', async () => {
    let n = 0;
    const f = fakeOrg({ [`content/items/${PARKS_VIEW}/relatedItems`]: async () => { n++; return { relatedItems: [] }; } });
    const r = await scanOrg(f.request, opts);
    expect(n).toBe(2);
    expect(find(r, PARKS_VIEW)).toMatchObject({ isView: true, sourceId: null });
  });
});

describe('usage', () => {
  it('matches by service name case-insensitively and returns sparse [daysAgo, requests]', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect((find(r, PARKS) as unknown as { usage: unknown }).usage).toEqual([[5, 30], [200, 7]]);
    expect((find(r, PARKS_VIEW) as unknown as { usage: unknown }).usage).toEqual([[10, 2]]);
  });

  it('drops zero days and gives an empty array for services with no usage', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect((find(r, ROADS) as unknown as { usage: unknown }).usage).toEqual([]);
  });

  it('asks for the whole org (no name) in 3 daily windows covering 365 days, via POST', async () => {
    const f = fakeOrg();
    await scanOrg(f.request, opts);
    const u = f.calls.filter((c) => c.path === 'portals/self/usage');
    expect(u).toHaveLength(3);
    for (const c of u) {
      expect(c.method).toBe('POST');
      expect(c.params).toMatchObject({ period: '1d', etype: 'svcusg', stype: 'features', groupby: 'name' });
      expect(c.params).not.toHaveProperty('name');
      expect(Number(c.params.endTime) - Number(c.params.startTime)).toBeLessThanOrEqual(150 * DAY);
    }
    expect(Math.min(...u.map((c) => Number(c.params.startTime)))).toBe(NOW - 365 * DAY);
    expect(Math.max(...u.map((c) => Number(c.params.endTime)))).toBe(NOW);
  });

  it('FB-29: a second, zero-filled entry with the same name in one window never wipes the real counts', async () => {
    // groupby=name returns a zero-filled series per name; two entries can share a name (case differs, or the same name
    // reported twice). The busy ABS layer lost every request in the newest window this way.
    const day = NOW - 5 * DAY;
    const f = fakeOrg({ 'portals/self/usage': async (_p, params) => (Number(params?.endTime) === NOW
      ? { data: [{ name: 'Parks', num: [[day, '30'], [day - DAY, '12']] }, { name: 'parks', num: [[day, '0'], [day - DAY, '0']] }] }
      : { data: [] }) });
    const r = await scanOrg(f.request, opts);
    expect((find(r, PARKS) as unknown as { usage: unknown }).usage).toEqual([[5, 30], [6, 12]]);
  });

  it('FB-29: two entries with the same name in one window add up', async () => {
    const day = NOW - 5 * DAY;
    const f = fakeOrg({ 'portals/self/usage': async (_p, params) => (Number(params?.endTime) === NOW
      ? { data: [{ name: 'Parks', num: [[day, '30']] }, { name: 'PARKS', num: [[day, '4']] }] }
      : { data: [] }) });
    const r = await scanOrg(f.request, opts);
    expect((find(r, PARKS) as unknown as { usage: unknown }).usage).toEqual([[5, 34]]);
  });

  it('does not double count a day that sits on a window edge', async () => {
    const edge = NOW - 150 * DAY;
    const f = fakeOrg({ 'portals/self/usage': async () => ({ data: [{ name: 'Parks', num: [[edge, '9']] }] }) });
    const r = await scanOrg(f.request, opts);
    expect((find(r, PARKS) as unknown as { usage: unknown }).usage).toEqual([[150, 9]]);
  });

  it('warns and carries on when a usage window fails', async () => {
    const f = fakeOrg({ 'portals/self/usage': async () => { throw Object.assign(new Error('bad'), { status: 400 }); } });
    const r = await scanOrg(f.request, opts);
    expect(r.warnings.some((w) => /usage/i.test(w))).toBe(true);
    expect((find(r, PARKS) as unknown as { usage: unknown }).usage).toEqual([]);
    expect(r.data.usageComplete).toBe(false);
  });

  it('DC-083: one failed window marks usage incomplete, so a layer with no lastViewed is never flagged', async () => {
    const f = fakeOrg({ 'portals/self/usage': async (_p, params) => {
      if (Number(params?.endTime) === NOW) throw Object.assign(new Error('bad'), { status: 400 });
      return usageWindow(Number(params?.startTime), Number(params?.endTime));
    } });
    const r = await scanOrg(f.request, opts);
    expect(r.data.usageComplete).toBe(false);
    const roads = evaluate(r.data, { minDaysSinceUse: 180, minDaysSinceUpdate: 0, maxUsedBy: 99 }).families.find((x) => x.source.id === ROADS);
    expect(roads).toBeUndefined();
  });
});

describe('dependencies', () => {
  it('finds item ids and service urls (any case) in the /data text', async () => {
    const r = await scanOrg(fakeOrg().request, opts);
    expect((find(r, PARKS) as unknown as { dependencies: unknown }).dependencies).toEqual([{ id: MAP1, title: 'Park map', type: 'Web Map', owner: 'alice' }]);
    expect((find(r, ROADS) as unknown as { dependencies: unknown }).dependencies).toEqual([{ id: DASH, title: 'Roads board', type: 'Dashboard', owner: 'bob' }]);
    expect((find(r, PARKS_VIEW) as unknown as { dependencies: unknown[] }).dependencies).toEqual([]);
  });

  it('does not match a longer service name that merely starts with the same letters', async () => {
    const f = fakeOrg({ [`content/items/${DASH}/data`]: async () => JSON.stringify({ url: SVC('Roads_old') + '/0' }) });
    const r = await scanOrg(f.request, opts);
    expect((find(r, ROADS) as unknown as { dependencies: unknown[] }).dependencies).toEqual([]);
  });

  it('counts each map once per service even when it mentions it many times', async () => {
    const f = fakeOrg({ [`content/items/${MAP1}/data`]: async () => `${PARKS} ${PARKS} ${SVC('Parks')}/0 ${SVC('Parks')}/1` });
    const r = await scanOrg(f.request, opts);
    expect((find(r, PARKS) as unknown as { dependencies: unknown[] }).dependencies).toHaveLength(1);
  });

  it('reads item /data as text, last, and skips unreadable items with a warning', async () => {
    const f = fakeOrg();
    const r = await scanOrg(f.request, opts);
    const idx = (p: string) => f.calls.findIndex((c) => c.path === p);
    expect(idx(`content/items/${MAP1}/data`)).toBeGreaterThan(idx('portals/self/users'));
    expect(r.warnings.some((w) => w.includes('1 map or app could not be read'))).toBe(true);
  });

  it('depsMode none makes no maps/apps calls', async () => {
    const f = fakeOrg();
    const r = await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(f.calls.some((c) => c.path.endsWith('/data'))).toBe(false);
    expect(f.calls.filter((c) => c.path === 'search')).toHaveLength(1);
    expect((find(r, PARKS) as unknown as { dependencies: unknown[] }).dependencies).toEqual([]);
  });

  it('depsMode sample:N reads at most N maps and apps', async () => {
    const f = fakeOrg();
    await scanOrg(f.request, { ...opts, depsMode: 'sample:1' });
    expect(f.calls.filter((c) => c.path.endsWith('/data'))).toHaveLength(1);
  });
});

describe('paging and concurrency', () => {
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
    id: hex(0x1000 + from + i), owner: 'alice', title: `S${from + i}`, size: -1, access: 'org', created: NOW, modified: NOW,
    url: SVC(`S${from + i}`), typeKeywords: ['Hosted Service'],
  }));
  /** A big org: `serviceTotal` reported by search, `available` actually reachable. */
  function bigOrg(serviceTotal: number, available: number, delayMs = 1) {
    const starts: number[] = [];
    let inFlight = 0, maxInFlight = 0;
    const request: RequestFn = async (path, params = {}) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); else await Promise.resolve();
        if (path === 'search') {
          if (!String(params.q).includes('Feature Service')) return { total: 0, nextStart: -1, results: [] };
          const s = Number(params.start);
          starts.push(s);
          const n = Math.max(0, Math.min(100, available - s + 1));
          return { total: serviceTotal, nextStart: s + 100 <= available ? s + 100 : -1, results: many(s, n) };
        }
        if (path === 'portals/self/users') return { total: 0, nextStart: -1, users: [] };
        if (path === 'portals/self/usage') return { data: [] };
        if (/^content\/items\/[0-9a-f]{32}$/.test(path)) return { size: 1048576, typeKeywords: ['Hosted Service'] };
        throw new Error(`unexpected ${path}`);
      } finally { inFlight--; }
    };
    return { request, starts, maxInFlight: () => maxInFlight };
  }

  it('pages the search 100 at a time following nextStart', async () => {
    const f = bigOrg(250, 250);
    const r = await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(f.starts).toEqual([1, 101, 201]);
    expect(r.data.services).toHaveLength(250);
    expect(r.warnings.some((w) => w.includes('10,000'))).toBe(false);
  });

  it('warns and stops paging near the 10,000 cap', async () => {
    const f = bigOrg(12000, 12000, 0);
    const r = await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(f.starts).toHaveLength(SEARCH_CAP / 100);
    expect(r.data.services).toHaveLength(SEARCH_CAP);
    expect(r.warnings.some((w) => w.includes('10,000'))).toBe(true);
  }, 60000);

  it('fetches item details through the shared limiter: never more than 12 in flight', async () => {
    const f = bigOrg(30, 30);
    await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(f.maxInFlight()).toBeGreaterThan(1);
    expect(f.maxInFlight()).toBeLessThanOrEqual(12);
  });

  it('DC-071a: asks for every search page at once after the first tells the total', async () => {
    const f = bigOrg(1000, 1000, 5);
    const r = await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(f.starts[0]).toBe(1);
    expect([...f.starts].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, k) => 1 + k * 100));
    expect(f.maxInFlight()).toBeGreaterThanOrEqual(6); // pages overlap (sequential paging would be 1 or 2)
    expect(r.data.services.map((s) => s.id)).toEqual(many(1, 1000).map((s) => s.id)); // page order kept
  });

  it('DC-071a: carries on page by page when the org grows while it reads', async () => {
    const f = bigOrg(250, 330);
    const r = await scanOrg(f.request, { ...opts, depsMode: 'none' });
    expect(r.data.services).toHaveLength(330);
    expect(new Set(r.data.services.map((s) => s.id)).size).toBe(330);
  });
});

describe('progress', () => {
  it('emits every phase with counts and human messages (phases overlap since DC-071a; maps and apps come last)', async () => {
    const events: ScanProgress[] = [];
    await scanOrg(fakeOrg().request, { ...opts, onProgress: (p) => events.push(p) });
    expect(new Set(events.map((e) => e.phase))).toEqual(new Set(['find', 'size', 'views', 'usage', 'owners', 'deps']));
    expect(events[0]?.phase).toBe('find');
    const firstRead = events.findIndex((e) => e.phase === 'deps' && /^Checking/.test(e.message));
    expect(events.slice(firstRead).every((e) => e.phase === 'deps')).toBe(true);
    expect(events.find((e) => e.phase === 'size' && e.done === 3)).toMatchObject({ total: 3, message: 'Measuring storage, 3 of 3' });
    // FB-19: the usage line counts date ranges read, not "range n of 3".
    expect(events.filter((e) => e.phase === 'usage').map((e) => e.message)).toEqual([1, 2, 3].map((n) => `Looking at when each was last used, ${n} of 3 date ranges read`));
    const last = events.filter((e) => e.phase === 'deps').at(-1);
    expect(last).toMatchObject({ done: 3, total: 3, message: 'Checking which maps use them, 3 of 3' });
    for (const e of events) expect(e.message).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe('backoff', () => {
  it('retries 429 then succeeds, sleeping with growing delays', async () => {
    let n = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const f = fakeOrg({ 'portals/self/users': async () => { if (n++ < 2) throw Object.assign(new Error('slow'), { status: 429 }); return { total: 2, nextStart: -1, users }; } });
    const r = await scanOrg(f.request, { ...opts, sleep });
    expect(n).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(r.data.owners.length).toBeGreaterThanOrEqual(2);
  });

  it('retries ArcGIS JSON error codes 498 and 5xx returned in the body', async () => {
    let n = 0;
    const f = fakeOrg({ 'portals/self/users': async () => (n++ < 1 ? { error: { code: 498, message: 'Invalid token' } } : { total: 2, nextStart: -1, users }) });
    const r = await scanOrg(f.request, opts);
    expect(n).toBe(2);
    expect(r.data.owners.length).toBeGreaterThanOrEqual(2);
  });

  it('honours retryAfter', async () => {
    let n = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const f = fakeOrg({ 'portals/self/users': async () => { if (n++ < 1) throw Object.assign(new Error('slow'), { status: 503, retryAfter: 7 }); return { total: 2, nextStart: -1, users }; } });
    await scanOrg(f.request, { ...opts, sleep });
    expect(sleep.mock.calls[0][0]).toBe(7000);
  });

  it('gives up after repeated failures and does not retry a plain 400', async () => {
    let n = 0;
    const f = fakeOrg({ 'portals/self/users': async () => { n++; throw Object.assign(new Error('always'), { status: 503 }); } });
    await expect(scanOrg(f.request, opts)).rejects.toThrow('always');
    expect(n).toBe(6);
    let m = 0;
    const g = fakeOrg({ 'portals/self/users': async () => { m++; throw Object.assign(new Error('bad request'), { status: 400 }); } });
    await expect(scanOrg(g.request, opts)).rejects.toThrow('bad request');
    expect(m).toBe(1);
  });

  it('does not spend minutes on an item whose /data answers 200 with a persistent error 500 in the body (DC-067)', async () => {
    let n = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const f = fakeOrg({ [`content/items/${BROKEN}/data`]: async () => { n++; return { error: { code: 500, message: 'Unable to read item data' } }; } });
    const r = await scanOrg(f.request, { ...opts, sleep });
    expect(n).toBe(2);
    expect(sleep.mock.calls.reduce((t, c) => t + c[0], 0)).toBeLessThan(3000);
    expect(r.warnings.some((w) => /could not be read/.test(w))).toBe(true);
  });

  it('treats an arcgis-rest-js error (numeric code 500, no status) as a body error, and "HTTP 503" as retryable transport', async () => {
    let n = 0, m = 0;
    const f = fakeOrg({
      [`content/items/${BROKEN}/data`]: async () => { n++; throw Object.assign(new Error('Unable to read'), { name: 'ArcGISRequestError', code: 500 }); },
      [`content/items/${DASH}/data`]: async () => { m++; throw Object.assign(new Error('Service Unavailable'), { name: 'ArcGISRequestError', code: 'HTTP 503' }); },
    });
    await scanOrg(f.request, opts);
    expect(n).toBe(2);
    expect(m).toBe(6);
  });

  it.each([400, 401, 403, 404])('never retries a %i or a body error %i', async (code) => {
    let n = 0, m = 0;
    const f = fakeOrg({
      [`content/items/${BROKEN}/data`]: async () => { n++; throw Object.assign(new Error('no access'), { status: code }); },
      [`content/items/${DASH}/data`]: async () => { m++; return { error: { code, message: 'no access' } }; },
    });
    await scanOrg(f.request, opts);
    expect(n).toBe(1);
    expect(m).toBe(1);
  });

  it('still retries HTTP 503 on a /data read up to the full budget', async () => {
    let n = 0;
    const f = fakeOrg({ [`content/items/${BROKEN}/data`]: async () => { n++; throw Object.assign(new Error('down'), { status: 503 }); } });
    await scanOrg(f.request, opts);
    expect(n).toBe(6);
  });
});

describe('abort', () => {
  it('rejects with AbortError when aborted before starting, making no calls', async () => {
    const f = fakeOrg();
    const ac = new AbortController(); ac.abort();
    await expect(scanOrg(f.request, { ...opts, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(0);
  });

  it('stops mid-scan when aborted from a progress callback', async () => {
    const f = fakeOrg();
    const ac = new AbortController();
    const p = scanOrg(f.request, { ...opts, signal: ac.signal, onProgress: (e) => { if (e.phase === 'find' && e.done > 0) ac.abort(); } });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls.some((c) => c.path.startsWith('content/'))).toBe(false); // no views, sizes or /data after the stop
  });

  it('interrupts a backoff sleep', async () => {
    const ac = new AbortController();
    const f = fakeOrg({ 'portals/self/users': async () => { throw Object.assign(new Error('slow'), { status: 429 }); } });
    const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((_, rej) => { ac.abort(); if (signal?.aborted) rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    await expect(scanOrg(f.request, { ...opts, signal: ac.signal, sleep })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('read-only guard in the pipeline', () => {
  it('only ever calls allow-listed read endpoints', async () => {
    const f = fakeOrg();
    await scanOrg(f.request, opts);
    const allowed = [/^search$/, /^content\/items\/[0-9a-f]{32}(\/data|\/relatedItems)?$/, /^portals\/self\/(usage|users)$/, /^content\/users\/[a-z]+$/];
    for (const c of f.calls) expect(allowed.some((re) => re.test(c.path)), c.path).toBe(true);
    expect(f.calls.every((c) => !/FeatureServer|services/.test(c.path))).toBe(true);
  });

  it('a malicious item id cannot turn a read into a write path or a service call', async () => {
    const evil = { ...searchServices[0], id: '../content/users/x/addItem' };
    const f = fakeOrg({ search: async (_p, params) => ({ total: 1, nextStart: -1, results: String(params?.q).includes('Feature Service') ? [evil] : [] }) });
    await expect(scanOrg(f.request, opts)).rejects.toBeInstanceOf(BlockedRequest);
    expect(f.calls.some((c) => c.path.includes('addItem'))).toBe(false);
  });
});

describe('DC-017: the app\'s own nudge log', () => {
  const LOG = hex(0xc1);
  const logItem = { id: LOG, owner: 'alice', title: 'Decluttering nudge log', size: -1, access: 'private', created: NOW - 900 * DAY, modified: NOW - 900 * DAY,
    url: SVC('Decluttering_nudge_log_0123abcd'), typeKeywords: ['Hosted Service'], tags: ['decluttering-nudge-log', 'Decluttering'] };
  it('is never listed as a service to tidy, and is not read beyond the search', async () => {
    const org = fakeOrg({
      search: async (_p, params) => {
        const q = String(params?.q);
        return q.includes('Feature Service') ? { total: 4, nextStart: -1, results: [...searchServices, logItem] } : { total: 3, nextStart: -1, results: searchMaps };
      },
    });
    const { data } = await scanOrg(org.request, opts);
    expect(data.services.map((s) => s.id)).not.toContain(LOG);
    expect(data.services).toHaveLength(3);
    expect(org.calls.some((c) => c.path.includes(LOG))).toBe(false);
  });
  it('a look-alike without the app tag is still scanned', async () => {
    const lookAlike = { ...logItem, tags: ['notes'] };
    const org = fakeOrg({
      search: async (_p, params) => String(params?.q).includes('Feature Service')
        ? { total: 4, nextStart: -1, results: [...searchServices, lookAlike] } : { total: 3, nextStart: -1, results: searchMaps },
      [`content/items/${LOG}`]: async () => ({ ...lookAlike, size: 1024 }),
    });
    const { data } = await scanOrg(org.request, opts);
    expect(data.services.map((s) => s.id)).toContain(LOG);
  });
});

describe('mergeUsageWindow (FB-29; also feeds the early dot map)', () => {
  it('adds same-name rows within a window and counts an edge day once across windows', () => {
    const into = new Map<string, Map<number, number>>();
    mergeUsageWindow(into, [{ name: 'abs', num: [[1, '10'], [2, '0']] }, { name: 'ABS', num: [[1, 0], [2, 0]] }]);
    mergeUsageWindow(into, [{ name: 'abs', num: [[2, 5], [3, 7]] }]);
    mergeUsageWindow(into, [{ name: 'abs', num: [[3, 7]] }]); // the next window repeats its edge day
    expect([...(into.get('abs') ?? [])]).toEqual([[1, 10], [2, 5], [3, 7]]);
  });
  it('skips rows without a name and junk timestamps', () => {
    const into = new Map<string, Map<number, number>>();
    mergeUsageWindow(into, [{ num: [[1, 1]] }, { name: 'x', num: [['nope', 3]] }]);
    expect([...into]).toEqual([['x', new Map()]]);
  });
});
