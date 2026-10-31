// The read-only scan: turns an authenticated request function into the domain's Data shape.
// Every call goes through guardRequest (no writes, no service urls), a retry wrapper (backoff on 429/498/5xx) and one
// shared adaptive limiter (DC-071a: 6 in flight, growing to 12, halving on 429/503).
// DC-071a order (docs/research/large-org-scan.md): find, usage, owners and the first page of the maps-and-apps listing
// start together at t=0; search pages are fetched in parallel once the first tells the total; views are traced as each
// page lands; sizes use owner content listings where they pay off (sizing.ts); maps and apps are read last.
import type { BrokenRef, Data, Dependency, Owner, Service } from '../domain/types';
import { carriedRefs, missingRefs } from '../domain/broken-refs';
import { PRESETS, allRows, evaluate } from '../domain/stale';
import { mapsToRead } from '../cache/scanCache';
import { guardRequest } from './guard';
import { LOG_NAME_RE, LOG_TAG, LOG_TITLE } from '../log/guard';
import { createLimiter, statusOf, type Limiter } from './limiter';
import { ScanMeter } from './progress';
import { measureHybrid, planSizing, settleAll, type SizeTarget } from './sizing';
import type {
  CoreResult, DependencyOptions, DependencyResult, PhaseId, RequestFn, RequestOptions, ScanOptions, ScanResult, SizeInfo, SizeOptions, SizeResult,
} from './types';

const DAY = 864e5;
const MAX_RETRIES = 5;
/** A 200 response carrying `error.code` 500 is the item itself failing (an unreadable item), not a blip: one retry, not five (DC-067). */
const MAX_BODY_500_RETRIES = 1;
const RETRYABLE = new Set([429, 498, 500, 502, 503, 504]);
/** Work items handed to the limiter at once per phase; the limiter decides what is actually in flight. */
const POOL_WIDTH = 24;
/** Limiter priorities (lower first): what makes the review meaningful soonest goes first. */
export const PRIORITY = { core: 0, views: 1, sizes: 2, deps: 3 } as const;
/**
 * Above this many services the core does not wait for storage sizes: the review opens first and sizes stream in
 * afterwards, likely-stale first (DC-053). Small orgs keep measuring everything up front.
 */
export const LAZY_SIZE_THRESHOLD = 150;
/** The search API stops paging at 10,000; stop just short of it and warn. */
export const SEARCH_CAP = 9900;
const PAGE = 100;
// Hosted feature services only. Parquet feature layers (beta) are a separate item type billed as file storage, so they stay out (DC-065).
export const SERVICE_QUERY = (orgId: string) => `orgid:${orgId} AND type:"Feature Service" AND typekeywords:"Hosted Service"`;
// DC-071a: Web Scene added (its operationalLayers reference layers like a web map).
export const REFERRER_QUERY = (orgId: string) =>
  `orgid:${orgId} AND (type:"Web Map" OR type:"Web Scene" OR type:"Dashboard" OR type:"Web Mapping Application" OR type:"Web Experience" OR type:"StoryMap" OR type:"Form" OR type:"Hub Site Application")`;

type Json = Record<string, unknown>;
type Item = Json & { id: string };

function abortError(): Error {
  const e = new Error('The scan was stopped.');
  e.name = 'AbortError';
  return e;
}
const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';
const isBlocked = (e: unknown) => (e as Error | null)?.name === 'BlockedRequest';
const noop = () => {};

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Retry wrapper: backs off on 429/498/5xx and network failures, honours abort. Blocked requests are never retried. */
function withRetry(inner: RequestFn, o: { sleep: NonNullable<ScanOptions['sleep']>; random: () => number; signal?: AbortSignal }): RequestFn {
  return async (path, params, options) => {
    const signal = options?.signal ?? o.signal;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      try {
        const res = await inner(path, params, { ...options, signal });
        const err = (res as { error?: { code?: unknown; message?: unknown } } | null)?.error;
        if (err && typeof res === 'object') {
          const e = new Error(`${path}: ${String(err.code)} ${String(err.message ?? '')}`) as Error & { code?: unknown; inBody?: boolean };
          e.code = err.code;
          e.inBody = true;
          throw e;
        }
        return res;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'BlockedRequest') throw e;
        const status = statusOf(e);
        const retryable = status === null ? e instanceof TypeError : RETRYABLE.has(status);
        // A numeric `code` (and no `status`) is the error ArcGIS put in a 200 body; `HTTP 5xx` and `status` are transport failures.
        const eo = e as { inBody?: boolean; status?: unknown; code?: unknown };
        const inBody = eo.inBody === true || (eo.status === undefined && typeof eo.code === 'number');
        const limit = status === 500 && inBody ? MAX_BODY_500_RETRIES : MAX_RETRIES;
        if (!retryable || attempt >= limit) throw e;
        const retryAfter = Number((e as { retryAfter?: unknown }).retryAfter);
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt) + o.random() * 500;
        await o.sleep(wait, signal);
      }
    }
  };
}

