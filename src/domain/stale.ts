// Staleness model (ADR 0007), ported from prototype D. Pure TS: no DOM.
// Reference date is data.org.scannedAt; usage is [[daysAgo, count], ...] relative to it, lastViewed an ISO time.
import type { Data, EvaluateResult, Family, Option, Owner, OwnerGroup, Row, Service, Thresholds, TidyHint, UnreachableGroup } from './types';
import { DAY, agoDays, fmtMonthYear } from './format';
import { COOLDOWN_DAYS, nudgedRecently } from './cooldown';
import { byPriority, classifyPriority, cutoffsOf, priorityOf, type Priority } from './priority';
import { HOUR, SWEEP_HEAVY_REQUESTS, sweepDays, sweepHours, type Sweeps } from './sweep';

/**
 * Thresholds are plain numbers the admin can see and edit. Presets only fill them in.
 * DC-083 (ADR 0007, amendment 2026-10-17): last used and last updated more than 1 year / 6 months / 3 months ago.
 */
export const PRESETS: Record<'gentle' | 'balanced' | 'strict', Thresholds> = {
  gentle:   { minDaysSinceUse: 365, minDaysSinceUpdate: 365, maxUsedBy: 0, minSizeMB: 20 },
  balanced: { minDaysSinceUse: 180, minDaysSinceUpdate: 180, maxUsedBy: 1, minSizeMB: 15 },
  strict:   { minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 2, minSizeMB: 10 }, // provisional; DC-031 recalibrates
};
/**
 * DC-055: below 10 MB a service saves little (10 MB is about 2.4 credits a month), so every starting point hides
 * smaller ones by default: Strict 10 MB, Balanced 15 MB, Gentle 20 MB, Suggested 10 to 20 MB (suggest.ts).
 * Unknown sizes are never hidden (DC-053).
 */
export const SIZE_FLOOR_MB = 10;
/** The usage history the scan reads: 365 UTC days up to and including today (src/scan/pipeline.ts). */
export const USAGE_READ_DAYS = 365;
/** What Esri says a blank lastViewed means (docs/research/usage-signals-deep-dive.md section 2). */
export const NO_RECORD_SINCE = 'November 2022';
const opts = (vals: number[], label: (v: number) => string): Option[] => vals.map((value) => ({ value, label: label(value) }));
const mbLabel = (v: number) => (v === 0 ? 'Any size' : v >= 1024 ? `${v / 1024} GB` : `${v} MB`);
const AGES: [number, string][] = [[90, '3 months'], [180, '6 months'], [270, '9 months'], [365, '1 year'], [730, '2 years'], [1095, '3 years']];
export const SIZE_OPTIONS = opts([0, 1, 10, 15, 20, 50, 100, 1024], mbLabel);
/** "Last used: more than [3 months | 6 months | 9 months | 1 year | 2 years] ago" (research 7.2). */
export const LAST_USED_OPTIONS: Option[] = AGES.filter(([v]) => v <= 730).map(([value, label]) => ({ value, label }));
export const UPDATE_OPTIONS: Option[] = AGES.map(([value, label]) => ({ value, label }));
export const USED_BY_OPTIONS = opts([0, 1, 2, 5], (v) => (v === 0 ? 'No maps or apps' : `At most ${v}`));

/** `suggested` is worked out per org (see suggest.ts); it is not in PRESETS. */
export const PRESET_NAMES = { suggested: 'Suggested', gentle: 'Gentle', balanced: 'Balanced', strict: 'Strict', custom: 'Custom' } as const;
export type PresetName = keyof typeof PRESET_NAMES;

/** Which fixed preset the numbers match: gentle, balanced, strict, or custom. Never returns suggested. */
export function matchPreset(t: Thresholds): Exclude<PresetName, 'suggested'> {
  for (const [name, p] of Object.entries(PRESETS) as [keyof typeof PRESETS, Thresholds][]) {
    if ((Object.keys(p) as (keyof Thresholds)[]).every((k) => p[k] === (t[k] ?? (k === 'minSizeMB' ? 0 : undefined)))) return name;
  }
  return 'custom';
}

/**
 * Credits per month for a hosted feature layer's storage. Hosted views have no storage of their own (size 0).
 * DC-134: attachments (part of sizeMB) are file storage, 1.2 credits per GB; the rest is feature storage, 2.4 per 10 MB.
 */
