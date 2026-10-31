// DC-064: the dot map's scales, ported from prototypes/d-converged/scan.js. Pure: fractions of the plot, 0..1, y up.
import type { Thresholds } from '../../domain/types';
import { fmtInt } from '../../domain/format';
import { NO_STORAGE_MB } from './dots';
import { t, tn } from '../../i18n';

export type LensId = 'stale' | 'big' | 'used';
export const LENSES: { id: LensId; readonly label: string; readonly note: string }[] = [
  { id: 'stale', get label() { return t('scan.lens.stale'); }, get note() { return t('scan.lens.stale-note'); } },
  { id: 'big', get label() { return t('scan.lens.big'); }, get note() { return t('scan.lens.big-note'); } },
  { id: 'used', get label() { return t('scan.lens.used'); }, get note() { return t('scan.lens.used-note'); } },
];

export const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
/** Stable jitter per dot, 0..1. */
export const hash = (i: number, k: number): number => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };

// How stale, across: piecewise by time since update. 3 years+ is a band, not a wall.
const X_STOPS: [number, number][] = [[0, 0], [90, 0.16], [180, 0.31], [365, 0.5], [730, 0.71], [1095, 0.87]];
export const X_BAND: [number, number] = [0.915, 0.985];
export function xUpdate(days: number, i: number): number {
  if (days >= 1095) return X_BAND[0] + hash(i, 1) * (X_BAND[1] - X_BAND[0]);
  for (let k = 1; k < X_STOPS.length; k++) {
    const a = X_STOPS[k - 1] as [number, number], b = X_STOPS[k] as [number, number];
    if (days <= b[0]) return a[1] + (Math.max(0, days) - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
  }
  return 0.87;
}

// How stale, up (DC-083): time since last used. "No use recorded" is its own band at the top; the rest piecewise.
export const Y_BAND: [number, number] = [0.9, 0.985];
const Y_STOPS: [number, number][] = [[0, 0.03], [30, 0.14], [90, 0.3], [180, 0.47], [365, 0.66], [730, 0.84]];
/** Plot fraction for a last use `days` ago (no jitter). Beyond 2 years it stays just under the top band. */
export function yLastUsed(days: number): number {
  const d = Math.max(0, days);
  for (let k = 1; k < Y_STOPS.length; k++) {
    const a = Y_STOPS[k - 1] as [number, number], b = Y_STOPS[k] as [number, number];
    if (d <= b[0]) return a[1] + (d - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
  }
  return Math.min(0.88, 0.84 + (d - 730) / 730 * 0.04);
}
/** A dot's height: null (no use recorded, or none in the year read) sits in the top band, jittered so they don't pile up. */
export const yUsedAgo = (days: number | null, i: number): number => (days === null
  ? Y_BAND[0] + hash(i, 2) * (Y_BAND[1] - Y_BAND[0])
  : clamp(yLastUsed(days) + (hash(i, 2) - 0.5) * 0.012, 0.01, 0.89));

/** Staleness is capped at 1, so the very stale pile up at the top: spread them through a top band instead. */
export const yStale = (staleness: number, i: number): number => (staleness >= 0.97
  ? Y_BAND[0] + hash(i, 5) * (Y_BAND[1] - Y_BAND[0])
  : clamp(staleness + (hash(i, 5) - 0.5) * 0.05, 0.02, 0.88));

// How big: no-storage items (hosted views, empty layers) form their own band at the left; the rest spread on a log scale.
const SIZE_BAND: [number, number] = [0, 0.06], SIZE_LO = NO_STORAGE_MB;
export const xSize = (mb: number, i: number, maxMB: number): number => (mb < SIZE_LO
  ? SIZE_BAND[0] + hash(i, 3) * (SIZE_BAND[1] - SIZE_BAND[0])
  : 0.1 + 0.88 * clamp((Math.log10(mb) - Math.log10(SIZE_LO)) / Math.max(1e-6, Math.log10(Math.max(maxMB, 0.2)) - Math.log10(SIZE_LO))));

/** Used by maps: four columns (none, 1, 2, 3 or more). */
export const xUsed = (usedBy: number, i: number): number => (Math.min(3, usedBy) + 0.5) / 4 + (hash(i, 4) - 0.5) * 0.17;

/** A dot's place on a lens, as plot fractions (x right, y up). */
export function lensPoint(
  lens: LensId, d: { usedBy: number; lastUsedDaysAgo: number | null; daysSinceUpdate: number; sizeMB: number; staleness: number }, i: number,
  _t: Thresholds, maxMB: number,
): [number, number] {
  if (lens === 'stale') return [xUpdate(d.daysSinceUpdate, i), yUsedAgo(d.lastUsedDaysAgo, i)];
  if (lens === 'big') return [xSize(d.sizeMB, i, maxMB), yStale(d.staleness, i)];
  return [xUsed(d.usedBy, i), yStale(d.staleness, i)];
}

/** The stale zone on "How stale": from minDaysSinceUpdate across, and from minDaysSinceUse up (plot fractions). */
export function staleZone(t: Thresholds): { x: number; y: number } {
  return { x: xUpdate(t.minDaysSinceUpdate, 0), y: yLastUsed(t.minDaysSinceUse) };
}

/** FB-63 (DC-106): the stale zone's box in canvas pixels, for a plot of `plot` with `inset` pixels of margin. `left` is the dashed border's
 *  x, snapped to a pixel centre. It is always inside the drawable area (the plot's left edge to its right edge), for any threshold. */
export function zoneBox(
  plot: { x0: number; y0: number; w: number; h: number }, inset: number, t: Thresholds,
): { left: number; right: number; top: number; bottom: number } {
  const z = staleZone(t);
  const gx = (n: number) => plot.x0 + inset + n * (plot.w - 2 * inset), gy = (n: number) => plot.y0 + inset + (1 - n) * (plot.h - 2 * inset);
  const right = plot.x0 + plot.w - 2;
  const left = Math.min(right - 1, Math.max(plot.x0 + 1, Math.round(gx(z.x) - 0.5) + 0.5));
  return { left, right, top: plot.y0 + 2.5, bottom: Math.round(gy(z.y)) + 0.5 };
}

export const RAMP = { from: '#faa61a', mid: '#e0642f', to: '#b01f59' }; // Amber -> Raspberry
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], k: number) => a.map((v, i) => v + ((b[i] as number) - v) * k);
/** 0 (barely stale, amber) .. 1 (very stale, raspberry). DC-135: the console look passes its own ramp. */
export function rampColour(k: number, ramp: { from: string; mid: string; to: string } = RAMP): string {
  const [cA, cM, cR] = [hex(ramp.from), hex(ramp.mid), hex(ramp.to)] as [number[], number[], number[]];
  k = clamp(k);
  const c = k < 0.5 ? mix(cA, cM, k * 2) : mix(cM, cR, (k - 0.5) * 2);
  return `rgb(${c.map(Math.round).join(',')})`;
}

