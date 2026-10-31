// Pure helpers for the review components (tone-guide copy, tick state, sparkline geometry). No DOM.
import type { Option, OwnerGroup, Row, Thresholds } from '../../domain/types';
import { describe, lastUsedWords, span, viewsWords } from '../../domain/stale';
import { fmtMonthYear, formatMB } from '../../domain/format';
import { credit, plural } from '../shared/text';

/** Tick state: items, not owners, carry the tick. A recently nudged owner starts with every item unticked. */
export const itemOn = (items: ReadonlyMap<string, boolean>, o: OwnerGroup, r: Row): boolean =>
  items.get(r.source.id) ?? !o.nudgedRecently;

export const svcCount = (r: Row): number => 1 + r.views.length;
export const sumSvc = (rows: Row[]): number => rows.reduce((a, r) => a + svcCount(r), 0);
export const includedRows = (items: ReadonlyMap<string, boolean>, o: OwnerGroup): Row[] => o.rows.filter((r) => itemOn(items, o, r));

/** The rule in plain words, as displayed (tone guide rewrites 5, 7, 8, 9). Skips the usage clause when usage is hidden. */
export function sayRule(t: Thresholds, canSeeUsage: boolean, member = false): string {
  const who = member ? 'We pick out your layers' : 'We pick out layers';
  if (canSeeUsage) return describe(t).replace('We flag a layer', who);
  const by = t.maxUsedBy === 0 ? 'no maps or apps use it' : `at most ${plural(t.maxUsedBy, 'map or app', 'maps or apps')} ${t.maxUsedBy === 1 ? 'uses' : 'use'} it`;
  const size = t.minSizeMB ? ` and it is at least ${t.minSizeMB >= 1024 ? `${t.minSizeMB / 1024} GB` : `${t.minSizeMB} MB`}` : '';
  return `${who} that were last updated more than ${span(t.minDaysSinceUpdate)} ago, where ${by}${size}. Usage isn't available with your access, so it isn't part of the rule.`;
}

type WhyRow = Pick<Row, 'lastUsedDaysAgo' | 'useKnown' | 'noUseRecorded' | 'lastModified' | 'usedBy'> & Partial<Pick<Row, 'numViews'>>;

/**
 * The "why" line under a row (DC-083): "Last used 8 months ago · last updated Mar 2024 · used by 1 map or app ·
 * 585,557 views all time". Without usage access it leaves out the last-used clause. `stopped`: the scan was stopped early.
 */
export function sayWhy(row: WhyRow, canSeeUsage: boolean, depsKnown = true, stopped = false): string {
  const by = !depsKnown ? (stopped ? 'used by: not checked' : 'used by: still checking…')
    : row.usedBy === 0 ? 'no maps or apps use it' : `used by ${plural(row.usedBy, 'map or app', 'maps or apps')}`;
  const views = viewsWords(row.numViews);
  const parts = [`last updated ${fmtMonthYear(row.lastModified)}`, by, ...(views ? [views] : [])];
  if (canSeeUsage) parts.unshift(lastUsedWords(row));
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The size chip: "2 MB" or "14.6 MB", or "Size not measured yet" while sizing runs, "Size not measured" after a stop (DC-053). */
export const saySize = (row: Pick<Row, 'sizeMB' | 'sizeKnown'>, stopped = false): string =>
  row.sizeKnown ? formatMB(row.sizeMB) : stopped ? 'Size not measured' : 'Size not measured yet';

/** The credit chip's label and tooltip. DC-134: names the attachments when there are some, since they cost far less per MB. */
export const sayCredits = (row: Pick<Row, 'credits' | 'attachmentMB'>): string =>
  `About ${credit(row.credits)} credits a month` + (row.attachmentMB >= 0.05
    ? `. Includes ${formatMB(row.attachmentMB)} of attachments, billed as file storage at a much lower rate.`
    : '');

export interface SparkBar { x: number; y: number; h: number; zero: boolean }
export interface SparkGeometry { width: number; height: number; bars: SparkBar[]; total: number }

/** Bar geometry for the 13-week sparkline: a bar per week, a flat tick for an empty week. */
export function sparkGeometry(weekly: number[]): SparkGeometry {
  const BW = 3, GAP = 1.6, H = 16;
  const width = +(weekly.length * (BW + GAP) - GAP).toFixed(1);
  const bars = weekly.map((v, i): SparkBar => {
    const h = v > 0 ? Math.max(2, (v / 7) * (H - 3)) : 0;
    return { x: +(i * (BW + GAP)).toFixed(1), y: v > 0 ? H - h : H - 1, h: v > 0 ? h : 1, zero: v <= 0 };
  });
  return { width, height: H, bars, total: weekly.reduce((a, b) => a + b, 0) };
}

/** Ticked owners (with at least one ticked item) and the ticked item ids. */
export function selectionOf(owners: OwnerGroup[], items: ReadonlyMap<string, boolean>) {
  const rows = owners.flatMap((o) => includedRows(items, o));
  const ownerIds = owners.filter((o) => includedRows(items, o).length > 0).map((o) => o.owner.username);
  return {
    owners: ownerIds,
    items: rows.map((r) => r.source.id),
    services: sumSvc(rows),
    credits: rows.reduce((s, r) => s + r.credits, 0),
  };
}

/** DC-085: "Quick wins only" as the truth. Only Quick win rows, owners with none dropped, and the owner's figures recounted. */
export function quickWinsOnly(owners: OwnerGroup[]): OwnerGroup[] {
  return owners.flatMap((o) => {
    const rows = o.rows.filter((r) => r.priority === 'start');
    if (!rows.length) return [];
    return [{ ...o, rows, credits: rows.reduce((a, r) => a + r.credits, 0), sizeMB: rows.reduce((a, r) => a + r.sizeMB, 0),
      unmeasured: rows.filter((r) => !r.sizeKnown).length, startCount: rows.length }];
  });
}

export type OptionKey = 'minDaysSinceUse' | 'minDaysSinceUpdate' | 'maxUsedBy' | 'minSizeMB';

/** The label for a value the dropdown does not offer, in the same style as the ones it does (DC-085). */
export function optionLabel(key: OptionKey, v: number): string {
  switch (key) {
    case 'minDaysSinceUse':
    case 'minDaysSinceUpdate':
      return v > 0 && v % 365 === 0 ? plural(v / 365, 'year', 'years') : v > 0 && v % 30 === 0 ? plural(v / 30, 'month', 'months') : plural(v, 'day', 'days');
    case 'maxUsedBy': return v === 0 ? 'No maps or apps' : `At most ${v}`;
    case 'minSizeMB': return v === 0 ? 'Any size' : v >= 1024 ? `${v / 1024} GB` : `${v} MB`;
  }
}

/** The list, with the current value added in order when it is not already there. Returns the same list when it is. */
export function optionsWith(key: OptionKey, list: Option[], cur: number): Option[] {
  if (list.some((o) => o.value === cur)) return list;
  return [...list, { value: cur, label: optionLabel(key, cur) }].sort((a, b) => a.value - b.value);
}