export interface UsageRow { name?: unknown; num?: readonly (readonly [unknown, unknown])[] }

/**
 * Adds one usage window (`groupby=name` rows) into `into` (lower-case name -> timestamp -> requests). FB-29: rows that
 * share a name within the window add up; each is a zero-filled series, so a plain set let a second, empty row wipe a
 * busy layer's counts. Across windows a day is keyed by its timestamp, so an edge day both windows report counts once.
 */
export function mergeUsageWindow(into: Map<string, Map<number, number>>, rows: readonly UsageRow[]): void {
  const inWindow = new Map<string, Map<number, number>>();
  for (const d of rows) {
    const key = str(d.name).toLowerCase();
    if (!key) continue;
    const m = inWindow.get(key) ?? new Map<number, number>();
    for (const [ms, c] of d.num ?? []) { const t = Number(ms); if (Number.isFinite(t)) m.set(t, (m.get(t) ?? 0) + (Number(c) || 0)); }
    inWindow.set(key, m);
  }
  for (const [key, w] of inWindow) {
    const m = into.get(key) ?? new Map<number, number>();
    for (const [t, c] of w) m.set(t, Math.max(m.get(t) ?? 0, c));
    into.set(key, m);
  }
}

/** Every attempt waits its turn in the shared limiter. A 429 or 503 in a 200 body counts as a throttle too. */
function withLimiter(inner: RequestFn, limiter: Limiter): RequestFn {
  return (path, params, options = {}) => limiter.run(async () => {
    const res = await inner(path, params, options);
    const code = Number((res as { error?: { code?: unknown } } | null)?.error?.code);
    if (code === 429 || code === 503) throw Object.assign(new Error(`${path}: ${code}`), { code, inBody: true });
    return res;
  }, { priority: options.priority ?? PRIORITY.core, signal: options.signal });
}

const iso = (ms: unknown) => new Date(typeof ms === 'number' && ms > 0 ? ms : 0).toISOString();
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const urlName = (u: unknown) => /\/services\/([^/]+)\//i.exec(str(u))?.[1] ?? null;
const rowKey = (r: Json) => str(r.id) || str(r.username);

interface PageOpts {
  key: string; priority: number; signal?: AbortSignal; warnings: string[];
  /** Each page as it lands (any order), with the count so far and the reported total. */
  onPage?: (rows: Json[], got: number, total: number) => void;
}

/**
 * DC-071a: a search-style listing, fetched in parallel. Page 1 tells the total (`start` is a plain 1-based index, the
 * top 10,000 are pageable), then every other page is asked for at once through the limiter. Returns the rows in page
 * order, without duplicates (items can shift between pages while we read). Stops short of the 10,000 cap and warns.
 */
