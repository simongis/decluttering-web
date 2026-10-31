import { onLocaleChange, t } from '../i18n';

/** Access modes, worked out from privileges (not role names). See docs/adr/0008-sign-in-and-access-levels.md. */
export type AccessMode = 'admin' | 'admin-cant-send' | 'my-items';

/** Needed to review the whole org (CONFIRMED on the dev org, 2026-10-14). */
export const ADMIN_PRIVILEGES = ['portal:admin:viewItems', 'portal:admin:viewUsers'] as const;
/** Needed to notify owners: create the hidden group, then add/remove members. */
export const SEND_PRIVILEGES = ['portal:user:createGroup', 'portal:admin:assignToGroups'] as const;

/**
 * Admin review needs the view privileges. Unreadable org usage does NOT demote an admin: the review still runs
 * on last updated, used by and size, with usage rules marked unavailable (ADR 0008; see canSeeUsage).
 * Sending additionally needs group create and assign. Anything else is My items (least access).
 */
export function accessMode(privileges: string[] | undefined, _usageReadable: boolean): AccessMode {
  const have = new Set(privileges ?? []);
  const has = (list: readonly string[]) => list.every((p) => have.has(p));
  if (!has(ADMIN_PRIVILEGES)) return 'my-items';
  return has(SEND_PRIVILEGES) ? 'admin' : 'admin-cant-send';
}

/** Rules that need usage only apply when the org usage probe succeeded. */
export function canSeeUsage(usageReadable: boolean): boolean {
  return usageReadable;
}

/** DC-111 (FB-67): one line of the sign-in checklist. `neutral` is not a failure (an org that is read-only on purpose). */
export type CapabilityId = 'view' | 'usage' | 'send' | 'org-send' | 'email';
export interface Capability { id: CapabilityId; state: 'yes' | 'no' | 'neutral'; label: string; line: string; /** ADR 0013: the row offers this button. */ action?: 'turn-on' | 'turn-off' }
export type CapabilityLevel = 'full' | 'review' | 'locked' | 'mine';
export interface Capabilities { items: Capability[]; level: CapabilityLevel; summary: string }

export const CAPABILITY_SUMMARY: Record<CapabilityLevel, string> = {
  get full() { return t('access.summary.full'); },
  get review() { return t('access.summary.review'); },
  get locked() { return t('access.summary.locked'); },
  get mine() { return t('access.summary.mine'); },
};

export let SENDING_UNAVAILABLE_LINE = t('access.sendingUnavailable');
onLocaleChange(() => { SENDING_UNAVAILABLE_LINE = t('access.sendingUnavailable'); });

/**
 * What this account can do here, from the same facts sign-in already holds: the privileges, whether the usage probe
 * worked, whether an admin in this org may turn sending on (`mayOptIn`, ADR 0013) and whether this admin has
 * (`optedIn`: their own app group exists; unknown counts as not yet). Pure; no network.
 */
export function capabilities(privileges: string[] | undefined, usageReadable: boolean, mayOptIn: boolean, optedIn = false): Capabilities {
  const on = mayOptIn && optedIn;
  const have = new Set(privileges ?? []);
  const has = (list: readonly string[]) => list.every((p) => have.has(p));
  const view = has(ADMIN_PRIVILEGES), send = has(SEND_PRIVILEGES);
  const items: Capability[] = [
    { id: 'view', state: view ? 'yes' : 'no', label: t('access.capability.view.label'),
      line: view ? t('access.capability.view.full') : t('access.capability.view.own') },
    { id: 'usage', state: usageReadable ? 'yes' : 'no', label: t('access.capability.usage.label'),
      line: usageReadable ? t('access.capability.usage.available') : t('access.capability.usage.unavailable') },
    { id: 'send', state: send ? 'yes' : 'no', label: t('access.capability.send.label'),
      line: send ? t('access.capability.send.available') : t('access.capability.send.unavailable') },
    { id: 'org-send', state: on ? 'yes' : 'neutral', label: t('access.capability.orgSend.label'),
      line: on ? t('access.capability.orgSend.on')
        : mayOptIn ? t('access.capability.orgSend.off')
        : SENDING_UNAVAILABLE_LINE,
      ...(mayOptIn && !on && send ? { action: 'turn-on' as const } : on ? { action: 'turn-off' as const } : {}) },
  ];
  const level: CapabilityLevel = !view ? 'mine' : send && on ? 'full' : send ? 'locked' : 'review';
  return { items, level, summary: CAPABILITY_SUMMARY[level] };
}

/** DC-121: shown on the checklist and as the test-send block reason. */
export let NO_ADMIN_EMAIL = t('access.noAdminEmail');
onLocaleChange(() => { NO_ADMIN_EMAIL = t('access.noAdminEmail'); });

/**
 * DC-121: the "Your email address" row. `undefined` means the address isn't known (not loaded), so there is no row;
 * an empty or blank string means the profile has none.
 */
export function emailCapability(email: string | undefined): Capability | null {
  if (email === undefined) return null;
  const e = email.trim();
  return { id: 'email', state: e ? 'yes' : 'no', label: t('access.capability.email.label'), line: e || NO_ADMIN_EMAIL };
}

/** The privileges an access mode stands for (sign-in keeps the mode, not the list). */
export function privilegesOfMode(mode: AccessMode): string[] {
  return mode === 'my-items' ? [] : mode === 'admin' ? [...ADMIN_PRIVILEGES, ...SEND_PRIVILEGES] : [...ADMIN_PRIVILEGES];
}
