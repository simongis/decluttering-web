// DC-147: the item panel's connections (Used directly / Through a map). Test-first.
import { describe, expect, it } from 'vitest';
import type { Data, Dependency, Family, MapApps, Service } from './types';
import { families } from './stale';
import { connectionsOf, isMapType } from './connections';

let n = 0;
const svc = (o: Partial<Service> = {}): Service => ({
  id: `s${++n}`, title: `Layer ${n}`, owner: 'owner', created: '2020-01-01T00:00:00Z', modified: '2021-01-01T00:00:00Z', sizeMB: 30,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const dep = (id: string, type: string, title = id): Dependency => ({ id, title, type, owner: 'someone' });
const mk = (services: Service[], mapApps?: MapApps): Data => ({
  org: { id: 'o1', name: 'Org', urlKey: 'org', scannedAt: '2026-11-01T09:00:00Z' },
  owners: [{ username: 'owner', fullName: 'Owner', disabled: false, thumbnail: null, lastNotified: null }],
  services, ...(mapApps ? { mapApps } : {}),
});
const famOf = (d: Data, id: string): Family => families(d).find((f) => f.id === id) as Family;

const mapA = dep('mapa', 'Web Map', 'Alpha map');
const mapB = dep('mapb', 'Web Map', 'Bravo map');
const scene = dep('scene', 'Web Scene', 'Charlie scene');
const dash = dep('dash', 'Dashboard', 'Ops dashboard');
const story = dep('story', 'StoryMap', 'A story');
const form = dep('form', 'Form', 'Field form');

describe('connectionsOf', () => {
  it('knows which item types are maps', () => {
    expect(isMapType('Web Map')).toBe(true);
    expect(isMapType('Web Scene')).toBe(true);
    expect(isMapType('Dashboard')).toBe(false);
  });

  it('members: the source then its views, with the clicked one marked', () => {
    const src = svc({ title: 'Roads' });
    const view = svc({ isView: true, sourceId: src.id, title: 'Roads public' });
    const d = mk([src, view]);
    const c = connectionsOf(d, famOf(d, src.id), view.id);
    expect(c.members).toEqual([
      { id: src.id, title: 'Roads', role: 'source', focus: false },
      { id: view.id, title: 'Roads public', role: 'view', focus: true },
    ]);
    expect(c.direct).toEqual([]);
    expect(c.throughMap).toEqual([]);
    expect(c.throughMapKnown).toBe(false);
  });

  it('Used directly: maps first, then apps, each once with the members it links; a map used by two members', () => {
    const src = svc({ dependencies: [mapB, form, mapA] });
    const view = svc({ isView: true, sourceId: src.id, dependencies: [mapA, dash] });
    const d = mk([src, view], { byMap: {}, apps: [] });
    const c = connectionsOf(d, famOf(d, src.id), src.id);
    expect(c.direct.map((x) => [x.item.id, x.kind, x.members])).toEqual([
      ['mapa', 'map', [src.id, view.id]],
      ['mapb', 'map', [src.id]],
      ['form', 'app', [src.id]],
      ['dash', 'app', [view.id]],
    ]);
    expect(c.direct.map((x) => x.focus)).toEqual([true, true, true, false]);
    expect(c.counts).toEqual({ maps: 2, apps: 2, throughMap: 0 });
  });

  it('Through a map: apps reaching a member only through a linked map, with the maps they go through', () => {
    const src = svc({ dependencies: [mapA, scene] });
    const view = svc({ isView: true, sourceId: src.id, dependencies: [mapB] });
    const other = dep('other', 'Web Mapping Application', 'Unrelated app');
    const d = mk([src, view], {
      byMap: { mapa: ['story', 'dash'], mapb: ['dash'], scene: ['story'], elsewhere: ['other'] },
      apps: [story, dash, other],
    });
    const c = connectionsOf(d, famOf(d, src.id), view.id);
    expect(c.throughMapKnown).toBe(true);
    expect(c.throughMap.map((x) => [x.item.id, x.maps])).toEqual([
      ['story', ['mapa', 'scene']],
      ['dash', ['mapa', 'mapb']],
    ]);
    expect(c.throughMap.map((x) => x.focus)).toEqual([false, true]);
    expect(c.counts).toEqual({ maps: 3, apps: 0, throughMap: 2 });
  });

  it('an app that links a member directly and through a map counts once, under Used directly', () => {
    const src = svc({ dependencies: [mapA, dash] });
    const d = mk([src], { byMap: { mapa: ['dash', 'story'] }, apps: [dash, story] });
    const c = connectionsOf(d, famOf(d, src.id));
    expect(c.direct.map((x) => x.item.id)).toEqual(['mapa', 'dash']);
    expect(c.throughMap.map((x) => x.item.id)).toEqual(['story']);
    expect(c.focus).toBeNull();
  });

  it('an app never goes through an app: only maps lead to the Through a map column', () => {
    const src = svc({ dependencies: [dash] });
    // a (bad) entry keyed by an app id is ignored
    const d = mk([src], { byMap: { dash: ['story'] }, apps: [story] });
    expect(connectionsOf(d, famOf(d, src.id)).throughMap).toEqual([]);
  });
});
