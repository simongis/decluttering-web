import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { appendFileSync } from 'node:fs';

/*
 * DC-107 (phase 1): accessibility audit. Runs axe (WCAG 2.0, 2.1 and 2.2 A/AA) on each page state, in light and dark, at 1280 px and
 * 400 px, then keyboard, names/roles, reduced-motion and zoom checks. Findings are in docs/research/a11y-audit.md (A11Y-nn).
 * Known findings are excluded or marked test.fail() with a comment naming the ID; the fixes phase removes those marks.
 *
 * Landing, demo, About and the demo Emails run on the built preview (baseURL). The simulator states (scan, solo org, header menu
 * while signed in) are dev-server only, so they use 5173 and skip themselves when it isn't running (as solo-org.spec.ts does).
 */
const DEV = 'http://localhost:5173';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SIZES = { desktop: { width: 1280, height: 900 }, phone: { width: 400, height: 800 } } as const;
const THEMES = ['light', 'dark'] as const;

test.setTimeout(180_000);

// DC-116: the demo now plays a 30 to 45 second scan first. Every state here that only needs Review or Emails asks for the quick demo;
// the 'demo-scan' state does not, so it audits the real demo scan screen.
test.beforeEach(async ({ page }, info) => {
  if (info.title.includes('demo-scan')) return;
  await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; });
});

/** Rules switched off for a known finding. Each entry names the finding that covers it (see docs/research/a11y-audit.md). */
const KNOWN: { rule: string; id: string }[] = [
  // Phase 2 (DC-117) fixed A11Y-01, 02, 03 and 10 on Review. A11Y-04 (Emails dialogs) is another worker's.
];

interface Hit { state: string; theme: string; size: string; rule: string; impact: string | null | undefined; nodes: string[] }

async function scan(page: Page, state: string, theme: string, size: string): Promise<string[]> {
  const res = await new AxeBuilder({ page }).withTags(TAGS).disableRules(KNOWN.map((k) => k.rule)).analyze();
  for (const v of res.violations) {
    const hit: Hit = ({ state, theme, size, rule: v.id, impact: v.impact, nodes: v.nodes.slice(0, 6).map((n) => n.target.join(' >> ') + ' :: ' + n.html.slice(0, 140)) });
    if (process.env.A11Y_DUMP) appendFileSync(process.env.A11Y_DUMP, JSON.stringify(hit) + String.fromCharCode(10));
  }
  return res.violations.map((v) => v.id);
}


/* ---------------------------------------------------------------- page states */
const settle = (page: Page) => page.waitForTimeout(500);
const reviewReady = async (page: Page) => { await expect(page.locator('dc-review [data-card]').first()).toBeVisible(); await settle(page); };
/** On a phone the rule panel is folded; open it so the info buttons are reachable. */
const openPanel = async (page: Page) => {
  const fold = page.locator('dc-review .panel-fold');
  if (await fold.isVisible() && (await fold.getAttribute('aria-expanded')) !== 'true') { await fold.click(); await settle(page); }
};


/** The demo Emails step: tick every owner on the review, press the Emails button, and (unless asked) close the first-visit intro. */
const toDemoEmails = async (page: Page, keepIntro = false) => {
  await page.goto('/#/demo'); await reviewReady(page);
  const cards = page.locator('dc-review [data-card]');
  for (let i = 0; i < await cards.count(); i++) {
    const cb = cards.nth(i).locator('calcite-label calcite-checkbox').first();
    if (!(await cb.evaluate((e) => (e as HTMLInputElement).checked))) {
      // Fall back to a script click if anything covers the tick box (A11Y-07 made the panel non-sticky on short screens).
      await cb.click({ timeout: 3000 }).catch(() => cb.evaluate((e) => { (e as HTMLInputElement).checked = true; e.dispatchEvent(new Event('calciteCheckboxChange', { bubbles: true })); }));
    }
  }
  await page.locator('[data-action="to-emails"]').click({ timeout: 5000 }).catch(() => page.locator('[data-action="to-emails"]').evaluate((e) => (e as HTMLElement).click()));
  await expect(page.locator('dc-emails .em-editor')).toBeVisible();
  const intro = page.locator('#em-intro');
  if (!keepIntro && await intro.evaluate((e) => (e as HTMLElement & { open: boolean }).open)) { await page.locator('#em-intro [data-action="intro-ok"]').click(); await expect(intro).not.toHaveAttribute('open', ''); }
  await settle(page);
};

