import { expect, test } from '@playwright/test';

// ADR 0015: the language lives in the account menu (not the header); signed out, the landing page offers the other language.
test('the account menu switches the app to Spanish and remembers it; the header has no language control', async ({ page }) => {
  await page.goto('/#/demo');
  await expect(page.locator('[data-steps]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-step="review"]')).toContainText('Review');
  await expect(page.locator('calcite-navigation [slot="content-end"][data-action="language"]')).toHaveCount(0);

  await page.locator('calcite-navigation-user').click();
  const row = page.locator('[data-menu="user"] calcite-segmented-control[data-action="language"]');
  await expect(row).toBeVisible();
  await expect(row.locator('calcite-segmented-control-item[value="es"]')).toHaveAttribute('lang', 'es');
  await row.locator('calcite-segmented-control-item[value="es"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('[data-step="review"]')).toContainText('Revisión');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('[data-step="review"]')).toContainText('Revisión');
});

test('signed out, the landing page offers the other language by its own name', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('[data-action="landing-language"] calcite-link[data-locale="es"]');
  await expect(link).toHaveText('Español');
  await link.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('[data-action="landing-language"] calcite-link[data-locale="en"]')).toHaveText('English');
});
