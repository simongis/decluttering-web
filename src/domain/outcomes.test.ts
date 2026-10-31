import { describe, expect, it } from 'vitest';
import { finishClause, ownerChip, sinceLine, sinceNudges, USED_AGAIN_TIP } from './outcomes';
import type { Data, LoggedSend, Service } from './types';

const DAY = 86400000;
const SCANNED = '2026-10-10T09:00:00.000Z';
const REF = Date.parse(SCANNED);
const iso = (daysAgo: number) => new Date(REF - daysAgo * DAY).toISOString();
const id = (c: string) => c.repeat(32);

const svc = (c: string, o: Partial<Service> = {}): Service => ({
  id: id(c), title: `Layer ${c}`, owner: 'amy', created: iso(800), modified: iso(400), sizeMB: 100, access: 'org', isView: false,
  sourceId: null, usage: [], lastViewed: iso(300), dependencies: [], ...o,
});
const data = (services: Service[], over: Partial<Data> = {}): Data => ({
  org: { id: 'org1', name: 'Org', urlKey: 'org', scannedAt: SCANNED },
  owners: [{ username: 'amy', fullName: 'Amy A', disabled: false, thumbnail: null, lastNotified: null }],
  services, ...over,
});
const send = (o: Partial<LoggedSend> = {}): LoggedSend => ({ owner: 'amy', sentAt: iso(90), itemIds: [id('a')], itemCount: 1, credits: 10, ...o });

const outcomeOf = (d: Data, s: LoggedSend, opts = {}) => sinceNudges(d, [s], opts)?.owners[0]?.items[0]?.outcome;

describe('sinceNudges: one outcome per nudged item, first match wins (DC-096)', () => {
  it('gone: not in today\'s scan', () => {
    expect(outcomeOf(data([]), send())).toBe('gone');
  });
  it('handed over: the owner now differs', () => {
    expect(outcomeOf(data([svc('a', { owner: 'bob' })]), send())).toBe('handedOver');
  });
  it('updated: modified after the send', () => {
    expect(outcomeOf(data([svc('a', { modified: iso(10) })]), send())).toBe('updated');
  });
  it('updated: a view of the family modified after the send counts too', () => {
    const d = data([svc('a'), svc('v', { isView: true, sourceId: id('a'), modified: iso(5) })]);
    expect(outcomeOf(d, send())).toBe('updated');
  });
  it('updated: a data edit after the send counts (DC-131), on the source or a view', () => {
    expect(outcomeOf(data([svc('a', { dataEdited: iso(10) })]), send())).toBe('updated');
    const d = data([svc('a'), svc('v', { isView: true, sourceId: id('a'), dataEdited: iso(5) })]);
    expect(outcomeOf(d, send())).toBe('updated');
  });
  it('used: last used (lastViewed or data requests) after the send', () => {
    expect(outcomeOf(data([svc('a', { lastViewed: iso(20) })]), send())).toBe('used');
    expect(outcomeOf(data([svc('a', { usage: [[30, 400]] })]), send())).toBe('used');
  });
  it('used: the same day as the send is not "after"', () => {
    expect(outcomeOf(data([svc('a', { lastViewed: iso(90) })]), send())).toBe('noChange');
  });
  it('no change yet', () => {
    expect(outcomeOf(data([svc('a')]), send())).toBe('noChange');
  });
  it('first match wins: handed over beats updated and used; updated beats used', () => {
    expect(outcomeOf(data([svc('a', { owner: 'bob', modified: iso(5), lastViewed: iso(5) })]), send())).toBe('handedOver');
    expect(outcomeOf(data([svc('a', { modified: iso(5), lastViewed: iso(5) })]), send())).toBe('updated');
  });
  it('a partial scan says "not checked" instead of "no change"; known use and the other outcomes still count', () => {
    const partial = { partial: true };
    expect(outcomeOf(data([svc('a')]), send(), partial)).toBe('notChecked');
    expect(outcomeOf(data([svc('a', { lastViewed: iso(20) })]), send(), partial)).toBe('used');
    expect(outcomeOf(data([]), send(), partial)).toBe('gone');
    expect(outcomeOf(data([svc('a', { modified: iso(5) })]), send(), partial)).toBe('updated');
  });
  it('usage that could not be read in full is partial too', () => {
    expect(outcomeOf(data([svc('a')], { usageComplete: false }), send())).toBe('notChecked');
  });
  it('a send newer than the scan is not checked yet', () => {
    expect(outcomeOf(data([]), send({ sentAt: new Date(REF + DAY).toISOString() }))).toBe('notChecked');
  });
  it('an item uses its most recent send only', () => {
    const s = sinceNudges(data([svc('a', { lastViewed: iso(50) })]), [send({ sentAt: iso(200) }), send({ sentAt: iso(40) })]);
    expect(s?.owners[0]?.items).toHaveLength(1);
    expect(s?.owners[0]?.items[0]?.outcome).toBe('noChange');
    expect(s?.owners[0]?.sentAt).toBe(iso(40));
  });
});

