// DC-071a: the big-org engine end to end on small fixtures: everything starts at t=0, Web Scene is read, sizes come
// from owner listings, the shared limiter slows down on 429s, the stage model ends at 100%, depsChecked is honest.
import { describe, expect, it } from 'vitest';
import { REFERRER_QUERY, depsCheckedOf, scanCore, scanOrg } from './pipeline';
import { scanSession } from './session';
import type { RequestFn, ScanStages } from './types';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const DAY = 864e5;
const MB = 1048576;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const SVC = (name: string) => `https://services1.arcgis.com/X/arcgis/rest/services/${name}/FeatureServer`;
const NS = 30, NM = 20;
const sIds = Array.from({ length: NS }, (_, k) => hex(0xa000 + k));
const mIds = Array.from({ length: NM }, (_, k) => hex(0xb000 + k));
const owner = (k: number) => (k < 20 ? 'amy' : k < 28 ? 'bob' : `solo${k}`);
const services = sIds.map((id, k) => ({
  id, owner: owner(k), title: `S${k}`, size: -1, access: 'private', created: NOW - 900 * DAY, modified: NOW - 800 * DAY,
  url: SVC(`S${k}`), type: 'Feature Service', typeKeywords: ['Hosted Service'],
}));
const maps = mIds.map((id, k) => ({ id, title: `M${k}`, type: k === 0 ? 'Web Scene' : 'Web Map', owner: 'carl', modified: NOW - (k + 1) * DAY }));

