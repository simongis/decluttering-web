// DC-096: closing the loop. What happened to each nudged item since its most recent logged send, compared with today's
// scan, and roughly how many credits a month the items no longer in the org were worth. Pure: no requests, no DOM.
// Correlation only: the app never says an outcome happened because of a nudge.
import { DAY, fmtDate, fmtInt } from './format';
import { families, familyUse } from './stale';
import type { Data, Family, LoggedSend, Service } from './types';

/** First match wins, in this order. */
export type Outcome = 'gone' | 'handedOver' | 'updated' | 'used' | 'noChange' | 'notChecked';
export const OUTCOMES: readonly Outcome[] = ['gone', 'handedOver', 'updated', 'used', 'noChange', 'notChecked'];
export type OutcomeCounts = Record<Outcome, number>;

export const OUTCOME_LABEL: Record<Outcome, string> = {
  gone: 'No longer in your org', handedOver: 'Handed over', updated: 'Updated', used: 'Used again', noChange: 'No change yet', notChecked: 'Not checked',
};
export const USED_AGAIN_TIP = 'Someone used it after the nudge; it may still be needed.';

export interface ItemOutcome {
  id: string; outcome: Outcome;
  /** From today's scan; null when the item is no longer in it. */
  service: Service | null;
}

export interface OwnerOutcome {
  owner: string;
  /** The newest send to this owner (ISO). */
  sentAt: string;
  sends: number;
  items: ItemOutcome[];
  counts: OutcomeCounts;
  credits: number;
}

export interface SinceNudges {
  owners: OwnerOutcome[];
  /** The newest send (ISO). */
  latest: string;
  counts: OutcomeCounts;
  /** Credits a month the items no longer in the org were worth at send time. */
  credits: number;
  /** True when every send that counts towards `credits` has all its items gone (no apportioning). */
  exact: boolean;
}

export interface OutcomeOpts {
  /** Today's scan is partial (stopped early, or usage can't be seen): use not shown is "not checked", not "no change". */
  partial?: boolean;
  /** DC-086: the admin's setting, so last used matches the review. */
  countSweeps?: boolean;
}

const zero = (): OutcomeCounts => ({ gone: 0, handedOver: 0, updated: 0, used: 0, noChange: 0, notChecked: 0 });

function familyIndex(data: Data): Map<string, Family> {
  const m = new Map<string, Family>();
  for (const f of families(data)) for (const s of [f.source, ...f.views]) m.set(s.id, f);
  return m;
}

