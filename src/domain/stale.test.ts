import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PRESETS, PRESET_NAMES, matchPreset, creditsPerMonth, families, evaluate, describe, whyLine, ruleLine,
  allRows, SIZE_OPTIONS, LAST_USED_OPTIONS, UPDATE_OPTIONS, USED_BY_OPTIONS,
} from './stale';
import type { Data, EvaluateResult, Dependency, Owner, Service, Thresholds } from './types';

const SCAN = '2026-10-10T09:00:00Z';
const DAY = 86400000;
const isoAgo = (d: number) => new Date(Date.parse(SCAN) - d * DAY).toISOString();

let n = 0;
const hex = () => (++n).toString(16).padStart(32, '0');
const svc = (o: Partial<Service> = {}): Service => ({
  id: hex(), title: `Service ${n}`, owner: 'amy', created: isoAgo(900), modified: isoAgo(800), sizeMB: 5,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const dep = (i = 1): Dependency => ({ id: `d${i}`, title: `Map ${i}`, type: 'Web Map', owner: 'amy' });
const owners = (extra: Owner[] = []): Owner[] => [
  { username: 'amy', fullName: 'Amy A', email: 'amy@example.org', role: 'org_publisher', disabled: false, thumbnail: null, lastNotified: null },
  { username: 'bob', fullName: 'Bob B', email: 'bob@example.org', role: 'org_publisher', disabled: false, thumbnail: null, lastNotified: null },
  { username: 'dee', fullName: 'Dee D', email: 'dee@example.org', role: 'org_user', disabled: true, thumbnail: null, lastNotified: null },
  ...extra,
];
const mk = (services: Service[], own: Owner[] = owners()): Data => ({
  org: { id: 'o', name: 'Org', urlKey: 'org', scannedAt: SCAN }, owners: own, services,
});
const T: Thresholds = { minDaysSinceUse: 180, minDaysSinceUpdate: 365, maxUsedBy: 1 };

test('presets match the contract and matchPreset round-trips', () => {
  assert.deepEqual(PRESETS.gentle, { minDaysSinceUse: 365, minDaysSinceUpdate: 365, maxUsedBy: 0, minSizeMB: 20 });
  assert.deepEqual(PRESETS.balanced, { minDaysSinceUse: 180, minDaysSinceUpdate: 180, maxUsedBy: 1, minSizeMB: 15 });
  assert.deepEqual(PRESETS.strict, { minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 2, minSizeMB: 10 });
  for (const k of Object.keys(PRESETS)) assert.equal(matchPreset({ ...PRESETS[k as keyof typeof PRESETS] }), k);
  assert.equal(matchPreset({ ...PRESETS.balanced, minDaysSinceUse: 270 }), 'custom');
  assert.equal(matchPreset({ ...PRESETS.balanced, minSizeMB: 10 }), 'custom');
  assert.deepEqual(Object.keys(PRESET_NAMES).sort(), ['balanced', 'custom', 'gentle', 'strict', 'suggested']);
});

test('GH-2: deprecated layers are in unless excluded; authoritative ones are out unless included; neither changes the starting point', () => {
  const dep = svc({ contentStatus: 'deprecated' }), plain = svc();
  const auth = svc({ contentStatus: 'org_authoritative' }), pub = svc({ contentStatus: 'public_authoritative' });
  const data = mk([dep, plain, auth, pub]);
  const ids = (t: Thresholds) => evaluate(data, t).families.map((r) => r.source.id).sort();
  assert.deepEqual(ids(T), [dep.id, plain.id].sort());
  assert.deepEqual(ids({ ...T, excludeDeprecated: true }), [plain.id]);
  assert.deepEqual(ids({ ...T, includeAuthoritative: true }), [dep.id, plain.id, auth.id, pub.id].sort());
  assert.equal(matchPreset({ ...PRESETS.balanced, excludeDeprecated: true, includeAuthoritative: true }), 'balanced');
});

test('credits maths: 2.4 credits per 10 MB per month', () => {
  assert.equal(creditsPerMonth(10), 2.4);
  assert.equal(creditsPerMonth(0), 0);
  assert.ok(Math.abs(creditsPerMonth(1024) - 245.76) < 1e-9);
});

test('a day many services share is use like any other (DC-057)', () => {
  const target = svc({ usage: [[5, 1], [30, 1]] });
  const others = [];
  for (let i = 0; i < 4; i++) others.push(svc({ usage: [[5, 1]] }));
  const data = mk([target, ...others]);
  const row = (r: EvaluateResult, id: string) => r.families.find((f) => f.source.id === id);
  assert.equal(row(evaluate(data, T), target.id), undefined); // used 5 days ago, so not stale
  assert.equal(allRows(data, T).find((f) => f.source.id === target.id)!.lastUsedDaysAgo, 5);
});

test('last used is the newest day with requests, wherever it falls in the year read (DC-083)', () => {
  const s = svc({ usage: [[10, 1], [89, 1], [90, 1], [200, 1]] });
  const r = allRows(mk([s]), T)[0];
  assert.equal(r.lastUsedDaysAgo, 10);
  assert.equal(r.stale, false);
});

test('lastUsedDaysAgo is null when never used', () => {
  const r = evaluate(mk([svc()]), T);
  assert.equal(r.families[0].lastUsedDaysAgo, null);
  assert.equal(r.families[0].noUseRecorded, false); // no lastViewed field: an old scan, requests only
  assert.equal(r.families[0].requestsOnly, true);
});

test('families group views under their source; standalone is a family of one', () => {
  const src = svc({ sizeMB: 100 });
  const v1 = svc({ isView: true, sourceId: src.id, sizeMB: 0 });
  const v2 = svc({ isView: true, sourceId: src.id, sizeMB: 0 });
  const solo = svc();
  const fams = families(mk([v1, solo, src, v2]));
  assert.equal(fams.length, 2);
  const f = fams.find((x) => x.source.id === src.id)!;
  assert.deepEqual(f.views.map((v) => v.id).sort(), [v1.id, v2.id].sort());
  assert.equal(fams.find((x) => x.source.id === solo.id)!.views.length, 0);
});

test('family last use is the newest across members; family is stale only as a whole', () => {
  const src = svc({ sizeMB: 50, usage: [[300, 1]] });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 0, usage: [[200, 4]], lastViewed: isoAgo(250) });
  const data = mk([src, v]);
  assert.equal(evaluate(data, { ...T, minDaysSinceUse: 270 }).families.length, 0);
  const r = evaluate(data, T);
  assert.equal(r.families.length, 1);
  assert.equal(r.families[0].lastUsedDaysAgo, 200);
  assert.equal(r.families[0].views.length, 1);
  assert.equal(r.totals.services, 2);
  assert.equal(r.totals.families, 1);
});

