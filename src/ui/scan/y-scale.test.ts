import { describe, expect, it } from 'vitest';
import { LOG_WEEK_TICKS, LOG_WEEKS_MAX, Y_BAND, lensPoint, staleZone, yLastUsed, zoneBox } from './dot-layout';
import { PRESETS } from '../../domain/stale';

describe('vertical scale: log in weeks', () => {
  it('today sits where the standard scale puts it, and the top stays under the "no use" band', () => {
    expect(yLastUsed(0, 'log-weeks')).toBeCloseTo(yLastUsed(0));
    expect(yLastUsed(LOG_WEEKS_MAX * 7, 'log-weeks')).toBeCloseTo(0.88);
    for (const d of [0, 1, 7, 30, 365, 730, 1460, 5000]) expect(yLastUsed(d, 'log-weeks')).toBeLessThan(Y_BAND[0]);
  });
  it('longer ago is always higher, up to 4 years (then capped, like the standard scale past 2)', () => {
    for (let d = 1; d <= LOG_WEEKS_MAX * 7; d += 3) expect(yLastUsed(d, 'log-weeks')).toBeGreaterThan(yLastUsed(d - 1, 'log-weeks'));
  });
  it('spreads the recent end: the first month gets far more height than on the standard scale', () => {
    const span = (s: 'standard' | 'log-weeks') => yLastUsed(30, s) - yLastUsed(0, s);
    expect(span('log-weeks')).toBeGreaterThan(2 * span('standard'));
    // Used today, yesterday and the day before no longer share a row.
    expect(yLastUsed(1, 'log-weeks') - yLastUsed(0, 'log-weeks')).toBeGreaterThan(0.015);
  });
  it('ticks are in weeks, in order, far enough apart to label', () => {
    let prev = yLastUsed(0, 'log-weeks');
    for (const [d, w] of LOG_WEEK_TICKS) {
      expect(d / 7).toBeCloseTo(w, 0);
      const y = yLastUsed(d, 'log-weeks');
      expect(y - prev).toBeGreaterThan(0.05);
      prev = y;
    }
  });
  it('the stale zone and the dots follow the same scale, so a layer on the rule edge stays on it', () => {
    const t = PRESETS.balanced;
    expect(staleZone(t, 'log-weeks').y).toBeCloseTo(yLastUsed(t.minDaysSinceUse, 'log-weeks'));
    expect(staleZone(t, 'log-weeks').x).toBe(staleZone(t).x);
    const plot = { x0: 70, y0: 12, w: 700, h: 360 };
    expect(zoneBox(plot, 16, t, 'log-weeks').bottom).not.toBe(zoneBox(plot, 16, t).bottom);
    const d = { usedBy: 0, lastUsedDaysAgo: 40, daysSinceUpdate: 400, sizeMB: 10, staleness: 0.5 };
    expect(lensPoint('stale', d, 3, t, 100, 'log-weeks')[0]).toBe(lensPoint('stale', d, 3, t, 100)[0]);
    expect(lensPoint('stale', d, 3, t, 100, 'log-weeks')[1]).not.toBe(lensPoint('stale', d, 3, t, 100)[1]);
  });
  it('defaults to the standard scale, and "no use recorded" keeps its band on both', () => {
    const d = { usedBy: 0, lastUsedDaysAgo: null, daysSinceUpdate: 400, sizeMB: 10, staleness: 1 };
    for (const s of ['standard', 'log-weeks'] as const) {
      const y = lensPoint('stale', d, 9, PRESETS.balanced, 100, s)[1];
      expect(y).toBeGreaterThanOrEqual(Y_BAND[0]);
    }
    expect(lensPoint('big', { ...d, lastUsedDaysAgo: 5 }, 9, PRESETS.balanced, 100, 'log-weeks')).toEqual(lensPoint('big', { ...d, lastUsedDaysAgo: 5 }, 9, PRESETS.balanced, 100));
  });
});
