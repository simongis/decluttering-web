import type { BrokenRef, Data, Dependency } from '../domain/types';

export type Method = 'GET' | 'POST';

export interface RequestOptions {
  method?: Method;
  /** Return the response body as text instead of parsed JSON (used for item /data). */
  text?: boolean;
  signal?: AbortSignal;
  /** DC-071a: the shared limiter's queue priority (lower goes first). Ignored below the limiter. */
  priority?: number;
}

/**
 * An authenticated request function. `path` is relative to `<portal>/sharing/rest/`.
 * It resolves with parsed JSON (or text), and rejects with an error carrying `status` (HTTP) and/or `code`
 * (ArcGIS JSON error code) so the pipeline can decide whether to back off.
 */
export type RequestFn = (path: string, params?: Record<string, string | number>, options?: RequestOptions) => Promise<unknown>;

export type PhaseId = 'find' | 'size' | 'views' | 'usage' | 'owners' | 'deps';

export interface ScanProgress { phase: PhaseId; done: number; total: number; message: string }

/**
 * DC-071a: the progress model for the scan screen. Three stages people understand, each determinate by its own count:
 *   find:    "Finding layers" (services found of the search total; owners as a part)
 *   measure: "Checking use and size" (services measured of those to measure; usage windows and views as parts)
 *   deps:    "Checking maps and apps" (maps and apps checked of all of them; reused ones count as checked)
 * Stages overlap (usage starts with find), so each has its own state. Built by ScanMeter (progress.ts).
 */
export type StageId = 'find' | 'measure' | 'deps';
export type StageState = 'waiting' | 'working' | 'done' | 'stopped';

export interface StagePart { done: number; total: number | null }

export interface StageProgress {
  id: StageId;
  /** "Finding layers", "Checking use and size", "Checking maps and apps". */
  label: string;
  state: StageState;
  /** The headline count. total is null while not known yet. */
  done: number; total: number | null;
  /** 0..1, including the stage's parts (a stage can be busy before its headline count moves). */
  fraction: number;
  /** Headline items per second over the last ~10 s; null until there is enough to tell. */
  rate: number | null;
  /** ms since the scan started; null until it starts or ends. */
  startedMs: number | null; endedMs: number | null;
  /** find: services, owners. measure: usage (windows), views, sizes. deps: listing (maps and apps listed), maps (checked). */
  parts: Record<string, StagePart>;
}

/** What an estimate needs: calls are the unit of work (stages differ by orders of magnitude in items). */
export interface ScanEstimate {
  callsDone: number;
  /** A planning estimate, not a promise: sizes and listings are estimated until they are planned. */
  callsLeft: number;
  /** Completed calls per second over the last ~10 s; null until there is enough to tell. */
  callsPerSec: number | null;
  /** callsLeft / callsPerSec; null when the rate is unknown. The UI should smooth it and show it only when stable. */
  etaMs: number | null;
  /** The shared limiter: calls allowed in flight, in flight now, queued. */
  limit: number; inFlight: number; queued: number;
  /** ArcGIS Online asked us to slow down (a 429 or 503) and the limit has not grown back yet. */
  slowedDown: boolean;
  throttles: number;
}

export interface ScanStages {
  stages: [StageProgress, StageProgress, StageProgress];
  /** The first stage not done (what the current-stage line talks about); null when all are done or stopped. */
  current: StageId | null;
  /** 0..100, whole number, from calls done and estimated calls left; 100 only when finished. */
  percent: number;
  /** The core is in: the review can open (partial results are fine). */
  readyToReview: boolean;
  finished: boolean;
  /** Stop was pressed after the core: unfinished stages are 'stopped', and the next scan resumes them. */
  stopped: boolean;
  elapsedMs: number;
  estimate: ScanEstimate;
}

export type DepsMode = 'all' | 'none' | `sample:${number}`;