test('a recently used view keeps the whole family off the list even if the source is idle', () => {
  const src = svc({ usage: [] });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 0, usage: [[1, 1], [2, 1], [3, 1], [4, 1]] });
  assert.equal(evaluate(mk([src, v]), T).families.length, 0);
});

test('family update age uses the most recent modified; usedBy is distinct across the family', () => {
  const src = svc({ modified: isoAgo(800), dependencies: [dep(1)] });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 0, modified: isoAgo(400), dependencies: [dep(1), dep(2)] });
  const r = evaluate(mk([src, v]), { ...T, maxUsedBy: 5 });
  assert.equal(r.families[0].daysSinceUpdate, 400);
  assert.equal(r.families[0].usedBy, 2);
  // a fresh view makes the family too recent
  const fresh = svc({ isView: true, sourceId: src.id, sizeMB: 0, modified: isoAgo(10) });
  assert.equal(evaluate(mk([src, fresh]), T).families.length, 0);
  // usedBy across views can push the family over the limit
  assert.equal(evaluate(mk([src, v]), { ...T, maxUsedBy: 1 }).families.length, 0);
});

test('credits: views are 0, family credits are the source storage', () => {
  const src = svc({ sizeMB: 100 });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 40 }); // stray size still must not earn credits
  const r = evaluate(mk([src, v]), T);
  assert.equal(r.families[0].credits, 24);
  assert.equal(r.families[0].sizeMB, 100);
  assert.equal(r.totals.credits, 24);
  assert.equal(r.totals.sizeMB, 100);
});

test('threshold boundaries: lastUsed >=, daysSinceUpdate >=, usedBy <=', () => {
  const at = (o: Partial<Service>) => evaluate(mk([svc(o)]), T).families.length;
  assert.equal(at({ usage: [[180, 1]] }), 1);
  assert.equal(at({ usage: [[179, 1]] }), 0);
  assert.equal(at({ lastViewed: isoAgo(180) }), 1);
  assert.equal(at({ lastViewed: isoAgo(179) }), 0);
  assert.equal(at({ modified: isoAgo(365) }), 1);
  assert.equal(at({ modified: isoAgo(364) }), 0);
  assert.equal(at({ dependencies: [dep(1)] }), 1);
  assert.equal(at({ dependencies: [dep(1), dep(2)] }), 0);
});

