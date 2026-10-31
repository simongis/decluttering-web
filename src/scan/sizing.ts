// DC-071a: hybrid sizing. `search` returns size -1 for hosted services, so storage needs another call. One
// content/items/{id} per service is exact but costs one call each; an owner's content listing (content/users/{owner},
// plus one per folder, 100 items a page) returns real sizes for every item in it (controller check, 2026-10-16,
// docs/research/large-org-scan.md). Per owner: list their content when they have at least MIN_LIST services to measure
// and listing looks cheaper than one call each; anything the listings don't settle is measured one by one.
import { assertAllowed } from './guard';
import type { RequestFn, SizeInfo } from './types';

/** Owners with fewer services to measure than this are measured item by item (a listing costs at least one call). */
export const MIN_LIST = 2;
/** After this many failed listings and none that worked, the rest of the scan measures item by item. */
export const LISTING_GIVE_UP = 3;
const PAGE = 100;
const MB = 1024 * 1024;

export interface SizeTarget {
  id: string; owner: string;
  /** The service's folder id from the search (null: the owner's root); undefined when the search didn't say. */
  folder?: string | null;
}

export interface HybridOptions {
  call: RequestFn;
  signal?: AbortSignal;
  /** Limiter priority for these calls. */
  priority?: number;
  /** How many owners and items to work on at once (the shared limiter decides what is actually in flight). */
  width?: number;
  onSize: (id: string, info: SizeInfo) => void;
  /** A per-item read failed: the service stays unmeasured. */
  onFail: (id: string) => void;
  /** The calls still planned, after every change (for the estimate). */
  onPlan?: (callsLeft: number) => void;
}

type Json = Record<string, unknown>;
export type SizeJob = { kind: 'owner'; owner: string; ids: string[] } | { kind: 'item'; id: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';
const isBlocked = (e: unknown) => (e as Error | null)?.name === 'BlockedRequest';
const allowed = (path: string) => { try { return assertAllowed(path, 'GET'); } catch { return false; } };
export const userPath = (owner: string, folder?: string) => `content/users/${owner}${folder ? `/${folder}` : ''}`;

/** Bytes of a numeric field as MB; 0 when missing, negative or not a number. */
const mbOf = (v: unknown): number => { const n = Number(v); return typeof v === 'number' && Number.isFinite(n) && n > 0 ? n / MB : 0; };

/**
 * What a listed item or content/items call says about storage; null when it has no real size (search-style -1).
 * DC-134: `subInfo` is the attachments' bytes (what the ArcGIS API for Python's `Item.attachments_size` returns), part of
 * `size` and billed as file storage (docs/research/attachment-storage.md). Always set, so a cached 0 means "none".
 */
export function sizeInfoOf(it: Json): SizeInfo | null {
  const n = Number(it.size);
  if (it.size === undefined || it.size === null || !Number.isFinite(n) || n < 0) return null;
  const z: SizeInfo = { sizeMB: n > 0 ? n / MB : 0, attachmentMB: mbOf(it.subInfo) };
  if (it.description) z.description = str(it.description);
  if (it.snippet) z.snippet = str(it.snippet);
  if (Array.isArray(it.tags)) z.tags = (it.tags as unknown[]).map(String);
  return z;
}

/**
 * Jobs in the order of the targets (so likely-stale services come first): one job per owner with at least MIN_LIST
 * targets (at the owner's first target), one per remaining item. Owners whose name can't be put in a guarded path are
 * measured item by item.
 */
export function planSizing(targets: SizeTarget[]): SizeJob[] {
  const byOwner = new Map<string, string[]>();
  for (const t of targets) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t.id]);
  const jobs: SizeJob[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const ids = byOwner.get(t.owner) as string[];
    if (t.owner && ids.length >= MIN_LIST && allowed(userPath(t.owner))) {
      if (!seen.has(t.owner)) { seen.add(t.owner); jobs.push({ kind: 'owner', owner: t.owner, ids }); }
    } else jobs.push({ kind: 'item', id: t.id });
  }
  return jobs;
}

/** A guess at the calls a plan costs before it runs: an owner job is its root listing and, usually, a folder or two. */
const guess = (j: SizeJob) => (j.kind === 'item' ? 1 : Math.min(j.ids.length, 3));

