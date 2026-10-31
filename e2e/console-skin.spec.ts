import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/*
 * DC-135 (ADR 0014): the console look. The standard look is untouched by default; the look switch in the header (sun off,
 * delta on) switches the console look on, with the console logo; it survives a reload; the same switch turns it off. axe passes in the
 * console look on About and the demo review.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

test('standard by default; the header toggle turns the console look on, it survives a reload, and toggles back', async ({ page }) => {
  await page.goto('/#/about');
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-skin', /.*/);
  await expect(html).toHaveClass(/calcite-mode-light/);
  expect(await page.locator('#dc-skin-font').count()).toBe(0);
  await expect(page.locator('dc-about [data-action="console-look"]')).toHaveCount(0); // the old About badge is gone

  const toggle = page.locator('calcite-navigation [data-action="skin-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveAccessibleName('Console look');
  await expect(page.locator('.dc-logo img')).toHaveAttribute('src', /brand-mark\.svg$/);
  const box = await toggle.boundingBox();
  expect(box && box.width >= 24 && box.height >= 24).toBe(true);

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(html).toHaveAttribute('data-skin', 'console');
  await expect(html).toHaveClass(/calcite-mode-dark/);
  await expect(page.locator('body')).toHaveClass(/calcite-mode-dark/);
  await expect(page.locator('#dc-skin-font')).toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.dc-logo img')).toHaveAttribute('src', /brand-mark-console\.svg$/);
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--calcite-color-background').trim())).toBe('#000');

  await page.reload();
  await expect(html).toHaveAttribute('data-skin', 'console');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();
  await expect(html).not.toHaveAttribute('data-skin', /.*/);
  await expect(html).toHaveClass(/calcite-mode-light/);
  await expect(page.locator('.dc-logo img')).toHaveAttribute('src', /brand-mark\.svg$/);
  await page.reload();
  await expect(html).not.toHaveAttribute('data-skin', /.*/);
});

for (const [name, hash] of [['about', '#/about'], ['demo review', '#/demo'], ['demo emails', '#/demo']] as const) {
  test(`axe passes in the console look: ${name}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('decluttering:skin', '"console"'));
    await page.goto(`/${hash}`);
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'console');
    if (hash === '#/about') await expect(page.locator('dc-about h1')).toBeVisible();
    else await expect(page.locator('dc-review [data-card]').first()).toBeVisible();
    if (name === 'demo emails') {
      await page.locator('[data-action="to-emails"]').click();
      await expect(page.locator('calcite-panel.em-edit')).toBeVisible();
      await page.getByRole('button', { name: 'Got it' }).click().catch(() => {});
    }
    const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}