async function pagesFrom(call: RequestFn, path: string, params: Record<string, string | number>, first: Json, o: PageOpts): Promise<Json[]> {
  const pages: Json[][] = [];
  const rows0 = (first[o.key] as Json[] | undefined) ?? [];
  pages.push(rows0);
  let got = rows0.length;
  const total = Number(first.total ?? 0) || 0;
  o.onPage?.(rows0, got, Math.max(total, got));
  const next0 = Number(first.nextStart ?? -1);
  let capped = false;
  if (next0 > 0 && rows0.length) {
    const last = Math.min(Math.max(total, next0), SEARCH_CAP);
    const starts: number[] = [];
    for (let s = next0; s <= last; s += PAGE) starts.push(s);
    let tailNext = -1, tailStart = 0;
    await settleAll(starts.map((s, k) => ({ s, k })), POOL_WIDTH, o.signal, async ({ s, k }) => {
      const r = await call(path, { ...params, num: PAGE, start: s }, { priority: o.priority, signal: o.signal }) as Json;
      const rows = (r[o.key] as Json[] | undefined) ?? [];
      pages[k + 1] = rows;
      got += rows.length;
      if (s >= tailStart) { tailStart = s; tailNext = rows.length ? Number(r.nextStart ?? -1) : -1; }
      o.onPage?.(rows, got, Math.max(total, got));
    });
    // The org grew while we read: carry on one page at a time from where the last page says.
    let start = tailNext;
    while (start > 0) {
      if (start > SEARCH_CAP) { capped = true; break; }
      const r = await call(path, { ...params, num: PAGE, start }, { priority: o.priority, signal: o.signal }) as Json;
      const rows = (r[o.key] as Json[] | undefined) ?? [];
      pages.push(rows);
      got += rows.length;
      o.onPage?.(rows, got, Math.max(total, got));
      start = rows.length ? Number(r.nextStart ?? -1) : -1;
    }
    if (total > SEARCH_CAP) capped = true;
  }
  if (capped || total > 10000) {
    o.warnings.push(`The search stops at about 10,000 results, so ${path} may have missed some. Results are incomplete for very large orgs.`);
  }
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const page of pages) for (const r of page ?? []) {
    const k = rowKey(r);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(r);
  }
  return out.slice(0, SEARCH_CAP);
}

async function pageParallel(call: RequestFn, path: string, params: Record<string, string | number>, o: PageOpts): Promise<Json[]> {
  const first = await call(path, { ...params, num: PAGE, start: 1 }, { priority: o.priority, signal: o.signal }) as Json;
  return pagesFrom(call, path, params, first, o);
}

/** DC-017: the app's own nudge log is a hosted feature service too; it is never listed as something to tidy. */
export function isAppNudgeLog(it: Json): boolean {
  const tags = Array.isArray(it.tags) ? (it.tags as unknown[]).map(String) : [];
  const title = str(it.title);
  return tags.includes(LOG_TAG) && (title === LOG_TITLE || LOG_NAME_RE.test(title));
}

const kw = (it: Json) => (Array.isArray(it.typeKeywords) ? it.typeKeywords as string[] : []);
const isView = (it: Json) => kw(it).includes('View Service');
/** Where a service lives, from its search row: `ownerFolder` when the search gives it (undefined when it doesn't say). */
const whereOf = (it: Json): { owner: string; folder?: string | null } =>
  ('ownerFolder' in it ? { owner: str(it.owner), folder: str(it.ownerFolder) || null } : { owner: str(it.owner) });

