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

test('demo: choosing layers with the checkboxes counts them, Select all picks every row, and Delete selected opens the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const before = await page.locator('dc-family-row').count();
  const bulk = page.locator('[data-action="delete-selected"]');
  await expect(bulk).toHaveAttribute('disabled', '');
  await expect(page.locator('[data-del-count]')).toContainText('Select the layers');
  await page.locator('dc-family-row [data-action="pick-delete"]').nth(0).click();
  await page.locator('dc-family-row [data-action="pick-delete"]').nth(1).click();
  await expect(page.locator('[data-del-count]')).toContainText('2 layers selected');
  await expect(bulk).not.toHaveAttribute('disabled', '');
  await page.locator('[data-action="del-all"]').click();
  await expect(page.locator('[data-del-count]')).toContainText(`${before} layers selected`);
  await page.locator('[data-action="del-all"]').click();
  await expect(page.locator('[data-del-count]')).toContainText('Select the layers');
  await page.locator('dc-family-row [data-action="pick-delete"]').nth(0).click();
  await page.locator('dc-family-row [data-action="pick-delete"]').nth(1).click();
  await bulk.click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  await expect(page.locator('dc-delete-dialog [data-delete-item]')).toHaveCount(2);
  const results = await new AxeBuilder({ page }).include('dc-delete-dialog').include('[data-bar="delete-select"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.locator('dc-delete-dialog [data-action="delete-cancel"]').click();
  await expect(dialog(page)).not.toHaveAttribute('open', '');
  expect(await page.locator('dc-family-row').count()).toBe(before);
  // Delete them: both leave the list and the selection resets.
  await bulk.click();
  await typeWord(page, 'DELETE');
  await page.locator('dc-delete-dialog [data-action="delete-go"]').click();
  await expect(page.locator('dc-delete-dialog [data-delete="done"]')).toContainText('Deleted 2 layers.');
  await page.locator('dc-delete-dialog [data-action="delete-close"]').click();
  await expect.poll(() => page.locator('dc-family-row').count()).toBe(before - 2);
  await expect(page.locator('[data-del-count]')).toContainText('Select the layers');
});
test('demo: every row has a visible Delete button that opens the dialog for that layer only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const rows = page.locator('dc-family-row');
  expect(await page.locator('dc-family-row [data-action="delete-row"]').count()).toBe(await rows.count());
  await rows.first().locator('[data-action="delete-row"]').click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  await expect(page.locator('dc-delete-dialog [data-delete-item]')).toHaveCount(1);
  await page.locator('dc-delete-dialog [data-action="delete-cancel"]').click();
  await expect(dialog(page)).not.toHaveAttribute('open', '');
});

/** A drawn dot on the Review chart, in page coordinates. */
const chartDot = async (page: Page) => {
  const canvas = page.locator('dc-review dc-dot-map canvas');
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200); // the dots finish fading in
  const box = (await canvas.boundingBox())!;
  const pt = await page.locator('dc-review dc-dot-map').evaluate((m) => {
    const s = (m as unknown as { sprites: { x: number; y: number; rad: number; id: string }[] }).sprites.find((d) => d.rad > 2);
    return s ? { x: s.x, y: s.y, id: s.id } : null;
  });
  expect(pt, 'the demo chart has a dot').not.toBeNull();
  return { box, x: box.x + pt!.x, y: box.y + pt!.y, id: pt!.id };
};

test('demo: a rectangle on the chart adds the layers in it to the delete selection, shown under the chart and in the bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/demo');
  await reviewReady(page);
  await expect(page.locator('[data-scan="select-hint"]')).toBeVisible();
  const { box } = await chartDot(page);
  await expect(page.locator('[data-chart-sel-count]')).toContainText('No layers selected');
  await expect(page.locator('[data-action="chart-sel-delete"]')).toHaveAttribute('disabled', '');
  await page.mouse.move(box.x + 72, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.move(box.x + box.width - 16, box.y + box.height - 42, { steps: 8 });
  await page.mouse.up();
  const count = page.locator('[data-chart-sel-count]');
  await expect(count).toBeVisible();
  const n = Number((await count.innerText()).match(/\d+/)![0]);
  expect(n).toBeGreaterThan(1);
  await expect(page.locator('[data-del-count]')).toContainText(`${n} layers selected`);
  // A second rectangle adds (never fewer).
  await page.mouse.move(box.x + 72, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 80, { steps: 6 });
  await page.mouse.up();
  expect(Number((await count.innerText()).match(/\d+/)![0])).toBeGreaterThanOrEqual(n);
  // The selection deletes from under the chart.
  await page.locator('[data-action="chart-sel-delete"]').click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  expect(await page.locator('dc-delete-dialog [data-delete-item]').count()).toBeGreaterThanOrEqual(n);
  await page.locator('dc-delete-dialog [data-action="delete-cancel"]').click();
  await page.locator('[data-action="chart-sel-clear"]').click();
  await expect(page.locator('[data-chart-sel-count]')).toContainText('No layers selected');
});

test('demo: a click on a dot asks whether to view or delete it; View opens the item, Delete opens the dialog for it', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const dot = await chartDot(page);
  await page.mouse.click(dot.x, dot.y);
  const tip = page.locator('dc-review .dm-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute('role', 'dialog');
  await expect(tip.locator('[data-dot-action="view"]')).toBeVisible();
  await expect(tip.locator('[data-dot-action="delete"]')).toBeVisible();
  // Nothing opened by the click itself.
  expect(context.pages()).toHaveLength(1);
  const [tab] = await Promise.all([context.waitForEvent('page'), tip.locator('[data-dot-action="view"]').click()]);
  expect(tab.url()).toContain(dot.id);
  await tab.close();
  await expect(tip).toBeHidden();
  await page.mouse.click(dot.x, dot.y);
  await tip.locator('[data-dot-action="delete"]').click();
  await expect(dialog(page)).toHaveAttribute('open', '');
  await expect(page.locator('dc-delete-dialog [data-delete-item]')).toHaveCount(1);
  await expect(page.locator(`dc-delete-dialog [data-delete-item="${dot.id}"]`)).toHaveCount(1);
  const results = await new AxeBuilder({ page }).include('dc-review dc-dot-map').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.locator('dc-delete-dialog [data-action="delete-cancel"]').click();
});

test('demo: Enter on a focused dot opens the same menu, and Escape closes it back to the chart', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/demo');
  await reviewReady(page);
  await chartDot(page);
  await page.locator('dc-review dc-dot-map canvas').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const tip = page.locator('dc-review .dm-tip');
  await expect(tip.locator('[data-dot-action="view"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(page.locator('dc-review dc-dot-map canvas')).toBeFocused();
});
