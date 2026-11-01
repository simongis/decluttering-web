// DC-147d: what ArcGIS Online's own item relationships add to the item panel's Connections. Pure TS: no DOM, no requests.
// Our /data scan stays the base (docs/research/item-dependencies-agol.md 7); `relatedItems` forward from the family's
// used-directly maps adds what only relationships record: offline Map Areas (Map2Area) and Survey123 forms and add-ins
// (Data2Survey, Data2SurveyAddIn), per https://developers.arcgis.com/rest/users-groups-and-items/relationship-types/.
// These are display only: they never feed "used by" or the stale rule, so a layer never looks used because of them.
import { isMapType, type Connections } from './connections';
import type { Dependency } from './types';

/** Destination types of Map2Area. */
export const AREA_TYPES: ReadonlySet<string> = new Set(['Map Area']);
/** Destination types of Data2Survey and Data2SurveyAddIn. */
export const SURVEY_TYPES: ReadonlySet<string> = new Set(['Form', 'Survey123 Add In']);

/** Most maps asked per family; the rest are "not checked". */
export const MAP_CAP = 20;

export type RelatedResult = { ok: true; items: Dependency[] } | { ok: false; reason: 'denied' | 'failed' };

export interface Extra {
  item: Dependency;
  /** The map ids it came from, in the order the maps were asked. */
  maps: string[];
}

export interface RelatedExtras {
  /** Offline map areas, by title. */
  areas: Extra[];
  /** Survey123 forms and add-ins, by title. */
  surveys: Extra[];
  /** Maps answered, still waiting, not allowed (only the owner or an admin may ask), failed. */
  checked: number; pending: number; denied: number; failed: number;
}

type Json = Record<string, unknown>;

/** The rows of a relatedItems answer. A body-level `error` throws with its code (the request layer may pass it through). */
export function parseRelated(body: unknown): Dependency[] {
  const b = (body ?? {}) as Json;
  const err = b.error as { code?: unknown; message?: unknown } | undefined;
  if (err && typeof err === 'object') throw Object.assign(new Error(String(err.message ?? 'relatedItems error')), { code: err.code });
  const rows = Array.isArray(b.relatedItems) ? (b.relatedItems as Json[]) : [];
  const out: Dependency[] = [];
  for (const r of rows) {
    if (typeof r?.id !== 'string' || typeof r.type !== 'string') continue;
    const d: Dependency = { id: r.id, title: typeof r.title === 'string' && r.title ? r.title : r.id, type: r.type, owner: typeof r.owner === 'string' ? r.owner : '' };
    if (typeof r.modified === 'number') d.modified = new Date(r.modified).toISOString();
    if (typeof r.contentStatus === 'string' && r.contentStatus) d.contentStatus = r.contentStatus;
    out.push(d);
  }
  return out;
}

/** Why a call failed: "denied" (not the owner and not an admin, or signed out) is final; anything else is a failure. */
export function relatedFailure(e: unknown): 'denied' | 'failed' {
  const x = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
  if ([401, 403, 498, 499].includes(n(x.status)) || [401, 403, 498, 499].includes(n(x.code))) return 'denied';
  if (typeof x.message === 'string' && /permission|not authori[sz]ed|access denied/i.test(x.message)) return 'denied';
  return 'failed';
}

/** The maps to ask: the family's used-directly maps and scenes, in column order, at most `cap`. */
export function mapsToCheck(c: Pick<Connections, 'direct'>, cap = MAP_CAP): { maps: string[]; more: number } {
  const all = c.direct.filter((u) => u.kind === 'map' || isMapType(u.item.type)).map((u) => u.item.id);
  return { maps: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

const byTitle = (a: Extra, b: Extra) => a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id);

/** The extras for `maps`, from what has been answered so far; `known` holds every id our own connections already show. */
export function relatedExtras(maps: readonly string[], results: ReadonlyMap<string, RelatedResult | undefined>, known: ReadonlySet<string>): RelatedExtras {
  const found = new Map<string, Extra>();
  let checked = 0, pending = 0, denied = 0, failed = 0;
  for (const m of new Set(maps)) {
    const r = results.get(m);
    if (!r) { pending++; continue; }
    if (!r.ok) { if (r.reason === 'denied') denied++; else failed++; continue; }
    checked++;
    for (const it of r.items) {
      if (known.has(it.id) || !(AREA_TYPES.has(it.type) || SURVEY_TYPES.has(it.type))) continue;
      const e = found.get(it.id);
      if (e) { if (!e.maps.includes(m)) e.maps.push(m); } else found.set(it.id, { item: it, maps: [m] });
    }
  }
  const all = [...found.values()];
  return {
    areas: all.filter((e) => AREA_TYPES.has(e.item.type)).sort(byTitle),
    surveys: all.filter((e) => SURVEY_TYPES.has(e.item.type)).sort(byTitle),
    checked, pending, denied, failed,
  };
}
