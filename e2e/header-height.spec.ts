import { test, expect, type Page } from '@playwright/test';

/*
 * FB-86: switching between the standard and console looks must not change the header's height or move its labels. Measured
 * on the demo through the header's own skin toggle, at desktop and phone widths; every box within 1px.
 */
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

const SELECTORS = ['calcite-navigation', '.dc-name', '[data-action="skin-toggle"]', 'calcite-navigation-user', 'main'];

async function measure(page: Page) {
  return page.evaluate((sels) => {
    const out: Record<string, { top: number; height: number } | null> = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      const r = el?.getBoundingClientRect();
      out[s] = r ? { top: r.top, height: r.height } : null;
    }
    return out;
  }, SELECTORS);
}

for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`header height and label positions match in both looks: ${label}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/#/demo');
    await expect(page.locator('dc-review .list-head h2')).toBeVisible();
    const toggle = page.locator('calcite-navigation [data-action="skin-toggle"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const standard = await measure(page);

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'console');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(500);
    const consoleLook = await measure(page);

    for (const s of SELECTORS) {
      const a = standard[s];
      const b = consoleLook[s];
      expect(a, `${s} present`).not.toBeNull();
      expect(b, `${s} present in console look`).not.toBeNull();
      expect(Math.abs(a!.top - b!.top), `${s} top`).toBeLessThanOrEqual(1);
      if (s !== 'main') expect(Math.abs(a!.height - b!.height), `${s} height`).toBeLessThanOrEqual(1);
    }
  });
}
