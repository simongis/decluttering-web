import { describe, expect, it, vi } from 'vitest';
import { assertRemoveAllowed, BlockedRequest, guardRemoveRequest } from './guard';
import { createItemRemover, DeletingDisabled, type RemoveFamily } from './remover';
import { createSessionRemover } from './session';
import { familiesToRemove, pruneRemoved } from './plan';
import { deleteScope, mayDelete, parseDeletingMode } from '../auth/deleting';
import type { Data, Service } from '../domain/types';
import type { RequestFn } from '../scan/types';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), F = 'f'.repeat(32);

describe('deleting setting (default deny)', () => {
  it('is on only for the exact word', () => {
    expect(parseDeletingMode('on')).toBe('on');
    expect(parseDeletingMode(' on ')).toBe('on');
    for (const v of [undefined, null, '', 'ON', 'true', '1', 'yes', 'off', 'list']) expect(parseDeletingMode(v)).toBe('off');
  });
  it('offers nothing when the build has it off', () => {
    expect(deleteScope(['portal:admin:deleteItems'], 'off')).toBe('none');
    expect(deleteScope(undefined, 'off')).toBe('none');
  });
  it('gives all with the admin privilege, own with the create-items privilege, none otherwise', () => {
    expect(deleteScope(['portal:admin:deleteItems'], 'on')).toBe('all');
    expect(deleteScope(['portal:user:createItem'], 'on')).toBe('own');
    expect(deleteScope(['portal:admin:viewItems'], 'on')).toBe('none');
    expect(deleteScope(undefined, 'on')).toBe('none');
  });
  it('mayDelete follows the scope', () => {
    expect(mayDelete('all', 'me', 'other')).toBe(true);
    expect(mayDelete('own', 'me', 'me')).toBe(true);
    expect(mayDelete('own', 'me', 'other')).toBe(false);
    expect(mayDelete('none', 'me', 'me')).toBe(false);
    expect(mayDelete(undefined, 'me', 'me')).toBe(false);
    expect(mayDelete('own', undefined, 'me')).toBe(false);
  });
});

describe('remove guard', () => {
  const ctx = { self: 'me', scope: 'own' as const };
  it('allows the item read and a delete of the signed-in user\'s own item', () => {
    expect(assertRemoveAllowed(`content/items/${A}`, 'GET', ctx)).toBe('readItem');
    expect(assertRemoveAllowed(`content/users/me/items/${A}/delete`, 'POST', ctx, { f: 'json' })).toBe('deleteItem');
    expect(assertRemoveAllowed(`content/users/me/${F}/items/${A}/delete`, 'POST', ctx)).toBe('deleteItem');
  });
  it('blocks deleting somebody else\'s item unless the scope is all', () => {
    expect(() => assertRemoveAllowed(`content/users/other/items/${A}/delete`, 'POST', ctx)).toThrow(BlockedRequest);
    expect(assertRemoveAllowed(`content/users/other/items/${A}/delete`, 'POST', { self: 'me', scope: 'all' })).toBe('deleteItem');
  });
  it('blocks every delete when the scope is none or missing', () => {
    for (const scope of ['none', null, undefined] as const) {
      expect(() => assertRemoveAllowed(`content/users/me/items/${A}/delete`, 'POST', { self: 'me', scope })).toThrow(BlockedRequest);
    }
  });
  it('blocks permanent deletes and any other parameter', () => {
    expect(() => assertRemoveAllowed(`content/users/me/items/${A}/delete`, 'POST', ctx, { permanentDelete: 'true' })).toThrow(/no parameters/);
    expect(() => assertRemoveAllowed(`content/users/me/items/${A}/delete`, 'POST', ctx, { f: 'json', x: 1 })).toThrow(BlockedRequest);
  });
  it('blocks the wrong method, other endpoints and malformed paths', () => {
    expect(() => assertRemoveAllowed(`content/users/me/items/${A}/delete`, 'GET', ctx)).toThrow(/method/);
    expect(() => assertRemoveAllowed(`content/items/${A}`, 'POST', ctx)).toThrow(/method/);
    for (const p of [
      `content/users/me/items/${A}/update`, `content/users/me/items/${A}/unprotect`, `content/users/me/items/${A}/share`, `content/users/me/items/${A}/move`,
      'community/createGroup', `content/users/me/items/${A}/delete/`, `content/users/../items/${A}/delete`, `content/users/me/items/${A}/delete?x=1`,
      `https://x.example/sharing/rest/content/items/${A}`, `content/users/me/items/zz/delete`, '',
    ]) expect(() => assertRemoveAllowed(p, 'POST', { self: 'me', scope: 'all' }), p).toThrow(BlockedRequest);
  });
  it('guardRemoveRequest never reaches the inner function for a blocked call', async () => {
    const inner = vi.fn(async () => ({}));
    const g = guardRemoveRequest(inner, () => ({ self: 'me', scope: 'own' }));
    await expect(g(`content/users/other/items/${A}/delete`, {}, { method: 'POST' })).rejects.toThrow(BlockedRequest);
    expect(inner).not.toHaveBeenCalled();
    await g(`content/items/${A}`);
    expect(inner).toHaveBeenCalledOnce();
  });
});

