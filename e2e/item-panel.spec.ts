import { test, expect, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/*
 * DC-147c: the row's monthly bars, their hover card, and the item panel. Demo runs on the built preview (baseURL); the
 * simulator (a family with more than 8 maps or apps, "+N more") needs the dev server on 5173 and skips itself without it.
 * Opening the panel paints from the scan already in memory; after it has painted (DC-147d) it may ask ArcGIS Online's
 * relatedItems for the family's maps, and nothing else. The demo and the simulator answer those from memory (no network),
 * so the panel's own call log (`relatedLog`) is what the specs read.
 */
const DEV = 'http://localhost:5173';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
test.setTimeout(180_000);
// The idle pre-fetch (DC-147d) is switched off except in its own spec, so a panel open is what asks relatedItems here.
test.beforeEach(async ({ page }, info) => {
  const idle = /idle pre-fetch/.test(info.title);
  await page.addInitScript((idle) => {
    const w = window as unknown as { __DC_DEMO_FAST__?: boolean; __DC_RELATED_IDLE_OFF__?: boolean };
    w.__DC_DEMO_FAST__ = true;
    if (!idle) w.__DC_RELATED_IDLE_OFF__ = true;
  }, idle);
});

const devUp = (): Promise<boolean> => fetch(DEV).then((r) => r.ok, () => false);
const reviewReady = async (page: Page) => { await expect(page.locator('dc-review [data-card]').first()).toBeVisible({ timeout: 60_000 }); await page.waitForTimeout(400); };
const panel = (page: Page) => page.locator('dc-item-panel calcite-sheet');
const isOpen = (page: Page) => panel(page).evaluate((e) => (e as HTMLElement & { open: boolean }).open);

/**
 * Calcite's icon files are fetched the first time an icon is drawn, and code is loaded once (the quick demo's relatedItems
 * stand-in is a lazy chunk); anything else would be data, which the panel must not fetch over the network.
 */
const isAsset = (r: Request) => { const p = new URL(r.url()).pathname; return /\/assets\/icon\/[^/]+\.json$/.test(p) || /\.(js|ts|mjs)$/.test(p) || p.startsWith('/@') || p.startsWith('/node_modules/'); };

type LogEntry = { mapId: string; path: string; kind: string; at: number };
const relatedLog = (page: Page): Promise<LogEntry[]> => page.locator('dc-item-panel').evaluate((e) => [...(e as unknown as { relatedLog: LogEntry[] }).relatedLog]);

/** Watches for the panel's headline to appear (painted) and notes the time and how many relatedItems calls had been sent then. */
const watchPaint = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __paint?: { at: number; calls: number } };
  delete w.__paint;
  const panel = document.querySelector('dc-item-panel') as unknown as HTMLElement & { relatedLog: unknown[] };
  const mo = new MutationObserver(() => {
    if (!w.__paint && panel.querySelector('[data-usage-headline]')) { w.__paint = { at: Date.now(), calls: panel.relatedLog.length }; mo.disconnect(); }
  });
  mo.observe(panel, { childList: true, subtree: true });
});
const painted = (page: Page) => page.evaluate(() => (window as unknown as { __paint?: { at: number; calls: number } }).__paint ?? null);

/** The used-directly web maps and scenes of the open family (what relatedItems may be asked for). */
const familyMaps = (page: Page): Promise<string[]> => page.locator('dc-item-panel').evaluate((e) => {
  const row = (e as unknown as { row: { source: { dependencies: { id: string; type: string }[] }; views: { dependencies: { id: string; type: string }[] }[] } }).row;
  return [...new Set([row.source, ...row.views].flatMap((s) => s.dependencies).filter((d) => d.type === 'Web Map' || d.type === 'Web Scene').map((d) => d.id))];
});

/**
 * Opens the panel by clicking `opener`; returns the network requests (not icons or code) made from the click until the
 * panel has painted and settled, and the relatedItems calls the panel sent from the click on.
 */
