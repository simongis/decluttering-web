// ADR 0016: the delete selection on Review, as pure functions (dc-review holds the state). Ids are source layer ids.

export interface Sized { sizeMB: number | null }

/** What a rectangle on the chart did: the layers it took, those it left out because the user can't delete them. */
export interface RectResult {
  next: Set<string>;
  /** Distinct layers whose dots were inside the rectangle. */
  inRect: number;
  /** Newly added to the selection (already selected ones are not counted again). */
  added: number;
  /** Inside the rectangle, but this user may not delete them, so left out. */
  dropped: number;
}

/** Adds the deletable ids to the selection. Never removes anything. */
export function addPicked(sel: ReadonlySet<string>, ids: readonly string[], deletable: { has(id: string): boolean }): RectResult {
  const next = new Set(sel);
  const seen = new Set<string>();
  let added = 0, dropped = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!deletable.has(id)) { dropped++; continue; }
    if (!next.has(id)) { next.add(id); added++; }
  }
  return { next, inRect: seen.size, added, dropped };
}

/** One layer in or out. Adding is refused (the same set back) when the user may not delete it. */
export function togglePicked(sel: ReadonlySet<string>, id: string, on: boolean, deletable: { has(id: string): boolean }): ReadonlySet<string> {
  if (on === sel.has(id)) return sel;
  if (on && !deletable.has(id)) return sel;
  const next = new Set(sel);
  if (on) next.add(id); else next.delete(id);
  return next;
}

/**
 * What is chosen right now: only ids the user may still delete (a layer that left the data, or whose owner the user can't
 * delete for, drops out), their known storage (null when none is measured), and how many are not on the list.
 */
export function chosenOf(sel: ReadonlySet<string>, deletable: ReadonlyMap<string, Sized>, onList?: ReadonlySet<string>): { ids: string[]; sizeMB: number | null; off: number } {
  const ids = [...sel].filter((id) => deletable.has(id));
  const known = ids.map((id) => deletable.get(id)?.sizeMB).filter((v): v is number => typeof v === 'number');
  return {
    ids,
    sizeMB: known.length ? known.reduce((s, v) => s + v, 0) : null,
    off: onList ? ids.filter((id) => !onList.has(id)).length : 0,
  };
}

/** The selection without ids that are no longer in the data. The same set back when nothing went. */
export function keepPresent(sel: ReadonlySet<string>, present: { has(id: string): boolean }): ReadonlySet<string> {
  if (![...sel].some((id) => !present.has(id))) return sel;
  return new Set([...sel].filter((id) => present.has(id)));
}

/** ADR 0016: what the delete bar shows. `off`: the build has deleting off, no bar. */
export type DeleteStatus = 'off' | 'no-privilege' | 'waiting' | 'stopped' | 'ready';

/** The status from the facts: the build setting, whether a remover exists for this user, and the scan's state. */
export function deleteStatusOf(f: { buildOn: boolean; mayDelete: boolean; stopped: boolean; depsKnown: boolean; refreshing: boolean }): DeleteStatus {
  if (!f.buildOn && !f.mayDelete) return 'off';
  if (!f.mayDelete) return 'no-privilege';
  if (f.stopped) return 'stopped';
  if (!f.depsKnown || f.refreshing) return 'waiting';
  return 'ready';
}

/** The message that says why nothing can be selected yet; null when ready (or off). */
export function waitReason(st: DeleteStatus): 'review.delete.noPrivilege' | 'review.delete.waitingStopped' | 'review.delete.waiting' | null {
  return st === 'no-privilege' ? 'review.delete.noPrivilege' : st === 'stopped' ? 'review.delete.waitingStopped' : st === 'waiting' ? 'review.delete.waiting' : null;
}