export const creditsPerMonth = (sizeMB: number, attachmentMB = 0): number => {
  const att = Math.min(Math.max(0, attachmentMB), sizeMB);
  return ((sizeMB - att) / 10) * 2.4 + (att / 1024) * 1.2;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** 90 -> "3 months", 365 -> "a year", 730 -> "2 years", 45 -> "45 days". */
export const span = (d: number): string =>
  (d >= 365 && d % 365 === 0 ? (d === 365 ? 'a year' : `${d / 365} years`) : d >= 60 ? `${Math.round(d / 30.4)} months` : plural(d, 'day', 'days'));
const byWords = (n: number) => (n === 0 ? 'used by no maps or apps' : `used by at most ${plural(n, 'map or app', 'maps or apps')}`);
/** "a, b, and c" (the research 7.2 sentence keeps the serial comma). */
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')}${xs.length > 2 ? ',' : ''} and ${xs[xs.length - 1]}`);

/**
 * A preset (or custom mix) in one plain sentence: "We flag a layer nobody has used for more than 6 months, last
 * updated more than 6 months ago, used by at most 1 map or app, and at least 15 MB." (research 7.2).
 */
export function describe(t: Thresholds): string {
  const rest = [`last updated more than ${span(t.minDaysSinceUpdate)} ago`, byWords(t.maxUsedBy)];
  if (t.minSizeMB) rest.push(`at least ${mbLabel(t.minSizeMB)}`);
  const lead = t.minDaysSinceUse > 0 ? `We flag a layer nobody has used for more than ${span(t.minDaysSinceUse)}, ` : 'We flag a layer ';
  return `${lead}${list(rest)}.`;
}

/** The thresholds on one short line, for the compact "Starting point": "Last used more than 6 months ago · last updated more than 6 months ago · used by at most 1 map or app · at least 15 MB". */
export function ruleLine(t: Thresholds): string {
  const parts = [`last updated more than ${span(t.minDaysSinceUpdate)} ago`, byWords(t.maxUsedBy)];
  if (t.minDaysSinceUse > 0) parts.unshift(`last used more than ${span(t.minDaysSinceUse)} ago`);
  if (t.minSizeMB) parts.push(`at least ${mbLabel(t.minSizeMB)}`);
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

type WhyRow = Pick<Row, 'lastUsedDaysAgo' | 'useKnown' | 'noUseRecorded' | 'lastModified' | 'usedBy'> & Partial<Pick<Row, 'numViews' | 'requestsOnly'>>;

/** The last-used part of a why line: "Last used 8 months ago", or the unknown and no-record lines (research 7.2). */
export function lastUsedWords(row: Pick<WhyRow, 'lastUsedDaysAgo' | 'useKnown' | 'noUseRecorded'>): string {
  if (row.noUseRecorded) return `No use recorded since at least ${NO_RECORD_SINCE}`;
  if (!row.useKnown) return "Last used: unknown (we couldn't read all of its use)";
  if (row.lastUsedDaysAgo === null) return 'No data requests in the last year';
  return `Last used ${agoDays(row.lastUsedDaysAgo)}`;
}

/** "585,557 views all time", or null when the scan did not read views. */
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }); // DC-100: toLocaleString per call was a hot spot
export const viewsWords = (n: number | null | undefined): string | null =>
  (typeof n === 'number' ? `${INT.format(Math.round(n))} ${n === 1 ? 'view' : 'views'} all time` : null);

/** "Last used 8 months ago · last updated Mar 2024 · used by 1 map or app · 585,557 views all time" (research 7.2). */
export function whyLine(row: WhyRow): string {
  const by = row.usedBy === 0 ? 'not used by any maps or apps' : `used by ${plural(row.usedBy, 'map or app', 'maps or apps')}`;
  const parts = [lastUsedWords(row), `last updated ${fmtMonthYear(row.lastModified)}`, by];
  const views = viewsWords(row.numViews);
  if (views) parts.push(views);
  return parts.join(' · ');
}

// ---------- scoring ----------
const daysBetween = (aIso: string, refMs: number) => Math.floor((refMs - Date.parse(aIso)) / DAY);
/** The scan time in ms. Worked out once while the date text is the same (DC-100b: it was read once per family per call). */
let refText = '', refMs = NaN;
const refOf = (data: Data): number => {
  const k = data.org.scannedAt;
  if (k !== refText) { refText = k; refMs = Date.parse(k); }
  return refMs;
};

