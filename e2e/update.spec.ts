import { test, expect, type Page } from '@playwright/test';
/*
 * Keeping the app up to date (src/update): version.json is published with the build, a newer build shows a Reload banner,
 * the reload skips a cached index.html with ?b=, and the first load of a new build clears the saved scan.
 */
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

const runningBuild = (page: Page) => page.evaluate(() => localStorage.getItem('decluttering:build'));
const savedScans = (page: Page) => page.evaluate(() => new Promise<string[]>((ok) => {
  const req = indexedDB.open('decluttering', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('cache'); };
  req.onerror = () => ok([]);
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('cache')) { db.close(); ok([]); return; }
    const r = db.transaction('cache').objectStore('cache').getAllKeys();
    r.onsuccess = () => { db.close(); ok(r.result.map(String)); };
    r.onerror = () => { db.close(); ok([]); };
  };
}));
const seedScan = (page: Page) => page.evaluate(() => new Promise<void>((ok, fail) => {
  const req = indexedDB.open('decluttering', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('cache'); };
  req.onerror = () => fail(req.error);
  req.onsuccess = () => {
    const tx = req.result.transaction('cache', 'readwrite');
    tx.objectStore('cache').put({ data: {}, savedAt: new Date().toISOString() }, 'scan:testorg:someone');
    tx.oncomplete = () => { req.result.close(); ok(); };
    tx.onerror = () => fail(tx.error);
  };
}));

test('the build publishes version.json, and the app running it shows no banner', async ({ page }) => {
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  const v = await (await page.request.get('/version.json')).json() as { build: string; commit: string };
  expect(v.build).toMatch(/^[0-9a-f]+\+?-[0-9a-z]+$|^unknown-/);
  expect(await runningBuild(page)).toBe(v.build);
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-update="available"]')).toHaveCount(0);
});

test('a newer build on the server: a banner offers Reload, which loads it past a cached index.html', async ({ page }) => {
  await page.route('**/version.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ build: 'zz-newer', commit: 'zz' }) }));
  await page.goto('/#/demo');
  const banner = page.locator('[data-update="available"]');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('A new version of Decluttering is available');
  const nav = page.waitForRequest((r) => r.isNavigationRequest() && r.url().includes('b=zz-newer'));
  await page.locator('[data-action="update-reload"]').click();
  await nav;
  await page.waitForLoadState('domcontentloaded');
  // Once loaded, the address bar is clean again and the page is still the one the user was on.
  await expect.poll(() => page.url()).not.toContain('b=');
  expect(page.url()).toContain('#/demo');
  // "Later" hides it for now.
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-action="update-later"]').click();
  await expect(banner).toHaveCount(0);
});

test('the first load of a new build clears the saved scan; a reload of the same build keeps it', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => runningBuild(page)).not.toBeNull();
  await seedScan(page);
  expect(await savedScans(page)).toEqual(['scan:testorg:someone']);
  await page.reload();
  await expect.poll(() => runningBuild(page)).not.toBeNull();
  expect(await savedScans(page), 'same build: the saved scan stays').toEqual(['scan:testorg:someone']);
  // As if the last build in this browser was another one.
  await page.evaluate(() => { localStorage.setItem('decluttering:build', 'an-older-build'); localStorage.setItem('decluttering:locale', 'es'); });
  await page.reload();
  await expect.poll(() => runningBuild(page)).not.toBe('an-older-build');
  expect(await savedScans(page), 'new build: the saved scan is gone').toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('decluttering:locale')), 'settings stay').toBe('es');
});

test('Review, By owner: a mouse click anywhere on an owner filters the list, and a second click clears it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 });
  const cards = page.locator('dc-review [data-card]');
  const all = await cards.count();
  test.skip(all < 2, 'The demo needs two owners on the list.');
  await page.locator('dc-review [data-action="chart-view"] calcite-segmented-control-item[value="owner"]').click();
  const node = page.locator('dc-review dc-sankey [role="button"][data-node]').first();
  await expect(node).toBeVisible();
  const id = await node.getAttribute('data-node');
  const box = (await node.boundingBox())!;
  // Its empty part, left of the name: before the fix nothing there took the click. The same spot twice: the chart
  // must not move when an owner is picked (the chip above it has its row from the start).
  for (const [fx, fy] of [[0.1, 0.5], [0.5, 0.15], [0.5, 0.85]] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    expect(Math.abs((await node.boundingBox())!.y - box.y), 'the chart stays put').toBeLessThan(1);
    await expect(cards, `click at ${fx},${fy} filters`).toHaveCount(1);
    await expect(page.locator(`dc-review [data-card="${id}"]`)).toHaveCount(1);
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await expect(cards, `second click at ${fx},${fy} clears`).toHaveCount(all);
  }
});
