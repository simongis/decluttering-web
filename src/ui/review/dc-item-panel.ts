// DC-147c: the item panel. One shared instance, mounted once by the owner list; a row click (or Enter/Space on the row's
// bars button) opens it for that family with the clicked layer highlighted. Two sections, from what the scan already holds
// (no requests to paint): Usage (headline in days, calendar or monthly bars, 12 months or 2 years, per member, a table) and
// Connections (Layer and views -> Used directly -> Through a map; a grouped list on narrow panels). Design source:
// prototypes/item-panel/. Motion (BACKLOG "DC-147 decisions"): slide in from inline-end with a fade, about 200 ms ease-out,
// out in about 150 ms, the scrim fades; reduced motion fades only. Calcite's own sheet transition is switched off so these
// timings are ours.
// DC-147d: once painted, Connections asks ArcGIS Online's relatedItems (forward) for the family's used-directly maps and adds
// a fourth column, "Offline and surveys" (Map Areas and Survey123 forms): reserved from the first paint, so nothing moves.
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { repeat } from 'lit/directives/repeat.js';
import { guard } from 'lit/directives/guard.js';
import '@esri/calcite-components/dist/components/calcite-sheet';
import '@esri/calcite-components/dist/components/calcite-panel';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import '@esri/calcite-components/dist/components/calcite-select';
import '@esri/calcite-components/dist/components/calcite-option';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import { LocaleController } from '../../i18n/controller';
import { formatDate, formatNumber, getLocale, t, tn } from '../../i18n';
import type { Data, Dependency, Org, Row, Service } from '../../domain/types';
import { itemUrl } from '../../domain/format';
import { usageContext, usageSeries, type Span, type UsageSeries } from '../../domain/usage-series';
import { connectionsMemo, familyById, type Connections } from '../../domain/connections';
import { ownerNamer } from '../../domain/broken-refs';
import { AREA_TYPES, mapsToCheck, relatedExtras, type RelatedExtras } from '../../domain/related-extras';
import { relatedLoader, useRelatedData } from './related-source';
import { credit } from '../shared/text';
import { saySize } from './helpers';
import { itemTypeIcon, statusChip } from './item-chips';
import { calendarSvg, dayReadout, isToday, monthBarsSvg, monthReadout } from './panel-charts';
import { longIso, sayHeadline, monthName } from './usage-words';
import { HATCH_ID } from './dc-usage-bars';
import type { ItemOpenDetail } from './dc-family-row';

/** Nodes per Connections column before "+N more". */
export const CAP = 8;
const OPEN_MS = 200, CLOSE_MS = 150;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Col = 'family' | 'direct' | 'through' | 'extra';
interface Node { id: string; title: string; type: string; owner: string; status?: string; modified?: string; col: Col; focus?: boolean; via?: string[]; from?: string[] }
/** DC-147d: the extras for the open family, with the maps asked and how many the cap left out. */
interface Extras { x: RelatedExtras; maps: string[]; more: number; lit: Set<string> }

