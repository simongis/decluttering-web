// DC-064: what the dot map shows, from real scan events (ported from prototypes/d-converged/scan.js buildLive). Pure.
//
// Before the core is in: one dot per service found so far, light grey until its size is read, then grown to its size.
// After the core: one dot per family, coloured by how stale it is under Balanced (the stale zone), ringed when a map or
// app uses it. While maps and apps are still being read, the used-by rule is skipped (ADR 0007), so a dot can settle to
// grey as the reads arrive.
import type { Data, Owner, Row, Service, Thresholds } from '../../domain/types';
import { PRESETS, allRows, creditsPerMonth, evaluate, sweepsOf } from '../../domain/stale';
import { sweepSummary, type SweepSummary } from '../../domain/sweep';
import { sayWhy } from '../review/helpers';

/** What the search says about a service; url, modified and view-ness let the map place it before the core is in (DC-071c). */
export interface FoundItem {
  id: string; title: string; owner: string; url?: string; modified?: number; created?: number; isView?: boolean;
  /** DC-083: the search row's lastViewed (epoch ms; null or absent when blank). */
  lastViewed?: number | null;
}

/** Usage as it has landed: data requests per day per service name (lower case), keyed by timestamp. Complete windows only. */
export interface EarlyUsage { end: number; byName: ReadonlyMap<string, ReadonlyMap<number, number>> }

export type DotKind = 'pending' | 'sized' | 'fine' | 'stale';

export interface Dot {
  id: string; title: string; owner: string;
  /** Storage in MB (0 while not read). */
  sizeMB: number; sized: boolean; credits: number;
  kind: DotKind;
  /** Stale before used-by is applied: in the zone. A candidate that is not stale is in the zone but too used (or too small). */
  candidate: boolean;
  /** 0 (barely) .. 1 (very) */
  staleness: number;
  /** DC-083: days since last used (null: no use recorded, or none in the year read). */
  usedBy: number; lastUsedDaysAgo: number | null; daysSinceUpdate: number;
  /** Services in the family (the source and its views). */
  nSvc: number;
  why: string;
  /** DC-100: the words for a dot not yet read out. 7,000 are built on every update, only one is ever read, so `why` stays empty until `dotWhy` asks. */
  whyOf?: () => string;
  /** A view not yet linked to its source (before the core): it holds no storage of its own, so the size floor skips it. */
  view?: boolean;
}

export interface DotModel {
  dots: Dot[];
  /** Dots sit on the lens, not the grey grid: either the core's data is in, or (DC-071c) usage and last-updated are. */
  revealed: boolean;
  /** The core's data is in: dots are families, and the totals are real. False while the early picture is drawn. */
  exact: boolean;
  /** Lowest staleness among stale dots (at most 0.3), for the colour ramp. */
  staleMin: number;
  maxSizeMB: number;
  /** DC-082: before usage is in, every dot's last-updated date is known (from the search), so the map can place it across. */
  timed?: boolean;
  stats: { found: number; staleServices: number; credits: number; sizeMB: number };
  /** DC-086: days when many layers were touched at once (null: none found), and whether the admin counts them. */
  sweeps?: (SweepSummary & { counting: boolean }) | null;
}

export const SCAN_THRESHOLDS: Thresholds = PRESETS.balanced;

// The why line says "used by: still checking…" until every map and app is read, like the review (FB-15).
// A disabled owner's stale item stays on the map but is outside the stale total (the review lists it under "No one to nudge").
const DISABLED_WHY = "Owner can't be emailed: their account is disabled";
const dotOf = (r: Row, candidate: boolean, depsKnown: boolean): Dot => ({
  id: r.source.id, title: r.source.title, owner: r.owner.fullName || r.owner.username || r.source.owner,
  sizeMB: r.sizeMB, sized: r.sizeKnown, credits: r.credits,
  kind: r.stale ? 'stale' : 'fine', candidate,
  staleness: Math.min(1, Math.max(0, r.staleness)),
  usedBy: r.usedBy, lastUsedDaysAgo: r.lastUsedDaysAgo, daysSinceUpdate: r.daysSinceUpdate,
  nSvc: 1 + r.views.length, why: '', view: r.source.isView || undefined,
  whyOf: () => (r.stale && r.owner.disabled ? `${sayWhy(r, true, depsKnown)} · ${DISABLED_WHY}` : sayWhy(r, true, depsKnown)),
});

