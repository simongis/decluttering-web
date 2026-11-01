import { describe, expect, it } from 'vitest';
import { carriedRefs, missingRefs, ownerNamer, sortBrokenRefs, visibleBrokenRefs, type Known } from './broken-refs';
import type { BrokenRef, Data, Owner, Service } from './types';

const ORG = 'AbCdEf0123456789';
const id = (c: string) => c.repeat(32);
const host = (name: string, org = ORG, sub = 'services1') => `https://${sub}.arcgis.com/${org}/arcgis/rest/services/${name}/FeatureServer/0`;
const known = (ids: string[] = [], names: string[] = []): Known => ({ hasId: (x) => ids.includes(x), hasName: (n) => names.includes(n) });
// The scan lowercases a map's text before looking at it.
const map = (...layers: Record<string, unknown>[]) => JSON.stringify({ operationalLayers: layers, baseMap: {} }).toLowerCase();

describe('missingRefs (DC-035a): strict, only this org hosted layers that the search did not find', () => {
  it('true positive: an item id and a url on this org host that match nothing', () => {
    expect(missingRefs(map({ itemId: id('a'), url: host('Parks') }), ORG, known())).toEqual([id('a')]);
  });

  it('a url with no usable id is reported by its service name', () => {
    expect(missingRefs(map({ url: host('Old_Roads') }), ORG, known())).toEqual(['name:old_roads']);
    expect(missingRefs(map({ itemId: 'not-an-id', url: host('Old_Roads') }), ORG, known())).toEqual(['name:old_roads']);
  });

  it('a layer that is found by id, or by service name (re-created), is fine', () => {
    expect(missingRefs(map({ itemId: id('a'), url: host('Parks') }), ORG, known([id('a')]))).toEqual([]);
    expect(missingRefs(map({ itemId: id('a'), url: host('Parks') }), ORG, known([], ['parks']))).toEqual([]);
  });

  it('views count as found: they are in the search like any hosted layer', () => {
    expect(missingRefs(map({ itemId: id('b'), url: host('Parks_View') }), ORG, known([id('b')], ['parks_view']))).toEqual([]);
  });

  it('another org hosted layer, or public Esri content, is never reported', () => {
    expect(missingRefs(map({ itemId: id('c'), url: host('Roads', 'ZZZZZZZZZZZZZZZZ') }), ORG, known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('d'), url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer' }), ORG, known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('d'), url: 'https://server.example.org/arcgis/rest/services/Roads/FeatureServer/0' }), ORG, known())).toEqual([]);
  });

  it('other item types are never reported: tile and image layers on this org host, and a bare item id with no url', () => {
    expect(missingRefs(map({ itemId: id('e'), url: `https://tiles.arcgis.com/tiles/${ORG}/arcgis/rest/services/Base/MapServer` }), ORG, known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('e'), url: `https://services1.arcgis.com/${ORG}/arcgis/rest/services/Img/ImageServer` }), ORG, known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('f'), title: 'Basemap or anything' }), ORG, known())).toEqual([]);
  });

  it('text that is not JSON, or does not mention this org, gives nothing', () => {
    expect(missingRefs('{"a": ', ORG, known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('a'), url: host('Parks') }), 'OTHERORG00000000', known())).toEqual([]);
    expect(missingRefs(map({ itemId: id('a'), url: host('Parks') }), '', known())).toEqual([]);
  });

  it('finds layers nested in groups and tables, and counts each only once', () => {
    const text = JSON.stringify({ operationalLayers: [{ layers: [{ itemId: id('a'), url: host('Parks') }] }], tables: [{ itemId: id('a'), url: host('Parks') }, { url: host('Gone') }] }).toLowerCase();
    expect(missingRefs(text, ORG, known())).toEqual([id('a'), 'name:gone']);
  });
});