test('no size gate: tiny and zero-size services are listed', () => {
  const r = evaluate(mk([svc({ sizeMB: 0.001 }), svc({ sizeMB: 0 })]), T);
  assert.equal(r.families.length, 2);
});

test('sort: credits desc, then sizeMB desc; owners by credits desc', () => {
  const a = svc({ owner: 'amy', sizeMB: 10 });
  const b = svc({ owner: 'bob', sizeMB: 500 });
  const c = svc({ owner: 'amy', sizeMB: 100 });
  const zeroA = svc({ owner: 'amy', sizeMB: 0 });
  const r = evaluate(mk([a, b, c, zeroA]), T);
  assert.deepEqual(r.families.map((f) => f.sizeMB), [500, 100, 10, 0]);
  assert.deepEqual(r.owners.map((o) => o.owner.username), ['bob', 'amy']);
  const amy = r.owners[1]!;
  assert.equal(amy.rows.length, 3);
  assert.equal(amy.sizeMB, 110);
  assert.ok(Math.abs(amy.credits - 26.4) < 1e-9);
  assert.equal(r.totals.owners, 2);
  assert.equal(r.totals.families, 4);
});

test('owners: disabled flag, nudgedRecently within 182 days, defaultTicked is its inverse', () => {
  const own = owners();
  own[0].lastNotified = isoAgo(100);
  own[1].lastNotified = isoAgo(300);
  const r = evaluate(mk([svc({ owner: 'amy', sizeMB: 9 }), svc({ owner: 'bob', sizeMB: 1 })], own), T);
  const amy = r.owners.find((o) => o.owner.username === 'amy')!;
  const bob = r.owners.find((o) => o.owner.username === 'bob')!;
  assert.equal(amy.nudgedRecently, true);
  assert.equal(amy.defaultTicked, false);
  assert.equal(bob.nudgedRecently, false);
  assert.equal(bob.defaultTicked, true);
  assert.equal(bob.disabled, false);
  assert.equal(amy.disabled, false);
  // boundary
  own[0].lastNotified = isoAgo(182);
  assert.equal(evaluate(mk([svc()], own), T).owners[0].nudgedRecently, true);
  own[0].lastNotified = isoAgo(183);
  assert.equal(evaluate(mk([svc()], own), T).owners[0].nudgedRecently, false);
});

test('rows carry the owner record and why line', () => {
  const r = evaluate(mk([svc({ usage: [[300, 1]], dependencies: [dep(1)] })]), T);
  const row = r.families[0];
  assert.equal(row.owner.username, 'amy');
  assert.equal(row.family.source.id, row.source.id);
  assert.equal(row.why, whyLine(row));
});

