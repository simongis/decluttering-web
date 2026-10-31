// DC-071a: hybrid sizing (owner content listings where they pay off, one call per item otherwise).
import { describe, expect, it } from 'vitest';
import { guardRequest } from './guard';
import { MIN_LIST, measureHybrid, planSizing, sizeInfoOf, type SizeTarget } from './sizing';
import type { RequestFn, SizeInfo } from './types';

const MB = 1048576;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const F1 = hex(0xf1), F2 = hex(0xf2), F3 = hex(0xf3), F4 = hex(0xf4), F5 = hex(0xf5);

interface Svc { id: string; owner: string; folder: string | null; size: number }
/** A small org: services by owner and folder; each listing also holds `extra` non-service items per folder. */
function org(svcs: Svc[], o: { folders?: Record<string, string[]>; extra?: number; deny?: string[]; listedSize?: number } = {}) {
  const calls: string[] = [];
  const row = (s: Svc) => ({ id: s.id, owner: s.owner, type: 'Feature Service', typeKeywords: ['Hosted Service'], size: o.listedSize ?? s.size, description: `About ${s.id.slice(-2)}`, tags: ['t'] });
  const request: RequestFn = async (path, params = {}) => {
    calls.push(path);
    await new Promise((r) => setTimeout(r, 0));
    let m = /^content\/users\/([^/]+)(?:\/([0-9a-f]{32}))?$/.exec(path);
    if (m) {
      const [, owner, folder = null] = m;
      if (o.deny?.includes(owner as string)) throw Object.assign(new Error('You do not have permissions'), { status: 403 });
      const mine = svcs.filter((s) => s.owner === owner && s.folder === folder).map(row);
      const others = Array.from({ length: o.extra ?? 0 }, (_, k) => ({ id: hex(0xe0000 + k), type: 'Web Map', typeKeywords: [], size: 100 }));
      const all = [...others, ...mine];
      const start = Number(params.start) || 1, num = Number(params.num) || 10;
      const page = all.slice(start - 1, start - 1 + num);
      return { total: all.length, start, num: page.length, nextStart: start - 1 + num < all.length ? start + num : -1, items: page,
        ...(folder ? {} : { folders: (o.folders?.[owner as string] ?? []).map((id) => ({ id, title: 'f' })) }) };
    }
    m = /^content\/items\/([0-9a-f]{32})$/.exec(path);
    if (m) { const s = svcs.find((x) => x.id === m![1]); if (!s) throw Object.assign(new Error('gone'), { status: 400 }); return { ...row(s), size: s.size }; }
    throw new Error(`unexpected ${path}`);
  };
  return { request: guardRequest(request), calls };
}
const svc = (k: number, owner: string, folder: string | null = null): Svc => ({ id: hex(0x100 + k), owner, folder, size: (k + 1) * MB });
const targets = (svcs: Svc[], withFolder = false): SizeTarget[] => svcs.map((s) => ({ id: s.id, owner: s.owner, ...(withFolder ? { folder: s.folder } : {}) }));
async function run(svcs: Svc[], f: ReturnType<typeof org>, t = targets(svcs), width?: number) {
  const sizes = new Map<string, SizeInfo>();
  const failed: string[] = [];
  const plans: number[] = [];
  await measureHybrid(t, { call: f.request, width, onSize: (id, z) => sizes.set(id, z), onFail: (id) => failed.push(id), onPlan: (n) => plans.push(n) });
  return { sizes, failed, plans };
}
const items = (calls: string[]) => calls.filter((c) => c.startsWith('content/items/'));
const lists = (calls: string[]) => calls.filter((c) => c.startsWith('content/users/'));

describe('planSizing', () => {
  it('one listing job per owner with at least MIN_LIST services, at their first service; items for the rest, in order', () => {
    expect(MIN_LIST).toBe(2);
    const jobs = planSizing([
      { id: 'a', owner: 'solo' }, { id: 'b', owner: 'amy' }, { id: 'c', owner: 'bob' }, { id: 'd', owner: 'amy' }, { id: 'e', owner: 'bad name' }, { id: 'f', owner: 'bad name' },
    ]);
    expect(jobs).toEqual([
      { kind: 'item', id: 'a' }, { kind: 'owner', owner: 'amy', ids: ['b', 'd'] }, { kind: 'item', id: 'c' },
      { kind: 'item', id: 'e' }, { kind: 'item', id: 'f' }, // a username the guard would refuse is never listed
    ]);
  });
});