/*
 * DC-071b (FB-18): the dot map grows with the count. Today's height up to GROW_ABOVE dots, then with the square root of
 * the count so density stays roughly even, capped at a share of the viewport (and never below the base height).
 */
export const GROW_ABOVE = 1000;
export const HEIGHT_CAP_VH = 0.7;
export const HEIGHT_MAX_PX = 900;
export function mapHeight(width: number, dots: number, viewportH: number): number {
  const base = Math.round(clamp(width * 0.58, 300, 460));
  if (dots <= GROW_ABOVE) return base;
  const cap = Math.max(base, Math.min(HEIGHT_MAX_PX, Math.round(viewportH * HEIGHT_CAP_VH)));
  return Math.round(Math.min(cap, base * Math.sqrt(dots / GROW_ABOVE)));
}

/** Above this many dots, not-stale ones are drawn as shading; stale and at-risk ones stay dots (FB-18). */
export const DENSITY_ABOVE = 3000;

/** Counts of points per square cell of `cell` px, keyed "col,row". */
export function densityBins(points: Iterable<[number, number]>, cell: number): Map<string, number> {
  const bins = new Map<string, number>();
  for (const [x, y] of points) {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  return bins;
}

/** Shading strength for a cell, 0..1: log-scaled so one dot still shows and dense cells don't go black. */
export const densityAlpha = (count: number, max: number): number =>
  count <= 0 ? 0 : 0.12 + 0.5 * (Math.log1p(count) / Math.log1p(Math.max(1, max)));

/*
 * DC-082 (FB-33): motion. Every dot carries its own motion in plot fractions (so it follows the plot as the height eases),
 * retargeted from wherever it is drawn: an update mid-flight never jumps, and an unchanged target keeps its motion running.
 * New dots fade and grow in, staggered by a few ms each and capped so a page of 7,000 does not crawl. Under
 * prefers-reduced-motion durations are 0 (no travel) and entry is a short fade only.
 */
export const ENTER_MS = 420, FADE_MS = 160, TRAVEL_MS = 800, LENS_MS = 750, HEIGHT_MS = 650;
export const STAGGER_MAX_MS = 360, STAGGER_STEP_MS = 3;
/** Extra spread on a lens change, so the dots glide as a soft wave rather than one block. */
export const LENS_STAGGER_MS = 140;

export const smoothstep = (k: number): number => k * k * (3 - 2 * k);
/** Eased 0..1 from `start` over `dur`; 0 before it starts (a staggered dot waits), 1 when `dur` is 0. */
export const progress = (now: number, start: number, dur: number): number => (dur <= 0 ? (now >= start ? 1 : 0) : smoothstep(clamp((now - start) / dur)));

/** How long the `rank`-th dot of a batch of `batch` waits before it starts: a few ms each, all within STAGGER_MAX_MS. */
export function staggerDelay(rank: number, batch: number): number {
  if (batch <= 1) return 0;
  const total = Math.min(STAGGER_MAX_MS, (batch - 1) * STAGGER_STEP_MS);
  return (clamp(rank, 0, batch - 1) / (batch - 1)) * total;
}

/** A new dot's look at entry progress p (linear 0..1): fade in and grow from radius 0 with a slight pop. Reduced: fade only. */
export function entryLook(p: number, reduce: boolean): { alpha: number; scale: number } {
  p = clamp(p);
  if (reduce) return { alpha: p, scale: 1 };
  if (p >= 1) return { alpha: 1, scale: 1 };
  const q = p - 1, C = 1.2; // ease-out-back: a pop of about 5% before it settles
  return { alpha: clamp(p * 1.6), scale: Math.max(0, 1 + (C + 1) * q * q * q + C * q * q) };
}

/** A dot's travel: from (fx, fy, fr) to (tx, ty, tr), x and y as plot fractions, r in px. */
export interface Motion { fx: number; fy: number; fr: number; tx: number; ty: number; tr: number; start: number; dur: number }
export type Place = [x: number, y: number, r: number];

export function motionAt(m: Motion, now: number): Place {
  const k = progress(now, m.start, m.dur);
  if (k >= 1) return [m.tx, m.ty, m.tr];
  return [m.fx + (m.tx - m.fx) * k, m.fy + (m.ty - m.fy) * k, m.fr + (m.tr - m.fr) * k];
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
/**
 * Send a dot to `to`, starting from where it is drawn at `now` (or place it there when it has no motion yet). The same
 * target returns the running motion unchanged.
 */
export function retarget(m: Motion | null, now: number, to: Place, delay: number, dur: number): Motion {
  if (m && near(m.tx, to[0], 1e-5) && near(m.ty, to[1], 1e-5) && near(m.tr, to[2], 0.01)) return m;
  const [fx, fy, fr] = m ? motionAt(m, now) : to;
  return { fx, fy, fr, tx: to[0], ty: to[1], tr: to[2], start: now + delay, dur };
}

/** A one-number tween (the map's height). */
export interface Tween { from: number; to: number; start: number; dur: number }
export const tweenAt = (t: Tween, now: number): number => {
  const k = progress(now, t.start, t.dur);
  return k >= 1 ? t.to : t.from + (t.to - t.from) * k;
};
/** Ease to `to` from the value drawn at `now`; the same target keeps the running tween. */
export function heightTween(t: Tween | null, now: number, to: number, dur: number): Tween {
  if (t && t.to === to) return t;
  return { from: t ? tweenAt(t, now) : to, to, start: now, dur: t ? dur : 0 };
}
export const tweenDone = (t: Tween, now: number): boolean => progress(now, t.start, t.dur) >= 1;

/** Before usage is in: across by last updated (known from the search), and a calm, stable spread up the plot. */
export const waitY = (i: number): number => 0.1 + hash(i, 6) * 0.72;
export const prePoint = (daysSinceUpdate: number, i: number): [number, number] => [xUpdate(daysSinceUpdate, i), waitY(i)];

/** Unmeasured dots before usage: small, and smaller still when there are thousands. */
export const pendingRadius = (count: number): number => clamp(2.6 - 0.45 * Math.sqrt(Math.max(0, count - 100) / 1000), 1.4, 2.6);

/** Radius for a measured dot: storage on a square-root scale. */
export const sizeRadius = (sizeMB: number, maxMB: number, wide: boolean): number => 2.6 + Math.sqrt(Math.max(0, sizeMB) / Math.max(1e-6, maxMB)) * (wide ? 11 : 8);

/**
 * FB-30: what the left column on "How big" holds. With the size floor on that is only views (no storage of their own),
 * empty layers, and dots whose size is not measured yet; the label and note say which.
 */
export function sizeBand(dots: readonly { sized: boolean; sizeMB: number }[]): { label: string; note: string } {
  let unmeasured = 0, none = 0;
  for (const d of dots) { if (!d.sized) unmeasured++; else if (d.sizeMB < SIZE_LO) none++; }
  const f = fmtInt;
  if (unmeasured && none) return { label: t('scan.size.minimal-or-unmeasured'), note: t('scan.size.combine', { unmeasured: tn('scan.size.unmeasured-count', unmeasured, { count: f(unmeasured) }), minimal: tn('scan.size.minimal-count', none, { count: f(none) }) }) };
  if (unmeasured) return { label: t('scan.size.unmeasured'), note: tn('scan.size.unmeasured-count', unmeasured, { count: f(unmeasured) }) };
  // Under 0.1 MB: a hosted view has none of its own, a tiny layer a little, so "minimal", not "no storage" (user, 2026-10-23).
  return { label: t('scan.size.minimal'), note: none ? tn('scan.size.minimal-count', none, { count: f(none) }) : '' };
}

/** A stable jitter index from an item id (FNV-1a), so a dot keeps its place when the floor or a merge removes others. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) { h ^= id.charCodeAt(k); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1000003;
}