interface PageState { id: string; dev?: boolean; go: (page: Page) => Promise<void> }
const SIM = 'n=200&speed=0.02';
const toSimReview = async (page: Page, q: string) => {
  await page.goto(`${DEV}/#/simulate?${q}`);
  const btn = page.locator('dc-scan-screen [data-action="review"]').first();
  await expect(btn).toBeVisible({ timeout: 90_000 });
  await btn.click();
  await expect(page.locator('dc-review .summary')).toBeVisible();
  await settle(page);
};

const stopOnceReviewIsOffered = async (page: Page) => {
  await page.goto(`${DEV}/#/simulate?n=600&speed=1`);
  await expect(page.locator('dc-scan-screen [data-action="review"]').first()).toBeVisible({ timeout: 60_000 });
  const stop = page.locator('dc-scan-screen [data-action="stop"]');
  await expect(stop).toBeVisible(); await stop.click();
  await expect(page.locator('[data-action="resume-link"]')).toBeVisible({ timeout: 30_000 }); await settle(page);
};

const STATES: PageState[] = [
  { id: 'landing', go: async (p) => { await p.goto('/#/'); await expect(p.locator('[data-page="landing"]')).toBeVisible(); await settle(p); } },
  { id: 'about', go: async (p) => { await p.goto('/#/about'); await expect(p.locator('dc-about')).toBeVisible(); await settle(p); } },
  { id: 'about-expanded', go: async (p) => {
    await p.goto('/#/about'); await expect(p.locator('dc-about')).toBeVisible();
    await p.evaluate(() => document.querySelectorAll('dc-about details').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
    await settle(p);
  } },
  { id: 'demo-scan', go: async (p) => { await p.goto('/#/demo'); await expect(p.locator('dc-scan-screen [data-scan="progress"]')).toBeVisible(); await p.waitForTimeout(2500); } },
  { id: 'demo-review', go: async (p) => { await p.goto('/#/demo'); await reviewReady(p); } },
  { id: 'demo-chart-owner', go: async (p) => {
    await p.goto('/#/demo'); await reviewReady(p);
    await p.locator('calcite-segmented-control-item[value="owner"]').first().click(); await expect(p.locator('dc-sankey')).toBeVisible(); await settle(p);
  } },
  { id: 'demo-popover-starting-point', go: async (p) => {
    await p.goto('/#/demo'); await reviewReady(p);
    await openPanel(p); await p.locator('#preset-info').click(); await expect(p.locator('calcite-popover[heading="Starting point"]')).toHaveAttribute('open', ''); await settle(p);
  } },
  { id: 'demo-popover-last-used', go: async (p) => {
    await p.goto('/#/demo'); await reviewReady(p);
    await openPanel(p); await p.locator('#usage-info').click(); await expect(p.locator('calcite-popover[heading="Last used"]')).toHaveAttribute('open', ''); await settle(p);
  } },
  { id: 'demo-user-menu', go: async (p) => {
    await p.goto('/#/demo'); await reviewReady(p);
    await p.locator('#dc-user').click(); await expect(p.locator('[data-menu="user"]')).toBeVisible(); await settle(p);
  } },
  { id: 'demo-emails', go: (p) => toDemoEmails(p) },
  { id: 'demo-emails-link-dialog', go: async (p) => {
    await toDemoEmails(p);
    await p.locator('calcite-button[label="Link"]').click(); await expect(p.locator('#em-link-dlg')).toHaveAttribute('open', ''); await settle(p);
  } },
  { id: 'demo-emails-intro-dialog', go: async (p) => {
    await toDemoEmails(p);
    await p.locator('calcite-action[text="Before you send"]').click(); await expect(p.locator('#em-intro')).toHaveAttribute('open', ''); await settle(p);
  } },
  { id: 'demo-emails-preview-confirm', go: async (p) => {
    await toDemoEmails(p);
    await p.locator('dc-emails [data-action="send"]').click(); await expect(p.locator('#em-confirm')).toHaveAttribute('open', ''); await settle(p);
  } },
  { id: 'sim-scanning', dev: true, go: async (p) => {
    await p.goto(`${DEV}/#/simulate?n=600&speed=1`);
    await expect(p.locator('dc-scan-screen [data-action="stop"]')).toBeVisible({ timeout: 60_000 }); await p.waitForTimeout(1500);
  } },
  // Stop before the basics are in: the scan screen says it didn't finish and offers Try again.
  { id: 'sim-stopped-early', dev: true, go: async (p) => {
    await p.goto(`${DEV}/#/simulate?n=600&speed=4`);
    const stop = p.locator('dc-scan-screen [data-action="stop"]');
    await expect(stop).toBeVisible({ timeout: 60_000 }); await p.waitForTimeout(700); await stop.click();
    await expect(p.locator('dc-scan-screen [data-action="retry"]')).toBeVisible({ timeout: 30_000 }); await settle(p);
  } },
  // Stop once Review is offered: the admin lands on Review with a "Scan stopped, Resume" line; the scan screen's stopped state is one click back.
  { id: 'sim-stopped', dev: true, go: (p) => stopOnceReviewIsOffered(p) },
  { id: 'sim-stopped-scan', dev: true, go: async (p) => {
    await stopOnceReviewIsOffered(p);
    await p.locator('[data-action="home"]').click(); // the logo goes to the scan screen when signed in
    await expect(p.locator('dc-scan-screen [data-action="resume"]')).toBeVisible(); await settle(p);
  } },
  { id: 'sim-scan-done', dev: true, go: async (p) => {
    await p.goto(`${DEV}/#/simulate?${SIM}`);
    await expect(p.locator('dc-scan-screen [data-action="review"]').first()).toBeVisible({ timeout: 90_000 }); await settle(p);
  } },
  { id: 'sim-review', dev: true, go: (p) => toSimReview(p, SIM) },
  { id: 'sim-review-solo', dev: true, go: (p) => toSimReview(p, `${SIM}&solo=1`) },
  { id: 'sim-user-menu', dev: true, go: async (p) => {
    await toSimReview(p, SIM);
    await p.locator('#dc-user').click(); await expect(p.locator('[data-menu="user"]')).toBeVisible(); await settle(p);
  } },
];

async function devUp(): Promise<boolean> { return fetch(DEV).then((r) => r.ok, () => false); }

for (const st of STATES) {
  for (const theme of THEMES) {
    for (const [sizeName, size] of Object.entries(SIZES)) {
      if (sizeName === 'phone' && theme === 'dark') continue; // trimmed matrix: dark at 1280 px only, 400 px in light only
      test(`axe: ${st.id} / ${theme} / ${sizeName}`, async ({ page }) => {
        if (st.dev) test.skip(!(await devUp()), 'Needs the dev server (npm run dev): the simulator is not in the preview build.');
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: theme });
        await st.go(page);
        const rules = await scan(page, st.id, theme, sizeName);
        expect(rules, `axe violations on ${st.id}`).toEqual([]);
      });
    }
  }
}