/** A source layer plus its hosted views. Standalone services (and views whose source is missing) are families of one. */
const familiesMemo = new WeakMap<Data, Family[]>();
/** The org's families, worked out once per Data (the array and its families are shared: do not change them). */
export function families(data: Data): Family[] {
  let f = familiesMemo.get(data);
  if (!f) { f = buildFamilies(data); familiesMemo.set(data, f); }
  return f;
}
/** DC-100b: the last families built. A Data whose members are the very same objects keeps the same Family objects, so what is cached per family survives. */
let familiesLast = new Map<string, Family>();
function buildFamilies(data: Data): Family[] {
  const byId = new Map(data.services.map((s) => [s.id, s]));
  const fam = new Map<string, Family>();
  const hasSource = (s: Service) => s.isView && !!s.sourceId && byId.has(s.sourceId);
  // A hosted view costs no credits; it only matters through its source. One whose source isn't in this org's scan (a lookup
  // that failed, bad data) is left out entirely: never its own family, row, dot or email (user, 2026-10-23).
  for (const s of data.services) if (!hasSource(s) && !s.isView) fam.set(s.id, { id: s.id, source: s, views: [] });
  for (const s of data.services) if (hasSource(s)) {
    // views of views resolve to the root source. A cycle of view sources (bad data) would loop for ever: a view caught
    // in one is left out (DC-084; user, 2026-10-23).
    let root = byId.get(s.sourceId as string) as Service;
    const seen = new Set<string>([s.id]);
    while (hasSource(root) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.sourceId as string) as Service; }
    if (hasSource(root)) continue; // a cycle (bad data): no source to belong to, so left out like a lone view
    fam.get(root.id)?.views.push(s);
  }
  const out: Family[] = [];
  const kept = new Map<string, Family>();
  for (const f of fam.values()) {
    const p = familiesLast.get(f.id);
    let same = !!p && p.source === f.source && p.views.length === f.views.length;
    if (same && p) for (let i = 0; i < f.views.length; i++) if (p.views[i] !== f.views[i]) { same = false; break; }
    const use = same ? (p as Family) : f;
    out.push(use); kept.set(use.id, use);
  }
  familiesLast = kept;
  return out;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const TIP: Record<string, string> = {
  'description,tags,summary': 'Tip: a short description, a summary and a few tags help colleagues find this.',
  'description,tags': 'Tip: a short description and a few tags help colleagues find this.',
  'description,summary': 'Tip: a short description and a summary help colleagues find this.',
  'tags,summary': 'Tip: a summary and a few tags help colleagues find this.',
  description: 'Tip: a short description helps colleagues find this.',
  tags: 'Tip: a few tags help colleagues find this.',
  summary: 'Tip: a short summary helps colleagues find this.',
};
/** Tidy-up hints read from the source service. Never filters anything. */
export function tidyHintsOf(src: Service): TidyHint[] {
  const h: TidyHint[] = [];
  if (!String(src.description ?? '').trim()) h.push('description');
  if (!(src.tags && src.tags.length)) h.push('tags');
  if (!String(src.snippet ?? '').trim()) h.push('summary');
  return h;
}
export const tidyTip = (hints: TidyHint[]): string | null => (hints.length ? (TIP[hints.join(',')] ?? null) : null);

/** What a family's members say about use (DC-083). Shared with suggest.ts so both judge use the same way. */
export interface UseInfo {
  /** Newest of lastViewed and the last day with data requests, in whole days before the scan; null when neither shows use. */
  last: number | null;
  /** Some member carries a lastViewed field (a scan from DC-083 on). */
  hasViewed: boolean;
  /** The newest lastViewed is blank and there were no data requests in the year read. */
  none: boolean;
  /** DC-086: a lastViewed fell in a sweep hour and was set aside, so what came before it is not known. */
  swept?: boolean;
}

/**
 * Last use of a family's members (DC-083). With `sweeps` (DC-086), a sweep day is ignored when the family made at most
 * 10 requests that day, and a lastViewed inside a sweep hour is ignored. Without it, every request and view counts.
 */
export function useOf(members: readonly Service[], ref: number, sweeps?: Sweeps): UseInfo {
  let seen: number | null = null, hasViewed = false, swept = false;
  let perDay: Map<number, number> | null = null;
  // No sweep days: a day counts when any request landed on it, so the newest such day needs no per-day totals.
  const plain = !sweeps || sweeps.days.size === 0;
  let newest: number | null = null;
  for (const m of members) {
    for (const [d, c] of m.usage) {
      if (!(c > 0)) continue; // DC-084: a zero count is not a day with data requests
      const a = Math.max(0, d); // a future-dated bucket is use today
      if (plain) { if (newest === null || a < newest) newest = a; continue; }
      if (!perDay) perDay = new Map();
      perDay.set(a, (perDay.get(a) ?? 0) + c);
    }
    if (m.lastViewed !== undefined) hasViewed = true;
    if (typeof m.lastViewed === 'string') {
      const t = Date.parse(m.lastViewed);
      if (!Number.isFinite(t)) continue;
      if (sweeps?.hours.has(Math.floor(t / HOUR))) { swept = true; continue; }
      const a = Math.max(0, Math.floor((ref - t) / DAY)); if (seen === null || a < seen) seen = a;
    }
  }
  let req: number | null = newest;
  if (perDay) for (const [a, c] of perDay) {
    if (sweeps?.days.has(a) && c <= SWEEP_HEAVY_REQUESTS) continue; // a light touch on a sweep day
    if (req === null || a < req) req = a;
  }
  const last = req === null ? seen : seen === null ? req : Math.min(req, seen);
  return { last, hasViewed, none: hasViewed && last === null && !swept, ...(swept ? { swept } : {}) };
}

