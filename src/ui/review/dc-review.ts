import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-block';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import '@esri/calcite-components/dist/components/calcite-notice';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import '../../styles/review.css';
import './dc-filters';
import './dc-owner-list';
import './dc-since-nudges';
import '../scan/dc-dot-map';
import type { DotModel } from '../scan/dots';
import { readChartOpen, readChartView, reviewDots, writeChartOpen, writeChartView, zoneName, type ChartView } from './review-dots';
import type { Data, EvaluateResult, Org, OwnerGroup, Thresholds } from '../../domain/types';
import { PRESETS, PRESET_NAMES, evaluate, matchPreset, sizeChangeImpact, statusToggles, sweepsOf, type PresetName, type SizeImpact } from '../../domain/stale';
import { suggest, type Suggestion } from '../../domain/suggest';
import { sweepNote, sweepSummary } from '../../domain/sweep';
import { fmtInt, formatMB, itemUrl } from '../../domain/format';
import { credit, plural } from '../shared/text';
import type { SortKey } from '../../domain/priority';
import { itemOn, quickWinsOnly, sayRule, saySize, selectionOf, sumSvc } from './helpers';
import { ownerChip, type SinceNudges } from '../../domain/outcomes';
import { noOneToNudge } from '../../domain/solo';

export type ReviewMode = 'admin' | 'admin-cant-send' | 'my-items';
/** `solo` (DC-103): every owner the rule flags is the signed-in admin, so there is no one to nudge and no Emails step. */
export interface SelectionDetail { owners: string[]; items: string[]; services: number; credits: number; solo?: boolean }

const DONE_KEY = 'decluttering:done';
const loadDone = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]') as string[]); } catch { return new Set(); }
};
const saveDone = (s: Set<string>) => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch { /* private mode */ } };

/** DC-090: Review asks one question per card, so its dot map offers How stale only. */
const STALE_ONLY = ['stale'] as const;

const T_KEYS = ['minDaysSinceUse', 'minDaysSinceUpdate', 'maxUsedBy', 'minSizeMB'] as const;
const sameT = (a: Thresholds, b: Thresholds) => T_KEYS.every((k) => (a[k] ?? 0) === (b[k] ?? 0));

/** DC-103: the one line that says why there are no ticks and no Emails step. */
export const SOLO_NOTE = "You're the only owner here, so there's no one to nudge. Here's your own list to tidy, biggest first.";

const appLink = () => location.origin + location.pathname.replace(/[^/]*$/, '');
const adminNote = () => t('review.admin.note', { url: appLink() });

/**
 * The review screen: summary, filters, owner list (or one list in member mode), "No one to nudge".
 * Props in: data, org, mode, canSeeUsage (and thresholds, filterOwner, memberUsername).
 * Events out: `dc-thresholds-change` (Thresholds) and `dc-selection-change` ({ owners, items, services, credits }).
 * Slot `chart`: put a child with slot="chart" (the Sankey) inside; light DOM, so it is moved into the chart card's
 * "By owner" view. The card's default view, "How stale", is the scan's dot map drawn here from the same rule (DC-090).
 * Slot `context`: children with slot="context" (the cache note) are moved into the page head, right of the h1.
 * It also listens for a bubbling `dc-owner-select` from that chart and filters the list to that owner.
 */
