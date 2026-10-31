import { describe, expect, it } from 'vitest';
import type { OwnerGroup, Row } from '../../domain/types';
import { PRESETS } from '../../domain/stale';
import { itemOn, sayCredits, sayRule, saySize, sayWhy, selectionOf, sparkGeometry } from './helpers';

const row = (id: string, views = 0): Row => ({
  source: { id }, views: new Array(views).fill({}), credits: 2, sizeMB: 10,
} as unknown as Row);
const group = (rows: Row[], nudgedRecently: boolean, username = 'a'): OwnerGroup =>
  ({ owner: { username }, rows, nudgedRecently } as unknown as OwnerGroup);

describe('itemOn', () => {
  it('defaults on, and off for a recently nudged owner', () => {
    expect(itemOn(new Map(), group([row('1')], false), row('1'))).toBe(true);
    expect(itemOn(new Map(), group([row('1')], true), row('1'))).toBe(false);
  });
  it('an explicit tick wins', () => {
    expect(itemOn(new Map([['1', true]]), group([row('1')], true), row('1'))).toBe(true);
  });
});

describe('selectionOf', () => {
  it('counts ticked owners, items, services and credits', () => {
    const owners = [group([row('1', 2), row('2')], false, 'a'), group([row('3')], true, 'b')];
    const s = selectionOf(owners, new Map());
    expect(s.owners).toEqual(['a']);
    expect(s.items).toEqual(['1', '2']);
    expect(s.services).toBe(4);
    expect(s.credits).toBe(4);
  });
});

describe('sparkGeometry', () => {
  it('draws a minimum-height bar, and a flat tick for zero', () => {
    const g = sparkGeometry([0, 1, 7]);
    expect(g.bars[0]).toMatchObject({ zero: true, h: 1 });
    expect(g.bars[1]?.h).toBeGreaterThanOrEqual(2);
    expect(g.bars[2]).toMatchObject({ y: 3 });
    expect(g.total).toBe(8);
  });
});

describe('copy without usage access', () => {
  it('rule and why skip the usage clause', () => {
    expect(sayRule(PRESETS.balanced, false)).not.toMatch(/last used|nobody has used|data request/i);
    expect(sayRule(PRESETS.balanced, true)).toMatch(/^We pick out layers nobody has used for more than 6 months/);
    const why = sayWhy({ lastUsedDaysAgo: null, useKnown: true, noUseRecorded: false, lastModified: '2024-03-05T00:00:00Z', usedBy: 0 }, false);
    expect(why).toBe('Last updated Mar 2024 · no maps or apps use it');
  });
});

describe('sayWhy while maps and apps are still being read', () => {
  it('says used-by is still being checked', () => {
    expect(sayWhy({ lastUsedDaysAgo: 300, useKnown: true, noUseRecorded: false, lastModified: '2024-03-01T00:00:00Z', usedBy: 2 }, true, false)).toMatch(/used by: still checking…$/);
  });
});

describe('after a scan stopped early (DC-053)', () => {
  it('says used-by was not checked, and an unmeasured size was not measured', () => {
    expect(sayWhy({ lastUsedDaysAgo: 300, useKnown: true, noUseRecorded: false, lastModified: '2024-03-01T00:00:00Z', usedBy: 0 }, true, false, true)).toMatch(/used by: not checked$/);
    expect(saySize({ sizeMB: 0, sizeKnown: false })).toBe('Size not measured yet');
    expect(saySize({ sizeMB: 0, sizeKnown: false }, true)).toBe('Size not measured');
    expect(saySize({ sizeMB: 2, sizeKnown: true }, true)).toBe('2 MB');
  });
});

describe('sayCredits (DC-134)', () => {
  it('names attachments only when there are some', () => {
    expect(sayCredits({ credits: 24, attachmentMB: 0 })).toBe('About 24 credits a month');
    expect(sayCredits({ credits: 0.31, attachmentMB: 227 })).toBe('About 0.3 credits a month. Includes 227 MB of attachments, billed as file storage at a much lower rate.');
    expect(sayCredits({ credits: 0.1, attachmentMB: 0.01 })).toBe('About 0.1 credits a month');
  });
});
