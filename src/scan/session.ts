// One scan from the app's point of view (DC-053): the core, then sizes (big orgs only) and dependencies in the background,
// with the cache's incremental paths. No browser APIs here, so the Stop semantics are unit tested; scan-run.ts wires it up.
import type { Data, Dependency } from '../domain/types';
import { sizesToReuse, type CacheEntry, type CacheExtras, type FetchedAt } from '../cache/scanCache';
import { scanCore, scanDependencies, scanSizes, withDependencies, withSizes } from './pipeline';
import type { RequestFn, ScanOptions, SizeInfo, SizeResult } from './types';

export interface DataState {
  /** Every map and app has been checked, so "used by" can be trusted. */
  depsKnown: boolean;
  /** Services whose storage is not measured yet. */
  unmeasured: number;
}

export interface SessionOptions extends ScanOptions {
  /** The cached entry: lazy sizing reuses its sizes, and only unread or changed maps and apps are read. */
  previous?: CacheEntry;
  /** Applied to every Data handed out (the my-items owner fix). */
  fix?: (d: Data) => Data;
  /** First call right after the core (the review can open), then at most every renderMs, then once at the end. */
  onData?: (data: Data, state: DataState) => void;
  renderMs?: number;
  /** Saves the result, complete or not (a stopped scan is saved with what it has). Failures are ignored. */
  save?: (data: Data, fetchedAt: FetchedAt, extras: CacheExtras) => Promise<void>;
  clock?: () => number;
}

export interface SessionOutcome {
  data: Data; warnings: string[];
  /** ms from the start until the review could first be shown. */
  coreMs: number;
  /** ms from the start until every size was known (null when stopped first). */
  sizesMs: number | null;
  /** Stop was pressed after the core: data holds what was known at that point. */
  stopped: boolean;
  depsComplete: boolean;
  unmeasured: number;
  /**
   * DC-071a: what a stopped scan left for next time (null when nothing is left). The cache keeps what was read, so the
   * next scan measures and reads only these. A warning says so in words.
   */
  resume: { mapsLeft: number; sizesLeft: number } | null;
}

const unmeasuredIn = (d: Data) => d.services.reduce((n, s) => n + (s.sizeMB === null ? 1 : 0), 0);

/**
 * Stop semantics (DC-053): an abort before the core finishes rejects with AbortError (partial usage would make everything
 * look unused, which is dishonest). An abort after the core ends the background work and resolves with `stopped: true`
 * and what is known: unmeasured sizes stay null, unread maps and apps are simply not counted, and the cache says so.
 */
export async function scanSession(request: RequestFn, o: SessionOptions): Promise<SessionOutcome> {
  const clock = o.clock ?? (() => performance.now());
  const now = o.now ?? Date.now;
  const renderMs = o.renderMs ?? 1000;
  const fix = o.fix ?? ((d: Data) => d);
  const t0 = clock();
  const prev = o.previous;

  const core = await scanCore(request, o);
  if (core.sizesPending) {
    // Measure only what the cache doesn't already know.
    const reuse = sizesToReuse(core.data.services, prev?.data);
    if (reuse.size) core.data = withSizes(core.data, reuse);
  }
  const coreMs = Math.round(clock() - t0);

  let sizes: ReadonlyMap<string, SizeInfo> = new Map();
  // Until this scan's links arrive, show the cached ones.
  let deps = new Map<string, Dependency[]>(prev?.data.services.map((s) => [s.id, s.dependencies]) ?? []);
  let depsDone = false;
  // depsChecked (FB-15) is true for every service only once every map and app has been read (or reused from a complete read).
  const compose = () => fix(withDependencies(withSizes(core.data, sizes), deps, depsDone));
  const emit = () => { const d = compose(); o.onData?.(d, { depsKnown: depsDone, unmeasured: unmeasuredIn(d) }); };
  emit();

  let last = clock(), dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => { timer = null; if (dirty) { dirty = false; emit(); last = clock(); } };
  const schedule = () => {
    dirty = true;
    const wait = renderMs - (clock() - last);
    if (wait <= 0) flush(); else timer ??= setTimeout(flush, wait);
  };

  let sizesMs: number | null = core.sizesPending ? null : coreMs;
  const sizing: Promise<SizeResult | null> = core.sizesPending
    ? scanSizes(core, { signal: o.signal, onSizes: (b) => { sizes = b.sizes; schedule(); } })
      .then((r) => { if (!r.stopped) sizesMs = Math.round(clock() - t0); return r; })
    : Promise.resolve(null);
  const reading = scanDependencies(core, {
    signal: o.signal,
    previous: prev ? { fetchedAt: prev.fetchedAt.dependencies, data: prev.data, readAt: prev.depsReadAt } : undefined,
    onBatch: (b) => { deps = b.dependencies; schedule(); },
  }).then((r) => { depsDone = !r.stopped && core.ctx.depsMode !== 'none'; deps = r.dependencies; return r; });
  let sz: SizeResult | null, dp: Awaited<typeof reading>;
  try { [sz, dp] = await Promise.all([sizing, reading]); }
  finally { if (timer) clearTimeout(timer); timer = null; }

  if (sz) sizes = sz.sizes;
  const data = compose();
  const unmeasured = unmeasuredIn(data);
  const stopped = !!sz?.stopped || dp.stopped;
  core.ctx.meter.finish(stopped);
  o.onData?.(data, { depsKnown: depsDone, unmeasured });
  const mapsLeft = dp.stopped ? Math.max(0, dp.total - dp.read - dp.reused) : 0;
  const resume = stopped && (mapsLeft || unmeasured) ? { mapsLeft, sizesLeft: unmeasured } : null;
  const resumeNote = resume ? [`Stopped with ${[
    resume.sizesLeft ? `${fmt(resume.sizesLeft)} service${resume.sizesLeft === 1 ? '' : 's'} still to measure` : '',
    resume.mapsLeft ? (resume.mapsLeft === 1 ? '1 map or app still to check' : `${fmt(resume.mapsLeft)} maps and apps still to check`) : '',
  ].filter(Boolean).join(' and ')}. The next scan picks up where this one left off.`] : [];

  const stamp = new Date(now()).toISOString();
  const extras: CacheExtras = { depsReadAt: dp.readAt };
  if (stopped || unmeasured) extras.incomplete = { unmeasured, deps: dp.stopped };
  try { await o.save?.(data, { services: stamp, usage: stamp, users: stamp, dependencies: stamp }, extras); } catch { /* the cache is a convenience */ }

  return {
    data, warnings: [...core.warnings, ...(sz?.warnings ?? []), ...dp.warnings, ...resumeNote],
    coreMs, sizesMs, stopped, depsComplete: !dp.stopped, unmeasured, resume,
  };
}

const fmt = (n: number) => n.toLocaleString('en-AU');
