import { describe, expect, it } from 'vitest';
import { scanCore, scanDependencies, withDependencies } from './pipeline';
import type { DependencyBatch, RequestFn } from './types';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const DAY = 864e5;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const SVC = (name: string) => `https://services1.arcgis.com/X/arcgis/rest/services/${name}/FeatureServer`;
const PARKS = hex(0xa1), ROADS = hex(0xa3);
// 50 MB each: above every starting point's minimum size (DC-055), so both count as likely stale
const services = [
  { id: PARKS, owner: 'alice', title: 'Parks', size: 50 * 1024 * 1024, access: 'org', created: NOW - 900 * DAY, modified: NOW - 400 * DAY, url: SVC('Parks'), typeKeywords: ['Hosted Service'] },
  { id: ROADS, owner: 'carol', title: 'Roads', size: 50 * 1024 * 1024, access: 'org', created: NOW - 900 * DAY, modified: NOW - 400 * DAY, url: SVC('Roads'), typeKeywords: ['Hosted Service'] },
];
// 120 maps: owned by bob except one owned by alice (an owner of a stale candidate), modified 1..120 days ago.
const maps = Array.from({ length: 120 }, (_, i) => ({
  id: hex(0xb000 + i), title: `Map ${i}`, type: 'Web Map', owner: i === 100 ? 'alice' : 'bob', modified: NOW - (i + 1) * DAY,
}));
const refers = (i: number) => (i % 2 === 0 ? PARKS : ROADS);

function fake() {
  const calls: string[] = [];
  const request: RequestFn = async (path, params = {}) => {
    calls.push(path);
    await new Promise((r) => setTimeout(r, 0));
    if (path === 'search') {
      const q = String(params.q);
      return { total: 1, nextStart: -1, results: q.includes('Feature Service') ? services : maps };
    }
    let m = /^content\/items\/([0-9a-f]{32})$/.exec(path);
    if (m) return services.find((s) => s.id === m![1]);
    m = /^content\/items\/([0-9a-f]{32})\/data$/.exec(path);
    if (m) {
      const i = maps.findIndex((x) => x.id === m![1]);
      return JSON.stringify({ layer: refers(i) });
    }
    if (path === 'portals/self/usage') return { data: [] };
    if (path === 'portals/self/users') return { total: 3, nextStart: -1, users: [{ username: 'alice' }, { username: 'bob' }, { username: 'carol' }] };
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
}
const opts = { portal: 'https://www.arcgis.com', orgId: 'ORG', now: () => NOW, sleep: async () => {}, random: () => 0 };
const dataCalls = (calls: string[]) => calls.filter((c) => c.endsWith('/data'));

describe('scanCore', () => {
  it('finishes without reading any map or app /data, and leaves dependencies empty and unknown', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    expect(dataCalls(f.calls)).toHaveLength(0);
    expect(f.calls.filter((c) => c === 'search')).toHaveLength(2); // services, and only the first page of maps and apps (its total, for the estimate; DC-071a)
    expect(core.depsKnown).toBe(false);
    expect(core.data.services.every((s) => s.dependencies.length === 0)).toBe(true);
  });
});

