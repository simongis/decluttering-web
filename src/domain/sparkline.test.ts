// DC-144: the row sparkline's extra numbers (light sweep touches, request totals, busiest day, not read). Test-first.
import { describe, expect, it } from 'vitest';
import type { Data, Service, Thresholds } from './types';
import { allRows } from './stale';

const SCAN = '2026-10-17T09:00:00Z';
const REF = Date.parse(SCAN);
const DAY = 864e5;
const isoAgo = (d: number) => new Date(REF - d * DAY).toISOString();

let n = 0;
const svc = (o: Partial<Service> = {}): Service => ({
  id: `p${++n}`, title: `Layer ${n}`, owner: 'amy', created: isoAgo(1500), modified: isoAgo(1200), sizeMB: 30,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const owners = [{ username: 'amy', fullName: 'Amy A', disabled: false, thumbnail: null, lastNotified: null }];
const mk = (services: Service[], extra: Partial<Data> = {}): Data =>
  ({ org: { id: 'o1', name: 'Org', urlKey: 'org', scannedAt: SCAN }, owners, services, ...extra });
const RULE: Thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 99, minSizeMB: 0 };

/** 60 filler layers touched on day 10 with 2 requests each: day 10 is a sweep day. */
const crowd = (): Service[] => Array.from({ length: 60 }, () => svc({ usage: [[10, 2]] }));
const rowOf = (data: Data, s: Service, countSweeps = false) =>
  allRows(data, RULE, { countSweeps }).find((r) => r.source.id === s.id)!;

describe('row sparkline numbers', () => {
  it('sums requests over the 91 days and finds the busiest day with its UTC date', () => {
    const s = svc({ usage: [[0, 4], [3, 9], [20, 2], [91, 500], [200, 7]] });
    const r = rowOf(mk([s]), s);
    expect(r.requests91).toBe(15); // days 91 and 200 are outside the window
    expect(r.busiest).toEqual({ daysAgo: 3, count: 9, date: '2026-10-14' });
    expect(r.usageRead).toBe(true);
  });

  it('sums a family across the source and its views, per day', () => {
    const s = svc({ usage: [[5, 3]] });
    const v = svc({ isView: true, sourceId: s.id, sizeMB: 0, usage: [[5, 4], [6, 6]] });
    const r = rowOf(mk([s, v]), s);
    expect(r.requests91).toBe(13);
    expect(r.busiest).toMatchObject({ daysAgo: 5, count: 7 });
    expect(r.weekly.reduce((a, b) => a + b, 0)).toBe(2); // request days stay a union of days
  });

  it('has no busiest day with no requests, and ignores zero counts', () => {
    const s = svc({ usage: [[2, 0]] });
    const r = rowOf(mk([s]), s);
    expect(r.requests91).toBe(0);
    expect(r.busiest).toBeNull();
  });

  it('marks days with only sweep touches, per week, and still counts them as request days', () => {
    const s = svc({ usage: [[0, 4], [3, 5], [10, 2]] }); // day 10 is the sweep day: 2 requests, light
    const data = mk([s, ...crowd()]);
    const r = rowOf(data, s);
    expect(r.weekly[12]).toBe(2);
    expect(r.weekly[11]).toBe(1);
    expect(r.weeklySwept[11]).toBe(1);
    expect(r.weeklySwept[12]).toBe(0);
    expect(r.weeklySwept.length).toBe(13);
    expect(r.requests91).toBe(11); // light touches are real requests: not dropped from the total
  });

  it('a heavy day on a sweep day is not light', () => {
    const s = svc({ usage: [[10, 40]] });
    const r = rowOf(mk([s, ...crowd()]), s);
    expect(r.weekly[11]).toBe(1);
    expect(r.weeklySwept[11]).toBe(0);
  });

  it('draws sweep touches normally when the admin counts them', () => {
    const s = svc({ usage: [[10, 2]] });
    const r = rowOf(mk([s, ...crowd()]), s, true);
    expect(r.weekly[11]).toBe(1);
    expect(r.weeklySwept.every((v) => v === 0)).toBe(true);
  });

  it('is not read when a usage window failed, even with no buckets', () => {
    const s = svc({ usage: [] });
    const failed = mk([s], { usageComplete: false });
    expect(rowOf(failed, s).usageRead).toBe(false);
    expect(rowOf(mk([s]), s).usageRead).toBe(true);
  });

  it('shares rows without changing them (DC-100 memo)', () => {
    const s = svc({ usage: [[1, 1]] });
    const data = mk([s]);
    expect(rowOf(data, s)).toBe(rowOf(data, s));
  });
});