const sweepMemo = new WeakMap<Data, Sweeps>();
/** DC-100: the last sweep work and what it was worked out from. A new Data that changed only dependencies reuses it. */
let sweepLast: { services: readonly Service[]; sweeps: Sweeps } | null = null;
const sameSweepInput = (a: readonly Service[], b: readonly Service[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Service, y = b[i] as Service;
    if (x !== y && (x.id !== y.id || x.usage !== y.usage || x.lastViewed !== y.lastViewed || x.isView !== y.isView || x.sourceId !== y.sourceId)) return false;
  }
  return true;
};
/** DC-086: the org's sweep days and hours, worked out once per Data (and not again while usage and views are unchanged). */
export function sweepsOf(data: Data): Sweeps {
  let sw = sweepMemo.get(data);
  if (!sw) {
    if (sweepLast && sameSweepInput(sweepLast.services, data.services)) sw = sweepLast.sweeps;
    else { sw = { days: sweepDays(data.services), hours: sweepHours(families(data)) }; sweepLast = { services: data.services, sweeps: sw }; }
    sweepMemo.set(data, sw);
  }
  return sw;
}
interface UseMemo { usage: readonly (readonly (readonly [number, number])[])[]; viewed: (string | null | undefined)[]; sweeps: Sweeps | undefined; ref: number; use: UseInfo }
/** DC-100: a family's last use, kept while its members' usage arrays and lastViewed, the sweeps and the scan date are the same (a Data copy that only gained dependencies reuses it). */
const useMemo = new WeakMap<object, UseMemo>();
/** The one sweep-aware last use the review, Suggested and the dot map share. `countSweeps`: the admin's setting. */
export const familyUse = (data: Data, members: readonly Service[], countSweeps = false): UseInfo => {
  const ref = refOf(data), sweeps = countSweeps ? undefined : sweepsOf(data);
  const first = members[0] as Service, c = useMemo.get(first.usage);
  if (c && c.sweeps === sweeps && c.ref === ref && c.usage.length === members.length) {
    let same = true;
    for (let i = 0; i < members.length && same; i++) { const m = members[i] as Service; same = c.usage[i] === m.usage && c.viewed[i] === m.lastViewed; }
    if (same) return c.use;
  }
  const use = useOf(members, ref, sweeps);
  useMemo.set(first.usage, { usage: members.map((m) => m.usage), viewed: members.map((m) => m.lastViewed), sweeps, ref, use });
  return use;
};

/**
 * Whether last use is known under an age rule of `minDays` (DC-083). Recent use is always known. Otherwise a failed
 * usage window makes it unknown (the FB-29 lesson: never flag on a read that went wrong). An old scan without lastViewed
 * knows only the year of data requests it read.
 */
export function useKnownFor(u: UseInfo, minDays: number, usageComplete: boolean): boolean {
  if (u.last !== null && u.last < minDays) return true;
  if (!usageComplete) return false;
  // A lastViewed set aside as a sweep (DC-086) hides what came before it: only the year of requests is known.
  if ((u.hasViewed && !u.swept) || u.last !== null) return true;
  return minDays <= USAGE_READ_DAYS;
}

/** Passes the "Last used: more than N ago" rule: known, and nothing newer than N days (0 skips the rule). */
export function unusedFor(u: UseInfo, minDays: number, usageComplete: boolean): boolean {
  if (minDays <= 0) return true;
  return useKnownFor(u, minDays, usageComplete) && (u.last === null || u.last >= minDays);
}

/** What scoring a family gives that does not depend on the rule or on whether maps and apps are all read (DC-100b). Shared between rows: never changed. */
type Base = Omit<Row, 'useKnown' | 'stale' | 'priority' | 'priorityReason' | 'why'>;

/** The few numbers every verdict needs. Cheap: one pass over the family's members. */
type Light = Pick<Row, 'lastModified' | 'daysSinceUpdate' | 'usedBy' | 'sizeMB' | 'attachmentMB' | 'credits' | 'sizeKnown'>;
function lightOf(f: Family, ref: number): Light {
  const src = f.source, views = f.views;
  let deps: Set<string> | null = null;
  // The scan writes a missing `modified` as 1970-01-01 (pipeline.ts `iso`): that is no date, not a very old one.
  const dated = (t: number) => Number.isFinite(t) && t > 0;
  let lastModified = src.modified, lm = dated(Date.parse(lastModified)) ? Date.parse(lastModified) : NaN;
  const newer = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (dated(t) && !(lm >= t)) { lastModified = iso; lm = t; }
  };
  // A family's storage is its source's; stray view sizes never count. Unknown sizes (null) count as 0 and mark the row.
  let sizeKnown = true, sizeMB = 0, attachmentMB = 0;
  for (let k = -1; k < views.length; k++) {
    const m = k < 0 ? src : views[k] as Service;
    if (m.dependencies.length) { deps ??= new Set(); for (const d of m.dependencies) deps.add(d.id); }
    // DC-131: last updated is the newest of the item dates and the data edit dates across the family.
    if (k >= 0) newer(m.modified);
    newer(m.dataEdited);
    if (!m.isView) { if (m.sizeMB === null) sizeKnown = false; else { sizeMB += m.sizeMB; attachmentMB += m.attachmentMB ?? 0; } }
  }
  // No date at all: 0 days, so the "last updated" rule never flags it (errors lean towards not flagging).
  const daysSinceUpdate = Number.isFinite(lm) ? Math.floor((ref - lm) / DAY) : 0;
  return { lastModified, daysSinceUpdate, usedBy: deps ? deps.size : 0, sizeMB, attachmentMB, credits: creditsPerMonth(sizeMB, attachmentMB), sizeKnown };
}

