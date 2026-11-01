import { test, expect, type Page } from '@playwright/test';

/*
 * The item panel follows new data. A refresh that lands while the panel is open (a cached scan replaced by a newer one)
 * must show the family's usage from the new scan on the new scan's days, never the old usage on the new days; a family
 * gone from the new data closes the panel. And a chart hover only moves the cursor: Connections and its links are left as
 * drawn. Demo (built preview), no network.
 */
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __DC_DEMO_FAST__?: boolean; __DC_RELATED_IDLE_OFF__?: boolean };
    w.__DC_DEMO_FAST__ = true;
    w.__DC_RELATED_IDLE_OFF__ = true;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  // Every layer in the list (a loose custom rule), so a used layer with maps is on it.
  await page.evaluate(() => {
    const r = document.querySelector('dc-review') as unknown as { pick: string; thresholds: unknown };
    r.pick = 'custom'; r.thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 999, minSizeMB: 0 };
  });
  await page.waitForTimeout(800);
});

const panelOpen = (page: Page) => page.locator('dc-item-panel').evaluate((e) => (e as unknown as { isOpen: boolean }).isOpen);

/** Opens the panel (through its API) for a listed family with recent requests and at least one map or app; returns its source id. */
const openUsedFamily = (page: Page) => page.evaluate(() => {
  type S = { id: string; usage: [number, number][]; dependencies: unknown[] };
  type R = { source: S; views: S[] };
  const list = document.querySelector('dc-owner-list') as unknown as { owners: { rows: R[] }[] };
  const rows = list.owners.flatMap((o) => o.rows);
  const ok = (r: R) => [r.source, ...r.views].some((s) => s.usage.some(([d, c]) => c > 0 && d < 200)) && [r.source, ...r.views].some((s) => s.dependencies.length > 0);
  const row = rows.find(ok);
  if (!row) throw new Error('no used family with maps in the demo');
  const opener = document.querySelector('dc-family-row [data-open-panel]') as HTMLElement;
  (document.querySelector('dc-item-panel') as unknown as { show(d: unknown): void }).show({ row, member: row.source.id, opener });
  return row.source.id;
});

/** The panel's data moved on by `days`: scanned later, every service a new object with its usage days that much older. */
const refreshBy = (page: Page, days: number, drop?: string) => page.evaluate(([days, drop]) => {
  type S = { id: string; sourceId: string | null; usage: [number, number][] };
  type D = { org: { scannedAt: string }; services: S[]; usageGaps?: [number, number][] };
  const panel = document.querySelector('dc-item-panel') as unknown as { data: D };
  const d = panel.data;
  const at = new Date(Date.parse(d.org.scannedAt) + days * 86_400_000).toISOString();
  panel.data = {
    ...d,
    org: { ...d.org, scannedAt: at },
    services: d.services.filter((s) => !drop || (s.id !== drop && s.sourceId !== drop)).map((s) => ({ ...s, usage: s.usage.map(([a, c]) => [a + days, c] as [number, number]) })),
    ...(d.usageGaps ? { usageGaps: d.usageGaps.map(([a, b]) => [a + days, b + days] as [number, number]) } : {}),
  };
}, [days, drop ?? ''] as const);

const lastUseCell = (page: Page) => page.locator('dc-item-panel .ip-chart rect.last').getAttribute('data-d');

test('a refresh while the panel is open shows the new scan\'s usage on its own days (the same calendar day, 5 days further back)', async ({ page }) => {
  await openUsedFamily(page);
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  const before = Number(await lastUseCell(page));
  expect(before).toBeGreaterThanOrEqual(0);
  const scanDay0 = await page.locator('dc-item-panel .ip-legend').textContent();
  const nodes0 = await page.locator('dc-item-panel .diagram .node').count();

  await refreshBy(page, 5);
  await expect.poll(() => lastUseCell(page)).toBe(String(before + 5));
  expect(await panelOpen(page)).toBe(true);
  // The scan day moved on; the panel holds the new data's members (their usage is the shifted one).
  expect(await page.locator('dc-item-panel .ip-legend').textContent()).not.toBe(scanDay0);
  const same = await page.locator('dc-item-panel').evaluate((e) => {
    const p = e as unknown as { data: { services: unknown[] }; row: { source: unknown; family: { source: unknown } } };
    return p.data.services.includes(p.row.source) && p.row.family.source === p.row.source;
  });
  expect(same).toBe(true);
  await expect(page.locator('dc-item-panel .diagram .node')).toHaveCount(nodes0);
});

test('a refresh that no longer has the family closes the panel', async ({ page }) => {
  const id = await openUsedFamily(page);
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await refreshBy(page, 1, id);
  await expect.poll(() => panelOpen(page)).toBe(false);
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toHaveCount(0);
});

test('a chart hover moves the readout only: Connections and its links are not drawn again', async ({ page }) => {
  await openUsedFamily(page);
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await expect(page.locator('dc-item-panel [data-related="checking"]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(400);
  // Mark what is drawn now: the links' paths are replaced whenever they are drawn again.
  await page.locator('dc-item-panel').evaluate((e) => {
    for (const el of e.querySelectorAll('.diagram svg.links path, .diagram .node')) (el as unknown as { __mark?: number }).__mark = 1;
  });
  const cells = page.locator('dc-item-panel .ip-chart [data-d]');
  const read0 = await page.locator('dc-item-panel .ip-read').textContent();
  for (const k of [10, 40, 80]) await cells.nth(k).dispatchEvent('pointermove', { bubbles: true });
  await expect(page.locator('dc-item-panel .ip-read')).not.toHaveText(read0 ?? '');
  await expect(page.locator('dc-item-panel .ip-chart .cur')).toHaveCount(1);
  await page.waitForTimeout(200);
  const kept = await page.locator('dc-item-panel').evaluate((e) => {
    const els = [...e.querySelectorAll('.diagram svg.links path, .diagram .node')];
    return { all: els.length, marked: els.filter((el) => (el as unknown as { __mark?: number }).__mark === 1).length };
  });
  expect(kept.all).toBeGreaterThan(0);
  expect(kept.marked).toBe(kept.all);
});