async function openCounting(page: Page, opener: ReturnType<Page['locator']>): Promise<{ network: string[]; related: LogEntry[]; paint: { at: number; calls: number } | null }> {
  const seen: string[] = [];
  const on = (r: Request) => { if (!isAsset(r)) seen.push(`${r.method()} ${r.url()}`); };
  const before = (await relatedLog(page)).length;
  await watchPaint(page);
  page.on('request', on);
  await opener.click();
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await page.waitForTimeout(600);
  page.off('request', on);
  return { network: seen, related: (await relatedLog(page)).slice(before), paint: await painted(page) };
}

/** The panel's requests are relatedItems for this family's maps only, sent after it painted. */
async function expectOnlyRelated(page: Page, r: Awaited<ReturnType<typeof openCounting>>): Promise<void> {
  expect(r.network, 'network requests while opening the panel').toEqual([]);
  expect(r.paint, 'the panel painted').not.toBeNull();
  expect(r.paint?.calls, 'no relatedItems call before the panel painted').toBe((await relatedLog(page)).length - r.related.length);
  const maps = await familyMaps(page);
  for (const e of r.related) {
    expect(e.path).toBe(`content/items/${e.mapId}/relatedItems`);
    expect(maps).toContain(e.mapId);
    expect(e.at).toBeGreaterThanOrEqual(r.paint?.at ?? 0);
  }
  expect(r.related.length).toBeLessThanOrEqual(20);
}

/** The row in the demo that is a family (source + views): the member switch is there. */
async function familyIndex(page: Page): Promise<number> {
  return page.locator('dc-family-row').evaluateAll((els) => els.findIndex((e) => ((e as HTMLElement & { row?: { views: unknown[] } }).row?.views.length ?? 0) > 0));
}

test('demo: the bars give a card after the delay, Escape closes it; a row opens the panel (relatedItems only, after paint), and Escape returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const bars = page.locator('dc-usage-bars button').first();
  await expect(bars).toHaveAttribute('aria-label', /^Requests per month, past year: .+ Click for details\.$/);

  // Hover: no card at once, a card after the 500 ms delay.
  const card = page.locator('dc-usage-peek calcite-popover');
  await bars.hover();
  await page.waitForTimeout(150);
  expect(await card.evaluate((e) => (e as HTMLElement & { open: boolean }).open)).toBe(false);
  await expect.poll(() => card.evaluate((e) => (e as HTMLElement & { open: boolean }).open), { timeout: 2000 }).toBe(true);
  await expect(page.locator('dc-usage-peek .pk-line')).toHaveText('Requests per month, UTC (scale compressed in the row)');
  await expect(page.locator('dc-usage-peek .pk-more')).toHaveText('Click for details');
  await page.keyboard.press('Escape');
  await expect.poll(() => card.evaluate((e) => (e as HTMLElement & { open: boolean }).open)).toBe(false);
  await page.mouse.move(0, 0);

  // A row with views: open from the bars button; nothing but relatedItems for its maps, after the panel has painted.
  const fi = await familyIndex(page);
  expect(fi, 'the demo has a family on its review').toBeGreaterThanOrEqual(0);
  const row = page.locator('dc-family-row').nth(fi);
  const opener = row.locator('dc-usage-bars button');
  await opener.scrollIntoViewIfNeeded();
  await expectOnlyRelated(page, await openCounting(page, opener));
  expect(await isOpen(page)).toBe(true);
  // Focus is inside the panel.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dc-item-panel'))).toBe(true);

  // Usage: calendar by default, 2-year toggle, monthly bars switch, member switch.
  await expect(page.locator('dc-item-panel .ip-chart svg.cal').first()).toBeVisible();
  expect(await page.locator('dc-item-panel .ip-chart svg.cal rect[data-d]').count()).toBe(365);
  await page.locator('dc-item-panel calcite-segmented-control[data-sw="range"] calcite-segmented-control-item[value="730"]').click();
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toContainText('2 years');
  await expect.poll(() => page.locator('dc-item-panel .ip-chart svg.cal rect[data-d]').count()).toBe(730);
  await page.locator('dc-item-panel calcite-segmented-control[data-sw="chart"] calcite-segmented-control-item[value="bars"]').click();
  await expect(page.locator('dc-item-panel .ip-chart svg.mbars')).toBeVisible();
  const member = page.locator('dc-item-panel [data-sw="member"]');
  await expect(member).toBeVisible();
  // Keyboard readout on the chart.
  await page.locator('dc-item-panel .ip-chart').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('dc-item-panel .ip-read b')).toBeVisible();
  // Show as a table.
  await page.locator('dc-item-panel [data-act="table"]').click();
  await expect(page.locator('dc-item-panel .ip-table tbody tr')).not.toHaveCount(0);

  // Connections: the family column with the clicked layer marked, and the Used directly column when anything uses it.
  await expect(page.locator('dc-item-panel .diagram .col[data-col="family"]')).toBeVisible();
  await expect(page.locator('dc-item-panel .diagram .node.me')).toHaveCount(1);

  // Escape closes and focus returns to the row's button.
  await page.keyboard.press('Escape');
  await expect.poll(() => isOpen(page)).toBe(false);
  await expect.poll(() => opener.evaluate((e) => e === document.activeElement)).toBe(true);
});

