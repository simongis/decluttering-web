// FB-24: "Select all / Select none" on the Emails step's owner list. Only owners with items can be ticked.
export type SelectState = 'all' | 'some' | 'none';

import { t, tn } from '../../i18n';

export interface Selection { state: SelectState; count: number; total: number; label: string }

export function selectionOf(sendable: string[], ticked: ReadonlySet<string>): Selection {
  const count = sendable.filter((u) => ticked.has(u)).length, total = sendable.length;
  const state: SelectState = count === 0 ? 'none' : count === total ? 'all' : 'some';
  return { state, count, total, label: t('emails.selection.count', { count, total }) };
}

/* DC-121: owners with no email on file are marked, and never counted in or sent a real send. */
export const hasEmail = (o: { email?: string }): boolean => !!o.email?.trim();

/**
 * `known` is false when no owner has an address at all (a cached scan keeps none: ADR 0009). We can't tell "no email on
 * file" from "not loaded" then, so nobody is excluded; otherwise owners without one are listed in `noEmail`.
 */
export function splitByEmail<T extends { email?: string }>(owners: readonly T[]): { known: boolean; reachable: T[]; noEmail: T[] } {
  const known = owners.some(hasEmail);
  if (!known) return { known, reachable: [...owners], noEmail: [] };
  return { known, reachable: owners.filter(hasEmail), noEmail: owners.filter((o) => !hasEmail(o)) };
}

/** The confirm-dialog line: "2 of 7 owners have no email on file, so they won’t get one." (null when it doesn't apply). */
export function noEmailLine(n: number, of: number): string | null {
  if (n <= 0) return null;
  return tn(n === 1 ? 'emails.no.email.one' : 'emails.no.email.other', n, { total: of });
}

export const selectAll = (sendable: string[]): Set<string> => new Set(sendable);
export const selectNone = (): Set<string> => new Set();