@customElement('dc-item-panel')
export class DcItemPanel extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) data: Data | null = null;
  @property({ attribute: false }) org!: Pick<Org, 'urlKey' | 'customBaseUrl'>;
  @property({ type: Boolean }) countSweeps = false;
  @property({ type: Boolean }) depsKnown = true;
  @property({ type: Boolean }) stopped = false;
  /** Member mode (my items): maps and apps are not checked for this view. */
  @property({ type: Boolean }) member = false;
  @property({ type: Boolean }) canSeeUsage = true;

  @state() private open = false;
  @state() private row: Row | null = null;
  @state() private focusId = '';
  @state() private span: Span = 365;
  @state() private chart: 'cal' | 'bars' = 'cal';
  /** '' for all members together, else one member's id. */
  @state() private sel = '';
  @state() private table = false;
  @state() private list = false;
  @state() private expanded = new Set<Col>();
  @state() private width = 0;
  /** The day or month the readout names. Moving it redraws the usage readout only: Connections is guarded, links are not redrawn. */
  @state() private cursor = -1;
  /** Bumped when relatedItems answers land or are asked, so the guarded Connections section draws them. */
  @state() private relatedTick = 0;
  private opener: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private seriesMemo: { key: string; data: Data; family: Row['family']; s: UsageSeries } | null = null;
  private chartMemo: { s: UsageSeries; width: number; chart: 'cal' | 'bars'; svg: string } | null = null;
  private offRelated: (() => void) | null = null;
  private relatedTimer = 0;

  protected override createRenderRoot(): HTMLElement { return this; }

  override connectedCallback(): void {
    super.connectedCallback();
    // DC-147d: answers land a few at a time; only an open panel draws them.
    this.offRelated = relatedLoader.subscribe(() => { if (this.open) this.relatedTick++; });
  }

  override disconnectedCallback(): void {
    this.ro?.disconnect(); this.ro = null;
    this.offRelated?.(); this.offRelated = null;
    cancelAnimationFrame(this.relatedTimer);
    super.disconnectedCallback();
  }

  /** DC-147d: every relatedItems call the app has sent (a test hook). */
  get relatedLog(): readonly { mapId: string; path: string; kind: string; at: number }[] { return relatedLoader.log; }

  /** DC-147d: relatedItems can be asked once the connections are known (not in member mode, not while maps are being read). */
  private get canAskRelated(): boolean { return !!this.data && !this.member && (this.depsKnown || this.stopped); }

  /** DC-147d: after the panel has painted, ask for the family's maps (at most 20); answers already kept are not asked again. */
  private startRelated(): void {
    cancelAnimationFrame(this.relatedTimer);
    this.relatedTimer = requestAnimationFrame(() => setTimeout(() => {
      const r = this.row, data = this.data;
      if (!this.open || !r || !data || !this.canAskRelated) return;
      useRelatedData(data);
      relatedLoader.loadFor(connectionsMemo(data, r.family, this.focusId), 'open');
      this.relatedTick++;
    }, 0));
  }

  /** Open for a row (from a row click). Re-opening for another row while open swaps the content. */
  show(d: ItemOpenDetail): void {
    this.row = d.row;
    this.focusId = d.member;
    this.opener = d.opener;
    this.sel = '';
    this.table = false;
    this.expanded = new Set();
    this.cursor = -1;
    this.open = true;
  }

  get isOpen(): boolean { return this.open; }

  /** Calcite asks before it closes (Escape, the scrim, the close button): play the way out first. */
  private beforeClose = async (): Promise<void> => {
    const panel = this.querySelector<HTMLElement>('calcite-panel');
    const scrim = this.querySelector<HTMLElement>('.ip-scrim');
    const fade = reduced();
    const rtl = getComputedStyle(this).direction === 'rtl';
    const out: Keyframe[] = fade ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${rtl ? '-' : ''}48px)` }];
    const anims = [panel?.animate(out, { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' }), scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'forwards' })];
    await Promise.all(anims.map((a) => a?.finished.catch(() => undefined)));
  };

  private onClosed = () => {
    if (!this.open) return;
    this.open = false;
    const back = this.opener;
    this.opener = null;
    // Calcite gives focus back to what had it before the sheet; the row's button is the right place.
    requestAnimationFrame(() => back?.isConnected && back.focus());
    this.dispatchEvent(new CustomEvent('dc-item-close', { bubbles: true, composed: true }));
  };

  private onOpened = () => {
    const panel = this.querySelector<HTMLElement & { setFocus?: () => Promise<void> }>('calcite-panel');
    void panel?.setFocus?.();
  };

  /**
   * New data (a refresh, a rescan) while a row is held: the family, its members and their usage are looked up again in the new
   * data, so usage days, gaps and sweeps all come from one scan. A family no longer in the data closes the panel.
   */
  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('data') || !this.row) return;
    const f = this.data ? familyById(this.data, this.row.family.id) : null;
    if (!f) { this.row = null; this.cursor = -1; if (this.open) this.onClosed(); return; }
    if (f === this.row.family) return;
    this.row = { ...this.row, family: f, source: f.source, views: f.views };
    if (this.sel && f.source.id !== this.sel && !f.views.some((v) => v.id === this.sel)) { this.sel = ''; this.cursor = -1; }
  }

  protected override updated(changed: PropertyValues): void {
    // A new row, a scan that has just finished reading maps, or a rescan (a new run clears the answers): ask again.
    if (this.open && (['open', 'row', 'data', 'depsKnown', 'stopped'] as const).some((k) => changed.has(k))) this.startRelated();
    if (changed.has('open') && this.open) {
      const panel = this.querySelector<HTMLElement>('calcite-panel');
      const scrim = this.querySelector<HTMLElement>('.ip-scrim');
      const fade = reduced();
      const rtl = getComputedStyle(this).direction === 'rtl';
      const inn: Keyframe[] = fade ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(${rtl ? '-' : ''}100%)` }, { opacity: 1, transform: 'none' }];
      panel?.getAnimations().forEach((a) => a.cancel());
      scrim?.getAnimations().forEach((a) => a.cancel());
      panel?.animate(inn, { duration: OPEN_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      scrim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS });
      const host = this.querySelector<HTMLElement>('.ip');
      if (host && !this.ro) {
        this.ro = new ResizeObserver(() => {
          const w = Math.round(this.querySelector<HTMLElement>('.ip-usage')?.getBoundingClientRect().width ?? 0);
          if (w && Math.abs(w - this.width) > 1) this.width = w;
          this.drawLinks();
        });
      }
      if (host) { this.ro?.disconnect(); this.ro?.observe(host); }
    }
    if (this.open) {
      // The day or month the readout names gets a ring (pointer or arrow keys).
      const chart = this.querySelector('.ip-chart');
      chart?.querySelectorAll('.cur').forEach((el) => el.classList.remove('cur'));
      if (this.cursor >= 0) chart?.querySelector(this.chart === 'cal' ? `[data-d="${this.cursor}"]` : `[data-m="${this.cursor}"]`)?.classList.add('cur');
      // A cursor move changes no node: the links stay as drawn.
      if (!(changed.size === 1 && changed.has('cursor'))) requestAnimationFrame(() => this.drawLinks());
    }
  }

  private series(): UsageSeries | null {
    const r = this.row, data = this.data;
    if (!r || !data) return null;
    const ctx = usageContext(data, this.countSweeps);
    const key = `${r.family.id}|${this.span}|${this.sel}|${this.countSweeps}`;
    if (this.seriesMemo?.key === key && this.seriesMemo.data === data && this.seriesMemo.family === r.family) return this.seriesMemo.s;
    const s = usageSeries(r.family, ctx, { span: this.span, member: this.sel || undefined });
    this.seriesMemo = { key, data, family: r.family, s };
    return s;
  }

  private members(): Service[] { const r = this.row; return r ? [r.family.source, ...r.family.views] : []; }
  private ownerName(u: string): string { return this.data ? ownerNamer(this.data.owners)(u) : u; }
  private memberName(id: string): string {
    const r = this.row;
    if (!r) return '';
    return r.family.source.id === id ? t('review.panel.member.source') : r.family.views.find((v) => v.id === id)?.title ?? '';
  }

  /* ------------------------------------------------------------------ header */
  private meta(m: Service): string {
    const r = this.row as Row;
    const type = t(m.isView ? 'review.panel.type.view' : 'review.panel.type.layer');
    const owner = this.ownerName(m.owner);
    if (m.isView) return t('review.panel.metaView', { type, owner });
    return t('review.panel.meta', { type, owner, size: saySize(r, this.stopped), credits: r.sizeKnown ? credit(r.credits) : '—' });
  }

  /* ------------------------------------------------------------------ usage */
  private seg(name: string, value: string, opts: [string, string][], label: string, on: (v: string) => void) {
    return html`<calcite-segmented-control scale="s" data-sw=${name} label=${label}
      @calciteSegmentedControlChange=${(e: Event) => on((e.target as HTMLElement & { value: string }).value)}>
      ${opts.map(([v, l]) => html`<calcite-segmented-control-item value=${v} ?checked=${v === value}>${l}</calcite-segmented-control-item>`)}
    </calcite-segmented-control>`;
  }

  private memberSwitch() {
    const ms = this.members();
    if (ms.length < 2) return nothing;
    const opts: [string, string][] = [['', t('review.panel.member.all', { count: ms.length })], ...ms.map((m) => [m.id, this.memberName(m.id)] as [string, string])];
    const set = (v: string) => { this.sel = v; this.cursor = -1; };
    // Short labels fit a segmented control; long view titles get a select (no sideways scroll at 390 px).
    if (ms.length <= 3 && opts.reduce((a, [, l]) => a + l.length, 0) <= 44) return html`<div class="ip-mem">${this.seg('member', this.sel, opts, t('review.panel.member'), set)}</div>`;
    return html`<div class="ip-mem"><calcite-select scale="s" data-sw="member" label=${t('review.panel.member')}
      @calciteSelectChange=${(e: Event) => set((e.target as HTMLElement & { value: string }).value)}>
      ${opts.map(([v, l]) => html`<calcite-option value=${v} ?selected=${v === this.sel}>${l}</calcite-option>`)}
    </calcite-select></div>`;
  }

  private onChartMove = (e: PointerEvent) => {
    const el = (e.target as Element).closest?.('[data-d], [data-m]') as SVGElement | null;
    if (!el) return;
    const i = Number(el.dataset.d ?? el.dataset.m);
    if (i !== this.cursor) this.cursor = i;
  };

  private onChartKey = (e: KeyboardEvent) => {
    const s = this.series();
    if (!s) return;
    const cal = this.chart === 'cal';
    const n = cal ? s.days.length : s.months.length;
    // The calendar runs left to right in time: Right is a week later (fewer days ago), Down a day later.
    let c = this.cursor < 0 ? (cal ? 0 : n - 1) : this.cursor;
    const later = (k: number) => (cal ? c - k : c + k);
    switch (e.key) {
      case 'ArrowRight': c = later(cal ? 7 : 1); break;
      case 'ArrowLeft': c = later(cal ? -7 : -1); break;
      case 'ArrowDown': c = later(1); break;
      case 'ArrowUp': c = later(-1); break;
      case 'Home': c = cal ? n - 1 : 0; break;
      case 'End': c = cal ? 0 : n - 1; break;
      default: return;
    }
    e.preventDefault();
    this.cursor = Math.max(0, Math.min(n - 1, c));
  };

  private readout(s: UsageSeries) {
    const cal = this.chart === 'cal';
    if (this.cursor < 0) return html`<p class="ip-read muted" aria-live="polite">${t(cal ? 'review.panel.hintDay' : 'review.panel.hintMonth')}</p>`;
    const names = s.members.map((id) => this.memberName(id));
    const r = cal ? dayReadout(s, Math.min(this.cursor, s.days.length - 1), names) : monthReadout(s.months[Math.min(this.cursor, s.months.length - 1)] as UsageSeries['months'][number], Math.min(this.cursor, s.months.length - 1) === s.months.length - 1);
    return html`<p class="ip-read" aria-live="polite"><b>${r.head}</b> ${r.lines.join(' · ')}</p>`;
  }

  private legend(s: UsageSeries) {
    const days = s.days;
    const hasGap = days.some((d) => d.notRead);
    const hasSweep = days.some((d) => d.sweepTouch && !d.notRead);
    const all = s.headline.allNotRead;
    const sw = (cls: string) => html`<svg width="12" height="12" aria-hidden="true"><rect class=${cls} x=${cls === 'sw' ? 0.5 : 0} y=${cls === 'sw' ? 0.5 : 0} width=${cls === 'sw' ? 11 : 12} height=${cls === 'sw' ? 11 : 12} rx="2"></rect></svg>`;
    const hatch = html`<svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="2" fill="url(#${HATCH_ID})"></rect></svg>`;
    if (this.chart === 'bars') {
      return html`<div class="ip-legend"><span class="lg">${sw('b-real')}${t('review.panel.legReal')}</span>
        ${hasSweep ? html`<span class="lg">${sw('b-sweep')}${t('review.panel.legSweep')}</span>` : nothing}
        ${hasGap ? html`<span class="lg">${hatch}${t('review.panel.legNotRead')}</span>` : nothing}</div>`;
    }
    return html`<div class="ip-legend">
      ${all ? nothing : html`<span class="lg lg-scale"><span>${t('review.panel.fewer')}</span>${['c0', 'q1', 'q2', 'q3', 'q4'].map((q, k) => html`<span title=${t(`review.panel.bucket.${k as 0 | 1 | 2 | 3 | 4}`)}>${sw(q)}<span class="sr">${t(`review.panel.bucket.${k as 0 | 1 | 2 | 3 | 4}`)}</span></span>`)}<span>${t('review.panel.more')}</span></span>`}
      ${s.headline.lastUse ? html`<span class="lg"><svg width="12" height="12" aria-hidden="true"><rect class="q2 last" x="1" y="1" width="10" height="10" rx="2"></rect></svg>${t('review.panel.legLast')}</span>` : nothing}
      <span class="lg"><svg width="14" height="14" aria-hidden="true"><rect class="c0" x="3" y="3" width="8" height="8" rx="2"></rect><rect class="today" x="1" y="1" width="12" height="12" rx="3"></rect></svg>${t(isToday(s) ? 'review.panel.legToday' : 'review.panel.legScanDay')}: ${longIso(s.days[0]?.date ?? s.to)}</span>
      ${hasSweep ? html`<span class="lg">${sw('sw')}${t('review.panel.legSweep')}</span>` : nothing}
      ${hasGap ? html`<span class="lg">${hatch}${t('review.panel.legNotRead')}</span>` : nothing}
    </div>`;
  }

  private monthTable(s: UsageSeries) {
    return html`<table class="ip-table"><caption class="sr">${t(this.chart === 'cal' ? 'review.panel.calLabel' : 'review.panel.barLabel', { from: longIso(s.from), to: longIso(s.to), headline: '' })}</caption>
      <thead><tr><th scope="col">${t('review.panel.col.month')}</th><th scope="col">${t('review.panel.col.days')}</th><th scope="col">${t('review.panel.col.req')}</th></tr></thead>
      <tbody>${s.months.map((m) => html`<tr><th scope="row">${monthName(m.month)}</th>${m.notReadDays >= m.days
        ? html`<td colspan="2">${t('review.panel.legNotRead')}</td>`
        : html`<td>${formatNumber(m.requestDays)}${m.notReadDays ? ' *' : ''}</td><td>${formatNumber(m.requests)}</td>`}</tr>`)}</tbody></table>`;
  }

  /** The chart's SVG text, built again only when the series, width or chart changes (not on a cursor move). */
  private chartSvg(s: UsageSeries, width: number): string {
    const m = this.chartMemo;
    if (m && m.s === s && m.width === width && m.chart === this.chart) return m.svg;
    const svg = this.chart === 'cal' ? calendarSvg(s, width) : monthBarsSvg(s, width);
    this.chartMemo = { s, width, chart: this.chart, svg };
    return svg;
  }

  private usage() {
    const r = this.row as Row;
    if (!this.canSeeUsage) return html`<p class="muted">${t('review.panel.noUsage')}</p>`;
    const s = this.series();
    if (!s) return nothing;
    const fam = s.members.length > 1;
    const head = sayHeadline(s.headline, fam);
    const width = Math.max(260, this.width || 600);
    const cal = this.chart === 'cal';
    const label = t(cal ? 'review.panel.calLabel' : 'review.panel.barLabel', { from: longIso(s.from), to: longIso(s.to), headline: head });
    const chart = this.chartSvg(s, width);
    const usageUrl = itemUrl(this.org, this.sel || this.focusId || r.source.id);
    return html`
      <p class="ip-head" data-usage-headline>${head}</p>
      ${s.headline.notReadBefore ? html`<p class="ip-note">${t('review.panel.notReadBefore', { date: longIso(s.headline.notReadBefore) })}</p>` : nothing}
      <div class="ip-switches">
        ${this.seg('chart', this.chart, [['cal', t('review.panel.chart.cal')], ['bars', t('review.panel.chart.bars')]], t('review.panel.chart'), (v) => { this.chart = v as 'cal' | 'bars'; this.cursor = -1; })}
        ${this.memberSwitch()}
      </div>
      <div class="ip-chart" tabindex="0" role="group" data-chart=${this.chart} aria-label=${`${label} ${t(cal ? 'review.panel.keysDay' : 'review.panel.keysMonth')}`}
        @pointermove=${this.onChartMove} @keydown=${this.onChartKey}>${unsafeSVG(chart)}</div>
      ${this.readout(s)}
      ${this.legend(s)}
      <p class="ip-fine">${t('review.panel.what')}</p>
      <p class="ip-fine">${t('review.panel.utc')} · <button type="button" class="linkish" data-act="table" aria-expanded=${String(this.table)} @click=${() => { this.table = !this.table; }}>${t(this.table ? 'review.panel.hideTable' : 'review.panel.asTable')}</button>
        · <calcite-link href=${usageUrl} target="_blank" rel="noopener" icon-end="launch">${t('review.panel.usageLink')}</calcite-link></p>
      ${this.table ? this.monthTable(s) : nothing}`;
  }

  /* ------------------------------------------------------------------ connections */
  private nodes(c: Connections): Node[] {
    const svc = new Map(this.members().map((m) => [m.id, m]));
    const fam: Node[] = c.members.map((m) => {
      const s = svc.get(m.id) as Service;
      return { id: m.id, title: m.title, type: 'Feature Layer', owner: s.owner, status: s.contentStatus, modified: s.modified, col: 'family', focus: m.id === this.focusId };
    });
    const dep = (d: Dependency, col: Col, via?: string[]): Node => ({ id: d.id, title: d.title, type: d.type, owner: d.owner, status: d.contentStatus, modified: d.modified, col, via });
    const mapTitle = new Map(c.direct.map((u) => [u.item.id, u.item.title]));
    const ex = this.extrasOf(c);
    const extra = ex ? [...ex.x.areas, ...ex.x.surveys].map((e): Node => ({ ...dep(e.item, 'extra'), from: e.maps.map((id) => mapTitle.get(id) ?? id) })) : [];
    return [...fam, ...c.direct.map((u) => dep(u.item, 'direct')), ...c.throughMap.map((u) => dep(u.item, 'through', u.maps.map((id) => mapTitle.get(id) ?? id))), ...extra];
  }

  /** DC-147d: what relatedItems has added so far for this family (null: nothing to ask, or it can't be asked here). */
  private extrasOf(c: Connections): Extras | null {
    if (!this.canAskRelated) return null;
    const { maps, more } = mapsToCheck(c);
    if (!maps.length) return null;
    const known = new Set<string>([...c.members.map((m) => m.id), ...c.direct.map((u) => u.item.id), ...c.throughMap.map((u) => u.item.id)]);
    const x = relatedExtras(maps, new Map(maps.map((m) => [m, relatedLoader.result(m)])), known);
    return { x, maps, more, lit: new Set(c.direct.filter((u) => u.focus).map((u) => u.item.id)) };
  }

  /** DC-147d: the quiet lines under the extras: checking, not available, couldn't check, none found, maps left out. */
  private extrasNotes(ex: Extras) {
    const x = ex.x, found = x.areas.length + x.surveys.length;
    return html`${x.pending ? html`<p class="ip-fine x-note" role="status" data-related="checking"><span class="x-spin" aria-hidden="true"></span>${t('review.panel.extrasChecking')}</p>` : nothing}
      ${!x.pending && x.denied ? html`<p class="ip-fine x-note" data-related="denied">${t('review.panel.extrasDenied')}</p>` : nothing}
      ${!x.pending && x.failed ? html`<p class="ip-fine x-note" data-related="failed">${t('review.panel.extrasFailed')}</p>` : nothing}
      ${!x.pending && x.checked && !found ? html`<p class="ip-fine x-note" data-related="none">${t('review.panel.extrasNone')}</p>` : nothing}
      ${ex.more ? html`<p class="ip-fine x-note" data-related="more">${tn('review.panel.extrasMore', ex.more, { count: formatNumber(ex.more) })}</p>` : nothing}`;
  }

  private viaText(n: Node): string {
    const f = n.from ?? [];
    if (f.length) return f.length === 1 ? t('review.panel.from', { map: f[0] as string }) : t('review.panel.fromMore', { map: f[0] as string, count: formatNumber(f.length - 1) });
    const v = n.via ?? [];
    if (!v.length) return '';
    return v.length === 1 ? t('review.panel.through', { map: v[0] as string }) : t('review.panel.throughMore', { map: v[0] as string, count: formatNumber(v.length - 1) });
  }

  private nodeEl(n: Node) {
    return html`<li><a class="node ${n.focus ? 'me' : ''}" data-id=${n.id} href=${itemUrl(this.org, n.id)} target="_blank" rel="noopener" aria-current=${n.focus ? 'true' : nothing}>
      <calcite-icon icon=${itemTypeIcon(n.type)} scale="s" text-label=${n.type}></calcite-icon>
      <span class="nt">${n.title}</span>
      <span class="no">${this.ownerName(n.owner)}</span>
      ${n.focus ? html`<span class="nme">${t('review.panel.youOpened')}</span>` : nothing}
      ${n.via?.length || n.from?.length ? html`<span class="nvia">${this.viaText(n)}</span>` : nothing}
      ${statusChip(n.status) === nothing ? nothing : html`<span class="ns">${statusChip(n.status)}</span>`}
    </a></li>`;
  }

  private colHead(col: Col): string {
    return t(col === 'family' ? 'review.panel.col.family' : col === 'direct' ? 'review.panel.col.direct' : col === 'through' ? 'review.panel.col.through' : 'review.panel.col.extra');
  }

  private diagram(nodes: Node[], ex: Extras | null) {
    // The extras column is there from the first paint whenever there are maps to ask, so its answers never move the others.
    const cols = (['family', 'direct', 'through', 'extra'] as Col[]).filter((c) => (c === 'extra' ? !!ex : nodes.some((n) => n.col === c)));
    return html`<div class="diagram" style=${`--cols:${cols.length}`}><svg class="links" aria-hidden="true"></svg>
      ${cols.map((col) => {
        const all = nodes.filter((n) => n.col === col);
        const open = this.expanded.has(col) || all.length <= CAP;
        const shown = open ? all : all.slice(0, CAP);
        const more = all.length - shown.length;
        const list = col === 'extra'
          ? html`${this.extraGroup(t('review.panel.grp.areas'), shown.filter((n) => AREA_TYPES.has(n.type)))}${this.extraGroup(t('review.panel.grp.surveys'), shown.filter((n) => !AREA_TYPES.has(n.type)))}`
          : html`<ul>${repeat(shown, (n) => n.id, (n) => this.nodeEl(n))}</ul>`;
        return html`<section class="col ${col === 'extra' ? 'col-x' : ''}" data-col=${col} aria-label=${this.colHead(col)}><h4 class="ch">${this.colHead(col)} ${col === 'extra' && !all.length ? nothing : html`<span class="muted">${formatNumber(all.length)}</span>`}</h4>
          ${list}
          ${more ? html`<button type="button" class="more" data-more=${col} @click=${() => this.expand(col)}>${t('review.panel.moreN', { count: formatNumber(more) })}</button>` : nothing}
          ${col === 'extra' && ex ? this.extrasNotes(ex) : nothing}
        </section>`;
      })}</div>`;
  }

  private extraGroup(h: string, list: Node[]) {
    return list.length ? html`<h5 class="xh">${h}</h5><ul>${repeat(list, (n) => n.id, (n) => this.nodeEl(n))}</ul>` : nothing;
  }

  private expand(col: Col) {
    this.expanded = new Set([...this.expanded, col]);
    // Focus moves to the first node the button revealed.
    void this.updateComplete.then(() => this.querySelectorAll<HTMLElement>(`.diagram .col[data-col="${col}"] .node`)[CAP]?.focus());
  }

  private listView(nodes: Node[], ex: Extras | null) {
    const line = (n: Node) => {
      const type = n.col === 'family' ? t(this.members().find((m) => m.id === n.id)?.isView ? 'review.panel.type.view' : 'review.panel.type.layer') : n.type;
      const bits = [type, this.ownerName(n.owner)];
      if (n.modified) bits.push(t('review.panel.updated', { date: formatDate(new Date(n.modified)) }));
      const via = this.viaText(n);
      return via ? `${bits.join(' · ')} · ${via}` : bits.join(' · ');
    };
    const item = (n: Node) => html`<li class="li">
      <calcite-icon icon=${itemTypeIcon(n.type)} scale="m" text-label=${n.type}></calcite-icon>
      <span class="lt"><a href=${itemUrl(this.org, n.id)} target="_blank" rel="noopener">${n.title}</a>${n.focus ? html` <span class="nme">${t('review.panel.youOpened')}</span>` : nothing}
        <span class="ls">${line(n)}</span></span>
      <span class="lc">${statusChip(n.status)}</span></li>`;
    const grp = (h: string, list: Node[], lvl: 'h4' | 'h5' = 'h4') => (list.length
      ? html`${lvl === 'h4' ? html`<h4>${h} <span class="muted">${formatNumber(list.length)}</span></h4>` : html`<h5>${h} <span class="muted">${formatNumber(list.length)}</span></h5>`}<ul>${list.map(item)}</ul>` : nothing);
    const direct = nodes.filter((n) => n.col === 'direct');
    const isMap = (n: Node) => n.type === 'Web Map' || n.type === 'Web Scene';
    return html`<div class="clist">
      ${grp(this.colHead('family'), nodes.filter((n) => n.col === 'family'))}
      ${direct.length ? html`<h4>${this.colHead('direct')} <span class="muted">${formatNumber(direct.length)}</span></h4>
        ${grp(t('review.panel.grp.maps'), direct.filter(isMap), 'h5')}${grp(t('review.panel.grp.apps'), direct.filter((n) => !isMap(n)), 'h5')}` : nothing}
      ${grp(this.colHead('through'), nodes.filter((n) => n.col === 'through'))}
      ${ex ? html`<h4>${this.colHead('extra')}${nodes.some((n) => n.col === 'extra') ? html` <span class="muted">${formatNumber(nodes.filter((n) => n.col === 'extra').length)}</span>` : nothing}</h4>
        ${grp(t('review.panel.grp.areas'), nodes.filter((n) => n.col === 'extra' && AREA_TYPES.has(n.type)), 'h5')}${grp(t('review.panel.grp.surveys'), nodes.filter((n) => n.col === 'extra' && !AREA_TYPES.has(n.type)), 'h5')}
        <div class="x-notes">${this.extrasNotes(ex)}</div>` : nothing}
    </div>`;
  }

  private connections() {
    const r = this.row as Row, data = this.data as Data;
    if (this.member) return html`<p class="ip-empty">${t('review.panel.notChecked')}</p>`;
    if (!this.depsKnown && !this.stopped) return html`<p class="ip-empty">${t('review.panel.checking')}</p>`;
    const c = connectionsMemo(data, r.family, this.focusId);
    const nodes = this.nodes(c);
    const ex = this.extrasOf(c);
    const used = c.direct.length + c.throughMap.length;
    const fam = c.members.length > 1;
    const stoppedNote = this.stopped ? html`<p class="ip-note">${t('review.panel.stopped')}</p>` : nothing;
    if (!used && !fam) {
      return html`${stoppedNote}<div class="ip-empty" data-conn="empty"><calcite-icon icon="information" scale="m"></calcite-icon>
        <div><p class="ip-empty-h">${t('review.panel.empty')}</p><p class="ip-fine">${t('review.panel.emptyNote')}</p></div></div>`;
    }
    return html`${stoppedNote}
      <div class="conn ${this.list ? 'as-list' : ''}">
        ${this.diagram(nodes, ex)}
        ${this.listView(nodes, ex)}
      </div>
      ${!used ? html`<p class="ip-fine">${t('review.panel.emptyFam')} ${t('review.panel.emptyNote')}</p>` : nothing}
      ${!c.throughMapKnown && c.counts.maps > 0 ? html`<p class="ip-fine">${t('review.panel.throughUnknown')}</p>` : nothing}
      <p class="ip-fine list-toggle"><button type="button" class="linkish" data-act="list" aria-expanded=${String(this.list)} @click=${() => { this.list = !this.list; }}>${t(this.list ? 'review.panel.hideList' : 'review.panel.asList')}</button></p>`;
  }

  /** The connectors: member -> direct use, map -> app through it. Drawn after layout; a hidden node joins its "+N more". */
  private drawLinks(): void {
    const host = this.querySelector<HTMLElement>('.diagram');
    const svgEl = host?.querySelector('svg.links');
    const r = this.row, data = this.data;
    if (!host || !svgEl || !r || !data) return;
    if (!host.offsetParent) { svgEl.innerHTML = ''; return; }
    const c = connectionsMemo(data, r.family, this.focusId);
    const hr = host.getBoundingClientRect();
    const anchor = (id: string, col: Col): HTMLElement | null =>
      host.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`) ?? host.querySelector<HTMLElement>(`.more[data-more="${col}"]`);
    const edges: [HTMLElement, HTMLElement, boolean][] = [];
    const seen = new Set<string>();
    const add = (a: HTMLElement | null, b: HTMLElement | null, on: boolean) => {
      if (!a || !b) return;
      const k = `${a.dataset.id ?? a.dataset.more}>${b.dataset.id ?? b.dataset.more}`;
      if (seen.has(k)) return;
      seen.add(k); edges.push([a, b, on]);
    };
    for (const u of c.direct) for (const m of u.members) add(anchor(m, 'family'), anchor(u.item.id, 'direct'), m === c.focus);
    for (const u of c.throughMap) for (const m of u.maps) add(anchor(m, 'direct'), anchor(u.item.id, 'through'), u.focus);
    const ex = this.extrasOf(c);
    if (ex) for (const e of [...ex.x.areas, ...ex.x.surveys]) for (const m of e.maps) add(anchor(m, 'direct'), anchor(e.item.id, 'extra'), ex.lit.has(m));
    let d = '', on = '';
    for (const [a, b, lit] of edges) {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - hr.left, y1 = ra.top + ra.height / 2 - hr.top, x2 = rb.left - hr.left, y2 = rb.top + rb.height / 2 - hr.top;
      const dx = Math.max(12, (x2 - x1) / 2);
      const p = `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      if (lit) on += p; else d += p;
    }
    svgEl.setAttribute('width', String(hr.width));
    svgEl.setAttribute('height', String(hr.height));
    svgEl.innerHTML = `<path class="ln" d="${d}"/><path class="ln on" d="${on}"/>`;
  }

  override render() {
    const r = this.row;
    const m = r ? this.members().find((x) => x.id === this.focusId) ?? r.source : null;
    return html`<div class="ip-scrim" ?hidden=${!this.open} aria-hidden="true"></div>
      <calcite-sheet class="ip-sheet" position="inline-end" display-mode="overlay" label=${t('review.panel.label')} .open=${this.open}
        .beforeClose=${this.beforeClose} @calciteSheetOpen=${this.onOpened} @calciteSheetClose=${this.onClosed}>
        ${r && m && this.open ? html`<calcite-panel heading=${m.title} description=${this.meta(m)} icon="feature-layer" closable
            @calcitePanelClose=${() => { const sh = this.querySelector<HTMLElement & { open: boolean }>('calcite-sheet'); if (sh) sh.open = false; }}>
          <div class="ip">
            <div class="ip-top">
              <span class="ip-chips">${statusChip(m.contentStatus)}</span>
              <calcite-link href=${itemUrl(this.org, m.id)} target="_blank" rel="noopener" icon-end="launch">${t('review.panel.open')}</calcite-link>
            </div>
            <section class="ip-usage" aria-labelledby="ip-u-h">
              <div class="ip-sh"><h3 id="ip-u-h">${t('review.panel.usage')}</h3>
                ${this.canSeeUsage ? this.seg('range', String(this.span), [['365', t('review.panel.range.12')], ['730', t('review.panel.range.24')]], t('review.panel.range'), (v) => { this.span = Number(v) as Span; this.cursor = -1; }) : nothing}</div>
              ${this.usage()}
            </section>
            <section class="ip-conn" aria-labelledby="ip-c-h"><h3 id="ip-c-h">${t('review.panel.connections')}</h3>${guard(
              [r.family, this.data, this.focusId, this.expanded, this.list, this.member, this.depsKnown, this.stopped, this.org, this.relatedTick, getLocale()],
              () => this.connections())}</section>
          </div>
        </calcite-panel>` : nothing}
      </calcite-sheet>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-item-panel': DcItemPanel } }
