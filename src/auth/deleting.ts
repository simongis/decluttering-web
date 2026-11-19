// ADR 0016: who may delete layers from Review. Default deny, like sending (ADR 0013). `VITE_DELETING=on` is the one build
// setting that turns the feature on; unset, empty or anything else means the app never offers or sends a delete.
import { DELETING_RAW } from './config';

export type DeletingMode = 'off' | 'on';

/** The exact word `on` (surrounding spaces ignored). Everything else is `off`. */
export function parseDeletingMode(v: unknown): DeletingMode {
  return typeof v === 'string' && v.trim() === 'on' ? 'on' : 'off';
}

/** This build's mode, fixed at build time. */
export const DELETING_MODE: DeletingMode = parseDeletingMode(DELETING_RAW);

/** Esri's privilege for deleting content in the organization, whoever owns it. */
export const DELETE_OTHERS_PRIVILEGE = 'portal:admin:deleteItems';
/** Esri's privilege to create, edit and delete your own content. */
export const DELETE_OWN_PRIVILEGE = 'portal:user:createItem';

/**
 * What the signed-in user may delete: `all` (any member's layers, needs the admin delete privilege), `own` (only their own
 * layers) or `none` (this build has deleting off, or the account has neither privilege). The server still decides; this only decides what the app offers.
 */
export type DeleteScope = 'all' | 'own' | 'none';

export function deleteScope(privileges: readonly string[] | undefined, mode: DeletingMode = DELETING_MODE): DeleteScope {
  if (mode !== 'on') return 'none';
  const have = privileges ?? [];
  if (have.includes(DELETE_OTHERS_PRIVILEGE)) return 'all';
  return have.includes(DELETE_OWN_PRIVILEGE) ? 'own' : 'none';
}

/** True when the user may delete a layer owned by `owner`. */
export function mayDelete(scope: DeleteScope | undefined, self: string | undefined, owner: string): boolean {
  if (scope === 'all') return true;
  return scope === 'own' && !!self && self === owner;
}
