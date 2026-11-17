// DC-090 (FB-38, FB-39, FB-40): the Review page's chart card and layout (demo mode, no network).
// The dot map on Review is the scan's dc-dot-map, placed by the same How stale lensPoint, and its stale zone follows the panel.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRESETS, evaluate } from '../src/domain/stale';
import { suggest } from '../src/domain/suggest';
import type { Data, Thresholds } from '../src/domain/types';
import { lensPoint } from '../src/ui/scan/dot-layout';

// DC-116: the demo plays a 30 to 45 second scan; this spec only needs the Review page and public/demo/mock-small.json, so it asks for the quick demo.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ = true; }); });

const data = JSON.parse(readFileSync(resolve(process.cwd(), 'public/demo/mock-small.json'), 'utf8')) as Data;
const sug = suggest(data);
const START: Thresholds = sug ? sug.thresholds : PRESETS.balanced;

const map = (p: Page) => p.locator('dc-review .chart-block dc-dot-map');
const card = (p: Page) => p.locator('dc-review .chart-block');

async function open(page: Page, clear = true) {
  await page.goto('/#/demo');
  if (clear) {
    await page.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('decluttering:chart')) localStorage.removeItem(k); } catch { /* blocked */ } });
    await page.reload();
  }
  await expect(page.locator('dc-review .list-head h2')).toBeVisible();
}

/** What the dot map on Review is drawing: each dot's target on the plot and what lensPoint needs to place it. */
const sprites = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('dc-review dc-dot-map') as unknown as {
    sprites: { id: string; seed: number; kind: string; usedBy: number; lastUsedDaysAgo: number | null; daysSinceUpdate: number; sizeMB: number; staleness: number; mo: { tx: number; ty: number } }[];
    shown: { maxSizeMB: number };
  };
  return { max: el.shown.maxSizeMB, dots: el.sprites.map((d) => ({ ...d, mo: { tx: d.mo.tx, ty: d.mo.ty } })) };
});

test('How stale is the default view: the scan\'s dot map, How stale only, its stale count is the list', async ({ page }) => {
  await open(page);
  await expect(card(page)).toHaveAttribute('data-chart-view', 'stale');
  await expect(map(page)).toBeVisible();
  // One question per card: no lens switch on Review.
  await expect(map(page).locator('[data-scan="lenses"]')).toHaveCount(0);
  await expect(map(page)).toHaveAttribute('data-stale-services', String(evaluate(data, START).totals.services));
  // The Sankey is still there, on "By owner".
  await expect(page.locator('dc-review dc-sankey')).toHaveCount(1);
  await expect(page.locator('dc-review dc-sankey')).toBeHidden();
});

test('the Review map places each dot with the same How stale lensPoint as the scan map', async ({ page }) => {
  await open(page);
  await expect(map(page)).toBeVisible();
  const s = await sprites(page);
  expect(s.dots.length).toBeGreaterThan(0);
  for (const d of s.dots) {
    const [x, y] = lensPoint('stale', d, d.seed, START, s.max);
    expect(d.mo.tx).toBeCloseTo(x, 6);
    expect(d.mo.ty).toBeCloseTo(y, 6);
  }
});

test('changing a filter moves the stale zone and recolours the dots; the count still matches the list', async ({ page }) => {
  await open(page);
  await page.locator('dc-filters calcite-segmented-control-item[value="gentle"]').click();
  await expect(map(page)).toHaveJSProperty('zoneLabel', 'Gentle');
  await expect(map(page)).toHaveAttribute('data-stale-services', String(evaluate(data, PRESETS.gentle).totals.services));
  const before = await sprites(page);
  await page.locator('dc-filters calcite-segmented-control-item[value="strict"]').click();
  const strict = evaluate(data, PRESETS.strict);
  await expect(map(page)).toHaveAttribute('data-stale-services', String(strict.totals.services));
  await expect(map(page)).toHaveJSProperty('zoneLabel', 'Strict');
  await expect(map(page)).toHaveJSProperty('thresholds', PRESETS.strict);
  const after = await sprites(page);
  const kind = new Map(before.dots.map((d) => [d.id, d.kind]));
  expect(after.dots.some((d) => kind.get(d.id) !== d.kind)).toBe(true);
  // Reachable stale dots on the map are the list's families.
  const disabled = new Set(data.owners.filter((o) => o.disabled).map((o) => o.username));
  const ownerOf = new Map(data.services.map((sv) => [sv.id, sv.owner]));
  const mapStale = after.dots.filter((d) => d.kind === 'stale' && !disabled.has(ownerOf.get(d.id) ?? '')).map((d) => d.id).sort();
  expect(mapStale).toEqual(strict.families.map((r) => r.source.id).sort());
  // Custom is labelled "your rule".
  await page.locator('dc-filters calcite-segmented-control-item[value="custom"]').click();
  await expect(map(page)).toHaveJSProperty('zoneLabel', 'your rule');
});

test('the view and the collapsed state are remembered', async ({ page }) => {
  await open(page);
  await card(page).locator('calcite-segmented-control-item[value="owner"]').click();
  await expect(card(page)).toHaveAttribute('data-chart-view', 'owner');
  await expect(page.locator('dc-review dc-sankey')).toBeVisible();
  await expect(map(page)).toBeHidden();
  await open(page, false);
  await expect(card(page)).toHaveAttribute('data-chart-view', 'owner');
  // Collapse from the header toggle, then reload.
  await card(page).evaluate((el) => (el as HTMLElement & { expanded: boolean }).expanded).then((v) => expect(v).toBe(true));
  await page.locator('dc-review .chart-block').locator('button#toggle').first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('decluttering:chartOpen'))).toBe('0');
  await open(page, false);
  await expect.poll(() => card(page).evaluate((el) => (el as HTMLElement & { expanded: boolean }).expanded)).toBe(false);
});

test('layout: a real gutter at 1440 px; at 400 px no sideways scroll and the panel folds to one line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const box = async (s: string) => (await page.locator(s).first().boundingBox())!;
  const side = await box('dc-review .dc-review-side'), main = await box('dc-review .dc-review-main'), f = await box('dc-filters');
  expect(Math.round(main.x - (f.x + f.width))).toBeGreaterThanOrEqual(23);
  expect(Math.abs(side.y - main.y)).toBeLessThan(1);
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(page.locator('dc-review .panel-fold')).toBeVisible();
  await expect(page.locator('dc-filters')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  await page.locator('dc-review .panel-fold').click();
  await expect(page.locator('dc-filters')).toBeVisible();
});