function fake(o: { rate429?: (path: string, n: number) => boolean; listings?: boolean } = {}) {
  const calls: { path: string; t: number }[] = [];
  let clock = 0, n = 0;
  const request: RequestFn = async (path, params = {}, opt = {}) => {
    calls.push({ path, t: clock++ });
    const k = n++;
    await new Promise((r) => setTimeout(r, path === 'portals/self/usage' ? 5 : 1));
    if (opt.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (o.rate429?.(path, k)) throw Object.assign(new Error('Too many requests'), { status: 429 });
    if (path === 'search') {
      const svc = String(params.q).includes('Feature Service');
      return { total: svc ? NS : NM, nextStart: -1, results: svc ? services : maps };
    }
    let m = /^content\/users\/([^/]+)$/.exec(path);
    if (m) {
      if (o.listings === false) throw Object.assign(new Error('no'), { status: 403 });
      return { total: 0, nextStart: -1, folders: [], items: services.filter((s) => s.owner === m![1]).map((s, i) => ({ ...s, size: (i + 1) * MB })) };
    }
    m = /^content\/items\/([0-9a-f]{32})$/.exec(path);
    if (m) return { ...services[sIds.indexOf(m[1] as string)], size: 7 * MB };
    m = /^content\/items\/([0-9a-f]{32})\/data$/.exec(path);
    if (m) { const k = mIds.indexOf(m[1] as string); return JSON.stringify({ operationalLayers: [{ itemId: sIds[k] }] }); }
    if (path === 'portals/self/usage') return { data: [] };
    if (path === 'portals/self/users') return { total: 3, nextStart: -1, users: [{ username: 'amy' }, { username: 'bob' }, { username: 'carl' }] };
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
}
const opts = { portal: 'https://www.arcgis.com', orgId: 'ORG', now: () => NOW, sleep: async () => {}, random: () => 0 };

describe('DC-071a engine', () => {
  it('starts usage, owners and the maps-and-apps listing together with find, before anything that needs the service list', async () => {
    const f = fake();
    await scanCore(f.request, opts);
    const first = f.calls.slice(0, 6).map((c) => c.path).sort();
    expect(first).toEqual(['portals/self/usage', 'portals/self/usage', 'portals/self/usage', 'portals/self/users', 'search', 'search']);
    // DC-147: the two second-year windows go out later, never ahead of find
    expect(f.calls.filter((c) => c.path === 'portals/self/usage')).toHaveLength(5);
  });

  it('reads Web Scenes as well as web maps and apps', async () => {
    expect(REFERRER_QUERY('ORG')).toContain('type:"Web Scene"');
    const r = await scanOrg(fake().request, opts);
    const s0 = r.data.services.find((s) => s.id === sIds[0]);
    expect(s0?.dependencies.map((d) => d.type)).toEqual(['Web Scene']);
  });

  it('sizes a small org from owner listings where they pay off, and one by one for the rest', async () => {
    const f = fake();
    const core = await scanCore(f.request, opts);
    const paths = f.calls.map((c) => c.path);
    expect(paths.filter((p) => p.startsWith('content/users/')).sort()).toEqual(['content/users/amy', 'content/users/bob']);
    expect(paths.filter((p) => /^content\/items\/[0-9a-f]{32}$/.test(p))).toHaveLength(2); // the two single-service owners
    expect(core.data.services.find((s) => s.id === sIds[1])?.sizeMB).toBe(2);
    expect(core.data.services.find((s) => s.id === sIds[29])?.sizeMB).toBe(7);
  });

  it('falls back to one call per service when listings are refused, with the same result', async () => {
    const f = fake({ listings: false });
    const core = await scanCore(f.request, opts);
    expect(f.calls.filter((c) => /^content\/items\/[0-9a-f]{32}$/.test(c.path))).toHaveLength(NS);
    expect(core.data.services.every((s) => s.sizeMB === 7)).toBe(true);
  });

  it('a burst of 429s slows the shared limiter down and the scan still completes', async () => {
    const stages: ScanStages[] = [];
    const f = fake({ rate429: (path, k) => path.endsWith('/data') && k % 3 === 0 });
    const r = await scanOrg(f.request, { ...opts, onStages: (s) => stages.push(s) });
    expect(r.depsKnown).toBe(true);
    const last = stages.at(-1) as ScanStages;
    expect(last.estimate.throttles).toBeGreaterThanOrEqual(1);
    expect(last).toMatchObject({ finished: true, percent: 100, readyToReview: true, current: null });
    expect(last.stages.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(last.stages[2]).toMatchObject({ done: NM, total: NM });
  });

  it('stage events: ready to review comes with the core, before maps and apps are done', async () => {
    const stages: ScanStages[] = [];
    await scanOrg(fake().request, { ...opts, onStages: (s) => stages.push(s) });
    const ready = stages.findIndex((s) => s.readyToReview);
    expect(ready).toBeGreaterThan(0);
    expect(stages[ready]?.stages[2]?.state).not.toBe('done');
    for (let k = 1; k < stages.length; k++) expect(stages[k]!.percent).toBeGreaterThanOrEqual(0);
  });
});

describe('depsChecked (FB-15)', () => {
  it('is true for every service once every map and app was read', async () => {
    const r = await scanOrg(fake().request, opts);
    expect(r.data.services.every(depsCheckedOf)).toBe(true);
  });

  it('is false for every service while maps and apps are being read, and after a stop; the result says the next scan resumes', async () => {
    const f = fake();
    const ctl = new AbortController();
    const seen: boolean[] = [];
    let reads = 0;
    const request: RequestFn = async (p, params, o) => {
      const res = await f.request(p, params, o);
      if (p.endsWith('/data') && ++reads === 5) ctl.abort();
      return res;
    };
    const out = await scanSession(request, { ...opts, signal: ctl.signal, renderMs: 0, onData: (d) => seen.push(d.services.some(depsCheckedOf)) });
    expect(out.stopped).toBe(true);
    expect(seen.every((x) => x === false)).toBe(true);
    expect(out.data.services.some(depsCheckedOf)).toBe(false);
    expect(out.resume?.mapsLeft).toBeGreaterThan(0);
    expect(out.resume!.mapsLeft).toBeLessThan(NM);
    expect(out.warnings.at(-1)).toMatch(/^Stopped with \d+ maps and apps still to check\. The next scan picks up where this one left off\.$/);
  });

  it('a complete session has no resume note', async () => {
    const out = await scanSession(fake().request, { ...opts, renderMs: 0 });
    expect(out.resume).toBeNull();
    expect(out.data.services.every(depsCheckedOf)).toBe(true);
    expect(out.warnings.some((w) => /picks up where/.test(w))).toBe(false);
  });
});
