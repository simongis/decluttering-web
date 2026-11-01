// DC-084, updated for DC-083 (the "last used" rule): every filter, preset and the Suggested ladder checked against what
// its wording says. Behaviour is tested through the public functions only (evaluate, allRows, families, matchPreset,
// suggest and the wording helpers), with readable fixtures.
// Findings and limitations: docs/research/filter-validation.md.
import { describe, expect, it } from 'vitest';
import {
  LAST_USED_OPTIONS, PRESETS, SIZE_OPTIONS, UPDATE_OPTIONS, USAGE_RULE_DAYS, USED_BY_OPTIONS,
  allRows, describe as describeRule, evaluate, families, matchPreset, ruleLine, sizeChangeImpact, whyLine,
} from './stale';
import { CAP_SIZES, LADDER, suggest, suggestSentence } from './suggest';
import { formatMB } from './format';
import { sortRows } from './priority';
import type { Data, Dependency, Owner, Service, Thresholds } from './types';

// ---------- fixtures ----------
const SCAN = '2026-10-10T09:00:00Z';
const DAY = 86400000;
const isoAgo = (days: number) => new Date(Date.parse(SCAN) - days * DAY).toISOString();

let seq = 0;
/**
 * A service that passes every preset by default: no use recorded (blank lastViewed, no data requests), last updated
 * 800 days ago, no maps or apps, 50 MB.
 */
const svc = (o: Partial<Service> = {}): Service => {
  seq++;
  return {
    id: `s${seq}`, title: `Service ${seq}`, owner: 'amy', created: isoAgo(900), modified: isoAgo(800), sizeMB: 50,
    access: 'private', isView: false, sourceId: null, usage: [], lastViewed: null, dependencies: [], ...o,
  };
};
/** A service from a scan saved before DC-083: no lastViewed field at all. */
const oldSvc = (o: Partial<Service> = {}): Service => { const s = svc(o); delete s.lastViewed; return s; };
const view = (source: Service, o: Partial<Service> = {}): Service => svc({ isView: true, sourceId: source.id, sizeMB: 0, ...o });
const deps = (k: number, prefix = 'm'): Dependency[] => Array.from({ length: k }, (_, i) => ({ id: `${prefix}${i}`, title: `Map ${i}`, type: 'Web Map', owner: 'amy' }));
/** One request on each of the given days ago. */
const usedOn = (...days: number[]): [number, number][] => days.map((d) => [d, 1]);
/** Requests on every day in [a, b] days ago. */
const usedBetween = (a: number, b: number, count = 1): [number, number][] => Array.from({ length: b - a + 1 }, (_, i) => [a + i, count]);

const owner = (username: string, o: Partial<Owner> = {}): Owner => ({ username, fullName: username.toUpperCase(), disabled: false, thumbnail: null, lastNotified: null, ...o });
const OWNERS: Owner[] = [owner('amy'), owner('bob'), owner('dee', { disabled: true })];
const org = (services: Service[], owners: Owner[] = OWNERS, extra: Partial<Data> = {}): Data => ({ org: { id: 'o', name: 'Org', urlKey: 'org', scannedAt: SCAN }, owners, services, ...extra });
const partial = (services: Service[]): Data => org(services, OWNERS, { usageComplete: false });

/** Every filter wide open, so one filter at a time can be tested alone. */
const OPEN: Thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 1e9, minSizeMB: 0 };
const ALL_RULES: Thresholds[] = [...Object.values(PRESETS), ...LADDER.map(([u, a, b]) => ({ minDaysSinceUse: u, minDaysSinceUpdate: a, maxUsedBy: b, minSizeMB: 0 }))];
const flaggedIn = (data: Data, id: string, t: Thresholds, opts: { depsKnown?: boolean } = {}): boolean =>
  evaluate(data, t, opts).families.some((r) => r.source.id === id);
const flagged = (s: Service, t: Thresholds, opts: { depsKnown?: boolean } = {}): boolean => flaggedIn(org([s]), s.id, t, opts);
const rowOf = (data: Data, id: string, t: Thresholds = OPEN) => {
  const r = allRows(data, t).find((x) => x.source.id === id);
  if (!r) throw new Error(`no row for ${id}`);
  return r;
};