/** Everything except reading maps and apps: find, usage, owners, views (and sizes on small orgs). Dependencies are left empty (see scanDependencies). */
export async function scanCore(request: RequestFn, opts: ScanOptions): Promise<CoreResult> {
  const { portal, orgId, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const warnings: string[] = [];
  const limiter = createLimiter({ delay: (ms) => sleep(ms) });
  const meter = new ScanMeter({ emit: opts.onStages, limiter });
  limiter.onSettle = () => meter.call();
  const call = guardRequest(withRetry(withLimiter(request, limiter), { sleep, random: opts.random ?? Math.random, signal }));
  const progress = (phase: PhaseId, done: number, total: number, message: string) => opts.onProgress?.({ phase, done, total, message });
  const depsMode = opts.depsMode ?? 'all';
  throwIfAborted(signal);

  // Usage, owners and the first page of maps and apps start with find: none of them needs the service list.
  // 4. usage: whole org, 365 days, 3 windows of at most 150 days, newest first
  const end = now();
  const windows: [number, number][] = [[end - 150 * DAY, end], [end - 300 * DAY, end - 150 * DAY], [end - 365 * DAY, end - 300 * DAY]];
  const usageByName = new Map<string, Map<number, number>>();
  let windowsRead = 0;
  /** DC-083: a failed window makes last use unknown for layers whose lastViewed doesn't settle it (never flagged). */
  let usageFailed = false;
  meter.set('usage', 0, windows.length);
  progress('find', 0, 0, 'Finding hosted feature services…');
  const usageP = Promise.all(windows.map(async ([a, b]) => {
    try {
      const u = await call('portals/self/usage', { vars: 'num', groupby: 'name', etype: 'svcusg', stype: 'features', period: '1d', startTime: Math.round(a), endTime: Math.round(b) }, { priority: PRIORITY.core }) as Json;
      mergeUsageWindow(usageByName, (u.data as UsageRow[] | undefined) ?? []);
    } catch (e) {
      if (isAbort(e) || isBlocked(e)) throw e;
      usageFailed = true;
      warnings.push('Part of the usage history could not be read, so some services may look less used than they are.');
    }
    windowsRead++;
    meter.set('usage', windowsRead, windows.length);
    progress('usage', windowsRead, windows.length, `Looking at when each was last used, ${windowsRead} of ${windows.length} date ranges read`);
  }));
  usageP.catch(noop);

  // 5. owners
  const ownersP = pageParallel(call, 'portals/self/users', {}, {
    key: 'users', priority: PRIORITY.core, signal, warnings,
    onPage: (_rows, n, total) => { meter.set('owners', n, total); progress('owners', n, total, `Meeting the owners, ${fmt(n)} so far`); },
  });
  ownersP.catch(noop);

  // The maps-and-apps total, early, so the estimate knows the long stage from the first seconds.
  const referrersFirst = depsMode === 'none' ? undefined
    : (call('search', { q: REFERRER_QUERY(orgId), sortField: 'modified', sortOrder: 'desc', num: PAGE, start: 1 }, { priority: PRIORITY.core }) as Promise<Json>)
      .then((r) => { meter.set('listing', ((r.results as unknown[] | undefined) ?? []).length, Number(r.total ?? 0) || 0); meter.set('maps', 0, Number(r.total ?? 0) || 0); return r; }, () => null);
  if (depsMode === 'none') meter.skipDeps();

  // 1. find, with 3. views traced as each page lands
  const sourceOf = new Map<string, string | null>();
  const viewJobs: Promise<void>[] = [];
  let viewsSeen = 0, viewsDone = 0;
  // A view whose source isn't found is left out of the results (stale.ts families), so a failed or empty lookup is tried
  // once more before giving up (user, 2026-10-23).
  const lookupSource = async (id: string): Promise<string | null> => {
    try {
      const r = await call(`content/items/${id}/relatedItems`, { relationshipType: 'Service2Service', direction: 'reverse', num: 100 }, { priority: PRIORITY.views }) as Json;
      return ((r.relatedItems as Item[] | undefined) ?? [])[0]?.id ?? null;
    } catch (e) {
      if (isAbort(e) || isBlocked(e)) throw e;
      return null;
    }
  };
  const traceView = async (v: Json) => {
    const id = str(v.id);
    sourceOf.set(id, (await lookupSource(id)) ?? (await lookupSource(id)));
    viewsDone++;
    meter.set('views', viewsDone, findDone ? viewsSeen : null);
    progress('views', viewsDone, viewsSeen, `Finding which services are views, ${fmt(viewsDone)} of ${fmt(viewsSeen)}`);
  };
  let findDone = false;
  const foundAll = await pageParallel(call, 'search', { q: SERVICE_QUERY(orgId) }, {
    key: 'results', priority: PRIORITY.core, signal, warnings,
    onPage: (rows, n, total) => {
      meter.set('services', n, total);
      progress('find', n, total, `Reading ${fmt(total || n)} services, ${fmt(n)} so far`);
      for (const r of rows) {
        if (!isView(r) || isAppNudgeLog(r) || sourceOf.has(str(r.id))) continue;
        sourceOf.set(str(r.id), null);
        viewsSeen++;
        const p = traceView(r);
        p.catch(noop);
        viewJobs.push(p);
      }
    },
  }) as Item[];
  findDone = true;
  const found = foundAll.filter((it) => !isAppNudgeLog(it));
  meter.set('services', foundAll.length, foundAll.length);
  meter.set('views', viewsDone, viewsSeen);
  if (!viewsSeen) progress('views', 0, 0, 'No views to trace');
  const where = new Map(found.map((s) => [s.id, whereOf(s)]));

  // 2. size (and fuller metadata). Big orgs skip this; scanSizes measures them after the review has opened (DC-053).
  const lazy = found.length > (opts.lazySizeThreshold ?? LAZY_SIZE_THRESHOLD);
  const details = new Map<string, SizeInfo>();
  let missing = 0;
  let sizing: Promise<void> = Promise.resolve();
  const targets: SizeTarget[] = found.map((s) => ({ id: s.id, ...whereOf(s) }));
  if (lazy) {
    meter.set('sizes', 0, found.length);
    meter.plan('sizes', planSizing(targets).reduce((n, j) => n + (j.kind === 'item' ? 1 : Math.min(j.ids.length, 3)), 0));
    progress('size', 0, found.length, `Storage for ${fmt(found.length)} services is measured once the review is open`);
  } else {
    let n = 0;
    const tick = () => { n++; meter.set('sizes', n, found.length); progress('size', n, found.length, `Measuring storage, ${fmt(n)} of ${fmt(found.length)}`); };
    meter.set('sizes', 0, found.length);
    sizing = measureHybrid(targets, {
      call, signal, priority: PRIORITY.sizes, width: POOL_WIDTH,
      onSize: (id, z) => { details.set(id, z); tick(); },
      onFail: () => { missing++; tick(); },
      onPlan: (left) => meter.plan('sizes', left),
    });
    sizing.catch(noop);
    if (!found.length) progress('size', 0, 0, 'All sized');
  }

  await Promise.all([sizing, Promise.all(viewJobs), usageP]);
  const userRows = await ownersP;
  if (missing) warnings.push(`Could not read the size of ${missing} service${missing === 1 ? '' : 's'}; they are counted as 0 MB.`);

  const owners: Owner[] = userRows.map((u) => ({
    username: str(u.username), fullName: str(u.fullName) || str(u.username),
    ...(u.email ? { email: str(u.email) } : {}),
    ...(u.role ? { role: str(u.role) } : {}),
    disabled: u.disabled === true,
    thumbnail: u.thumbnail ? `${portal.replace(/\/+$/, '')}/sharing/rest/community/users/${str(u.username)}/info/${str(u.thumbnail)}` : null,
    lastNotified: null,
  }));
  const known = new Set(owners.map((o) => o.username));
  for (const s of found) {
    const name = str(s.owner);
    if (name && !known.has(name)) {
      known.add(name);
      owners.push({ username: name, fullName: name, disabled: true, thumbnail: null, lastNotified: null });
      warnings.push(`${name} owns services but is not in the user list, so they are treated as unreachable.`);
    }
  }

  // Dependencies are read later (scanDependencies), so the review can appear first.
  const byName = new Map<string, string[]>();
  for (const s of found) {
    const n = urlName(s.url)?.toLowerCase();
    if (n) byName.set(n, [...(byName.get(n) ?? []), s.id]);
  }

  // map to the domain shape
  const scannedAt = new Date(end).toISOString();
  const services: Service[] = found.map((s) => {
    const name = urlName(s.url)?.toLowerCase();
    const raw = name ? usageByName.get(name) : undefined;
    const byDay = new Map<number, number>();
    for (const [ms, c] of raw ?? []) {
      const ago = Math.max(0, Math.floor((end - ms) / DAY));
      if (c > 0) byDay.set(ago, (byDay.get(ago) ?? 0) + c);
    }
    const view = isView(s);
    const svc: Service = {
      id: s.id, title: str(s.title), owner: str(s.owner), created: iso(s.created), modified: iso(s.modified),
      sizeMB: lazy ? null : 0,
      access: str(s.access), isView: view, sourceId: view ? sourceOf.get(s.id) ?? null : null,
      usage: [...byDay].sort((a, b) => a[0] - b[0]),
      // DC-083: free on the search row. Blank (missing, 0 or negative) is Esri's "not since about November 2022".
      lastViewed: typeof s.lastViewed === 'number' && s.lastViewed > 0 ? iso(s.lastViewed) : null,
      dependencies: [],
    };
    if (typeof s.numViews === 'number' && s.numViews >= 0) svc.numViews = s.numViews;
    if (s.description) svc.description = str(s.description);
    if (s.snippet) svc.snippet = str(s.snippet);
    if (Array.isArray(s.tags)) svc.tags = (s.tags as unknown[]).map(String);
    if (typeof s.contentStatus === 'string' && s.contentStatus) svc.contentStatus = s.contentStatus;
    return svc;
  });

  let data: Data = {
    org: { id: orgId, name: opts.orgName ?? orgId, urlKey: opts.urlKey ?? '', scannedAt, ...(opts.customBaseUrl ? { customBaseUrl: opts.customBaseUrl } : {}) },
    owners, services, usageComplete: !usageFailed,
  };
  if (!lazy) data = withSizes(data, details);
  meter.core();
  return {
    data, warnings, depsKnown: false, sizesPending: lazy,
    ctx: { call, progress, orgId, byId: new Set(found.map((s) => s.id)), byName, depsMode, signal, meter, referrersFirst, where },
  };
}

const SIZE_BATCH = 12;
const DEPS_BATCH = 50;

/** Copy of data with measured sizes (and the fuller metadata from the same call) filled in. Others keep what they had. */
export function withSizes(data: Data, sizes: ReadonlyMap<string, SizeInfo>): Data {
  if (!sizes.size) return data;
  return {
    ...data,
    services: data.services.map((s) => {
      const z = sizes.get(s.id);
      if (!z) return s;
      const out: Service = { ...s, sizeMB: z.sizeMB };
      if (z.attachmentMB !== undefined) out.attachmentMB = z.attachmentMB;
      if (z.description !== undefined) out.description = z.description;
      if (z.snippet !== undefined) out.snippet = z.snippet;
      if (z.tags !== undefined) out.tags = z.tags;
      return out;
    }),
  };
}

/** "Looks stale on usage and age alone": Balanced, with used-by and size ignored (the same idea as the deps priority). */
const LIKELY_STALE = { ...PRESETS.balanced, maxUsedBy: Number.MAX_SAFE_INTEGER, minSizeMB: 0 };

/**
 * Which services still need a size, in the order to measure them (DC-053): sources of families that look stale on usage
 * and age alone first, then the other sources, then views last (a view's storage is its source's, so its own size never
 * counts; it is measured only for its fuller metadata). DC-134: sources with a size cached before DC-134 (no attachment
 * figure) are measured again, after the unmeasured ones of the same rank: their rows already show a size.
 */
export function sizeOrder(data: Data): string[] {
  const likely = new Set(allRows(data, LIKELY_STALE, { depsKnown: false }).filter((r) => r.stale).map((r) => r.source.id));
  const refresh = (s: Service) => s.sizeMB !== null && !s.isView && s.attachmentMB === undefined;
  const rank = (s: Service) => (s.isView ? 4 : (likely.has(s.id) ? 0 : 2) + (refresh(s) ? 1 : 0));
  return data.services.filter((s) => s.sizeMB === null || refresh(s))
    .map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s.id);
}

