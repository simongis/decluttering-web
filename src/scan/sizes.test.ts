// DC-053: big orgs skip sizing in the core; scanSizes measures afterwards, likely-stale first, and can be stopped.
import { describe, expect, it } from 'vitest';
import { LAZY_SIZE_THRESHOLD, scanCore, scanOrg, scanSizes, sizeOrder, withSizes } from './pipeline';
import type { RequestFn, SizeBatch } from './types';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const DAY = 864e5;
const MB = 1048576;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const SVC = (name: string) => `https://services1.arcgis.com/X/arcgis/rest/services/${name}/FeatureServer`;

// Service k: even k are old and unused (likely stale), odd k were updated last week (not stale). k % 10 === 9 is an old view of k - 1.
const N = 40;
const ids = Array.from({ length: N }, (_, k) => hex(0xc000 + k));
const isView = (k: number) => k % 10 === 9;
const services = ids.map((id, k) => ({
  id, owner: 'alice', title: `S${k}`, size: -1, access: 'private', created: NOW - 900 * DAY,
  modified: k % 2 === 0 || isView(k) ? NOW - 800 * DAY : NOW - 7 * DAY, url: SVC(`S${k}`),
  typeKeywords: isView(k) ? ['Hosted Service', 'View Service'] : ['Hosted Service'],
}));

function fake() {
  const calls: string[] = [];
  const request: RequestFn = async (path, params = {}) => {
    calls.push(path);
    await new Promise((r) => setTimeout(r, 0));
    if (path === 'search') {
      const q = String(params.q);
      return { total: q.includes('Feature Service') ? N : 0, nextStart: -1, results: q.includes('Feature Service') ? services : [] };
    }
    let m = /^content\/items\/([0-9a-f]{32})$/.exec(path);
    if (m) {
      const k = ids.indexOf(m[1]);
      return { ...services[k], size: (k + 1) * MB, description: `About S${k}`, tags: ['t'] };
    }
    m = /^content\/items\/([0-9a-f]{32})\/relatedItems$/.exec(path);
    if (m) { const k = ids.indexOf(m[1]); return { relatedItems: [{ id: ids[k - 1] }] }; }
    if (path === 'portals/self/usage') return { data: [] };
    if (path === 'portals/self/users') return { total: 1, nextStart: -1, users: [{ username: 'alice', fullName: 'Alice' }] };
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
}
const opts = { portal: 'https://www.arcgis.com', orgId: 'ORG', now: () => NOW, sleep: async () => {}, random: () => 0, depsMode: 'none' as const };
const sizeCalls = (calls: string[]) => calls.filter((c) => /^content\/items\/[0-9a-f]{32}$/.test(c));

describe('lazy sizing threshold', () => {
  it('starts at 150 services', () => { expect(LAZY_SIZE_THRESHOLD).toBe(150); });

  it('at or below the threshold the core measures every service as before', async () => {
    const f = fake();
    const core = await scanCore(f.request, { ...opts, lazySizeThreshold: N });
    expect(core.sizesPending).toBe(false);
    expect(sizeCalls(f.calls)).toHaveLength(N);
    expect(core.data.services.every((s) => typeof s.sizeMB === 'number')).toBe(true);
  });

  it('above the threshold the core makes no size calls and every size is unknown (null)', async () => {
    const f = fake();
    const core = await scanCore(f.request, { ...opts, lazySizeThreshold: 10 });
    expect(core.sizesPending).toBe(true);
    expect(sizeCalls(f.calls)).toHaveLength(0);
    expect(core.data.services.every((s) => s.sizeMB === null)).toBe(true);
    expect(core.warnings.some((w) => w.includes('size'))).toBe(false);
    // views are still found from the search's type keywords
    expect(core.data.services.filter((s) => s.isView)).toHaveLength(4);
  });
});

describe('sizeOrder', () => {
  it('likely-stale sources first, then other sources, then views; skips sizes already known', async () => {
    const core = await scanCore(fake().request, { ...opts, lazySizeThreshold: 10 });
    const known = withSizes(core.data, new Map([[ids[0] as string, { sizeMB: 5, attachmentMB: 0 }]]));
    const order = sizeOrder(known).map((id) => ids.indexOf(id));
    const stale = order.filter((k) => k % 2 === 0 && !isView(k));
    const rest = order.filter((k) => k % 2 === 1 && !isView(k));
    const views = order.filter((k) => isView(k));
    expect(order).toEqual([...stale, ...rest, ...views]);
    expect(stale[0]).toBe(2); // 0 is already measured
    expect(order).not.toContain(0);
    expect(views).toEqual([9, 19, 29, 39]);
  });
});

describe('scanSizes', () => {
  it('measures in priority order and streams cumulative batches', async () => {
    const f = fake();
    const core = await scanCore(f.request, { ...opts, lazySizeThreshold: 10 });
    f.calls.length = 0;
    const batches: SizeBatch[] = [];
    const r = await scanSizes(core, { batchSize: 8, onSizes: (b) => batches.push(b) });
    expect(r.stopped).toBe(false);
    expect(r.missing).toBe(0);
    expect(r.sizes.size).toBe(N);
    expect(batches.map((b) => b.sizes.size)).toEqual([8, 16, 24, 32, 40]);
    expect(batches.at(-1)?.final).toBe(true);
    // the first batch is all likely-stale sources
    const first = sizeCalls(f.calls).slice(0, 8).map((p) => ids.indexOf(p.slice(-32)));
    expect(first.every((k) => k % 2 === 0 && !isView(k))).toBe(true);
    const data = withSizes(core.data, r.sizes);
    const s3 = data.services.find((s) => s.id === ids[3]);
    expect(s3?.sizeMB).toBe(4);
    expect(s3?.description).toBe('About S3');
  });

  it('a stop resolves with what was measured (stopped: true), leaving the rest unknown', async () => {
    const f = fake();
    const core = await scanCore(f.request, { ...opts, lazySizeThreshold: 10 });
    const ctl = new AbortController();
    const r = await scanSizes(core, { batchSize: 8, signal: ctl.signal, onSizes: (b) => { if (b.done >= 16) ctl.abort(); } });
    expect(r.stopped).toBe(true);
    // Calls already in flight when Stop is pressed still land and are kept (DC-071a); nothing new is sent.
    expect(r.sizes.size).toBeGreaterThanOrEqual(16);
    expect(r.sizes.size).toBeLessThan(N);
    expect(r.missing).toBe(N - r.sizes.size);
    const data = withSizes(core.data, r.sizes);
    expect(data.services.filter((s) => s.sizeMB === null)).toHaveLength(r.missing);
  });

  it('an unreadable item stays unknown, with a warning that says so', async () => {
    const f = fake();
    const bad = ids[2] as string;
    const request: RequestFn = async (path, params, o) => {
      if (path === `content/items/${bad}`) throw Object.assign(new Error('nope'), { status: 400 });
      return f.request(path, params, o);
    };
    const core = await scanCore(request, { ...opts, lazySizeThreshold: 10 });
    const r = await scanSizes(core);
    expect(r.missing).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 service; they show as not measured/);
  });

  it('scanOrg on a big org returns every size measured', async () => {
    const r = await scanOrg(fake().request, { ...opts, lazySizeThreshold: 10 });
    expect(r.data.services.every((s) => typeof s.sizeMB === 'number')).toBe(true);
  });
});
