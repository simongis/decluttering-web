// DC-147d: the relatedItems loader (cache per scan run, concurrency 2, open before idle, failures cached). Test-first.
import { describe, expect, it } from 'vitest';
import { RelatedLoader } from './related-loader';
import type { RequestFn } from '../../scan/types';
import type { Connections } from '../../domain/connections';

const id = (n: number) => n.toString(16).padStart(32, '0');

/** A fake request: answers when `release` is called, records the order of calls and how many were in flight at most. */
function fake(answer: (mapId: string) => unknown = () => ({ relatedItems: [{ id: 'area', title: 'Area', type: 'Map Area', owner: 'o' }] })) {
  const calls: { path: string; params: Record<string, string | number> }[] = [];
  const waiting: (() => void)[] = [];
  let inFlight = 0, maxInFlight = 0;
  const request: RequestFn = (path, params = {}) => new Promise((resolve, reject) => {
    calls.push({ path, params });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    waiting.push(() => {
      inFlight--;
      const m = /content\/items\/([0-9a-f]{32})\/relatedItems/.exec(path)?.[1] ?? '';
      try { const a = answer(m); if (a instanceof Error) reject(a); else resolve(a); } catch (e) { reject(e); }
    });
  });
  /** Answers every call, including the ones the answers let start, until nothing has been waiting for a few ticks. */
  const flush = async () => {
    for (let k = 0, quiet = 0; k < 400 && quiet < 3; k++) {
      await new Promise((r) => setTimeout(r, 0));
      if (waiting.length) { quiet = 0; waiting.shift()?.(); } else quiet++;
    }
  };
  return { request, calls, flush, get maxInFlight() { return maxInFlight; }, get waiting() { return waiting.length; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RelatedLoader', () => {
  it('asks relatedItems forward for each map, two at a time, and caches the answers', async () => {
    const f = fake();
    const l = new RelatedLoader(() => f.request);
    l.setRun('run1');
    const done = l.load([id(1), id(2), id(3)], 'open');
    await tick();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toEqual({ path: `content/items/${id(1)}/relatedItems`, params: { direction: 'forward', num: 100 } });
    await f.flush();
    await done;
    expect(f.calls).toHaveLength(3);
    expect(f.maxInFlight).toBe(2);
    expect(l.result(id(1))).toEqual({ ok: true, items: [{ id: 'area', title: 'Area', type: 'Map Area', owner: 'o' }] });
    // Asked again: nothing new.
    await l.load([id(1), id(2)], 'open');
    expect(f.calls).toHaveLength(3);
    expect(l.log.map((e) => e.kind)).toEqual(['open', 'open', 'open']);
  });

  it('a new scan run clears the cache, and answers for the old run are dropped', async () => {
    const f = fake();
    const l = new RelatedLoader(() => f.request);
    l.setRun('run1');
    void l.load([id(1)], 'open');
    await tick();
    l.setRun('run2');
    await f.flush();
    expect(l.result(id(1))).toBeUndefined();
    await Promise.all([l.load([id(1)], 'open'), f.flush()]);
    expect(f.calls).toHaveLength(2);
    expect(l.result(id(1))?.ok).toBe(true);
    l.setRun('run2'); // same run: kept
    expect(l.result(id(1))?.ok).toBe(true);
  });

  it('403 is cached as not available (no retry); other failures are cached for a while, then may be asked again', async () => {
    let now = 0;
    const f = fake((m) => (m === id(1) ? Object.assign(new Error('no'), { status: 403 }) : m === id(2) ? { error: { code: 403, message: 'You do not have permissions' } } : new Error('network')));
    const l = new RelatedLoader(() => f.request, { now: () => now, failTtlMs: 60_000 });
    l.setRun('r');
    await Promise.all([l.load([id(1), id(2), id(3)], 'open'), f.flush()]);
    expect(l.result(id(1))).toEqual({ ok: false, reason: 'denied' });
    expect(l.result(id(2))).toEqual({ ok: false, reason: 'denied' });
    expect(l.result(id(3))).toEqual({ ok: false, reason: 'failed' });
    await l.load([id(1), id(2), id(3)], 'open');
    expect(f.calls).toHaveLength(3);
    now = 61_000;
    // Expired: still reads as failed (never as "checking" with nothing asked), but the next ask sends it again.
    expect(l.result(id(3))).toEqual({ ok: false, reason: 'failed' });
    await Promise.all([l.load([id(1), id(2), id(3)], 'open'), f.flush()]);
    expect(f.calls).toHaveLength(4);
  });

  it('an expired failure reads as failed until it is asked again; while asked again it reads as pending, then the new answer', async () => {
    let now = 0, fail = true;
    const f = fake(() => (fail ? new Error('network') : { relatedItems: [] }));
    const l = new RelatedLoader(() => f.request, { now: () => now, failTtlMs: 60_000 });
    l.setRun('r');
    await Promise.all([l.load([id(1)], 'open'), f.flush()]);
    now = 120_000;
    expect(l.result(id(1))).toEqual({ ok: false, reason: 'failed' });
    expect(l.isPending(id(1))).toBe(false);
    // Reading it any number of times sends nothing.
    for (let k = 0; k < 5; k++) l.result(id(1));
    expect(f.calls).toHaveLength(1);
    fail = false;
    const done = l.load([id(1)], 'open');
    await tick();
    expect(l.isPending(id(1))).toBe(true);
    expect(l.result(id(1))).toBeUndefined();
    // Asked again while in flight: no second call.
    void l.load([id(1)], 'open');
    await Promise.all([done, f.flush()]);
    expect(f.calls).toHaveLength(2);
    expect(l.result(id(1))).toEqual({ ok: true, items: [] });
  });

  it('no session: every map is "not available", and nothing is sent', async () => {
    const l = new RelatedLoader(() => null);
    l.setRun('r');
    await l.load([id(1)], 'open');
    expect(l.result(id(1))).toEqual({ ok: false, reason: 'denied' });
    expect(l.log).toEqual([]);
  });

  it('a panel open goes before queued idle work, and cancelIdle drops what idle work has not started', async () => {
    const f = fake();
    const l = new RelatedLoader(() => f.request);
    l.setRun('r');
    void l.load([id(1), id(2), id(3), id(4)], 'idle');
    await tick();
    void l.load([id(9)], 'open');
    await tick();
    expect(f.calls.map((c) => c.path)).toEqual([id(1), id(2)].map((m) => `content/items/${m}/relatedItems`));
    f.calls.length = 0;
    await f.flush();
    // The open one went first; the idle ones carry on behind it.
    expect(f.calls[0]?.path).toBe(`content/items/${id(9)}/relatedItems`);
    l.cancelIdle();
    void l.load([id(5), id(6), id(7)], 'idle');
    await tick();
    l.cancelIdle();
    await f.flush();
    expect(l.result(id(7))).toBeUndefined();
    expect(l.isPending(id(7))).toBe(false);
    expect(l.log.filter((e) => e.kind === 'open').map((e) => e.mapId)).toEqual([id(9)]);
  });

  it('loadFor asks at most 20 maps of a family and says how many more were not checked', async () => {
    const f = fake();
    const l = new RelatedLoader(() => f.request);
    l.setRun('r');
    const direct = Array.from({ length: 25 }, (_, i) => ({ item: { id: id(i + 1), title: `M${i}`, type: 'Web Map', owner: 'o' }, kind: 'map' as const, members: ['s'], focus: false }));
    const c = { direct, throughMap: [], members: [] } as unknown as Connections;
    const r = l.loadFor(c, 'open');
    expect(r.maps).toHaveLength(20);
    expect(r.more).toBe(5);
    await Promise.all([r.done, f.flush()]);
    expect(f.calls).toHaveLength(20);
  });

  it('tells subscribers when answers land', async () => {
    const f = fake();
    const l = new RelatedLoader(() => f.request);
    l.setRun('r');
    let n = 0;
    const off = l.subscribe(() => { n++; });
    await Promise.all([l.load([id(1)], 'open'), f.flush()]);
    expect(n).toBeGreaterThan(0);
    off();
    const before = n;
    await Promise.all([l.load([id(2)], 'open'), f.flush()]);
    expect(n).toBe(before);
  });
});
