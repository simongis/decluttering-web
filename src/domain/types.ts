import type { Priority } from './priority';
export interface Org { id: string; name: string; urlKey: string; scannedAt: string; /** The org's custom base URL host (portals/self), e.g. maps.arcgis.com. */ customBaseUrl?: string }

export interface Owner {
  username: string; fullName: string; email?: string; role?: string;
  disabled: boolean; thumbnail: string | null; lastNotified: string | null;
}

/**
 * A map or app that links a layer. DC-147c: `modified` (ISO) and `contentStatus` come from its search row (no extra
 * request), for the item panel's lists and chips; scans saved before DC-147c lack them (shown without the date).
 */
export interface Dependency { id: string; title: string; type: string; owner: string; modified?: string; contentStatus?: string }

/**
 * DC-035a: a map or app that points at a hosted layer no longer in the org. `missing` holds the referenced item ids
 * (32-hex), or `name:<service name>` when the reference had a service url but no item id. Ids only, so the cache stays small.
 * DC-137: `modified` (ISO) and `contentStatus` come from the map's or app's search row (no extra request); scans saved before
 * DC-137 lack them until the map is listed again.
 */
export interface BrokenRef { id: string; title: string; type: string; owner: string; missing: string[]; modified?: string; contentStatus?: string }

export interface Service {
  id: string; title: string; owner: string; created: string; modified: string;
  /** DC-131: newest edit date across the service's layers and tables, as ISO. undefined: not read; null: read, no date. */
  dataEdited?: string | null;
  /** Storage in MB. null: not measured yet (lazy sizing on big orgs, or a scan stopped early; DC-053). */
  sizeMB: number | null;
  /**
   * DC-134: of sizeMB, the attachments (the item's `subInfo`), billed as file storage. Absent: measured before DC-134
   * or not at all, so counted as 0 (every byte at the feature rate).
   */
  attachmentMB?: number;
  access: string; isView: boolean; sourceId: string | null;
  /** [daysAgo, count] relative to org.scannedAt */
  usage: [number, number][];
  /**
   * DC-083: when the item was last opened or its data read (Esri's `lastViewed`, from the search row), as ISO.
   * null: blank, which Esri says means "not since about November 2022". Absent (undefined): a scan saved before
   * DC-083 that never read it, so last used comes from data requests only.
   */
  lastViewed?: string | null;
  /** DC-083: total views all time (`numViews`). Context only, never a filter: data requests do not raise it. */
  numViews?: number;
  dependencies: Dependency[];
  description?: string; snippet?: string; tags?: string[];
  /** GH-2: Esri's content status badge from the search row (`deprecated`, `org_authoritative`, ...). Absent: none, or a scan from before. */
  contentStatus?: string;
}

export interface Data {
  org: Org; owners: Owner[]; services: Service[];
  /**
   * DC-083: false when part of the usage history could not be read (a usage window failed). Then a layer whose
   * lastViewed is blank or older than the rule's age has an unknown last use, and is never flagged. Absent: read in full.
   */
  usageComplete?: boolean;
  /** DC-035a: maps and apps with references to layers that are gone (see domain/broken-refs.ts). Absent: not looked for. */
  brokenRefs?: BrokenRef[];
  /**
   * DC-147: how many UTC days of usage history the scan read, up to and including the scan day (usage days 0 to
   * usageDays - 1). Absent: 365, a scan saved before DC-147. The rule only ever looks at the first 365 (USAGE_RULE_DAYS).
   */
  usageDays?: number;
  /**
   * DC-147: usage windows that failed, as inclusive [newest, oldest] days-ago ranges. Days in them without requests are
   * "not read", never zero. Absent: none recorded (a scan before DC-147 with usageComplete false gives no ranges).
   */
  usageGaps?: [number, number][];
  /** DC-147: apps that show a layer through a web map or scene (see MapApps). Absent: not looked for (a scan before DC-147). */
  mapApps?: MapApps;
}

/**
 * DC-147: apps whose /data references a web map (or web scene) in the org by id, for the item panel's "Through a map"
 * column. `byMap`: map id to app ids (every such reference, so an app not read again stays right when its map gains a
 * layer); `apps`: each of those apps once.
 */