function scoreFamily(f: Family, use: UseInfo, owner: Owner, l: Light, usageComplete: boolean): Base {
  const members = [f.source, ...f.views];
  const weekly = new Array<number>(13).fill(0);
  const seen = new Set<number>();
  for (const m of members) for (const [d, c] of m.usage) {
    // DC-101: today (day 0) and the previous 90 UTC days, so a layer used today never shows empty bars.
    if (!(c > 0) || d < 0 || d > 90 || seen.has(d)) continue;
    seen.add(d);
    const w = 12 - Math.floor(d / 7);
    weekly[w] = (weekly[w] ?? 0) + 1;
  }
  const tidyHints = tidyHintsOf(f.source);
  const viewCounts = members.map((m) => m.numViews).filter((v): v is number => typeof v === 'number');
  return {
    family: f, source: f.source, views: f.views, owner,
    lastUsedDaysAgo: use.last, noUseRecorded: use.none && usageComplete, requestsOnly: !use.hasViewed,
    numViews: viewCounts.length ? viewCounts.reduce((a, b) => a + b, 0) : null,
    daysSinceUpdate: l.daysSinceUpdate, lastModified: l.lastModified,
    usedBy: l.usedBy, sizeMB: l.sizeMB, attachmentMB: l.attachmentMB, credits: l.credits, sizeKnown: l.sizeKnown,
    tidyHints, tidy: tidyTip(tidyHints), weekly,
    staleness: (clamp01(use.last === null ? 1 : use.last / 365) + clamp01(l.daysSinceUpdate / 730)) / 2,
  };
}

const isStale = (r: Pick<Row, 'daysSinceUpdate' | 'usedBy' | 'sizeKnown' | 'sizeMB'>, u: UseInfo, t: Thresholds, usageComplete: boolean, depsKnown = true) =>
  unusedFor(u, t.minDaysSinceUse, usageComplete) && r.daysSinceUpdate >= t.minDaysSinceUpdate && (!depsKnown || r.usedBy <= t.maxUsedBy) && (!r.sizeKnown || r.sizeMB >= (t.minSizeMB || 0));

/** Every family (stale or not) scored under `t`, with `stale` set. Used by the scan screen. */
/** `depsKnown: false` while maps and apps are still being read: the used-by rule is skipped and priority is capped (ADR 0007, 0010). */
/** `countSweeps` (DC-086): count sweep days and hours like any other use (the admin's setting; off by default). */
export interface EvalOpts { depsKnown?: boolean; countSweeps?: boolean }
export function allRows(data: Data, t: Thresholds, opts: EvalOpts = {}): Row[] {
  // DC-100: the Review page, its dot map and the totals all ask for the same rows; work them out once per Data and rule.
  // The rows are shared between callers (and between Data copies, DC-100b): never change one.
  let byRule = rowsMemo.get(data);
  if (!byRule) { byRule = new Map(); rowsMemo.set(data, byRule); }
  const key = `${JSON.stringify(t)}|${opts.depsKnown ?? true}|${!!opts.countSweeps}`;
  let hit = byRule.get(key);
  if (!hit) {
    if (byRule.size >= 6) byRule.delete(byRule.keys().next().value as string);
    hit = computeRows(data, t, opts);
    byRule.set(key, hit);
  } else { byRule.delete(key); byRule.set(key, hit); }
  return hit.slice(); // callers sort their copy
}
const rowsMemo = new WeakMap<Data, Map<string, Row[]>>();

/**
 * DC-100b: while maps and apps stream in, a new Data arrives every second and only a few families changed. Work that
 * belongs to a family (its score, then its row) is kept against the Family object, which is reused while its members are
 * the very same objects, and checked again before it is used.
 */
/**
 * What a family scores apart from any rule (DC-100b): its last use and the few numbers every verdict needs, flat, so it can
 * be judged as it stands. `base` (the rest of a row) is worked out on first use. Shared: never changed.
 */