interface Fake { type?: string; owner: string; protected?: boolean; ownerFolder?: string | null; gone?: boolean; failDelete?: string; unconfirmed?: boolean }
function world(items: Record<string, Fake>) {
  const calls: string[] = [];
  const request: RequestFn = async (path, _params, options) => {
    calls.push(`${options?.method ?? 'GET'} ${path}`);
    const read = /^content\/items\/([0-9a-f]{32})$/.exec(path);
    if (read) {
      const it = items[read[1]!];
      if (!it || it.gone) throw new Error('Item does not exist or is inaccessible.');
      return { id: read[1], type: it.type ?? 'Feature Service', owner: it.owner, protected: !!it.protected, ownerFolder: it.ownerFolder ?? null };
    }
    const del = /^content\/users\/[^/]+\/(?:[0-9a-f]{32}\/)?items\/([0-9a-f]{32})\/delete$/.exec(path);
    if (del) {
      const it = items[del[1]!]!;
      if (it.failDelete) throw new Error(it.failDelete);
      if (it.unconfirmed) return { success: false };
      it.gone = true;
      return { success: true, itemId: del[1] };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls, items };
}
const fam = (id: string, owner: string, views: [string, string][] = []): RemoveFamily => ({ id, source: { id, owner }, views: views.map(([v, o]) => ({ id: v, owner: o })) });

describe('item remover', () => {
  it('will not exist without a delete scope', () => {
    expect(() => createItemRemover({ request: async () => ({}), self: 'me', scope: 'none' })).toThrow(DeletingDisabled);
    expect(() => createSessionRemover(null, { portal: 'https://x', self: 'me', scope: undefined })).toThrow(DeletingDisabled);
  });
  it('deletes the views first, then the source, and reports every id', async () => {
    const w = world({ [A]: { owner: 'me' }, [B]: { owner: 'me' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const [o] = await r.removeFamilies([fam(A, 'me', [[B, 'me']])]);
    expect(o).toEqual({ id: A, ok: true, removed: [B, A] });
    const deletes = w.calls.filter((c) => c.startsWith('POST'));
    expect(deletes).toEqual([`POST content/users/me/items/${B}/delete`, `POST content/users/me/items/${A}/delete`]);
  });
  it('reads every member before it deletes any', async () => {
    const w = world({ [A]: { owner: 'me' }, [B]: { owner: 'me', protected: true } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const [o] = await r.removeFamilies([fam(A, 'me', [[B, 'me']])]);
    expect(o).toMatchObject({ ok: false, reason: 'protected', removed: [] });
    expect(w.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
  it('leaves an item that is no longer a hosted feature layer or changed owner', async () => {
    const w = world({ [A]: { owner: 'me', type: 'Web Map' }, [B]: { owner: 'someone' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'all' });
    const out = await r.removeFamilies([fam(A, 'me'), fam(B, 'me')]);
    expect(out.map((o) => o.ok === false && o.reason)).toEqual(['changed', 'changed']);
    expect(w.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
  it('refuses a family with an owner the user may not delete, without any request', async () => {
    const w = world({ [A]: { owner: 'me' }, [B]: { owner: 'other' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const [o] = await r.removeFamilies([fam(A, 'me', [[B, 'other']])]);
    expect(o).toMatchObject({ ok: false, reason: 'not-allowed' });
    expect(w.calls).toEqual([]);
  });
  it('admin scope deletes another member\'s layer, inside its folder', async () => {
    const w = world({ [A]: { owner: 'other', ownerFolder: F } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'all' });
    expect((await r.removeFamilies([fam(A, 'other')]))[0]).toMatchObject({ ok: true });
    expect(w.calls).toContain(`POST content/users/other/${F}/items/${A}/delete`);
  });
  it('counts an item that is already gone as removed, without a delete call', async () => {
    const w = world({ [A]: { owner: 'me', gone: true } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    expect((await r.removeFamilies([fam(A, 'me')]))[0]).toEqual({ id: A, ok: true, removed: [A] });
    expect(w.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
  it('reports a failed source and keeps the views that were already deleted', async () => {
    const w = world({ [A]: { owner: 'me', failDelete: 'Cannot delete: in use' }, [B]: { owner: 'me' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const [o] = await r.removeFamilies([fam(A, 'me', [[B, 'me']])]);
    expect(o).toEqual({ id: A, ok: false, reason: 'failed', message: 'Cannot delete: in use', removed: [B] });
  });
  it('does not trust a response without success:true', async () => {
    const w = world({ [A]: { owner: 'me', unconfirmed: true } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    expect((await r.removeFamilies([fam(A, 'me')]))[0]).toMatchObject({ ok: false, reason: 'failed', removed: [] });
  });
  it('one family failing does not stop the next; progress is reported', async () => {
    const w = world({ [A]: { owner: 'me', protected: true }, [C]: { owner: 'me' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const seen: number[] = [];
    const out = await r.removeFamilies([fam(A, 'me'), fam(C, 'me')], { onProgress: (d) => seen.push(d) });
    expect(out.map((o) => o.ok)).toEqual([false, true]);
    expect(seen).toEqual([1, 2]);
  });
  it('stops before the next family when aborted', async () => {
    const w = world({ [A]: { owner: 'me' }, [C]: { owner: 'me' } });
    const r = createItemRemover({ request: w.request, self: 'me', scope: 'own' });
    const ctl = new AbortController();
    const out = await r.removeFamilies([fam(A, 'me'), fam(C, 'me')], { signal: ctl.signal, onProgress: () => ctl.abort() });
    expect(out.map((o) => (o.ok ? 'ok' : o.reason))).toEqual(['ok', 'stopped']);
    expect(w.items[C]!.gone).toBeUndefined();
  });
  it('the session remover sends the delete as a POST with no extra parameters', async () => {
    const send = vi.fn(async (url: string, o: { method: string }) => (o.method === 'GET' ? { type: 'Feature Service', owner: 'me', protected: false } : { success: true }));
    const r = createSessionRemover(null, { portal: 'https://www.arcgis.com/', self: 'me', scope: 'own', send });
    expect((await r.removeFamilies([fam(A, 'me')]))[0]).toMatchObject({ ok: true });
    expect(send).toHaveBeenLastCalledWith(`https://www.arcgis.com/sharing/rest/content/users/me/items/${A}/delete`, { method: 'POST', params: {}, signal: undefined });
  });
});

const svc = (id: string, owner: string, o: Partial<Service> = {}): Service => ({
  id, title: `T${id.slice(0, 1)}`, owner, created: '2020-01-01', modified: '2020-01-01', sizeMB: 10, access: 'private',
  isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const data = (services: Service[]): Data => ({ org: { id: 'o', name: 'O', urlKey: 'o', scannedAt: '2025-01-01' }, owners: [], services });

describe('plan', () => {
  const d = data([svc(A, 'me', { dependencies: [{ id: 'm1', title: 'M', type: 'Web Map', owner: 'me' }] }), svc(B, 'other', { isView: true, sourceId: A }), svc(C, 'me')]);
  it('a chosen layer brings its views and its used-by count', () => {
    const [c] = familiesToRemove(d, [A]);
    expect(c).toMatchObject({ id: A, owner: 'me', sizeMB: 10, usedBy: 1, views: [{ id: B, owner: 'other' }] });
    expect(c!.family).toEqual({ id: A, source: { id: A, owner: 'me' }, views: [{ id: B, owner: 'other' }] });
  });
  it('skips unknown ids, views and duplicates', () => {
    expect(familiesToRemove(d, ['x'.repeat(32), B, C, C]).map((c) => c.id)).toEqual([C]);
  });
  it('prunes deleted services, and returns the same data when none match', () => {
    expect(pruneRemoved(d, [A, B]).services.map((s) => s.id)).toEqual([C]);
    expect(pruneRemoved(d, ['x'])).toBe(d);
    expect(d.services).toHaveLength(3);
  });
});
