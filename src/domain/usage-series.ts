// DC-147: the item panel's usage, worked out from what the scan already holds (no requests). Pure TS: no DOM.
// Days are UTC days before the scan (Service.usage's daysAgo), day 0 is the scan day (partial). Wording rules:
// docs/research/usage-representation.md 5.4 and ADR 0007 (2026-10-31): a failed window is "not read", never zero; sweep
// touches are set aside exactly as Last used sets them aside (useOf), on the whole family's requests that day.
import type { Data, Family, Service } from './types';
import { DAY } from './format';
import { USAGE_RULE_DAYS, sweepDaysRead } from './stale';
import { SWEEP_HEAVY_REQUESTS } from './sweep';

export type Span = 365 | 730;

/** What the series needs from the scan, worked out once per Data (see usageContext). */
export interface UsageContext {
  /** The scan time, ms. */
  ref: number;
  /** Days of history read: usage days 0 to readDays - 1. 365 for a scan saved before DC-147. */
  readDays: number;
  /** Inclusive [newest, oldest] days-ago ranges that were not read. */
  gaps: readonly (readonly [number, number])[];
  /** Sweep days over every day read; null when the admin counts sweeps as use. */
  sweepDays: ReadonlySet<number> | null;
}

export interface UsageDay {
  daysAgo: number;
  /** UTC date, YYYY-MM-DD. */
  date: string;
  /** Data requests that day for the selection (sweep touches included; see sweepTouch). 0 when not read. */
  requests: number;
  /** The family made at most SWEEP_HEAVY_REQUESTS requests on a sweep day: shown lighter, not counted as use. */
  sweepTouch: boolean;
  /** The day could not be read (a failed window, or before the history read): never draw it as zero. */
  notRead: boolean;
  /** All members together, more than one, and some requests: each member's count, in `members` order (for the tooltip). */
  byMember?: number[];
}

export interface UsageMonth {
  /** UTC month, YYYY-MM. */
  month: string;
  /** Days of this month inside the span (the first and the current month can be partial). */
  days: number;
  /** Requests on days of real use, and how many such days. */
  requests: number; requestDays: number;
  /** Requests on sweep-touch days, and how many such days. */
  sweptRequests: number; sweepTouchDays: number;
  notReadDays: number;
}

export interface DayRef { daysAgo: number; date: string }

/** The facts a headline sentence is built from ("Used on 12 days in the past year, last on 3 March 2026."). */
export interface UsageHeadline {
  span: Span;
  /** Real use in the span: requests, and the days they fell on (sweep touches left out). */
  requests: number; requestDays: number;
  sweptRequests: number; sweepTouchDays: number;
  /** The newest day of real use in the span; null when none. */
  lastUse: DayRef | null;
  /** The newest day of real use in everything read (for "No requests in the past year. Last used on ..."). */
  lastUseEver: DayRef | null;
  /** Days in the span that could not be read; allNotRead when that is every day. */
  notReadDays: number; allNotRead: boolean;
  /** The span reaches past the history read: the first day that was read (UTC date). null when the span was read in full. */
  notReadBefore: string | null;
}

export interface UsageSeries {
  span: Span;
  /** The first and last day of the span (UTC dates); `to` is the scan day. */
  from: string; to: string;
  /** The member ids shown (source first, then views), one when a member is picked. */
  members: string[];
  /** One cell per day of the span; days[i].daysAgo === i (newest first). */
  days: UsageDay[];
  /** UTC calendar months across the span, oldest first. */
  months: UsageMonth[];
  headline: UsageHeadline;
}

const ctxMemo = new WeakMap<Data, [UsageContext | undefined, UsageContext | undefined]>();

