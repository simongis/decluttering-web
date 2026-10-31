// Tidy priority (ADR 0010). Pure TS: no DOM. Mirrors prototypes/d-converged/model.js; the tests mirror each other.
import type { Row } from './types';
import { agoDays, formatMB } from './format';
import { getLocale, t, tn } from '../i18n';

export type Priority = 'start' | 'look' | 'low';
export type SortKey = 'priority' | 'credits' | 'updated' | 'views';

/** 10 MB of storage, in credits a month. A family at or above this is high impact however large the set's top is. */
export const IMPACT_FLOOR_CREDITS = 2.4;
/** 1 MB: at or above this a family is never "Low impact" on size alone. */
export const LOW_FLOOR_CREDITS = 0.24;
export const PRIORITY_LABELS: Record<Priority, string> = { get start() { return t('domain.priority.start'); }, get look() { return t('domain.priority.look'); }, get low() { return t('domain.priority.low'); } };
export const PRIORITY_RANK: Record<Priority, number> = { start: 0, look: 1, low: 2 };
/** Dots shown next to the label (never colour alone). */
export const PRIORITY_DOTS: Record<Priority, number> = { start: 3, look: 2, low: 1 };
/** Narrow reach: only the owner, or groups. Anything else (org, public, unknown) is wide. */
const NARROW = new Set(['private', 'shared']);

const plural = (n: number) => tn(n === 1 ? 'review.reason.mapUses' : 'review.reason.mapsUse', n);

/** Credits a family needs to count as high impact: top third of the stale set, or the 10 MB floor, whichever is lower. */
export function impactCutoff(staleRows: Pick<Row, 'credits'>[]): number {
  const sorted = staleRows.map((r) => r.credits).sort((a, b) => b - a);
  if (!sorted.length) return IMPACT_FLOOR_CREDITS;
  return Math.min(sorted[Math.ceil(sorted.length / 3) - 1] as number, IMPACT_FLOOR_CREDITS);
}

/** Credits of the largest family still in the bottom third of the stale set. */
export function lowCutoff(staleRows: Pick<Row, 'credits'>[]): number {
  const sorted = staleRows.map((r) => r.credits).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.ceil(sorted.length / 3) - 1] as number;
}

/** DC-083: a wide-reach family counts as a Quick win only when nobody has used it for a year or more (or no use is recorded). */
export const LONG_UNUSED_DAYS = 365;

/** DC-100: the two cutoffs depend only on the stale set, so they are sorted out once per set, not once per row. */
const cutoffMemo = new WeakMap<object, { n: number; low: number; impact: number }>();
export const cutoffsOf = (staleRows: Pick<Row, 'credits'>[]): Cutoffs => {
  let c = cutoffMemo.get(staleRows);
  if (!c || c.n !== staleRows.length) { c = { n: staleRows.length, low: lowCutoff(staleRows), impact: impactCutoff(staleRows) }; cutoffMemo.set(staleRows, c); }
  return c;
};

type PriorityRow = Pick<Row, 'credits' | 'sizeMB' | 'usedBy' | 'lastUsedDaysAgo'> & {
  sizeKnown?: boolean; useKnown?: boolean; noUseRecorded?: boolean; source: Pick<Row['source'], 'access'>;
};

export interface Cutoffs { low: number; impact: number }

/** Which band a row falls in, from its own numbers and the cutoffs of the stale set. No wording is made (DC-100b: this runs for every family). */
export function classifyPriority(row: PriorityRow, cut: Cutoffs, depsKnown: boolean, useKnown: boolean = row.useKnown ?? true): { priority: Priority; lowBand: boolean } {
  const longUnused = useKnown && (!!row.noUseRecorded || row.lastUsedDaysAgo === null || row.lastUsedDaysAgo >= LONG_UNUSED_DAYS);
  const narrow = NARROW.has(row.source.access);
  const sizeKnown = row.sizeKnown ?? true;
  const lowBand = sizeKnown && (row.credits === 0 || (row.credits < LOW_FLOOR_CREDITS && row.credits <= cut.low));
  const high = sizeKnown && !lowBand && row.credits > 0 && row.credits >= cut.impact;
  let priority: Priority;
  if (lowBand) priority = 'low';
  else if (depsKnown && row.usedBy > 0 && !narrow) priority = 'low';
  else if (high && depsKnown && row.usedBy === 0 && useKnown && (narrow || longUnused)) priority = 'start';
  else priority = 'look';
  return { priority, lowBand };
}

