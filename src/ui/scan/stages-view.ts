// DC-071b: what the scan screen says about progress, from the three-stage model (ScanStages, DC-071a). Pure; no DOM.
// One current-stage line with a live count, one overall percent, a smoothed estimate, a quiet "how we're crawling" line,
// the stage list, the tab title, and when the big-org card shows. Only stage changes and completion are announced.
import type { ScanEstimate, ScanStages, StageId, StageProgress, StageState } from '../../scan/types';
import { sayRemaining } from './estimate';
import { formatNumber, t, tn } from '../../i18n';

const fmt = (n: number): string => formatNumber(Math.round(n));


export const ALL_DONE = 'All done. Take a look around the map, or move on to the review.';
export const STOPPED_LINE = 'Stopped. Next time we pick up where we left off.';
export const APP_TITLE = 'Decluttering';

/** "1,240 of 3,050", "2,300 so far", or '' when nothing is counted yet. */
export function stageCount(s: Pick<StageProgress, 'done' | 'total'>): string {
  if (s.total === null) return s.done > 0 ? t('scan.phase-stage.count-null', { count: fmt(s.done) }) : '';
  return t('scan.phase-stage.count-known', { done: fmt(Math.min(s.done, s.total)), total: fmt(s.total) });
}

const stageOf = (st: ScanStages, id: StageId): StageProgress => st.stages.find((s) => s.id === id) as StageProgress;

function stageLabel(id: StageId): string {
  return id === 'find' ? t('scan.phase-stage.find') : id === 'measure' ? t('scan.phase-stage.measure') : t('scan.phase-stage.deps');
}

/** The one line above the bar: "Checking maps and apps: 1,240 of 3,050". */
export function currentLine(st: ScanStages | null): string {
  if (!st) return t('scan.line.getting-started');
  if (st.finished) return t('scan.line.finished');
  if (st.stopped) return t('scan.line.stopped');
  if (!st.current) return t('scan.line.finishing');
  const s = stageOf(st, st.current);
  // Sizes (the headline) often start after use and views: say what is moving instead of a count stuck at 0.
  if (s.id === 'measure' && s.done === 0) {
    const { usage, views } = s.parts;
    const layers = stageOf(st, 'find').total;
    const of = layers ? tn('scan.line.for-layers', layers, { count: fmt(layers) }) : '';
    const label = stageLabel(s.id);
    if (usage && (usage.total === null || usage.done < usage.total)) return t('scan.line.reading-use', { label, layers: of });
    if (views && views.total !== null && views.done < views.total) return t('scan.line.matching-views', { label });
  }
  const c = stageCount(s);
  const label = stageLabel(s.id);
  return c ? t('scan.line.with-count', { label, count: c }) : `${label}…`;
}

/** Services the search said there are (the dot map lays its grid out for them, so dots fill in without shifting). */
export function servicesExpected(st: ScanStages | null): number {
  return st ? stageOf(st, 'find').total ?? 0 : 0;
}

/** The announced line (role=status): the stage in plain words, never the counts, so it only changes with the stage. */
export function announceLine(st: ScanStages | null): string {
  if (!st) return t('scan.line.getting-started-period');
  if (st.finished) return t('scan.line.finished');
  if (st.stopped) return t('scan.line.stopped');
  const label = st.current ? t('scan.line.ready-label', { label: stageLabel(st.current) }) : t('scan.line.finishing');
  return st.readyToReview ? t('scan.line.ready', { label }) : label;
}

export interface StageRow { id: StageId; label: string; state: StageState; count: string; detail: string; fraction: number }

/** "What we're up to": the three stages, each with its state, its count and a short line about its parts. */
export function stageRows(st: ScanStages | null, mode = 'admin'): StageRow[] {
  if (!st) return [];
  return st.stages.map((s) => {
    const p = s.parts;
    let detail = '';
    if (s.state === 'waiting') detail = t('scan.phase-stage.waiting');
    else if (s.id === 'find') {
      const owners = p.owners;
      detail = mode === 'my-items' ? (s.state === 'done' ? t('scan.phase-stage.matched') : t('scan.phase-stage.matching'))
        : owners && owners.total !== null && owners.total > 0 ? (owners.done >= owners.total ? tn('scan.phase-stage.owner-count', owners.total, { count: fmt(owners.total) }) : t('scan.phase-stage.owners', { done: fmt(owners.done), total: fmt(owners.total) })) : '';
    } else if (s.id === 'measure') {
      const usage = p.usage, views = p.views;
      const bits = [
        usage && usage.total !== null ? (usage.done >= usage.total ? t('scan.phase-stage.use-in') : t('scan.phase-stage.reading-use-short')) : null,
        views && views.total !== null && views.total > 0 && views.done < views.total ? t('scan.phase-stage.matching-views-short') : null,
      ].filter(Boolean);
      detail = bits.join(' · ');
    } else if (s.id === 'deps') {
      detail = s.state === 'done' && s.total === 0 ? t('scan.phase-stage.no-deps') : s.total === null ? t('scan.phase-stage.listing-deps') : '';
    }
    if (s.state === 'stopped') detail = t('scan.phase-stage.stopped');
    return { id: s.id, label: stageLabel(s.id), state: s.state, count: stageCount(s), detail, fraction: s.fraction };
  });
}

