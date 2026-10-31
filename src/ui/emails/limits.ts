// DC-125d, ADR 0013 decision 7: the limits the app sets on sending. ArcGIS documents none, so these numbers are
// deliberate, kept in one place, and tuned after real use. When in doubt the code sends fewer, never more. Pure.

import { onLocaleChange, t } from '../../i18n';

export const SEND_LIMITS = { perRun: 40, perDay: 100, gapMs: 2000 } as const;
export interface Limits { perRun: number; perDay: number; gapMs: number }

/**
 * The limits in force. The real ones everywhere except the demo, where a test hook (`window.__DC_DEMO_LIMITS__`) may
 * only LOWER them, so a spec can see the caps with a handful of fake owners. It can never raise a limit.
 */
export function effectiveLimits(demo: boolean, w: { __DC_DEMO_LIMITS__?: Partial<Limits> } | undefined = typeof window === 'undefined' ? undefined : (window as never)): Limits {
  const o = demo ? w?.__DC_DEMO_LIMITS__ : undefined;
  const low = (real: number, v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(real, Math.floor(v)) : real);
  return { perRun: low(SEND_LIMITS.perRun, o?.perRun), perDay: low(SEND_LIMITS.perDay, o?.perDay), gapMs: low(SEND_LIMITS.gapMs, o?.gapMs) };
}

/** The calm note when more owners are ticked than one run may send. */
export const runCapNote = (perRun: number = SEND_LIMITS.perRun): string =>
  t('emails.limit.run', { count: perRun });
/** The note when today's allowance is smaller than the run. */
export const dayNote = (sentToday: number, remaining: number): string =>
  t('emails.limit.day', { sent: sentToday, remaining });
/** Beside the disabled send button when today's allowance is used up. */
export const dayFull = (perDay: number): string => t('emails.limit.full', { count: perDay });
export let DAY_FULL = dayFull(SEND_LIMITS.perDay);
onLocaleChange(() => { DAY_FULL = dayFull(SEND_LIMITS.perDay); });

/** How many of these sends happened on `now`'s local day. Anything without a readable time is not counted. */
export function countToday(sends: readonly { sentAt: string | Date }[], now: Date = new Date()): number {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  let n = 0;
  for (const s of sends) {
    const t = s.sentAt instanceof Date ? s.sentAt : new Date(s.sentAt);
    if (!Number.isNaN(t.getTime()) && t.getFullYear() === y && t.getMonth() === m && t.getDate() === d) n += 1;
  }
  return n;
}

export interface SendPlan {
  /** How many owners go now: the first `go` of the ticked list, in the current order. */
  go: number;
  remainingToday: number;
  runCapped: boolean;
  dayCapped: boolean;
  /** Nothing can go today. */
  blocked: boolean;
  notes: string[];
}

export function planSend(ticked: number, sentToday: number, limits: Limits = SEND_LIMITS): SendPlan {
  // A number we can't trust sends nobody.
  if (!Number.isFinite(ticked) || !Number.isFinite(sentToday)) return { go: 0, remainingToday: 0, runCapped: false, dayCapped: false, blocked: true, notes: [] };
  const n = Math.max(0, Math.floor(ticked));
  const sent = Math.max(0, Math.floor(sentToday));
  const remainingToday = Math.max(0, limits.perDay - sent);
  const go = Math.min(n, limits.perRun, remainingToday);
  const blocked = remainingToday === 0;
  const dayCapped = !blocked && n > remainingToday && remainingToday <= limits.perRun;
  const runCapped = n > limits.perRun && go === limits.perRun;
  const notes: string[] = [];
  if (n > 0 && blocked) notes.push(dayFull(limits.perDay));
  else if (dayCapped) notes.push(dayNote(sent, remainingToday));
  else if (runCapped) notes.push(runCapNote(limits.perRun));
  return { go, remainingToday, runCapped, dayCapped, blocked, notes };
}

/* ------------------------------------------------------------ sends made in this page that the log may not have re-read */

const pageSends = new Map<string, Date[]>();
const key = (orgId: string, admin: string) => `${orgId}\u0000${admin}`;

export function recordPageSend(orgId: string, admin: string, at: Date = new Date()): void {
  const k = key(orgId, admin);
  pageSends.set(k, [...(pageSends.get(k) ?? []), at]);
}
export const pageSendsFor = (orgId: string, admin: string): readonly Date[] => pageSends.get(key(orgId, admin)) ?? [];
/** Forget just these sends (the ones the log now holds, once read back). Matched by the very Date recorded. */
export function forgetPageSends(orgId: string, admin: string, ats: readonly Date[]): void {
  const k = key(orgId, admin), left = (pageSends.get(k) ?? []).filter((d) => !ats.includes(d));
  if (left.length) pageSends.set(k, left); else pageSends.delete(k);
}
/** Forget all of them (it holds them now); with no arguments, forget all (tests). */
export function clearPageSends(orgId?: string, admin?: string): void {
  if (orgId === undefined || admin === undefined) pageSends.clear();
  else pageSends.delete(key(orgId, admin));
}

/**
 * This admin's sends today: their own nudge log's rows dated today (the store holds only the admin's own table, test
 * rows already left out) plus sends made in this page since the log was last read.
 */
export function sentTodayFor(orgId: string, admin: string, logged: readonly { sentAt: string | Date }[] | undefined, now: Date = new Date()): number {
  return countToday(logged ?? [], now) + countToday(pageSendsFor(orgId, admin).map((sentAt) => ({ sentAt })), now);
}
