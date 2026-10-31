// DC-134: what pricing attachments separately costs on a big org (1,500 and 7,000 services, the simulated org), measured
// against the same org with no attachment figures. Requests, the one-off re-measure after the upgrade, scoring time and
// the saved scan's size. The 7,000 case and the timing repeats run with PERF=1 (about 2 minutes on a 4-core laptop);
// PERF_OUT=<file> writes the table: PERF=1 PERF_OUT=perf.json npx vitest run src/scan/attachments-perf.test.ts
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSimulatedOrg } from '../demo/simulated-org';
import { ScanCache, type CacheEntry } from '../cache/scanCache';
import { MemoryStore } from '../cache/store';
import { allRows, evaluate, PRESETS } from '../domain/stale';
import type { Data } from '../domain/types';
import { scanSession } from './session';
import type { RequestFn } from './types';

const NOW = Date.UTC(2026, 9, 10, 9);
const kindOf = (p: string) =>
  /^content\/items\/[0-9a-f]{32}$/.test(p) ? 'item' : /^content\/users\//.test(p) ? 'listing' : p.endsWith('/data') ? 'map' : p.split('/').pop() as string;

function counted(request: RequestFn) {
  const calls = new Map<string, number>();
  const req: RequestFn = (path, params, o) => { const k = kindOf(path); calls.set(k, (calls.get(k) ?? 0) + 1); return request(path, params, o); };
  const sizing = () => (calls.get('item') ?? 0) + (calls.get('listing') ?? 0);
  const total = () => [...calls.values()].reduce((a, b) => a + b, 0);
  return { req, calls, sizing, total, reset: () => calls.clear() };
}

function cacheFor() {
  const cache = new ScanCache(new MemoryStore(), () => new Date(NOW));
  return {
    save: (d: Data, f: Parameters<ScanCache['save']>[3], x: Parameters<ScanCache['save']>[4]) => cache.save('SIM', 'admin', d, f, x),
    load: () => cache.load('SIM', 'admin') as Promise<CacheEntry>,
  };
}

const base = { portal: 'https://sim.example', orgId: 'X', now: () => NOW, sleep: async () => {}, random: () => 0, renderMs: 0 };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] as number;
function timeIt(f: () => unknown, runs = 7): number {
  f(); // warm
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); }
  return median(t);
}
/** A cached scan from before DC-134: sizes without their attachment figures. */
const legacy = (e: CacheEntry): CacheEntry =>
  ({ ...e, data: { ...e.data, services: e.data.services.map(({ attachmentMB: _drop, ...s }) => s) } });

const report: Record<string, unknown>[] = [];

const PERF = !!process.env.PERF;
const SIZES = PERF ? [1500, 7000] : [1500];

describe.each(SIZES)('DC-134 on a simulated org of %i services', (services) => {
  it('adds no requests, re-measures sizes once after the upgrade, and keeps scoring time and the saved scan in bounds', async () => {
    const sim = { speed: 0, services, maps: 400, now: () => NOW };

    // 1. A cold scan of the same org, with and without attachments: the same requests (subInfo rides on the size calls).
    const plain = counted(createSimulatedOrg({ ...sim, attachmentShare: 0 }).request);
    const withAtt = counted(createSimulatedOrg(sim).request);
    const c = cacheFor();
    const t0 = performance.now();
    await scanSession(plain.req, { ...base });
    let tPlain = performance.now() - t0;
    const t1 = performance.now();
    const cold = await scanSession(withAtt.req, { ...base, save: c.save });
    let tAtt = performance.now() - t1;
    if (PERF) {
      // Timing only: the other order, keeping each side's best, so warm-up and GC don't favour either.
      const a = createSimulatedOrg(sim).request, p = createSimulatedOrg({ ...sim, attachmentShare: 0 }).request;
      let t = performance.now(); await scanSession(a, { ...base }); tAtt = Math.min(tAtt, performance.now() - t);
      t = performance.now(); await scanSession(p, { ...base }); tPlain = Math.min(tPlain, performance.now() - t);
    }
    expect(Object.fromEntries(withAtt.calls)).toEqual(Object.fromEntries(plain.calls));
    const attached = cold.data.services.filter((s) => (s.attachmentMB ?? 0) > 0).length;
    expect(attached).toBeGreaterThan(services * 0.08);

    // 2. Rescans. A cache saved after DC-134 reuses every size. One saved before shows its sizes at once (nothing
    // unmeasured when the review opens) and refreshes the sources' attachments in the background, once, views skipped.
    const saved = await c.load();
    withAtt.reset();
    await scanSession(withAtt.req, { ...base, previous: saved });
    const reuseCalls = withAtt.sizing();
    withAtt.reset();
    const firstUnmeasured: number[] = [];
    const upgraded = await scanSession(withAtt.req, { ...base, previous: legacy(saved), onData: (_d, st) => firstUnmeasured.push(st.unmeasured) });
    const upgradeCalls = withAtt.sizing();
    const coldCalls = (plain.calls.get('item') ?? 0) + (plain.calls.get('listing') ?? 0);
    expect(reuseCalls).toBe(0);
    expect(firstUnmeasured[0]).toBe(0);
    expect(upgradeCalls).toBeGreaterThan(0);
    expect(upgradeCalls).toBeLessThanOrEqual(coldCalls);
    expect(upgraded.data.services.filter((s) => !s.isView && s.attachmentMB === undefined)).toHaveLength(0);

    // 3. Scoring: every row and the review's evaluate, with and without attachment figures on the same data.
    const data = cold.data;
    const bare = legacy(saved).data;
    const t = PRESETS.balanced;
    // Fresh copies per run, so the per-Data memo never answers from a previous run.
    const fresh = (d: Data) => () => evaluate({ ...d, services: [...d.services] }, t);
    const evalAtt = timeIt(fresh(data)), evalBare = timeIt(fresh(bare));
    expect(evalAtt).toBeLessThan(evalBare * 1.5 + 5);

    // 4. The saved scan grows by one small number per service.
    const bytesAtt = JSON.stringify(data).length, bytesBare = JSON.stringify(bare).length;
    expect(bytesAtt / bytesBare).toBeLessThan(1.05);

    // 5. What it changes: the same families, priced correctly.
    const rows = allRows(data, t), rowsBare = allRows(bare, t);
    const stale = rows.filter((r) => r.stale).length;
    expect(stale).toBe(rowsBare.filter((r) => r.stale).length); // nobody is hidden by the change
    const credits = evaluate(data, t).totals.credits, creditsBare = evaluate(bare, t).totals.credits;
    expect(credits).toBeLessThan(creditsBare);

    report.push({
      services, withAttachments: attached, requests: withAtt.total() && plain.total(), extraRequests: 0,
      'scan ms (plain / att)': `${Math.round(tPlain)} / ${Math.round(tAtt)}`,
      'size calls: cold / rescan / first after upgrade (background)': `${coldCalls} / ${reuseCalls} / ${upgradeCalls}`,
      'evaluate ms (bare / att)': `${evalBare.toFixed(1)} / ${evalAtt.toFixed(1)}`,
      'saved scan KB (bare / att)': `${Math.round(bytesBare / 1024)} / ${Math.round(bytesAtt / 1024)}`,
      'stale credits/month (old / new)': `${Math.round(creditsBare)} / ${Math.round(credits)}`,
      staleFamilies: stale,
    });
  }, 300_000);
});

describe('report', () => {
  it('prints the table', () => { if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(report, null, 1)); expect(report.length).toBe(SIZES.length); });
});