const svc = (c: string, deps: string[] = []): Service => ({
  id: id(c), title: c, owner: 'amy', created: '2020-01-01T00:00:00Z', modified: '2020-01-01T00:00:00Z', sizeMB: 1, access: 'org', isView: false,
  sourceId: null, usage: [], lastViewed: null, dependencies: deps.map((d) => ({ id: d, title: `Map ${d}`, type: 'Web Map', owner: 'bob' })),
});
const data = (over: Partial<Data> = {}): Data => ({
  org: { id: 'o', name: 'O', urlKey: 'o', scannedAt: '2026-10-10T00:00:00Z' }, owners: [], services: [svc('1')],
  brokenRefs: [{ id: 'm1', title: 'Zeta', type: 'Web Map', owner: 'bob', missing: [id('a')] }, { id: 'm2', title: 'Alpha', type: 'Web Map', owner: 'bob', missing: ['name:old'] }], ...over,
});

describe('visibleBrokenRefs', () => {
  it('shows nothing for a partial scan (maps and apps not all read)', () => {
    expect(visibleBrokenRefs(data(), { depsComplete: false, mode: 'admin' })).toEqual([]);
  });
  it('shows nothing to a member: their search cannot see other owners private items', () => {
    expect(visibleBrokenRefs(data(), { depsComplete: true, mode: 'my-items' })).toEqual([]);
    expect(visibleBrokenRefs(data(), { depsComplete: true, mode: 'admin-cant-send' })).toHaveLength(2);
  });
  it('shows nothing when none were kept, and sorts by owner then title', () => {
    expect(visibleBrokenRefs(data({ brokenRefs: [] }), { depsComplete: true, mode: 'admin' })).toEqual([]);
    expect(visibleBrokenRefs(data({ brokenRefs: undefined }), { depsComplete: true, mode: 'admin' })).toEqual([]);
    expect(visibleBrokenRefs(data(), { depsComplete: true, mode: 'admin' }).map((b) => b.title)).toEqual(['Alpha', 'Zeta']);
  });
  it('drops an id that is among the org layers today', () => {
    const d = data({ services: [svc('a')] });
    expect(visibleBrokenRefs(d, { depsComplete: true, mode: 'admin' }).map((b) => b.id)).toEqual(['m2']);
  });
});

describe('carriedRefs: maps not re-read keep their findings, checked again against today layers', () => {
  const listed = (...ids: string[]) => new Map(ids.map((i) => [i, { title: `Now ${i}`, type: 'Web Map', owner: 'bob' }]));
  it('keeps a stored finding that is still missing, with the title as listed today', () => {
    expect(carriedRefs(data(), listed('m1'), known())).toEqual([{ id: 'm1', title: 'Now m1', type: 'Web Map', owner: 'bob', missing: [id('a')] }]);
  });
  it('drops one whose layer is back (by id or by name), and maps that were changed (not in reused)', () => {
    expect(carriedRefs(data(), listed('m1', 'm2'), known([id('a')], ['old']))).toEqual([]);
    expect(carriedRefs(data(), listed('m9'), known())).toEqual([]);
  });
  it('picks up a layer the last scan linked to that has since gone', () => {
    const prev = data({ services: [svc('1', ['m3'])], brokenRefs: [] });
    expect(carriedRefs(prev, listed('m3'), known())).toEqual([{ id: 'm3', title: 'Now m3', type: 'Web Map', owner: 'bob', missing: [id('1')] }]);
    expect(carriedRefs(prev, listed('m3'), known([id('1')]))).toEqual([]);
  });
  it('is empty without a previous scan', () => {
    expect(carriedRefs(undefined, listed('m1'), known())).toEqual([]);
  });
});