describe('scanDependencies', () => {
  it('streams cumulative batches and ends with a final one covering everything', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const batches: DependencyBatch[] = [];
    const r = await scanDependencies(core, { batchSize: 50, onBatch: (b) => batches.push(b) });
    expect(batches.map((b) => b.done)).toEqual([50, 100, 120]);
    expect(batches.map((b) => b.final)).toEqual([false, false, true]);
    const sizes = batches.map((b) => b.dependencies.get(PARKS)?.length ?? 0);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(r.dependencies.get(PARKS)).toHaveLength(60);
    expect(r.dependencies.get(ROADS)).toHaveLength(60);
    expect(withDependencies(core.data, r.dependencies).services[0]!.dependencies).toHaveLength(60);
  });

  it('reads maps owned by owners of likely-stale services first, then newest first', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const order: string[] = [];
    await scanDependencies(core, { batchSize: 1000, onBatch: () => {} });
    for (const c of dataCalls(f.calls)) order.push(c.split('/')[2]!);
    expect(order[0]).toBe(maps[100]!.id); // alice's map jumps the queue
    expect(order.slice(1, 4)).toEqual([maps[0]!.id, maps[1]!.id, maps[2]!.id]);
  });

  it('a stop between batches keeps what was read (stopped: true) instead of throwing (DC-053)', async () => {
    const f = fake();
    const ctl = new AbortController();
    const core = await scanCore(f.request, opts);
    const r = await scanDependencies(core, { batchSize: 10, signal: ctl.signal, onBatch: (b) => { if (b.done >= 20) ctl.abort(); } });
    expect(r.stopped).toBe(true);
    expect(dataCalls(f.calls).length).toBeLessThan(120);
    expect(Object.keys(r.readAt)).toHaveLength(r.read);
    expect(r.read).toBe(dataCalls(f.calls).length);
    expect(r.dependencies.size).toBeGreaterThan(0);
  });

  it('resumes a stopped scan: reads only the maps it never read, and keeps the links it found', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const full = await scanDependencies(core);
    const ctl = new AbortController();
    const part = await scanDependencies(core, { batchSize: 10, signal: ctl.signal, onBatch: (b) => { if (b.done >= 30) ctl.abort(); } });
    expect(part.stopped).toBe(true);
    const previous = { fetchedAt: core.data.org.scannedAt, data: withDependencies(core.data, part.dependencies), readAt: part.readAt };
    f.calls.length = 0;
    const resumed = await scanDependencies(core, { previous });
    expect(resumed.stopped).toBe(false);
    expect(dataCalls(f.calls)).toHaveLength(120 - part.read);
    expect(resumed.reused).toBe(part.read);
    const ids = (m: Map<string, { id: string }[]>, k: string) => (m.get(k) ?? []).map((d) => d.id).sort();
    expect(ids(resumed.dependencies, PARKS)).toEqual(ids(full.dependencies, PARKS));
    expect(ids(resumed.dependencies, ROADS)).toEqual(ids(full.dependencies, ROADS));
    expect(Object.keys(resumed.readAt)).toHaveLength(120);
  });

  it('with a previous scan, re-reads only maps modified since then and keeps the rest', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const full = await scanDependencies(core);
    const previous = { fetchedAt: new Date(NOW - 3.5 * DAY).toISOString(), data: withDependencies(core.data, full.dependencies) };
    f.calls.length = 0;
    const core2 = await scanCore(f.request, opts);
    f.calls.length = 0;
    const batches: DependencyBatch[] = [];
    const r = await scanDependencies(core2, { previous, onBatch: (b) => batches.push(b) });
    expect(dataCalls(f.calls)).toHaveLength(3); // modified 1, 2, 3 days ago
    expect(r.read).toBe(3);
    expect(r.reused).toBe(117);
    expect(r.dependencies.get(PARKS)).toHaveLength(60);
    expect(batches[0]!.done).toBe(117); // the reused links show up straight away
  });

  it('DC-147c: a reused map takes its date and status from the current search row, even from a scan saved without them', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const full = await scanDependencies(core);
    // A scan saved before DC-147c: no dates or statuses on its links.
    const bare = new Map([...full.dependencies].map(([k, v]) => [k, v.map(({ id, title, type, owner }) => ({ id, title, type, owner }))]));
    const previous = { fetchedAt: new Date(NOW - 3.5 * DAY).toISOString(), data: withDependencies(core.data, bare) };
    const core2 = await scanCore(f.request, opts);
    const r = await scanDependencies(core2, { previous });
    expect(r.reused).toBe(117);
    const deps = r.dependencies.get(PARKS) ?? [];
    expect(deps.length).toBe(60);
    expect(deps.every((d) => typeof d.modified === 'string')).toBe(true);
  });

  it('depsMode none reads nothing', async () => {
    const f = fake();
    const core = await scanCore(f.request, { ...opts, depsMode: 'none' });
    await scanDependencies(core);
    expect(f.calls.filter((c) => c === 'search')).toHaveLength(1);
  });
});
