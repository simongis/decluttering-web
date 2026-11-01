// DC-147: what the item panel's connection diagram draws, from what the scan already holds (no requests). Pure TS: no DOM.
// Columns: the family (source, views) -> Used directly (maps and apps whose /data links a member) -> Through a map (apps whose
// /data references one of those maps by id, and links no member directly). No line skips a column.
import type { Data, Dependency, Family, MapApps } from './types';
import { families } from './stale';

/** Items that hold layers and that apps reference by id: the "maps" of the Through a map hop. */
export const isMapType = (type: string): boolean => type === 'Web Map' || type === 'Web Scene';

export interface ConnectionMember { id: string; title: string; role: 'source' | 'view'; focus: boolean }

export interface DirectUse {
  item: Dependency; kind: 'map' | 'app';
  /** The members it links, in member order. */
  members: string[];
  /** It links the clicked member. */
  focus: boolean;
}

export interface ThroughMapUse {
  item: Dependency;
  /** The Used directly maps it goes through, in their column order. */
  maps: string[];
  /** One of those maps links the clicked member. */
  focus: boolean;
}

export interface Connections {
  members: ConnectionMember[];
  /** Maps first, then apps; each by title. */
  direct: DirectUse[];
  /** By title. Empty when throughMapKnown is false. */
  throughMap: ThroughMapUse[];
  /** False for a scan saved before DC-147 (map references were not recorded). */
  throughMapKnown: boolean;
  focus: string | null;
  counts: { maps: number; apps: number; throughMap: number };
}

const appsMemo = new WeakMap<MapApps, Map<string, Dependency>>();
const appsById = (m: MapApps): Map<string, Dependency> => {
  let x = appsMemo.get(m);
  if (!x) { x = new Map(m.apps.map((a) => [a.id, a])); appsMemo.set(m, x); }
  return x;
};
const byTitle = (a: Dependency, b: Dependency) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** The family's connections, with `focus` (a member id, the clicked layer) marked along its paths. */
export function connectionsOf(data: Data, f: Family, focus?: string): Connections {
  const all = f.views.length ? [f.source, ...f.views] : [f.source];
  const focusId = focus && all.some((m) => m.id === focus) ? focus : null;
  const members: ConnectionMember[] = all.map((m, i) => ({ id: m.id, title: m.title, role: i === 0 ? 'source' : 'view', focus: m.id === focusId }));

  const direct = new Map<string, DirectUse>();
  for (const m of all) for (const d of m.dependencies) {
    let u = direct.get(d.id);
    if (!u) { u = { item: d, kind: isMapType(d.type) ? 'map' : 'app', members: [], focus: false }; direct.set(d.id, u); }
    if (!u.members.includes(m.id)) u.members.push(m.id);
    if (m.id === focusId) u.focus = true;
  }
  const maps = [...direct.values()].filter((u) => u.kind === 'map').sort((a, b) => byTitle(a.item, b.item));
  const apps = [...direct.values()].filter((u) => u.kind === 'app').sort((a, b) => byTitle(a.item, b.item));

  const through = new Map<string, ThroughMapUse>();
  const mapApps = data.mapApps;
  if (mapApps) {
    const info = appsById(mapApps);
    for (const mp of maps) for (const appId of mapApps.byMap[mp.item.id] ?? []) {
      if (direct.has(appId)) continue; // linked directly too: once, under Used directly
      const item = info.get(appId);
      if (!item) continue;
      let t = through.get(appId);
      if (!t) { t = { item, maps: [], focus: false }; through.set(appId, t); }
      if (!t.maps.includes(mp.item.id)) t.maps.push(mp.item.id);
      if (mp.focus) t.focus = true;
    }
  }
  const throughMap = [...through.values()].sort((a, b) => byTitle(a.item, b.item));
  return {
    members, direct: [...maps, ...apps], throughMap, throughMapKnown: !!mapApps, focus: focusId,
    counts: { maps: maps.length, apps: apps.length, throughMap: throughMap.length },
  };
}

/**
 * The family whose source is `sourceId` in this data, or null when it is not there (gone, or the id is a view's). The item
 * panel uses it to follow a refresh: the members and their usage must come from the same data as the scan day.
 */
const familyIndex = new WeakMap<Data, Map<string, Family>>();
export function familyById(data: Data, sourceId: string): Family | null {
  let m = familyIndex.get(data);
  if (!m) { m = new Map(families(data).map((f) => [f.id, f])); familyIndex.set(data, m); }
  return m.get(sourceId) ?? null;
}

/** connectionsOf, kept for the last data and focus asked per family: the panel asks on every render and link drawing. */
const connMemo = new WeakMap<Family, { data: Data; focus: string | undefined; c: Connections }>();
export function connectionsMemo(data: Data, f: Family, focus?: string): Connections {
  const m = connMemo.get(f);
  if (m && m.data === data && m.focus === focus) return m.c;
  const c = connectionsOf(data, f, focus);
  connMemo.set(f, { data, focus, c });
  return c;
}
