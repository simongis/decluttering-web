import { LitElement, html, nothing, render, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t as translate, tn } from '../../i18n';
import { live } from 'lit/directives/live.js';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import { PORTAL_URL } from '../../auth/config';
import { formatMB, fmtInt, itemUrl } from '../../domain/format';
import { PRESET_NAMES } from '../../domain/stale';
import type { Org, Thresholds } from '../../domain/types';
import { NO_STORAGE_MB, SCAN_THRESHOLDS, SHOW_ALL_BELOW, dotWhy, SMALL_LAYER_MB, rampK, ringed, withSmallFloor, type Dot, type DotModel, type HiddenSmall } from './dots';
import {
  DENSITY_ABOVE, ENTER_MS, FADE_MS, HEIGHT_MS, LENSES, LENS_MS, LENS_STAGGER_MS, STAGGER_MAX_MS, TRAVEL_MS, Y_BAND,
  clamp, densityAlpha, densityBins, entryLook, hash, heightTween, lensPoint, mapHeight, motionAt, pendingRadius, prePoint,
  rampColour, retarget, seedOf, sizeBand, sizeRadius, staggerDelay, staleZone, zoneBox, tweenAt, tweenDone, xSize, xUpdate, yLastUsed,
  type LensId, type Motion, type Place, type Tween,
} from './dot-layout';
import { chartPalette, type ChartPalette } from './chart-palette';
import { onSkinChange } from '../skin/skin';

/*
 * DC-064: the scan screen's dot map, ported from prototypes/d-converged/scan.js (canvas, lenses, stale zone, tooltip,
 * keyboard). One dot per hosted feature service while the core is read, then one per family on the chosen lens.
 * Everything it draws comes from `model` (buildDots over real scan events); it has no timings of its own.
 * Accessibility: the canvas is focusable with an aria-label; arrow keys step through the dots (stalest first), Enter opens
 * one in ArcGIS Online, Escape closes the tip.
 * DC-071b (FB-18, FB-25): lenses wait until usage is in; the height grows with the count; above DENSITY_ABOVE dots the
 * not-stale ones are drawn as shading (stale and at-risk stay dots, hoverable).
 * DC-082 (FB-33): one picture taking shape. Before usage is in, dots already sit across by last updated (known from the
 * search), so there is no grey grid to snap away from (the grid stays only as a fallback when the search has no dates).
 * Each dot has its own motion in plot fractions, retargeted from where it is drawn: new dots fade and grow in (staggered,
 * capped), dots travel when usage or a size lands, lens changes glide as a soft wave, removed dots fade out, the height
 * eases, and shading cross-fades in and out. Under prefers-reduced-motion nothing travels: positions and height change at
 * once, new dots and lens changes use short fades. FB-32: no "Pause chart updates" (the user's decision).
 */

const TIP_DELAY = 400, FADE_HALF = 120, REVEAL_MS = 900;
const SHOW_SMALL_KEY = 'decluttering:dotmap.showSmall';
const readShowSmall = (): boolean => { try { return localStorage.getItem(SHOW_SMALL_KEY) === '1'; } catch { return false; } };
const writeShowSmall = (v: boolean): void => { try { localStorage.setItem(SHOW_SMALL_KEY, v ? '1' : '0'); } catch { /* private window or blocked storage: the choice just is not remembered */ } };
const INSET = 16;

interface Sprite extends Dot {
  /** Index in `sprites` (hit test, keyboard). */
  i: number;
  /** Stable jitter index from the id: a dot keeps its place when others leave. */
  seed: number;
  /** Where it is going, in plot fractions (radius in px). */
  mo: Motion;
  /** When its entry (fade and grow) starts; -Infinity: already there. */
  born: number;
  colour: string;
  /** Drawn as part of the density shading, not as its own dot. */
  shade?: boolean;
  /** As last drawn, in px (hit test, tip). */
  x: number; y: number; rad: number;
}

/** A dot that has gone from the picture (a view merged into its source, a layer under the floor): it fades out where it was. */
interface Ghost { x: number; y: number; rad: number; colour: string; start: number; dur: number }

