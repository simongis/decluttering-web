// DC-090 (FB-40): the "How stale" dot map on the Review page. The scan screen's picture, drawn from the finished scan
// and the panel's current rule: the same buildDots (and through it the same allRows and evaluate the list uses), so
// the stale zone moves and the dots recolour when a filter changes, and the dots in the zone are the list.
import type { Data, Thresholds } from '../../domain/types';
import { PRESET_NAMES, type PresetName } from '../../domain/stale';
import { t } from '../../i18n';
import { buildDots, type DotModel } from '../scan/dots';

export interface ReviewDotsOpts { depsKnown: boolean; countSweeps: boolean }

/** The dot model for these (effective) thresholds: one dot per family, coloured by the rule in force. */
export function reviewDots(data: Data, t: Thresholds, opts: ReviewDotsOpts): DotModel {
  return buildDots({ found: [], sized: new Map(), data, depsKnown: opts.depsKnown, countSweeps: opts.countSweeps }, t);
}

/** The stale zone's label: the starting point in force, or "your rule" for Custom. */
export const zoneName = (shown: PresetName): string => (shown === 'custom' ? t('review.dots.yourRule') : PRESET_NAMES[shown]);

/** The chart card's two views, remembered per browser. */
export type ChartView = 'stale' | 'owner';
// DC-112: under the app's `decluttering:` prefix, so /reset.html and "Sign out and clear saved data" remove them. The old
// `dc.review.*` keys were missed by both, so one old "By owner" pick outlived every reset (FB-68, FB-75).
const VIEW_KEY = 'decluttering:chartView';
const OPEN_KEY = 'decluttering:chartOpen';
// DC-112 (FB-75): the pick is kept per org, so one made in a real org (or an old one under the former shared key) never
// decides what the demo or another org opens on.
const viewKey = (orgId?: string): string => `${VIEW_KEY}.${orgId ?? ''}`;
export const readChartView = (orgId?: string): ChartView => { try { return localStorage.getItem(viewKey(orgId)) === 'owner' ? 'owner' : 'stale'; } catch { return 'stale'; } };
export const writeChartView = (v: ChartView, orgId?: string): void => { try { localStorage.setItem(viewKey(orgId), v); } catch { /* storage blocked: not remembered */ } };
export const readChartOpen = (): boolean => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
export const writeChartOpen = (v: boolean): void => { try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* storage blocked: not remembered */ } };