// ---------- Last used ("Last used: more than N ago") ----------
describe('Last used: "more than N ago" is N whole days or more, from the newer of lastViewed and data requests', () => {
  for (const { value: v, label } of LAST_USED_OPTIONS) {
    if (v <= USAGE_RULE_DAYS) it(`${label} (${v} days): a data request ${v} days ago is flagged, ${v - 1} days ago is not`, () => {
      const t = { ...OPEN, minDaysSinceUse: v };
      expect(flagged(svc({ usage: usedOn(v) }), t)).toBe(true);
      expect(flagged(svc({ usage: usedOn(v - 1) }), t)).toBe(false);
    });
    // DC-147: the scan reads two years, but the rule reads data requests for one (days 0 to 364), as before; beyond that
    // only lastViewed tells. So no layer is picked differently for having a second year of history behind it.
    else it(`${label} (${v} days): data requests in the second year are not the rule's; lastViewed decides`, () => {
      const t = { ...OPEN, minDaysSinceUse: v };
      expect(flagged(svc({ usage: usedOn(v - 1), lastViewed: isoAgo(v) }), t)).toBe(true);
      expect(flagged(svc({ usage: usedOn(USAGE_RULE_DAYS - 1), lastViewed: isoAgo(v) }), t)).toBe(false);
    });

    it(`${label} (${v} days): lastViewed ${v} days ago is flagged, ${v - 1} days ago or an hour short is not`, () => {
      const t = { ...OPEN, minDaysSinceUse: v };
      expect(flagged(svc({ lastViewed: isoAgo(v) }), t)).toBe(true);
      expect(flagged(svc({ lastViewed: isoAgo(v - 1) }), t)).toBe(false);
      expect(flagged(svc({ lastViewed: new Date(Date.parse(isoAgo(v)) + 3600_000).toISOString() }), t)).toBe(false);
    });
  }

  it('the newer signal wins: a recent lastViewed keeps off a layer with old requests, and the reverse', () => {
    const t = { ...OPEN, minDaysSinceUse: 180 };
    const opened = svc({ lastViewed: isoAgo(10), usage: usedOn(400) });
    const requested = svc({ lastViewed: isoAgo(500), usage: usedOn(3) });
    expect(rowOf(org([opened]), opened.id).lastUsedDaysAgo).toBe(10);
    expect(rowOf(org([requested]), requested.id).lastUsedDaysAgo).toBe(3);
    expect(flagged(opened, t)).toBe(false);
    expect(flagged(requested, t)).toBe(false);
  });

  it('FB-29: lastViewed today and (wrongly) no requests in 150 days is not stale under any preset or rung', () => {
    // The real case: about 10,000 requests a day on days 150 to 365, and the newest window lost to a merge bug.
    const busy = svc({ lastViewed: isoAgo(0), usage: usedBetween(150, 364, 10_000), modified: isoAgo(800) });
    for (const t of ALL_RULES) expect(flagged(busy, t), JSON.stringify(t)).toBe(false);
    for (const t of ALL_RULES) expect(flaggedIn(partial([busy]), busy.id, t)).toBe(false); // and with the window failure noted
    expect(rowOf(org([busy]), busy.id).why).toMatch(/^Last used today · /);
  });

  it('a request today, or a future-dated bucket, is use today: never flagged', () => {
    for (const t of ALL_RULES) {
      expect(flagged(svc({ usage: usedOn(0) }), t)).toBe(false);
      expect(flagged(svc({ usage: [[-1, 99]] }), t)).toBe(false);
    }
  });

  it('requests are not counted, only the last day: 10,000 a day stops at the last one', () => {
    const s = svc({ usage: usedBetween(200, 300, 10_000) });
    expect(rowOf(org([s]), s.id).lastUsedDaysAgo).toBe(200);
    expect(flagged(s, PRESETS.balanced)).toBe(true);  // 200 >= 180
    expect(flagged(s, PRESETS.gentle)).toBe(false);   // 200 < 365
  });

  it('a [daysAgo, 0] entry is not use', () => {
    const s = svc({ usage: [[5, 0]], lastViewed: isoAgo(400) });
    expect(rowOf(org([s]), s.id).lastUsedDaysAgo).toBe(400);
  });

  it('an unreadable lastViewed is ignored (requests still count)', () => {
    const s = svc({ lastViewed: 'not a date', usage: usedOn(30) });
    expect(rowOf(org([s]), s.id).lastUsedDaysAgo).toBe(30);
  });
});