/* ---------------------------------------------------------------- shared helpers for the manual-pass checks */
function note(kind: string, detail: unknown): void {
  if (process.env.A11Y_DUMP) appendFileSync(process.env.A11Y_DUMP, JSON.stringify({ kind, detail }) + String.fromCharCode(10));
}

/** The focused element, looking through open shadow roots: a short description and whether it shows any focus indicator. */
async function focusInfo(page: Page): Promise<{ desc: string; visible: boolean; body: boolean }> {
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return { desc: 'body', visible: false, body: true };
    const label = (el.getAttribute('aria-label') || el.getAttribute('label') || el.getAttribute('title') || (el.textContent ?? '').trim().slice(0, 30) || '').replace(/\s+/g, ' ');
    // The indicator can be on the element, on its shadow host (Calcite draws it inside), or on a parent that shows :focus-within.
    const chain: Element[] = [];
    for (let n: Element | null = el; n && chain.length < 6; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) chain.push(n);
    const shows = chain.some((n) => {
      const cs = getComputedStyle(n);
      return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && /\d/.test(cs.boxShadow));
    });
    const host = (el.getRootNode() as ShadowRoot).host;
    return { desc: `${host ? host.tagName.toLowerCase() + ' > ' : ''}${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${label}"`, visible: shows, body: false };
  });
}

