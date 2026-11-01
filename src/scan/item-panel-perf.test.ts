// DC-147: what the item panel's data costs on a big org (the simulated org): requests per scan and scan time with 365 and
// 730 days of usage, the saved scan's size, and the time to build one panel's data (usage series + connections) over 200
// random families and for the family with the most connections. The 7,000 case runs with PERF=1:
//   PERF=1 npx vitest run src/scan/item-panel-perf.test.ts
// PERF_OUT=<file> also writes the table as JSON.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSimulatedOrg, seeded } from '../demo/simulated-org';
import { families } from '../domain/stale';
import { connectionsOf } from '../domain/connections';
import { usageContext, usageSeries } from '../domain/usage-series';
import type { Data, Family } from '../domain/types';
import { scanOrg } from './pipeline';
import type { RequestFn } from './types';

const NOW = Date.UTC(2026, 10, 1, 9, 30);
const PERF = !!process.env.PERF;
const SIZES = PERF ? [7000] : [1500];

function counted(request: RequestFn) {
  const calls = new Map<string, number>();
  const kind = (p: string) => (p.endsWith('/data') ? 'data' : p.split('/').pop() as string);
  const req: RequestFn = (path, params, o) => { const k = kind(path); calls.set(k, (calls.get(k) ?? 0) + 1); return request(path, params, o); };
  return { req, calls, total: () => [...calls.values()].reduce((a, b) => a + b, 0) };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number; };
const kb = (n: number) => Math.round(n / 1024);
const ms = (n: number) => Math.round(n * 1000) / 1000;

/** One panel's data, as opening it would build it: the whole family, both spans, and the connections. */
function panel(data: Data, f: Family): number {
  const ctx = usageContext(data);
  const a = usageSeries(f, ctx, { span: 365 });
  const b = usageSeries(f, ctx, { span: 730 });
  const c = connectionsOf(data, f, f.source.id);
  return a.days.length + b.days.length + c.direct.length;
}

describe.each(SIZES)('DC-147 item panel on a simulated org of %i services', (services) => {
  it('adds 2 usage requests, keeps the saved scan in bounds and builds a panel in well under a frame', async () => {
    const sim = { services, maps: Math.round(services * 3000 / 7000), now: () => NOW };
    const opts = { portal: 'https://sim.example', orgId: 'X', now: () => NOW, sleep: async () => {}, random: () => 0 };
    const rows: Record<string, unknown>[] = [];

    // 1. Requests and scan time (CPU only: the simulator answers on the next tick), 365 vs 730 days.
    const run = async (usageDays: number, speed: number) => {
      const c = counted(createSimulatedOrg({ ...sim, speed }).request);
      const t0 = performance.now();
      const r = await scanOrg(c.req, { ...opts, usageDays, sleep: undefined });
      return { r, c, ms: performance.now() - t0 };
    };
    const before = await run(365, 0), after = await run(730, 0);
    // With the simulator's latency model (usage calls take seconds) at 1/20 speed: does the core wait on the second year?
    const slowBefore = await run(365, 0.05), slowAfter = await run(730, 0.05);
    const usageCalls = (x: typeof before) => x.c.calls.get('usage') ?? 0;
    expect(usageCalls(after) - usageCalls(before)).toBe(2);
    expect(after.c.total() - before.c.total()).toBe(2);

    const d1 = before.r.data, d2 = after.r.data;
    const size = (d: Data) => JSON.stringify(d).length;
    const mapAppsSize = d2.mapApps ? JSON.stringify(d2.mapApps).length : 0;
    const buckets = (d: Data) => d.services.reduce((n, s) => n + s.usage.length, 0);
    rows.push(
      { measure: 'requests per scan', '365 days': before.c.total(), '730 days': after.c.total(), note: `usage ${usageCalls(before)} -> ${usageCalls(after)}` },
      { measure: 'scan wall time, CPU only (ms)', '365 days': Math.round(before.ms), '730 days': Math.round(after.ms) },
      { measure: 'scan wall time, latency x0.05 (ms)', '365 days': Math.round(slowBefore.ms), '730 days': Math.round(slowAfter.ms) },
      { measure: 'saved scan JSON (KB)', '365 days': kb(size(d1)), '730 days': kb(size(d2)), note: `of which mapApps ${kb(mapAppsSize)} KB` },
      { measure: 'usage buckets', '365 days': buckets(d1), '730 days': buckets(d2) },
    );
    expect(size(d2)).toBeLessThan(size(d1) * 2);

    // 2. One panel's data: 200 random families (p50, p95), the first open (context: sweep days over both years) and the worst family.
    const fams = families(d2);
    const t0 = performance.now();
    usageContext(d2);
    const ctxMs = performance.now() - t0;
    const rand = seeded(147);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const f = fams[Math.floor(rand() * fams.length)] as Family;
      const t = performance.now(); panel(d2, f); times.push(performance.now() - t);
    }
    const links = (f: Family) => { const c = connectionsOf(d2, f); return c.direct.length + c.throughMap.length; };
    const worst = fams.reduce((w, f) => (links(f) > links(w) ? f : w), fams[0] as Family);
    const wc = connectionsOf(d2, worst);
    const wt: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); panel(d2, worst); wt.push(performance.now() - t); }
    const throughFams = fams.filter((f) => connectionsOf(d2, f).throughMap.length > 0).length;
    rows.push(
      { measure: 'first panel: usage context (ms)', '730 days': ms(ctxMs), note: 'once per scan' },
      { measure: 'panel data p50 / p95 (ms, 200 families)', '730 days': `${ms(pct(times, 0.5))} / ${ms(pct(times, 0.95))}` },
      { measure: 'worst family: panel data p50 (ms)', '730 days': ms(pct(wt, 0.5)), note: `${worst.views.length + 1} layers, ${wc.counts.maps} maps, ${wc.counts.apps} apps, ${wc.counts.throughMap} through a map` },
      { measure: 'families with a through-a-map app', '730 days': throughFams, note: `of ${fams.length}` },
    );
    expect(pct(times, 0.95)).toBeLessThan(16);
    expect(throughFams).toBeGreaterThan(0);

    console.table(rows);
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify({ services, rows }, null, 2));
  }, 600_000);
});
