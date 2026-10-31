import { describe, expect, it } from 'vitest';
import { QUIPS, QUIP_EVERY_LINK_MS, QUIP_EVERY_MS, QUIP_SHOW_AFTER_MS, createRotation, createTipState, safeUrl } from './quips';
// The prototype is plain JS with no types; the parity checks below treat it as data. It is not in the public copy (DC-104),
// so those checks run only where it exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Proto = any;
const protoLoad = Object.values(import.meta.glob('../../../prototypes/d-converged/quips.js'))[0];
const proto = (protoLoad ? await protoLoad() : null) as Proto;

const tips = Array.from({ length: 7 }, (_, i) => ({ kind: 'tip' as const, text: `t${i}` }));
const jokes = Array.from({ length: 3 }, (_, i) => ({ kind: 'joke' as const, text: `j${i}` }));
const list = [...tips, ...jokes];

describe('timing (docs/research/waiting-ux.md)', () => {
  it('shows after 10 s and holds every line 12 s', () => {
    expect(QUIP_SHOW_AFTER_MS).toBe(10000);
    expect(QUIP_EVERY_MS).toBe(12000);
    expect(QUIP_EVERY_LINK_MS).toBe(12000);
  });
});

describe('Pause / Play state', () => {
  it('runs until paused, and stays paused until Play (hover does not resume it)', () => {
    const s = createTipState();
    expect(s.running).toBe(true);
    expect(s.togglePause()).toBe(true);
    expect(s.running).toBe(false);
    s.setHold(true); s.setHold(false);
    expect(s.running).toBe(false);
    expect(s.togglePause()).toBe(false);
    expect(s.running).toBe(true);
  });
  it('hover or focus holds temporarily, then releases', () => {
    const s = createTipState();
    s.setHold(true);
    expect(s.running).toBe(false);
    s.setHold(false);
    expect(s.running).toBe(true);
  });
  it('stop is final', () => {
    const s = createTipState();
    s.stop();
    expect(s.running).toBe(false);
    s.togglePause(); s.togglePause();
    expect(s.running).toBe(false);
  });
});

describe('rotation', () => {
  it('does not repeat within a cycle of each kind, or back to back', () => {
    for (const rnd of [Math.random, () => 0, () => 0.999]) {
      const r = createRotation(list, rnd);
      const seq = Array.from({ length: 300 }, () => r.next()!);
      seq.slice(1).forEach((x, i) => expect(x).not.toBe(seq[i]));
      for (const kind of ['tip', 'joke']) {
        const of = seq.filter((q) => q.kind === kind), n = list.filter((q) => q.kind === kind).length;
        for (let i = 0; i + n <= of.length; i += n) expect(new Set(of.slice(i, i + n)).size).toBe(n);
      }
    }
  });
  it('a joke every 3rd or 4th line, never two in a row', () => {
    const r = createRotation(list);
    const seq = Array.from({ length: 300 }, () => r.next()!.kind);
    let run = 0, first = true;
    for (const k of seq) { if (k === 'joke') { if (!first) expect([3, 4]).toContain(run); run = 0; first = false; } else run++; }
  });
  it('empty list shows nothing', () => {
    expect(createRotation([]).next()).toBeNull();
    expect(createRotation(undefined).next()).toBeNull();
  });
});

describe('safeUrl', () => {
  it('allows https on esri.com and arcgis.com hosts only', () => {
    for (const u of ['https://doc.arcgis.com/en/x', 'https://www.esri.com/a?b=1', 'https://arcgis.com']) expect(safeUrl(u)).toBeTruthy();
    for (const u of ['http://doc.arcgis.com/', 'https://evilesri.com/', 'https://esri.com.evil.com/', 'https://arcgis.com@evil.com/', 'javascript:alert(1)', '', null, undefined])
      expect(safeUrl(u)).toBeNull();
  });
  it.skipIf(!proto)('matches the prototype', () => {
    for (const u of ['https://doc.arcgis.com/x', 'http://esri.com', 'https://user:pw@esri.com/', 'nope', null]) expect(safeUrl(u)).toBe(proto.safeUrl(u));
  });
});

describe('FB-20: hosted-layer tips first', () => {
  const hosted = Array.from({ length: 4 }, (_, i) => ({ kind: 'tip' as const, topic: 'hosted-layers' as const, text: `h${i}` }));
  const other = Array.from({ length: 3 }, (_, i) => ({ kind: 'tip' as const, topic: 'other' as const, text: `o${i}` }));
  it('plays hosted-layer tips, then the rest, each cycle', () => {
    for (const rnd of [Math.random, () => 0, () => 0.999]) {
      const r = createRotation([...other, ...hosted, ...jokes], rnd);
      const seen = Array.from({ length: 80 }, () => r.next()!).filter((q) => q.kind === 'tip');
      for (let c = 0; c + 7 <= seen.length; c += 7) {
        const cyc = seen.slice(c, c + 7);
        expect(cyc.slice(0, 4).every((q) => q.topic === 'hosted-layers')).toBe(true);
        expect(cyc.slice(4).every((q) => q.topic === 'other')).toBe(true);
      }
    }
  });
  it('tags the real list', () => {
    const t = QUIPS().filter((q) => q.kind === 'tip');
    expect(t.every((q) => q.topic === 'hosted-layers' || q.topic === 'other')).toBe(true);
    expect(t.filter((q) => q.topic === 'hosted-layers')).toHaveLength(8);
  });
});

describe.skipIf(!proto)('app and prototype stay in sync', () => {
  it('same tips and jokes, in the same order', () => { expect(QUIPS()).toEqual(proto.QUIPS); });
  it('same timing constants', () => {
    expect([QUIP_SHOW_AFTER_MS, QUIP_EVERY_MS, QUIP_EVERY_LINK_MS]).toEqual([proto.QUIP_SHOW_AFTER_MS, proto.QUIP_EVERY_MS, proto.QUIP_EVERY_LINK_MS]);
  });
  it('every link passes safeUrl', () => { for (const q of QUIPS()) if (q.url) expect(safeUrl(q.url)).toBeTruthy(); });
});