export interface Scored {
  family: Family; source: Service; use: UseInfo;
  /** Some member has a usage bucket or a lastViewed (Suggested's "is there any usage data"). */
  anyUsage: boolean;
  lastUsedDaysAgo: number | null; noUseRecorded: boolean;
  daysSinceUpdate: number; lastModified: string; usedBy: number; sizeMB: number; credits: number; sizeKnown: boolean;
  readonly base: Base;
}
class BaseEntry implements Scored {
  readonly source: Service;
  readonly lastUsedDaysAgo: number | null;
  readonly noUseRecorded: boolean;
  readonly daysSinceUpdate: number; readonly lastModified: string; readonly usedBy: number; readonly sizeMB: number; readonly credits: number; readonly sizeKnown: boolean;
  private rest: Base | null = null;
  constructor(
    readonly family: Family, readonly use: UseInfo, readonly anyUsage: boolean, private readonly l: Light, private readonly owner: Owner,
    readonly ref: number, readonly complete: boolean, readonly sweeps: Sweeps | undefined, readonly ownerSrc: Owner | undefined,
  ) {
    this.source = family.source; this.lastUsedDaysAgo = use.last; this.noUseRecorded = use.none && complete;
    this.daysSinceUpdate = l.daysSinceUpdate; this.lastModified = l.lastModified; this.usedBy = l.usedBy; this.sizeMB = l.sizeMB; this.credits = l.credits; this.sizeKnown = l.sizeKnown;
  }
  get base(): Base { return this.rest ??= scoreFamily(this.family, this.use, this.owner, this.l, this.complete); }
}
/** The entries of the last Data scored (per sweeps setting), in family order: the next Data finds its families at the same places, or through `byFamily`. */
const lastBase: [{ list: BaseEntry[]; byFamily: Map<Family, BaseEntry> | null } | null, { list: BaseEntry[]; byFamily: Map<Family, BaseEntry> | null } | null] = [null, null];
const sameOwner = (a: Owner | undefined, b: Owner | undefined): boolean =>
  a === b || (!!a && !!b && a.username === b.username && a.fullName === b.fullName && a.email === b.email && a.role === b.role
    && a.disabled === b.disabled && a.thumbnail === b.thumbnail && a.lastNotified === b.lastNotified);

const scoredMemo = new WeakMap<Data, [Scored[] | undefined, Scored[] | undefined]>();
/**
 * Every family scored apart from the rule, in family order: its last use, days since update, used-by, storage and so on.
 * Worked out once per Data, and per family only when the family (or the scan date, sweeps or owner) is not the one seen last.
 * Review's rows and Suggested both read it. The entries are shared: never change one.
 */
export function scoredFamilies(data: Data, countSweeps = false): Scored[] {
  let pair = scoredMemo.get(data);
  if (!pair) { pair = [undefined, undefined]; scoredMemo.set(data, pair); }
  const at = countSweeps ? 1 : 0;
  let out = pair[at];
  if (out) return out;
  const complete = data.usageComplete !== false;
  const ref = refOf(data);
  const ownerByName = new Map(data.owners.map((o) => [o.username, o]));
  const prev = lastBase[at];
  const sweeps = countSweeps ? undefined : sweepsOf(data);
  const fams = families(data);
  const list = new Array<BaseEntry>(fams.length);
  out = list;
  for (let i = 0; i < fams.length; i++) {
    const f = fams[i] as Family;
    const own = ownerByName.get(f.source.owner);
    let e = prev?.list[i];
    if (prev && e?.family !== f) e = (prev.byFamily ??= new Map(prev.list.map((x) => [x.family, x]))).get(f);
    // A Family object is only kept while its members are the same objects (they are never changed), so its last use stands
    // while the scan date and the sweeps are the same.
    if (!(e && e.ref === ref && e.complete === complete && e.sweeps === sweeps && sameOwner(e.ownerSrc, own))) {
      const members = f.views.length ? [f.source, ...f.views] : [f.source];
      const use = useOf(members, ref, sweeps); // (what familyUse works out; the entry is the memo here)
      const owner = own || { username: f.source.owner, fullName: f.source.owner, disabled: false, lastNotified: null, thumbnail: null };
      const l = lightOf(f, ref);
      let anyUsage = false;
      for (const m of members) if (m.usage.length > 0 || typeof m.lastViewed === 'string') { anyUsage = true; break; }
      e = new BaseEntry(f, use, anyUsage, l, owner, ref, complete, sweeps, own);
    }
    list[i] = e;
  }
  lastBase[at] = { list, byFamily: null };
  pair[at] = out;
  return out;
}

/** A finished row and what it was made from. A row is the same whenever the family, the rule's verdicts and the words are. */
interface Final { entry: Scored; useKnown: boolean; stale: boolean; depsKnown: boolean; priority: Priority; lowBand: boolean; row: Row }
const finalsMemo = new WeakMap<Family, Final[]>();
const MAX_FINALS = 8;
/** The last sort, as positions in family order: the next one starts from it (see computeRows). */
let lastOrder: number[] = [];