export interface MapApps { byMap: Record<string, string[]>; apps: Dependency[] }

export interface Family { id: string; source: Service; views: Service[] }

export interface Thresholds {
  /** DC-083: last used at least this many days ago (0: the use rule is skipped, for roles that cannot see usage). */
  minDaysSinceUse: number;
  minDaysSinceUpdate: number; maxUsedBy: number;
  minSizeMB?: number;
  /** GH-2: leave out layers the org has marked deprecated. Off by default; not part of any starting point. */
  excludeDeprecated?: boolean;
  /** GH-2: show layers the org has marked authoritative. Off by default (they are left out); not part of any starting point. */
  includeAuthoritative?: boolean;
}

export type TidyHint = 'description' | 'tags' | 'summary';

export interface Row {
  family: Family; source: Service; views: Service[]; owner: Owner;
  /**
   * DC-083: days since the family was last used: the newest of lastViewed and the last UTC day with data requests,
   * across the source and its views. null when neither shows any use.
   */
  lastUsedDaysAgo: number | null;
  /** False when last use can't be told under these thresholds (part of the usage history failed). Never flagged. */
  useKnown: boolean;
  /** Blank lastViewed and no data requests in the year read: "No use recorded since at least November 2022". */
  noUseRecorded: boolean;
  /** The scan has no lastViewed (saved before DC-083): last used comes from data requests only. */
  requestsOnly: boolean;
  /** Total views all time across the family; null when the scan did not read them. */
  numViews: number | null;
  daysSinceUpdate: number; lastModified: string;
  /** Known storage only: 0 (and 0 credits) while the source's size is not measured yet; see sizeKnown. */
  usedBy: number; sizeMB: number; credits: number; why: string;
  /** DC-134: of sizeMB, the source's attachments, priced as file storage in credits. */
  attachmentMB: number;
  /** False while the source's storage is not measured yet. Such rows are never hidden by "Size: at least". */
  sizeKnown: boolean;
  tidyHints: TidyHint[]; tidy: string | null;
  weekly: number[];
  /** DC-144: of each week's request days, how many had only sweep touches (set aside by Last used; none when the admin counts sweeps). Same length as weekly. */
  weeklySwept: number[];
  /** DC-144: data requests over the 91 days (day 0 plus the previous 90 UTC days), summed over the source and its views. */
  requests91: number;
  /** DC-144: the busiest of those days, summed over the family; null with no requests. `date` is its UTC date (YYYY-MM-DD). */
  busiest: { daysAgo: number; count: number; date: string } | null;
  /** DC-144: false when a usage window failed (data.usageComplete === false): the sparkline says "not read" and never draws zero. */
  usageRead: boolean;
  stale: boolean; staleness: number;
  priority: Priority; priorityReason: string;
}

export interface OwnerGroup {
  owner: Owner; rows: Row[]; credits: number; sizeMB: number;
  /** Rows whose storage is not measured yet (credits and sizeMB count only the known ones). */
  unmeasured: number;
  startCount: number;
  disabled: boolean; nudgedRecently: boolean; nudgedDaysAgo: number | null; defaultTicked: boolean;
}

export interface UnreachableGroup { owner: Owner; rows: Row[]; credits: number; sizeMB: number }

export interface EvaluateResult {
  families: Row[];
  owners: OwnerGroup[];
  unreachable: UnreachableGroup[];
  totals: {
    services: number; families: number; owners: number; unreachableFamilies: number; credits: number; sizeMB: number;
    /** Families whose storage is not measured yet; credits and sizeMB are "so far". */
    unmeasured: number;
  };
}

export interface Option { value: number; label: string }

/** DC-096: one logged send to one owner, as read back from the nudge log (test rows left out). */
export interface LoggedSend {
  owner: string;
  /** ISO time of the send. */
  sentAt: string;
  /** The items in the digest (the log keeps up to about 240). */
  itemIds: string[];
  /** How many items the digest held (can exceed itemIds when the list was cut short). */
  itemCount: number;
  /** The owner's estimated credits a month for those items, at send time. */
  credits: number;
}