test('whyLine reads as the contract example and avoids banned words', () => {
  const s = svc({ usage: [[240, 1]], modified: isoAgo(570), dependencies: [dep(1)], numViews: 585557 });
  const row = evaluate(mk([s]), T).families[0];
  const line = whyLine(row);
  assert.match(line, /^Last used 8 months ago · last updated [A-Z][a-z]{2} \d{4} · used by 1 map or app · 585,557 views all time$/);
  const zero = whyLine({ ...row, lastUsedDaysAgo: null, usedBy: 0, numViews: null });
  const none = whyLine({ ...row, noUseRecorded: true });
  const unknown = whyLine({ ...row, useKnown: false });
  assert.match(zero, /^No data requests in the last year · .* · not used by any maps or apps$/);
  assert.match(none, /^No use recorded since at least November 2022 · /);
  assert.match(unknown, /^Last used: unknown \(we couldn't read all of its use\) · /);
  // ADR 0007 vocabulary: plain, never quiet, dormant or bot talk
  for (const l of [line, zero, none, unknown, describe(T), describe(PRESETS.gentle)]) {
    assert.ok(!/quiet|dormant|abandoned|usage call|script|bot/i.test(l), l);
  }
});

test('describe is one plain sentence built from t', () => {
  const d = describe(PRESETS.balanced);
  assert.match(d, /more than 6 months/);
  assert.match(d, /at most 1 map or app/);
  assert.equal(d.split('. ').length, 1);
  assert.ok(describe(PRESETS.strict).includes('3 months'));
  assert.notEqual(describe(PRESETS.gentle), describe(PRESETS.strict));
});

test('size filter: minSizeMB is a floor, 0 or missing means any size', () => {
  const data = mk([svc({ sizeMB: 0.5 }), svc({ sizeMB: 10 }), svc({ sizeMB: 500 })]);
  assert.equal(evaluate(data, T).families.length, 3);
  assert.equal(evaluate(data, { ...T, minSizeMB: 0 }).families.length, 3);
  assert.deepEqual(evaluate(data, { ...T, minSizeMB: 10 }).families.map((f) => f.sizeMB), [500, 10]);
  assert.equal(evaluate(data, { ...T, minSizeMB: 1024 }).families.length, 0);
  assert.equal(matchPreset({ ...PRESETS.balanced, minSizeMB: 10 }), 'custom');
});

test('dropdown options are { value, label } and cover the controller lists', () => {
  assert.deepEqual(SIZE_OPTIONS.map((o) => o.value), [0, 1, 10, 15, 20, 50, 100, 1024]);
  assert.deepEqual(SIZE_OPTIONS.map((o) => o.label), ['Any size', '1 MB', '10 MB', '15 MB', '20 MB', '50 MB', '100 MB', '1 GB']);
  assert.deepEqual(LAST_USED_OPTIONS.map((o) => o.value), [90, 180, 270, 365, 730]);
  assert.deepEqual(UPDATE_OPTIONS.map((o) => o.label), ['3 months', '6 months', '9 months', '1 year', '2 years', '3 years']);
  assert.deepEqual(USED_BY_OPTIONS.map((o) => o.value), [0, 1, 2, 5]);
  for (const l of [SIZE_OPTIONS, LAST_USED_OPTIONS, UPDATE_OPTIONS, USED_BY_OPTIONS]) for (const o of l) assert.ok(typeof o.label === 'string' && 'value' in o);
});

test('tidy hints come from the source service and never filter', () => {
  const full = svc({ description: 'd', snippet: 's', tags: ['a'] });
  const bare = svc({ description: '', snippet: '', tags: [] });
  const noTags = svc({ description: 'd', snippet: 's', tags: [] });
  const legacy = svc(); // fields absent: counts as missing
  const r = evaluate(mk([full, bare, noTags, legacy]), T);
  const by = (id: string) => r.families.find((f) => f.source.id === id)!;
  assert.equal(r.families.length, 4);
  assert.deepEqual(by(full.id).tidyHints, []);
  assert.equal(by(full.id).tidy, null);
  assert.deepEqual(by(bare.id).tidyHints, ['description', 'tags', 'summary']);
  assert.match(by(bare.id).tidy!, /^Tip: .*help colleagues find this\.$/);
  assert.deepEqual(by(noTags.id).tidyHints, ['tags']);
  assert.match(by(noTags.id).tidy!, /tags/);
  assert.ok(!/description/.test(by(noTags.id).tidy!));
  // a view's own fields are ignored; the source decides
  const v = svc({ isView: true, sourceId: full.id, sizeMB: 0, description: '', tags: [] });
  assert.deepEqual(evaluate(mk([full, v]), T).families[0].tidyHints, []);
});

test('disabled owners: stale items leave owners/families and appear in unreachable', () => {
  const a = svc({ owner: 'amy', sizeMB: 10 });
  const d1 = svc({ owner: 'dee', sizeMB: 100 });
  const d2 = svc({ owner: 'dee', sizeMB: 20 });
  const r = evaluate(mk([a, d1, d2]), T);
  assert.deepEqual(r.owners.map((o) => o.owner.username), ['amy']);
  assert.deepEqual(r.families.map((f) => f.source.id), [a.id]);
  assert.equal(r.unreachable.length, 1);
  assert.equal(r.unreachable[0].owner.username, 'dee');
  assert.equal(r.unreachable[0].rows.length, 2);
  assert.equal(r.unreachable[0].sizeMB, 120);
  assert.ok(Math.abs(r.unreachable[0].credits - 28.8) < 1e-9);
  assert.equal(r.totals.unreachableFamilies, 2);
  assert.equal(r.totals.families, 1);
  assert.equal(r.totals.owners, 1);
  assert.equal(evaluate(mk([a]), T).totals.unreachableFamilies, 0);
  assert.deepEqual(evaluate(mk([a]), T).unreachable, []);
  // a disabled owner's active item is not stale, so not unreachable either
  const busy = svc({ owner: 'dee', usage: [[1, 1], [2, 1], [3, 1], [4, 1]] });
  assert.equal(evaluate(mk([busy]), T).unreachable.length, 0);
});

test('a missing update date never makes a layer look long untouched (errors lean towards not flagging)', () => {
  // The scan turns a missing `modified` into 1970-01-01; that must not read as "last updated 56 years ago".
  const s = svc({ modified: new Date(0).toISOString() });
  const row = evaluate(mk([s]), { ...T, minDaysSinceUse: 0 });
  assert.equal(row.families.length, 0);
  // A view's real date still counts for the family.
  const src = svc({ modified: new Date(0).toISOString() });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 0, modified: isoAgo(500) });
  const fam = evaluate(mk([src, v]), { ...T, minDaysSinceUse: 0 }).families[0];
  assert.equal(fam?.daysSinceUpdate, 500);
});

