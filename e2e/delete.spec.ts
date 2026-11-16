import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
/*
 * ADR 0016: deleting layers from Review. The demo has a stand-in remover (no account, no request, nothing changes anywhere),
 * so this plays the whole flow: from the item panel and from the ticked rows, with the typed confirmation.
 */
test.setTimeout(180_000);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __DC_DEMO_FAST__?: boolean; __DC_RELATED_IDLE_OFF__?: boolean };
    w.__DC_DEMO_FAST__ = true;
    w.__DC_RELATED_IDLE_OFF__ = true;
  });
});
const reviewReady = async (page: Page) => { await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 }); await page.waitForTimeout(400); };
const dialog = (page: Page) => page.locator('dc-delete-dialog calcite-dialog');
const typeWord = async (page: Page, word: string) => {
  const input = page.locator('dc-delete-dialog [data-delete="typed"]');
  await input.locator('input').fill(word);
};

test('demo: the item panel deletes a layer after the typed confirmation, and the row leaves the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const rows = page.locator('dc-family-row');
  const before = await rows.count();
  const first = rows.first();
  const title = (await first.locator('.title, [data-title], a').first().textContent())?.trim() ?? '';
  await first.locator('.why').click();
  await page.locator('dc-item-panel [data-action="delete-item"]').click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  await expect(page.locator('dc-delete-dialog [data-delete-item]')).toHaveCount(1);
  const go = page.locator('dc-delete-dialog [data-action="delete-go"]');
  await expect(go).toHaveAttribute('disabled', '');
  await typeWord(page, 'nope');
  await expect(go).toHaveAttribute('disabled', '');
  await typeWord(page, 'delete');
  await expect(go).not.toHaveAttribute('disabled', '');
  await go.click();
  await expect(page.locator('dc-delete-dialog [data-delete="done"]')).toContainText('Deleted 1 layer.');
  await page.locator('dc-delete-dialog [data-action="delete-close"]').click();
  await expect(dialog(page)).not.toHaveAttribute('open', '');
  await expect.poll(() => rows.count()).toBeLessThan(before);
  if (title) await expect(page.locator('dc-family-row', { hasText: title })).toHaveCount(0);
});

test('demo: Cancel leaves everything as it was; the ticked rows open the same dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const before = await page.locator('dc-family-row').count();
  const bulk = page.locator('[data-action="delete-ticked"]');
  await expect(bulk).toBeVisible();
  await bulk.click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  expect(await page.locator('dc-delete-dialog [data-delete-item]').count()).toBeGreaterThan(0);
  const results = await new AxeBuilder({ page }).include('dc-delete-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.locator('dc-delete-dialog [data-action="delete-cancel"]').click();
  await expect(dialog(page)).not.toHaveAttribute('open', '');
  expect(await page.locator('dc-family-row').count()).toBe(before);
});
