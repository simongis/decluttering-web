// Builds the real remover on a signed-in session. The raw sender stays inside this function, so the only way to reach it is
// through the remover (and so through the remover's allow-list).
import { request } from '@esri/arcgis-rest-request';
import type { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import { createItemRemover, DeletingDisabled, type ItemRemover } from './remover';
import type { DeleteScope } from '../auth/deleting';
import type { Sender } from '../scan/request';
import type { RequestFn } from '../scan/types';

export interface SessionRemoverOptions {
  portal: string;
  self: string;
  scope: DeleteScope | undefined;
  /** Injected in tests; defaults to arcgis-rest-js with the session. */
  send?: Sender;
}

export function createSessionRemover(manager: ArcGISIdentityManager | null, opts: SessionRemoverOptions): ItemRemover {
  // Checked before anything else is built, so a user who may not delete never gets a sender either.
  if (opts.scope !== 'all' && opts.scope !== 'own') throw new DeletingDisabled();
  const base = `${opts.portal.replace(/\/+$/, '')}/sharing/rest`;
  const send: Sender | undefined = opts.send ?? (manager
    ? (url, o) => request(url, { authentication: manager, httpMethod: o.method, params: { f: 'json', ...o.params }, signal: o.signal })
    : undefined);
  if (!send) throw new Error('createSessionRemover needs a session or a sender');
  const raw: RequestFn = (path, params = {}, options = {}) =>
    send(`${base}/${path}`, { method: options.method ?? 'GET', params, signal: options.signal });
  return createItemRemover({ request: raw, self: opts.self, scope: opts.scope });
}