export interface ScanOptions {
  portal: string;
  orgId: string;
  orgName?: string;
  urlKey?: string;
  customBaseUrl?: string;
  onProgress?: (p: ScanProgress) => void;
  /** DC-071a: the three-stage progress model, at most every STAGE_EMIT_MS and on every stage change. */
  onStages?: (s: ScanStages) => void;
  signal?: AbortSignal;
  depsMode?: DepsMode;
  /** Above this many services the core skips sizing; scanSizes measures them afterwards (DC-053). Default LAZY_SIZE_THRESHOLD. */
  lazySizeThreshold?: number;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ScanResult {
  data: Data; warnings: string[];
  /** False until every map and app has been looked at; "used by" is not trustworthy before then (ADR 0007). */
  depsKnown: boolean;
}

/** What scanCore hands to scanDependencies. */
export interface CoreResult extends ScanResult {
  depsKnown: false;
  /** True when the core skipped sizing (a big org): every service's sizeMB is null until scanSizes fills it in. */
  sizesPending: boolean;
  ctx: {
    call: RequestFn; progress: (phase: PhaseId, done: number, total: number, message: string) => void;
    orgId: string; byId: Set<string>; byName: Map<string, string[]>; depsMode: DepsMode; signal?: AbortSignal;
    /** The three-stage progress model shared by every phase (DC-071a). */
    meter: import('./progress').ScanMeter;
    /** The first page of the maps-and-apps listing, asked for alongside find so its total is known early (DC-071a). */
    referrersFirst?: Promise<Record<string, unknown> | null>;
    /** Where each service lives, from the search (owner and, when the search says, its folder): for hybrid sizing. */
    where: Map<string, { owner: string; folder?: string | null }>;
  };
}

export interface DependencyBatch {
  /** Cumulative: service id to the maps and apps found so far. */
  dependencies: Map<string, Dependency[]>;
  done: number; total: number; final: boolean;
}

export interface DependencyOptions {
  onBatch?: (b: DependencyBatch) => void;
  signal?: AbortSignal;
  batchSize?: number;
  /**
   * A cached scan: only maps and apps modified after they were last read are re-read. `readAt` (map id to when it was
   * read) is the per-map record; without it every map counts as read at fetchedAt. A map missing from `readAt` was never
   * read (a stopped scan) and is read now.
   */
  previous?: { fetchedAt: string; data: Data; readAt?: Record<string, string> };
}

export interface DependencyResult {
  dependencies: Map<string, Dependency[]>; warnings: string[]; read: number; reused: number;
  /** Maps and apps in the org (listed); read + reused = total when complete. */
  total: number;
  /** Map or app id to when its links were read (reused ones keep their earlier time). Saved with the cache. */
  readAt: Record<string, string>;
  /** DC-035a: maps and apps pointing at hosted layers that are gone (what was read or reused; see domain/broken-refs.ts). Absent when maps were not read. */
  brokenRefs?: BrokenRef[];
  /** True when aborted after the core: the result holds what was read so far, and is not complete. */
  stopped: boolean;
}

/** What one content/items/{id} call tells us beyond the search result. */
export interface SizeInfo {
  sizeMB: number;
  /** DC-134: of sizeMB, the attachments (the item's `subInfo`). Absent only on sizes cached before DC-134. */
  attachmentMB?: number;
  description?: string; snippet?: string; tags?: string[];
}

export interface SizeBatch {
  /** Cumulative: service id to its measured size (and fuller metadata). */
  sizes: Map<string, SizeInfo>;
  done: number; total: number; final: boolean;
}

export interface SizeOptions {
  onSizes?: (b: SizeBatch) => void;
  signal?: AbortSignal;
  batchSize?: number;
}

export interface SizeResult {
  sizes: Map<string, SizeInfo>; warnings: string[];
  /** Services still without a size (not reached before a stop, or unreadable). */
  missing: number;
  stopped: boolean;
}