describe('measureHybrid', () => {
  it('an owner with everything in the root: one listing, no per-item calls, real sizes and metadata', async () => {
    const svcs = [0, 1, 2, 3, 4].map((k) => svc(k, 'amy'));
    const f = org(svcs);
    const r = await run(svcs, f);
    expect(f.calls).toEqual(['content/users/amy']);
    expect(r.sizes.get(svcs[2]!.id)).toEqual({ sizeMB: 3, attachmentMB: 0, description: 'About 02', tags: ['t'] });
    expect(r.sizes.size).toBe(5);
    expect(r.plans.at(-1)).toBe(0);
  });

  it('lists folders when more services are left than there are folders', async () => {
    const svcs = [svc(0, 'amy'), svc(1, 'amy'), svc(2, 'amy', F1), svc(3, 'amy', F1), svc(4, 'amy', F2), svc(5, 'amy', F2)];
    const f = org(svcs, { folders: { amy: [F1, F2] } });
    const r = await run(svcs, f);
    expect(lists(f.calls).sort()).toEqual(['content/users/amy', `content/users/amy/${F1}`, `content/users/amy/${F2}`]);
    expect(items(f.calls)).toEqual([]);
    expect(r.sizes.size).toBe(6);
  });

  it('measures item by item when fewer are left than there are folders', async () => {
    const svcs = [svc(0, 'amy'), svc(1, 'amy', F1), svc(2, 'amy', F3)];
    const f = org(svcs, { folders: { amy: [F1, F2, F3, F4, F5] } });
    const r = await run(svcs, f);
    expect(lists(f.calls)).toEqual(['content/users/amy']);
    expect(items(f.calls).sort()).toEqual([svcs[1]!.id, svcs[2]!.id].map((id) => `content/items/${id}`).sort());
    expect(r.sizes.size).toBe(3);
  });

  it('when the search says where each one lives, lists only folders holding at least two of them', async () => {
    const svcs = [svc(0, 'amy', F1), svc(1, 'amy', F1), svc(2, 'amy', F1), svc(3, 'amy', F2)];
    const f = org(svcs, { folders: { amy: [F1, F2] } });
    const r = await run(svcs, f, targets(svcs, true));
    expect(lists(f.calls)).toEqual(['content/users/amy', `content/users/amy/${F1}`]);
    expect(items(f.calls)).toEqual([`content/items/${svcs[3]!.id}`]);
    expect(r.sizes.size).toBe(4);
  });

  it('stops paging a listing once one call per item would be cheaper', async () => {
    const svcs = [svc(0, 'amy'), svc(1, 'amy'), svc(2, 'amy')];
    const f = org(svcs, { extra: 950 }); // 10 pages, the services on the last one
    const r = await run(svcs, f);
    expect(lists(f.calls)).toEqual(['content/users/amy']);
    expect(items(f.calls)).toHaveLength(3);
    expect(r.sizes.size).toBe(3);
  });

  it('pages a listing while that is still cheaper', async () => {
    const svcs = Array.from({ length: 40 }, (_, k) => svc(k, 'amy'));
    const f = org(svcs, { extra: 150 }); // 190 items: 2 pages for 40 services
    const r = await run(svcs, f);
    expect(f.calls).toEqual(['content/users/amy', 'content/users/amy']);
    expect(r.sizes.size).toBe(40);
  });

  it('falls back to one call per item when a listing is refused, or carries no real sizes', async () => {
    const svcs = [svc(0, 'amy'), svc(1, 'amy'), svc(2, 'bob'), svc(3, 'bob')];
    const denied = org(svcs, { deny: ['amy'] });
    const a = await run(svcs, denied);
    expect(items(denied.calls)).toEqual([svcs[0]!.id, svcs[1]!.id].map((id) => `content/items/${id}`));
    expect(a.sizes.size).toBe(4);
    const noSize = org(svcs, { listedSize: -1 });
    const b = await run(svcs, noSize);
    expect(items(noSize.calls)).toHaveLength(4);
    expect(b.sizes.get(svcs[3]!.id)?.sizeMB).toBe(4);
  });

  it('stops trying listings after three refusals when none has worked', async () => {
    const owners = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const svcs = owners.flatMap((o, k) => [svc(2 * k, o), svc(2 * k + 1, o)]);
    const f = org(svcs, { deny: owners });
    const r = await run(svcs, f, targets(svcs), 2);
    expect(lists(f.calls).length).toBeLessThanOrEqual(4); // the third refusal may land while one more is in flight
    expect(items(f.calls)).toHaveLength(12);
    expect(r.sizes.size).toBe(12);
  });

  it('a per-item failure is reported, not thrown', async () => {
    const svcs = [svc(0, 'solo')];
    const f = org([]);
    const r = await run(svcs, f);
    expect(r.failed).toEqual([svcs[0]!.id]);
  });

  it('rejects with AbortError when stopped, and never swallows a blocked call', async () => {
    const svcs = [0, 1, 2].map((k) => svc(k, 'amy'));
    const ctl = new AbortController(); ctl.abort();
    await expect(measureHybrid(targets(svcs), { call: org(svcs).request, signal: ctl.signal, onSize: () => {}, onFail: () => {} })).rejects.toMatchObject({ name: 'AbortError' });
    const evil = [{ id: '../addItem', owner: 'solo' }];
    await expect(measureHybrid(evil, { call: org([]).request, onSize: () => {}, onFail: () => {} })).rejects.toMatchObject({ name: 'BlockedRequest' });
  });
});

describe('sizeInfoOf', () => {
  it('reads bytes as MB and treats -1 or a missing size as unknown', () => {
    expect(sizeInfoOf({ size: 2 * MB })).toEqual({ sizeMB: 2, attachmentMB: 0 });
    expect(sizeInfoOf({ size: 0 })).toEqual({ sizeMB: 0, attachmentMB: 0 });
    expect(sizeInfoOf({ size: -1 })).toBeNull();
    expect(sizeInfoOf({})).toBeNull();
  });
});
