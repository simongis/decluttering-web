// DC-147: the item panel's usage, as pure series. Test-first.
import { describe, expect, it } from 'vitest';
import type { Data, Family, Service } from './types';
import { families, useOf, sweepsOf } from './stale';
import { SWEEP_HEAVY_REQUESTS } from './sweep';
import { usageContext, usageSeries } from './usage-series';

const SCAN = '2026-11-01T09:30:00Z';
const REF = Date.parse(SCAN);
const DAY = 864e5;

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

/** 60 filler layers touched lightly on `days`, so those are sweep days (>= 50 services, >= 25%, median <= 5). */
const sweepFiller = (days: number[]) => Array.from({ length: 60 }, () => svc({ usage: days.map((d): [number, number] => [d, 1]) }));

describe('usageSeries', () => {
  it('gives one cell per day of the span, newest first (index = days ago), with UTC dates ending on the scan day', () => {
    const s = svc({ usage: [[0, 3], [2, 5], [400, 7]] });
    const d = mk([s]);
    const ctx = usageContext(d);
    const y1 = usageSeries(famOf(d, s.id), ctx, { span: 365 });
    expect(y1.days).toHaveLength(365);
    expect(y1.days[0]).toMatchObject({ daysAgo: 0, date: '2026-11-01', requests: 3, sweepTouch: false, notRead: false });
    expect(y1.days[2]).toMatchObject({ date: '2026-10-30', requests: 5 });
    expect(y1.to).toBe('2026-11-01');
    expect(y1.from).toBe(new Date(REF - 364 * DAY).toISOString().slice(0, 10));
    expect(y1.headline).toMatchObject({ requests: 8, requestDays: 2, lastUse: { daysAgo: 0, date: '2026-11-01' } });
    const y2 = usageSeries(famOf(d, s.id), ctx, { span: 730 });
    expect(y2.days).toHaveLength(730);
    expect(y2.days[400]?.requests).toBe(7);
    expect(y2.headline).toMatchObject({ requests: 15, requestDays: 3, notReadBefore: null });
  });

  it('a light touch on a sweep day is a sweep touch, not use; a heavy day on a sweep day is use (the useOf rule)', () => {
    const light = svc({ usage: [[10, 2], [200, 1]] });
    const heavy = svc({ usage: [[10, SWEEP_HEAVY_REQUESTS + 5]] });
    const d = mk([light, heavy, ...sweepFiller([10])]);
    expect(sweepsOf(d).days.has(10)).toBe(true);
    const ctx = usageContext(d);
    const a = usageSeries(famOf(d, light.id), ctx, { span: 365 });
    expect(a.days[10]).toMatchObject({ requests: 2, sweepTouch: true, notRead: false });
    expect(a.headline).toMatchObject({ requests: 1, requestDays: 1, sweptRequests: 2, sweepTouchDays: 1, lastUse: { daysAgo: 200 } });
    // Last used on the row agrees with the panel's last real use day.
    expect(useOf([light], REF, sweepsOf(d)).last).toBe(200);
    const b = usageSeries(famOf(d, heavy.id), ctx, { span: 365 });
    expect(b.days[10]).toMatchObject({ sweepTouch: false });
    expect(b.headline.lastUse?.daysAgo).toBe(10);
    // Counting sweeps (the admin's setting): nothing is set aside.
    const c = usageSeries(famOf(d, light.id), usageContext(d, true), { span: 365 });
    expect(c.days[10]?.sweepTouch).toBe(false);
    expect(c.headline.lastUse?.daysAgo).toBe(10);
  });

  it('finds sweep days in the second year too', () => {
    const light = svc({ usage: [[500, 2]] });
    const d = mk([light, ...sweepFiller([500])]);
    const s = usageSeries(famOf(d, light.id), usageContext(d), { span: 730 });
    expect(s.days[500]?.sweepTouch).toBe(true);
    expect(s.headline.lastUse).toBeNull();
    // the rule never sees the second year: its sweep days stay as they were
    expect(sweepsOf(d).days.has(500)).toBe(false);
  });

  it('decides a sweep touch on the whole family, so a view does not turn a heavy family day into a touch', () => {
    const src = svc({ usage: [[10, 9]] });
    const view = svc({ isView: true, sourceId: src.id, usage: [[10, 3]] });
    const d = mk([src, view, ...sweepFiller([10])]);
    const fam = famOf(d, src.id);
    const ctx = usageContext(d);
    // family total 12 > 10: use, also for the view alone
    expect(usageSeries(fam, ctx, { span: 365, member: view.id }).days[10]).toMatchObject({ requests: 3, sweepTouch: false });
  });

  it('a failed window is not read, never zero; a day in it with requests was read', () => {
    const s = svc({ usage: [[5, 4], [150, 2]] });
    const d = mk([s], { usageGaps: [[150, 300]], usageComplete: false });
    const ser = usageSeries(famOf(d, s.id), usageContext(d), { span: 365 });
    expect(ser.days[149]).toMatchObject({ requests: 0, notRead: false });
    expect(ser.days[150]).toMatchObject({ requests: 2, notRead: false });
    expect(ser.days[151]).toMatchObject({ requests: 0, notRead: true });
    expect(ser.days[300]).toMatchObject({ notRead: true });
    expect(ser.days[301]).toMatchObject({ notRead: false });
    expect(ser.headline.notReadDays).toBe(150);
    expect(ser.headline.allNotRead).toBe(false);
  });

  it('a scan before DC-147 that failed a window (no ranges kept): every day without requests is not read', () => {
    const s = svc({ usage: [[5, 4]] });
    const d = mk([s], { usageDays: undefined, usageComplete: false });
    const ser = usageSeries(famOf(d, s.id), usageContext(d), { span: 365 });
    expect(ser.days[5]).toMatchObject({ requests: 4, notRead: false });
    expect(ser.days[6]?.notRead).toBe(true);
    expect(ser.headline.notReadDays).toBe(364);
  });

  it('a scan saved before DC-147 (365 days): the second year is not read, with the date it starts from', () => {
    const s = svc({ usage: [[3, 1]] });
    const d = mk([s], { usageDays: undefined });
    const ctx = usageContext(d);
    expect(ctx.readDays).toBe(365);
    const ser = usageSeries(famOf(d, s.id), ctx, { span: 730 });
    expect(ser.days[364]?.notRead).toBe(false);
    expect(ser.days[365]).toMatchObject({ requests: 0, notRead: true });
    expect(ser.days[729]?.notRead).toBe(true);
    expect(ser.headline.notReadBefore).toBe(new Date(REF - 364 * DAY).toISOString().slice(0, 10));
    expect(ser.headline.notReadDays).toBe(365);
    expect(usageSeries(famOf(d, s.id), ctx, { span: 365 }).headline.notReadBefore).toBeNull();
  });

  it('every day not read: allNotRead', () => {
    const s = svc();
    const d = mk([s], { usageGaps: [[0, 729]], usageComplete: false });
    expect(usageSeries(famOf(d, s.id), usageContext(d), { span: 365 }).headline.allNotRead).toBe(true);
  });

  it('a request day on a view only: counted for the family and the view, not for the source', () => {
    const src = svc({ usage: [[20, 5]] });
    const view = svc({ isView: true, sourceId: src.id, usage: [[7, 12], [20, 1]] });
    const d = mk([src, view]);
    const fam = famOf(d, src.id);
    const ctx = usageContext(d);
    const all = usageSeries(fam, ctx, { span: 365 });
    expect(all.members).toEqual([src.id, view.id]);
    expect(all.days[7]).toMatchObject({ requests: 12, byMember: [0, 12] });
    expect(all.days[20]).toMatchObject({ requests: 6, byMember: [5, 1] });
    expect(all.headline).toMatchObject({ requestDays: 2, requests: 18, lastUse: { daysAgo: 7 } });
    const onlySrc = usageSeries(fam, ctx, { span: 365, member: src.id });
    expect(onlySrc.members).toEqual([src.id]);
    expect(onlySrc.days[7]).toMatchObject({ requests: 0, notRead: false });
    expect(onlySrc.days[7]?.byMember).toBeUndefined();
    expect(onlySrc.headline).toMatchObject({ requestDays: 1, lastUse: { daysAgo: 20 } });
    const onlyView = usageSeries(fam, ctx, { span: 365, member: view.id });
    expect(onlyView.headline).toMatchObject({ requestDays: 2, requests: 13 });
  });

  it('months: UTC calendar months across the span, oldest first, with the sweep share and days not read', () => {
    const s = svc({ usage: [[0, 3], [1, 2], [40, 2]] });
    const d = mk([s, ...sweepFiller([40])], { usageGaps: [[60, 70]] });
    const ser = usageSeries(famOf(d, s.id), usageContext(d), { span: 365 });
    expect(ser.months.at(-1)).toMatchObject({ month: '2026-11', days: 1, requests: 3, requestDays: 1 });
    expect(ser.months.at(-2)).toMatchObject({ month: '2026-10', days: 31, requests: 2, requestDays: 1 });
    // day 40 = 22 Sep 2026, a sweep touch; days 60 to 70 = 23 Aug to 2 Sep, not read
    expect(ser.months.find((m) => m.month === '2026-09')).toMatchObject({ requests: 0, sweptRequests: 2, sweepTouchDays: 1, notReadDays: 2 });
    expect(ser.months.find((m) => m.month === '2026-08')).toMatchObject({ notReadDays: 9 });
    expect(ser.months.reduce((a, m) => a + m.days, 0)).toBe(365);
    expect(ser.months[0]?.month).toBe(ser.from.slice(0, 7));
  });

  it('the last real use in everything read, for "none in the past year, last used on <date>"', () => {
    const s = svc({ usage: [[500, 9]] });
    const d = mk([s]);
    const ser = usageSeries(famOf(d, s.id), usageContext(d), { span: 365 });
    expect(ser.headline.lastUse).toBeNull();
    expect(ser.headline.lastUseEver).toMatchObject({ daysAgo: 500 });
    expect(ser.headline.requestDays).toBe(0);
  });

  it('a future-dated bucket is today, as in useOf', () => {
    const s = svc({ usage: [[-1, 4]] });
    const d = mk([s]);
    expect(usageSeries(famOf(d, s.id), usageContext(d), { span: 365 }).days[0]?.requests).toBe(4);
  });
});