describe('Unknown is never flagged (part of the usage history could not be read)', () => {
  it('blank lastViewed and no requests: "Last used: unknown", under every rule', () => {
    const s = svc();
    const r = rowOf(partial([s]), s.id, PRESETS.balanced);
    expect(r).toMatchObject({ useKnown: false, noUseRecorded: false, stale: false });
    expect(r.why).toMatch(/^Last used: unknown \(we couldn't read all of its use\) · /);
    for (const t of ALL_RULES) expect(flaggedIn(partial([s]), s.id, t)).toBe(false);
  });

  it('lastViewed older than N is unknown for that N; newer than N is known use', () => {
    const s = svc({ lastViewed: isoAgo(200) });
    expect(flaggedIn(partial([s]), s.id, PRESETS.balanced)).toBe(false);          // 200 >= 180, but the requests may be newer
    expect(rowOf(partial([s]), s.id, PRESETS.balanced).useKnown).toBe(false);
    expect(rowOf(partial([s]), s.id, PRESETS.gentle).useKnown).toBe(true);       // 200 < 365: used, whatever the requests say
    expect(rowOf(partial([s]), s.id, PRESETS.gentle).why).toMatch(/^Last used 7 months ago/);
    expect(flaggedIn(org([s]), s.id, PRESETS.balanced)).toBe(true);              // read in full: stale
  });

  it('a recent request is known use even when another window failed', () => {
    const s = svc({ usage: usedOn(20) });
    expect(rowOf(partial([s]), s.id, PRESETS.strict)).toMatchObject({ useKnown: true, lastUsedDaysAgo: 20, stale: false });
  });

  it('unknown rows are not in Suggested\'s counts either', () => {
    const stale = Array.from({ length: 30 }, (_, i) => svc({ owner: `u${i}` }));
    const fresh = Array.from({ length: 30 }, (_, i) => svc({ owner: `f${i}`, lastViewed: isoAgo(1), modified: isoAgo(5) }));
    expect(suggest(org([...stale, ...fresh], [...stale, ...fresh].map((s) => owner(s.owner))))).not.toBeNull();
    expect(suggest(org([...stale, ...fresh], [...stale, ...fresh].map((s) => owner(s.owner)), { usageComplete: false }))).toBeNull();
  });

  it('a missing usageComplete (older caches) means read in full', () => {
    const s = svc();
    expect(rowOf(org([s]), s.id, PRESETS.balanced).useKnown).toBe(true);
  });
});

describe('No use recorded: blank lastViewed and no requests in the year read', () => {
  it('counts as unused for every rule, and says "since at least November 2022"', () => {
    const s = svc();
    const r = rowOf(org([s]), s.id, PRESETS.balanced);
    expect(r).toMatchObject({ noUseRecorded: true, useKnown: true, lastUsedDaysAgo: null });
    expect(r.why).toMatch(/^No use recorded since at least November 2022 · /);
    for (const t of [...ALL_RULES, { ...OPEN, minDaysSinceUse: 730 }]) expect(flagged(s, t)).toBe(true);
  });

  it('blank lastViewed with any request is not "no use recorded"', () => {
    const s = svc({ usage: usedOn(300) });
    expect(rowOf(org([s]), s.id)).toMatchObject({ noUseRecorded: false, lastUsedDaysAgo: 300 });
  });

  it('one member with a lastViewed takes the family out of "no use recorded"', () => {
    const src = svc();
    const v = view(src, { lastViewed: isoAgo(500) });
    expect(rowOf(org([src, v]), src.id)).toMatchObject({ noUseRecorded: false, lastUsedDaysAgo: 500 });
  });
});

describe('Old caches (no lastViewed): last used from data requests only', () => {
  it('uses the request days, and marks the row requestsOnly', () => {
    const s = oldSvc({ usage: usedOn(200) });
    const r = rowOf(org([s]), s.id, PRESETS.balanced);
    expect(r).toMatchObject({ requestsOnly: true, lastUsedDaysAgo: 200, stale: true, noUseRecorded: false });
    expect(r.why).toMatch(/^Last used 7 months ago · /);
  });

  it('no requests: unused for up to a year (what was read), unknown beyond it', () => {
    const s = oldSvc();
    const r = rowOf(org([s]), s.id, PRESETS.gentle);
    expect(r).toMatchObject({ useKnown: true, noUseRecorded: false, lastUsedDaysAgo: null, stale: true });
    expect(r.why).toMatch(/^No data requests in the last year · /);
    expect(flagged(s, { ...OPEN, minDaysSinceUse: 365 })).toBe(true);
    expect(flagged(s, { ...OPEN, minDaysSinceUse: 730 })).toBe(false);
    expect(rowOf(org([s]), s.id, { ...OPEN, minDaysSinceUse: 730 }).useKnown).toBe(false);
  });
});

describe('Total views (numViews) is context, never a filter', () => {
  it('a layer with 585,557 views all time is flagged exactly like one with none', () => {
    for (const t of ALL_RULES) {
      expect(flagged(svc({ numViews: 585_557 }), t)).toBe(flagged(svc({ numViews: 0 }), t));
    }
  });

  it('the row shows the family total at the end of the why line; without a count the part is left out', () => {
    const src = svc({ numViews: 585_000, lastViewed: isoAgo(240) });
    const v = view(src, { numViews: 557 });
    const r = rowOf(org([src, v]), src.id, PRESETS.balanced);
    expect(r.numViews).toBe(585_557);
    expect(r.why).toBe('Last used 8 months ago · last updated Aug 2024 · not used by any maps or apps · 585,557 views all time');
    expect(rowOf(org([svc({ numViews: 1 })]), `s${seq}`).why).toMatch(/· 1 view all time$/);
    expect(rowOf(org([svc()]), `s${seq}`).why).not.toMatch(/views?/);
  });

  it('"Least viewed" sorts by views, fewest first, with unknown counts last (FB-61)', () => {
    const data = org([svc({ title: 'A', numViews: 10 }), svc({ title: 'B' }), svc({ title: 'C', numViews: 900 })]);
    expect(sortRows(evaluate(data, PRESETS.balanced).families, 'views').map((r) => r.source.title)).toEqual(['A', 'C', 'B']);
  });
});

// ---------- Last updated ----------
describe('"Last updated: more than N ago" is N whole days or more since the scan', () => {
  for (const { value: v, label } of UPDATE_OPTIONS) {
    it(`${label} (${v} days): updated exactly ${v} days ago is flagged, ${v - 1} days ago is not`, () => {
      const t = { ...OPEN, minDaysSinceUpdate: v };
      expect(flagged(svc({ modified: isoAgo(v) }), t)).toBe(true);
      expect(flagged(svc({ modified: isoAgo(v - 1) }), t)).toBe(false);
      // an hour short of the full day still counts as v - 1 days
      expect(flagged(svc({ modified: new Date(Date.parse(isoAgo(v)) + 3600_000).toISOString() }), t)).toBe(false);
    });
  }

  it('a family is as new as its most recently updated member (a view edit keeps the source off)', () => {
    const src = svc({ modified: isoAgo(800) });
    const v = view(src, { modified: isoAgo(10) });
    const ev = evaluate(org([src, v]), { ...OPEN, minDaysSinceUpdate: 365 });
    expect(ev.families).toHaveLength(0);
    expect(rowOf(org([src, v]), src.id).daysSinceUpdate).toBe(10);
  });

  it('a modified date after the scan is never stale', () => {
    expect(flagged(svc({ modified: isoAgo(-3) }), { ...OPEN, minDaysSinceUpdate: 90 })).toBe(false);
  });
});

// ---------- Used by ----------
describe('"Used by: at most N" is inclusive and counts distinct maps and apps across the family', () => {
  for (const { value: v, label } of USED_BY_OPTIONS) {
    it(`${label} (${v}): ${v} maps or apps is flagged, ${v + 1} is not`, () => {
      const t = { ...OPEN, maxUsedBy: v };
      expect(flagged(svc({ dependencies: deps(v) }), t)).toBe(true);
      expect(flagged(svc({ dependencies: deps(v + 1) }), t)).toBe(false);
    });
  }

  it('the same map using the source and a view counts once; a map using only a view counts for the family', () => {
    const src = svc({ dependencies: deps(1, 'shared') });
    const v = view(src, { dependencies: [...deps(1, 'shared'), ...deps(1, 'viewonly')] });
    const r = rowOf(org([src, v]), src.id);
    expect(r.usedBy).toBe(2);
    expect(evaluate(org([src, v]), { ...OPEN, maxUsedBy: 1 }).families).toHaveLength(0);
  });

  it('while maps and apps are still being read (depsKnown false) the used-by rule is skipped', () => {
    const s = svc({ dependencies: deps(10) });
    expect(flagged(s, { ...OPEN, maxUsedBy: 0 }, { depsKnown: false })).toBe(true);
    expect(flagged(s, { ...OPEN, maxUsedBy: 0 }, { depsKnown: true })).toBe(false);
  });

  it('depsKnown false only ever adds rows (an upper bound), and never makes a Quick win', () => {
    const data = org([svc({ dependencies: deps(3) }), svc(), svc({ access: 'public' }), svc({ sizeMB: 500 })]);
    const known = new Set(evaluate(data, PRESETS.balanced).families.map((r) => r.source.id));
    const unknown = evaluate(data, PRESETS.balanced, { depsKnown: false }).families;
    for (const id of known) expect(unknown.some((r) => r.source.id === id)).toBe(true);
    expect(unknown.length).toBeGreaterThan(known.size);
    expect(unknown.some((r) => r.priority === 'start')).toBe(false);
  });
});

// ---------- Size: at least ----------
describe('"Size: at least" is inclusive, uses the source storage only, and never hides unmeasured sizes', () => {
  for (const { value: v, label } of SIZE_OPTIONS) {
    it(`${label} (${v}): ${v} MB is flagged${v > 0 ? `, just under ${v} MB is not` : ', even 0 MB'}`, () => {
      const t = { ...OPEN, minSizeMB: v };
      expect(flagged(svc({ sizeMB: v }), t)).toBe(true);
      if (v > 0) expect(flagged(svc({ sizeMB: v - 0.01 }), t)).toBe(false);
    });
  }

  it('a missing minSizeMB means any size', () => {
    const t: Thresholds = { minDaysSinceUse: 180, minDaysSinceUpdate: 0, maxUsedBy: 0 };
    expect(flagged(svc({ sizeMB: 0 }), t)).toBe(true);
  });

  it('a size not measured yet is never hidden, even at 1 GB, and counts 0 MB and 0 credits', () => {
    const s = svc({ sizeMB: null });
    expect(flagged(s, { ...OPEN, minSizeMB: 1024 })).toBe(true);
    const ev = evaluate(org([s]), { ...OPEN, minSizeMB: 1024 });
    expect(ev.totals).toMatchObject({ sizeMB: 0, credits: 0, unmeasured: 1 });
  });

  it('view sizes never count: a 5 MB source with a "100 MB" view is a 5 MB family', () => {
    const src = svc({ sizeMB: 5 });
    const v = view(src, { sizeMB: 100 });
    expect(rowOf(org([src, v]), src.id).sizeMB).toBe(5);
    expect(evaluate(org([src, v]), { ...OPEN, minSizeMB: 10 }).families).toHaveLength(0);
  });

  it('the size chip never shows a value at or above a threshold the item is below (DC-085)', () => {
    expect(formatMB(14.6)).toBe('14.6 MB');
    expect(flagged(svc({ sizeMB: 14.6 }), { ...OPEN, minSizeMB: 15 })).toBe(false);
    expect(formatMB(9.96)).toBe('9.9 MB');
    expect(flagged(svc({ sizeMB: 9.96 }), { ...OPEN, minSizeMB: 10 })).toBe(false);
    for (const minSizeMB of [1, 10, 15, 20, 50, 100, 1024]) {
      for (const mb of [minSizeMB - 0.04, minSizeMB - 0.5, minSizeMB - 0.001]) {
        const shown = formatMB(mb);
        const n = parseFloat(shown.replace(/,/g, ''));
        const inMB = shown.endsWith('GB') ? n * 1024 : n;
        expect(inMB, `${mb} shown as ${shown}`).toBeLessThan(minSizeMB);
      }
    }
    expect(formatMB(15)).toBe('15 MB');
    expect(formatMB(100)).toBe('100 MB');
    expect(formatMB(99.99)).toBe('99.9 MB');
    expect(formatMB(1023.9)).toBe('1023 MB');
  });

  it('lowering the minimum adds exactly the known sizes in [new, old); unmeasured rows were already there', () => {
    const data = org([svc({ sizeMB: 0.5 }), svc({ sizeMB: 1 }), svc({ sizeMB: 14.99 }), svc({ sizeMB: 15 }), svc({ sizeMB: null })]);
    const imp = sizeChangeImpact(data, PRESETS.balanced, 1);
    expect(imp.families).toBe(2); // 1 and 14.99
    expect(imp.sizeMB).toBeCloseTo(15.99);
    expect(imp.unmeasured).toBe(1);
  });
});

// ---------- every filter together ----------
describe('filters combine with AND', () => {
  const B = PRESETS.balanced; // last used and updated 180 days or more, at most 1 map or app, at least 15 MB
  const atEveryBoundary: Partial<Service> = { lastViewed: isoAgo(180), usage: usedOn(181), modified: isoAgo(180), dependencies: deps(1), sizeMB: 15 };

  it('a service sitting exactly on every Balanced boundary is flagged', () => {
    expect(flagged(svc(atEveryBoundary), B)).toBe(true);
  });

  const oneOver: [string, Partial<Service>][] = [
    ['opened a day more recently', { lastViewed: isoAgo(179) }],
    ['data requested a day more recently', { usage: usedOn(179) }],
    ['updated a day more recently', { modified: isoAgo(179) }],
    ['one more map or app', { dependencies: deps(2) }],
    ['a little smaller', { sizeMB: 14.99 }],
  ];
  for (const [what, patch] of oneOver) {
    it(`failing one filter alone (${what}) keeps it off the list`, () => {
      expect(flagged(svc({ ...atEveryBoundary, ...patch }), B)).toBe(false);
    });
  }
});

// ---------- families ----------
describe('families: a source and its hosted views are judged as one', () => {
  it("the family's last use is the newest across its members", () => {
    const src = svc({ usage: usedOn(300), lastViewed: isoAgo(400) });
    const v1 = view(src, { lastViewed: isoAgo(200) });
    const v2 = view(src, { usage: usedOn(250) });
    const data = org([src, v1, v2]);
    expect(rowOf(data, src.id).lastUsedDaysAgo).toBe(200);
    expect(evaluate(data, PRESETS.balanced).families).toHaveLength(1); // 200 >= 180
    expect(evaluate(data, PRESETS.gentle).families).toHaveLength(0);   // 200 < 365
  });

  it('a recently opened view keeps the whole family off, even when the source looks idle', () => {
    const src = svc();
    const v = view(src, { lastViewed: isoAgo(2) });
    for (const t of ALL_RULES) expect(flaggedIn(org([src, v]), src.id, t)).toBe(false);
  });

  it("a view of a view resolves to the root source; the grandchild's use keeps the family off", () => {
    const src = svc();
    const v = view(src);
    const vv = svc({ isView: true, sourceId: v.id, sizeMB: 0, usage: usedOn(0) });
    const data = org([src, v, vv]);
    const fams = families(data);
    expect(fams).toHaveLength(1);
    expect(fams[0]?.views.map((x) => x.id).sort()).toEqual([v.id, vv.id].sort());
    expect(evaluate(data, PRESETS.strict).families).toHaveLength(0);
  });

  it('totals count a family as 1 + its views; credits come from the source only', () => {
    const src = svc({ sizeMB: 100 });
    const ev = evaluate(org([src, view(src), view(src)]), PRESETS.balanced);
    expect(ev.totals).toMatchObject({ families: 1, services: 3, sizeMB: 100, credits: 24 });
  });

  it('a view whose source is missing is left out: no family, no row, so it can never be flagged or emailed (user, 2026-10-23)', () => {
    const orphan = svc({ isView: true, sourceId: 'not-in-scan', sizeMB: 0, usage: usedOn(3) });
    expect(families(org([orphan]))).toHaveLength(0);
    const ev = evaluate(org([orphan]), PRESETS.balanced);
    expect(ev.totals).toMatchObject({ families: 0, services: 0, credits: 0 });
  });

  it('a view with no source id at all is left out too, while an ordinary layer stays', () => {
    const lone = svc({ isView: true, sourceId: null, sizeMB: 0 });
    const layer = svc({ sizeMB: 40 });
    expect(families(org([lone, layer])).map((f) => f.source.id)).toEqual([layer.id]);
  });

  it('two views of the same missing source are both left out (no longer two stray families)', () => {
    const a = svc({ isView: true, sourceId: 'gone', sizeMB: 0 });
    const b = svc({ isView: true, sourceId: 'gone', sizeMB: 0 });
    expect(families(org([a, b]))).toHaveLength(0);
  });

  it("the family belongs to the source owner: a colleague's view is nudged to the source owner", () => {
    const src = svc({ owner: 'amy' });
    const v = view(src, { owner: 'bob' });
    const ev = evaluate(org([src, v]), PRESETS.balanced);
    expect(ev.owners.map((o) => o.owner.username)).toEqual(['amy']);
    expect(ev.totals.services).toBe(2);
  });
});

// ---------- owners ----------
describe('owners: disabled, recently nudged, unknown; totals', () => {
  it('disabled owners go to "No one to nudge" and leave the totals', () => {
    const ev = evaluate(org([svc({ owner: 'amy', sizeMB: 50 }), svc({ owner: 'dee', sizeMB: 70 }), svc({ owner: 'dee', sizeMB: 30 })]), PRESETS.balanced);
    expect(ev.owners.map((o) => o.owner.username)).toEqual(['amy']);
    expect(ev.unreachable.map((g) => [g.owner.username, g.rows.length, g.sizeMB])).toEqual([['dee', 2, 100]]);
    expect(ev.totals).toMatchObject({ owners: 1, families: 1, services: 1, sizeMB: 50, unreachableFamilies: 2 });
  });

  it('the six-month cooldown is 182 days inclusive; a recently nudged owner stays on the list, unticked', () => {
    const own = [owner('amy', { lastNotified: isoAgo(182) }), owner('bob', { lastNotified: isoAgo(183) })];
    const ev = evaluate(org([svc({ owner: 'amy' }), svc({ owner: 'bob' })], own), PRESETS.balanced);
    const by = (u: string) => ev.owners.find((o) => o.owner.username === u);
    expect(by('amy')).toMatchObject({ nudgedRecently: true, defaultTicked: false, nudgedDaysAgo: 182 });
    expect(by('bob')).toMatchObject({ nudgedRecently: false, defaultTicked: true, nudgedDaysAgo: 183 });
    expect(ev.totals.owners).toBe(2); // a flag, never a skip
  });

  it('LIMITATION: an owner missing from the owner list is assumed reachable (not disabled)', () => {
    const ev = evaluate(org([svc({ owner: 'ghost' })], []), PRESETS.balanced);
    expect(ev.owners[0]?.owner).toMatchObject({ username: 'ghost', fullName: 'ghost', disabled: false });
    expect(ev.unreachable).toHaveLength(0);
  });

  it('totals equal the sums over owners (what the header shows)', () => {
    const data = org([svc({ owner: 'amy', sizeMB: 40 }), svc({ owner: 'bob', sizeMB: 20 }), svc({ owner: 'bob', sizeMB: null })]);
    const ev = evaluate(data, PRESETS.balanced);
    const sum = (k: 'credits' | 'sizeMB' | 'unmeasured') => ev.owners.reduce((n, o) => n + o[k], 0);
    expect(ev.totals.credits).toBeCloseTo(sum('credits'));
    expect(ev.totals.sizeMB).toBe(sum('sizeMB'));
    expect(ev.totals.unmeasured).toBe(sum('unmeasured'));
    expect(ev.totals.services).toBe(ev.owners.reduce((n, o) => n + o.rows.reduce((m, r) => m + 1 + r.views.length, 0), 0));
  });
});

// ---------- presets ----------
describe('presets: values, wording and recognition', () => {
  it('the ADR 0007 (2026-10-17) table: 1 year / 6 months / 3 months, used by 0 / 1 / 2, 20 / 15 / 10 MB', () => {
    expect(PRESETS.gentle).toEqual({ minDaysSinceUse: 365, minDaysSinceUpdate: 365, maxUsedBy: 0, minSizeMB: 20 });
    expect(PRESETS.balanced).toEqual({ minDaysSinceUse: 180, minDaysSinceUpdate: 180, maxUsedBy: 1, minSizeMB: 15 });
    expect(PRESETS.strict).toEqual({ minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 2, minSizeMB: 10 });
  });

  const RULE_LINES = {
    gentle: 'Last used more than a year ago · last updated more than a year ago · used by no maps or apps · at least 20 MB',
    balanced: 'Last used more than 6 months ago · last updated more than 6 months ago · used by at most 1 map or app · at least 15 MB',
    strict: 'Last used more than 3 months ago · last updated more than 3 months ago · used by at most 2 maps or apps · at least 10 MB',
  } as const;
  for (const name of ['gentle', 'balanced', 'strict'] as const) {
    it(`${name}: ruleLine reads its numbers, and matchPreset recognises it`, () => {
      expect(ruleLine(PRESETS[name])).toBe(RULE_LINES[name]);
      expect(matchPreset({ ...PRESETS[name] })).toBe(name);
    });

    it(`${name}: every value is one the dropdowns offer`, () => {
      const p = PRESETS[name];
      expect(LAST_USED_OPTIONS.map((o) => o.value)).toContain(p.minDaysSinceUse);
      expect(UPDATE_OPTIONS.map((o) => o.value)).toContain(p.minDaysSinceUpdate);
      expect(USED_BY_OPTIONS.map((o) => o.value)).toContain(p.maxUsedBy);
      expect(SIZE_OPTIONS.map((o) => o.value)).toContain(p.minSizeMB);
    });

    it(`${name}: changing any one filter to another option makes it Custom, and changing it back restores it`, () => {
      const lists: [keyof Thresholds, { value: number }[]][] = [
        ['minDaysSinceUse', LAST_USED_OPTIONS], ['minDaysSinceUpdate', UPDATE_OPTIONS],
        ['maxUsedBy', USED_BY_OPTIONS], ['minSizeMB', SIZE_OPTIONS],
      ];
      for (const [k, list] of lists) for (const { value } of list) {
        if (value === PRESETS[name][k]) continue;
        const t = { ...PRESETS[name], [k]: value };
        // another preset can be reached only by changing more than one key, so one change is always Custom
        expect(matchPreset(t), `${name} with ${k}=${value}`).toBe('custom');
        expect(matchPreset({ ...t, [k]: PRESETS[name][k] })).toBe(name);
      }
    });
  }

  it('the options: last used 3, 6, 9 months, 1 and 2 years; last updated adds 3 years', () => {
    expect(LAST_USED_OPTIONS.map((o) => o.label)).toEqual(['3 months', '6 months', '9 months', '1 year', '2 years']);
    expect(UPDATE_OPTIONS.map((o) => o.value)).toEqual([90, 180, 270, 365, 730, 1095]);
  });

  it('a preset without its minimum size is Custom', () => {
    const { minSizeMB: _drop, ...noSize } = PRESETS.gentle;
    expect(matchPreset(noSize)).toBe('custom');
  });

  it('the presets get stricter in order: Strict flags a superset of Balanced, Balanced of Gentle', () => {
    const data = org([
      svc({ lastViewed: isoAgo(200), modified: isoAgo(200), dependencies: deps(1), sizeMB: 15 }), // Balanced and Strict
      svc({ usage: usedOn(100), modified: isoAgo(100), dependencies: deps(2), sizeMB: 10 }),      // Strict only
      svc({ modified: isoAgo(800), sizeMB: 25 }),                                                  // all three
      svc({ lastViewed: isoAgo(30), modified: isoAgo(800) }),                                      // none
    ]);
    const ids = (t: Thresholds) => new Set(evaluate(data, t).families.map((r) => r.source.id));
    const g = ids(PRESETS.gentle), b = ids(PRESETS.balanced), s = ids(PRESETS.strict);
    for (const id of g) expect(b.has(id)).toBe(true);
    for (const id of b) expect(s.has(id)).toBe(true);
    expect([g.size, b.size, s.size]).toEqual([1, 2, 3]);
  });
});

// ---------- wording ----------
describe('wording agrees with the numbers', () => {
  it('describe: each preset in one sentence, numbers as set (research 7.2)', () => {
    expect(describeRule(PRESETS.balanced)).toBe(
      'We flag a layer nobody has used for more than 6 months, last updated more than 6 months ago, used by at most 1 map or app, and at least 15 MB.');
    expect(describeRule(PRESETS.gentle)).toBe(
      'We flag a layer nobody has used for more than a year, last updated more than a year ago, used by no maps or apps, and at least 20 MB.');
    expect(describeRule(PRESETS.strict)).toBe(
      'We flag a layer nobody has used for more than 3 months, last updated more than 3 months ago, used by at most 2 maps or apps, and at least 10 MB.');
  });

  it('no "days with data requests" count is left in any rule wording', () => {
    for (const t of ALL_RULES) {
      for (const l of [describeRule(t), ruleLine(t)]) {
        expect(l).toMatch(/last used|nobody has used/i);
        expect(l).not.toMatch(/data request|days used|\bon \d+ days?\b/i);
      }
    }
  });

  it('no "at least 0 MB": Any size (0) and a missing minimum leave the size clause out', () => {
    for (const t of [{ ...PRESETS.balanced, minSizeMB: 0 }, { minDaysSinceUse: 180, minDaysSinceUpdate: 365, maxUsedBy: 0 }]) {
      expect(ruleLine(t)).not.toMatch(/MB|size/);
      expect(describeRule(t)).not.toMatch(/MB|size/);
    }
    expect(describeRule({ ...PRESETS.balanced, minSizeMB: 0 })).toBe('We flag a layer nobody has used for more than 6 months, last updated more than 6 months ago and used by at most 1 map or app.');
    expect(ruleLine({ ...PRESETS.balanced, minSizeMB: 1024 })).toMatch(/at least 1 GB$/);
    expect(ruleLine({ ...PRESETS.balanced, minSizeMB: 1 })).toMatch(/at least 1 MB$/);
  });

  it('plurals and months in why lines', () => {
    const row = (lastUsedDaysAgo: number | null, usedBy: number, numViews: number | null = null) =>
      ({ lastUsedDaysAgo, useKnown: true, noUseRecorded: false, usedBy, numViews, lastModified: isoAgo(400) });
    expect(whyLine(row(240, 0))).toBe('Last used 8 months ago · last updated Sep 2025 · not used by any maps or apps');
    expect(whyLine(row(180, 1, 585_557))).toBe('Last used 6 months ago · last updated Sep 2025 · used by 1 map or app · 585,557 views all time');
    expect(whyLine(row(400, 2))).toBe('Last used 13 months ago · last updated Sep 2025 · used by 2 maps or apps');
    expect(whyLine(row(800, 0))).toMatch(/^Last used 2.2 years ago/);
  });

  it('a flagged row\'s last used never reads as less than the rule it passed (month rounding)', () => {
    for (const { value: v, label } of LAST_USED_OPTIONS) {
      const s = svc({ lastViewed: isoAgo(v) });
      const r = rowOf(org([s]), s.id, { ...OPEN, minDaysSinceUse: v });
      expect(r.stale).toBe(true);
      const m = /Last used (\d+(?:\.\d)?) (months|years) ago/.exec(r.why);
      expect(m, r.why).not.toBeNull();
      const months = m![2] === 'years' ? Number(m![1]) * 12 : Number(m![1]);
      const want = label.endsWith('year') ? 12 : label.endsWith('years') ? Number(label.split(' ')[0]) * 12 : Number(label.split(' ')[0]);
      expect(months, `${label}: ${r.why}`).toBeGreaterThanOrEqual(want - 0.6);
    }
  });

  it('ruleLine spans read naturally for every option', () => {
    const span = (d: number) => ruleLine({ ...PRESETS.balanced, minDaysSinceUpdate: d }).split(' · ')[1];
    expect(UPDATE_OPTIONS.map((o) => span(o.value))).toEqual(UPDATE_OPTIONS.map((o) => `last updated more than ${o.label === '1 year' ? 'a year' : o.label} ago`));
    const used = (d: number) => ruleLine({ ...PRESETS.balanced, minDaysSinceUse: d }).split(' · ')[0];
    expect(LAST_USED_OPTIONS.map((o) => used(o.value))).toEqual(LAST_USED_OPTIONS.map((o) => `Last used more than ${o.label === '1 year' ? 'a year' : o.label} ago`));
  });
});

// ---------- the Suggested ladder ----------
describe('Suggested: the gentlest rung near 15% of services, at most 40 owners', () => {
  // Builders for whole orgs. `used` is days since last use (by lastViewed); undefined is no use recorded.
  let on = 0;
  const fam = (o: { upd?: number; used?: number; by?: number; owner?: string; size?: number | null } = {}): Service =>
    svc({ owner: o.owner ?? `o${++on}`, modified: isoAgo(o.upd ?? 10), lastViewed: o.used === undefined ? null : isoAgo(o.used), dependencies: deps(o.by ?? 0), sizeMB: o.size === undefined ? 50 : o.size });
  /** Recently updated and opened yesterday, so never stale on any rung. */
  const fresh = (k: number) => Array.from({ length: k }, () => fam({ upd: 10, used: 1 }));
  const orgOf = (services: Service[], extra: Owner[] = [], more: Partial<Data> = {}): Data => {
    const names = [...new Set(services.map((s) => s.owner))];
    return org(services, [...names.filter((u) => !extra.some((e) => e.username === u)).map((u) => owner(u)), ...extra], more);
  };

  it('the ladder runs from Gentle to Strict on last used, last updated and used by; each rung flags a superset of the one before', () => {
    const p = (t: Thresholds) => [t.minDaysSinceUse, t.minDaysSinceUpdate, t.maxUsedBy];
    expect(LADDER[0]).toEqual(p(PRESETS.gentle));
    expect(LADDER[LADDER.length - 1]).toEqual(p(PRESETS.strict));
    expect(LADDER.some((r) => r.join() === p(PRESETS.balanced).join())).toBe(true);
    for (let i = 1; i < LADDER.length; i++) {
      const [u, a, b] = LADDER[i] as readonly number[], [u0, a0, b0] = LADDER[i - 1] as readonly number[];
      expect((u as number) <= (u0 as number) && (a as number) <= (a0 as number) && (b as number) >= (b0 as number), `rung ${i}`).toBe(true);
      expect(LADDER[i]).not.toEqual(LADDER[i - 1]);
    }
    for (const [u, a] of LADDER) {
      expect(LAST_USED_OPTIONS.map((o) => o.value)).toContain(u);
      expect(UPDATE_OPTIONS.map((o) => o.value)).toContain(a);
    }
  });

  it('returns null for fewer than 20 families, for an org with no use at all, and for a tidy org', () => {
    expect(suggest(orgOf([...Array.from({ length: 5 }, () => fam({ upd: 800 })), ...fresh(14)]))).toBeNull();
    expect(suggest(orgOf(Array.from({ length: 30 }, () => oldSvc({ owner: 'amy' }))))).toBeNull();
    expect(suggest(orgOf(fresh(60)))).toBeNull();
  });

  it('picks the gentlest rung that reaches half the target (target = 15% of services of 10 MB or more)', () => {
    // 100 families -> target 15, floor 7.5. Rung 0 flags 5 (not enough); rung 2 (9 months) adds 10.
    const r0 = Array.from({ length: 5 }, () => fam({ upd: 800 }));
    const r2 = Array.from({ length: 10 }, () => fam({ upd: 300, used: 300 }));
    const s = suggest(orgOf([...r0, ...r2, ...fresh(85)]));
    expect(s).toMatchObject({ rung: 2, flagged: 15, target: 15, capped: false });
    expect(s?.thresholds).toMatchObject({ minDaysSinceUse: 270, minDaysSinceUpdate: 270, maxUsedBy: 1 });
  });

  it('FB-29 families are never counted, at any rung', () => {
    const busy = Array.from({ length: 30 }, () => svc({ owner: `b${++on}`, modified: isoAgo(800), lastViewed: isoAgo(0), usage: usedBetween(150, 364, 10_000) }));
    expect(suggest(orgOf([...busy, ...fresh(30)]))).toBeNull();
  });

  it('what Suggested reports (flagged, owners) is what the review then shows for its thresholds', () => {
    const fixtures: Data[] = [
      orgOf([...Array.from({ length: 12 }, () => fam({ upd: 400, used: 400, by: 1 })), ...Array.from({ length: 6 }, (_, i) => fam({ upd: 300, used: 280, owner: `p${i % 2}` })), ...fresh(80)]),
      orgOf([...Array.from({ length: 30 }, (_, i) => fam({ upd: 800, size: i % 3 === 0 ? 12 : i % 3 === 1 ? null : 40 })), ...fresh(70)]),
      orgOf([...Array.from({ length: 8 }, () => fam({ upd: 100, used: 95, by: 2 })), ...Array.from({ length: 8 }, () => fam({ upd: 800, owner: 'dee' })), ...fresh(40)], [owner('dee', { disabled: true })]),
      orgOf([...Array.from({ length: 20 }, () => oldSvc({ owner: `x${++on}`, modified: isoAgo(800), usage: usedOn(200) })), ...fresh(60)]),
    ];
    for (const data of fixtures) {
      const s = suggest(data);
      expect(s).not.toBeNull();
      if (!s) continue;
      const ev = evaluate(data, s.thresholds);
      expect(ev.totals.families).toBe(s.flagged);
      expect(ev.totals.owners).toBe(s.owners);
      expect(s.preset).toBe(matchPreset(s.thresholds));
    }
  });

  it('always stays inside the ladder: never past Strict, minimum size 10 to 20 MB unless capped by owners', () => {
    const s = suggest(orgOf([...Array.from({ length: 4 }, () => fam({ upd: 100, used: 95, by: 2 })), ...fresh(40)]));
    expect(s).not.toBeNull();
    expect(s?.rung).toBe(LADDER.length - 1);
    expect(s?.thresholds).toMatchObject({ minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 2 });
    expect([10, 15, 20]).toContain(s?.thresholds.minSizeMB);
  });

  it('LIMITATION: a very stale org gets the gentlest rung even when it flags far more than 15%', () => {
    const s = suggest(orgOf([...Array.from({ length: 80 }, (_, i) => fam({ upd: 800, owner: `a${i % 10}` })), ...fresh(20)]));
    expect(s?.rung).toBe(0);
    expect(s?.flagged).toBe(80); // 80% of the org, against a target of 15
    expect(s?.target).toBe(15);
    expect(suggestSentence(s!)).toContain('about 1 in 1 services');
  });

  it('DC-084 bug 2 settled: more than 40 owners at the gentlest rung steps the size up (20, 50, 100 MB) first', () => {
    // 100 stale families from 100 owners: 30 of 120 MB, 70 of 30 MB. At 20 MB that is 100 owners; at 50 MB, 30.
    const big = Array.from({ length: 30 }, () => fam({ upd: 800, size: 120 }));
    const mid = Array.from({ length: 70 }, () => fam({ upd: 800, size: 30 }));
    const s = suggest(orgOf([...big, ...mid, ...fresh(100)]));
    expect(CAP_SIZES).toEqual([20, 50, 100]);
    expect(s).toMatchObject({ rung: 0, flagged: 30, owners: 30, capped: false });
    expect(s?.thresholds.minSizeMB).toBe(50);
    expect(evaluate(orgOf([...big, ...mid, ...fresh(100)]), s!.thresholds).totals.owners).toBe(30);
  });

  it('when 100 MB still has more than 40 owners it returns that, capped, and the sentence says so', () => {
    const many = Array.from({ length: 100 }, () => fam({ upd: 800, size: 200 })); // 100 different owners, all big
    const s = suggest(orgOf([...many, ...fresh(100)]));
    expect(s).toMatchObject({ rung: 0, capped: true, owners: 100 });
    expect(s?.thresholds.minSizeMB).toBe(100);
    const words = suggestSentence(s!);
    expect(words).toMatch(/more than 40 owners, even at 100 MB/);
    expect(words).not.toMatch(/delet|must|urgent/i);
  });

  it('a size step that would flag nothing is not taken', () => {
    const many = Array.from({ length: 60 }, () => fam({ upd: 800, size: 30 })); // 60 owners; nothing at 50 MB
    const s = suggest(orgOf([...many, ...fresh(60)]));
    expect(s).toMatchObject({ capped: true, owners: 60 });
    expect(s?.thresholds.minSizeMB).toBe(20);
  });

  it('LIMITATION: when the owner cap sends it back to a gentler rung, that rung can flag under half the target and capped is false', () => {
    // 300 families -> target 45, floor 22.5. Rung 0: 20 families (under the floor); rung 1 adds 60 used by one map, from 80 owners (over the cap).
    const a = Array.from({ length: 20 }, () => fam({ upd: 800 }));
    const b = Array.from({ length: 60 }, () => fam({ upd: 800, by: 1 }));
    const s = suggest(orgOf([...a, ...b, ...fresh(220)]));
    expect(s).toMatchObject({ rung: 0, flagged: 20, capped: false });
    expect(s!.flagged).toBeLessThan(s!.target / 2);
  });

  it('disabled owners are left out of the count (they cannot be emailed) but still count in "1 in N services"', () => {
    const stale = Array.from({ length: 10 }, () => fam({ upd: 800 }));
    const gone = Array.from({ length: 40 }, () => fam({ upd: 800, owner: 'dee' }));
    const s = suggest(orgOf([...stale, ...gone, ...fresh(50)], [owner('dee', { disabled: true })]));
    expect(s?.flagged).toBe(10);
    expect(s?.total).toBe(100);
    expect(suggestSentence(s!)).toContain('about 1 in 10 services');
  });

  it('the sentence reads the rung in last-used words', () => {
    const s = suggest(orgOf([...Array.from({ length: 10 }, () => fam({ upd: 800 })), ...fresh(50)]));
    expect(suggestSentence(s!)).toBe('Suggested for your org: about 1 in 6 services (10 services across 10 owners), those nobody has used for more than a year, last updated more than a year ago, used by no maps or apps, and at least 20 MB.'); // 10 is over the target of 9, so 20 MB
  });

  it('while maps and apps are still being read the suggestion is marked refining and never flags fewer', () => {
    const data = orgOf([...Array.from({ length: 20 }, () => fam({ upd: 400, by: 3 })), ...fresh(80)]);
    const known = suggest(data);
    const refining = suggest(data, { depsKnown: false });
    expect(refining?.refining).toBe(true);
    expect(known?.refining ?? false).toBe(false);
    expect(refining!.flagged).toBeGreaterThan(0);
  });
});

describe('families with bad data (DC-084 fix)', () => {
  it('a cycle of view sources terminates, and the views in it are left out (no source to belong to)', async () => {
    const { families } = await import('./stale');
    const svc = (id: string, sourceId: string) => ({ id, title: id, owner: 'amy', created: '2020-01-01T00:00:00Z', modified: '2020-01-01T00:00:00Z', sizeMB: 0, access: 'org', isView: true, sourceId, usage: [], dependencies: [] });
    const data = { org: { id: 'o', name: 'o', urlKey: '', scannedAt: '2026-10-16T00:00:00Z' }, owners: [], services: [svc('a', 'b'), svc('b', 'a')] };
    const f = families(data as never);
    expect(f).toEqual([]);
  });
});
