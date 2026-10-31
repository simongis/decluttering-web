// Orchestrates one signed-in scan: cache first (ADR 0009), then a guarded, read-only scan, then save.
import type { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import type { AccessInfo } from '../auth/session';
import { PORTAL_URL } from '../auth/config';
import { ScanCache, staleness, type CacheEntry } from '../cache/scanCache';
import { IndexedDbStore } from '../cache/store';
import type { Data, Dependency, Service } from '../domain/types';
import { scanSession, type DataState } from '../scan/session';
import { createRequest } from '../scan/request';
import type { PhaseId, RequestFn, ScanProgress, ScanStages } from '../scan/types';
import { createSessionNudgeLog, getNudgeSends, mergeLogReads, seededNudgeLog, setNudgeLog, setNudgeSources, setNudgeSummary, type NudgeLog, type OthersRead } from '../log';
import { sinceNudges } from '../domain/outcomes';

export const PHASE_ORDER: PhaseId[] = ['find', 'size', 'views', 'usage', 'owners', 'deps'];

/** Phase-level microcopy (the live message from the scan adds the counts). */
export const PHASE_COPY: Record<PhaseId, string> = {
  find: 'Finding your hosted feature services',
  size: 'Measuring how much storage each one uses',
  views: 'Working out which ones are views of others',
  usage: 'Checking when each was last used',
  owners: 'Meeting the owners',
  deps: 'Seeing which maps and apps use them',
};

export interface ScanOutcome {
  data: Data; warnings: string[]; timings: Partial<Record<PhaseId, number>>;
  /** Milliseconds from the start of the scan until the review could first be shown (the core, before /data). */
  coreMs: number;
  /** Milliseconds until every size was known (null when stopped first). */
  sizesMs: number | null;
  /** Stop was pressed after the core: data is what was known then (DC-053). */
  stopped: boolean;
  depsComplete: boolean;
  /** Services whose storage is still not measured. */
  unmeasured: number;
  /** DC-071a: what a stopped scan left for the next one (it picks up there); null when nothing is left. */
  resume: { mapsLeft: number; sizesLeft: number } | null;
  /** DC-102: the result as a cache entry, kept in memory so "Resume" in the same session passes it back as `previous` (also in the simulator, which never touches the cache). */
  entry: CacheEntry;
}

/**
 * What the scan screen's dot map sees before the core is done (DC-064): services as the search pages arrive, sizes as each
 * item is read, and each map or app read (finer than the 50-item dependency batches). Read off the responses of the same
 * guarded calls; nothing extra is requested.
 */
export type ScanTap =
  | { kind: 'found'; items: { id: string; title: string; owner: string; url?: string; modified?: number; created?: number; isView?: boolean; lastViewed?: number | null }[] }
  /** DC-071c: one usage window as it lands (data requests per day per service name), so the map can place dots early. */
  | { kind: 'usage'; endTime: number; rows: { name: string; num: [number, number][] }[] }
  | { kind: 'sized'; id: string; sizeMB: number; /** DC-134: the attachments' MB, when the item has any. */ attachmentMB?: number }
  | { kind: 'read' };

const MB = 1024 * 1024;
/** DC-134: the attachments' MB from an item's `subInfo`, only when there are some (the tap stays lean for the rest). */
const attachedOf = (it: unknown): { attachmentMB?: number } => {
  const b = (it as { subInfo?: unknown } | null)?.subInfo;
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? { attachmentMB: b / MB } : {};
};
const ITEM = /^content\/items\/([0-9a-zA-Z]+)$/;
const ITEM_DATA = /^content\/items\/[0-9a-zA-Z]+\/data$/;
/** DC-071a: an owner's content listing (hybrid sizing) carries real sizes for every item in it. */
const USER_CONTENT = /^content\/users\/[^/]+(\/[0-9a-f]{32})?$/;

/** Wraps a request so `tap` sees found services, sizes and map reads. The response is passed on untouched. */
export function tapRequest(request: RequestFn, tap: (e: ScanTap) => void): RequestFn {
  return async (path, params, options) => {
    const res = await request(path, params, options);
    try {
      if (path === 'search' && /Hosted Service/.test(String(params?.q ?? ''))) {
        const results = (res as { results?: unknown } | null)?.results;
        if (Array.isArray(results)) {
          tap({ kind: 'found', items: results.map((r: Record<string, unknown>) => ({
            id: String(r.id ?? ''), title: String(r.title ?? ''), owner: String(r.owner ?? ''),
            url: typeof r.url === 'string' ? r.url : undefined,
            modified: typeof r.modified === 'number' ? r.modified : undefined, created: typeof r.created === 'number' ? r.created : undefined,
            isView: Array.isArray(r.typeKeywords) ? (r.typeKeywords as unknown[]).includes('View Service') : undefined,
            // DC-083: blank lastViewed is null; a row without the field at all leaves it out.
            ...('lastViewed' in r ? { lastViewed: typeof r.lastViewed === 'number' && r.lastViewed > 0 ? r.lastViewed : null } : {}),
          })) });
        }
      } else if (/^portals\/[^/]+\/usage$/.test(path)) {
        const rows = (res as { data?: unknown } | null)?.data;
        if (Array.isArray(rows)) {
          tap({ kind: 'usage', endTime: Number(params?.endTime) || 0, rows: rows.map((d: Record<string, unknown>) => ({
            name: String(d.name ?? '').toLowerCase(), num: (Array.isArray(d.num) ? d.num : []).map((p: unknown) => [Number((p as unknown[])[0]), Number((p as unknown[])[1]) || 0] as [number, number]),
          })).filter((d) => d.name) });
        }
      } else if (ITEM.test(path) && res && typeof res === 'object') {
        const n = Number((res as { size?: unknown }).size);
        tap({ kind: 'sized', id: (ITEM.exec(path) as RegExpExecArray)[1] as string, sizeMB: Number.isFinite(n) && n > 0 ? n / MB : 0, ...attachedOf(res) });
      } else if (ITEM_DATA.test(path)) tap({ kind: 'read' });
      else if (USER_CONTENT.test(path) && res && typeof res === 'object') {
        for (const it of ((res as { items?: unknown }).items as Record<string, unknown>[] | undefined) ?? []) {
          const n = Number(it?.size);
          const hosted = it?.type === 'Feature Service' && Array.isArray(it.typeKeywords) && (it.typeKeywords as unknown[]).includes('Hosted Service');
          if (hosted && it.size !== null && Number.isFinite(n) && n >= 0) tap({ kind: 'sized', id: String(it.id ?? ''), sizeMB: n > 0 ? n / MB : 0, ...attachedOf(it) });
        }
      }
    } catch { /* the tap is for display only */ }
    return res;
  };
}

/**
 * DC-017: reads the app's nudge log, if there is one, into the in-memory store the review uses. Reads only (a search of
 * the admin's own items, then a query of the app's own table), through the log's own allow-list, not the scan's. Only
 * for an admin in a writable org: the log can only have been created there, and a read-only org (DC-058) never sees a
 * service call. DC-125c: other admins' logs in the org are read too (query only) and merged in, with who sent each; if one
 * can't be read the flag is kept for the UI. Never throws: without a log, or if it can't be read, nothing changes.
 */
export async function readNudgeLog(access: Pick<AccessInfo, 'mode' | 'writable' | 'orgId' | 'username'>, make: () => NudgeLog): Promise<number | null> {
  if (access.mode !== 'admin' || !access.writable) return null;
  try {
    const log = make();
    const own = (await log.find()) ? await log.read() : null;
    // DC-125c (ADR 0013, decision 6): other admins' logs count towards the six-month rest. Query only; never fails the scan.
    const others = await (log.readOthers?.() ?? Promise.resolve<OthersRead>({ reads: [], unreadable: false })).catch((): OthersRead => ({ reads: [], unreadable: true }));
    if (!own && !others.reads.length && !others.unreadable) return null;
    const merged = mergeLogReads(own, others.reads, access.username);
    setNudgeLog(access.orgId, merged.latest);
    setNudgeSources(access.orgId, merged.by, others.unreadable);
    return merged.latest.size;
  } catch { return null; }
}

/**
 * DC-096: once a scan is in and the log has been read, what the finish line says about past nudges (numbers only, kept in
 * memory). Nothing is set when there was no log. `stopped`: the scan was stopped early, so use is "not checked".
 */
export function summariseNudges(orgId: string, data: Data, stopped: boolean): void {
  const sends = getNudgeSends(orgId);
  if (!sends) return;
  const s = sinceNudges(data, sends, { partial: stopped });
  setNudgeSummary(orgId, s ? { counts: s.counts, credits: s.credits, exact: s.exact } : null);
}

/** Re-render budget while dependencies stream in. */
export const DEPS_RENDER_MS = 1000;

/**
 * DC-100b: how often a page that is busy (or hidden, or being used) is handed new data. The session already spaces batches
 * DEPS_RENDER_MS apart; this stretches that when taking the last one cost the page a lot, so the page keeps most of its time
 * for the admin, waits while they are clicking or typing, and slows right down in a background tab. The first batch (the core)
 * and the last (every map read) are never held.
 */
export const PACE_COST_FACTOR = 5;
export const PACE_MAX_GAP_MS = 6000;
export const PACE_HIDDEN_GAP_MS = 5000;
/** Wait for this long without a click, key or scroll before handing over a batch... */
export const PACE_QUIET_MS = 1200;
/** ...but never hold one for longer than this. */
export const PACE_MAX_HOLD_MS = 8000;

export interface PaceEnv {
  now(): number; hidden(): boolean;
  /** When the admin last clicked, typed or scrolled (ms on the same clock as now), or -Infinity. */
  lastInput(): number;
  later(fn: () => void, ms: number): unknown; cancel(t: unknown): void;
}

export function paceData(emit: (d: Data, s: DataState) => void, env: PaceEnv): { push(d: Data, s: DataState): void; stop(): void } {
  let first = true, last = -Infinity, cost = 0;
  let held: { d: Data; s: DataState } | null = null, heldAt = 0;
  let timer: unknown = null;
  const clear = () => { if (timer !== null) { env.cancel(timer); timer = null; } };
  const hand = (d: Data, s: DataState) => {
    const t = env.now();
    last = t;
    emit(d, s);
    // The page draws in microtasks right after emit returns, so the next timer shows what the batch cost.
    env.later(() => { cost = env.now() - t; last = env.now(); }, 0);
  };
  const gap = () => Math.min(PACE_MAX_GAP_MS, Math.max(DEPS_RENDER_MS, cost * PACE_COST_FACTOR, env.hidden() ? PACE_HIDDEN_GAP_MS : 0));
  const check = () => {
    timer = null;
    if (!held) return;
    const now = env.now();
    const overdue = now - heldAt >= PACE_MAX_HOLD_MS;
    const wait = overdue ? 0 : Math.max(last + gap() - now, env.lastInput() + PACE_QUIET_MS - now, 0);
    if (wait > 0) { timer = env.later(check, Math.ceil(wait)); return; }
    const { d, s } = held; held = null;
    hand(d, s);
  };
  return {
    push(d, s) {
      if (first || s.depsKnown) { first = false; held = null; clear(); hand(d, s); return; }
      if (!held) heldAt = env.now();
      held = { d, s };
      if (timer === null) timer = env.later(check, 0);
    },
    stop() { clear(); held = null; },
  };
}

/** The page's clock, visibility and clicks, keys and scrolls; `off` lets go of the listeners. Outside a browser nothing is ever held. */
function browserEnv(): { env: PaceEnv; off: () => void } {
  let input = -Infinity;
  const events = ['pointerdown', 'keydown', 'wheel', 'input', 'change'];
  const mark = () => { input = performance.now(); };
  const live = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (live) for (const e of events) window.addEventListener(e, mark, { capture: true, passive: true });
  return {
    env: {
      now: () => performance.now(), hidden: () => live && document.hidden, lastInput: () => input,
      later: (fn, ms) => setTimeout(fn, ms), cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
    off: () => { if (live) for (const e of events) window.removeEventListener(e, mark, { capture: true }); },
  };
}

const sameDeps = (a: readonly Dependency[], b: readonly Dependency[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** Equal field for field (links and any other array by reference, links also element by element). */
function sameService(a: Service, b: Service): boolean {
  const ka = Object.keys(a) as (keyof Service)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (k === 'dependencies') { if (!sameDeps(a.dependencies, b.dependencies)) return false; }
    else if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * DC-100b: each batch of sizes or links composes a whole new Data, with a new object for every service, so everything
 * downstream (families, scores, rows, the sweep check) sees 7,000 changes when a few dozen happened. This hands back the
 * previous service object wherever nothing changed, and the previous Data when nothing at all did. Nothing is mutated.
 */
export function serviceKeeper(): (next: Data) => Data {
  let prev: Data | null = null;
  let byId = new Map<string, Service>();
  return (next) => {
    const last = prev;
    let moved = !last || last.services.length !== next.services.length;
    const services = next.services.map((s, i) => {
      const p = byId.get(s.id);
      if (p && sameService(p, s)) { if (!moved && last?.services[i] !== p) moved = true; return p; }
      moved = true;
      return s;
    });
    byId = new Map(services.map((s) => [s.id, s]));
    if (last && !moved) {
      const keys = Object.keys(next) as (keyof Data)[];
      if (keys.length === Object.keys(last).length && keys.every((k) => k === 'services' || last[k] === next[k])) return last;
    }
    prev = { ...next, services };
    return prev;
  };
}


let cache: ScanCache | null = null;
const getCache = () => (cache ??= new ScanCache(new IndexedDbStore()));

export async function loadCached(access: AccessInfo): Promise<{ entry: CacheEntry; note: string } | undefined> {
  try {
    const entry = await getCache().load(access.orgId, access.username);
    return entry ? { entry, note: staleness(entry, new Date()) } : undefined;
  } catch { return undefined; }
}

/** Dev only: force lazy sizing on a small org for a real-run check (localStorage `decluttering:lazySizeThreshold`). */
function devLazyThreshold(): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    const raw = localStorage.getItem('decluttering:lazySizeThreshold');
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch { return undefined; }
}

/** Dev only: pretend the last full scan took this long (localStorage `decluttering:fullScanMs`), so the Rescan warning can be tried on a fast simulated org. */
function devFullScanMs(): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    const n = Number(localStorage.getItem('decluttering:fullScanMs'));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/**
 * Core first (onData fires with depsKnown=false so the review can appear), then sizes (big orgs, DC-053) and dependencies
 * stream in (onData again, at most about once a second, and once at the end). Aborting before the core is done rejects
 * with AbortError; aborting after it resolves with `stopped: true` and what is known. The result is always saved to the
 * cache, so the next visit (or "Finish scanning") measures and reads only what is missing.
 * `previous` is the cached entry.
 */
export async function runScan(
  manager: ArcGISIdentityManager, access: AccessInfo,
  o: {
    onProgress?: (p: ScanProgress) => void; signal?: AbortSignal; previous?: CacheEntry;
    /** DC-071a: the three-stage progress model (stages, percent, estimate inputs), at most every 250 ms and on each stage change. */
    onStages?: (s: ScanStages) => void;
    onData?: (data: Data, state: DataState) => void;
    /** Services found, sizes and map reads as they happen (the scan screen's dot map). */
    onTap?: (e: ScanTap) => void;
    /**
     * Dev only (DC-074, the simulated org): answers the scan instead of the signed-in session; nothing is cached or
     * logged. DC-096: the nudge log read is a seeded in-memory fake with a few past sends.
     */
    request?: RequestFn;
  } = {},
): Promise<ScanOutcome> {
  const timings: Partial<Record<PhaseId, number>> = {};
  const began = performance.now();
  let phase = null as PhaseId | null;
  let since = performance.now();
  const base = o.request ?? createRequest(manager, {
    portal: PORTAL_URL,
    usageReadable: access.usageReadable,
    ownerOnly: access.mode === 'my-items' ? access.username : undefined,
  });
  const request = o.onTap ? tapRequest(base, o.onTap) : base;
  const onProgress = (p: ScanProgress) => {
    if (p.phase !== phase) {
      if (phase) timings[phase] = Math.round(performance.now() - since);
      phase = p.phase; since = performance.now();
    }
    o.onProgress?.(p);
  };
  const keep = serviceKeeper();
  const fix = (data: Data): Data => {
    if (access.mode === 'my-items') {
      // The user list is just the signed-in member; they are reachable, whatever the rest of the org is.
      for (const ow of data.owners) if (ow.username === access.username) ow.disabled = false;
    }
    return keep(data);
  };
  // DC-017: once the core is in (the scan's read-only phase), read the nudge log alongside, without holding anything up.
  let logRead: Promise<number | null> | null = null;
  const onData = (data: Data, state: DataState) => {
    if (!o.request) logRead ??= readNudgeLog(access, () => createSessionNudgeLog(manager, { portal: PORTAL_URL, orgId: access.orgId, self: access.username }));
    else if (import.meta.env.DEV) {
      logRead ??= import('../dev/simulated-org').then((m) =>
        readNudgeLog(access, () => seededNudgeLog({ self: access.username, orgId: access.orgId, rows: m.simulatedNudgeRows(data) })));
    }
    pace.push(data, state);
  };
  const { env, off } = browserEnv();
  const pace = paceData((d, s) => o.onData?.(d, s), env);
  let entry: CacheEntry | null = null;
  let out: Awaited<ReturnType<typeof scanSession>>;
  try {
    out = await scanSession(request, {
      portal: PORTAL_URL, orgId: access.orgId, orgName: access.orgName, urlKey: access.urlKey, customBaseUrl: access.customBaseUrl, signal: o.signal, onProgress, onStages: o.onStages,
      lazySizeThreshold: devLazyThreshold(),
      previous: o.previous, fix, onData, renderMs: DEPS_RENDER_MS,
      save: async (data, fetchedAt, ex) => {
        // DC-105: a scan that reused nothing and finished is a full scan; its time is what Rescan quotes. Otherwise keep the last one.
        const full = !o.previous && !ex.incomplete ? { ms: devFullScanMs() ?? Math.round(performance.now() - began), items: data.services.length, at: new Date().toISOString() } : o.previous?.fullScan;
        const extras = full ? { ...ex, fullScan: full } : ex;
        entry = { data, fetchedAt, savedAt: new Date().toISOString(), ...extras };
        if (!o.request) await getCache().save(access.orgId, access.username, data, fetchedAt, extras);
      },
    });
  } finally { pace.stop(); off(); } // whatever is still held is superseded by the result the caller gets
  if (phase) timings[phase] = Math.round(performance.now() - since);
  // DC-096: the finish line's "since your last nudges", once the log read (already under way) is in. Never holds the scan up.
  void (logRead as Promise<number | null> | null)?.then(() => summariseNudges(access.orgId, out.data, out.stopped)).catch(() => undefined);
  return { ...out, timings, entry: entry ?? { data: out.data, fetchedAt: { services: '', usage: '', users: '', dependencies: '' }, savedAt: new Date().toISOString() } };
}
