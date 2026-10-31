// The Suggested preset (DC-034, docs/research/adaptive-presets.md), ported from prototype D (model.js). Pure TS: no DOM.
import type { Data, Thresholds } from './types';
import { PRESETS, matchPreset, scoredFamilies, span, unusedFor, type PresetName, type UseInfo } from './stale';
import { formatNumber, t, tn } from '../i18n';

/**
 * [minDaysSinceUse, minDaysSinceUpdate, maxUsedBy], gentlest to strictest (DC-083: last used and last updated, 1 year
 * down to 3 months). Each rung flags at least what the one before it does. Rung values are placeholders (TBC):
 * DC-031 recalibrates them. Never beyond Strict.
 */
export const LADDER: readonly (readonly [number, number, number])[] = [
  [365, 365, 0], [365, 365, 1], [270, 270, 1], [180, 180, 1], [180, 180, 2], [90, 180, 2], [90, 90, 2],
];
/**
 * Minimum sizes Suggested may pick, smallest first (DC-055). Never below 10 MB: smaller services save little.
 * The rule: the ladder decides use, age and used-by. At the rung where the climb stops, start at 10 MB;
 * while that would flag more than the target or more than 40 owners, step up to 15 MB, then 20 MB.
 * The target is about 15% of the services of at least 10 MB (or not measured yet), so an org of mostly small
 * services still gets a suggestion.
 * A step is taken only if it still flags at least half the target. Only then does the owner cap send the
 * suggestion back to the gentler rung. Unknown sizes always count (DC-053).
 */
export const SUGGEST_SIZES: readonly number[] = [10, 15, 20];
/**
 * DC-083 (settles DC-084 bug 2): when no gentler rung is left and a rung still names more than 40 owners, the size
 * steps on through these before giving up. If 100 MB still names more than 40, the suggestion says so (capped).
 */
export const CAP_SIZES: readonly number[] = [20, 50, 100];
const SUGGEST = { share: 0.15, minTarget: 3, maxTarget: 300, minFamilies: 20, ownerCap: 40, floorShare: 0.5 }; // TBC with the ladder

export interface Suggestion {
  rung: number; thresholds: Thresholds; preset: PresetName;
  flagged: number; owners: number; target: number; total: number;
  /** Families of at least 10 MB (or not measured yet): the base for the target (DC-055). */
  eligible: number;
  /** More than 40 owners even at the gentlest rung with the largest size step: the sentence says so. */
  capped: boolean; refining: boolean;
}

/**
 * The gentlest rung that flags about 15% of the org's services (at least half of that), with at most 40 owners.
 * Returns null when there are too few services, no usage data, or the org looks tidy. Pure and deterministic.
 * While dependencies are unknown (`depsKnown: false`) the used-by test is skipped, so counts are upper bounds ("refining").
 */
export function suggest(data: Data, { depsKnown = true, countSweeps = false }: { depsKnown?: boolean; countSweeps?: boolean } = {}): Suggestion | null {
  const scored = scoredFamilies(data, countSweeps);
  const total = scored.length;
  if (total < SUGGEST.minFamilies) return null;
  const base = PRESETS.balanced;
  const complete = data.usageComplete !== false;
  const disabled = new Set(data.owners.filter((o) => o.disabled).map((o) => o.username));
  let anyUsage = false;
  const rows: { use: UseInfo; age: number; by: number; owner: string; size: number }[] = [];
  let eligible = 0;
  const floorMB = SUGGEST_SIZES[0] as number;
  // DC-100b: what a family scores apart from any rule is worked out once and shared with Review's rows (stale.ts scoredFamilies).
  for (const sc of scored) {
    if (sc.anyUsage) anyUsage = true;
    // Storage as in the rows: the source's (views store nothing). Unknown sizes pass every size test (DC-053, DC-055).
    const size = sc.sizeKnown ? sc.sizeMB : Infinity;
    if (!sc.sizeKnown || size >= floorMB) eligible++;
    if (disabled.has(sc.source.owner)) continue; // can't be emailed: not part of a batch
    rows.push({ use: sc.use, age: sc.daysSinceUpdate, by: sc.usedBy, owner: sc.source.owner, size });
  }
  if (!anyUsage) return null;
  const target = Math.max(SUGGEST.minTarget, Math.min(SUGGEST.maxTarget, Math.round(SUGGEST.share * eligible)));
  const floor = target * SUGGEST.floorShare;
  const build = (i: number, minSizeMB: number, flagged: number, owners: number, capped: boolean): Suggestion => {
    const [minDaysSinceUse, minDaysSinceUpdate, maxUsedBy] = LADDER[i] as readonly [number, number, number];
    const thresholds: Thresholds = { ...base, minDaysSinceUse, minDaysSinceUpdate, maxUsedBy, minSizeMB };
    return { rung: i, thresholds, preset: matchPreset(thresholds), flagged, owners, target, total, eligible, capped, refining: !depsKnown };
  };
  const count = (i: number, minSize: number) => {
    const [minUse, minAge, maxBy] = LADDER[i] as readonly [number, number, number];
    let m = 0;
    const owners = new Set<string>();
    for (const r of rows) if (unusedFor(r.use, minUse, complete) && r.age >= minAge && (!depsKnown || r.by <= maxBy) && r.size >= minSize) { m++; owners.add(r.owner); }
    return { m, owners: owners.size };
  };
  let last: Suggestion | null = null;
  for (let i = 0; i < LADDER.length; i++) {
    let size = SUGGEST_SIZES[0] as number;
    let c = count(i, size);
    for (const next of SUGGEST_SIZES.slice(1)) {
      if (c.m <= target && c.owners <= SUGGEST.ownerCap) break; // within target: keep the smaller minimum
      const k = count(i, next);
      if (k.m < floor) break;                                     // a bigger minimum would flag too few
      size = next; c = k;
    }
    if (c.owners > SUGGEST.ownerCap) {
      if (last) return last;
      // No gentler rung to fall back to: raise the minimum size until at most 40 owners remain (DC-084 bug 2).
      for (const next of CAP_SIZES) {
        if (next <= size) continue;
        const k = count(i, next);
        if (!k.m) break;
        size = next; c = k;
        if (c.owners <= SUGGEST.ownerCap) return build(i, size, c.m, c.owners, false);
      }
      return build(i, size, c.m, c.owners, true);
    }
    if (c.m >= floor) return build(i, size, c.m, c.owners, false);
    if (c.m > 0) last = build(i, size, c.m, c.owners, false);
  }
  return null;
}

/** One plain sentence about a suggestion, built from the result of suggest(); a capped one adds a sentence that says so. */
export function suggestSentence(s: Suggestion): string {
  const thresholds = s.thresholds, share = Math.max(1, Math.round(s.total / Math.max(1, s.flagged)));
  const by = thresholds.maxUsedBy === 0 ? t('domain.suggest.by.none') : t(thresholds.maxUsedBy === 1 ? 'domain.suggest.by.one' : 'domain.suggest.by.other', { count: formatNumber(thresholds.maxUsedBy) });
  const main = t('domain.suggest.main', {
    share, flagged: tn('common.unit.services', s.flagged, { count: formatNumber(s.flagged) }),
    owners: tn('common.unit.owners', s.owners, { count: formatNumber(s.owners) }),
    useSpan: span(thresholds.minDaysSinceUse), updateSpan: span(thresholds.minDaysSinceUpdate), by, size: thresholds.minSizeMB ?? 0,
  });
  return s.capped ? `${main}${t('domain.suggest.capped', { cap: SUGGEST.ownerCap, size: thresholds.minSizeMB ?? 0 })}` : main;
}