/**
 * Measures the services still unsized (sizeMB null), in sizeOrder, with hybrid sizing (owner listings where they pay
 * off, DC-071a), streaming cumulative results to onSizes (every batchSize services, and at the end). On abort it
 * resolves with what has landed and `stopped: true`; it never rejects with AbortError.
 */
export async function scanSizes(core: CoreResult, o: SizeOptions = {}): Promise<SizeResult> {
  const { call, progress, meter, where } = core.ctx;
  const signal = o.signal ?? core.ctx.signal;
  const sizes = new Map<string, SizeInfo>();
  const warnings: string[] = [];
  const order = sizeOrder(core.data);
  const total = order.length;
  const step = o.batchSize ?? SIZE_BATCH;
  let unreadable = 0, done = 0, emitted = 0, stopped = false;
  meter.set('sizes', 0, total);
  const tick = () => {
    done++;
    meter.set('sizes', done, total);
    progress('size', done, total, `Measuring storage, ${fmt(done)} of ${fmt(total)}`);
    if (done - emitted >= step || done >= total) {
      emitted = done;
      o.onSizes?.({ sizes: new Map(sizes), done, total, final: done >= total });
    }
  };
  try {
    throwIfAborted(signal);
    await measureHybrid(order.map((id) => ({ id, ...(where.get(id) ?? { owner: '' }) })), {
      call, signal, priority: PRIORITY.sizes, width: POOL_WIDTH,
      onSize: (id, z) => { sizes.set(id, z); tick(); },
      onFail: () => { unreadable++; tick(); },
      onPlan: (left) => meter.plan('sizes', left),
    });
  } catch (e) {
    if (!isAbort(e)) throw e;
    stopped = true;
  }
  meter.plan('sizes', 0);
  if (unreadable) warnings.push(`Could not read the size of ${unreadable} service${unreadable === 1 ? '' : 's'}; they show as not measured.`);
  return { sizes, warnings, missing: total - sizes.size, stopped };
}

