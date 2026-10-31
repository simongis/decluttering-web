import type { Data, Service } from '../domain/types';
import type { SizeInfo } from '../scan/types';
import type { KeyValueStore } from './store';

export const CACHE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export type CachePart = 'services' | 'usage' | 'users' | 'dependencies';
export type FetchedAt = Record<CachePart, string>;

export interface CacheEntry {
  data: Data;
  fetchedAt: FetchedAt;
  savedAt: string;
  /** Map or app id to when its links were read. Lets a stopped scan resume with only the unread ones (DC-053). */
  depsReadAt?: Record<string, string>;
  /** Present when the scan was stopped early: sizes not measured, and whether maps and apps were all checked. */
  incomplete?: { unmeasured: number; deps: boolean };
  /** DC-105: how long the last full scan (nothing reused) took and how many services it read, for the Rescan time estimate. */
  fullScan?: { ms: number; items: number; /** When it finished (ISO). Background refreshes don't move it. */ at?: string };
}

export type CacheExtras = Pick<CacheEntry, 'depsReadAt' | 'incomplete' | 'fullScan'>;

export type Clock = () => Date;

export const cacheKey = (orgId: string, username: string): string => `scan:${orgId}:${username}`;

/** Owner emails are fetched at send time and never cached (ADR 0009). */
function stripEmails(data: Data): Data {
  const copy = structuredClone(data);
  copy.owners = copy.owners.map((o) => {
    const rest = { ...o };
    delete rest.email;
    return rest;
  });
  return copy;
}

export class ScanCache {
  constructor(private store: KeyValueStore, private now: Clock = () => new Date()) {}

  async save(orgId: string, username: string, data: Data, fetchedAt: FetchedAt, extras: CacheExtras = {}): Promise<void> {
    const entry: CacheEntry = { data: stripEmails(data), fetchedAt, savedAt: this.now().toISOString() };
    if (extras.depsReadAt) entry.depsReadAt = extras.depsReadAt;
    if (extras.incomplete) entry.incomplete = extras.incomplete;
    if (extras.fullScan) entry.fullScan = extras.fullScan;
    await this.store.set(cacheKey(orgId, username), entry);
  }

  /** Returns undefined when missing or expired; expired entries are deleted. */
  async load(orgId: string, username: string): Promise<CacheEntry | undefined> {
    const key = cacheKey(orgId, username);
    const entry = await this.store.get<CacheEntry>(key);
    if (!entry) return undefined;
    const age = this.now().getTime() - new Date(entry.savedAt).getTime();
    if (!(age <= CACHE_TTL_DAYS * DAY_MS)) {
      await this.store.delete(key);
      return undefined;
    }
    return entry;
  }
}

/** "from your last scan, 3 days ago", based on the oldest part. */
export function staleness(entry: Pick<CacheEntry, 'fetchedAt'>, now: Date): string {
  const oldest = Math.min(...Object.values(entry.fetchedAt).map((t) => new Date(t).getTime()));
  const days = Math.max(0, Math.floor((now.getTime() - oldest) / DAY_MS));
  const when = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `from your last scan, ${when}`;
}

export interface ModifiedItem { id: string; modified: string }

/** Maps and apps changed since the dependencies were last fetched. */
export function depsToRecheck<T extends ModifiedItem>(
  cachedDeps: { fetchedAt: string },
  mapsAndApps: T[],
): T[] {
  const since = new Date(cachedDeps.fetchedAt).getTime();
  return mapsAndApps.filter((m) => new Date(m.modified).getTime() > since);
}

/**
 * Maps and apps to read: never read, or changed since they were read. Without `readAt` (an older cache) every map counts
 * as read at `fetchedAt`, which is depsToRecheck.
 */
export function mapsToRead<T extends ModifiedItem>(
  prev: { fetchedAt: string; readAt?: Record<string, string> },
  mapsAndApps: T[],
): T[] {
  if (!prev.readAt) return depsToRecheck(prev, mapsAndApps);
  const readAt = prev.readAt;
  return mapsAndApps.filter((m) => {
    const at = readAt[m.id];
    return at === undefined || new Date(m.modified).getTime() > new Date(at).getTime();
  });
}

/**
 * Sizes a lazy scan can take from the cache instead of measuring again (DC-053): services the last scan measured and
 * whose item has not been modified since. Everything else is measured. DC-134: a size cached before DC-134 has no
 * attachment figure: it is reused as it is (so the review is complete at once) and sizeOrder refreshes it in the background.
 */
export function sizesToReuse(current: Pick<Service, 'id' | 'modified'>[], previous: Pick<Data, 'services'> | undefined): Map<string, SizeInfo> {
  const out = new Map<string, SizeInfo>();
  if (!previous) return out;
  const before = new Map(previous.services.map((s) => [s.id, s]));
  for (const s of current) {
    const p = before.get(s.id);
    if (p && p.sizeMB !== null && p.modified === s.modified) out.set(s.id, p.attachmentMB === undefined ? { sizeMB: p.sizeMB } : { sizeMB: p.sizeMB, attachmentMB: p.attachmentMB });
  }
  return out;
}
