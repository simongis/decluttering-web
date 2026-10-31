// DC-098 (FB-54, FB-55): the header shows who is signed in (avatar, menu with name, org and the two sign-out choices),
// and the logo goes home. The signed-in tests mock the whole OAuth round trip (no real sign-in, no credentials) and seed
// a cached scan, so the review shows at once while the mocked refresh fails politely.
import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// DC-116: the demo plays a 30 to 45 second scan; this spec only needs the Review page and public/demo/mock-small.json, so it asks for the quick demo.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

const data = JSON.parse(readFileSync(resolve(process.cwd(), 'public/demo/mock-small.json'), 'utf8')) as unknown;
const FAKE_TOKEN = 'fake-token';
// A 1 x 1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ADMIN = ['portal:admin:viewItems', 'portal:admin:viewUsers', 'portal:user:createGroup', 'portal:admin:assignToGroups'];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Seen { thumbUrl: string; thumbAuth: string | undefined }

/** Mocks ArcGIS sign-in, portals/self (with a profile picture) and the picture itself; everything else fails politely. */
async function mockArcGIS(page: Page, seen: Seen): Promise<void> {
  await page.route(/\/sharing\/rest\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost') return route.continue();
    const path = url.pathname.replace(/^.*\/sharing\/rest\//, '').replace(/\/+$/, '');
    if (path === 'oauth2/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? 'http://localhost:4173/');
      back.search = `?code=fake-code&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`;
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    if (path === 'oauth2/token') return json(route, { access_token: FAKE_TOKEN, expires_in: 7200, username: 'test.admin', ssl: true });
    if (path === 'portals/self') {
      return json(route, { id: 'testorg', name: 'Test Org', user: { username: 'test.admin', fullName: 'Test Admin', role: 'org_admin', privileges: ADMIN, thumbnail: 'me.png' } });
    }
    if (path === 'community/users/test.admin/info/me.png') {
      seen.thumbUrl = url.toString();
      seen.thumbAuth = await route.request().headerValue('x-esri-authorization') ?? undefined;
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG, headers: { 'access-control-allow-origin': '*' } });
    }
    return json(route, { error: { code: 400, message: 'Mocked in e2e', details: [] } });
  });
}

