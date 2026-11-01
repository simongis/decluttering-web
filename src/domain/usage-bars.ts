// DC-147c: the Review row's 12 monthly bars, from what the scan already holds (no requests). Pure TS: no DOM.
// The months are the 12 UTC calendar months ending with the scan's month (the last one partial). The same rules as
// usage-series.ts: a sweep touch (a light family day on a sweep day) is set aside and drawn lighter; a failed window is
// "not read", never zero. Shared scale (BACKLOG "DC-147 decisions"): the top is the 95th percentile of the listed rows'
// non-zero month totals, months above it are drawn full with a cap mark, heights are log1p-compressed, and any month with
// a request gets at least BAR_MIN_PX.
import type { Family } from './types';
import { DAY } from './format';
import { SWEEP_HEAVY_REQUESTS } from './sweep';
import type { UsageContext } from './usage-series';

export const ROW_MONTHS = 12;
/** The past year, as the panel's 12-month headline counts it (usageSeries span 365). */
const YEAR = 365;
export const BAR_MIN_PX = 2;

export interface RowMonth {
  /** UTC month, YYYY-MM. */
  month: string;
  /** Requests on days of real use, and how many such days. */
  requests: number; requestDays: number;
  /** Requests on sweep-touch days (not counted as use). */
  swept: number;
  /** Every day of the month (up to the scan day) could not be read: hatched, never zero. */
  notRead: boolean;
  /** Some days could not be read. */
  partNotRead: boolean;
}

/** The caption: used in the past year, no requests, only sweep touches, or not read. */
export type RowUsageKind = 'used' | 'none' | 'sweepOnly' | 'notRead';

export interface RowBars {
  /** Oldest first; the last is the scan's month. */
  months: RowMonth[];
  /** Days of real use in the past 365 days (agrees with the panel's 12-month headline). */
  requestDays: number;
  /** The newest of `months` with real use; -1 when none. */
  lastUseMonth: number;
  /** The newest day of real use in the past 365 days (days ago); null when none. */
  lastUse: number | null;
  kind: RowUsageKind;
}

interface MonthGrid {
  /** Month index (0..11) per days-ago, -1 before the first month. */
  idx: Int8Array;
  keys: string[];
  /** Days per month (up to the scan day). */
  len: number[];
  /** Per month, the not-read days in it (before any family's requests are taken into account). */
  gapDays: number[][];
}

const gridMemo = new WeakMap<UsageContext, MonthGrid>();
function gridOf(ctx: UsageContext): MonthGrid {
  const hit = gridMemo.get(ctx);
  if (hit) return hit;
  const today = Math.floor(ctx.ref / DAY);
  const now = new Date(today * DAY);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const first = Math.floor(Date.UTC(y, m - (ROW_MONTHS - 1), 1) / DAY);
  const days = today - first + 1;
  const idx = new Int8Array(Math.max(days, YEAR)).fill(-1);
  const keys: string[] = [];
  const len = new Array<number>(ROW_MONTHS).fill(0);
  const gapDays: number[][] = Array.from({ length: ROW_MONTHS }, () => []);
  for (let k = 0; k < ROW_MONTHS; k++) {
    const dt = new Date(Date.UTC(y, m - (ROW_MONTHS - 1) + k, 1));
    keys.push(dt.toISOString().slice(0, 7));
  }
  const inGap = (d: number): boolean => {
    if (d >= ctx.readDays) return true;
    for (const [a, b] of ctx.gaps) if (d >= a && d <= b) return true;
    return false;
  };
  let k = -1, cur = '';
  for (let d = days - 1; d >= 0; d--) {
    const key = new Date((today - d) * DAY).toISOString().slice(0, 7);
    if (key !== cur) { cur = key; k++; }
    idx[d] = k;
    len[k] = (len[k] as number) + 1;
    if (inGap(d)) (gapDays[k] as number[]).push(d);
  }
  const g: MonthGrid = { idx, keys, len, gapDays };
  gridMemo.set(ctx, g);
  return g;
}

const barsMemo = new WeakMap<UsageContext, WeakMap<Family, RowBars>>();