/** A service as the scan hands it out: `depsChecked` says whether every map and app was read for it (FB-15). */
export type ScannedService = Service & { depsChecked?: boolean };

/** True only when every map and app in the org was read for this service, so "used by" (or "none") can be said. */
export const depsCheckedOf = (s: Service): boolean => (s as ScannedService).depsChecked === true;

/**
 * Copy of data with the given dependencies filled in (services missing from the map get none). With `checked`, every
 * service also gets `depsChecked` (DC-071a): true only when every map and app was read (or reused from a complete read).
 */
export function withDependencies(data: Data, deps: Map<string, Dependency[]>, checked?: boolean, brokenRefs?: BrokenRef[]): Data {
  return {
    ...data,
    ...(brokenRefs ? { brokenRefs } : {}),
    services: data.services.map((s) => (checked === undefined ? { ...s, dependencies: deps.get(s.id) ?? [] } : { ...s, dependencies: deps.get(s.id) ?? [], depsChecked: checked })),
  };
}

/**
 * Reads /data for maps and apps, streaming cumulative results to onBatch (every batchSize maps, and at the end).
 * With `previous`, only maps and apps never read or modified since they were read are read (mapsToRead); the rest keep
 * their old links. On abort (after the core) it resolves with what was read so far and `stopped: true` (DC-053).
 * Order: maps and apps owned by owners of likely-stale services first, then newest-modified first.
 */