test('demo: a click on the row (not its links) opens the panel for that layer; a layer nothing uses says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const idx = await page.locator('dc-family-row').evaluateAll((els) => els.findIndex((e) => {
    const r = (e as HTMLElement & { row?: { usedBy: number; views: unknown[] } }).row;
    return !!r && r.usedBy === 0 && r.views.length === 0;
  }));
  test.skip(idx < 0, 'no unused single layer on the demo review');
  const row = page.locator('dc-family-row').nth(idx);
  await row.locator('.why').click();
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await expect(page.locator('dc-item-panel [data-conn="empty"]')).toContainText('Nothing in your org uses this layer.');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dc-item-panel'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => isOpen(page)).toBe(false);
});

/** Every layer in the list (a loose custom rule), so the families with the most maps are on the page. */
const everyLayer = async (page: Page) => {
  await page.evaluate(() => {
    const r = document.querySelector('dc-review') as unknown as { pick: string; thresholds: unknown };
    r.pick = 'custom'; r.thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 999, minSizeMB: 0 };
  });
  await page.waitForTimeout(800);
};

/** Opens the panel (through its API) for the listed family with the most used-directly web maps; returns how many. */
const openMostMaps = (page: Page) => page.evaluate(() => {
  type S = { dependencies: { type: string }[] };
  type R = { source: S & { id: string }; views: S[] };
  const list = document.querySelector('dc-owner-list') as unknown as { owners: { rows: R[] }[] };
  const rows = list.owners.flatMap((o) => o.rows);
  const n = (r: R) => [r.source, ...r.views].reduce((a, s) => a + s.dependencies.filter((d) => d.type === 'Web Map').length, 0);
  const best = rows.reduce((a, r) => (n(r) > n(a) ? r : a), rows[0] as R);
  const opener = document.querySelector('dc-family-row [data-open-panel]') as HTMLElement;
  (document.querySelector('dc-item-panel') as unknown as { show(d: unknown): void }).show({ row: best, member: best.source.id, opener });
  return n(best);
});