describe('credits saved a month', () => {
  it('apportions a send\'s credits by the share of its items gone, "about"', () => {
    const s = sinceNudges(data([svc('b'), svc('c'), svc('d')]), [send({ itemIds: [id('a'), id('b'), id('c'), id('d')], itemCount: 4, credits: 40 })]);
    expect(s?.credits).toBeCloseTo(10);
    expect(s?.exact).toBe(false);
  });
  it('is exact when every item of the send is gone', () => {
    const s = sinceNudges(data([]), [send({ itemIds: [id('a'), id('b')], itemCount: 2, credits: 12 })]);
    expect(s?.credits).toBeCloseTo(12);
    expect(s?.exact).toBe(true);
  });
  it('sums across sends and owners, and counts each outcome', () => {
    const d = data([svc('b', { modified: iso(1) }), svc('c', { owner: 'bob', lastViewed: iso(1) }), svc('d', { owner: 'bob' })]);
    const s = sinceNudges(d, [
      send({ itemIds: [id('a'), id('b')], itemCount: 2, credits: 20, sentAt: iso(100) }),
      send({ owner: 'bob', itemIds: [id('e'), id('c'), id('d')], itemCount: 3, credits: 30, sentAt: iso(30) }),
    ]);
    expect(s?.credits).toBeCloseTo(20);
    expect(s?.counts).toMatchObject({ gone: 2, updated: 1, used: 1, noChange: 1, handedOver: 0, notChecked: 0 });
    expect(s?.latest).toBe(iso(30));
    expect(s?.owners.map((o) => o.owner)).toEqual(['bob', 'amy']);
  });
  it('no sends (no log, or only test rows) gives nothing', () => {
    expect(sinceNudges(data([svc('a')]), [])).toBeNull();
    expect(sinceNudges(data([svc('a')]), null)).toBeNull();
    expect(sinceNudges(data([svc('a')]), undefined)).toBeNull();
  });
});

describe('wording', () => {
  it('the card line names owners, the newest date and each non-zero outcome', () => {
    const d = data([svc('b', { modified: iso(1) }), svc('c', { lastViewed: iso(1) }), svc('d')]);
    const s = sinceNudges(d, [send({ itemIds: [id('a'), id('b'), id('c'), id('d')], itemCount: 4, credits: 40, sentAt: '2026-10-01T00:00:00.000Z' })]);
    expect(sinceLine(s!)).toBe('Since you nudged 1 owner (latest 1 Oct 2026): 1 layer no longer in your org, about 10 credits a month · 1 updated · 1 used again · 1 no change yet');
  });
  it('exact credits drop "about"; nothing gone says so plainly', () => {
    expect(sinceLine(sinceNudges(data([]), [send({ credits: 4.24 })])!)).toBe('Since you nudged 1 owner (latest 12 Jul 2026): 1 layer no longer in your org, 4.2 credits a month');
    expect(sinceLine(sinceNudges(data([svc('a')]), [send()])!)).toBe('Since you nudged 1 owner (latest 12 Jul 2026): 1 no change yet');
  });
  it('never claims cause', () => {
    const s = sinceNudges(data([svc('a', { lastViewed: iso(1) })]), [send()])!;
    expect(sinceLine(s)).not.toMatch(/because/i);
    expect(USED_AGAIN_TIP).toBe('Someone used it after the nudge; it may still be needed.');
  });
  it('the owner chip adds "2 of 4 gone" only when something is gone', () => {
    const s = sinceNudges(data([svc('c'), svc('d')]), [send({ itemIds: [id('a'), id('b'), id('c'), id('d')], itemCount: 4 })])!;
    expect(ownerChip(s.owners[0]!)).toBe('2 of 4 gone');
    expect(ownerChip(sinceNudges(data([svc('a')]), [send()])!.owners[0]!)).toBeNull();
  });
  it('the scan finish line: credits saved, or just the count when the credits are tiny; nothing when nothing is gone', () => {
    expect(finishClause(sinceNudges(data([]), [send({ itemIds: [id('a'), id('b')], itemCount: 4, credits: 280 })]))).toBe('Since your last nudges: about 140 credits a month saved.');
    expect(finishClause(sinceNudges(data([]), [send({ credits: 0 })]))).toBe('Since your last nudges: 1 layer no longer in your org.');
    expect(finishClause(sinceNudges(data([svc('a')]), [send()]))).toBeNull();
    expect(finishClause(null)).toBeNull();
  });
});
