import { test } from 'vitest';
import assert from 'node:assert/strict';
import { evaluate, allRows, whyLine } from './stale';
import { fmtMonthYear } from './format';
import type { Data, Owner, Service, Thresholds } from './types';

// DC-131a: a family's "last updated" is the newer of the item date and the data edit date.
const SCAN = '2026-10-10T09:00:00Z';
const DAY = 86400000;
const isoAgo = (d: number) => new Date(Date.parse(SCAN) - d * DAY).toISOString();

let n = 0;
const hex = () => (++n).toString(16).padStart(32, '0');
const svc = (o: Partial<Service> = {}): Service => ({
  id: hex(), title: `Service ${n}`, owner: 'amy', created: isoAgo(900), modified: isoAgo(800), sizeMB: 5,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const view = (src: Service, o: Partial<Service> = {}) => svc({ isView: true, sourceId: src.id, sizeMB: 0, ...o });
const owners: Owner[] = [
  { username: 'amy', fullName: 'Amy A', email: 'amy@example.org', role: 'org_publisher', disabled: false, thumbnail: null, lastNotified: null },
];
const mk = (services: Service[], extra: Partial<Data> = {}): Data => ({
  org: { id: 'o', name: 'Org', urlKey: 'org', scannedAt: SCAN }, owners, services, ...extra,
});
const T: Thresholds = { minDaysSinceUse: 180, minDaysSinceUpdate: 365, maxUsedBy: 1 };

test('family last updated is the newest of every member modified and dataEdited', () => {
  const src = svc({ modified: isoAgo(800), dataEdited: isoAgo(500) });
  const v = view(src, { modified: isoAgo(600), dataEdited: isoAgo(450) });
  assert.equal(allRows(mk([src, v]), T)[0].daysSinceUpdate, 450);
  const src2 = svc({ modified: isoAgo(800), dataEdited: isoAgo(100) });
  const v2 = view(src2, { modified: isoAgo(400), dataEdited: isoAgo(700) });
  assert.equal(allRows(mk([src2, v2]), T)[0].daysSinceUpdate, 100);
});

test('a recent dataEdited on the source keeps the family off the list', () => {
  const src = svc({ modified: isoAgo(800), dataEdited: isoAgo(30) });
  assert.equal(evaluate(mk([src]), T).families.length, 0);
});

test('a recent dataEdited on a view keeps the family off the list', () => {
  const src = svc({ modified: isoAgo(800) });
  const v = view(src, { modified: isoAgo(800), dataEdited: isoAgo(30) });
  assert.equal(evaluate(mk([src, v]), T).families.length, 0);
});

test('an old dataEdited never makes a family more stale than its item date', () => {
  const src = svc({ modified: isoAgo(200), dataEdited: isoAgo(900) });
  const r = allRows(mk([src]), T)[0];
  assert.equal(r.daysSinceUpdate, 200);
  assert.equal(evaluate(mk([src]), T).families.length, 0);
});

test('undefined and null dataEdited fall back to the item date', () => {
  const a = svc({ modified: isoAgo(500) });
  const b = svc({ modified: isoAgo(500), dataEdited: null });
  const c = svc({ modified: isoAgo(500), dataEdited: undefined });
  for (const s of [a, b, c]) {
    const r = allRows(mk([s]), T)[0];
    assert.equal(r.daysSinceUpdate, 500);
    assert.equal(r.stale, true);
  }
});

test('a junk or 1970 dataEdited is ignored like a missing modified', () => {
  for (const bad of ['not a date', '', '1970-01-01T00:00:00.000Z']) {
    const s = svc({ modified: isoAgo(500), dataEdited: bad });
    const r = allRows(mk([s]), T)[0];
    assert.equal(r.daysSinceUpdate, 500, `dataEdited ${JSON.stringify(bad)}`);
    assert.equal(r.stale, true);
  }
});

test('lastModified is the newer date, so the why line shows the data date', () => {
  const src = svc({ modified: isoAgo(800), dataEdited: isoAgo(500) });
  const r = allRows(mk([src]), T)[0];
  assert.equal(r.lastModified, isoAgo(500));
  const month = fmtMonthYear(isoAgo(500)), old = fmtMonthYear(isoAgo(800));
  const line = whyLine(r);
  assert.ok(line.includes(`last updated ${month}`), line);
  assert.ok(!line.includes(`last updated ${old}`), line);
  assert.ok(!/data last edited|data edited/i.test(line), line);
});

test('with last used not part of the rule, a recent dataEdited still keeps the family off the list', () => {
  // minDaysSinceUse 0 skips the last-used rule, so the verdict leans on last updated alone.
  const rule: Thresholds = { ...T, minDaysSinceUse: 0 };
  const old = svc({ modified: isoAgo(800) });
  assert.equal(evaluate(mk([old]), rule).families.length, 1); // control: flagged without a data date
  const fresh = svc({ modified: isoAgo(800), dataEdited: isoAgo(30) });
  assert.equal(evaluate(mk([fresh]), rule).families.length, 0);
});