function computeRows(data: Data, t: Thresholds, opts: EvalOpts): Row[] {
  const depsKnown = opts.depsKnown ?? true;
  const complete = data.usageComplete !== false;
  const scored = scoredFamilies(data, !!opts.countSweeps);
  const n = scored.length;
  const knowns = new Array<boolean>(n), stales = new Array<boolean>(n);
  const staleBases: Scored[] = [];
  for (let i = 0; i < n; i++) {
    const sc = scored[i] as Scored;
    knowns[i] = useKnownFor(sc.use, t.minDaysSinceUse, complete);
    const st = isStale(sc, sc.use, t, complete, depsKnown);
    stales[i] = st;
    // Unmeasured rows (0 credits so far) would distort the impact cutoffs, so they are left out of them.
    if (st && sc.sizeKnown) staleBases.push(sc);
  }
  const cut = cutoffsOf(staleBases);

  const rows = new Array<Row>(n);
  for (let i = 0; i < n; i++) {
    const sc = scored[i] as Scored, f = sc.family, useKnown = knowns[i] as boolean, stale = stales[i] as boolean;
    const cls = classifyPriority(sc, cut, depsKnown, useKnown);
    let finals = finalsMemo.get(f);
    let hit: Row | null = null;
    if (finals) for (const v of finals) {
      if (v.entry === sc && v.useKnown === useKnown && v.stale === stale && v.depsKnown === depsKnown && v.priority === cls.priority && v.lowBand === cls.lowBand) { hit = v.row; break; }
    }
    if (hit) { rows[i] = hit; continue; }
    const r: Row = { ...sc.base, useKnown, stale, priority: 'low', priorityReason: '', why: '' };
    // DC-100: the line is only read for the rows that are shown, so it is worded the first time it is asked for.
    Object.defineProperty(r, 'why', {
      enumerable: true, configurable: true,
      get() { const w = whyLine(r); Object.defineProperty(r, 'why', { value: w, enumerable: true, writable: true, configurable: true }); return w; },
      set(v: string) { Object.defineProperty(r, 'why', { value: v, enumerable: true, writable: true, configurable: true }); },
    });
    const p = priorityOf(r, staleBases, { depsKnown });
    r.priority = p.priority; r.priorityReason = p.reason;
    if (!finals) { finals = []; finalsMemo.set(f, finals); }
    if (finals.length >= MAX_FINALS) finals.shift();
    finals.push({ entry: sc, useKnown, stale, depsKnown, priority: p.priority, lowBand: cls.lowBand, row: r });
    rows[i] = r;
  }

  // DC-100b: a batch of links or sizes, or a change of rule, moves few rows, so the sort starts from where the last one ended
  // (the engine's merge sort is fast on nearly sorted input). Ties fall back to the family order, exactly as a stable sort would.
  const order = lastOrder.length === n ? lastOrder.slice() : Array.from({ length: n }, (_, i) => i);
  order.sort((x, y) => byPriority(rows[x] as Row, rows[y] as Row) || x - y);
  lastOrder = order;
  return order.map((k) => rows[k] as Row);
}

const groupByOwner = (rows: Row[]): Row[][] => {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const g = m.get(r.owner.username);
    if (g) g.push(r); else m.set(r.owner.username, [r]);
  }
  return [...m.values()];
};
const sum = (rows: Row[], k: 'credits' | 'sizeMB') => rows.reduce((n, r) => n + r[k], 0);
const unmeasured = (rows: Row[]) => rows.filter((r) => !r.sizeKnown).length;
type Group = { credits: number; rows: Row[]; owner: Owner };
const byGroupCredits = (a: Group, b: Group) =>
  b.credits - a.credits || b.rows.length - a.rows.length || a.owner.username.localeCompare(b.owner.username);

const groupMemo = new Map<string, Map<string, OwnerGroup>>();

export function evaluate(data: Data, t: Thresholds, opts: EvalOpts = {}): EvaluateResult {
  const stale = allRows(data, t, opts).filter((r) => r.stale);
  // Owners with disabled accounts can't be emailed: they go to a separate admin-only list.
  const rows = stale.filter((r) => !r.owner.disabled);
  const lost = stale.filter((r) => r.owner.disabled);
  const ref = refOf(data);

  const unreachable: UnreachableGroup[] = groupByOwner(lost)
    .map((rs) => ({ owner: (rs[0] as Row).owner, rows: rs, credits: sum(rs, 'credits'), sizeMB: sum(rs, 'sizeMB') }))
    .sort(byGroupCredits);

  // DC-100b: an owner whose rows are the very same objects as last time gets the same group object back, so the page can
  // leave their card alone. Kept per rule; the groups are shared between callers (never change one).
  const gkey = `${JSON.stringify(t)}|${opts.depsKnown ?? true}|${!!opts.countSweeps}`;
  let before = groupMemo.get(gkey);
  if (before) groupMemo.delete(gkey);
  else if (groupMemo.size >= 6) groupMemo.delete(groupMemo.keys().next().value as string);
  const after = new Map<string, OwnerGroup>();
  groupMemo.set(gkey, after);
  before ??= new Map();
  const owners: OwnerGroup[] = groupByOwner(rows).map((rs) => {
    const owner = (rs[0] as Row).owner;
    const nudgedDaysAgo = owner.lastNotified ? daysBetween(owner.lastNotified, ref) : null;
    const recent = nudgedRecently(owner, ref, COOLDOWN_DAYS);
    const prev = before.get(owner.username);
    let g: OwnerGroup;
    if (prev && sameOwner(prev.owner, owner) && prev.rows.length === rs.length && prev.rows.every((r, i) => r === rs[i])
      && prev.nudgedRecently === recent && prev.nudgedDaysAgo === nudgedDaysAgo) g = prev;
    else {
      g = {
        owner, rows: rs, credits: sum(rs, 'credits'), sizeMB: sum(rs, 'sizeMB'), unmeasured: unmeasured(rs),
        startCount: rs.filter((r) => r.priority === 'start').length,
        disabled: !!owner.disabled, nudgedRecently: recent, nudgedDaysAgo, defaultTicked: !recent,
      };
    }
    after.set(owner.username, g);
    return g;
  }).sort(byGroupCredits);

  return {
    families: rows,
    owners,
    unreachable,
    totals: {
      services: rows.reduce((n, r) => n + 1 + r.views.length, 0),
      families: rows.length, owners: owners.length, unreachableFamilies: lost.length,
      credits: sum(rows, 'credits'), sizeMB: sum(rows, 'sizeMB'), unmeasured: unmeasured(rows),
    },
  };
}