/** `staleRows` is the whole stale set, including `row`. One plain reason line; it never says "delete". */
export function priorityOf(row: PriorityRow, staleRows: Pick<Row, 'credits'>[], opts: { depsKnown?: boolean } = {}): { priority: Priority; reason: string } {
  const useKnown = row.useKnown ?? true;
  const depsKnown = opts.depsKnown ?? true;
  const { priority, lowBand } = classifyPriority(row, cutoffsOf(staleRows), depsKnown);
  const access = row.source.access;
  const sizeKnown = row.sizeKnown ?? true;
  // An unmeasured size can't be called small or big: it stays Worth a look until it is measured (DC-053).
  const size = sizeKnown ? formatMB(row.sizeMB) : t('domain.priority.sizeUnknown');
  if (lowBand) return { priority, reason: t('domain.priority.lowReason', { label: PRIORITY_LABELS.low, size }) };
  const reach = access === 'private' ? t('domain.priority.reach.private') : access === 'shared' ? t('domain.priority.reach.shared')
    : access === 'public' ? t('domain.priority.reach.public') : t('domain.priority.reach.org');
  const use = !depsKnown ? t('domain.priority.checking') : row.usedBy > 0 ? `${plural(row.usedBy)} it`
    : !useKnown ? t('domain.priority.useUnknown')
    : row.noUseRecorded ? t('domain.priority.noUse')
    : row.lastUsedDaysAgo === null ? t('domain.priority.noRequests')
    : t('domain.priority.lastUsed', { ago: agoDays(row.lastUsedDaysAgo) });
  return { priority, reason: t('domain.priority.reason', { label: PRIORITY_LABELS[priority], size, reach, use }) };
}

type Sortable = Pick<Row, 'credits' | 'sizeMB' | 'daysSinceUpdate'> & { source: Pick<Row['source'], 'title'>; priority?: Priority; sizeKnown?: boolean; numViews?: number | null };

const unknownLast = (a: Sortable, b: Sortable): number => Number(a.sizeKnown === false) - Number(b.sizeKnown === false);
/** Rebuild only when the selected locale changes. */
let collatorLocale = '';
let collator: Intl.Collator;
function compareTitles(a: string, b: string): number {
  const locale = getLocale();
  if (locale !== collatorLocale) { collator = new Intl.Collator(locale); collatorLocale = locale; }
  return collator.compare(a, b);
}
/** Most credits first; unmeasured sizes go last (DC-053). */
export const byCredits = (a: Sortable, b: Sortable): number =>
  unknownLast(a, b) || b.credits - a.credits || b.sizeMB - a.sizeMB || compareTitles(a.source.title, b.source.title);
const rank = (r: Sortable) => PRIORITY_RANK[r.priority ?? 'low'];
export const byPriority = (a: Sortable, b: Sortable): number => rank(a) - rank(b) || byCredits(a, b);
const byUpdated = (a: Sortable, b: Sortable): number => b.daysSinceUpdate - a.daysSinceUpdate || byCredits(a, b);
/** FB-61: least viewed all time first (the quietest layers are the safest nudges); rows without a view count go last. */
const byViews = (a: Sortable, b: Sortable): number =>
  (a.numViews ?? Infinity) - (b.numViews ?? Infinity) || byCredits(a, b);

/** A sorted copy. Priority (then credits) is the default; "updated" puts the longest-untouched first, "views" the least viewed. */
export function sortRows<T extends Sortable>(rows: readonly T[], key: SortKey = 'priority'): T[] {
  return [...rows].sort(key === 'credits' ? byCredits : key === 'updated' ? byUpdated : key === 'views' ? byViews : byPriority);
}
