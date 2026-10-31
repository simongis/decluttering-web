// DC-086: sweeps. A script or crawler that touches every layer with a request or two would make the whole org look
// "used recently". We find those days (and lastViewed hours) from data already in hand and set the light touches aside
// when working out last used (docs/research/usage-signals-deep-dive.md 6.2, 6.3). Pure TS: no DOM.
import type { Family, Service } from './types';
import { DAY, fmtDate } from './format';
import { t, tn } from '../i18n';

/*
 * JUDGEMENT values, calibrated on one big org's cached scan (6,812 layers, anonymised counts): 15 days in the year had
 * requests on more than 25% of layers (83% to 91% on the worst), with a median of 1 to 3 requests per touched layer.
 * Recalibrate once that org is re-scanned with lastViewed.
 */
/** A sweep day: requests touched at least this share of services... */
export const SWEEP_DAY_SHARE = 0.25;
/** ...and at least this many services in all (so a small org's busy day is not a sweep)... */
export const SWEEP_MIN_SERVICES = 50;
/** ...and the median requests per touched service that day is at most this (people at work make more). */
export const SWEEP_MAX_MEDIAN = 5;
/** A sweep hour: at least SWEEP_DAY_SHARE of families have their newest lastViewed in it, and at least this many. */
export const SWEEP_MIN_FAMILIES = 50;
/** On a sweep day a family's requests still count when there are more than this many (a heavy user on a sweep day). */
export const SWEEP_HEAVY_REQUESTS = 10;

export const HOUR = 3_600_000;

export interface Sweeps {
  /** Sweep days, as whole days before the scan (the usage buckets' daysAgo). */
  days: ReadonlySet<number>;
  /** Sweep hours, as Math.floor(epoch ms / HOUR) in UTC. */
  hours: ReadonlySet<number>;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** UTC days on which requests touched at least 25% of services, at least 50 of them, with a median of at most 5 requests. */
export function sweepDays(services: readonly Service[]): Set<number> {
  const perDay = new Map<number, Map<string, number>>();
  for (const s of services) for (const [d, c] of s.usage) {
    if (!(c > 0)) continue;
    const a = Math.max(0, d);
    const m = perDay.get(a) ?? new Map<string, number>();
    perDay.set(a, m);
    m.set(s.id, (m.get(s.id) ?? 0) + c);
  }
  const out = new Set<number>();
  for (const [d, m] of perDay) {
    if (m.size < SWEEP_MIN_SERVICES || m.size < SWEEP_DAY_SHARE * services.length) continue;
    if (median([...m.values()]) <= SWEEP_MAX_MEDIAN) out.add(d);
  }
  return out;
}

/** The newest parsable lastViewed across a family's members, in epoch ms, or null. */
const newestViewed = (f: Family): number | null => {
  let best: number | null = null;
  for (const m of [f.source, ...f.views]) {
    if (typeof m.lastViewed !== 'string') continue;
    const t = Date.parse(m.lastViewed);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
};

/**
 * UTC hours (floored) holding the newest lastViewed of at least 25% of all families, and at least 50 of them.
 * A data request moves lastViewed to the floored hour (live check L1), so a sweep stacks families in one hour.
 */
export function sweepHours(fams: readonly Family[]): Set<number> {
  const count = new Map<number, number>();
  for (const f of fams) {
    const t = newestViewed(f);
    if (t !== null) { const h = Math.floor(t / HOUR); count.set(h, (count.get(h) ?? 0) + 1); }
  }
  const out = new Set<number>();
  for (const [h, c] of count) if (c >= SWEEP_MIN_FAMILIES && c >= SWEEP_DAY_SHARE * fams.length) out.add(h);
  return out;
}

export interface SweepSummary {
  /** Distinct UTC dates with a sweep day or a sweep hour. */
  dates: number;
  /** The most recent of them, in days before the scan, and as "7 Oct 2026". */
  latestDaysAgo: number; latest: string;
}

/** What was found, for the note; null when there is nothing to say. `ref` is the scan time (ms). */
export function sweepSummary(sw: Sweeps, ref: number): SweepSummary | null {
  const today = Math.floor(ref / DAY);
  const ago = new Set<number>(sw.days);
  for (const h of sw.hours) ago.add(Math.max(0, today - Math.floor((h * HOUR) / DAY)));
  if (!ago.size) return null;
  const latestDaysAgo = Math.min(...ago);
  return { dates: ago.size, latestDaysAgo, latest: fmtDate(new Date((today - latestDaysAgo) * DAY).toISOString()) };
}

/** The calm note for the review header and the scan's finish line, and its one action (DC-086, tone guide). */
export function sweepNote(s: SweepSummary, counting: boolean): { text: string; action: string } {
  const others = s.dates - 1;
  const when = others ? tn(others === 1 ? 'domain.sweep.when.one' : 'domain.sweep.when.other', others, { date: s.latest, count: String(others) }) : t('domain.sweep.when', { date: s.latest });
  return counting
    ? { text: t('domain.sweep.counting', { when }), action: t('domain.sweep.action.setAside') }
    : { text: t('domain.sweep.notCounting', { when }), action: t('domain.sweep.action.count') };
}

/** One sentence for the "Last used" info popover. */
export const SWEEP_INFO = t('domain.sweep.info');
