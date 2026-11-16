// Pure helpers for deleting from Review: what a chosen layer means (its views go too), and the scan data once they are gone.
import type { Data, Service } from '../domain/types';
import type { RemoveFamily } from './remover';

/** One chosen layer, as the confirm dialog shows it. */
export interface RemovalCandidate {
  id: string;
  title: string;
  owner: string;
  /** Source plus views. The views share the source's storage, so the size is the source's. */
  sizeMB: number | null;
  /** Maps and apps that use the source, directly. They will show a broken layer after the delete. */
  usedBy: number;
  views: { id: string; title: string; owner: string }[];
  family: RemoveFamily;
}

/** Candidates for the given source layer ids. Ids the data does not hold, or that are views, are skipped. */
export function familiesToRemove(data: Data, sourceIds: readonly string[]): RemovalCandidate[] {
  const byId = new Map<string, Service>(data.services.map((s) => [s.id, s]));
  const viewsOf = new Map<string, Service[]>();
  for (const s of data.services) if (s.isView && s.sourceId) (viewsOf.get(s.sourceId) ?? viewsOf.set(s.sourceId, []).get(s.sourceId)!).push(s);
  const out: RemovalCandidate[] = [];
  for (const id of new Set(sourceIds)) {
    const s = byId.get(id);
    if (!s || s.isView) continue;
    const views = viewsOf.get(id) ?? [];
    out.push({
      id, title: s.title, owner: s.owner, sizeMB: s.sizeMB, usedBy: s.dependencies.length,
      views: views.map((v) => ({ id: v.id, title: v.title, owner: v.owner })),
      family: { id, source: { id, owner: s.owner }, views: views.map((v) => ({ id: v.id, owner: v.owner })) },
    });
  }
  return out;
}

/** The data without the deleted services. The same object comes back when none of them is in it. */
export function pruneRemoved(data: Data, removedIds: ReadonlySet<string> | readonly string[]): Data {
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds);
  if (!gone.size || !data.services.some((s) => gone.has(s.id))) return data;
  return { ...data, services: data.services.filter((s) => !gone.has(s.id)) };
}