export async function scanDependencies(core: CoreResult, o: DependencyOptions = {}): Promise<DependencyResult> {
  const { call, progress, orgId, byId, byName, depsMode, meter } = core.ctx;
  const signal = o.signal ?? core.ctx.signal;
  const warnings: string[] = [];
  const depsOf = new Map<string, Dependency[]>();
  /** DC-035a: references to hosted layers that are gone, by map or app id. Only when the search saw every hosted feature service. */
  const lookForBroken = byId.size < SEARCH_CAP;
  const known = { hasId: (id: string) => byId.has(id), hasName: (n: string) => byName.has(n) };
  const broken = new Map<string, BrokenRef>();
  const readAt: Record<string, string> = {};
  const readNow = core.data.org.scannedAt; // conservative: no map in this run was read before the core finished
  const snapshot = () => new Map([...depsOf].map(([k, v]) => [k, [...v]]));
  if (depsMode === 'none') {
    meter.skipDeps();
    progress('deps', 0, 0, 'Skipped checking maps and apps');
    return { dependencies: depsOf, warnings, read: 0, reused: 0, total: 0, readAt, stopped: false };
  }
  let read = 0, reused = 0, unreadable = 0, stopped = false, total = 0;
  try {
    throwIfAborted(signal);
    const sample = /^sample:(\d+)$/.exec(depsMode);
    const params = { q: REFERRER_QUERY(orgId), sortField: 'modified', sortOrder: 'desc' };
    const say = (n: number, t: number) => progress('deps', n, t, `Listing maps and apps, ${fmt(n)} of ${fmt(t || n)}`);
    const first = (await core.ctx.referrersFirst) ?? await call('search', { ...params, num: PAGE, start: 1 }, { priority: PRIORITY.core, signal }) as Json;
    let referrers = await pagesFrom(call, 'search', params, first, {
      key: 'results', priority: PRIORITY.core, signal, warnings,
      onPage: (_rows, n, t) => { meter.set('listing', n, t); say(n, t); },
    }) as Item[];
    if (sample) referrers = referrers.slice(0, Number(sample[1]));
    total = referrers.length;
    meter.set('listing', total, total);

    // Reuse the last scan's links for maps and apps that have not changed since they were read.
    let toRead = referrers;
    if (o.previous) {
      const prev = o.previous;
      const live = new Set(referrers.map((r) => r.id));
      const changed = new Set(mapsToRead(
        { fetchedAt: prev.fetchedAt, readAt: prev.readAt },
        referrers.map((r) => ({ id: r.id, modified: iso(r.modified) })),
      ).map((r) => r.id));
      toRead = referrers.filter((r) => changed.has(r.id));
      reused = referrers.length - toRead.length;
      for (const r of referrers) if (!changed.has(r.id)) readAt[r.id] = prev.readAt?.[r.id] ?? prev.fetchedAt;
      for (const sv of prev.data.services) {
        const keep = sv.dependencies.filter((d) => live.has(d.id) && !changed.has(d.id));
        if (keep.length && byId.has(sv.id)) depsOf.set(sv.id, keep);
      }
      if (lookForBroken) {
        const asListed = new Map(referrers.filter((r) => !changed.has(r.id)).map((r) => [r.id, { title: str(r.title), type: str(r.type), owner: str(r.owner) }]));
        for (const b of carriedRefs(prev.data, asListed, known)) broken.set(b.id, b);
      }
      if (depsOf.size) o.onBatch?.({ dependencies: snapshot(), done: reused, total, final: !toRead.length });
    }

    // Priority: owners of services that look stale on size/usage/age alone (used-by ignored), cheap from the core data.
    const likely = new Set(evaluate(withDependencies(core.data, new Map()), { ...PRESETS.balanced, maxUsedBy: Number.MAX_SAFE_INTEGER })
      .families.filter((r) => r.stale).map((r) => r.owner.username));
    toRead = toRead.map((r, i) => ({ r, i, first: likely.has(str(r.owner)) ? 0 : 1 })).sort((a, b) => a.first - b.first || a.i - b.i).map((x) => x.r);

    let done = reused, emitted = reused;
    const step = o.batchSize ?? DEPS_BATCH;
    meter.set('maps', done, total);
    if (toRead.length) meter.begin('deps');
    const tick = () => {
      done++;
      meter.set('maps', done, total);
      if (done - emitted >= step || done >= total) {
        emitted = done;
        progress('deps', done, total, `Checking which maps use them, ${fmt(done)} of ${fmt(total)}`);
        o.onBatch?.({ dependencies: snapshot(), done, total, final: done >= total });
      }
    };
    await settleAll(toRead, POOL_WIDTH, signal, async (r) => {
      let text: string;
      try { text = String(await call(`content/items/${r.id}/data`, {}, { text: true, priority: PRIORITY.deps, signal })).toLowerCase(); }
      catch (e) {
        if (isAbort(e) || isBlocked(e)) throw e;
        unreadable++;
        readAt[r.id] = readNow; // like a complete scan: not retried until it changes
        read++;
        tick();
        return;
      }
      const hit = new Set<string>();
      for (const m of text.matchAll(/[0-9a-f]{32}/g)) if (byId.has(m[0])) hit.add(m[0]);
      for (const m of text.matchAll(/\/services\/([^/"'\\?]+)\//g)) for (const id of byName.get(m[1] as string) ?? []) hit.add(id);
      const dep: Dependency = { id: r.id, title: str(r.title), type: str(r.type), owner: str(r.owner) };
      for (const id of hit) depsOf.set(id, [...(depsOf.get(id) ?? []), dep]);
      // The text was lowercased above; refs and names compare in lowercase.
      const missing = lookForBroken ? missingRefs(text, orgId, known) : [];
      if (missing.length) broken.set(r.id, { ...dep, missing });
      readAt[r.id] = readNow;
      read++;
      tick();
    });
    if (!toRead.length && reused) progress('deps', done, total, `Checking which maps use them, ${fmt(done)} of ${fmt(total)}`);
    if (!referrers.length) progress('deps', 0, 0, 'No maps or apps to check');
  } catch (e) {
    // Stopped after the core: keep what was read. Anything else is a real failure.
    if (!isAbort(e)) throw e;
    stopped = true;
  }
  if (unreadable) warnings.push(`${unreadable} map${unreadable === 1 ? '' : 's'} or app${unreadable === 1 ? '' : 's'} could not be read, so some services may look less used than they are.`);
  const brokenRefs = lookForBroken ? [...broken.values()] : undefined;
  // The session composes its Data from core.data, so the references travel with it (the stopped flag tells Review how far to trust them).
  if (brokenRefs) core.data = { ...core.data, brokenRefs };
  return { dependencies: depsOf, warnings, read, reused, total, readAt, stopped, ...(brokenRefs ? { brokenRefs } : {}) };
}

/** The whole scan in one go (core, sizes when deferred, then dependencies). The app uses the steps separately. */
export async function scanOrg(request: RequestFn, opts: ScanOptions): Promise<ScanResult> {
  const core = await scanCore(request, opts);
  const [sizes, deps] = await Promise.all([core.sizesPending ? scanSizes(core) : null, scanDependencies(core)]);
  const depsKnown = core.ctx.depsMode !== 'none' && !deps.stopped;
  core.ctx.meter.finish(!!sizes?.stopped || deps.stopped);
  return {
    data: withDependencies(withSizes(core.data, sizes?.sizes ?? new Map()), deps.dependencies, depsKnown, deps.brokenRefs),
    warnings: [...core.warnings, ...(sizes?.warnings ?? []), ...deps.warnings],
    depsKnown,
  };
}

const fmt = (n: number) => n.toLocaleString('en-AU');
export type { RequestOptions };