/** The tab title: "42% · Decluttering" while it runs, "Done · Decluttering" at the end. */
export function tabTitle(st: ScanStages | null, base = APP_TITLE): string {
  if (!st) return base;
  if (st.finished) return `${t('scan.tab.done')} · ${base}`;
  if (st.stopped) return `${t('scan.tab.stopped')} · ${base}`;
  return `${st.percent}% · ${base}`;
}

/** FB-23: a calm line that shows the scan is smart (several requests at once), never an error. */
export function crawlLine(e: Pick<ScanEstimate, 'limit' | 'slowedDown'> | null | undefined): string | null {
  if (!e || e.limit <= 0) return null;
  if (e.slowedDown) return t('scan.line.crawl-slow');
  return t('scan.line.crawl-steady', { count: e.limit });
}

/** The big-org card appears after this much time, if the scan still has a while to go. */
export const BIG_ORG_AFTER_MS = 15_000;
/** ...and if at least this much is left (or the estimate isn't known yet). */
export const BIG_ORG_MIN_LEFT_MS = 60_000;

export function wantsBigOrgCard(st: ScanStages | null, eta: { ms: number } | null): boolean {
  if (!st || st.finished || st.stopped || st.elapsedMs < BIG_ORG_AFTER_MS) return false;
  const left = eta?.ms ?? st.estimate.etaMs;
  return left === null || left >= BIG_ORG_MIN_LEFT_MS;
}

/** FB-77: the "While you wait" tips appear after this much time... */
export const TIPS_AFTER_MS = 10_000;
/** ...if the whole scan (elapsed plus time left; unknown counts as long) is at least this long. */
export const TIPS_MIN_TOTAL_MS = 60_000;

export function wantsTips(st: ScanStages | null, eta: { ms: number } | null): boolean {
  if (!st || st.finished || st.stopped || st.elapsedMs < TIPS_AFTER_MS) return false;
  const left = eta?.ms ?? st.estimate.etaMs;
  return left === null || st.elapsedMs + left >= TIPS_MIN_TOTAL_MS;
}

/** Maps and apps still to look inside, for the card ("3,050 maps and apps to look inside"); null while not known. */
export function mapsToCheck(st: ScanStages | null): number | null {
  if (!st) return null;
  const d = stageOf(st, 'deps');
  return d.total;
}

/** Usage is in: the dot map's lenses mean something now. */
export function usageIn(st: ScanStages | null): boolean {
  if (!st) return true;
  const u = stageOf(st, 'measure').parts.usage;
  return !!u && u.total !== null && u.done >= u.total;
}

/*
 * The estimate. The meter gives calls left / calls per second over the last ~10 s, which jumps around as stages change.
 * Shown only once it is stable: after ESTIMATE_AFTER_MS, smoothed, and only after a few readings agree. Once shown, it
 * counts down with real time between readings, so a steady scan never shows the number going up by a little.
 */
export const ESTIMATE_AFTER_MS = 15_000;
const SMOOTH = 0.25;
const AGREE = 3;
const AGREE_RATIO = 2;
const MAX_MS = 6 * 60 * 60 * 1000;
export const SLACK = 1.2;

export function createEtaSmoother() {
  let smoothed: number | null = null;
  let lastT = 0;
  let agree = 0;
  let shown = false;
  return {
    /** Feed every ScanStages; returns the estimate to show, or null. */
    add(st: ScanStages): { ms: number; text: string } | null {
      const raw = st.estimate.etaMs, t = st.elapsedMs;
      if (st.finished || st.stopped) { smoothed = null; shown = false; agree = 0; return null; }
      if (raw === null || !Number.isFinite(raw) || raw > MAX_MS) { agree = 0; lastT = t; return shown && smoothed !== null ? out(smoothed) : null; }
      const dt = Math.max(0, t - lastT); lastT = t;
      if (smoothed === null) smoothed = raw;
      else {
        const aged = Math.max(0, smoothed - dt);
        smoothed = aged + SMOOTH * (raw - aged);
      }
      const close = Math.max(raw, smoothed) / Math.max(1, Math.min(raw, smoothed)) <= AGREE_RATIO;
      agree = close ? agree + 1 : 0;
      if (!shown && t >= ESTIMATE_AFTER_MS && agree >= AGREE) shown = true;
      return shown ? out(smoothed) : null;
    },
  };
  // Words carry some slack (NN/g: allow extra time), so "under a minute" is never said with a minute still to go.
  function out(ms: number) { return { ms, text: sayRemaining(ms * SLACK) }; }
}