// ---------- DC-055: lowering the minimum size ----------
export interface SizeImpact {
  /** Families (rows) the lower minimum adds, and their owners; newOwners were not on the list before. */
  families: number; owners: number; newOwners: number;
  /** Storage and credits a month of what is added (known sizes only: unmeasured rows are on the list either way). */
  sizeMB: number; credits: number;
  /** Credits a month already on the list before the change (so the dialog can say whether the extra is worth it). */
  baseCredits?: number;
  /** Rows on the list whose size is still being measured. */
  unmeasured: number;
  fromMB: number; toMB: number;
}

/** The size a starting point hides below: its own minimum, Suggested's pick, or the 10 MB floor for Custom. */
export function sizeReference(preset: PresetName, suggestedMB?: number): number {
  if (preset === 'suggested') return suggestedMB ?? SIZE_FLOOR_MB;
  if (preset === 'custom') return SIZE_FLOOR_MB;
  return PRESETS[preset].minSizeMB ?? SIZE_FLOOR_MB;
}

/** Ask before a size change only when it lowers the minimum below the starting point's. */
export const shouldAskAboutSize = (fromMB: number, toMB: number, refMB: number): boolean => toMB < fromMB && toMB < refMB;

/** What changing the minimum size from t.minSizeMB to `toMB` adds to the list. Pure. */
export function sizeChangeImpact(data: Data, t: Thresholds, toMB: number, opts: EvalOpts = {}): SizeImpact {
  const before = evaluate(data, t, opts);
  const after = evaluate(data, { ...t, minSizeMB: toMB }, opts);
  const had = new Set(before.families.map((r) => r.source.id));
  const added = after.families.filter((r) => !had.has(r.source.id));
  const ownersBefore = new Set(before.owners.map((o) => o.owner.username));
  const owners = new Set(added.map((r) => r.owner.username));
  return {
    families: added.length, owners: owners.size, newOwners: [...owners].filter((u) => !ownersBefore.has(u)).length,
    sizeMB: sum(added, 'sizeMB'), credits: sum(added, 'credits'), unmeasured: after.totals.unmeasured,
    fromMB: t.minSizeMB ?? 0, toMB, baseCredits: before.totals.credits,
  };
}

/** The dialog copy: "This adds 23 small services from 9 owners, worth about 4 credits a month in total. …" */
export function smallItemsMessage(i: SizeImpact): string {
  const worth = i.credits < 1 ? 'less than 1 credit a month' : `about ${plural(Math.round(i.credits), 'credit', 'credits')} a month`;
  const measuring = i.unmeasured
    ? ` ${plural(i.unmeasured, 'service is', 'services are')} still being measured, so ${i.unmeasured === 1 ? 'it stays' : 'they stay'} on the list whatever size you pick.`
    : '';
  // The verdict follows the numbers: small next to what's already on the list, or thinly spread, or simply worthwhile.
  const base = i.baseCredits ?? 0;
  const share = base > 0 ? i.credits / base : (i.credits >= 1 ? 1 : 0);
  const more = base >= 1 && i.credits >= 1 ? `, ${Math.round(share * 100)}% more than the ${Math.round(base)} already on the list` : '';
  const verdict = i.credits < 1 || share < 0.1
    ? ' Worth it for a tidy-up, but it adds names to the digest for little saving.'
    : i.credits / Math.max(1, i.families) < 1
      ? ' A worthwhile saving, but spread thinly: on average each is worth under a credit a month.'
      : ' A worthwhile saving.';
  return `This adds ${plural(i.families, 'small service', 'small services')} from ${plural(i.owners, 'owner', 'owners')}, worth ${worth} in total${more}.${verdict}${measuring}`;
}
