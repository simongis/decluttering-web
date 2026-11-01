import { test, expect } from '@playwright/test';

// DC-035a: the playing demo scans a made-up org with 3 maps and apps that point at deleted layers (and a decoy that must not
// show). Review lists them in a collapsed block under the owner list, as a sortable table (DC-137). The quick demo (no scan) shows nothing.

test('the playing demo lists maps and apps with missing layers, without calling any service url', async ({ page }) => {
  const errors: string[] = [];
  const urls: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => urls.push(r.url()));

  await page.goto('/#/demo');
  await expect(page.locator('dc-scan-screen [data-action="review"]')).toBeVisible({ timeout: 40_000 });
  await page.locator('[data-action="skip-demo"]').click();
  await expect(page.locator('dc-review')).toBeVisible({ timeout: 30_000 });

  const block = page.locator('dc-broken-refs calcite-block[data-broken-refs="block"]');
  await expect(block).toBeVisible({ timeout: 30_000 });
  await expect(block).toHaveAttribute('heading', 'Maps and apps with missing layers (3)');
  expect(await block.evaluate((el) => (el as HTMLElement & { open: boolean }).open)).toBe(false); // collapsed
  await block.evaluate((el) => { (el as HTMLElement & { open: boolean }).open = true; });
  // DC-137: no subtitle, a short note, then a table sorted by missing layers, most first.
  expect(await block.getAttribute('description')).toBeNull();
  const rows = block.locator('tbody tr[data-broken]');
  await expect(rows).toHaveCount(3);
  const titles = () => rows.locator('td.br-item').allInnerTexts();
  expect((await titles()).map((t) => t.trim())).toEqual(['Road Works Dashboard', 'Community Facilities Explorer', 'Flood Watch Viewer']);
  await expect(rows.locator('[data-missing]')).toHaveText(['3', '2', '1']);
  await expect(block.locator('th:has([data-sort="missing"])')).toHaveAttribute('aria-sort', 'descending');
  // Item-type icons, named for screen readers; ArcGIS Online's status chips on the deprecated and the authoritative map.
  await expect(rows.first().locator('td.br-item calcite-icon')).toHaveAttribute('icon', 'dashboard');
  await expect(rows.first().locator('td.br-item calcite-icon')).toHaveAttribute('text-label', 'Dashboard');
  await expect(rows.first()).toContainText('Deprecated');
  await expect(block.locator('calcite-chip.st-deprecated')).toHaveCount(1);
  await expect(rows.nth(1).locator('calcite-chip.st-authoritative')).toHaveAttribute('icon', 'check-circle');
  await expect(rows.first().locator('calcite-chip.st-deprecated')).toHaveAttribute('icon', 'exclamation-mark-triangle');
  // Sorting: again on the same column flips it; another column sorts by that.
  await block.locator('[data-sort="missing"]').click();
  await expect(rows.locator('[data-missing]')).toHaveText(['1', '2', '3']);
  await expect(block.locator('th:has([data-sort="missing"])')).toHaveAttribute('aria-sort', 'ascending');
  await block.locator('[data-sort="title"]').click();
  expect((await titles()).map((t) => t.trim())).toEqual(['Community Facilities Explorer', 'Flood Watch Viewer', 'Road Works Dashboard']);
  await expect(block.locator('th:has([data-sort="missing"])')).toHaveAttribute('aria-sort', 'none');
  await expect(block).toContainText('Flood Watch Viewer');
  await expect(block).not.toContainText('Regional Overview Map');
  // No Status column when nothing listed has a status worth showing.
  await expect(block.locator('[data-sort="deprecated"]')).toHaveCount(1);
  await page.locator('dc-broken-refs').evaluate((el) => {
    const e = el as HTMLElement & { refs: { contentStatus?: string }[] };
    e.refs = e.refs.map(({ contentStatus: _, ...r }) => r);
  });
  await expect(block.locator('[data-sort="deprecated"]')).toHaveCount(0);
  await expect(block.locator('thead th')).toHaveCount(4);
  await expect(rows.first().locator('td')).toHaveCount(4);

  // Report only: nothing here to tick or send.
  await expect(block.locator('calcite-checkbox, calcite-button')).toHaveCount(0);
  // A phone-width window never scrolls sideways (the table scrolls inside its card).
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The scan never asks a service url for anything (the made-up org answers from memory, and there is no other network).
  expect(urls.filter((u) => /arcgis\.com\/.*\/rest\/services\/|FeatureServer|MapServer/i.test(u) && !/js\.arcgis\.com\/calcite/.test(u))).toEqual([]);
  expect(errors).toEqual([]);
});

test('the quick demo shows no missing-layers block', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible();
  await expect(page.locator('dc-broken-refs calcite-block')).toHaveCount(0);
});