test('weekly: 13 buckets oldest to newest', () => {
  const sharers = [];
  for (let i = 0; i < 4; i++) sharers.push(svc({ usage: [[10, 1]] })); // day 10 is used by every service: it still counts
  const s = svc({ usage: [[0, 1], [1, 1], [2, 1], [10, 1], [8, 1], [90, 1], [91, 1], [200, 1]] });
  const t = { ...T, minDaysSinceUse: 0 };
  const row = evaluate(mk([s, ...sharers]), t).families.find((f) => f.source.id === s.id)!;
  assert.equal(row.weekly.length, 13);
  assert.equal(row.weekly[12], 3); // DC-101: today (day 0) counts; days 0-6 are the newest week
  assert.equal(row.weekly[11], 2); // days 8 and 10
  assert.equal(row.weekly[0], 1); // day 90, oldest; day 91 is out
  assert.equal(row.weekly.reduce((a, b) => a + b, 0), 6);
  // family union: a view's days merge, same day counts once
  const v = svc({ isView: true, sourceId: s.id, sizeMB: 0, usage: [[1, 9], [3, 1]] });
  const fam = evaluate(mk([s, v]), { ...T, minDaysSinceUse: 0 }).families[0];
  assert.equal(fam.weekly[12], 4);
});

test('staleness is 0..1: mean of last-used and update age; never used = 1 on that half', () => {
  const never = svc({ usage: [], modified: isoAgo(730) });
  const recent = svc({ usage: [[1, 1]], modified: isoAgo(0) });
  const mid = svc({ usage: [[73, 1]], modified: isoAgo(365) });
  const ancient = svc({ usage: [[400, 1]], modified: isoAgo(5000) });
  const rows = allRows(mk([never, recent, mid, ancient]), T);
  const by = (x: Service) => rows.find((r) => r.source.id === x.id)!.staleness;
  assert.equal(by(never), 1);
  assert.ok(Math.abs(by(recent) - 1 / 365 / 2) < 1e-9);
  assert.ok(Math.abs(by(mid) - (73 / 365 + 0.5) / 2) < 1e-9);
  assert.equal(by(ancient), 1);
  for (const r of rows) assert.ok(r.staleness >= 0 && r.staleness <= 1);
});

test('allRows covers every family with stale flags; evaluate agrees', () => {
  const src = svc({ sizeMB: 50 });
  const v = svc({ isView: true, sourceId: src.id, sizeMB: 0 });
  const stale = svc({ owner: 'dee' });
  const live = svc({ usage: [[1, 1], [2, 1], [3, 1], [4, 1]] });
  const data = mk([src, v, stale, live]);
  const rows = allRows(data, T);
  assert.equal(rows.length, families(data).length);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.stale).length, 2); // includes the disabled owner's
  assert.equal(rows.find((r) => r.source.id === live.id)!.stale, false);
  const e = evaluate(data, T);
  assert.equal(e.totals.families + e.totals.unreachableFamilies, 2);
  for (const r of rows) assert.ok(Array.isArray(r.weekly) && typeof r.why === 'string');
});

test('ruleLine reads the thresholds on one short line', () => {
  assert.equal(ruleLine(PRESETS.balanced), 'Last used more than 6 months ago · last updated more than 6 months ago · used by at most 1 map or app · at least 15 MB');
  assert.equal(ruleLine(PRESETS.gentle), 'Last used more than a year ago · last updated more than a year ago · used by no maps or apps · at least 20 MB');
  assert.equal(ruleLine({ ...PRESETS.gentle, minDaysSinceUse: 0 }), 'Last updated more than a year ago · used by no maps or apps · at least 20 MB');
});