describe('sortBrokenRefs (DC-137): the missing-layers table', () => {
  const ref = (title: string, n: number, extra: Partial<BrokenRef> = {}): BrokenRef =>
    ({ id: title.toLowerCase(), title, type: 'Web Map', owner: `u_${title}`, missing: Array.from({ length: n }, (_, i) => id(String(i))), ...extra });
  const a = ref('Alpha', 1, { modified: '2026-01-05T00:00:00.000Z', owner: 'zed' });
  const b = ref('Bravo', 3, { modified: '2025-06-01T00:00:00.000Z', owner: 'amy', contentStatus: 'deprecated' });
  const c = ref('Charlie', 1, { owner: 'bob' }); // saved before DC-137: no date
  const d = ref('Delta', 2, { modified: '2026-03-01T00:00:00.000Z', owner: 'cat', contentStatus: 'org_authoritative' });
  const titles = (rs: readonly BrokenRef[]) => rs.map((r) => r.title);

  it('default: most missing layers first, ties by title', () => {
    expect(titles(sortBrokenRefs([a, c, d, b], 'missing', 'desc'))).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
    expect(titles(sortBrokenRefs([a, c, d, b], 'missing', 'asc'))).toEqual(['Alpha', 'Charlie', 'Delta', 'Bravo']);
  });

  it('by modified date, newest first; an unknown date goes last either way', () => {
    expect(titles(sortBrokenRefs([a, b, c, d], 'modified', 'desc'))).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie']);
    expect(titles(sortBrokenRefs([a, b, c, d], 'modified', 'asc'))).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
  });

  it('by owner uses the name shown, not the username', () => {
    const names: Record<string, string> = { zed: 'Ann Zed', amy: 'Zoe Amy', bob: 'Bob B', cat: 'Cat C' };
    expect(titles(sortBrokenRefs([a, b, c, d], 'owner', 'asc', (u) => names[u] ?? u))).toEqual(['Alpha', 'Charlie', 'Delta', 'Bravo']);
  });

  it('by title, and by status: deprecated, then authoritative, then none', () => {
    expect(titles(sortBrokenRefs([d, b, a, c], 'title', 'asc'))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(titles(sortBrokenRefs([a, c, d, b], 'deprecated', 'desc'))).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
  });

  it('does not change the list it was given', () => {
    const list = [a, b];
    sortBrokenRefs(list, 'missing', 'desc');
    expect(titles(list)).toEqual(['Alpha', 'Bravo']);
  });
});

describe('carriedRefs (DC-137): keeps the modified date and content status as listed today', () => {
  it('copies them from the listing', () => {
    const prev = { brokenRefs: [{ id: id('m'), title: 'Old', type: 'Web Map', owner: 'u', missing: [id('a')] }], services: [] } as unknown as Data;
    const listed = new Map([[id('m'), { title: 'New', type: 'Web Map', owner: 'u', modified: '2026-02-01T00:00:00.000Z', contentStatus: 'deprecated' }]]);
    expect(carriedRefs(prev, listed, known())).toEqual([{ id: id('m'), title: 'New', type: 'Web Map', owner: 'u', missing: [id('a')], modified: '2026-02-01T00:00:00.000Z', contentStatus: 'deprecated' }]);
  });
});

describe('ownerNamer: one username -> name lookup per owner list (no find per sort comparison)', () => {
  const o = (username: string, fullName: string): Owner => ({ username, fullName, disabled: false, thumbnail: null, lastNotified: null });
  it('gives the full name, or the username when there is none or the owner is not listed', () => {
    const name = ownerNamer([o('ann', 'Ann Lee'), o('bob', '')]);
    expect(name('ann')).toBe('Ann Lee');
    expect(name('bob')).toBe('bob');
    expect(name('zed')).toBe('zed');
  });
  it('is built once per owner list, and does not walk the list per call', () => {
    const owners = Array.from({ length: 4000 }, (_, i) => o(`u${i}`, `User ${i}`));
    const name = ownerNamer(owners);
    expect(ownerNamer(owners)).toBe(name);
    let reads = 0;
    const spy = new Proxy(owners, { get(t, k, r) { if (k === 'find') reads++; return Reflect.get(t, k, r); } });
    const n2 = ownerNamer(spy);
    for (let i = 0; i < 1000; i++) n2(`u${i}`);
    expect(reads).toBe(0);
    expect(n2('u3999')).toBe('User 3999');
  });
  it('sorts the missing-layers table by owner name through it', () => {
    const ref = (id: string, owner: string): BrokenRef => ({ id, title: id, type: 'Web Map', owner, missing: ['x'] });
    const name = ownerNamer([o('zz', 'Aaron'), o('aa', 'Zoe')]);
    expect(sortBrokenRefs([ref('1', 'aa'), ref('2', 'zz')], 'owner', 'asc', name).map((r) => r.owner)).toEqual(['zz', 'aa']);
  });
});