test('demo: Connections adds offline map areas and surveys from ArcGIS Online after a checking line, and nothing else moves', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  await everyLayer(page);
  const before = (await relatedLog(page)).length;
  await watchPaint(page);
  const maps = await openMostMaps(page);
  expect(maps, 'a family used by several maps').toBeGreaterThan(1);
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  // The fourth column is there at once, with the checking line; the other columns don't move when the answers land.
  const col = page.locator('dc-item-panel .diagram .col[data-col="extra"]');
  await expect(col).toBeVisible();
  await expect(col.locator('[data-related="checking"]')).toHaveText('Checking ArcGIS Online for offline areas and surveys…');
  const direct = page.locator('dc-item-panel .diagram .col[data-col="direct"]');
  // Wait for the slide-in animation to finish (not a fixed time: on a busy machine it starts late, and the answers can land during a fixed wait).
  await expect.poll(() => page.locator('dc-item-panel').evaluate((e) => e.getAnimations({ subtree: true }).filter((a) => a.playState !== 'finished' && a.effect?.getComputedTiming().iterations !== Infinity).length), { intervals: [50] }).toBe(0);
  const box0 = await direct.boundingBox();
  await expect(col.locator('.node').first()).toBeVisible({ timeout: 15_000 });
  await expect(col.locator('[data-related="checking"]')).toHaveCount(0, { timeout: 15_000 });
  expect(await direct.boundingBox()).toEqual(box0);
  await expect(col.locator('.ch')).toContainText('Offline and surveys');
  await expect(col.locator('.xh').first()).toHaveText(/^(Offline map areas|Surveys)$/);
  await expect(col.locator('.node .nvia').first()).toHaveText(/^from .+/);
  // Only relatedItems for this family's maps, sent after the panel painted; none of them twice.
  const sent = (await relatedLog(page)).slice(before);
  const fam = await familyMaps(page);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(Math.min(20, fam.length));
  for (const e of sent) { expect(e.path).toBe(`content/items/${e.mapId}/relatedItems`); expect(fam).toContain(e.mapId); expect(e.kind).toBe('open'); }
  expect(new Set(sent.map((e) => e.mapId)).size).toBe(sent.length);
  const paint = await painted(page);
  expect(paint?.calls).toBe(before);
  // Open it again: the answers are kept for this scan, nothing is asked twice.
  await page.keyboard.press('Escape');
  await expect.poll(() => isOpen(page)).toBe(false);
  // The sheet reports closed before the panel has handled its close event; show() in that gap is undone by the late close.
  await expect.poll(() => page.locator('dc-item-panel').evaluate((e) => (e as unknown as { isOpen: boolean }).isOpen)).toBe(false);
  await openMostMaps(page);
  await expect(col.locator('.node').first()).toBeVisible();
  await page.waitForTimeout(400);
  expect((await relatedLog(page)).length).toBe(before + sent.length);
});