/** Runs at most `n` tasks at once and waits for all of them, so nothing lands after it returns. Rejects with the first failure. */
export async function settleAll<T>(xs: T[], n: number, signal: AbortSignal | undefined, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0, failed: unknown = null, hasFailed = false;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length && !hasFailed) {
      if (signal?.aborted) { if (!hasFailed) { hasFailed = true; failed = Object.assign(new Error('The scan was stopped.'), { name: 'AbortError' }); } return; }
      const x = xs[next++] as T;
      try { await fn(x); } catch (e) { if (!hasFailed) { hasFailed = true; failed = e; } return; }
    }
  }));
  if (hasFailed) throw failed;
}

/** Measures every target, listings first where they pay off. Rejects only on abort or a blocked call. */
export async function measureHybrid(targets: SizeTarget[], o: HybridOptions): Promise<void> {
  const { call, signal } = o;
  const priority = o.priority ?? 0;
  const width = o.width ?? 24;
  const where = new Map(targets.map((t) => [t.id, t]));
  const jobs = planSizing(targets);
  let planned = jobs.reduce((n, j) => n + guess(j), 0);
  const plan = (delta: number) => { planned = Math.max(0, planned + delta); o.onPlan?.(planned); };
  o.onPlan?.(planned);

  const one = async (id: string) => {
    let it: Json;
    try { it = await call(`content/items/${id}`, {}, { priority, signal }) as Json; }
    catch (e) {
      if (isAbort(e) || isBlocked(e)) throw e;
      o.onFail(id);
      return;
    } finally { plan(-1); }
    // No real size on the item itself: counted as 0 MB, as before (DC-053).
    o.onSize(id, sizeInfoOf(it) ?? (sizeInfoOf({ ...it, size: 0 }) as SizeInfo));
  };

  // If listings keep failing and none has worked (an account that may not list others' content), stop trying them.
  let listOk = 0, listFail = 0;
  const listingsWork = () => listOk > 0 || listFail < LISTING_GIVE_UP;

  const ownerJob = async (owner: string, ids: string[]) => {
    const want = new Set(ids);
    if (!listingsWork()) {
      plan(want.size - guess({ kind: 'owner', owner, ids }));
      await settleAll([...want], width, signal, one);
      return;
    }
    const take = (r: Json) => {
      for (const it of (r.items as Json[] | undefined) ?? []) {
        const id = str(it.id);
        if (!want.has(id)) continue;
        const z = sizeInfoOf(it);
        if (z) { want.delete(id); o.onSize(id, z); }
      }
    };
    /** One listing, paged only while that is cheaper than measuring what is left item by item. Returns its first page. */
    const list = async (path: string): Promise<Json | null> => {
      let start = 1, first: Json | null = null;
      while (start > 0 && want.size) {
        plan(1);
        let r: Json;
        try { r = await call(path, { num: PAGE, start }, { priority, signal }) as Json; listOk++; }
        catch (e) { if (!isAbort(e) && !isBlocked(e)) listFail++; throw e; }
        finally { plan(-1); }
        first ??= r;
        take(r);
        const next = Number(r.nextStart ?? -1), total = Number(r.total ?? 0);
        if (!(next > 0)) break;
        if (Math.ceil(Math.max(0, total - (next - 1)) / PAGE) >= want.size) break;
        start = next;
      }
      return first;
    };
    plan(-guess({ kind: 'owner', owner, ids }));
    try {
      const root = await list(userPath(owner));
      const folders = ((root?.folders as Json[] | undefined) ?? []).map((f) => str(f.id)).filter((f) => /^[0-9a-f]{32}$/.test(f) && allowed(userPath(owner, f)));
      if (want.size && folders.length) {
        let pick: string[];
        const left = [...want].map((id) => where.get(id)?.folder);
        if (left.every((f) => f !== undefined)) {
          // The search said where each one lives: list only folders holding at least MIN_LIST of what is left.
          const count = new Map<string, number>();
          for (const f of left) if (f) count.set(f, (count.get(f) ?? 0) + 1);
          pick = folders.filter((f) => (count.get(f) ?? 0) >= MIN_LIST);
        } else pick = want.size > folders.length ? folders : [];
        const results = await Promise.allSettled(pick.map((f) => list(userPath(owner, f))));
        const bad = results.find((x) => x.status === 'rejected' && (isAbort(x.reason) || isBlocked(x.reason)));
        if (bad) throw (bad as PromiseRejectedResult).reason;
      }
    } catch (e) {
      if (isAbort(e) || isBlocked(e)) throw e;
      // A listing we may not read (or that failed): measure what is left one by one.
    }
    if (!want.size) return;
    plan(want.size);
    await settleAll([...want], width, signal, one);
  };

  await settleAll(jobs, width, signal, (j) => (j.kind === 'item' ? one(j.id) : ownerJob(j.owner, j.ids)));
}
