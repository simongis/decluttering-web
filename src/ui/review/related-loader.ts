// DC-147d: asks ArcGIS Online's relatedItems (forward, every type) for the maps of an opened family, and keeps the answers
// for the scan run. Two calls at a time; a panel open goes before idle pre-fetch; idle work not yet started can be dropped.
// "Not available" (403: only the owner or an admin may ask) is kept for the run, so it is never asked again; other failures
// are kept for a minute, so a flaky network can't become a retry storm. After that a failure still reads as failed, but the
// next ask (a panel open) sends it again. No DOM here: unit tested with a fake request.
// relatedItems does not count as use (docs/research/usage-representation.md 6.1).
import type { RequestFn } from '../../scan/types';
import type { Connections } from '../../domain/connections';
import { MAP_CAP, mapsToCheck, parseRelated, relatedFailure, type RelatedResult } from '../../domain/related-extras';

export type LoadKind = 'open' | 'idle';

export interface LoaderOptions {
  /** Calls in flight at most. Default 2. */
  concurrency?: number;
  /** How long a failure (not a 403) is kept before the map may be asked again. Default 60 s. */
  failTtlMs?: number;
  now?: () => number;
}

/** The scan's limiter queue priority (lower first): behind every scan phase. Ignored by request functions without a limiter. */
export const RELATED_PRIORITY = 99;

interface Job { mapId: string; kind: LoadKind; waiters: (() => void)[] }

export class RelatedLoader {
  private run = '';
  private gen = 0;
  private cache = new Map<string, { r: RelatedResult; at: number }>();
  private queue: Job[] = [];
  private flying = new Map<string, Job>();
  private listeners = new Set<() => void>();
  private readonly conc: number;
  private readonly failTtl: number;
  private readonly now: () => number;
  /** Every call sent, in order (a test hook, and the measure for docs/perf). */
  readonly log: { mapId: string; path: string; kind: LoadKind; at: number }[] = [];

  constructor(private readonly resolve: () => RequestFn | null | Promise<RequestFn | null>, o: LoaderOptions = {}) {
    this.conc = o.concurrency ?? 2;
    this.failTtl = o.failTtlMs ?? 60_000;
    this.now = o.now ?? (() => Date.now());
  }

  /** The scan run the answers belong to (org and scan time). A different run clears everything. */
  setRun(key: string): void {
    if (key === this.run) return;
    this.run = key;
    this.gen++;
    this.cache.clear();
    const dropped = [...this.queue, ...this.flying.values()];
    this.queue = []; this.flying.clear();
    for (const j of dropped) for (const w of j.waiters) w();
    this.emit();
  }

  /**
   * The answer for a map in this run, if there is one. None while it is being asked (again). An expired failure still reads
   * as failed until it is asked again, so a panel never shows "checking" for a map nobody is asking.
   */
  result(mapId: string): RelatedResult | undefined {
    if (this.isPending(mapId)) return undefined;
    return this.cache.get(mapId)?.r;
  }

  /** An answer that stands: anything but a failure older than the failure TTL (that one may be asked again). */
  private settled(mapId: string): boolean {
    const c = this.cache.get(mapId);
    return !!c && !(!c.r.ok && c.r.reason === 'failed' && this.now() - c.at > this.failTtl);
  }

  /** Queued or in flight. */
  isPending(mapId: string): boolean { return this.flying.has(mapId) || this.queue.some((j) => j.mapId === mapId); }

  /** Calls queued or in flight. */
  get active(): number { return this.queue.length + this.flying.size; }

  /** Asks for every map without an answer; resolves when each has settled (answered, failed, dropped or the run changed). */
  load(mapIds: readonly string[], kind: LoadKind): Promise<void> {
    const waits: Promise<void>[] = [];
    if (kind === 'open') {
      // A new panel open goes first; an earlier panel's leftovers wait behind it, as idle work.
      for (const j of this.queue) if (j.kind === 'open' && !mapIds.includes(j.mapId)) j.kind = 'idle';
    }
    for (const m of new Set(mapIds)) {
      if (this.settled(m)) continue;
      let j = this.flying.get(m) ?? this.queue.find((x) => x.mapId === m);
      if (!j) {
        j = { mapId: m, kind, waiters: [] };
        this.queue.push(j);
      } else if (kind === 'open' && j.kind === 'idle') {
        j.kind = 'open';
      }
      const job = j;
      waits.push(new Promise<void>((r) => job.waiters.push(r)));
    }
    // Open first, then idle; first come first served within each.
    this.queue.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'open' ? -1 : 1));
    this.pump();
    return Promise.all(waits).then(() => undefined);
  }

  /** The family's maps (at most 20), asked; `more` is how many maps were left out by the cap. */
  loadFor(c: Pick<Connections, 'direct'>, kind: LoadKind, cap = MAP_CAP): { maps: string[]; more: number; done: Promise<void> } {
    const { maps, more } = mapsToCheck(c, cap);
    return { maps, more, done: this.load(maps, kind) };
  }

  /** Drops idle work that has not started (any user input, a scroll). Calls in flight finish and are kept. */
  cancelIdle(): void {
    const keep: Job[] = [];
    for (const j of this.queue) { if (j.kind === 'idle') for (const w of j.waiters) w(); else keep.push(j); }
    if (keep.length !== this.queue.length) { this.queue = keep; this.emit(); }
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private emit(): void { for (const fn of [...this.listeners]) fn(); }

  private pump(): void {
    while (this.flying.size < this.conc && this.queue.length) {
      const j = this.queue.shift() as Job;
      this.flying.set(j.mapId, j);
      void this.send(j, this.gen);
    }
  }

  private async send(j: Job, gen: number): Promise<void> {
    let r: RelatedResult;
    try {
      const request = await this.resolve();
      if (gen !== this.gen) return;
      if (!request) {
        r = { ok: false, reason: 'denied' };
      } else {
        const path = `content/items/${j.mapId}/relatedItems`;
        this.log.push({ mapId: j.mapId, path, kind: j.kind, at: this.now() });
        const body = await request(path, { direction: 'forward', num: 100 }, { priority: RELATED_PRIORITY });
        r = { ok: true, items: parseRelated(body) };
      }
    } catch (e) {
      r = { ok: false, reason: relatedFailure(e) };
    }
    if (gen !== this.gen) return; // the run changed: setRun already settled the waiters
    this.flying.delete(j.mapId);
    this.cache.set(j.mapId, { r, at: this.now() });
    for (const w of j.waiters) w();
    this.emit();
    this.pump();
  }
}