for (const look of ['standard', 'console'] as const) {
  test(`axe passes on the open panel: ${look}`, async ({ page }) => {
    if (look === 'console') await page.addInitScript(() => localStorage.setItem('decluttering:skin', '"console"'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/demo');
    await reviewReady(page);
    await everyLayer(page);
    await openMostMaps(page);
    await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
    // With the offline areas and surveys in (DC-147d).
    await expect(page.locator('dc-item-panel .col[data-col="extra"] .node').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    const res = await new AxeBuilder({ page }).include('dc-item-panel').withTags(TAGS).analyze();
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}

/** DC-149: deletes every CSS rule written for the console look (html[data-skin="console"] ...), in @media too. */
const dropConsoleRules = (page: Page) => page.evaluate(() => {
  let n = 0;
  const walk = (list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i] as CSSRule;
      if (r instanceof CSSStyleRule && r.selectorText.includes('data-skin="console"')) { owner.deleteRule(i); n++; }
      else if (r instanceof CSSGroupingRule) walk(r.cssRules, r);
    }
  };
  for (const sh of [...document.styleSheets]) { try { walk(sh.cssRules, sh); } catch { /* another origin: none of ours */ } }
  return n;
});

/** DC-149: the computed look of every element in the open panel (and the panel's header-action tokens), as one string. */
const panelStyles = (page: Page) => page.locator('dc-item-panel').evaluate((host) => {
  const props = ['color', 'background-color', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight', 'text-transform',
    'letter-spacing', 'display', 'visibility', 'opacity', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'clip-path', 'rx', 'ry',
    'outline', 'position', 'padding', 'margin', 'width', 'height'];
  const out: string[] = [];
  host.querySelectorAll('*').forEach((el, i) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    out.push(`${i} ${el.tagName} ${props.map((p) => cs.getPropertyValue(p)).join('|')} ${[r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(',')}`);
    for (const pe of ['::before', '::after']) { const ps = getComputedStyle(el, pe); if (ps.content !== 'none' && ps.content !== 'normal') out.push(`${i}${pe} ${ps.content} ${props.map((p) => ps.getPropertyValue(p)).join('|')}`); }
  });
  const panel = host.querySelector('calcite-panel') as Element;
  out.push(['background-color', 'text-color'].map((k) => getComputedStyle(panel).getPropertyValue(`--calcite-panel-header-action-${k}`)).join('|'));
  return out.join('\n');
});

/** DC-149: two screenshots match up to anti-aliasing noise (Chromium rasterises a few edge pixels a level or two apart). */
const samePixels = (page: Page, a: Buffer, b: Buffer) => page.evaluate(async ([a, b]) => {
  const load = async (b64: string) => { const im = new Image(); im.src = `data:image/png;base64,${b64}`; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d') as CanvasRenderingContext2D; x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height); };
  const [p, q] = [await load(a as string), await load(b as string)];
  if (p.width !== q.width || p.height !== q.height) return { size: false, off: -1, max: -1 };
  let off = 0, max = 0;
  for (let i = 0; i < p.data.length; i++) { const d = Math.abs((p.data[i] as number) - (q.data[i] as number)); if (d) { off++; max = Math.max(max, d); } }
  return { size: true, off, max };
}, [a.toString('base64'), b.toString('base64')]);

test('DC-149: the standard look of the open panel is untouched by the console rules (calendar, bars, Connections)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  await everyLayer(page);
  await openMostMaps(page);
  await expect(page.locator('dc-item-panel .col[data-col="extra"] .node').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('dc-item-panel [data-related="checking"]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(500);
  const sheet = page.locator('dc-item-panel calcite-panel');
  const seg = (v: string) => page.locator(`dc-item-panel calcite-segmented-control[data-sw="chart"] calcite-segmented-control-item[value="${v}"]`);
  // Calendar, then the bars with a month hovered (its label block stays hidden here), then Connections.
  const look = async () => {
    const shots: Buffer[] = [], styles: string[] = [];
    const take = async () => { await page.waitForTimeout(250); styles.push(await panelStyles(page)); shots.push(await sheet.screenshot({ animations: 'disabled' })); };
    const scroll = (top: number) => sheet.evaluate((p, top) => (p as HTMLElement & { scrollContentTo(o: ScrollToOptions): void }).scrollContentTo({ top }), top);
    await scroll(0); await seg('cal').click(); await page.mouse.move(1, 1); await take();
    await seg('bars').click(); await page.locator('dc-item-panel .mbars .hit[data-m="3"]').hover(); await take();
    await scroll(400); await page.mouse.move(1, 1); await take();
    await scroll(0);
    return { shots, styles };
  };
  const before = await look();
  // The console-only parts are inert here: the label block hidden, no caps, the sans face on the axes.
  const std = await page.locator('dc-item-panel .mbars').evaluate((svg) => ({
    blk: getComputedStyle(svg.querySelector('.mblk') as Element).display,
    cap: getComputedStyle(svg.querySelector('.b-top') as Element).clipPath,
    font: getComputedStyle(svg.querySelector('.ax') as Element).fontFamily,
  }));
  expect(std.blk).toBe('none');
  expect(std.cap).toBe('none');
  expect(std.font).not.toMatch(/Antonio/);
  expect(await dropConsoleRules(page), 'console rules found to remove').toBeGreaterThan(20);
  const after = await look();
  for (let k = 0; k < before.shots.length; k++) {
    const a = (before.styles[k] as string).split('\n'), b = (after.styles[k] as string).split('\n');
    expect(b.length, `elements in view ${k}`).toBe(a.length);
    expect(b.flatMap((l, i) => (l === a[i] ? [] : [`${a[i]}\n  -> ${l}`])), `computed styles ${k} unchanged without the console rules`).toEqual([]);
    const px = await samePixels(page, before.shots[k] as Buffer, after.shots[k] as Buffer);
    expect(px.size, `screenshot ${k}: same size`).toBe(true);
    expect(px.max, `screenshot ${k}: at most anti-aliasing noise`).toBeLessThanOrEqual(8);
    expect(px.off, `screenshot ${k}: at most anti-aliasing noise`).toBeLessThan(400);
  }
});

test('DC-149: in the console look the close cross is peach on black, and the hovered month lights an amber label block', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('decluttering:skin', '"console"'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const fi = Math.max(0, await familyIndex(page));
  const opener = page.locator('dc-family-row').nth(fi).locator('dc-usage-bars button');
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  const close = await page.locator('dc-item-panel calcite-panel').evaluate((p) => {
    const btn = p.shadowRoot?.querySelector('#close')?.shadowRoot?.querySelector('button') as HTMLElement;
    const cs = getComputedStyle(btn);
    return { color: cs.color, bg: cs.backgroundColor };
  });
  expect(close).toEqual({ color: 'rgb(255, 197, 143)', bg: 'rgb(0, 0, 0)' });
  await page.locator('dc-item-panel calcite-segmented-control[data-sw="chart"] calcite-segmented-control-item[value="bars"]').click();
  const col = page.locator('dc-item-panel .mbars .mcol').nth(4);
  await col.locator('.hit').hover();
  await expect.poll(() => col.locator('.mblk').evaluate((e) => getComputedStyle(e).display)).not.toBe('none');
  expect(await col.locator('.mblk').evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(255, 161, 51)');
  expect(await page.locator('dc-item-panel .mbars .ax').first().evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/Antonio/);
});

test('demo at 390 px: the panel fills the screen, Connections is a list, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/demo');
  await reviewReady(page);
  const fi = Math.max(0, await familyIndex(page));
  const opener = page.locator('dc-family-row').nth(fi).locator('[data-open-panel]');
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await page.waitForTimeout(400);
  const w = await page.locator('dc-item-panel calcite-panel').evaluate((e) => e.getBoundingClientRect().width);
  expect(w).toBeGreaterThanOrEqual(388);
  await expect(page.locator('dc-item-panel .clist')).toBeVisible();
  await expect(page.locator('dc-item-panel .diagram')).toBeHidden();
  // DC-147d: a family with maps gets the Offline and surveys group at the end of the list.
  await page.keyboard.press('Escape');
  await expect.poll(() => isOpen(page)).toBe(false);
  await everyLayer(page);
  await openMostMaps(page);
  await expect(page.locator('dc-item-panel .clist h4', { hasText: 'Offline and surveys' })).toBeVisible();
  await expect(page.locator('dc-item-panel .clist [data-related="checking"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('dc-item-panel .clist h5', { hasText: /^(Offline map areas|Surveys)/ }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('dc-item-panel .ip').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('dc-item-panel .ip').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
});

test('simulator: on open only relatedItems for the family\'s maps (at most 20, after paint), and a column over 8 shows "+N more" that reveals the rest', async ({ page }) => {
  test.skip(!(await devUp()), 'Needs the dev server (npm run dev): the simulator is not in the preview build.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${DEV}/#/simulate?n=7000&speed=0.02`);
  const go = page.locator('dc-scan-screen [data-action="review"]').first();
  await expect(go).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('dc-scan-screen [data-action="stop"]')).toBeHidden({ timeout: 120_000 });
  await go.click();
  await reviewReady(page);
  // Every layer in the list (a loose custom rule), so the busiest family is on the page.
  await page.evaluate(() => {
    const r = document.querySelector('dc-review') as unknown as { pick: string; thresholds: unknown };
    r.pick = 'custom'; r.thresholds = { minDaysSinceUse: 0, minDaysSinceUpdate: 0, maxUsedBy: 999, minSizeMB: 0 };
  });
  await page.waitForTimeout(800);
  // Open the panel for the family with the most maps and apps in the whole list (cards stream in, so it may not be drawn).
  const seen: string[] = [];
  const on = (r: Request) => { if (!isAsset(r)) seen.push(`${r.method()} ${r.url()}`); };
  const before = (await relatedLog(page)).length;
  await watchPaint(page);
  page.on('request', on);
  const most = await page.evaluate(() => {
    type R = { source: { id: string; dependencies: unknown[] }; views: { dependencies: unknown[] }[] };
    const list = document.querySelector('dc-owner-list') as unknown as { owners: { rows: R[] }[] };
    const rows = list.owners.flatMap((o) => o.rows);
    const n = (r: R) => [r.source, ...r.views].reduce((a, s) => a + s.dependencies.length, 0);
    const best = rows.reduce((a, r) => (n(r) > n(a) ? r : a), rows[0] as R);
    const opener = document.querySelector('dc-family-row [data-open-panel]') as HTMLElement;
    (document.querySelector('dc-item-panel') as unknown as { show(d: unknown): void }).show({ row: best, member: best.source.id, opener });
    return n(best);
  });
  await expect(page.locator('dc-item-panel [data-usage-headline]')).toBeVisible();
  await page.waitForTimeout(600);
  page.off('request', on);
  expect(seen, 'network requests while opening the panel').toEqual([]);
  await expect(page.locator('dc-item-panel [data-related="checking"]')).toHaveCount(0, { timeout: 30_000 });
  await expectOnlyRelated(page, { network: seen, related: (await relatedLog(page)).slice(before), paint: await painted(page) });
  test.info().annotations.push({ type: 'most-connections', description: String(most) });
  const more = page.locator('dc-item-panel .diagram .more').first();
  expect(most, 'a family with more than 8 maps or apps').toBeGreaterThan(8);
  {
    const col = await more.getAttribute('data-more');
    const before = await page.locator(`dc-item-panel .diagram .col[data-col="${col}"] .node`).count();
    expect(before).toBe(8);
    await expect(more).toHaveText(/^\+\d+ more$/);
    await more.click();
    await expect.poll(() => page.locator(`dc-item-panel .diagram .col[data-col="${col}"] .node`).count()).toBeGreaterThan(8);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.node'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => isOpen(page)).toBe(false);
});

test('simulator: idle pre-fetch waits for the scan to finish, then asks a few maps for the families on screen', async ({ page }) => {
  test.skip(!(await devUp()), 'Needs the dev server (npm run dev): the simulator is not in the preview build.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${DEV}/#/simulate?n=7000&speed=1`);
  const go = page.locator('dc-scan-screen [data-action="review"]').first();
  await expect(go).toBeVisible({ timeout: 120_000 });
  await go.click();
  await reviewReady(page);
  // Review is showing while maps and apps are still being read: 3.5 s of quiet must not send anything.
  await expect(page.locator('[data-scan-state="running"]')).toHaveCount(1);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(3500);
  const during = (await relatedLog(page)).length;
  const stillRunning = await page.locator('[data-scan-state="running"]').count();
  test.skip(!stillRunning, 'the scan finished during the idle wait');
  expect(during, 'relatedItems calls during the scan').toBe(0);
  // Scan done: after 2 s of quiet the families on screen are pre-fetched, as idle work. The top of the list is stale layers,
  // which maps rarely use, so bring a row with maps on screen first.
  await expect(page.locator('[data-scan-state="done"]')).toHaveCount(1, { timeout: 240_000 });
  await everyLayer(page);
  const scrolled = await page.evaluate(() => {
    type S = { dependencies: { type: string }[] };
    const el = [...document.querySelectorAll('dc-family-row')].find((e) => {
      const r = (e as unknown as { row?: { family: { source: S; views: S[] } } }).row;
      return !!r && [r.family.source, ...r.family.views].some((s) => s.dependencies.some((d) => d.type === 'Web Map'));
    });
    el?.scrollIntoView({ block: 'center' });
    return !!el;
  });
  expect(scrolled, 'a row with maps in the list').toBe(true);
  await expect.poll(async () => (await relatedLog(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const idle = await relatedLog(page);
  expect(idle.every((e) => e.kind === 'idle' && e.path === `content/items/${e.mapId}/relatedItems`)).toBe(true);
  // Any input stops it: after a key press, at most the calls already in flight finish.
  await page.keyboard.press('Shift');
  const n = (await relatedLog(page)).length;
  await page.waitForTimeout(1500);
  expect((await relatedLog(page)).length - n).toBeLessThanOrEqual(2);
});
