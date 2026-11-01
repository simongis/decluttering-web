// DC-147: reading a second year of usage must not change which layers the rule picks out, for any starting point or
// custom threshold. Scans the simulated org (several seeds, plus the demo org) with 365 and with 730 days of history and
// compares every row's verdict. The simulator has second-year requests (some layers used only then) and second-year sweeps.
import { describe, expect, it } from 'vitest';
import { createSimulatedOrg, type SimulatedOrgConfig } from '../demo/simulated-org';
import { demoConfig } from '../demo/demo-org';
import { LAST_USED_OPTIONS, PRESETS, USAGE_RULE_DAYS, allRows, sweepsOf } from '../domain/stale';
import { suggest } from '../domain/suggest';
import { sweepSummary } from '../domain/sweep';
import type { Data, Thresholds } from '../domain/types';
import { scanOrg } from './pipeline';

const NOW = Date.UTC(2026, 10, 1, 9, 30);
const base = { portal: 'https://sim.example', orgId: 'X', now: () => NOW, sleep: async () => {}, random: () => 0 };

async function both(cfg: Partial<SimulatedOrgConfig>): Promise<[Data, Data]> {
  const one = await scanOrg(createSimulatedOrg({ ...cfg, speed: 0, now: () => NOW }).request, { ...base, usageDays: 365 });
  const two = await scanOrg(createSimulatedOrg({ ...cfg, speed: 0, now: () => NOW }).request, base);
  return [one.data, two.data];
}

/** Every starting point, and custom mixes across every Last used option (the 2-year one included) and the edges. */
function rules(d: Data): [string, Thresholds][] {
  const out: [string, Thresholds][] = Object.entries(PRESETS).map(([k, t]) => [k, t]);
  const sug = suggest(d);
  if (sug) out.push(['suggested', sug.thresholds]);
  for (const { value } of [{ value: 0 }, ...LAST_USED_OPTIONS]) {
    out.push([`use ${value}`, { minDaysSinceUse: value, minDaysSinceUpdate: 0, maxUsedBy: 99, minSizeMB: 0 }]);
    out.push([`use ${value} strict`, { minDaysSinceUse: value, minDaysSinceUpdate: 365, maxUsedBy: 0, minSizeMB: 20 }]);
  }
  return out;
}

const verdicts = (d: Data, t: Thresholds, countSweeps: boolean) =>
  new Map(allRows(d, t, { countSweeps }).map((r) => [r.source.id, `${r.stale}|${r.useKnown}|${r.lastUsedDaysAgo}|${r.noUseRecorded}|${r.priority}`]));

const SEEDS: [string, Partial<SimulatedOrgConfig>][] = [
  ['seed 74', { services: 1200, maps: 400, seed: 74 }],
  ['seed 11', { services: 900, maps: 300, seed: 11 }],
  ['seed 2026', { services: 1500, maps: 500, seed: 2026, brokenMaps: 2 }],
  ['demo org', demoConfig()],
];

describe.each(SEEDS)('DC-147: same picks with 365 or 730 days of usage (%s)', (_name, cfg) => {
  it('every row of every rule is the same, counting sweeps or not; the suggestion and the sweep note too', async () => {
    const [one, two] = await both(cfg);
    expect(one.usageDays).toBe(365);
    expect(two.usageDays).toBe(730);
    // not a vacuous test: the second scan has a second year, and some layers were used only then
    const y2 = (d: Data) => d.services.filter((s) => s.usage.some(([day]) => day >= USAGE_RULE_DAYS));
    expect(y2(one)).toHaveLength(0);
    expect(y2(two).length).toBeGreaterThan(20);
    expect(two.services.some((s) => s.usage.length && s.usage.every(([day]) => day >= USAGE_RULE_DAYS))).toBe(true);

    expect(suggest(two)?.thresholds).toEqual(suggest(one)?.thresholds);
    expect(sweepsOf(two).days).toEqual(sweepsOf(one).days);
    expect(sweepSummary(sweepsOf(two), NOW)).toEqual(sweepSummary(sweepsOf(one), NOW));
    let picked = 0;
    for (const [name, t] of rules(one)) for (const countSweeps of [false, true]) {
      const a = verdicts(one, t, countSweeps), b = verdicts(two, t, countSweeps);
      expect(b.size, name).toBe(a.size);
      const diff = [...a].filter(([id, v]) => b.get(id) !== v).map(([id, v]) => `${id}: ${v} -> ${b.get(id)}`);
      expect(diff, `${name}${countSweeps ? ' (counting sweeps)' : ''}`).toEqual([]);
      for (const v of a.values()) if (v.startsWith('true')) picked++;
    }
    expect(picked).toBeGreaterThan(0);
  }, 60_000);
});