@customElement('dc-dot-map')
export class DcDotMap extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) model: DotModel = { dots: [], revealed: false, exact: false, staleMin: 0.3, maxSizeMB: 1, stats: { found: 0, staleServices: 0, credits: 0, sizeMB: 0 } };
  /** Services are still being found (kept for the scan screen; entry motion now covers the newest dots). */
  @property({ type: Boolean }) finding = false;
  @property({ attribute: false }) org: Pick<Org, 'urlKey'> = { urlKey: '' };
  @property({ attribute: false }) thresholds: Thresholds = SCAN_THRESHOLDS;
  /** Usage is in, so the lenses mean something (FB-25). Until then they are disabled with a short reason. */
  @property({ type: Boolean, attribute: 'lenses-ready' }) lensesReady = true;
  /** A scan is still feeding the map: new dots fade and grow in (a finished scan opened again just appears). */
  @property({ type: Boolean }) live = false;
  /** Services the search said there are: before usage the plot is sized for all of them, so it does not grow as they land. */
  @property({ type: Number }) expected = 0;
  /** DC-090: the lenses offered (the Review page shows How stale only). With one lens the switch is left out. */
  @property({ attribute: false }) lenses: readonly LensId[] = LENSES.map((l) => l.id);
  /** The map's height relative to the scan screen's (the Review page draws it 10% shorter so the list starts sooner). */
  @property({ type: Number, attribute: 'height-scale' }) heightScale = 1;
  /** DC-090: the stale zone's label, the starting point in force (the scan screen draws Balanced). */
  @property({ attribute: 'zone-label' }) zoneLabel: string = PRESET_NAMES.balanced;
  /** DC-079: layers under SMALL_LAYER_MB are left off the map unless the viewer asks for them (remembered per browser). */
  @state() private showSmall = readShowSmall();
  private floorMemo: { model: DotModel; show: boolean; lens: LensId; expected: number; out: { model: DotModel; hidden: HiddenSmall } } | null = null;
  /** What is drawn: the latest model with the display floor applied. */
  private shown: DotModel = this.model;
  private dense = false;
  /** 0 (all dots) .. 1 (fine dots as shading): eased, so crossing DENSITY_ABOVE does not snap. */
  private denseT: Tween = { from: 0, to: 0, start: 0, dur: 0 };
  private ghosts: Ghost[] = [];
  private cellHalf = 6;
  /** Dots were placed across by last updated before usage: on reveal the time axis stays put instead of fading in. */
  private preTimed = false;

  /**
   * The model with the display floor applied (memoised, so an unchanged model keeps its identity). FB-43: on How big the
   * "no storage" column is left out too; it follows the drawn lens, so it changes at the cross-fade midpoint.
   */
  private floored(model: DotModel): { model: DotModel; hidden: HiddenSmall } {
    const c = this.floorMemo, lens = this.lens;
    if (c && c.model === model && c.show === this.showSmall && c.lens === lens && c.expected === this.expected) return c.out;
    // FB-52: a small org shows every layer (the search total when known, so the floor can't switch on mid-scan).
    const small = Math.max(this.expected, model.dots.length) < SHOW_ALL_BELOW;
    const out = withSmallFloor(model, { floorMB: small ? 0 : SMALL_LAYER_MB, show: this.showSmall, hideNoStorage: model.revealed && lens === 'big' });
    this.floorMemo = { model, show: this.showSmall, lens, expected: this.expected, out };
    return out;
  }
  private setShowSmall(v: boolean): void { this.showSmall = v; writeShowSmall(v); }

  @query('canvas') private canvas!: HTMLCanvasElement;
  @query('.dm-tip') private tip!: HTMLDivElement;
  @query('.dm-sr') private srLive!: HTMLDivElement;

  /** The lens drawn. Under reduced motion it changes at the cross-fade midpoint, after `picked`. */
  private lens: LensId = 'stale';
  /**
   * FB-44: the lens the switch shows, set the moment it is picked. The switch was bound to `lens`, which lags behind during
   * the reduced-motion cross-fade, so a re-render mid-fade (Lit writes only when its own last value changes) put the
   * old lens back on the switch while the chart went on to the new one.
   */
  @state() private picked: LensId = 'stale';
  private sprites: Sprite[] = [];
  /** Draw order: shading-bound dots, then grey, then the stale zone on top. */
  private order: number[] = [];
  private W = 0; private H = 0;
  /** The height, eased towards mapHeight for the count. */
  private heightT: Tween | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private revealAt: number | null = null;
  private fade: { start: number; swapped: boolean; target: LensId } | null = null;
  /** Keep painting until then: the last motion, entry, ghost or height change ends. */
  private animEnd = 0;
  private hover: number | null = null; private focusIdx = -1; private pinned = false;
  /** The last pointer was a finger or pen: a tap pins the tip with its link (a mouse click opens the item instead, FB-26). */
  private touch = false;
  private tipTimer = 0; private hideTimer = 0; private raf = 0;
  private ro: ResizeObserver | null = null;
  /** A11Y-09: followed live, so switching the OS setting while the app is open takes effect without a reload. */
  private readonly rmq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private reduce = this.rmq?.matches ?? false;
  private onReduceChange = (e: MediaQueryListEvent): void => { this.reduce = e.matches; this.kick(); };
  /** DC-135: the look in force; a change recolours every dot and repaints. */
  private pal: ChartPalette = chartPalette();
  private offSkin: (() => void) | null = null;
  private onSkin = (): void => { this.pal = chartPalette(); for (const d of this.sprites) d.colour = this.colourOf(d); this.kick(); this.requestUpdate(); };
  override connectedCallback(): void { super.connectedCallback(); this.reduce = this.rmq?.matches ?? false; this.rmq?.addEventListener?.('change', this.onReduceChange); this.pal = chartPalette(); this.offSkin = onSkinChange(this.onSkin); }
  private readonly pad = { l: 70, r: 14, t: 12, b: 40 }; // DC-083: room for "6 months" on the last-used axis

  protected override createRenderRoot(): HTMLElement { return this; }

  override disconnectedCallback(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    clearTimeout(this.tipTimer); clearTimeout(this.hideTimer);
    this.ro?.disconnect(); this.ro = null;
    this.rmq?.removeEventListener?.('change', this.onReduceChange);
    this.offSkin?.(); this.offSkin = null;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => { const w = this.canvas.clientWidth; if (w && Math.abs(w - this.W) > 1) { this.size(); this.kick(); } });
    this.ro.observe(this.canvas);
    this.size();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('model') || (changed as Map<PropertyKey, unknown>).has('showSmall') || changed.has('thresholds') || changed.has('expected') || changed.has('heightScale')) { this.rebuild(); this.kick(); }
    else if (changed.has('zoneLabel')) this.kick();
    else this.kick();
    if (this.tip && !this.tip.hidden) {
      const idx = this.hover ?? this.focusIdx;
      if (idx >= 0) this.showTip(idx, false, this.touch ? 'tap' : this.focusIdx >= 0 ? 'key' : 'hover');
    }
  }

  // ---------- layout ----------
  private plot() { const { l, r, t, b } = this.pad; return { x0: l, y0: t, w: this.W - l - r, h: this.H - t - b }; }
  private plotX(n: number) { const p = this.plot(); return p.x0 + INSET + n * (p.w - 2 * INSET); }
  private plotY(n: number) { const p = this.plot(); return p.y0 + INSET + (1 - n) * (p.h - 2 * INSET); }
  /** How many dots the plot is sized for: before usage, everything the search found, so it does not grow as pages land. */
  private layoutCount(): number { return this.shown.revealed ? this.sprites.length : Math.max(this.sprites.length, this.expected); }
  private targetH(): number { return Math.round(mapHeight(this.W || 600, this.layoutCount(), innerHeight) * this.heightScale); }
  private bump(t: number): void { if (t > this.animEnd) this.animEnd = t; }

  /** Where a dot belongs now, as plot fractions and a radius in px. */
  private targetOf(d: Sprite): Place {
    const m = this.shown, wide = this.W > 700;
    if (!m.revealed) {
      const r = d.sized ? sizeRadius(d.sizeMB, m.maxSizeMB, wide) : pendingRadius(this.layoutCount());
      if (m.timed) { const [x, y] = prePoint(d.daysSinceUpdate, d.seed); return [x, y, r]; }
      // No dates from the search: a grid laid out for everything expected, so it fills without shifting.
      const p = this.plot(), D = Math.max(1, this.layoutCount()), gw = Math.max(1, p.w - 2 * INSET), gh = Math.max(1, p.h - 2 * INSET);
      const COLS = Math.max(8, Math.ceil(Math.sqrt(D * (gw / gh)))), ROWS = Math.max(1, Math.ceil(D / COLS));
      this.cellHalf = Math.min(gw / COLS, gh / ROWS) / 2;
      return [(d.i % COLS + 0.5) / COLS, 1 - (Math.floor(d.i / COLS) + 0.5) / ROWS, Math.min(r, Math.max(1.2, this.cellHalf * 0.9))];
    }
    const [x, y] = lensPoint(this.lens, d, d.seed, this.thresholds, m.maxSizeMB);
    return [x, y, sizeRadius(d.sizeMB, m.maxSizeMB, wide)];
  }

  private colourOf(d: Dot): string {
    const P = this.pal;
    if (!this.shown.revealed) return d.sized ? P.grey : P.pending;
    return d.kind === 'stale' ? rampColour(rampK(d, this.shown.staleMin), P.ramp) : P.grey;
  }

  private setCanvasHeight(h: number): void {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    this.H = h; c.width = this.W * dpr; c.height = h * dpr; c.style.height = `${h}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Width changed (or first layout): size at once and put every dot where it belongs, no travel. */
  private size(): void {
    const c = this.canvas; if (!c || !this.ctx) return;
    this.W = c.clientWidth || 600;
    const h = this.targetH();
    this.heightT = { from: h, to: h, start: 0, dur: 0 };
    this.setCanvasHeight(h);
    const now = performance.now();
    for (const d of this.sprites) d.mo = retarget(d.mo, now, this.targetOf(d), 0, 0);
  }

  /** New model: each dot keeps where it is drawn and travels to its new place; newcomers fade and grow in. */
  private rebuild(lensMove = false): void {
    const now = performance.now(), reduce = this.reduce;
    const prev = new Map(this.sprites.map((d) => [d.id, d]));
    const was = this.shown;
    const f = this.floored(this.model);
    const m = (this.shown = f.model);
    if (!m.revealed) this.preTimed = !!m.timed;
    if (m.revealed && this.revealAt == null) this.revealAt = reduce || !prev.size ? -Infinity : now;
    if (!m.revealed) this.revealAt = null;
    const dense = m.revealed && m.dots.length > DENSITY_ABOVE;
    if (dense !== this.dense) {
      this.dense = dense;
      this.denseT = prev.size && !reduce ? heightTween(this.denseT, now, dense ? 1 : 0, 2 * TRAVEL_MS / 3) : { from: +dense, to: +dense, start: now, dur: 0 };
      this.bump(this.denseT.start + this.denseT.dur);
    }
    this.sprites = m.dots.map((d, i) => {
      const p = prev.get(d.id);
      return {
        ...d, i, seed: p?.seed ?? seedOf(d.id), mo: p?.mo as Motion, born: p?.born ?? -Infinity, colour: '',
        shade: dense && d.kind !== 'stale' && !d.candidate, x: p?.x ?? 0, y: p?.y ?? 0, rad: p?.rad ?? 0,
      };
    });
    // The height follows the count (FB-18), eased from where it is drawn (DC-082).
    if (this.ctx && this.W) { this.heightT = heightTween(this.heightT, now, this.targetH(), reduce ? 0 : HEIGHT_MS); this.bump(this.heightT.start + this.heightT.dur); }
    // Newcomers enter in a staggered wave, unless this is a finished scan opened again (everything just appears).
    const animateIn = prev.size > 0 || this.live;
    const fresh = this.sprites.filter((d) => !prev.has(d.id)).length;
    const revealing = m.revealed && !was.revealed && prev.size > 0;
    const travel = reduce ? 0 : TRAVEL_MS;
    let rank = 0;
    for (const d of this.sprites) {
      d.colour = this.colourOf(d);
      const to = this.targetOf(d);
      if (d.mo) {
        // Usage landing (the reveal) spreads the dots out a little more than a size landing.
        // A lens change glides as a soft wave (DC-082).
        const delay = reduce ? 0 : hash(d.seed, 7) * (lensMove ? LENS_STAGGER_MS : revealing ? STAGGER_MAX_MS : 90);
        d.mo = retarget(d.mo, now, to, delay, lensMove && !reduce ? LENS_MS : travel);
      } else {
        d.mo = retarget(null, now, to, 0, 0);
        d.born = animateIn ? now + (reduce ? 0 : staggerDelay(rank++, fresh)) : -Infinity;
        this.bump(d.born + (reduce ? FADE_MS : ENTER_MS));
      }
      this.bump(d.mo.start + d.mo.dur);
    }
    this.order = this.sprites.map((d) => d.i)
      .sort((a, b) => this.layer(this.sprites[a] as Sprite) - this.layer(this.sprites[b] as Sprite));
    // Dots that were drawn and are not now fade out where they were (reduced motion: a shorter fade).
    const ids = new Set(m.dots.map((d) => d.id)), gone = reduce ? FADE_MS : 2 * TRAVEL_MS / 3;
    for (const p of prev.values()) if (!ids.has(p.id) && p.rad && p.x) this.ghosts.push({ x: p.x, y: p.y, rad: p.rad, colour: p.colour, start: now, dur: gone });
    if (this.ghosts.length > 12000) this.ghosts.splice(0, this.ghosts.length - 12000);
    if (this.ghosts.length) this.bump(now + gone);
    if (this.hover != null && this.hover >= this.sprites.length) this.hover = null;
    if (this.focusIdx >= this.sprites.length) this.focusIdx = -1;
  }
  private layer(d: Sprite): number { return d.shade ? 0 : d.candidate ? 2 : 1; }

  private reveal(): number {
    if (!this.shown.revealed || this.revealAt == null) return 0;
    const p = clamp((performance.now() - this.revealAt) / REVEAL_MS);
    return p * p * (3 - 2 * p);
  }

  // ---------- lenses ----------
  private setLens(id: LensId): void {
    if (id === this.picked) return;
    this.picked = id;
    this.hideTip();
    if (this.reduce) {
      // Cross-fade: fade the plot out, swap the lens at the midpoint (no travel), fade back in.
      const now = performance.now();
      if (this.fade) { const a = this.fadeAlpha(now); this.fade = { start: now - FADE_HALF * (1 - a), swapped: false, target: id }; }
      else this.fade = { start: now, swapped: false, target: id };
    } else this.applyLens(id);
    this.requestUpdate();
    this.kick();
  }
  /**
   * The dots glide to the new lens as a soft wave (reduced motion: at once, behind the cross-fade). A rebuild, because the
   * lens decides which dots are drawn (FB-43): the "no storage" ones fade out on How big and back in elsewhere.
   */
  private applyLens(id: LensId): void {
    this.lens = id;
    this.rebuild(true);
    this.requestUpdate(); // the legend line and data-lens follow the drawn lens
  }
  private fadeAlpha(now: number): number {
    const e = now - (this.fade as { start: number }).start;
    return e < FADE_HALF ? 1 - e / FADE_HALF : clamp((e - FADE_HALF) / FADE_HALF);
  }

  // ---------- paint ----------
  private halo(text: string, x: number, y: number, align: CanvasTextAlign, colour: string, font: string): void {
    const ctx = this.ctx as CanvasRenderingContext2D;
    ctx.save(); ctx.font = font; ctx.textAlign = align; ctx.lineJoin = 'round';
    ctx.strokeStyle = this.pal.halo; ctx.lineWidth = 3.5; ctx.strokeText(text, x, y);
    ctx.fillStyle = colour; ctx.fillText(text, x, y); ctx.restore();
  }

  private drawAxes(): void {
    const ctx = this.ctx as CanvasRenderingContext2D, p = this.plot(), t = this.thresholds;
    const k = this.reveal();
    const early = !this.shown.revealed && !!this.shown.timed;
    if (k < 0.02 && !early) return;
    const P = this.pal, cap = (s: string) => (P.starChart ? s.toUpperCase() : s);
    ctx.save();
    ctx.font = P.starChart ? `12px ${P.font}` : `11px ${P.font}`; ctx.lineWidth = 1; ctx.globalAlpha = k;
    const bottom = p.y0 + p.h, right = p.x0 + p.w;
    // DC-135: the star chart's graticule is dotted; the standard grid is solid.
    const gridLine = (x0: number, y0: number, x1: number, y1: number) => {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = P.grid;
      if (P.starChart) ctx.setLineDash([1, 4]);
      ctx.stroke(); ctx.setLineDash([]);
    };
    const xt = (n: number, label: string) => { ctx.fillStyle = P.text; ctx.textAlign = 'center'; ctx.fillText(cap(label), this.plotX(n), bottom + 16); };
    const yt = (n: number, label: string, grid = true) => {
      const y = this.plotY(n); ctx.fillStyle = P.text; ctx.textAlign = 'right'; ctx.fillText(cap(label), p.x0 - 6, y + 4);
      if (grid) gridLine(p.x0, Math.round(y) + 0.5, right, Math.round(y) + 0.5);
    };
    const vline = (n: number) => { const x = Math.round(this.plotX(n)) + 0.5; gridLine(x, p.y0, x, bottom); };
    const timeAxis = () => {
      for (const [d, l] of [[90, translate('scan.map.months-3')], [180, translate('scan.map.months-6')], [365, translate('scan.map.years-1')], [730, translate('scan.map.years-2')]] as const) { vline(xUpdate(d, 0)); xt(xUpdate(d, 0), l); }
      vline(0.89); xt(0.95, translate('scan.map.years-3-plus'));
    };
    const frame = (xTitle: string, yTitle: string) => {
      if (P.starChart) {
        // Lilac corner brackets instead of a full frame, like a navigation display.
        const L = 14, x1 = p.x0 + 0.5, y1 = p.y0 + 0.5, x2 = right - 0.5, y2 = bottom + 0.5;
        ctx.save(); ctx.strokeStyle = P.frame; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1 + L); ctx.lineTo(x1, y1); ctx.lineTo(x1 + L, y1);
        ctx.moveTo(x2 - L, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + L);
        ctx.moveTo(x1, y2 - L); ctx.lineTo(x1, y2); ctx.lineTo(x1 + L, y2);
        ctx.moveTo(x2 - L, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - L);
        ctx.stroke(); ctx.restore();
      } else {
        ctx.beginPath(); ctx.moveTo(p.x0 + 0.5, p.y0); ctx.lineTo(p.x0 + 0.5, bottom + 0.5); ctx.lineTo(right, bottom + 0.5); ctx.strokeStyle = P.frame; ctx.stroke();
      }
      ctx.fillStyle = P.text; ctx.textAlign = 'center'; ctx.fillText(cap(xTitle), p.x0 + p.w / 2, bottom + 33);
      ctx.save(); ctx.translate(11, p.y0 + p.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(cap(yTitle), 0, 0); ctx.restore();
    };
    if (early) {
      // DC-082: before usage, the time axis is already true; up waits for usage.
      ctx.globalAlpha = 1; timeAxis();
      frame(translate('scan.map.last-updated'), translate('scan.map.waiting-usage'));
      ctx.restore(); return;
    }
    let xTitle: string, yTitle: string;
    if (this.lens === 'stale') {
      const z = staleZone(t);
      const zx = this.plotX(z.x) - 0.5, zy = this.plotY(z.y), zyTop = p.y0 + 2, zr = right - 2;
      ctx.fillStyle = P.zoneFill; ctx.fillRect(zx, zyTop, zr - zx, zy - zyTop);
      const sy = Math.round(this.plotY(0.893)) + 0.5; // separator under the "No use" band (no use recorded)
      ctx.beginPath(); ctx.moveTo(p.x0, sy); ctx.lineTo(right, sy); ctx.strokeStyle = P.sep; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = this.preTimed ? 1 : k; timeAxis(); ctx.globalAlpha = k; // the time axis was already there
      yt((Y_BAND[0] + Y_BAND[1]) / 2, translate('scan.map.no-use'), false);
      for (const [d, l] of [[0, translate('scan.map.today')], [90, translate('scan.map.months-3')], [180, translate('scan.map.months-6')], [365, translate('scan.map.years-1')], [730, translate('scan.map.years-2')]] as const) yt(yLastUsed(d), l);
      xTitle = translate('scan.map.last-updated'); yTitle = translate('scan.map.last-used');
      // FB-63: the border goes on after the grid lines. A grid line (1 year, 6 months...) can sit on the zone's edge, and painted first
      // the border was wiped out by it (Gentle and Suggested put the left edge exactly on "1 year").
      const zb = zoneBox(p, INSET, t);
      ctx.save(); ctx.strokeStyle = P.zoneLine; ctx.setLineDash(P.starChart ? [6, 3] : [4, 3]); ctx.strokeRect(zb.left, zb.top, zb.right - zb.left, zb.bottom - zb.top); ctx.restore();
      ctx.globalAlpha = k * 0.95;
      // FB-41: no corner labels; the axis titles and the stale zone say it.
      this.halo(cap(translate('scan.map.stale-zone', { label: this.zoneLabel })), zx + 8, zyTop + 14, 'left', P.zoneLine, P.starChart ? `600 12.5px ${P.font}` : `600 11.5px ${P.font}`);
      ctx.globalAlpha = k;
    } else if (this.lens === 'big') {
      const max = this.shown.maxSizeMB;
      // FB-30: the left column says what is in it (views and empty layers have no storage; some are not measured yet).
      const band = sizeBand(this.sprites);
      ctx.fillStyle = P.text; ctx.textAlign = 'left'; ctx.fillText(cap(band.label), p.x0 + 4, bottom + 16);
      if (band.note) this.halo(cap(band.note), p.x0 + 6, p.y0 + 12, 'left', P.text, P.starChart ? `12px ${P.font}` : `italic 11px ${P.font}`);
      for (const [mb, l] of [[1, '1 MB'], [10, '10 MB'], [100, '100 MB'], [1024, '1 GB']] as const) if (mb < max * 1.2) { vline(xSize(mb, 0, max)); xt(xSize(mb, 0, max), l); }
      yt(0, translate('scan.map.barely')); yt(0.5, translate('scan.map.fairly')); yt(1, translate('scan.map.very'));
      xTitle = translate('scan.map.storage'); yTitle = translate('scan.lens.stale');
    } else {
      [translate('scan.map.none'), '1', '2', translate('scan.map.more')].forEach((l, c) => xt((c + 0.5) / 4, l));
      yt(0, translate('scan.map.barely')); yt(0.5, translate('scan.map.fairly')); yt(1, translate('scan.map.very'));
      xTitle = translate('scan.map.maps-apps-using'); yTitle = translate('scan.lens.stale');
    }
    frame(xTitle, yTitle);
    ctx.restore();
  }

  /** Not-stale dots on a big map, as faint shading in small cells (FB-18): nothing is hidden, and it stays readable. */
  private paintDensity(pts: [number, number][], strength: number): void {
    if (!pts.length || strength <= 0.01) return;
    const ctx = this.ctx as CanvasRenderingContext2D, CELL = 6;
    const bins = densityBins(pts, CELL);
    let max = 1; for (const n of bins.values()) if (n > max) max = n;
    ctx.save(); ctx.fillStyle = this.pal.grey;
    for (const [k, n] of bins) {
      const [c, r] = k.split(',').map(Number) as [number, number];
      ctx.globalAlpha = densityAlpha(n, max) * strength;
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
    ctx.restore();
  }

  private paint(now: number): void {
    const ctx = this.ctx; if (!ctx || !this.W) return;
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawAxes();
    const revealed = this.shown.revealed, reduce = this.reduce;
    const p = this.plot(), gx = p.x0 + INSET, gw = p.w - 2 * INSET, gy = p.y0 + INSET, gh = p.h - 2 * INSET;
    const xMax = p.x0 + p.w, yMax = p.y0 + p.h, enterMs = reduce ? FADE_MS : ENTER_MS;
    const denseK = tweenAt(this.denseT, now);
    const shadePts: [number, number][] = [];
    for (const i of this.order) {
      const d = this.sprites[i] as Sprite;
      const [nx, ny, r0] = motionAt(d.mo, now);
      const x = clamp(gx + nx * gw, p.x0 + r0, xMax - r0), y = clamp(gy + (1 - ny) * gh, p.y0 + r0, yMax - r0);
      d.x = x; d.y = y;
      if (d.shade) { shadePts.push([x, y]); d.rad = 0; if (denseK >= 0.99) continue; }
      let alpha = d.candidate && revealed ? 0.88 : 0.7, r = r0;
      if (now < d.born + enterMs) {
        if (now < d.born) { if (!d.shade) d.rad = 0; continue; } // waiting for its turn in the wave
        const look = entryLook((now - d.born) / enterMs, reduce);
        alpha *= look.alpha; r *= look.scale;
      }
      if (d.shade) alpha *= 1 - denseK; else d.rad = r;
      if (this.lens === 'used' && revealed && d.usedBy === 0) alpha *= 0.7;
      if (r < 0.2 || alpha < 0.01) continue;
      ctx.globalAlpha = alpha; ctx.fillStyle = d.colour;
      // DC-135: in the star chart, stale dots glow like stars (only those: a glow on thousands of dots costs frames).
      const glow = this.pal.starChart && revealed && d.kind === 'stale';
      if (glow) { ctx.shadowColor = d.colour; ctx.shadowBlur = 8; }
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      if (glow) ctx.shadowBlur = 0;
      if (revealed && !d.shade && ringed(d, this.lens)) {
        ctx.globalAlpha = (this.lens === 'used' ? 1 : 0.9) * Math.min(1, alpha / 0.7); ctx.strokeStyle = this.pal.ring; ctx.lineWidth = this.lens === 'used' ? 1.6 : 1.1;
        ctx.beginPath(); ctx.arc(x, y, r + 1.6, 0, 7); ctx.stroke();
      }
    }
    // Shading under the dots would be nicer, but it needs this frame's positions; at its faint alpha on top reads the same.
    this.paintDensity(shadePts, denseK);
    if (this.ghosts.length) {
      this.ghosts = this.ghosts.filter((g) => now - g.start < g.dur);
      for (const g of this.ghosts) {
        const k = (now - g.start) / g.dur;
        ctx.globalAlpha = 0.7 * (1 - k); ctx.fillStyle = g.colour;
        ctx.beginPath(); ctx.arc(g.x, g.y, Math.max(0.3, g.rad * (reduce ? 1 : 1 - 0.6 * k)), 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const act = this.hover ?? (this.focusIdx >= 0 ? this.focusIdx : null);
    const a = act != null ? this.sprites[act] : undefined;
    if (a && a.rad) { ctx.strokeStyle = this.pal.focus; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(a.x, a.y, a.rad + 3.5, 0, 7); ctx.stroke(); }
  }

  private kick(): void { if (!this.raf && this.isConnected) this.raf = requestAnimationFrame(this.frame); }

  private frame = (): void => {
    this.raf = 0;
    if (!this.isConnected || !this.canvas) return;
    if (!this.canvas.clientWidth) return; // hidden: repaint when shown (ResizeObserver) or on the next update
    const now = performance.now();
    if (this.fade) {
      const e = now - this.fade.start;
      if (e >= FADE_HALF && !this.fade.swapped) { this.fade.swapped = true; if (this.fade.target !== this.lens) this.applyLens(this.fade.target); }
      if (e >= 2 * FADE_HALF) { this.fade = null; this.canvas.style.opacity = ''; }
      else this.canvas.style.opacity = String(this.fadeAlpha(now));
    }
    if (this.heightT) {
      const h = Math.round(tweenAt(this.heightT, now));
      if (h !== this.H) this.setCanvasHeight(h);
      if (tweenDone(this.heightT, now) && this.H !== this.heightT.to) this.setCanvasHeight(this.heightT.to);
    }
    this.paint(now);
    const revealing = this.shown.revealed && this.revealAt != null && now - this.revealAt < REVEAL_MS;
    if (now < this.animEnd || this.fade || revealing || this.ghosts.length) this.raf = requestAnimationFrame(this.frame);
  };

  // ---------- tooltip and keyboard ----------
  private hitTest(mx: number, my: number): number | null {
    let best: number | null = null, bd = 1e9;
    for (const d of this.sprites) {
      if (!d.rad) continue;
      const dist = Math.hypot(d.x - mx, d.y - my);
      if (dist <= Math.max(d.rad + 3, 6) && (dist < bd || (best != null && (this.sprites[best] as Sprite).rad > d.rad && dist <= bd + 1))) { best = d.i; bd = dist; }
    }
    return best;
  }

  private urlOf(d: Dot): string {
    return this.org.urlKey ? itemUrl(this.org, d.id) : `${PORTAL_URL}/home/item.html?id=${encodeURIComponent(d.id)}`;
  }

  /**
   * FB-26: the hover tip is compact and has no link (the pointer would cross other dots on the way and the tip would jump).
   * A mouse click on the dot opens it; Enter does from the keyboard; only a tap (touch) pins the tip with its link.
   */
  private showTip(i: number, announce: boolean, how: 'hover' | 'key' | 'tap' = 'hover'): void {
    const d = this.sprites[i]; if (!d) return;
    clearTimeout(this.hideTimer);
    const credits = d.credits >= 0.05 ? translate('scan.map.tip.monthly-credits', { credits: d.credits < 10 ? d.credits.toFixed(1) : fmtInt(d.credits) }) : translate('scan.map.tip.under-credits');
    render(html`<strong>${d.title}</strong><span class="dm-t-owner">${d.owner}</span>
      <span class="dm-t-row">${d.sized ? html`${formatMB(d.sizeMB)} · ${credits}` : translate('scan.map.tip.size-unmeasured')}</span>
      <span class="dm-t-why">${dotWhy(d)}</span>
      ${how === 'tap'
        ? html`<a href=${this.urlOf(d)} target="_blank" rel="noopener">${translate('scan.map.tip.open')}<span class="dc-sr">${translate('scan.new-tab')}</span></a>`
        : html`<span class="dm-t-hint">${translate(how === 'key' ? 'scan.map.tip.press-enter' : 'scan.map.tip.click')}${translate('scan.map.tip.to-open')}</span>`}`, this.tip);
    this.tip.classList.toggle('is-pinned', how === 'tap');
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = d.x + d.rad + 10, y = d.y - th / 2;
    if (x + tw > this.W - 4) x = d.x - d.rad - 10 - tw;
    x = clamp(x, 4, Math.max(4, this.W - tw - 4)); y = clamp(y, 4, Math.max(4, this.H - th - 4));
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
    if (announce) this.srLive.textContent = `${d.title}, ${d.owner}. ${dotWhy(d)}`;
  }
  private creditsText(c: number): string { return c >= 0.05 ? translate('scan.map.credits', { credits: c < 10 ? c.toFixed(1) : fmtInt(c) }) : translate('scan.map.under-credits'); }
  private hideTip(): void { clearTimeout(this.tipTimer); clearTimeout(this.hideTimer); if (this.tip) this.tip.hidden = true; this.pinned = false; }
  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => { if (!this.pinned) { this.hover = null; this.hideTip(); this.kick(); } }, 220);
  }

  private at(e: { clientX: number; clientY: number }): number | null {
    const b = this.canvas.getBoundingClientRect(); return this.hitTest(e.clientX - b.left, e.clientY - b.top);
  }
  private onMove = (e: PointerEvent): void => {
    const i = this.at(e);
    this.canvas.style.cursor = i == null ? 'default' : 'pointer';
    if (i === this.hover) return;
    clearTimeout(this.tipTimer);
    this.hover = i; this.focusIdx = -1; this.pinned = false; this.kick();
    if (i == null) { this.scheduleHide(); return; }
    clearTimeout(this.hideTimer);
    if (!this.tip.hidden) this.showTip(i, false); else this.tipTimer = window.setTimeout(() => this.showTip(i, false), TIP_DELAY);
  };
  private onLeave = (): void => { clearTimeout(this.tipTimer); this.scheduleHide(); };
  private onDown = (e: PointerEvent): void => { this.touch = e.pointerType !== 'mouse'; };
  private onClick = (e: MouseEvent): void => {
    const i = this.at(e);
    if (i == null) { this.pinned = false; this.hover = null; this.hideTip(); this.kick(); return; }
    const d = this.sprites[i];
    if (!this.touch && d) { window.open(this.urlOf(d), '_blank', 'noopener'); return; } // mouse: the dot is the link
    this.hover = i; this.pinned = true; this.showTip(i, true, 'tap'); this.kick(); // touch: a tap pins the tip with its link
  };
  /** Keyboard order: stale first, stalest first. */
  private stepOrder(): number[] {
    return this.sprites.filter((d) => d.rad).sort((a, b) => (Number(b.kind === 'stale') - Number(a.kind === 'stale')) || (b.staleness - a.staleness)).map((d) => d.i);
  }
  private onKey = (e: KeyboardEvent): void => {
    const ord = this.stepOrder(); if (!ord.length) return;
    const cur = ord.indexOf(this.focusIdx);
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const nx = e.key === 'Home' ? 0 : e.key === 'End' ? ord.length - 1
        : (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + ord.length) % ord.length;
      this.focusIdx = ord[cur < 0 && e.key !== 'End' && e.key !== 'Home' ? 0 : nx] as number;
      this.hover = null; this.pinned = true; this.showTip(this.focusIdx, true, 'key'); this.kick();
    } else if (e.key === 'Enter' && this.focusIdx >= 0) {
      const d = this.sprites[this.focusIdx]; if (d) window.open(this.urlOf(d), '_blank', 'noopener');
    } else if (e.key === 'Escape') { this.focusIdx = -1; this.hideTip(); this.kick(); }
  };
  private onBlur = (): void => { if (!this.tip.matches(':hover')) { this.focusIdx = -1; this.hideTip(); this.kick(); } };

  protected override render() {
    const f = this.floored(this.model);
    const m = f.model, hid = f.hidden;
    const ready = this.lensesReady && m.revealed;
    const note = ready ? LENSES.find((l) => l.id === this.picked)?.note ?? '' : ''; // FB-56: the switch stays disabled until usage is in; no line needed
    const dense = m.revealed && m.dots.length > DENSITY_ABOVE;
    const asDots = dense ? m.dots.filter((d) => d.kind === 'stale' || d.candidate).length : 0;
    // DC-079 and FB-43: what the floor leaves out, in one line ("4,018 layers under 3 MB (...) and 13 with minimal storage (under 0.1 MB)").
    const hidN = hid.count + hid.noStorage;
    const small = hid.count > 0 ? tn('scan.map.small-under', hid.count, { count: fmtInt(hid.count), layer: translate(hid.count === 1 ? 'scan.map.small-layer-one' : 'scan.map.small-layer-other'), mb: SMALL_LAYER_MB, credits: this.creditsText(hid.credits) }) : '';
    const empty = hid.noStorage > 0 ? tn('scan.map.small-minimal', hid.noStorage, { count: fmtInt(hid.noStorage), prefix: small ? '' : translate(hid.noStorage === 1 ? 'scan.map.small-prefix-one' : 'scan.map.small-prefix-many'), mb: NO_STORAGE_MB }) : '';
    const hiddenLine = small && empty ? translate('scan.map.hidden.join', { small, minimal: empty }) : translate('scan.map.hidden.join-only', { small, minimal: empty });
    const smallHiddenLabel = hid.count > 0 ? translate('scan.map.hidden.small', { mb: SMALL_LAYER_MB }) : '';
    const minimalHiddenLabel = hid.noStorage > 0 ? translate(hid.count > 0 ? 'scan.map.hidden.minimal-lower' : 'scan.map.hidden.minimal') : '';
    const hiddenNote = smallHiddenLabel && minimalHiddenLabel ? translate('scan.map.hidden.join', { small: smallHiddenLabel, minimal: minimalHiddenLabel }) : translate('scan.map.hidden.join-only', { small: smallHiddenLabel, minimal: minimalHiddenLabel });
    return html`
      <div class="dm-wrap" data-lens=${this.lens}>
        <div class="dm-lens">
          ${this.lenses.length < 2 ? nothing : html`<calcite-segmented-control scale="s" width="auto" label=${translate('scan.map.axis-arrange')} ?disabled=${!ready} data-scan="lenses"
            @calciteSegmentedControlChange=${(e: Event) => this.setLens((e.target as HTMLElement & { value: string }).value as LensId)}>
            ${LENSES.filter((l) => this.lenses.includes(l.id)).map((l) => html`<calcite-segmented-control-item value=${l.id} .checked=${live(l.id === this.picked)}>${l.label}</calcite-segmented-control-item>`)}
          </calcite-segmented-control>`}
          <span class="dm-lens-note" data-scan="lens-note">${note}</span>
        </div>
        <div class="dm-stage">
          <canvas tabindex="0" role="application" aria-roledescription=${translate('scan.map.canvas-title')} aria-describedby="dc-dm-help dc-dm-tip" data-scan="dots"
            aria-label=${translate('scan.map.aria', { dense: dense ? translate('scan.map.aria.density') : '', hidden: hiddenNote && !this.showSmall ? translate('scan.map.aria.hidden', { label: hiddenNote }) : '' })}
            @pointermove=${this.onMove} @pointerleave=${this.onLeave} @pointerdown=${this.onDown} @click=${this.onClick} @keydown=${this.onKey} @blur=${this.onBlur}></canvas>
          <div class="dm-tip" id="dc-dm-tip" role="tooltip" hidden
            @pointerenter=${() => clearTimeout(this.hideTimer)} @pointerleave=${() => this.scheduleHide()}></div>
          <div class="dm-sr" aria-live="polite"></div>
          <p class="dm-sr" id="dc-dm-help" data-scan="dots-help">${ready ? tn('scan.map.help.ready', m.dots.length, { count: fmtInt(m.dots.length), stale: fmtInt(m.dots.filter((d) => d.kind === 'stale').length) }) : translate('scan.map.help.waiting')}${translate('scan.map.help.keys')}</p>
        </div>
        <div class="dm-legend">
          <span class="dm-lg"><span class="dm-ramp" style="background: linear-gradient(90deg, ${this.pal.ramp.from}, ${this.pal.ramp.mid}, ${this.pal.ramp.to})"></span><span class="dm-ramp-labels"><span>${translate('scan.map.legend.barely')}</span><span>${translate('scan.map.legend.very')}</span></span></span>
          ${dense
            ? html`<span class="dm-lg" data-scan="density"><i class="dm-shade"></i>${translate('scan.map.density', { stale: fmtInt(asDots), others: fmtInt(m.dots.length - asDots) })}</span>`
            : html`<span class="dm-lg"><i class="dm-grey"></i>${translate('scan.map.legend.not-stale')}</span>`}
          <span class="dm-lg"><i class="dm-sz s"></i><i class="dm-sz l"></i>${translate('scan.map.legend.storage-size')}</span>
          <span class="dm-lg"><i class="dm-sz m dm-ringed"></i>${translate('scan.map.legend.used')}</span>
          ${hiddenLine ? html`<span class="dm-lg dm-small" data-scan="small-floor">${tn(this.showSmall ? 'scan.map.small.shown' : 'scan.map.small.hidden', hidN, { line: hiddenLine })}
            <button type="button" class="dm-link" data-scan="small-toggle" @click=${() => this.setShowSmall(!this.showSmall)}>${translate(this.showSmall ? 'scan.map.hide-them' : 'scan.map.show-them')}</button></span>` : nothing}
          ${m.exact ? nothing : html`<span class="dm-lg"><i class="dm-pending"></i>${translate('scan.map.legend.pending')}</span>`}
        </div>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-dot-map': DcDotMap } }
