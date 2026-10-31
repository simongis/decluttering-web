// DC-019, ADR 0013: who may send what, decided in one pure place so the UI only follows it.
//  - "Send a test to me" needs a notifier (an org that may opt in, or the demo's fake), the create-groups privilege,
//    and that the admin has opted in (their own app group exists).
//  - Sending to owners additionally needs `ownerSendsUnlocked`, which is false until the admin's own test has
//    succeeded this session (DC-125b, ./unlock), and only ever happens after the confirm dialog. The demo uses an in-memory fake, so it
//    can show the whole flow.
//  - Defence in depth: the real notifier is wrapped so owner sends throw while locked, whatever the UI does.
import { onLocaleChange, t } from '../../i18n';
import type { GroupNotifier } from '../../notify';
import type { NudgeLog } from '../../log';
import { SENDING_UNAVAILABLE_LINE } from '../../auth/access';
import { dayFull, SEND_LIMITS } from './limits';

export let OWNER_SENDS_OFF = 'Sending to owners is locked until you send yourself a test';
/** Beside the disabled "Send to N owners" button until this session's test has succeeded (DC-125b). */
export let TEST_FIRST = 'Send yourself a test first. It takes a moment, and you’ll see exactly what owners get.';
/** Why it asks again in a new session. */
export let TEST_EACH_SESSION = 'We ask for a quick test each time you sit down to send, so the email you check is the one that goes out.';
/** Shown wherever sending would be when this site (or this org) can't turn it on: calm, and not a fault of the admin. */
export let SENDING_UNAVAILABLE = SENDING_UNAVAILABLE_LINE;
/** The test block reason while the admin has not turned sending on. */
export let NOT_OPTED_IN = 'Turn on sending to send yourself a test.';
onLocaleChange(() => {
  OWNER_SENDS_OFF = t('emails.gate.owner.off');
  TEST_FIRST = t('emails.gate.test.first');
  TEST_EACH_SESSION = t('emails.gate.test.session');
  SENDING_UNAVAILABLE = t('emails.gate.unavailable');
  NOT_OPTED_IN = t('emails.gate.not.opted');
});

/**
 * Whether owner sends are unlocked. A plain boolean, or a function read at every call so the lock can be lifted
 * later in a session (DC-125b). Anything not exactly `true` locks.
 */
export type OwnerSendsUnlocked = boolean | (() => boolean);
const isUnlocked = (u: OwnerSendsUnlocked): boolean => (typeof u === 'function' ? u() : u) === true;

export interface GateInput {
  /** The demo: an in-memory fake notifier, nothing leaves the browser. */
  demo: boolean;
  /** DC-125b's seam: owner sends are unlocked for this session: only after a successful test. */
  ownerSendsUnlocked: boolean;
  /** This org may opt in to sending (VITE_SENDING; always true in the demo). */
  mayOptIn: boolean;
  /** The admin has turned sending on: their own app group exists. Ignored in the demo. */
  optedIn: boolean;
  /** null while the privilege check is still running. */
  canCreate: boolean | null;
  missing?: string;
  owners: number;
  /** DC-121: the signed-in admin's profile email. `undefined` = not known (no block); empty or blank = none (test blocked). */
  adminEmail?: string;
  /** DC-125d: owner emails this admin has sent today (own log plus this page). At the daily limit, owner sends are blocked. Unset: none counted. */
  sentToday?: number;
  /** The daily limit in force (the real one unless the demo lowers it). */
  perDay?: number;
}

export type BlockReason = 'read-only' | 'not-opted-in' | 'checking' | 'no-privilege' | 'test-first' | 'nobody' | 'no-email' | 'daily-limit';
export interface Gate { test: { ok: boolean; reason?: BlockReason; message?: string }; owners: { ok: boolean; reason?: BlockReason; message?: string } }

export function sendGate(g: GateInput): Gate {
  const noPriv = t('emails.role.privilege', { missing: g.missing || t('emails.role.create.groups') });
  const base: Gate['test'] = !g.mayOptIn && !g.demo ? { ok: false, reason: 'read-only', message: t('emails.gate.unavailable') }
    : g.canCreate === null ? { ok: false, reason: 'checking', message: t('emails.role.checking') }
    : !g.canCreate ? { ok: false, reason: 'no-privilege', message: noPriv }
    : !g.optedIn && !g.demo ? { ok: false, reason: 'not-opted-in', message: t('emails.gate.not.opted') }
    : { ok: true };
  const nobody = g.owners > 0 || !base.ok ? base : { ok: false, reason: 'nobody' as const, message: t('emails.role.tick.owner') };
  // DC-121: only the test goes to the admin, so only the test needs the admin's address.
  const noEmail = base.ok && g.adminEmail !== undefined && !g.adminEmail.trim();
  const test: Gate['test'] = noEmail ? { ok: false, reason: 'no-email', message: t('emails.role.no.email') } : nobody;
  let owners: Gate['owners'] = nobody;
  if (nobody.ok && !g.demo && g.ownerSendsUnlocked !== true) owners = { ok: false, reason: 'test-first', message: t('emails.gate.test.first') };
  else if (nobody.ok && g.sentToday !== undefined && !(g.sentToday < (g.perDay ?? SEND_LIMITS.perDay))) owners = { ok: false, reason: 'daily-limit', message: dayFull(g.perDay ?? SEND_LIMITS.perDay) };
  return { test, owners };
}