/** Seeds this origin with a fresh cached scan for test.admin, and a saved setting, before signing in. */
async function seedAndSignIn(page: Page): Promise<void> {
  await page.goto('/');
  const signIn = page.locator('[data-action="sign-in"]');
  await expect(signIn).toBeVisible();
  test.skip(await signIn.evaluate((e) => e.hasAttribute('disabled')), 'This build has no client ID, so sign-in is switched off.');
  await page.evaluate(async (d) => {
    localStorage.setItem('decluttering:e2e-marker', '1');
    const now = new Date().toISOString();
    const entry = { data: d, fetchedAt: { services: now, usage: now, users: now, dependencies: now }, savedAt: now };
    await new Promise<void>((ok, fail) => {
      const req = indexedDB.open('decluttering', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('cache'); };
      req.onerror = () => fail(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('cache', 'readwrite');
        tx.objectStore('cache').put(entry, 'scan:testorg:test.admin');
        tx.oncomplete = () => { req.result.close(); ok(); };
        tx.onerror = () => fail(tx.error);
      };
    });
  }, data);
  await signIn.click();
  await expect(page).toHaveURL(/#\/review$/, { timeout: 15_000 });
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible();
}

async function openMenu(page: Page) {
  await page.locator('calcite-navigation-user').click();
  const menu = page.locator('[data-menu="user"]');
  await expect(menu).toBeVisible();
  return menu;
}

test('signed in: avatar picture from a blob: URL fetched with the token in a header; the logo goes to Scan and the ticks survive', async ({ page }) => {
  const seen: Seen = { thumbUrl: '', thumbAuth: undefined };
  await mockArcGIS(page, seen);
  await seedAndSignIn(page);

  // The profile picture: token in the header only, shown from a blob: URL.
  await expect.poll(() => seen.thumbUrl).not.toBe('');
  expect(seen.thumbUrl).not.toContain(FAKE_TOKEN);
  expect(seen.thumbUrl).not.toMatch(/token=/i);
  expect(seen.thumbAuth).toBe(`Bearer ${FAKE_TOKEN}`);
  const user = page.locator('calcite-navigation-user');
  await expect(user).toHaveAttribute('full-name', 'Test Admin');
  await expect.poll(() => user.evaluate((e) => (e as unknown as { thumbnail: string }).thumbnail)).toMatch(/^blob:/);
  await expect(page.locator('[data-action="sign-out"]')).toHaveCount(0); // the old bottom-of-page button is gone

  const menu = await openMenu(page);
  await expect(menu.locator('[data-user-name]')).toHaveText('Test Admin');
  await expect(menu.locator('[data-user-org]')).toHaveText('Test Org');
  await expect(menu.locator('[data-action="sign-out-keep"]')).toBeVisible();
  await expect(menu.locator('[data-action="sign-out-clear"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Tick one owner, go home with the logo, come back: the tick is still there.
  const cb = page.locator('dc-review [data-card]').first().locator('calcite-label calcite-checkbox').first();
  const bar = page.locator('[data-bar="review"] [data-bar-main]');
  const before = await cb.evaluate((e) => (e as HTMLInputElement).checked);
  await cb.click();
  const ticked = await bar.textContent();
  expect(await cb.evaluate((e) => (e as HTMLInputElement).checked)).toBe(!before);

  const home = page.locator('a.dc-home');
  await expect(home).toHaveAttribute('aria-label', 'Decluttering, home');
  await home.click();
  await expect(page).toHaveURL(/#\/app$/);
  await expect(page.locator('dc-scan-screen')).toBeVisible();
  await expect(page.locator('dc-review')).toBeHidden();
  await page.locator('dc-scan-screen [data-action="review"]').click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(bar).toHaveText(ticked ?? '');
  expect(await cb.evaluate((e) => (e as HTMLInputElement).checked)).toBe(!before);

  // Sign out (keep saved data): the landing page, no session, the setting kept, the logo now goes to the landing page.
  await (await openMenu(page)).locator('[data-action="sign-out-keep"]').click();
  await expect(page.locator('[data-page="landing"]')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('calcite-navigation-user')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('decluttering:session'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('decluttering:e2e-marker'))).toBe('1');
  await expect(home).toHaveAttribute('href', '#/');
});

test('signed in: "Sign out and clear saved data" clears the session, settings and cached scan', async ({ page }) => {
  await mockArcGIS(page, { thumbUrl: '', thumbAuth: undefined });
  await seedAndSignIn(page);
  await (await openMenu(page)).locator('[data-action="sign-out-clear"]').click();
  await expect(page.locator('[data-page="landing"]')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('decluttering:session'))).toBeNull();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('decluttering:')))).toEqual([]);
  // The cache database is deleted once the app's open connection closes (here: on reload).
  await page.reload();
  await expect.poll(() => page.evaluate(async () => ((await indexedDB.databases()) ?? []).map((d) => d.name).filter((n) => n?.startsWith('decluttering')))).toEqual([]);
});

