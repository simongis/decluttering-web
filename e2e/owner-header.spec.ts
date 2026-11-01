import { test, expect } from '@playwright/test';

/** DC-148: at phone width an owner card's name never runs under the "N services" chip, in either look. */
for (const look of ['standard', 'console'] as const) {
  test(`owner card header: the name never overlaps the chips at 390 px: ${look}`, async ({ page }) => {
    await page.addInitScript((look) => {
      (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true;
      if (look === 'console') localStorage.setItem('decluttering:skin', '"console"');
    }, look);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/#/demo');
    await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('dc-review [data-card]')].map((c) => {
      const r = (e: Element | null) => (e as HTMLElement).getBoundingClientRect();
      const name = r(c.querySelector('.owner-id strong'));
      return { owner: c.getAttribute('data-card'), name: { l: name.left, r: name.right, t: name.top, b: name.bottom },
        chips: [...c.querySelectorAll('.owner-chips calcite-chip')].map((x) => { const k = r(x); return { l: k.left, r: k.right, t: k.top, b: k.bottom }; }) };
    }));
    expect(boxes.length).toBeGreaterThan(0);
    for (const o of boxes) {
      expect(o.chips.length, o.owner ?? '').toBeGreaterThan(0);
      for (const c of o.chips) {
        const overlap = o.name.l < c.r && c.l < o.name.r && o.name.t < c.b && c.t < o.name.b;
        expect(overlap, `${o.owner}: name overlaps a chip`).toBe(false);
      }
    }
  });
}
