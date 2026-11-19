import { test, expect, type Page } from '@playwright/test';
/* The vertical scale switch on Review's "How stale" chart: Standard or log in weeks, remembered per browser. */
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

const map = (page: Page) => page.locator('dc-review dc-dot-map');
/** The drawn height (px) of each dot used in the last `days`, after the dots have settled. */
const recentYs = async (page: Page, days: number) => {
  await page.waitForTimeout(1600); // travel and the lens-style glide end
  return map(page).evaluate((m, days) => (m as unknown as { sprites: { y: number; rad: number; lastUsedDaysAgo: number | null }[] }).sprites
    .filter((d) => d.rad > 0 && d.lastUsedDaysAgo !== null && d.lastUsedDaysAgo <= days).map((d) => d.y), days);
};
const spread = (ys: number[]) => Math.max(...ys) - Math.min(...ys);

test('Review: the log-in-weeks scale spreads the recently used layers, and the choice is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  const sw = map(page).locator('[data-scan="y-scale"]');
  await sw.scrollIntoViewIfNeeded();
  await expect(sw).toBeVisible();
  await expect(map(page).locator('.dm-wrap')).toHaveAttribute('data-y-scale', 'standard');
  const before = await recentYs(page, 30);
  expect(before.length, 'the demo has layers used in the last month').toBeGreaterThan(2);

  await sw.locator('calcite-segmented-control-item[value="log-weeks"]').click();
  await expect(map(page).locator('.dm-wrap')).toHaveAttribute('data-y-scale', 'log-weeks');
  const after = await recentYs(page, 30);
  expect(spread(after)).toBeGreaterThan(2 * spread(before));

  await page.reload();
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  await expect(map(page).locator('.dm-wrap')).toHaveAttribute('data-y-scale', 'log-weeks');
  await map(page).locator('[data-scan="y-scale"] calcite-segmented-control-item[value="standard"]').click();
  await expect(map(page).locator('.dm-wrap')).toHaveAttribute('data-y-scale', 'standard');
});

test('the scan screen has no scale switch and always draws the standard scale', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('decluttering:dotmap.yScale', 'log-weeks'); } catch { /* */ } });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('dc-scan-screen [data-scan="y-scale"]')).toHaveCount(0);
  for (const el of await page.locator('dc-dot-map').all()) {
    const inReview = await el.evaluate((e) => !!e.closest('dc-review'));
    await expect(el.locator('.dm-wrap')).toHaveAttribute('data-y-scale', inReview ? 'log-weeks' : 'standard');
  }
});