/** The scan facts the panel's usage needs. `countSweeps`: the admin counts sweep touches as use (nothing set aside). */
export function usageContext(data: Data, countSweeps = false): UsageContext {
  let pair = ctxMemo.get(data);
  if (!pair) { pair = [undefined, undefined]; ctxMemo.set(data, pair); }
  const at = countSweeps ? 1 : 0;
  const hit = pair[at];
  if (hit) return hit;
  const readDays = data.usageDays ?? USAGE_RULE_DAYS;
  // A scan from before DC-147 that failed a window kept no ranges: any day without requests may not have been read.
  const gaps: (readonly [number, number])[] = data.usageGaps ? data.usageGaps.map(([a, b]) => [a, b] as const)
    : data.usageComplete === false ? [[0, readDays - 1]] : [];
  const ctx: UsageContext = { ref: Date.parse(data.org.scannedAt), readDays, gaps, sweepDays: countSweeps ? null : sweepDaysRead(data) };
  pair[at] = ctx;
  return ctx;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The selection's usage over the span ending on the scan day: one cell per day, calendar months and the headline facts.
 * `member`: one member's id (source or view); absent (or not in the family) for all of them together.
 */
export function usageSeries(f: Family, ctx: UsageContext, o: { span: Span; member?: string }): UsageSeries {
  const span = o.span;
  const all: Service[] = f.views.length ? [f.source, ...f.views] : [f.source];
  const picked = o.member ? all.filter((m) => m.id === o.member) : [];
  const shown = picked.length ? picked : all;
  const perMember = shown.length > 1;
  // The family's requests per day (everything read), and the selection's (and per member) within the span.
  const family = new Map<number, number>();
  const sel = new Float64Array(span);
  const per: Float64Array[] | null = perMember ? shown.map(() => new Float64Array(span)) : null;
  const shownSet = new Set(shown);
  for (const m of all) {
    const k = perMember ? shown.indexOf(m) : -1;
    for (const [d0, c] of m.usage) {
      if (!(c > 0)) continue;
      const d = Math.max(0, d0); // a future-dated bucket is today (as useOf)
      family.set(d, (family.get(d) ?? 0) + c);
      if (d < span && shownSet.has(m)) {
        sel[d] = (sel[d] as number) + c;
        if (per && k >= 0) (per[k] as Float64Array)[d] = ((per[k] as Float64Array)[d] as number) + c;
      }
    }
  }
  const sweepDays = ctx.sweepDays;
  const touch = (d: number): boolean => !!sweepDays?.has(d) && (family.get(d) ?? 0) <= SWEEP_HEAVY_REQUESTS;
  const inGap = (d: number): boolean => {
    if (d >= ctx.readDays) return true;
    for (const [a, b] of ctx.gaps) if (d >= a && d <= b) return true;
    return false;
  };

  const today = Math.floor(ctx.ref / DAY);
  const days = new Array<UsageDay>(span);
  let requests = 0, requestDays = 0, sweptRequests = 0, sweepTouchDays = 0, notReadDays = 0;
  let lastUse: DayRef | null = null;
  for (let d = 0; d < span; d++) {
    const c = sel[d] as number;
    // A day with requests from any member was read (an edge day the neighbouring window returned).
    const notRead = !family.has(d) && inGap(d);
    const sweepTouch = c > 0 && touch(d);
    const cell: UsageDay = { daysAgo: d, date: isoDay((today - d) * DAY), requests: c, sweepTouch, notRead };
    if (per && c > 0) cell.byMember = per.map((p) => p[d] as number);
    days[d] = cell;
    if (notRead) notReadDays++;
    else if (c > 0) {
      if (sweepTouch) { sweptRequests += c; sweepTouchDays++; }
      else { requests += c; requestDays++; lastUse ??= { daysAgo: d, date: cell.date }; }
    }
  }

  // The newest real use in everything read, for the selection.
  let lastUseEver: DayRef | null = lastUse;
  if (!lastUseEver) {
    let best = -1;
    for (const m of shown) for (const [d0, c] of m.usage) {
      const d = Math.max(0, d0);
      if (c > 0 && d >= span && (best < 0 || d < best) && !touch(d)) best = d;
    }
    if (best >= 0) lastUseEver = { daysAgo: best, date: isoDay((today - best) * DAY) };
  }

  // Calendar months, oldest first.
  const months: UsageMonth[] = [];
  let cur: UsageMonth | null = null;
  for (let d = span - 1; d >= 0; d--) {
    const cell = days[d] as UsageDay;
    const key = cell.date.slice(0, 7);
    if (!cur || cur.month !== key) { cur = { month: key, days: 0, requests: 0, requestDays: 0, sweptRequests: 0, sweepTouchDays: 0, notReadDays: 0 }; months.push(cur); }
    cur.days++;
    if (cell.notRead) cur.notReadDays++;
    else if (cell.requests > 0) {
      if (cell.sweepTouch) { cur.sweptRequests += cell.requests; cur.sweepTouchDays++; }
      else { cur.requests += cell.requests; cur.requestDays++; }
    }
  }

  return {
    span, from: (days[span - 1] as UsageDay).date, to: (days[0] as UsageDay).date, members: shown.map((m) => m.id), days, months,
    headline: {
      span, requests, requestDays, sweptRequests, sweepTouchDays, lastUse, lastUseEver,
      notReadDays, allNotRead: notReadDays === span,
      notReadBefore: span > ctx.readDays ? isoDay((today - (ctx.readDays - 1)) * DAY) : null,
    },
  };
}