test('demo: keyboard reaches the logo and the demo user; the menu offers "Leave the demo"; the logo goes to the demo start', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible();

  // From the top of the page: the logo link first, then About (DC-021), the theme toggle (DC-135), then the account button.
  await page.keyboard.press('Tab');
  await expect(page.locator('a.dc-home')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-action="about"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-action="skin-toggle"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('calcite-navigation-user')).toBeFocused();
  await expect(page.locator('calcite-navigation-user')).toHaveAttribute('label', 'Account menu for Demo admin');
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-menu="user"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-user-name]')).toHaveText('Demo admin');
  await expect(menu.locator('[data-user-org]')).toHaveText('Riverside Studio');
  await expect(menu.locator('[data-action="sign-out-keep"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Tick, go to the Emails step, then the logo back to the demo's start: the tick is still there.
  const cards = page.locator('dc-review [data-card]');
  for (let i = 0; i < await cards.count(); i++) {
    const cb = cards.nth(i).locator('calcite-label calcite-checkbox').first();
    if (!(await cb.evaluate((e) => (e as HTMLInputElement).checked))) await cb.click();
  }
  const bar = page.locator('[data-bar="review"] [data-bar-main]');
  const ticked = await bar.textContent();
  await page.locator('[data-action="to-emails"]').click();
  await expect(page).toHaveURL(/#\/demo\/emails$/);
  await page.locator('#em-intro [data-action="intro-ok"]').click();
  await page.locator('a.dc-home').click();
  await expect(page).toHaveURL(/#\/demo$/);
  await expect(bar).toHaveText(ticked ?? '');

  await page.locator('calcite-navigation-user').click();
  await menu.locator('[data-action="leave-demo"]').click();
  await expect(page.locator('[data-page="landing"]')).toBeVisible();
  await expect(page.locator('calcite-navigation-user')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('phones (400 px): avatar only, nothing overflows; the menu still shows the name', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto('/#/demo');
  await expect(page.locator('dc-review [data-card]').first()).toBeVisible();
  const user = page.locator('calcite-navigation-user');
  await expect(user).toHaveAttribute('text-disabled', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await user.click();
  const menu = page.locator('[data-menu="user"]');
  await expect(menu.locator('[data-user-name]')).toHaveText('Demo admin');
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(400);
});

// DC-120 (FB-81): the account menu paints above page content (sticky bars, Calcite panel headers, side columns) on every screen.
/** Opens the account menu, checks that the menu itself is what is hit at its centre and lower left, then closes it. */
async function expectMenuOnTop(page: Page): Promise<void> {
  await page.locator('calcite-navigation-user').click();
  const menu = page.locator('[data-menu="user"]');
  await expect(menu).toBeVisible();
  await page.waitForTimeout(400); // let the popover settle
  const bad = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const bad: string[] = [];
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 8, r.bottom - 8]]) {
      let hit: Element | null = document.elementFromPoint(x, y);
      const first = hit ? `${hit.tagName}.${hit.className}` : 'none';
      let found = false;
      while (hit) { if (hit === el) { found = true; break; } hit = hit.parentElement ?? ((hit.getRootNode() as ShadowRoot).host ?? null); }
      if (!found) bad.push(first);
    }
    return bad;
  });
  expect(bad).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

for (const vp of [{ width: 1280, height: 720 }, { width: 390, height: 800 }]) {
  test(`demo: the account menu is on top of Review, Emails and the start page (${vp.width} px)`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/#/demo');
    await expect(page.locator('dc-review [data-card]').first()).toBeVisible();
    await expectMenuOnTop(page); // Review
    await page.locator('[data-action="to-emails"]').click();
    await expect(page).toHaveURL(/#\/demo\/emails$/);
    const intro = page.locator('#em-intro [data-action="intro-ok"]');
    // The first-visit dialog opens a moment after the page changes: wait for it (fresh storage always shows it), then dismiss.
    await intro.waitFor({ state: 'visible', timeout: 5000 }).then(() => intro.click(), () => undefined);
    await expect(page.locator('#em-intro')).not.toHaveAttribute('open', /.*/);
    await expectMenuOnTop(page); // Emails
    await page.locator('a.dc-home').click();
    await expect(page).toHaveURL(/#\/demo$/);
    await expectMenuOnTop(page); // back at the start
  });

  test(`signed in: the account menu is on top of Scan and About (${vp.width} px)`, async ({ page }) => {
    await page.setViewportSize(vp);
    await mockArcGIS(page, { thumbUrl: '', thumbAuth: undefined });
    await seedAndSignIn(page);
    await page.locator('a.dc-home').click();
    await expect(page.locator('dc-scan-screen')).toBeVisible();
    await expectMenuOnTop(page); // Scan
    await page.locator('[data-action="about"]').click();
    await expect(page).toHaveURL(/about/);
    await expectMenuOnTop(page); // About
  });
}
