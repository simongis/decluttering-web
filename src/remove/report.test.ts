import { describe, expect, it } from 'vitest';
import { csvField, deleteReportCsv, REPORT_COLUMNS, reportFileName } from './report';
import type { RemovalCandidate } from './plan';

const cand = (id: string, title: string, o: Partial<RemovalCandidate> = {}): RemovalCandidate => ({
  id, title, owner: 'ana', sizeMB: 12.3456, usedBy: 0, views: [], family: { id, source: { id, owner: 'ana' }, views: [] }, ...o,
});

describe('csvField', () => {
  it('quotes commas, quotes, line breaks and edge spaces', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(' pad')).toBe('" pad"');
    expect(csvField('plain')).toBe('plain');
    expect(csvField(null)).toBe('');
  });
  it('defuses text a spreadsheet would run as a formula', () => {
    for (const s of ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)']) expect(csvField(s).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    expect(csvField('-5', false)).toBe('-5'); // numbers and ids are not text
  });
});

describe('deleteReportCsv', () => {
  const at = new Date('2026-11-17T14:30:00Z');
  it('has the header and one row per layer, with the outcome of each', () => {
    const items = [
      cand('a'.repeat(32), 'Old, copy', { views: [{ id: 'v'.repeat(32), title: 'V', owner: 'ana' }], usedBy: 2 }),
      cand('b'.repeat(32), '=bad()', { sizeMB: null }),
      cand('c'.repeat(32), 'Half'),
    ];
    const csv = deleteReportCsv(items, [
      { id: 'a'.repeat(32), ok: true, removed: ['v'.repeat(32), 'a'.repeat(32)] },
      { id: 'b'.repeat(32), ok: false, reason: 'protected', removed: [] },
      { id: 'c'.repeat(32), ok: false, reason: 'failed', message: 'Server said no', removed: ['x'] },
    ], { at, by: 'admin', org: 'My Org' });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(5); // header, 3 rows, trailing empty
    expect(lines[1]).toBe(`2026-11-17T14:30:00.000Z,My Org,admin,${'a'.repeat(32)},"Old, copy",ana,12.35,${'v'.repeat(32)},2,deleted,,${'v'.repeat(32)} ${'a'.repeat(32)},`);
    expect(lines[2]).toContain(",'=bad(),");
    expect(lines[2]).toContain(',,0,not deleted,protected,,');
    expect(lines[3]).toContain('partly deleted,failed,x,Server said no');
  });
  it('a layer with no outcome (the run stopped before it) says so', () => {
    const csv = deleteReportCsv([cand('d'.repeat(32), 'D')], [], { at, by: 'me' });
    expect(csv.split('\r\n')[1]).toContain(',not run,');
  });
});

describe('reportFileName', () => {
  it('sorts by date and time', () => {
    expect(reportFileName(new Date(2026, 10, 7, 9, 5))).toBe('decluttering-deletes-2026-11-07-0905.csv');
  });
});