@customElement('dc-review')
export class DcReview extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) data!: Data;
  @property({ attribute: false }) org!: Org;
  @property() mode: ReviewMode = 'admin';
  @property({ type: Boolean, attribute: 'can-see-usage' }) canSeeUsage = true;
  @property({ attribute: false }) thresholds: Thresholds = { ...PRESETS.balanced };
  /** False while maps and apps are still being read: used-by is unknown, so that rule is skipped. */
  @property({ type: Boolean }) depsKnown = true;
  /** DC-086: count sweep days and hours like any other use (the org's setting). The note fires `dc-count-sweeps` (boolean). */
  @property({ type: Boolean, attribute: 'count-sweeps' }) countSweeps = false;
  @property() filterOwner: string | null = null;
  /** DC-096: what changed since past nudges (from the nudge log); null: no card. */
  @property({ attribute: false }) since: SinceNudges | null = null;
  /** my-items: score the whole org then show only this username's rows. */
  @property({ attribute: 'member-username' }) memberUsername = '';
  /** DC-103: the signed-in admin's username. When every flagged owner is this person, Review becomes their own to-do list. */
  @property({ attribute: 'admin-username' }) adminUsername = '';

  @state() private items = new Map<string, boolean>();
  @state() private done = loadDone();
  @state() private toast = '';
  @state() private sort: SortKey = 'priority';
  /** DC-103: the solo list ranks by credits until the admin picks a sort. */
  @state() private sortPicked = false;
  @state() private startOnly = false;
  /** DC-090: the chart card's view and whether it is open, remembered per browser. */
  @state() private chartPick: ChartView | null = null;
  private get chartView(): ChartView { return this.chartPick ?? readChartView(this.org?.id); }
  @state() private chartOpen = readChartOpen();
  /** DC-090: below 900 px the rule panel folds to one line (closed until opened). */
  @state() private panelOpen = false;
  private dots: DotModel | null = null;
  /** Suggested starting point for this org (null when the org gives us nothing to go on, or looks tidy). */
  @state() private sug: Suggestion | null = null;
  /** The starting point the admin last picked. Empty until they pick, or Suggested is applied by default. */
  @state() private pick: PresetName | '' = '';
  /** The numbers in force when Custom was clicked: Custom stays shown while they are unchanged. */
  private customAt: Thresholds | null = null;
  private ev: EvaluateResult | null = null;
  private vis: OwnerGroup[] | null = null;

  /** The owners on show: with "Quick wins only" on, just the Quick win rows. The heading, figures, action bar and Emails step all follow this. */
  private visibleOwners(): OwnerGroup[] {
    if (!this.ev) return [];
    if (!this.startOnly) return this.ev.owners;
    return this.vis ??= quickWinsOnly(this.ev.owners);
  }

  protected override createRenderRoot(): HTMLElement { return this; }

  private get member() { return this.mode === 'my-items'; }
  /** The scan was stopped early (DC-053): wording says "not measured" / "not checked" instead of "still ...". */
  @property({ type: Boolean }) stopped = false;
  /** DC-103: no one else to nudge. Live: it follows the rule, so loosening it brings the normal flow back. */
  private get solo(): boolean { return !this.member && !!this.ev && noOneToNudge(this.ev, this.adminUsername); }
  /** The list is drawn as a personal list (Mark as done, no ticks) for a member, and for a solo admin. */
  private get personal(): boolean { return this.member || this.solo; }
  private get selectable() { return this.mode === 'admin' && !this.solo; }
  private get activeSort(): SortKey { return this.solo && !this.sortPicked ? 'credits' : this.sort; }

  override connectedCallback(): void {
    super.connectedCallback();
    // Remember slotted chart children; they are moved into the chart block once it renders.
    this.pending = [...this.querySelectorAll(':scope > [slot="chart"], :scope > [slot="context"]')];
    this.addEventListener('dc-owner-select', this.onOwnerSelect as EventListener);
    this.addEventListener('dc-item-toggle', this.onItem as EventListener);
    this.addEventListener('dc-owner-toggle', this.onOwner as EventListener);
    this.addEventListener('dc-done-toggle', this.onDone as EventListener);
  }
  private pending: Element[] = [];

  private dotsTimer = 0;
  /** The numbers the dot model was made with: the map is drawn with these until the new model is ready, so the two always agree. */
  private dotsT: Thresholds | null = null;
  private stopDots() { clearTimeout(this.dotsTimer); this.dotsTimer = 0; }
  private drawDots() {
    if (this.member || !this.data) return;
    const t = this.effective();
    this.dots = reviewDots(this.data, t, { depsKnown: this.depsKnown, countSweeps: this.countSweeps });
    this.dotsT = t;
  }
  private laterDots() {
    this.stopDots();
    this.dotsTimer = window.setTimeout(() => { this.dotsTimer = 0; this.drawDots(); this.requestUpdate(); }, 0);
  }

  override disconnectedCallback(): void {
    this.stopDots();
    super.disconnectedCallback();
    this.removeEventListener('dc-owner-select', this.onOwnerSelect as EventListener);
    this.removeEventListener('dc-item-toggle', this.onItem as EventListener);
    this.removeEventListener('dc-owner-toggle', this.onOwner as EventListener);
    this.removeEventListener('dc-done-toggle', this.onDone as EventListener);
  }

  private effective(): Thresholds {
    // Without usage access the rules skip usage: 0 turns the last-used rule off.
    return this.canSeeUsage ? this.thresholds : { ...this.thresholds, minDaysSinceUse: 0 };
  }

  private evaluateNow(): EvaluateResult | null {
    if (!this.data) return null;
    const ev = evaluate(this.data, this.effective(), { depsKnown: this.depsKnown, countSweeps: this.countSweeps });
    if (this.member) {
      const mine = ev.owners.filter((o) => o.owner.username === this.memberUsername || !this.memberUsername);
      return { ...ev, owners: this.memberUsername ? mine : ev.owners, unreachable: [] };
    }
    return ev;
  }

  /** Suggested stays selected while its numbers are untouched. */
  private get shown(): PresetName {
    if (this.pick === 'custom' && this.customAt && sameT(this.thresholds, this.customAt)) return 'custom';
    return this.pick === 'suggested' && this.sug && sameT(this.thresholds, this.sug.thresholds) ? 'suggested' : matchPreset(this.thresholds);
  }

  /** Work out the Suggested preset. It is the default when the org gives us one; otherwise Balanced stays. */
  private applySuggestion(): void {
    if (!this.data) return;
    const prev = this.sug;
    const next = suggest(this.data, { depsKnown: this.depsKnown, countSweeps: this.countSweeps });
    this.sug = next;
    const follow = this.pick === 'suggested' && prev && sameT(this.thresholds, prev.thresholds);
    if (next && (this.pick === '' || follow)) {
      this.pick = 'suggested';
      if (!sameT(this.thresholds, next.thresholds)) this.setThresholds({ ...next.thresholds, ...statusToggles(this.thresholds) });
    } else if (!next && this.pick === 'suggested') {
      this.pick = '';
    }
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('data') || changed.has('depsKnown') || changed.has('countSweeps')) this.applySuggestion();
    if (changed.has('data') || changed.has('thresholds') || changed.has('countSweeps') || changed.has('canSeeUsage') || changed.has('mode') || changed.has('memberUsername') || changed.has('depsKnown') || changed.has('adminUsername')) {
      this.ev = this.evaluateNow();
      this.vis = null;
      // DC-090: the dot map follows the same rule as the list (buildDots runs the same allRows and evaluate).
      // DC-100b: after the first, it is drawn in a task of its own, so the list is on screen (and the page answers) before it.
      if (this.member || !this.data) { this.dots = null; this.dotsT = null; this.stopDots(); }
      else if (!this.dots) this.drawDots();
      else this.laterDots();
      if (this.filterOwner && !this.ev?.owners.some((o) => o.owner.username === this.filterOwner)) this.filterOwner = null;
    }
  }

  protected override updated(changed: PropertyValues): void {
    const host = this.querySelector('.chart-slot');
    const ctxHost = this.querySelector('.pagehead-ctx');
    const adopt = [...this.pending, ...this.querySelectorAll(':scope > [slot="chart"], :scope > [slot="context"]')];
    const charts = adopt.filter((n) => n.getAttribute('slot') === 'chart'), ctx = adopt.filter((n) => n.getAttribute('slot') === 'context');
    if (!host) for (const n of charts) (n as HTMLElement).hidden = true; // member mode has no chart
    else for (const n of charts) host.append(n);
    if (ctxHost) for (const n of ctx) ctxHost.append(n);
    this.pending = [...(host ? [] : charts), ...(ctxHost ? [] : ctx)];
    if (changed.has('data') || changed.has('thresholds') || changed.has('countSweeps') || changed.has('canSeeUsage') || changed.has('mode') || changed.has('memberUsername') || changed.has('items') || changed.has('startOnly') || changed.has('adminUsername')) {
      this.dispatchEvent(new CustomEvent<SelectionDetail>('dc-selection-change', {
        detail: { ...(this.ev && this.selectable ? selectionOf(this.visibleOwners(), this.items) : { owners: [], items: [], services: 0, credits: 0 }), solo: this.solo },
        bubbles: true, composed: true,
      }));
    }
  }

  private onOwnerSelect = (e: CustomEvent) => {
    const d = e.detail as unknown;
    const u = typeof d === 'string' ? d : (d as { username?: string; owner?: string } | null)?.username ?? (d as { owner?: string } | null)?.owner ?? null;
    this.filterOwner = u && u !== this.filterOwner ? u : null;
  };
  private onItem = (e: CustomEvent<{ id: string; checked: boolean }>) => {
    this.items = new Map(this.items).set(e.detail.id, e.detail.checked);
  };
  private onOwner = (e: CustomEvent<{ username: string; checked: boolean }>) => {
    const o = this.visibleOwners().find((x) => x.owner.username === e.detail.username);
    if (!o) return;
    const next = new Map(this.items);
    for (const r of o.rows) next.set(r.source.id, e.detail.checked);
    this.items = next;
  };
  private onDone = (e: CustomEvent<{ id: string; checked: boolean }>) => {
    const next = new Set(this.done);
    if (e.detail.checked) next.add(e.detail.id); else next.delete(e.detail.id);
    this.done = next; saveDone(next);
  };
  /** DC-055: what a lower minimum size would add to the list, for the "Include small items?" dialog. */
  private sizeImpact = (toMB: number): SizeImpact => sizeChangeImpact(this.data, this.effective(), toMB, { depsKnown: this.depsKnown, countSweeps: this.countSweeps });

  private setThresholds(t: Thresholds) {
    this.thresholds = t;
    this.dispatchEvent(new CustomEvent('dc-thresholds-change', { detail: t, bubbles: true, composed: true }));
  }

  private sortControl() {
    const opts: [SortKey, string][] = [['priority', t('review.sort.priority')], ['credits', t('review.sort.credits')], ['updated', t('review.sort.updated')], ['views', t('review.sort.views')]];
    return html`<div class="list-tools">
      <calcite-button scale="s" appearance=${this.startOnly ? 'solid' : 'outline'} kind="brand" icon-start="check" aria-pressed=${this.startOnly ? 'true' : 'false'}
        label=${t('review.sort.quickLabel')} title=${t('review.sort.quickTitle')} @click=${() => { this.startOnly = !this.startOnly; }}>${t('review.sort.quickOnly')}</calcite-button>
      <div class="sort-ctl"><span>${t('review.sort.label')}</span>
        <calcite-segmented-control scale="s" label=${t('review.sort.label')} @calciteSegmentedControlChange=${(e: Event) => { this.sort = (e.target as HTMLInputElement).value as SortKey; this.sortPicked = true; }}>
          ${opts.map(([k, label]) => html`<calcite-segmented-control-item value=${k} ?checked=${this.activeSort === k}>${label}</calcite-segmented-control-item>`)}
        </calcite-segmented-control></div>
    </div>`;
  }

  private async copyNote() {
    const text = adminNote();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    this.toast = ok ? t('review.nudge.copied') : t('review.nudge.copyFailed');
  }

  /** DC-096: username to the chip's extra words ("2 of 4 gone"). */
  private notesMemo: { since: SinceNudges | null; out: ReadonlyMap<string, string> } | null = null;
  private nudgeNotes(): ReadonlyMap<string, string> {
    if (this.notesMemo?.since !== this.since) {
      const m = new Map<string, string>();
      for (const o of this.since?.owners ?? []) { const t = ownerChip(o); if (t) m.set(o.owner, t); }
      this.notesMemo = { since: this.since, out: m };
    }
    return this.notesMemo.out;
  }

  private fig(cls: string, icon: string, value: unknown, label: string, of: unknown = nothing) {
    return html`<li class="fig ${cls}"><span class="ic"><calcite-icon preload icon=${icon} scale="s"></calcite-icon></span><b>${value}</b>${of}<small>${label}</small></li>`;
  }

  private figures(owners: OwnerGroup[]) {
    if (this.personal) {
      const rows = owners.flatMap((o) => o.rows).filter((r) => !this.done.has(r.source.id));
      const n = sumSvc(rows);
      const partial = rows.some((r) => !r.sizeKnown);
      return html`${this.fig('f-svc', 'feature-layer', fmtInt(n), t(n === 1 ? 'review.unit.layer' : 'review.unit.layers'))}
        ${this.fig('f-own', 'data', formatMB(rows.reduce((a, r) => a + r.sizeMB, 0)), t(partial ? 'review.fig.storageSoFar' : 'review.fig.storage'))}
        ${this.fig('f-cred', 'credit-card', credit(rows.reduce((a, r) => a + r.credits, 0)), t(partial ? 'review.fig.creditsMonthSoFar' : 'review.fig.creditsMonth'))}`;
    }
    const svc = owners.reduce((n, o) => n + sumSvc(o.rows), 0);
    const credits = owners.reduce((n, o) => n + o.credits, 0);
    const ticked = owners.filter((o) => o.rows.some((r) => itemOn(this.items, o, r))).length;
    return html`${this.fig('f-svc', 'feature-layer', fmtInt(svc), t(svc === 1 ? 'review.unit.service' : 'review.unit.services'))}
      ${this.selectable
        ? this.fig('f-own', 'users', fmtInt(ticked), t(owners.length === 1 ? 'review.unit.owner' : 'review.unit.owners'), html`<span class="of">${t('review.review.of', { count: fmtInt(owners.length) })}</span>`)
        : this.fig('f-own', 'users', fmtInt(owners.length), t(owners.length === 1 ? 'review.unit.ownerReview' : 'review.unit.ownersReview'))}
      ${this.fig('f-cred', 'credit-card', credit(credits), t(owners.some((o) => o.unmeasured) ? 'review.fig.creditsMonthSoFar' : 'review.fig.creditsMonth'))}`;
  }

  /**
   * DC-083: how last used was worked out, when it was not the usual way. A scan saved before DC-083 has no "last viewed"
   * dates; a scan that could not read all of the usage history leaves some layers unknown (they are never picked out).
   */
  private useNote() {
    if (!this.canSeeUsage || !this.data) return nothing;
    const old = this.data.services.length > 0 && this.data.services.every((s) => s.lastViewed === undefined);
    if (old) return this.note('use-note', 'information', t('review.notes.oldScan'), { note: 'requests-only' });
    if (this.data.usageComplete === false) return this.note('use-note', 'information', t('review.notes.partialUsage'), { note: 'usage-partial' });
    return nothing;
  }

  /** DC-086: one calm note when a script or crawler touched many layers at once, with a way to count those days back in. */
  private sweepNote() {
    if (!this.canSeeUsage || !this.data) return nothing;
    const s = sweepSummary(sweepsOf(this.data), Date.parse(this.data.org.scannedAt));
    if (!s) return nothing;
    const n = sweepNote(s, this.countSweeps);
    return html`<li class="use-note sweep-note" data-note="sweeps" data-sweep-dates=${s.dates} data-counting=${String(this.countSweeps)}>
      <calcite-icon icon="information" scale="s" aria-hidden="true"></calcite-icon><span>${n.text}
      <button type="button" class="dc-textlink" data-action="count-sweeps"
        @click=${() => this.dispatchEvent(new CustomEvent<boolean>('dc-count-sweeps', { detail: !this.countSweeps, bubbles: true, composed: true }))}>${n.action}</button></span></li>`;
  }

  /** "Credits so far, still measuring N" (DC-053). Counts the families on show whose storage isn't measured. */
  private sizesNote(owners: OwnerGroup[]) {
    const n = owners.reduce((a, o) => a + o.unmeasured, 0);
    if (!n) return nothing;
    const what = plural(n, 'item', 'items');
    return this.note('sizes-note', this.stopped ? 'information' : 'clock', t(this.stopped ? 'review.notes.storageStopped' : 'review.notes.storageMeasuring', { items: what }), { note: 'sizes', unmeasured: String(n) });
  }

  /** DC-090 (finding 5): a status note is a plain line with an icon inside the summary, under the figures. */
  private note(cls: string, icon: string, text: string, data: { note?: string; unmeasured?: string } = {}) {
    return html`<li class=${cls} data-note=${data.note ?? nothing} data-unmeasured=${data.unmeasured ?? nothing}>
      <calcite-icon icon=${icon} scale="s" aria-hidden="true"></calcite-icon><span>${text}</span></li>`;
  }

  private depsNote() {
    if (this.depsKnown) return nothing;
    return this.note('deps-note', this.stopped ? 'information' : 'clock', this.stopped
      ? t('review.notes.depsStopped') : t('review.notes.depsChecking'));
  }

  /** DC-090 (FB-40): one chart card, How stale (the scan's dot map, default) | By owner (the Sankey). */
  private chartCard(shown: PresetName) {
    const view = this.chartView, m = this.dots;
    const inZone = m?.stats.staleServices ?? 0;
    const setView = (v: ChartView) => { if (v === this.chartView) return; this.chartPick = v; writeChartView(v, this.org?.id); };
    return html`<calcite-block class="chart-block" data-chart-view=${view} collapsible ?expanded=${this.chartOpen}
      heading=${t(view === 'stale' ? 'review.chart.howStale' : 'review.chart.byOwner')}
      description=${view === 'stale'
        ? t('review.chart.staleDescription', { count: inZone })
        : t('review.chart.ownerDescription')}
      @calciteBlockToggle=${(e: Event) => { if (e.target !== e.currentTarget) return; const open = !!(e.target as HTMLElement & { expanded: boolean }).expanded; this.chartOpen = open; writeChartOpen(open); }}>
      <calcite-segmented-control slot="actions-end" scale="s" label=${t('review.chart.label')} data-action="chart-view"
        @calciteSegmentedControlChange=${(e: Event) => { e.stopPropagation(); setView((e.target as HTMLElement & { value: string }).value === 'owner' ? 'owner' : 'stale'); }}>
        <calcite-segmented-control-item value="stale" ?checked=${view === 'stale'}>${t('review.chart.howStale')}</calcite-segmented-control-item>
        <calcite-segmented-control-item value="owner" ?checked=${view === 'owner'}>${t('review.sankey.byOwner')}</calcite-segmented-control-item>
      </calcite-segmented-control>
      <div class="chart-view" data-view="stale" ?hidden=${view !== 'stale'}>
        ${m ? html`<dc-dot-map .model=${m} .org=${this.org} .thresholds=${this.dotsT ?? this.effective()} .lenses=${STALE_ONLY} .zoneLabel=${zoneName(shown)}
          lenses-ready height-scale="0.9" data-stale-services=${inZone}></dc-dot-map>` : nothing}
      </div>
      <div class="chart-view chart-slot" data-view="owner" ?hidden=${view !== 'owner'}></div>
    </calcite-block>`;
  }

  private unreachable(ev: EvaluateResult) {
    const un = ev.unreachable;
    if (!un.length) return nothing;
    const n = un.reduce((a, g) => a + g.rows.length, 0);
    return html`<calcite-block class="unreach" heading=${t('review.unreachable.heading')} collapsible expanded
      description=${t('review.unreachable.description', { owners: plural(un.length, 'owner', 'owners'), items: plural(n, 'item', 'items') })}>
      <calcite-icon slot="icon" icon="user-x" scale="s"></calcite-icon>
      <p class="unreach-note">${t('review.unreachable.disabled')}</p>
      <div class="unreach-list">${un.map((g) => html`<div class="un-owner">
        <div class="un-head"><calcite-icon preload icon="user-x" scale="s"></calcite-icon><strong>${g.owner.fullName}</strong><span class="muted small">${g.owner.username}</span>
          <calcite-chip class="c-inactive" scale="s" appearance="outline-fill" kind="neutral" label=${t('review.unreachable.accountDisabled')}>${t('review.unreachable.accountDisabled')}</calcite-chip></div>
        <ul class="un-items">${g.rows.map((r) => html`<li><calcite-link href=${itemUrl(this.org, r.source)} target="_blank" rel="noopener" icon-end="launch">${r.source.title}</calcite-link><span class="muted small"> ${r.sizeKnown ? `${formatMB(r.sizeMB)} · ≈ ${credit(r.credits)} ${t('review.fig.creditsMonth')}` : saySize(r, this.stopped)}</span></li>`)}</ul>
      </div>`)}</div>
    </calcite-block>`;
  }

  private nudgePanel() {
    return html`<calcite-block class="nudge" heading=${t('review.nudge.heading')} expanded>
      <calcite-icon slot="icon" icon="group" scale="s"></calcite-icon>
      <div class="block-pad">
        <p class="mi-p">${t('review.nudge.body')}</p>
        <calcite-button icon-start="copy" appearance="outline" width="full" @click=${() => this.copyNote()}>${t('review.nudge.copy')}</calcite-button>
        <p class="hint">${t('review.nudge.hint')}</p>
        ${this.toast ? html`<calcite-notice open scale="s" kind="success" icon="check-circle" class="toast"><div slot="message">${this.toast}</div></calcite-notice>` : nothing}
      </div>
    </calcite-block>`;
  }

  private emptyState() {
    return html`<div class="empty"><calcite-icon preload icon="feature-layer" scale="l"></calcite-icon><h2>${t('review.empty.heading')}</h2>
      <p class="lede">${t('review.empty.body')}</p>
      <calcite-button appearance="outline" @click=${() => this.setThresholds({ ...PRESETS.strict })}>${t('review.empty.strict')}</calcite-button></div>`;
  }

  override render() {
    const ev = this.ev;
    if (!ev) return nothing;
    const everyone = ev.owners;
    const owners = this.visibleOwners();
    const member = this.member, personal = this.personal;
    const filtered = !personal && this.filterOwner ? owners.filter((o) => o.owner.username === this.filterOwner) : owners;
    const rowsCount = owners.flatMap((o) => o.rows).length;
    const fo = personal ? undefined : owners.find((o) => o.owner.username === this.filterOwner);
    const heading = personal
      ? (rowsCount ? t('review.review.layersToReview', { count: sumSvc(owners.flatMap((o) => o.rows)) }) : t('review.review.nothing'))
      : (owners.length ? `${plural(filtered.length, 'owner', 'owners')} · ${plural(filtered.reduce((s, o) => s + sumSvc(o.rows), 0), 'service', 'services')}` : t('review.review.nothing'));
    const shown = this.shown;
    const filters = html`<dc-filters .thresholds=${this.thresholds} .canSeeUsage=${this.canSeeUsage} ?member=${member}
      .suggestion=${this.sug} .selected=${shown} .sizeImpact=${this.sizeImpact}
      @dc-preset-pick=${(e: CustomEvent<{ preset: PresetName }>) => { e.stopPropagation(); this.pick = e.detail.preset; this.customAt = e.detail.preset === 'custom' ? { ...this.thresholds } : null; }}
      @dc-thresholds-change=${(e: CustomEvent<Thresholds>) => { e.stopPropagation(); this.setThresholds(e.detail); }}></dc-filters>`;
    const list = !everyone.length ? this.emptyState() : html`<dc-owner-list .owners=${owners} .org=${this.org} .thresholds=${this.thresholds}
      .items=${this.items} .done=${this.done} .filterOwner=${this.filterOwner} .sort=${this.activeSort} ?selectable=${this.selectable} ?member=${personal}
      .canSeeUsage=${this.canSeeUsage} .depsKnown=${this.depsKnown} .stopped=${this.stopped} .nudgeNotes=${this.nudgeNotes()}></dc-owner-list>`;
    const startNone = this.startOnly && !owners.length && everyone.length > 0;

    const notes = [this.depsNote(), this.sizesNote(owners), this.useNote(), this.sweepNote()].filter((n) => n !== nothing);

    return html`<div class="dc-review-grid ${member ? 'mi-grid' : ''} ${this.solo ? 'solo-grid' : ''}" data-panel-open=${String(this.panelOpen)}>
      <header class="pagehead"><h1>${t(member ? 'review.headline.member' : 'review.headline.review')}</h1><div class="pagehead-ctx"></div></header>
      <aside class="dc-review-side" aria-label=${t('review.aria.staleRules')}>
        <button type="button" class="panel-fold" aria-expanded=${String(this.panelOpen)} @click=${() => { this.panelOpen = !this.panelOpen; }}>
          <calcite-icon icon="sliders-horizontal" scale="s" aria-hidden="true"></calcite-icon>
          <span class="pf-text"><b>${t('review.whatStale')}</b> · ${PRESET_NAMES[shown]}</span>
          <span class="pf-act">${t(this.panelOpen ? 'review.action.close' : 'review.action.change')}</span>
        </button>
        ${filters}
      </aside>
      <div class="dc-review-main">
        ${!member && this.since ? html`<dc-since-nudges .since=${this.since} .org=${this.org} .owners=${this.data.owners}></dc-since-nudges>` : nothing}
        <section class="summary" aria-labelledby="summary-h">
          <div class="sum-top">
            <h2 id="summary-h">${t(personal ? 'review.summary.readyLook' : 'review.summary.readyReview')} <span class="ctx">· ${PRESET_NAMES[shown]}</span></h2>
            <ul class="chips" aria-label=${t('review.summary.found')}>${this.figures(owners)}</ul>
          </div>
          ${notes.length ? html`<div role="status" aria-label=${t('review.summary.numbers')}><ul class="notes">${notes}</ul></div>` : nothing}
        </section>
        ${this.mode === 'admin-cant-send' ? html`<calcite-notice open icon="information" kind="brand"><div slot="message">${t('review.cantSend')}</div></calcite-notice>` : nothing}
        ${this.solo ? html`<calcite-notice open icon="information" kind="brand" data-note="solo"><div slot="message">${t('review.solo.note')}</div></calcite-notice>` : nothing}
        ${member ? nothing : this.chartCard(shown)}
        <div class="list-head"><h2>${heading}</h2>
          ${fo ? html`<calcite-chip closable scale="m" appearance="outline-fill" kind="brand" @calciteChipClose=${() => { this.filterOwner = null; }}>${t('review.label.owner', { name: fo.owner.fullName })}</calcite-chip>` : nothing}</div>
        ${everyone.length ? this.sortControl() : nothing}
        ${startNone ? html`<p class="lede">${t('review.sort.noneQuick')}</p>` : nothing}
        ${list}
        ${member ? nothing : this.unreachable(ev)}
      </div>
      ${member ? html`<aside class="mi-side" aria-label=${t('review.nudge.shareAria')}>${this.nudgePanel()}</aside>` : nothing}
    </div>`;
  }

  /** Words for the current rule, for the host's own use (for example a screen-reader summary). */
  get ruleText(): string { return sayRule(this.thresholds, this.canSeeUsage, this.member); }
}
declare global { interface HTMLElementTagNameMap { 'dc-review': DcReview } }
