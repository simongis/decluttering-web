// The item panel's lookups that must follow new data (a refresh) and not be redone per chart hover. Test-first.
import { describe, expect, it } from 'vitest';
import type { Data, Dependency, Service } from './types';
import { connectionsMemo, connectionsOf, familyById } from './connections';

let n = 0;
const svc = (o: Partial<Service> = {}): Service => ({
  id: `m${++n}`, title: `Layer ${n}`, owner: 'owner', created: '2020-01-01T00:00:00Z', modified: '2021-01-01T00:00:00Z', sizeMB: 30,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const dep = (id: string, type: string): Dependency => ({ id, title: id, type, owner: 'someone' });
const mk = (services: Service[], scannedAt = '2026-11-01T09:00:00Z'): Data => ({
  org: { id: 'o1', name: 'Org', urlKey: 'org', scannedAt }, owners: [], services,
});

describe('familyById', () => {
  it('finds the family by its source id in the data given (a refresh gives the new members and usage)', () => {
    const src = svc({ usage: [[3, 10]] });
    const view = svc({ isView: true, sourceId: src.id });
    const d1 = mk([src, view]);
    const f1 = familyById(d1, src.id);
    expect(f1?.source).toBe(src);
    expect(f1?.views).toEqual([view]);
    // Five days later: the same layer, usage moved on by five days.
    const src2 = { ...src, usage: [[8, 10]] as [number, number][] };
    const view2 = { ...view };
    const d2 = mk([src2, view2], '2026-11-06T09:00:00Z');
    const f2 = familyById(d2, src.id);
    expect(f2?.source).toBe(src2);
    expect(f2?.views[0]).toBe(view2);
  });

  it('is null when the family is gone from the new data, or the id is a view', () => {
    const src = svc();
    const view = svc({ isView: true, sourceId: src.id });
    expect(familyById(mk([svc()]), src.id)).toBeNull();
    expect(familyById(mk([src, view]), view.id)).toBeNull();
  });
});

describe('connectionsMemo', () => {
  it('is the same answer for the same data, family and focus, and a new one when any changes', () => {
    const src = svc({ dependencies: [dep('mapa', 'Web Map')] });
    const view = svc({ isView: true, sourceId: src.id, dependencies: [dep('dash', 'Dashboard')] });
    const d = mk([src, view]);
    const f = familyById(d, src.id);
    if (!f) throw new Error('no family');
    const a = connectionsMemo(d, f, src.id);
    expect(connectionsMemo(d, f, src.id)).toBe(a);
    expect(a).toEqual(connectionsOf(d, f, src.id));
    const b = connectionsMemo(d, f, view.id);
    expect(b).not.toBe(a);
    expect(b.focus).toBe(view.id);
    const d2 = { ...d };
    expect(connectionsMemo(d2, f, view.id)).not.toBe(b);
  });
});