// ---------- DC-100b: a Data that changed only a few services keeps the rest of the work ----------
test('DC-100b: rows from a Data copy that changed a few services equal a fresh scoring, and unchanged rows are the same objects', () => {
  const list: Service[] = [];
  for (let i = 0; i < 120; i++) {
    const src = svc({ owner: i % 3 ? 'amy' : 'bob', sizeMB: i % 7 === 0 ? null : (i % 11) * 6, usage: i % 5 === 0 ? [[3 + i, 2]] : [], modified: isoAgo(100 + i * 9) });
    list.push(src);
    if (i % 4 === 0) list.push(svc({ owner: src.owner, isView: true, sourceId: src.id, sizeMB: 0, modified: isoAgo(50 + i) }));
  }
  const a = mk(list);
  const rules: Thresholds[] = [T, { ...T, minDaysSinceUse: 0, maxUsedBy: 0 }, { minDaysSinceUse: 90, minDaysSinceUpdate: 90, maxUsedBy: 2, minSizeMB: 10 }];
  for (const t of rules) for (const depsKnown of [false, true]) for (const countSweeps of [false, true]) allRows(a, t, { depsKnown, countSweeps });

  // The next Data: a dozen services gain links and two get a size; every other service object is the very same one.
  const b = mk(list.map((s, i) => (i % 10 === 3 ? { ...s, dependencies: [dep(1), dep(2 + (i % 3))] } : i === 20 || i === 41 ? { ...s, sizeMB: 400 } : s)));
  const fresh = structuredClone(b) as Data; // new objects all through: nothing of it can be remembered
  for (const t of rules) for (const depsKnown of [false, true]) for (const countSweeps of [false, true]) {
    const opts = { depsKnown, countSweeps };
    const got = allRows(b, t, opts), want = allRows(fresh, t, opts);
    assert.deepEqual(got.map((r) => ({ ...r, family: r.family.id, source: r.source.id, views: r.views.map((v) => v.id), owner: r.owner.username })),
      want.map((r) => ({ ...r, family: r.family.id, source: r.source.id, views: r.views.map((v) => v.id), owner: r.owner.username })));
    assert.deepEqual(evaluate(b, t, opts).owners.map((o) => [o.owner.username, o.credits, o.startCount, o.rows.map((r) => r.source.id)]),
      evaluate(fresh, t, opts).owners.map((o) => [o.owner.username, o.credits, o.startCount, o.rows.map((r) => r.source.id)]));
  }

  const rowsA = new Map(allRows(a, T, { depsKnown: false }).map((r) => [r.source.id, r]));
  const rowsB = allRows(b, T, { depsKnown: false });
  let same = 0;
  for (const r of rowsB) if (rowsA.get(r.source.id) === r) same++;
  assert.ok(same > rowsB.length * 0.7, `most rows are kept (${same} of ${rowsB.length})`);
  const fa = families(a), fb = families(b);
  assert.equal(fb.filter((f) => fa.includes(f)).length > fb.length * 0.7, true);
});

test('DC-100b: a changed size or link on a kept Family object is seen (the Family is rebuilt with its members)', () => {
  const s1 = svc({ sizeMB: 40 }), s2 = svc({ sizeMB: 40 });
  const a = mk([s1, s2]);
  assert.equal(allRows(a, T).find((r) => r.source.id === s1.id)!.usedBy, 0);
  const b = mk([{ ...s1, dependencies: [dep(1), dep(2)] }, s2]);
  const rb = allRows(b, T);
  assert.equal(rb.find((r) => r.source.id === s1.id)!.usedBy, 2);
  assert.equal(rb.find((r) => r.source.id === s2.id)!.usedBy, 0);
  assert.equal(families(b).find((f) => f.id === s2.id), families(a).find((f) => f.id === s2.id));
});

test('DC-100b: an owner whose rows are the same objects gets the same group back from evaluate', () => {
  const amy = [svc({ sizeMB: 40 }), svc({ sizeMB: 30 })], bob = [svc({ owner: 'bob', sizeMB: 50 })];
  const a = mk([...amy, ...bob]);
  const ga = evaluate(a, T, { depsKnown: false }).owners;
  assert.equal(ga.length, 2);
  const b = mk([...amy, { ...bob[0] as Service, sizeMB: 80 }]);
  const gb = evaluate(b, T, { depsKnown: false }).owners;
  assert.equal(gb.find((g) => g.owner.username === 'amy'), ga.find((g) => g.owner.username === 'amy'));
  assert.notEqual(gb.find((g) => g.owner.username === 'bob'), ga.find((g) => g.owner.username === 'bob'));
  assert.equal(gb.find((g) => g.owner.username === 'bob')!.sizeMB, 80);
});