/** Calcite hosts do not delegate .focus(); their own setFocus() puts focus on the inner button, as a keyboard user would land. */
const focusEl = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const c = e as HTMLElement & { setFocus?: () => Promise<void> }; return c.setFocus ? c.setFocus() : c.focus(); });

async function tabThrough(page: Page, max: number): Promise<{ desc: string; visible: boolean }[]> {
  const seq: { desc: string; visible: boolean }[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focusInfo(page);
    if (f.body) break; // left the page into the browser chrome
    seq.push({ desc: f.desc, visible: f.visible });
  }
  return seq;
}

/* ---------------------------------------------------------------- keyboard pass */
test.describe('keyboard', () => {
  test('Tab order and visible focus: landing, demo review, About, demo Emails', async ({ page }) => {
    for (const p of ['/#/', '/#/demo', '/#/about', '/#/demo/emails']) {
      if (p.endsWith('/emails')) await toDemoEmails(page); else { await page.goto(p); await settle(page); }
      const seq = await tabThrough(page, 70);
      note('tab-order', { page: p, count: seq.length, sequence: seq });
      expect(seq.length, `something takes focus on ${p}`).toBeGreaterThan(0);
    }
  });

  test('Escape closes the info popovers and the user menu; where focus lands is recorded', async ({ page }) => {
    await page.setViewportSize(SIZES.desktop);
    await page.goto('/#/demo'); await reviewReady(page);
    for (const [btn, pop] of [['#preset-info', 'calcite-popover[heading="Starting point"]'], ['#usage-info', 'calcite-popover[heading="Last used"]'], ['#dc-user', 'calcite-popover[label="Account"]']] as const) {
      await focusEl(page, btn); await page.keyboard.press('Enter'); await settle(page);
      const isOpen = () => page.locator(pop).evaluate((e) => (e as HTMLElement & { open: boolean }).open);
      const opened = await isOpen();
      await page.keyboard.press('Escape'); await settle(page);
      const closed = !(await isOpen());
      const back = await focusInfo(page);
      note('escape-popover', { btn, opened, closed, focusAfter: back.desc });
      expect(opened, `${btn} opens from the keyboard`).toBe(true);
      expect(closed, `Escape closes ${btn}'s popover`).toBe(true);
    }
  });

  test('Escape closes the Emails dialogs; where focus lands is recorded', async ({ page }) => {
    await page.setViewportSize(SIZES.desktop);
    await toDemoEmails(page);
    const cases: [string, string][] = [
      ['calcite-action[text="Before you send"]', '#em-intro'],
      ['calcite-button[label="Link"]', '#em-link-dlg'],
      ['dc-emails [data-action="send"]', '#em-confirm'],
    ];
    for (const [trigger, dlg] of cases) {
      await focusEl(page, trigger); await page.keyboard.press('Enter'); await settle(page);
      const isOpen = () => page.locator(dlg).evaluate((e) => (e as HTMLElement & { open: boolean }).open);
      const opened = await isOpen();
      const inside = await focusInfo(page);
      await page.keyboard.press('Escape'); await settle(page);
      const closed = !(await isOpen());
      const back = await focusInfo(page);
      note('escape-dialog', { trigger, dlg, opened, focusInside: inside.desc, closed, focusAfter: back.desc });
      expect(opened, `${trigger} opens ${dlg}`).toBe(true);
      expect(closed, `Escape closes ${dlg}`).toBe(true);
    }
  });

  test('the dot map takes keyboard focus and the By owner bars are buttons', async ({ page }) => {
    await page.goto('/#/demo'); await reviewReady(page);
    await page.locator('dc-dot-map canvas').first().focus(); await page.keyboard.press('ArrowRight'); await settle(page);
    note('dot-map-keyboard', { liveAfterArrow: await page.locator('dc-dot-map .dm-sr').first().textContent() });
    await page.locator('calcite-segmented-control-item[value="owner"]').first().click();
    await expect(page.locator('dc-sankey')).toBeVisible();
    const bars = await page.locator('dc-sankey [role="button"]').count();
    note('sankey-buttons', { bars });
    expect(bars).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- names and roles */
test('names and roles: chips, usage bars, dot chart, icon-only controls', async ({ page }) => {
  await toDemoEmails(page);
  const chips = await page.locator('dc-emails .em-chips calcite-button').evaluateAll((els) => els.map((e) => ({ ph: e.getAttribute('data-ph'), text: (e.textContent ?? '').trim(), label: e.getAttribute('label') })));
  note('chips', chips);
  expect(chips.length).toBeGreaterThan(0);
  for (const c of chips) expect(c.text || c.label, `chip ${c.ph} has a name`).toBeTruthy();
  note('toolbar', await page.locator('dc-emails .em-tools calcite-button').evaluateAll((els) => els.map((e) => e.getAttribute('label') || (e.textContent ?? '').trim())));
  note('editor', await page.locator('dc-emails .em-editor').evaluate((e) => ({ role: e.getAttribute('role'), label: e.getAttribute('aria-label'), multi: e.getAttribute('aria-multiline') })));

  await page.goto('/#/demo'); await reviewReady(page);
  // DC-147c: the row's monthly bars are a button named by a full sentence (the sparkline and its tooltip are gone).
  const bars = await page.locator('dc-usage-bars button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  note('usage-bars', { count: bars.length, sample: bars.slice(0, 3) });
  expect(bars.length).toBeGreaterThan(0);
  for (const b of bars) expect(b).toMatch(/^Requests per month, past year: .+\. Click for details\.$/);
  expect(await page.locator('dc-sparkline').count()).toBe(0);
  const dot = await page.locator('dc-dot-map canvas').first().evaluate((e) => ({ role: e.getAttribute('role'), label: e.getAttribute('aria-label'), described: e.getAttribute('aria-describedby'), tabindex: e.getAttribute('tabindex') }));
  note('dot-map', dot);
  expect(dot.label, 'the dot chart canvas has a text alternative').toBeTruthy();
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('calcite-action, calcite-button, calcite-navigation-user, calcite-segmented-control, calcite-checkbox, calcite-switch, calcite-input')]
    .filter((e) => !(e.getAttribute('label') || e.getAttribute('text') || e.getAttribute('aria-label') || (e.textContent ?? '').trim() || e.closest('calcite-label')))
    .map((e) => e.outerHTML.slice(0, 120)));
  note('unnamed-controls', unnamed);
  expect(unnamed, 'calcite controls with no name').toEqual([]);
});

/* ---------------------------------------------------------------- reduced motion */
test('A11Y-07: the rules panel is not pinned on a short window, and is on a tall one', async ({ page }) => {
  for (const [h, pos] of [[500, 'static'], [900, 'sticky']] as const) {
    await page.setViewportSize({ width: 1280, height: h });
    await page.goto('/#/demo'); await reviewReady(page);
    expect(await page.locator('.dc-review-side').evaluate((e) => getComputedStyle(e).position), `panel position at ${h} px`).toBe(pos);
  }
});

test('A11Y-10: the info popover scroll areas are keyboard reachable and named', async ({ page }) => {
  await page.setViewportSize(SIZES.desktop);
  await page.goto('/#/demo'); await reviewReady(page);
  for (const btn of ['#preset-info', '#usage-info']) {
    await page.locator(btn).click(); await settle(page);
    const pop = page.locator(`calcite-popover[open] .pop`);
    expect(await pop.getAttribute('tabindex')).toBe('0');
    expect(await pop.getAttribute('aria-label')).toBeTruthy();
    await page.keyboard.press('Escape'); await settle(page);
  }
});

test('prefers-reduced-motion: reduce stops motion on the review, About, Emails and the user menu', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const running = () => page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && Number(a.effect?.getComputedTiming().duration ?? 0) > 1)
    .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'script'} ${Math.round(Number(a.effect?.getComputedTiming().duration ?? 0))}ms on ${(a.effect as KeyframeEffect | null)?.target?.tagName?.toLowerCase()}`));
  const states: [string, (p: Page) => Promise<void>][] = [
    ['demo review', async (p) => { await p.goto('/#/demo'); await reviewReady(p); }],
    ['demo review, user menu open', async (p) => { await p.goto('/#/demo'); await reviewReady(p); await p.locator('#dc-user').click(); await settle(p); }],
    ['demo review, popover open', async (p) => { await p.goto('/#/demo'); await reviewReady(p); await p.locator('#preset-info').click(); await settle(p); }],
    ['about', async (p) => { await p.goto('/#/about'); await settle(p); await p.locator('dc-about summary').first().click(); await settle(p); }],
    ['demo emails with dialog', async (p) => { await toDemoEmails(p); await p.locator('calcite-action[text="Before you send"]').click(); await settle(p); }],
  ];
  for (const [name, go] of states) {
    await go(page);
    const r = await running();
    note('reduced-motion', { state: name, running: r });
    expect(r, `animations still running under reduce on ${name}`).toEqual([]);
  }
});

/* ---------------------------------------------------------------- 200% zoom and reflow */
test('200% zoom (640 css px) and 320 px reflow: no horizontal scroll', async ({ page }) => {
  for (const [w, h] of [[640, 450], [320, 600]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const p of ['/#/', '/#/about', '/#/demo', '/#/demo/emails']) {
      if (p.endsWith('/emails')) await toDemoEmails(page); else { await page.goto(p); await settle(page); }
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      note('reflow', { page: p, width: w, scrollWidth: m.sw, clientWidth: m.cw });
      expect(m.sw, `${p} at ${w}px scrolls sideways`).toBeLessThanOrEqual(m.cw + 1);
    }
  }
});

/* ---------------------------------------------------------------- FB-72: do popovers and dialogs fit a small screen? */
interface Fit { name: string; viewport: string; spills: boolean; covered: boolean; flush: boolean; scrollsInside: boolean; top: number; bottom: number; contentBottom: number; innerHeight: number }

/** Measures the open calcite popover or dialog: where its box and its slotted content end, and whether something inside it scrolls. */
async function measureOverlay(page: Page, sel: string): Promise<Omit<Fit, 'name' | 'viewport'>> {
  return page.locator(sel).first().evaluate((host) => {
    const vh = window.innerHeight;
    const sr = host.shadowRoot!;
    const box = (sr.querySelector('.container') ?? sr.querySelector('.dialog') ?? host) as HTMLElement;
    const r = box.getBoundingClientRect();
    let scrollsInside = false;
    sr.querySelectorAll('*').forEach((e) => { const cs = getComputedStyle(e); if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1) scrollsInside = true; });
    let contentBottom = 0;
    host.querySelectorAll(':scope > *').forEach((c) => { const b = c.getBoundingClientRect(); if (b.height > 0) contentBottom = Math.max(contentBottom, b.bottom); });
    // A popover pinned flush to the bottom edge has its last line and its border at or past the edge (seen for "Last used" at 1280x720).
    const flush = host.tagName === 'CALCITE-POPOVER' && r.bottom >= vh - 2 && !scrollsInside;
    // The foot of a popover painted over by another layer (the sticky Next bar) hides its last lines (DC-114 / FB-72).
    let covered = false;
    if (host.tagName === 'CALCITE-POPOVER') {
      const at = document.elementFromPoint(r.left + r.width / 2, Math.min(r.bottom, vh) - 6);
      covered = !!at && at !== host && !host.contains(at) && !sr.contains(at);
    }
    const spills = r.bottom > vh + 1 || r.top < -1 || (contentBottom > vh + 1 && !scrollsInside) || flush || covered;
    return { spills, covered, flush, scrollsInside, top: Math.round(r.top), bottom: Math.round(r.bottom), contentBottom: Math.round(contentBottom), innerHeight: vh };
  });
}

// 1280x720 and 1366x768 laptop screens at 100%, 125% and 150% zoom (the CSS viewport shrinks by the zoom factor).
const SCREENS: [number, number, number][] = [[1280, 720, 1], [1366, 768, 1], [1280, 720, 1.25], [1366, 768, 1.25], [1280, 720, 1.5], [1366, 768, 1.5]];

/** Overlay name, how to reach it, the selector of the opened component. */
const OVERLAYS: { name: string; open: (p: Page) => Promise<void>; sel: string; emails?: boolean }[] = [
  { name: 'Review: Starting point popover', sel: 'calcite-popover[heading="Starting point"]', open: async (p) => { await openPanel(p); await p.locator('#preset-info').click(); } },
  { name: 'Review: Last used popover', sel: 'calcite-popover[heading="Last used"]', open: async (p) => { await openPanel(p); await p.locator('#usage-info').click(); } },
  { name: 'Header: account menu popover', sel: 'calcite-popover[label="Account"]', open: async (p) => { await p.locator('#dc-user').click(); } },
  { name: 'Emails: Before you send dialog', sel: '#em-intro', emails: true, open: async (p) => { await p.locator('calcite-action[text="Before you send"]').click(); } },
  { name: 'Emails: Add a link dialog', sel: '#em-link-dlg', emails: true, open: async (p) => { await p.locator('calcite-button[label="Link"]').click(); } },
  { name: 'Emails: Ready to send dialog', sel: '#em-confirm', emails: true, open: async (p) => { await p.locator('dc-emails [data-action="send"]').click(); } },
  { name: 'Emails: Turn on sending dialog', sel: '#turn-on-dialog', emails: true, open: async (p) => { await p.locator('dc-emails [data-action="test"]').click(); } },
  { name: 'Emails: Switch tone dialog', sel: '#em-tone-dlg', emails: true, open: async (p) => {
    await p.locator('#em-subject').evaluate((e) => { (e as HTMLInputElement).value = 'My own subject'; e.dispatchEvent(new CustomEvent('calciteInputInput', { bubbles: true })); });
    await p.locator('#em-tone calcite-segmented-control-item').nth(1).click();
  } },
];

for (const [w, h, zoom] of SCREENS) {
  const vp = `${w}x${h} @${Math.round(zoom * 100)}%`;
  test(`FB-72: popovers and dialogs fit ${vp}, or scroll inside themselves`, async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(10_000);
    await page.setViewportSize({ width: Math.round(w / zoom), height: Math.round(h / zoom) }); // zoom N% = a CSS viewport N times smaller
    const fits: Fit[] = [];
    for (const ov of OVERLAYS) {
      try {
        if (ov.emails) await toDemoEmails(page); else { await page.goto('/#/demo'); await reviewReady(page); }
        await ov.open(page); await page.waitForTimeout(700);
        fits.push({ name: ov.name, viewport: vp, ...(await measureOverlay(page, ov.sel)) });
      } catch (e) {
        note('overlay-unreachable', { name: ov.name, viewport: vp, error: String(e).slice(0, 140).replace(/\s+/g, ' ') });
      }
    }
    for (const f of fits) note('overlay-fit', f);
    const spilling = fits.filter((f) => f.spills && !KNOWN_SPILLS.some((k) => f.name === k.name));
    expect(spilling.map((f) => `${f.name} at ${f.viewport}`), 'overlays that spill off the screen').toEqual([]);
  });
}

/** Overlays that spill on a small screen, each covered by a finding in docs/research/a11y-audit.md. */
const KNOWN_SPILLS: { name: string; id: string }[] = []; // A11Y-06 fixed in DC-117
