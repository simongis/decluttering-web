// DC-035a: maps and apps that point at hosted layers that are no longer in the org. Pure; read-only; no requests.
//
// It works only from what the scan already has: each map's or app's /data text, and the item ids and service names of the
// hosted feature services the search found. It never calls a referenced service url. Be strict: when in doubt, leave it out.
//
// A reference counts as missing only when ALL of these hold:
//  1. It is a layer object in the map's JSON whose `url` is on THIS org's hosted-services host
//     (https://services*.arcgis.com/<this org id>/arcgis/rest/services/<name>/FeatureServer). Anything else (other orgs,
//     public Esri content, ArcGIS Server, basemaps, tile and image layers, vector tiles) is never reported.
//  2. Neither its item id nor its service name matches a hosted feature service the search found. Views are in that
//     search, so a layer that points at a view is found. A layer that was re-created under the same name is found.
//  3. An item id is only used when it is a well-formed 32-hex id; otherwise the service name stands alone.
//  4. Maps and apps were all read (the caller passes depsComplete), and the search covered every hosted feature service
//     (the result set was not cut at the search cap), otherwise nothing is reported.
//  5. It is shown only to an admin. An admin's search sees other owners' private items; a member's search does not, so for
//     a member a private layer of someone else would look gone. The Review section says it compares with the org's layers.
// A layer that only carries an item id (no url) is never reported: it could be any item type the search does not list.

import type { AccessMode } from '../auth/access';
import type { BrokenRef, Data, Owner } from './types';

const HEX32 = /^[0-9a-f]{32}$/;

/** Item id or service name lookups over what the search found (lowercase names). */
export interface Known { hasId(id: string): boolean; hasName(name: string): boolean }

const hostedRe = (orgId: string): RegExp => {
  const esc = orgId.toLowerCase().replace(/[^0-9a-z]/g, '');
  return new RegExp(`^https?://services[0-9a-z-]*\\.arcgis\\.com/${esc}/arcgis/rest/services/([^/?#]+)/featureserver(?:[/?#]|$)`);
};

/**
 * The missing references in one map's or app's /data text: ids (32-hex), or `name:<service>` for a url with no usable id.
 * Invalid JSON, or text that does not mention this org, gives none.
 */
export function missingRefs(text: string, orgId: string, known: Known): string[] {
  const org = orgId.toLowerCase();
  if (!org || !text.toLowerCase().includes(org)) return [];
  let root: unknown;
  try { root = JSON.parse(text); } catch { return []; }
  const re = hostedRe(org);
  const out = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) { const x = o[k]; if (x && typeof x === 'object') stack.push(x); }
    if (typeof o.url !== 'string') continue;
    const m = re.exec(o.url.trim().toLowerCase());
    if (!m) continue;
    const name = decodeURIComponent(m[1] as string).toLowerCase();
    const raw = typeof o.itemId === 'string' ? o.itemId : typeof o.itemid === 'string' ? o.itemid : '';
    const id = HEX32.test(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : '';
    if ((id && known.hasId(id)) || known.hasName(name)) continue;
    out.add(id || `name:${name}`);
  }
  return [...out].sort();
}

/** A map or app as listed by today's search (DC-137 adds its modified date and content status). */
type Listed = Pick<BrokenRef, 'title' | 'type' | 'owner' | 'modified' | 'contentStatus'>;

const stillMissing = (k: string, known: Known): boolean => (k.startsWith('name:') ? !known.hasName(k.slice(5)) : !known.hasId(k));

/**
 * For maps and apps that were NOT read this time (unchanged since the last read): what the last scan found, checked again
 * against today's layers, plus layers that map used to link to that have since gone. `reused` is those maps as listed today.
 */
