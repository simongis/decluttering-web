// DC-063: an honest "how long left" for a long scan. Pure functions; no DOM. Same logic as
// prototypes/d-converged/estimate.js (both are tested against the same cases).
//
// Overall progress is weighted by what each phase costs (docs/research/live-performance-2026-10-15.md: maps and apps is
// about 85% of a fresh scan), so a steady rate in weighted terms is a fair basis for a finish estimate.
import type { PhaseId } from '../../scan/types';
import { t, tn } from '../../i18n';

/** Relative cost of each phase on a fresh scan (milliseconds measured on a 79-service org, rounded). */
export const PHASE_WEIGHTS: Record<PhaseId, number> = { find: 300, size: 3500, views: 1000, usage: 1500, owners: 300, deps: 42000 };

export const ESTIMATE_MIN_ELAPSED_MS = 15000;
export const ESTIMATE_WINDOW_MS = 30000;
export const ESTIMATE_MIN_SPAN_MS = 6000;
export const ESTIMATE_MIN_PROGRESS = 0.01;
export const ESTIMATE_JUMP = 0.3;
export const ESTIMATE_STABLE_RATIO = 2.5;
export const ESTIMATE_MAX_MS = 2 * 60 * 60 * 1000;

export interface Sample { t: number; f: number }
export interface PhaseProgress { done: number; total: number }

/** Weighted overall fraction done, 0..1. Phases before `current` count as complete. */
export function overallFraction(
  ids: PhaseId[], progress: Partial<Record<PhaseId, PhaseProgress>>, current: PhaseId | null | undefined,
  finished = false, weights: Record<PhaseId, number> = PHASE_WEIGHTS,
): number {
  if (finished) return 1;
  const cur = current ? ids.indexOf(current) : -1;
  let sum = 0, got = 0;
  ids.forEach((id, k) => {
    const w = weights[id] ?? 1; sum += w;
    const p = progress[id];
    const f = cur >= 0 && k < cur ? 1 : p && p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
    got += w * f;
  });
  return sum > 0 ? got / sum : 0;
}

/** Plain words for a remaining time, rounded; never a seconds countdown. */
export function sayRemaining(ms: number): string {
  if (ms < 60000) return t('scan.time.under-minute');
  const n = Math.round(ms / 60000);
  return n === 1 ? t('scan.time.about-minute') : tn('scan.time.about-minutes', n, { count: n });
}

/** Null hides the estimate: too early, no measurable progress, a big jump, or an unstable rate. */
export function estimateRemaining(samples: Sample[]): { ms: number; text: string } | null {
  const last = samples[samples.length - 1];
  if (!last || last.t < ESTIMATE_MIN_ELAPSED_MS || last.f >= 1) return null;
  const w = samples.filter((s) => s.t >= last.t - ESTIMATE_WINDOW_MS);
  if (w.length < 4) return null;
  const first = w[0], span = last.t - first.t;
  if (span < ESTIMATE_MIN_SPAN_MS || last.f - first.f < ESTIMATE_MIN_PROGRESS) return null;
  for (let i = 1; i < w.length; i++) if (w[i].f - w[i - 1].f > ESTIMATE_JUMP) return null;
  const mid = first.t + span / 2;
  const a = w.filter((s) => s.t <= mid), b = w.filter((s) => s.t >= mid);
  const rate = (xs: Sample[]) => (xs.length > 1 && xs[xs.length - 1].t > xs[0].t ? (xs[xs.length - 1].f - xs[0].f) / (xs[xs.length - 1].t - xs[0].t) : 0);
  const [r1, r2] = [rate(a), rate(b)];
  if (r1 <= 0 || r2 <= 0 || Math.max(r1, r2) / Math.min(r1, r2) > ESTIMATE_STABLE_RATIO) return null;
  const ms = (1 - last.f) / ((last.f - first.f) / span);
  if (!Number.isFinite(ms) || ms > ESTIMATE_MAX_MS) return null;
  return { ms, text: sayRemaining(ms) };
}

/** Keeps samples for a scan: add(fraction, nowMs) then estimate(). */
export function createEstimator(startMs: number) {
  let samples: Sample[] = [];
  let pushedAt = -Infinity;
  return {
    add(f: number, now: number): void {
      const t = now - startMs;
      if (t - pushedAt < 500 && samples.length) samples[samples.length - 1] = { t, f }; else { samples.push({ t, f }); pushedAt = t; }
      samples = samples.filter((s) => s.t >= t - ESTIMATE_WINDOW_MS * 1.5);
    },
    estimate: () => estimateRemaining(samples),
  };
}

// DC-105 (FB-62): how long a full rescan will take, said before it starts.

/** Over this, Rescan asks first; under it, it just starts. */
export const RESCAN_ASK_MS = 2 * 60 * 1000;
/** With no full scan on record: about half a second per service (79 services, 133 maps and apps took 50 s: live-performance-2026-10-15.md). */
export const RESCAN_FALLBACK_MS_PER_ITEM = 500;

/** How long the last full scan took and how many services it read (kept with the cached result). */
export interface FullScanStat { ms: number; items: number }

/**
 * The last full scan's time, scaled to the services there are now; with none on record, the per-service rate.
 * `measured` is false for the fallback, which the copy calls "roughly".
 */
export function rescanEstimate(items: number, last?: FullScanStat | null): { ms: number; measured: boolean } {
  const n = Math.max(0, items);
  if (last && last.ms > 0 && last.items > 0) return { ms: last.ms * (n / last.items), measured: true };
  return { ms: n * RESCAN_FALLBACK_MS_PER_ITEM, measured: false };
}

/** A friendly length of time, without a lead word: "a minute", "7 minutes", "25 minutes", "an hour", "2 hours". */
export function sayDuration(ms: number): string {
  const min = ms / 60000;
  if (min < 1.5) return t('scan.time.a-minute');
  if (min < 10) return tn('scan.time.minutes', Math.round(min), { count: Math.round(min) });
  if (min < 52.5) return t('scan.time.minute-round', { count: Math.round(min / 5) * 5 });
  if (min < 67.5) return t('scan.time.hour');
  const halves = Math.round(min / 30) / 2;
  if (halves === 1.5) return t('scan.time.hour-half');
  return Number.isInteger(halves) ? t('scan.time.hours', { count: halves }) : t('scan.time.hours-half', { count: Math.floor(halves) });
}

/** "about 25 minutes, based on your last full scan", or "roughly 25 minutes, going by how many services there are". */
export function sayRescan(e: { ms: number; measured: boolean }): string {
  return t(e.measured ? 'scan.time.measured' : 'scan.time.estimated', { duration: sayDuration(e.ms) });
}
