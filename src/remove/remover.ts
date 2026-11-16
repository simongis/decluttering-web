// Deletes hosted feature layers the user chose on Review (ADR 0016). One family at a time: the views first, then the source.
// Each member is read from ArcGIS Online just before anything is deleted, and the family is only touched if every member
// is still a hosted feature layer, still owned by who the scan said, and not protected. The only calls it can make are on
// the remover's allow-list (./guard); a delete is never permanent.
import { assertRemoveAllowed, guardRemoveRequest, type RemoveGuardContext } from './guard';
import type { DeleteScope } from '../auth/deleting';
import type { RequestFn } from '../scan/types';

export interface RemoveItemRef { id: string; owner: string }
/** One thing the user chose: the source layer and its hosted views (they share the source's storage and break without it). */
export interface RemoveFamily { id: string; source: RemoveItemRef; views: RemoveItemRef[] }

/** Why a family was left alone (or only partly deleted). */
export type RemoveFailure =
  | 'not-allowed'   // the user may not delete one of its owners' items
  | 'protected'     // an item is marked "delete protection"; the owner has to turn it off
  | 'changed'       // an item is no longer a hosted feature layer, or has a different owner than the scan saw
  | 'stopped'       // the user stopped the run before this family
  | 'failed';       // ArcGIS Online refused, or the network failed

export type RemoveOutcome =
  | { id: string; ok: true; /** Ids deleted now, or found already gone. */ removed: string[] }
  | { id: string; ok: false; reason: RemoveFailure; message?: string; /** Ids that were deleted before the failure (views of a family whose source then failed). */ removed: string[] };

export interface ItemRemover {
  /** Deletes the families in order. Never throws for one family's failure; it is reported in its outcome. */
  removeFamilies(families: readonly RemoveFamily[], o?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<RemoveOutcome[]>;
}

export interface RemoverOptions {
  /** The raw (unguarded) request function; the remover guards it itself. */
  request: RequestFn;
  self: string;
  scope: DeleteScope;
}

interface ItemInfo { id?: string; owner?: string; type?: string; protected?: boolean; ownerFolder?: string | null }

const GONE = /does not exist|not found/i;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class DeletingDisabled extends Error {
  constructor() { super('Deleting is not available for this user.'); this.name = 'DeletingDisabled'; }
}

export function createItemRemover(opts: RemoverOptions): ItemRemover {
  const { self, scope } = opts;
  if (scope !== 'all' && scope !== 'own') throw new DeletingDisabled();
  const ctx = (): RemoveGuardContext => ({ self, scope });
  const call = guardRemoveRequest(opts.request, ctx);

  /** null: the item is already gone. */
  async function read(ref: RemoveItemRef, signal?: AbortSignal): Promise<ItemInfo | null> {
    try {
      return (await call(`content/items/${ref.id}`, {}, { method: 'GET', signal })) as ItemInfo;
    } catch (e) {
      if (GONE.test(errText(e))) return null;
      throw e;
    }
  }

  async function removeFamily(f: RemoveFamily, signal?: AbortSignal): Promise<RemoveOutcome> {
    const members = [...f.views, f.source]; // views first: the source can't go while they use it
    const removed: string[] = [];
    // Refuse early, before reading or changing anything, when the user may not delete one of them.
    try { for (const m of members) assertRemoveAllowed(`content/users/${m.owner}/items/${m.id}/delete`, 'POST', ctx(), { f: 'json' }); }
    catch (e) { return { id: f.id, ok: false, reason: 'not-allowed', message: errText(e), removed }; }
    const infos = new Map<string, ItemInfo>();
    try {
      for (const m of members) {
        const info = await read(m, signal);
        if (!info) { removed.push(m.id); continue; } // already gone
        if (info.protected) return { id: f.id, ok: false, reason: 'protected', removed: [] };
        if (info.type !== 'Feature Service' || (info.owner ?? '').toLowerCase() !== m.owner.toLowerCase()) {
          return { id: f.id, ok: false, reason: 'changed', removed: [] };
        }
        infos.set(m.id, info);
      }
    } catch (e) { return { id: f.id, ok: false, reason: 'failed', message: errText(e), removed: [] }; }
    for (const m of members) {
      const info = infos.get(m.id);
      if (!info) continue;
      if (signal?.aborted) return { id: f.id, ok: false, reason: 'stopped', removed };
      const folder = info.ownerFolder ? `${info.ownerFolder}/` : '';
      try {
        const res = await call(`content/users/${m.owner}/${folder}items/${m.id}/delete`, {}, { method: 'POST', signal }) as { success?: boolean };
        if (res?.success !== true) return { id: f.id, ok: false, reason: 'failed', message: 'ArcGIS Online did not confirm the delete.', removed };
        removed.push(m.id);
      } catch (e) {
        if (GONE.test(errText(e))) { removed.push(m.id); continue; }
        return { id: f.id, ok: false, reason: 'failed', message: errText(e), removed };
      }
    }
    return { id: f.id, ok: true, removed };
  }

  return {
    async removeFamilies(families, o = {}) {
      const out: RemoveOutcome[] = [];
      for (const f of families) {
        if (o.signal?.aborted) out.push({ id: f.id, ok: false, reason: 'stopped', removed: [] });
        else out.push(await removeFamily(f, o.signal));
        o.onProgress?.(out.length, families.length);
      }
      return out;
    },
  };
}
