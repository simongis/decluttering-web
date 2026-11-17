import { test, expect, type Page } from '@playwright/test';
/*
 * ADR 0016: deleting through the signed-in code path, on the dev simulator (dev server only, like solo-org.spec.ts). The
 * simulator's remover is the demo stand-in: nothing is sent anywhere. Skips itself without the dev server on 5173, or when
 * that server's build has deleting off.
 */
const DEV = process.env.E2E_DEV_URL ?? 'http://localhost:5173'; // E2E_DEV_URL: a dev server on another port
test.use({ baseURL: DEV });
test.setTimeout(180_000);
test.beforeEach(async () => {
  const up = await fetch(DEV).then((r) => r.ok, () => false);
  test.skip(!up, 'Needs the dev server (npm run dev): the simulator is not in the preview build.');
});

/** Opens Review on the simulator as `role`. Returns false (and skips) when the dev server has deleting off. */
const openAs = async (page: Page, query: string) => {
  await page.goto(`/#/simulate?${query}`);
  await expect(page.locator('.dc-ver')).toBeVisible({ timeout: 30_000 });
  test.skip(/deleting off|borrado desactivado/.test(await page.locator('.dc-ver').innerText()), 'The dev server has VITE_DELETING off.');
  const go = page.locator('dc-scan-screen [data-action="review"]').first();
  await expect(go).toBeVisible({ timeout: 120_000 });
  await go.click();
  await expect(page.locator('dc-review')).toBeVisible();
};

test('simulator, My items: a member can select and delete their own layers (no chart, no email ticks)', async ({ page }) => {
  await openAs(page, 'n=60&speed=1&solo=1&role=member');
  await expect(page.locator('dc-review section[data-page="review"], [data-page="review"]').first()).toHaveAttribute('data-mode', 'my-items');
  const bar = page.locator('[data-bar="delete-select"]');
  await expect(bar).toHaveAttribute('data-delete-status', 'ready', { timeout: 120_000 });
  await expect(page.locator('dc-review dc-dot-map')).toHaveCount(0); // My items has no chart
  const picks = page.locator('dc-family-row [data-action="pick-delete"]');
  const n = await picks.count();
  test.skip(n === 0, 'The rule left nothing on the list for this seed.');
  await picks.first().click();
  await expect(page.locator('[data-del-count]')).toContainText(/1 layer selected|1 capa seleccionada/);
  await page.locator('[data-action="delete-selected"]').click();
  await expect(page.locator('dc-delete-dialog [data-delete-item]')).toHaveCount(1);
  await page.locator('dc-delete-dialog [data-delete="typed"] input').fill(/capa/.test(await page.locator('[data-del-count]').innerText()) ? 'BORRAR' : 'DELETE');
  await page.locator('dc-delete-dialog [data-action="delete-go"]').click();
  await expect(page.locator('dc-delete-dialog [data-delete="done"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('dc-delete-dialog [data-action="delete-close"]').click();
  await expect.poll(() => page.locator('dc-family-row [data-action="pick-delete"]').count()).toBe(n - 1);
});

test('simulator, an admin without the delete privileges: the bar says why, and no Delete anywhere', async ({ page }) => {
  await openAs(page, 'n=60&speed=1&role=viewer');
  const bar = page.locator('[data-bar="delete-select"]');
  await expect(bar).toHaveAttribute('data-delete-status', 'no-privilege', { timeout: 60_000 });
  await expect(bar.locator('[data-del-why]')).toContainText(/privilege|privilegio/);
  await expect(page.locator('[data-action="delete-row"], [data-action="pick-delete"], [data-chart-sel]')).toHaveCount(0);
});

test('simulator, admin: while maps and apps are still being read, the bar says it is waiting', async ({ page }) => {
  // Slow maps and apps: Review opens on the core, before dependencies are in.
  await openAs(page, 'n=400&speed=0.25&maps=600');
  const bar = page.locator('[data-bar="delete-select"]');
  await expect(bar).toBeVisible({ timeout: 60_000 });
  const first = await bar.getAttribute('data-delete-status');
  test.skip(first === 'ready', 'Maps and apps were read before Review opened on this machine.');
  expect(first).toBe('waiting');
  await expect(page.locator('[data-action="pick-delete"]')).toHaveCount(0);
  await expect(bar).toHaveAttribute('data-delete-status', 'ready', { timeout: 170_000 });
});

test('simulator, admin: a rectangle offers the small layers in its area that the chart does not draw, and Include adds them', async ({ page }) => {
  await openAs(page, 'n=1200&speed=1');
  await expect(page.locator('[data-bar="delete-select"]')).toHaveAttribute('data-delete-status', 'ready', { timeout: 170_000 });
  const map = page.locator('dc-review dc-dot-map');
  const canvas = map.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const { drawn, all } = await map.evaluate((m) => ({ drawn: (m as unknown as { sprites: unknown[] }).sprites.length, all: (m as unknown as { model: { dots: unknown[] } }).model.dots.length }));
  expect(all, 'this org has layers under the small-layer floor').toBeGreaterThan(drawn);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 72, box.y + 13);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 15, box.y + box.height - 41, { steps: 10 });
  await page.mouse.up();
  const count = () => page.locator('[data-chart-sel-count]').innerText().then((t) => Number(t.match(/\d[\d,.]*/)![0].replace(/[,.]/g, '')));
  expect(await count()).toBe(drawn);
  await expect(page.locator('[data-rect-hidden]')).toContainText(String(all - drawn));
  await page.locator('[data-action="rect-include-hidden"]').click();
  expect(await count()).toBe(all);
  await expect(page.locator('[data-rect-hidden]')).toHaveCount(0);
});
