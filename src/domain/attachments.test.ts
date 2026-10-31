// DC-134 (FB-85): attachments are billed as file storage (1.2 credits per GB a month), not feature storage (2.4 per 10 MB).
// An item's `size` includes them; `subInfo` holds their bytes (docs/research/attachment-storage.md). Written test-first.
import { describe, expect, it } from 'vitest';
import { allRows, creditsPerMonth } from './stale';
import { sizeInfoOf } from '../scan/sizing';
import { sizeOrder, withSizes } from '../scan/pipeline';
import { sizesToReuse } from '../cache/scanCache';
import { buildDots } from '../ui/scan/dots';
import { tapRequest, type ScanTap } from '../routes/scan-run';
import type { Data, Service, Thresholds } from './types';

const MB = 1048576;
const SCAN = '2026-10-10T09:00:00Z';
const DAY = 864e5;
const isoAgo = (d: number) => new Date(Date.parse(SCAN) - d * DAY).toISOString();
let n = 0;
const svc = (o: Partial<Service> = {}): Service => ({
  id: `s${++n}`, title: `Service ${n}`, owner: 'amy', created: isoAgo(900), modified: isoAgo(800), sizeMB: 50,
  access: 'private', isView: false, sourceId: null, usage: [], dependencies: [], ...o,
});
const orgOf = (services: Service[]): Data => ({
  org: { id: 'o', name: 'Org', urlKey: 'org', scannedAt: SCAN },
  owners: [{ username: 'amy', fullName: 'Amy', disabled: false, thumbnail: null, lastNotified: null }],
  services,
});
const ANY: Thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 99, minSizeMB: 0 };
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('creditsPerMonth with attachments', () => {
  it('prices features at 2.4 per 10 MB and attachments at 1.2 per GB', () => {
    close(creditsPerMonth(10), 2.4); // no attachments: unchanged
    close(creditsPerMonth(10, 0), 2.4);
    close(creditsPerMonth(1024 + 10, 1024), 2.4 + 1.2);
    // The dev org's DEMO - Graffiti: 46.22 MB, of which 45.67 MB attachments.
    close(creditsPerMonth(46.22, 45.67), (0.55 / 10) * 2.4 + (45.67 / 1024) * 1.2);
  });

  it('never prices more attachments than the item holds', () => {
    close(creditsPerMonth(5, 8), (5 / 1024) * 1.2);
    close(creditsPerMonth(0, 0), 0);
  });
});

describe('rows', () => {
  it('a family is priced from its source attachments; the size and the size filter stay on total storage', () => {
    const src = svc({ sizeMB: 230, attachmentMB: 227 });
    const view = svc({ isView: true, sourceId: src.id, sizeMB: 0, attachmentMB: 0 });
    const r = allRows(orgOf([src, view]), { ...ANY, minSizeMB: 200 }).find((x) => x.source.id === src.id)!;
    expect(r.sizeMB).toBe(230);
    expect(r.attachmentMB).toBe(227);
    close(r.credits, creditsPerMonth(230, 227));
    expect(r.credits).toBeLessThan(1); // was 55.2 credits a month
    expect(r.stale).toBe(true); // still on the list: 230 MB passes "at least 200 MB"
  });

  it('a service without attachment figures (an old scan) keeps the old price', () => {
    const r = allRows(orgOf([svc({ sizeMB: 100 })]), ANY)[0]!;
    expect(r.attachmentMB).toBe(0);
    close(r.credits, 24);
  });
});

describe('sizing reads subInfo', () => {
  it('reads subInfo bytes as attachmentMB, 0 when absent or not a number', () => {
    expect(sizeInfoOf({ size: 46 * MB, subInfo: 45 * MB })).toEqual({ sizeMB: 46, attachmentMB: 45 });
    expect(sizeInfoOf({ size: 2 * MB })).toEqual({ sizeMB: 2, attachmentMB: 0 });
    expect(sizeInfoOf({ size: 2 * MB, subInfo: 'x' })).toEqual({ sizeMB: 2, attachmentMB: 0 });
    expect(sizeInfoOf({ size: 2 * MB, subInfo: -1 })).toEqual({ sizeMB: 2, attachmentMB: 0 });
    expect(sizeInfoOf({ size: -1, subInfo: 0 })).toBeNull();
  });

  it('withSizes carries attachmentMB onto the service', () => {
    const s = svc({ sizeMB: null });
    const d = withSizes(orgOf([s]), new Map([[s.id, { sizeMB: 46, attachmentMB: 45 }]]));
    expect(d.services[0]).toMatchObject({ sizeMB: 46, attachmentMB: 45 });
  });
});

describe('cache reuse and refresh (lazy sizing)', () => {
  it('reuses a size with its attachments; a size cached before DC-134 is reused as it is, without them', () => {
    const m = isoAgo(5);
    const prev = { services: [
      { id: 'new', sizeMB: 46, attachmentMB: 45, modified: m },
      { id: 'plain', sizeMB: 3, attachmentMB: 0, modified: m },
      { id: 'old', sizeMB: 46, modified: m },
    ] } as unknown as Data;
    const cur = ['new', 'plain', 'old'].map((id) => ({ id, modified: m }));
    expect([...sizesToReuse(cur, prev)]).toEqual([
      ['new', { sizeMB: 46, attachmentMB: 45 }], ['plain', { sizeMB: 3, attachmentMB: 0 }], ['old', { sizeMB: 46 }],
    ]);
  });

  it('sizeOrder refreshes old cached sources after the unmeasured ones of the same rank, and never views', () => {
    const fresh = svc({ sizeMB: 9, attachmentMB: 0 });
    const old = svc({ sizeMB: 9 });
    const unsized = svc({ sizeMB: null });
    const oldView = svc({ sizeMB: 0, isView: true, sourceId: fresh.id });
    const order = sizeOrder(orgOf([fresh, old, unsized, oldView]));
    expect(order).toEqual([unsized.id, old.id]);
  });
});

describe('scan screen', () => {
  it('the tap passes attachments on with the size', async () => {
    const seen: ScanTap[] = [];
    const id = 'a'.repeat(32);
    const req = tapRequest(async () => ({ id, size: 46 * MB, subInfo: 45 * MB }), (e) => seen.push(e));
    await req(`content/items/${id}`);
    expect(seen).toEqual([{ kind: 'sized', id, sizeMB: 46, attachmentMB: 45 }]);
  });

  it('dots price attachments at the file rate before the core is in', () => {
    const m = buildDots({ found: [{ id: 'x', title: 'X', owner: 'amy' }], sized: new Map([['x', 46]]), attached: new Map([['x', 45]]), data: null, depsKnown: false });
    expect(m.dots[0]!.sizeMB).toBe(46);
    close(m.dots[0]!.credits, creditsPerMonth(46, 45));
  });
});
