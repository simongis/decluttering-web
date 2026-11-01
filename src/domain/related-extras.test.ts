// DC-147d: what ArcGIS Online's relatedItems adds to the item panel's Connections (offline Map Areas, Survey123 forms). Test-first.
import { describe, expect, it } from 'vitest';
import { AREA_TYPES, SURVEY_TYPES, mapsToCheck, parseRelated, relatedExtras, relatedFailure, type RelatedResult } from './related-extras';
import type { Connections } from './connections';
import type { Dependency } from './types';

const dep = (id: string, type: string, title = id, owner = 'someone'): Dependency => ({ id, title, type, owner });
const ok = (...items: Dependency[]): RelatedResult => ({ ok: true, items });

describe('parseRelated', () => {
  it('reads relatedItems rows into items, with modified as ISO and content status kept', () => {
    const body = { total: 2, relatedItems: [
      { id: 'a1', title: 'North depot', type: 'Map Area', owner: 'kim', modified: Date.UTC(2025, 0, 2), contentStatus: 'deprecated' },
      { id: 'f1', title: 'Hydrant survey', type: 'Form', owner: 'lee' },
    ] };
    expect(parseRelated(body)).toEqual([
      { id: 'a1', title: 'North depot', type: 'Map Area', owner: 'kim', modified: '2025-01-02T00:00:00.000Z', contentStatus: 'deprecated' },
      { id: 'f1', title: 'Hydrant survey', type: 'Form', owner: 'lee' },
    ]);
  });

  it('skips rows without an id or type, and copes with no list', () => {
    expect(parseRelated({ relatedItems: [{ title: 'x' }, { id: 'b', type: 'Form' }] })).toEqual([{ id: 'b', title: 'b', type: 'Form', owner: '' }]);
    expect(parseRelated({})).toEqual([]);
    expect(parseRelated(null)).toEqual([]);
  });

  it('a body-level error is not a list: it throws with its code, so the caller can tell "not allowed" from a failure', () => {
    expect(() => parseRelated({ error: { code: 403, message: 'You do not have permissions' } })).toThrowError(expect.objectContaining({ code: 403 }));
  });
});

describe('relatedFailure', () => {
  it('403 and 401, as HTTP status or ArcGIS code, and permission messages are "not available"', () => {
    expect(relatedFailure({ status: 403 })).toBe('denied');
    expect(relatedFailure({ code: 403 })).toBe('denied');
    expect(relatedFailure({ code: 'GWM_0003', message: 'You do not have permissions to access this resource or perform this operation.' })).toBe('denied');
    expect(relatedFailure({ status: 401 })).toBe('denied');
    expect(relatedFailure({ code: 498 })).toBe('denied');
  });
  it('anything else is a failure', () => {
    expect(relatedFailure({ status: 500 })).toBe('failed');
    expect(relatedFailure(new Error('network'))).toBe('failed');
    expect(relatedFailure({ status: 429 })).toBe('failed');
  });
});

describe('the types kept (relationship types reference: Map2Area, Data2Survey, Data2SurveyAddIn)', () => {
  it('Map Area is an offline area; Form and Survey123 Add In are surveys', () => {
    expect([...AREA_TYPES]).toEqual(['Map Area']);
    expect([...SURVEY_TYPES]).toEqual(['Form', 'Survey123 Add In']);
  });
});

const conn = (maps: string[], others: string[] = [], through: string[] = []): Pick<Connections, 'direct' | 'throughMap' | 'members'> => ({
  members: [{ id: 'src', title: 'Source', role: 'source', focus: true }],
  direct: [
    ...maps.map((id) => ({ item: dep(id, id.startsWith('scene') ? 'Web Scene' : 'Web Map'), kind: 'map' as const, members: ['src'], focus: true })),
    ...others.map((id) => ({ item: dep(id, 'Dashboard'), kind: 'app' as const, members: ['src'], focus: true })),
  ],
  throughMap: through.map((id) => ({ item: dep(id, 'Dashboard'), maps: [maps[0] as string], focus: true })),
});

describe('mapsToCheck', () => {
  it('the used-directly maps and scenes, in column order; apps are not asked', () => {
    expect(mapsToCheck(conn(['m1', 'scene1'], ['app1']))).toEqual({ maps: ['m1', 'scene1'], more: 0 });
  });
  it('at most 20 (the cap), and how many more were not checked', () => {
    const ids = Array.from({ length: 23 }, (_, i) => `m${i}`);
    const r = mapsToCheck(conn(ids));
    expect(r.maps).toHaveLength(20);
    expect(r.maps[0]).toBe('m0');
    expect(r.more).toBe(3);
    expect(mapsToCheck(conn(ids), 5)).toEqual({ maps: ids.slice(0, 5), more: 18 });
  });
  it('no maps: nothing to check', () => {
    expect(mapsToCheck(conn([], ['app1']))).toEqual({ maps: [], more: 0 });
  });
});

describe('relatedExtras', () => {
  const area1 = dep('area1', 'Map Area', 'North depot');
  const area2 = dep('area2', 'Map Area', 'East ward');
  const form1 = dep('form1', 'Form', 'Hydrant survey');
  const addin = dep('addin', 'Survey123 Add In', 'Barcode add-in');
  const app = dep('app1', 'Dashboard', 'Ops');

  it('keeps Map Areas and forms only, grouped, each naming the map(s) it came from', () => {
    const results = new Map<string, RelatedResult | undefined>([
      ['m1', ok(area1, app, form1)],
      ['m2', ok(form1, area2, dep('wma', 'Web Mapping Application'))],
    ]);
    const x = relatedExtras(['m1', 'm2'], results, new Set());
    expect(x.areas.map((e) => [e.item.id, e.maps])).toEqual([['area2', ['m2']], ['area1', ['m1']]]); // by title: East ward, North depot
    expect(x.surveys.map((e) => [e.item.id, e.maps])).toEqual([['form1', ['m1', 'm2']]]);
    expect(x).toMatchObject({ checked: 2, pending: 0, denied: 0, failed: 0 });
  });

  it('Survey123 add-ins count as surveys', () => {
    const x = relatedExtras(['m1'], new Map([['m1', ok(addin)]]), new Set());
    expect(x.surveys.map((e) => e.item.id)).toEqual(['addin']);
  });

  it('drops anything already in our connections', () => {
    const x = relatedExtras(['m1'], new Map([['m1', ok(area1, form1)]]), new Set(['form1']));
    expect(x.areas.map((e) => e.item.id)).toEqual(['area1']);
    expect(x.surveys).toEqual([]);
  });

  it('counts maps still loading, not allowed and failed; their extras are simply absent', () => {
    const results = new Map<string, RelatedResult | undefined>([
      ['m1', ok(area1)],
      ['m2', { ok: false, reason: 'denied' }],
      ['m3', { ok: false, reason: 'failed' }],
    ]);
    const x = relatedExtras(['m1', 'm2', 'm3', 'm4'], results, new Set());
    expect(x).toMatchObject({ checked: 1, denied: 1, failed: 1, pending: 1 });
    expect(x.areas.map((e) => e.item.id)).toEqual(['area1']);
  });

  it('maps listed twice are counted once', () => {
    const x = relatedExtras(['m1', 'm1'], new Map([['m1', ok(area1)]]), new Set());
    expect(x.checked).toBe(1);
    expect(x.areas[0]?.maps).toEqual(['m1']);
  });
});
