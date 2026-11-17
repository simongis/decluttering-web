import { describe, expect, it } from 'vitest';
import { addPicked, chosenOf, deleteStatusOf, keepPresent, togglePicked, waitReason } from './selection';

const deletable = new Map([['a', { sizeMB: 10 }], ['b', { sizeMB: null }], ['c', { sizeMB: 5 }]]);

describe('addPicked (a rectangle on the chart)', () => {
  it('adds what the user may delete, counts the rest as left out, never removes', () => {
    const r = addPicked(new Set(['c']), ['a', 'x', 'a', 'c', 'y'], deletable);
    expect([...r.next].sort()).toEqual(['a', 'c']);
    expect(r).toMatchObject({ inRect: 4, added: 1, dropped: 2 });
  });
  it('an empty rectangle changes nothing', () => {
    const sel = new Set(['a']);
    expect(addPicked(sel, [], deletable)).toMatchObject({ inRect: 0, added: 0, dropped: 0 });
  });
});

describe('togglePicked (a row checkbox, a dot menu, the dialog Remove)', () => {
  it('adds and removes one', () => {
    const on = togglePicked(new Set(), 'a', true, deletable);
    expect([...on]).toEqual(['a']);
    expect([...togglePicked(on, 'a', false, deletable)]).toEqual([]);
  });
  it('refuses to add a layer the user may not delete, but can always remove', () => {
    const sel = new Set(['x']);
    expect(togglePicked(sel, 'y', true, deletable)).toBe(sel);
    expect([...togglePicked(sel, 'x', false, deletable)]).toEqual([]);
  });
  it('returns the same set when nothing changes', () => {
    const sel = new Set(['a']);
    expect(togglePicked(sel, 'a', true, deletable)).toBe(sel);
    expect(togglePicked(sel, 'b', false, deletable)).toBe(sel);
  });
});

describe('chosenOf', () => {
  it('counts only deletable ids, sums the known sizes and counts those off the list', () => {
    expect(chosenOf(new Set(['a', 'b', 'x', 'c']), deletable, new Set(['a']))).toEqual({ ids: ['a', 'b', 'c'], sizeMB: 15, off: 2 });
  });
  it('size is null when none is measured', () => {
    expect(chosenOf(new Set(['b']), deletable).sizeMB).toBeNull();
    expect(chosenOf(new Set(), deletable)).toEqual({ ids: [], sizeMB: null, off: 0 });
  });
});

describe('keepPresent', () => {
  it('drops ids that left the data, and keeps the same set when none did', () => {
    const sel = new Set(['a', 'gone']);
    expect([...keepPresent(sel, new Set(['a']))]).toEqual(['a']);
    expect(keepPresent(sel, new Set(['a', 'gone']))).toBe(sel);
  });
});

describe('delete status', () => {
  const base = { buildOn: true, mayDelete: true, stopped: false, depsKnown: true, refreshing: false };
  it('is off only when the build has it off and no remover exists', () => {
    expect(deleteStatusOf({ ...base, buildOn: false, mayDelete: false })).toBe('off');
    expect(deleteStatusOf({ ...base, buildOn: false })).toBe('ready'); // the demo: a stand-in remover, build off
  });
  it('says why it waits, in this order: privilege, stopped scan, maps and apps or a refresh', () => {
    expect(deleteStatusOf({ ...base, mayDelete: false, stopped: true })).toBe('no-privilege');
    expect(deleteStatusOf({ ...base, stopped: true, depsKnown: false })).toBe('stopped');
    expect(deleteStatusOf({ ...base, depsKnown: false })).toBe('waiting');
    expect(deleteStatusOf({ ...base, refreshing: true })).toBe('waiting');
    expect(deleteStatusOf(base)).toBe('ready');
  });
  it('has a message for every waiting state and none when ready or off', () => {
    expect(waitReason('no-privilege')).toBe('review.delete.noPrivilege');
    expect(waitReason('stopped')).toBe('review.delete.waitingStopped');
    expect(waitReason('waiting')).toBe('review.delete.waiting');
    expect(waitReason('ready')).toBeNull();
    expect(waitReason('off')).toBeNull();
  });
});