/* ------------------------------------------------------------ the send step: compose -> confirm -> sending */

export type SendStep = 'compose' | 'confirming' | 'sending' | 'done';
export type SendStepEvent = { type: 'ask' } | { type: 'cancel' } | { type: 'confirm' } | { type: 'finished' } | { type: 'again' };

/** Real sends start only from an open confirm dialog, and never while the gate is closed. */
export function nextSendStep(s: SendStep, e: SendStepEvent, gate: Gate): SendStep {
  switch (e.type) {
    case 'ask': return s === 'compose' && gate.owners.ok ? 'confirming' : s;
    case 'cancel': return s === 'confirming' ? 'compose' : s;
    case 'confirm': return s === 'confirming' && gate.owners.ok ? 'sending' : s === 'confirming' ? 'compose' : s;
    case 'finished': return s === 'sending' ? 'done' : s;
    case 'again': return s === 'done' ? 'compose' : s;
  }
}

/* ------------------------------------------------------------ the notifier, with owner sends switched off */

export class OwnerSendsOff extends Error {
  constructor() { super(t('emails.gate.owner.off')); this.name = 'OwnerSendsOff'; }
}

/**
 * Wraps a real notifier: with owner sends off, anything that would put an owner in the group or email them throws
 * before a request. The test send (to the signed-in admin only), group find-or-create and reads still work.
 */
export function gateNotifier(n: GroupNotifier, unlocked: OwnerSendsUnlocked): GroupNotifier {
  if (unlocked === true) return n;
  // Checked at every call, so a lock lifted later in the session (DC-125b) takes effect, and a lock never opens by accident.
  const off = async (): Promise<never> => { throw new OwnerSendsOff(); };
  const guard = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => (isUnlocked(unlocked) ? f(...a) : off());
  return {
    get group() { return n.group; },
    whoAmI: () => n.whoAmI(),
    canCreateGroup: () => n.canCreateGroup(),
    findGroup: () => n.findGroup(),
    createGroup: () => n.createGroup(),
    deleteGroup: () => n.deleteGroup(),
    sendTest: (s, h, f) => n.sendTest(s, h, f),
    add: guard((users: string[]) => n.add(users)),
    remove: (users) => n.remove(users),
    // Removing people only reduces exposure, so tidying is allowed with owner sends off; it never adds anyone.
    tidyGroup: () => n.tidyGroup(),
    async notify(users, subject, message, format) {
      // Only ever the signed-in admin (the test path); anyone else is an owner send.
      const me = await n.whoAmI();
      if (!isUnlocked(unlocked) && (users.length !== 1 || users[0] !== me)) throw new OwnerSendsOff();
      return n.notify(users, subject, message, format);
    },
    sendToOwner: guard((owner: string, subject: string, message: string, format?: Parameters<GroupNotifier['sendToOwner']>[3]) => n.sendToOwner(owner, subject, message, format)),
  };
}

/* ------------------------------------------------------------ the nudge log, with owner sends switched off (DC-017) */

/**
 * The log is created and written only as part of a real send to owners. With owner sends off, creating it and adding rows
 * throw before a request; finding it and reading it (both reads) still work.
 */
export function gateNudgeLog(l: NudgeLog, unlocked: OwnerSendsUnlocked): NudgeLog {
  if (unlocked === true) return l;
  const off = async (): Promise<never> => { throw new OwnerSendsOff(); };
  return {
    get table() { return l.table; },
    whoAmI: () => l.whoAmI(),
    find: () => l.find(),
    read: () => l.read(),
    // ADR 0012: removing the app's own log only reduces what is in the org, so it stays allowed with owner sends off
    // (like tidyGroup). It is never part of a send; the admin asks for it from About.
    deleteLog: () => l.deleteLog(),
    // DC-125c: reading other admins' logs is a query only (its own guard), so it stays allowed while owner sends are locked.
    findAllInOrg: () => l.findAllInOrg(),
    readOthers: () => l.readOthers(),
    create: (...a: Parameters<NudgeLog['create']>) => (isUnlocked(unlocked) ? l.create(...a) : off()),
    record: (...a: Parameters<NudgeLog['record']>) => (isUnlocked(unlocked) ? l.record(...a) : off()),
  };
}