/** The family's 12 monthly bars and its caption. Memoised per family and context. */
export function rowBars(f: Family, ctx: UsageContext): RowBars {
  let per = barsMemo.get(ctx);
  if (!per) { per = new WeakMap(); barsMemo.set(ctx, per); }
  const hit = per.get(f);
  if (hit) return hit;
  const g = gridOf(ctx);
  // The family's requests per day, everything read (sweep touches are judged on the whole family's day, as useOf does).
  const family = new Map<number, number>();
  const add = (u: [number, number][]) => {
    for (const [d0, c] of u) {
      if (!(c > 0)) continue;
      const d = Math.max(0, d0);
      family.set(d, (family.get(d) ?? 0) + c);
    }
  };
  add(f.source.usage);
  for (const v of f.views) add(v.usage);
  const sweepDays = ctx.sweepDays;
  const touch = (d: number, c: number): boolean => !!sweepDays?.has(d) && c <= SWEEP_HEAVY_REQUESTS;

  const months: RowMonth[] = g.keys.map((month) => ({ month, requests: 0, requestDays: 0, swept: 0, notRead: false, partNotRead: false }));
  let requestDays = 0, swept = 0, realEver = false, lastUse: number | null = null;
  for (const [d, c] of family) {
    const sw = touch(d, c);
    if (!sw) realEver = true;
    if (d < YEAR && !sw) { requestDays++; if (lastUse === null || d < lastUse) lastUse = d; }
    const k = d < g.idx.length ? (g.idx[d] as number) : -1;
    if (k < 0) continue;
    const mo = months[k] as RowMonth;
    if (sw) { mo.swept += c; swept += c; } else { mo.requests += c; mo.requestDays++; }
  }
  let yearNotRead = 0;
  for (let k = 0; k < ROW_MONTHS; k++) {
    const gaps = g.gapDays[k] as number[];
    if (!gaps.length) continue;
    let nr = 0;
    for (const d of gaps) if (!family.has(d)) nr++;
    const mo = months[k] as RowMonth;
    mo.notRead = nr > 0 && nr === g.len[k];
    mo.partNotRead = nr > 0 && !mo.notRead;
  }
  // "Not read" for the caption is the panel's rule: every day of the past 365 failed and had no requests.
  if (requestDays === 0 && swept === 0) {
    for (let d = 0; d < YEAR; d++) {
      if (family.has(d)) break;
      if (d >= ctx.readDays || ctx.gaps.some(([a, b]) => d >= a && d <= b)) yearNotRead++; else break;
    }
  }
  let lastUseMonth = -1;
  for (let k = ROW_MONTHS - 1; k >= 0; k--) if ((months[k] as RowMonth).requests > 0) { lastUseMonth = k; break; }
  const kind: RowUsageKind = yearNotRead === YEAR ? 'notRead' : requestDays > 0 ? 'used'
    : swept > 0 && !realEver ? 'sweepOnly' : 'none';
  const out: RowBars = { months, requestDays, lastUseMonth, lastUse, kind };
  per.set(f, out);
  return out;
}

/** The 95th percentile (nearest rank) of the non-zero values; 0 when there are none. */
export function p95(values: Iterable<number>): number {
  const v: number[] = [];
  for (const x of values) if (x > 0) v.push(x);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.ceil(0.95 * v.length) - 1] as number;
}

/**
 * The shared top for the rows on the page: p95 of every month's real requests that was read. Sweep touches are left out
 * (user, 2026-11-01): on a big org they fall on the same few days for every quiet layer, and scaled like use they made
 * every stale row look alike and used. They are drawn as a fixed small tick instead.
 */
export function listTop(rows: Iterable<RowBars>): number {
  const totals: number[] = [];
  for (const r of rows) for (const m of r.months) if (!m.notRead) totals.push(m.requests);
  return p95(totals);
}

/**
 * A month's bar height in px out of `h`: log1p-compressed against the shared top, full height (and `capped`) above it,
 * at least BAR_MIN_PX for any request. With no top (nothing listed has requests), any request fills the height.
 */
export function barHeight(v: number, top: number, h: number): { h: number; capped: boolean } {
  if (!(v > 0)) return { h: 0, capped: false };
  if (!(top > 0) || v >= top) return { h, capped: top > 0 && v > top };
  return { h: Math.max(BAR_MIN_PX, (h * Math.log1p(v)) / Math.log1p(top)), capped: false };
}