/** What the tip and the screen reader say about a dot. */
export const dotWhy = (d: Pick<Dot, 'why' | 'whyOf'>): string => d.why || d.whyOf?.() || '';

const DAY = 864e5;
const isoOf = (ms: number | undefined) => new Date(typeof ms === 'number' && ms > 0 ? ms : 0).toISOString();
const urlName = (u: string | undefined) => (u ? /\/services\/([^/]+)\//i.exec(u)?.[1]?.toLowerCase() ?? null : null);

/**
 * DC-071c: the services found so far, with the usage that has landed and the sizes read so far, as a provisional Data.
 * Unknown sizes are null (a small dot that grows later); views not linked yet stand alone (they merge when the core lands).
 */
export function earlyData(found: readonly FoundItem[], sized: ReadonlyMap<string, number>, usage: EarlyUsage, attached?: ReadonlyMap<string, number>): Data {
  const owners = new Map<string, Owner>();
  const services: Service[] = found.map((f) => {
    if (!owners.has(f.owner)) owners.set(f.owner, { username: f.owner, fullName: '', disabled: false, thumbnail: null, lastNotified: null });
    const byDay = new Map<number, number>();
    const name = urlName(f.url);
    for (const [ms, c] of (name ? usage.byName.get(name) : undefined) ?? []) {
      const ago = Math.max(0, Math.floor((usage.end - ms) / DAY));
      if (c > 0) byDay.set(ago, (byDay.get(ago) ?? 0) + c);
    }
    const mb = sized.get(f.id);
    return {
      id: f.id, title: f.title, owner: f.owner, created: isoOf(f.created), modified: isoOf(f.modified), sizeMB: mb ?? null, ...(mb !== undefined && attached?.has(f.id) ? { attachmentMB: attached.get(f.id) } : {}),
      access: '', isView: !!f.isView, sourceId: null, usage: [...byDay].sort((a, b) => a[0] - b[0]), dependencies: [],
      // DC-083: the tap passes lastViewed on; a search that did not carry the field leaves it absent (requests only).
      ...(f.lastViewed !== undefined ? { lastViewed: typeof f.lastViewed === 'number' && f.lastViewed > 0 ? isoOf(f.lastViewed) : null } : {}),
    } satisfies Service;
  });
  return { org: { id: '', name: '', urlKey: '', scannedAt: new Date(usage.end).toISOString() }, owners: [...owners.values()], services };
}

export function buildDots(
  input: { found: readonly FoundItem[]; sized: ReadonlyMap<string, number>; /** DC-134: of those sizes, the attachments' MB. */ attached?: ReadonlyMap<string, number>; data: Data | null; depsKnown: boolean; usage?: EarlyUsage | null; now?: number; countSweeps?: boolean },
  t: Thresholds = SCAN_THRESHOLDS,
): DotModel {
  const { found, sized, depsKnown } = input;
  const countSweeps = !!input.countSweeps;
  let { data } = input;
  // Usage and last-updated are all the "How stale" lens needs: place dots on it before the core is in.
  const early = !data && !!input.usage && found.length > 0 && found.every((f) => f.modified !== undefined);
  if (early) data = earlyData(found, sized, input.usage as EarlyUsage, input.attached);
  let dots: Dot[];
  let stats: DotModel['stats'];
  let timed = false;
  if (!data) {
    const now = input.now ?? Date.now();
    timed = found.length > 0 && found.every((f) => typeof f.modified === 'number' && f.modified > 0);
    dots = found.map((f) => {
      const mb = sized.get(f.id);
      return {
        id: f.id, title: f.title, owner: f.owner, sizeMB: mb ?? 0, sized: mb !== undefined, credits: creditsPerMonth(mb ?? 0, input.attached?.get(f.id)),
        kind: mb !== undefined ? 'sized' : 'pending', candidate: false, staleness: 0.5,
        usedBy: 0, lastUsedDaysAgo: null, daysSinceUpdate: timed ? Math.max(0, Math.floor((now - (f.modified as number)) / DAY)) : 0,
        nSvc: 1, why: 'Still being read', view: f.isView || undefined,
      } satisfies Dot;
    });
    stats = { found: found.length, staleServices: 0, credits: 0, sizeMB: 0 };
  } else {
    const order = new Map(found.map((f, i) => [f.id, i]));
    const inZone = new Set(allRows(data, t, { depsKnown: false, countSweeps }).filter((r) => r.stale).map((r) => r.source.id));
    const rows = allRows(data, t, { depsKnown, countSweeps })
      .sort((a, b) => (order.get(a.source.id) ?? 1e9) - (order.get(b.source.id) ?? 1e9));
    dots = rows.map((r) => dotOf(r, inZone.has(r.source.id), depsKnown));
    if (early) stats = { found: found.length, staleServices: 0, credits: 0, sizeMB: 0 }; // not the real totals yet
    else {
      // Same totals as the review: reachable owners only (disabled owners sit in "No one to nudge").
      const T = evaluate(data, t, { depsKnown, countSweeps }).totals;
      stats = { found: data.services.length, staleServices: T.services, credits: T.credits, sizeMB: T.sizeMB };
    }
  }
  const staleMin = Math.min(0.3, ...dots.filter((d) => d.kind === 'stale').map((d) => d.staleness));
  const maxSizeMB = Math.max(1, ...dots.map((d) => d.sizeMB));
  // The note on the finish line speaks only once the real data is in (DC-086).
  const found1 = data && !early ? sweepSummary(sweepsOf(data), Date.parse(data.org.scannedAt)) : null;
  const sweeps = found1 ? { ...found1, counting: countSweeps } : null;
  return { dots, revealed: !!data, exact: !!data && !early, staleMin, maxSizeMB, timed, stats, sweeps };
}

/** Where a stale dot sits on the amber to raspberry ramp, 0..1. */
export const rampK = (d: Pick<Dot, 'staleness'>, staleMin: number): number =>
  Math.min(1, Math.max(0, (d.staleness - staleMin) / Math.max(0.05, 1 - staleMin)));

/** A ring means a map or app uses it. Outside the "Used by maps" lens only dots in the stale zone get one. */
export const ringed = (d: Pick<Dot, 'usedBy' | 'candidate'>, lens: string): boolean => d.usedBy > 0 && (d.candidate || lens === 'used');

/** DC-079: measured layers under this size are left off the dot map by default (a display floor; the scan counts everything). */
export const SMALL_LAYER_MB = 3;

/** FB-52: an org with fewer hosted feature layers than this shows them all; the small-layer floor only helps big maps. */
export const SHOW_ALL_BELOW = 150;

/** Below this a measured dot has no storage of its own (a hosted view, an empty layer): the "no storage" column on How big. */
export const NO_STORAGE_MB = 0.1;

export interface HiddenSmall {
  /** Small measured fine dots under the floor (any lens). */
  count: number; sizeMB: number; credits: number;
  /** FB-43: dots with no storage the floor keeps (views, stale or in-zone empties), left off How big only. */
  noStorage: number;
}

/**
 * The model to draw with small, measured, fine dots left out, and what was left out. Unmeasured dots stay until their size
 * is known; stale, candidate and unlinked view dots always stay. `stats` and `maxSizeMB` are untouched. With `show` nothing is left out,
 * but `hidden` still reports what the floor would hide.
 *
 * FB-43: with `hideNoStorage` (the How big lens) the rest of the "no storage" column goes too: on a storage axis a dot with
 * no storage says nothing. On the other lenses those dots stay, because there they are real families placed by how stale
 * or how used they are (DC-079: hiding views there hid real families).
 */
export function withSmallFloor(model: DotModel, opts: { floorMB: number; show: boolean; hideNoStorage?: boolean }): { model: DotModel; hidden: HiddenSmall } {
  const hidden: HiddenSmall = { count: 0, sizeMB: 0, credits: 0, noStorage: 0 };
  const keep = model.dots.filter((d) => {
    if (d.sized && d.sizeMB < opts.floorMB && d.kind !== 'stale' && !d.candidate && !d.view) {
      hidden.count++; hidden.sizeMB += d.sizeMB; hidden.credits += d.credits;
      return opts.show;
    }
    if (opts.hideNoStorage && d.sized && d.sizeMB < NO_STORAGE_MB) { hidden.noStorage++; return opts.show; }
    return true;
  });
  return { model: keep.length === model.dots.length ? model : { ...model, dots: keep }, hidden };
}
