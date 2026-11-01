// DC-147c: the row's 12 monthly bars on a shared, compressed scale. Test-first.
import { describe, expect, it } from 'vitest';
import type { Data, Family, Service } from './types';
import { families } from './stale';
import { SWEEP_HEAVY_REQUESTS } from './sweep';
import { usageContext, usageSeries } from './usage-series';
import { BAR_MIN_PX, barHeight, listTop, p95, rowBars } from './usage-bars';

const SCAN = '2026-11-01T09:30:00Z';

let n = 0;
const svc = (o: Partial<Service> = {}): Service => ({
  id: `s${++n}`, title: `Layer ${n}`, owner: 'owner', created: '2020-01-01T00:00:00Z', modified: '2021-01-01T00:00:00Z', sizeMB: 30,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const mk = (services: Service[], extra: Partial<Data> = {}): Data => ({
  org: { id: 'o1', name: 'Org', urlKey: 'org', scannedAt: SCAN },
  owners: [{ username: 'owner', fullName: 'Owner', disabled: false, thumbnail: null, lastNotified: null }],
  services, usageDays: 730, ...extra,
});
const famOf = (d: Data, id: string): Family => families(d).find((f) => f.id === id) as Family;
const sweepFiller = (days: number[]) => Array.from({ length: 60 }, () => svc({ usage: days.map((x): [number, number] => [x, 1]) }));

describe('p95 (nearest rank over the non-zero values)', () => {
  it('is 0 with nothing to rank, ignores zeros, and is the value itself for one value', () => {
    expect(p95([])).toBe(0);
    expect(p95([0, 0])).toBe(0);
    expect(p95([7, 0])).toBe(7);
  });
  it('takes the ceil(0.95 n)th smallest value', () => {
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95(Array.from({ length: 20 }, (_, i) => 20 - i))).toBe(19);
    // One huge month does not set the top.
    expect(p95([...Array.from({ length: 40 }, () => 10), 1_000_000])).toBe(10);
  });
});

describe('barHeight (log1p compressed, capped at the top, at least 2 px)', () => {
  it('draws nothing for no requests', () => {
    expect(barHeight(0, 100, 22)).toEqual({ h: 0, capped: false });
  });
  it('fills the height at the top and is capped above it', () => {
    expect(barHeight(100, 100, 22)).toEqual({ h: 22, capped: false });
    expect(barHeight(5000, 100, 22)).toEqual({ h: 22, capped: true });
  });
  it('is log-compressed, so low usage still has height', () => {
    const one = barHeight(1, 1000, 22).h;
    expect(one).toBeCloseTo(22 * Math.log1p(1) / Math.log1p(1000), 6);
    expect(barHeight(31, 1000, 22).h).toBeCloseTo(22 * Math.log1p(31) / Math.log1p(1000), 6);
    expect(barHeight(31, 1000, 22).h).toBeGreaterThan(22 / 2);
  });
  it('gives any month with a request at least 2 px', () => {
    expect(BAR_MIN_PX).toBe(2);
    expect(barHeight(1, 1e9, 22).h).toBe(2);
    expect(barHeight(0.5, 1e9, 22).h).toBe(2);
  });
  it('with no top (nothing listed) a month with requests fills the height', () => {
    expect(barHeight(3, 0, 22)).toEqual({ h: 22, capped: false });
  });
  it('is monotone', () => {
    let prev = 0;
    for (const v of [1, 2, 5, 10, 50, 100, 400, 999, 1000, 4000]) { const h = barHeight(v, 1000, 22).h; expect(h).toBeGreaterThanOrEqual(prev); prev = h; }
  });
});

describe('rowBars', () => {
  it('gives 12 UTC calendar months ending with the scan month, oldest first', () => {
    const s = svc({ usage: [[0, 3], [1, 4], [40, 10]] });
    const d = mk([s]);
    const b = rowBars(famOf(d, s.id), usageContext(d));
    expect(b.months).toHaveLength(12);
    expect(b.months[0]?.month).toBe('2025-12');
    expect(b.months[11]?.month).toBe('2026-11');
    expect(b.months[11]).toMatchObject({ requests: 3, requestDays: 1 }); // 1 Nov
    expect(b.months[10]).toMatchObject({ requests: 4, requestDays: 1 }); // 31 Oct
    expect(b.months[9]).toMatchObject({ requests: 10, requestDays: 1 }); // 22 Sep
    expect(b.lastUseMonth).toBe(11);
    expect(b.kind).toBe('used');
  });

  it('sums the whole family, and counts request days over the past 365 days like the panel headline', () => {
    const src = svc({ usage: [[3, 5], [300, 2], [364, 1], [365, 9]] });
    const view = svc({ isView: true, sourceId: src.id, usage: [[3, 7], [10, 1]] });
    const d = mk([src, view]);
    const f = famOf(d, src.id);
    const ctx = usageContext(d);
    const b = rowBars(f, ctx);
    const y = usageSeries(f, ctx, { span: 365 });
    expect(b.requestDays).toBe(y.headline.requestDays);
    expect(b.requestDays).toBe(4);
    expect(b.lastUse).toBe(y.headline.lastUse?.daysAgo);
    const total = b.months.reduce((a, m) => a + m.requests, 0);
    expect(total).toBe(5 + 7 + 1 + 2); // day 364 falls before 1 Dec 2025, day 365 outside the year
  });

  it('sets sweep touches aside, lighter, as the series does; counting sweeps keeps them as use', () => {
    const s = svc({ usage: [[10, 2], [200, 1]] });
    const heavy = svc({ usage: [[10, SWEEP_HEAVY_REQUESTS + 5]] });
    const d = mk([s, heavy, ...sweepFiller([10])]);
    const b = rowBars(famOf(d, s.id), usageContext(d));
    const oct = b.months[10]; // 22 Oct
    expect(oct?.month).toBe('2026-10');
    expect(oct).toMatchObject({ requests: 0, swept: 2 });
    expect(b.requestDays).toBe(1);
    expect(b.lastUseMonth).toBe(b.months.findIndex((m) => m.requests > 0));
    const hb = rowBars(famOf(d, heavy.id), usageContext(d));
    expect(hb.months[10]).toMatchObject({ requests: SWEEP_HEAVY_REQUESTS + 5, swept: 0 });
    const c = rowBars(famOf(d, s.id), usageContext(d, true));
    expect(c.months[10]).toMatchObject({ requests: 2, swept: 0 });
  });

  it('says sweep only when the year has only sweep touches and nothing read was ever real use', () => {
    const s = svc({ usage: [[10, 2]] });
    const d = mk([s, ...sweepFiller([10])]);
    expect(rowBars(famOf(d, s.id), usageContext(d)).kind).toBe('sweepOnly');
    const old = svc({ usage: [[10, 2], [500, 4]] });
    const d2 = mk([old, ...sweepFiller([10])]);
    expect(rowBars(famOf(d2, old.id), usageContext(d2)).kind).toBe('none');
  });

  it('says none for a layer with no requests', () => {
    const s = svc();
    const d = mk([s]);
    const b = rowBars(famOf(d, s.id), usageContext(d));
    expect(b.kind).toBe('none');
    expect(b.lastUseMonth).toBe(-1);
    expect(b.lastUse).toBeNull();
    expect(b.months.every((m) => m.requests === 0 && m.swept === 0 && !m.notRead)).toBe(true);
  });

  it('marks a month not read only when every day of it failed and had no requests; never zero', () => {
    const s = svc({ usage: [[5, 3]] });
    // 2026-08 is days 62..92 before 1 Nov; fail 0..120 (so October, September, August, part of July).
    const d = mk([s], { usageGaps: [[0, 120]], usageComplete: false });
    const b = rowBars(famOf(d, s.id), usageContext(d));
    expect(b.months[11]).toMatchObject({ notRead: true });
    expect(b.months[10]).toMatchObject({ notRead: false, partNotRead: true, requests: 3 }); // day 5 was read
    expect(b.months[9]).toMatchObject({ notRead: true });
    expect(b.months[7]).toMatchObject({ month: '2026-07', notRead: false, partNotRead: true });
    expect(b.kind).toBe('used');
  });

  it('says not read when the whole year failed', () => {
    const s = svc();
    const d = mk([s], { usageComplete: false, usageDays: undefined });
    const b = rowBars(famOf(d, s.id), usageContext(d));
    expect(b.kind).toBe('notRead');
    expect(b.months.every((m) => m.notRead)).toBe(true);
  });

  it('is memoised per family and context', () => {
    const s = svc({ usage: [[1, 1]] });
    const d = mk([s]);
    const f = famOf(d, s.id);
    expect(rowBars(f, usageContext(d))).toBe(rowBars(f, usageContext(d)));
    expect(rowBars(f, usageContext(d, true))).not.toBe(rowBars(f, usageContext(d)));
  });
});

describe('listTop (one shared top for the rows on the page)', () => {
  it('is the 95th percentile of every listed month total of real requests, not-read months left out', () => {
    const rows = Array.from({ length: 10 }, (_, i) => svc({ usage: [[3, (i + 1) * 10]] }));
    const big = svc({ usage: [[3, 1_000_000]] });
    const d = mk([...rows, big]);
    const ctx = usageContext(d);
    const bars = [...rows, big].map((s) => rowBars(famOf(d, s.id), ctx));
    // 11 non-zero totals: 10..100 and 1,000,000; nearest rank ceil(10.45) = 11th -> the outlier. With 30 more rows it is not.
    expect(listTop(bars)).toBe(1_000_000);
    const more = Array.from({ length: 30 }, () => svc({ usage: [[3, 50]] }));
    const d2 = mk([...rows, big, ...more]);
    const ctx2 = usageContext(d2);
    expect(listTop([...rows, big, ...more].map((s) => rowBars(famOf(d2, s.id), ctx2)))).toBe(90); // 41 totals: rank 39 is 90
    expect(listTop([])).toBe(0);
  });

  it('leaves sweep touches out: a list of crawler touches alone has no top, so they never draw as bars', () => {
    const quiet = svc({ usage: [[10, 3]] });
    const d = mk([quiet, ...sweepFiller([10])]);
    const ctx = usageContext(d);
    const rows = [quiet, ...d.services.slice(1)].map((x) => rowBars(famOf(d, x.id), ctx));
    expect(rows[0]?.kind).toBe('sweepOnly');
    expect(listTop(rows)).toBe(0);
  });
});