export function carriedRefs(prev: Data | undefined, reused: ReadonlyMap<string, Listed>, known: Known): BrokenRef[] {
  if (!prev || !reused.size) return [];
  const gone = new Map<string, Set<string>>();
  for (const s of prev.services) {
    if (known.hasId(s.id)) continue;
    for (const d of s.dependencies) if (reused.has(d.id)) gone.set(d.id, (gone.get(d.id) ?? new Set()).add(s.id));
  }
  const missing = new Map<string, Set<string>>();
  for (const b of prev.brokenRefs ?? []) {
    if (!reused.has(b.id)) continue;
    for (const k of b.missing) if (stillMissing(k, known)) missing.set(b.id, (missing.get(b.id) ?? new Set()).add(k));
  }
  for (const [id, ks] of gone) for (const k of ks) missing.set(id, (missing.get(id) ?? new Set()).add(k));
  return [...missing].map(([id, ks]) => {
    const r = reused.get(id) as Listed;
    return { id, title: r.title, type: r.type, owner: r.owner, missing: [...ks].sort(), ...(r.modified ? { modified: r.modified } : {}), ...(r.contentStatus ? { contentStatus: r.contentStatus } : {}) };
  });
}

/**
 * What Review may show: nothing unless maps and apps were all read and the viewer is an admin (rule 4 and 5 above).
 * Entries are checked once more against the layers in `data`, and sorted by owner then title.
 */
export function visibleBrokenRefs(data: Data, o: { depsComplete: boolean; mode: AccessMode }): BrokenRef[] {
  if (!o.depsComplete || o.mode === 'my-items' || !data.brokenRefs?.length) return [];
  const ids = new Set(data.services.map((s) => s.id));
  return data.brokenRefs
    .map((b) => ({ ...b, missing: b.missing.filter((k) => k.startsWith('name:') || !ids.has(k)) }))
    .filter((b) => b.missing.length > 0)
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.title.localeCompare(b.title));
}

/** DC-137: Status column order: deprecated, then authoritative (org or public), then none. */
const statusRank = (s: string | undefined): number => (s === 'deprecated' ? 2 : s === 'org_authoritative' || s === 'public_authoritative' ? 1 : 0);

/** DC-137: the columns the missing-layers table can sort by ('deprecated' is the Status column). */
export type BrokenSortKey = 'title' | 'owner' | 'missing' | 'modified' | 'deprecated';
export type SortDir = 'asc' | 'desc';

/**
 * DC-137: a sorted copy for the missing-layers table (default: most missing layers first). Ties go by title, then id, so the
 * order is stable. A map with no known modified date (a scan saved before DC-137) goes last in either direction.
 */
export function sortBrokenRefs(refs: readonly BrokenRef[], key: BrokenSortKey, dir: SortDir, ownerName: (u: string) => string = (u) => u): BrokenRef[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byTitle = (a: BrokenRef, b: BrokenRef) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const primary = (a: BrokenRef, b: BrokenRef): number => {
    switch (key) {
      case 'missing': return sign * (a.missing.length - b.missing.length);
      case 'modified':
        if (!a.modified || !b.modified) return Number(!a.modified) - Number(!b.modified);
        return sign * a.modified.localeCompare(b.modified);
      case 'owner': return sign * ownerName(a.owner).localeCompare(ownerName(b.owner));
      case 'deprecated': return sign * (statusRank(a.contentStatus) - statusRank(b.contentStatus));
      case 'title': return sign * byTitle(a, b);
    }
  };
  return [...refs].sort((a, b) => primary(a, b) || byTitle(a, b));
}

const namers = new WeakMap<readonly Owner[], (u: string) => string>();
/** Username -> full name (or the username when there is none), built once per owner list: a big org has thousands of owners. */
export function ownerNamer(owners: readonly Owner[]): (u: string) => string {
  let f = namers.get(owners);
  if (!f) {
    const m = new Map<string, string>();
    for (const o of owners) if (!m.has(o.username)) m.set(o.username, o.fullName);
    f = (u: string) => m.get(u) || u;
    namers.set(owners, f);
  }
  return f;
}