/** Whole outcomes per nudged item, grouped by owner (newest send first). Null when there are no sends. */
export function sinceNudges(data: Data, sends: readonly LoggedSend[] | null | undefined, opts: OutcomeOpts = {}): SinceNudges | null {
  const valid = (sends ?? []).filter((s) => s.owner && Number.isFinite(Date.parse(s.sentAt)));
  if (!valid.length) return null;
  const ref = Date.parse(data.org.scannedAt);
  const partial = !!opts.partial || data.usageComplete === false;
  const byId = new Map(data.services.map((s) => [s.id, s]));
  const fam = familyIndex(data);

  // Each item belongs to its most recent send.
  const newestFirst = [...valid].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  const claimed = new Set<string>();
  const owners = new Map<string, OwnerOutcome>();
  let credits = 0, exact = true;
  for (const s of newestFirst) {
    const sent = Date.parse(s.sentAt);
    const sentAgo = (ref - sent) / DAY;
    const ids = [...new Set(s.itemIds)].filter((i) => !claimed.has(i));
    ids.forEach((i) => claimed.add(i));
    const items = ids.map((i): ItemOutcome => {
      const service = byId.get(i) ?? null;
      if (sent >= ref) return { id: i, outcome: 'notChecked', service };
      if (!service) return { id: i, outcome: 'gone', service };
      if (service.owner !== s.owner) return { id: i, outcome: 'handedOver', service };
      const f = fam.get(i);
      const members = f ? [f.source, ...f.views] : [service];
      // DC-131: the item or its data, whichever changed.
      if (members.some((m) => Date.parse(m.modified) > sent || Date.parse(m.dataEdited ?? '') > sent)) return { id: i, outcome: 'updated', service };
      const last = familyUse(data, members, opts.countSweeps).last;
      // `last` is whole days before the scan, so the use was certainly after the send only a full day later.
      if (last !== null && last + 1 <= sentAgo) return { id: i, outcome: 'used', service };
      return { id: i, outcome: partial ? 'notChecked' : 'noChange', service };
    });
    const gone = items.filter((x) => x.outcome === 'gone').length;
    const count = Math.max(s.itemCount, s.itemIds.length, 1);
    const saved = gone ? (s.credits > 0 ? s.credits : 0) * Math.min(1, gone / count) : 0;
    if (gone) { credits += saved; if (gone < count) exact = false; }
    const o = owners.get(s.owner) ?? { owner: s.owner, sentAt: s.sentAt, sends: 0, items: [], counts: zero(), credits: 0 };
    o.sends += 1; o.credits += saved; o.items.push(...items);
    for (const x of items) o.counts[x.outcome] += 1;
    owners.set(s.owner, o);
  }
  const counts = zero();
  for (const o of owners.values()) for (const k of OUTCOMES) counts[k] += o.counts[k];
  return { owners: [...owners.values()], latest: (newestFirst[0] as LoggedSend).sentAt, counts, credits, exact };
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const credit = (c: number) => (c < 10 ? c.toFixed(1) : fmtInt(c));
const creditWords = (c: number, exact: boolean) => `${exact ? '' : 'about '}${credit(c)} credits a month`;

/** The non-gone parts, e.g. ["5 updated", "3 used again", "20 no change yet"]. */
export function outcomeParts(c: OutcomeCounts): string[] {
  const p: string[] = [];
  if (c.handedOver) p.push(`${fmtInt(c.handedOver)} handed over`);
  if (c.updated) p.push(`${fmtInt(c.updated)} updated`);
  if (c.used) p.push(`${fmtInt(c.used)} used again`);
  if (c.noChange) p.push(`${fmtInt(c.noChange)} no change yet`);
  if (c.notChecked) p.push(`${fmtInt(c.notChecked)} not checked`);
  return p;
}

/** "12 layers no longer in your org, about 140 credits a month", or null when none are gone. */
export function goneWords(c: OutcomeCounts, credits: number, exact: boolean): string | null {
  if (!c.gone) return null;
  const n = plural(c.gone, 'layer', 'layers');
  return credits >= 0.05 ? `${n} no longer in your org, ${creditWords(credits, exact)}` : `${n} no longer in your org`;
}

/** The card's line: "Since you nudged 14 owners (latest 17 Oct 2026): 12 layers no longer in your org, about 140 credits a month · 5 updated · …". */
export function sinceLine(s: SinceNudges): string {
  const parts = [goneWords(s.counts, s.credits, s.exact), ...outcomeParts(s.counts)].filter((x): x is string => !!x);
  return `Since you nudged ${plural(s.owners.length, 'owner', 'owners')} (latest ${fmtDate(s.latest)}): ${parts.join(' · ')}`;
}

/** The owner chip's extra words, e.g. "2 of 4 gone"; null when nothing is gone. */
export function ownerChip(o: OwnerOutcome): string | null {
  return o.counts.gone ? `${fmtInt(o.counts.gone)} of ${fmtInt(o.items.length)} gone` : null;
}

/** The scan finish line's one clause, or null when nothing nudged is gone. */
export function finishClause(s: Pick<SinceNudges, 'credits' | 'exact'> & { counts: Pick<OutcomeCounts, 'gone'> } | null): string | null {
  if (!s?.counts.gone) return null;
  return s.credits >= 0.05
    ? `Since your last nudges: ${creditWords(s.credits, s.exact)} saved.`
    : `Since your last nudges: ${plural(s.counts.gone, 'layer', 'layers')} no longer in your org.`;
}
