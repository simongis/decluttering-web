// ADR 0012: what the "App data in your org" section on About does, as plain functions so it can be tested without a DOM.
// Finding what the app made is read-only (findGroup, the log's find and read). Removing is only ever called from an explicit
// confirm in <dc-app-data>. Both removals go through the notifier and the log, and so through their allow-lists and
// re-checks; nothing here sends a request of its own.
import { GROUP_TITLE, type GroupNotifier } from '../../notify';
import { LOG_TITLE, type NudgeLog } from '../../log';
import { itemUrl } from '../../domain/format';
import { onLocaleChange, t, tn } from '../../i18n';

/** What the section needs of the org: its id (the log's cache key) and where its pages live. */
export interface AppDataOrg { id: string; urlKey: string; customBaseUrl?: string }

export interface AppDataProps {
  notifier?: GroupNotifier | null;
  nudgeLog?: NudgeLog | null;
  writable?: boolean;
  org?: AppDataOrg | null;
}

export interface FoundGroup { id: string; title: string; href: string }
export interface FoundLog { itemId: string; title: string; href: string; /** Sends recorded (test rows left out); null when the read failed. */ sends: number | null }
export interface AppData { group: FoundGroup | null; log: FoundLog | null }

/** The section exists only for a writable org with something to look for. A read-only org gets nothing, not even a probe. */
export function canShowAppData(p: AppDataProps): boolean {
  return p.writable === true && !!p.org && !!p.org.id && !!(p.notifier || p.nudgeLog);
}

const groupHref = (org: AppDataOrg, id: string): string => itemUrl(org, id).replace('/home/item.html?', '/home/group.html?');
const itemHref = (org: AppDataOrg, id: string): string => itemUrl(org, id);

/**
 * Looks for the app's own group and log. Read only. Returns null when `signal` aborted (the caller drops the result);
 * a failed read of one thing leaves it out rather than guessing.
 */
export async function detectAppData(p: AppDataProps, signal?: AbortSignal | null): Promise<AppData | null> {
  const none: AppData = { group: null, log: null };
  if (!canShowAppData(p)) return none;
  const org = p.org!;
  const out: AppData = { group: null, log: null };
  if (p.notifier) {
    const g = await p.notifier.findGroup().catch(() => null);
    if (signal?.aborted) return null;
    if (g) out.group = { id: g.id, title: g.title, href: groupHref(org, g.id) };
  }
  if (p.nudgeLog) {
    const t = await p.nudgeLog.find().catch(() => null);
    if (signal?.aborted) return null;
    if (t) {
      const sends = await p.nudgeLog.read().then((r) => r.sends.length, () => null);
      if (signal?.aborted) return null;
      out.log = { itemId: t.itemId, title: t.title === LOG_TITLE ? t.title : LOG_TITLE, href: itemHref(org, t.itemId), sends };
    }
  }
  return out;
}

export type RemoveOutcome =
  | { ok: true; /** True when it was already gone, which counts as success. */ already: boolean }
  | { ok: false; message: string; href: string };

const notFound = (e: unknown): boolean => {
  const x = e as { code?: unknown; message?: unknown } | null;
  return x?.code === 404 || /does not exist|not found/i.test(String(x?.message ?? ''));
};

/** Removes the app's own group. Not found counts as success; any other error gives the friendly message and a link. */
export async function removeAppGroup(notifier: GroupNotifier, org: AppDataOrg): Promise<RemoveOutcome> {
  let found: Awaited<ReturnType<GroupNotifier['findGroup']>> = null;
  try {
    found = await notifier.findGroup();
    if (!found) return { ok: true, already: true };
    await notifier.deleteGroup();
    return { ok: true, already: false };
  } catch (e) {
    if (notFound(e)) return { ok: true, already: true };
    return { ok: false, message: COPY.groupFailed, href: found ? groupHref(org, found.id) : groupsHref(org) };
  }
}

/** Deletes the app's own log. Same outcomes as removeAppGroup. */
export async function removeAppLog(nudgeLog: NudgeLog, org: AppDataOrg, itemId: string): Promise<RemoveOutcome> {
  if (!nudgeLog.deleteLog) return { ok: false, message: COPY.logFailed, href: itemHref(org, itemId) };
  try {
    const r = await nudgeLog.deleteLog();
    return { ok: true, already: r === 'gone' };
  } catch (e) {
    if (notFound(e)) return { ok: true, already: true };
    return { ok: false, message: COPY.logFailed, href: itemHref(org, itemId) };
  }
}

const groupsHref = (org: AppDataOrg): string => groupHref(org, '').replace('group.html?id=', 'groups.html');

/** The words on the section, from docs/research/app-data-lifecycle.md section 3. */
function makeCopy() {
  return {
    heading: t('about.appData.heading'),
    intro: t('about.appData.intro'),
    loading: t('about.appData.loading'),
    groupRow: t('about.appData.groupRow', { title: GROUP_TITLE }),
    groupNote: t('about.appData.groupNote'),
    logRow: t('about.appData.logRow', { title: LOG_TITLE }),
    logNote: (sends: number | null): string => sends === null ? t('about.appData.logNoteUnknown') : tn('about.appData.logNote', sends),
    open: t('about.appData.open'),
    removeGroup: t('about.appData.removeGroup'),
    deleteLog: t('about.appData.deleteLog'),
    keep: t('about.appData.keep'),
    groupConfirmHeading: t('about.appData.groupConfirmHeading'),
    groupConfirm: t('about.appData.groupConfirm'),
    groupConfirmButton: t('about.appData.groupConfirmButton'),
    groupKeep: t('about.appData.groupKeep'),
    logConfirmHeading: t('about.appData.logConfirmHeading'),
    logConfirm: (rows: number | null): string => rows === null
      ? t('about.appData.logConfirmUnknown', { title: LOG_TITLE })
      : t(rows === 1 ? 'about.appData.logConfirmOne' : 'about.appData.logConfirmMany', { title: LOG_TITLE, count: rows }),
    logConfirmButton: t('about.appData.logConfirmButton'),
    groupFailed: t('about.appData.groupFailed'),
    logFailed: t('about.appData.logFailed'),
    groupDone: t('about.appData.groupDone'),
    logDone: t('about.appData.logDone'),
    busy: t('about.appData.busy'),
  } as const;
}

export let COPY = makeCopy();
onLocaleChange(() => { COPY = makeCopy(); });
