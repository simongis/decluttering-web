import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { getLocale, t, tn } from '../../i18n';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';
import '@esri/calcite-components/dist/components/calcite-avatar';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-checkbox';
import '@esri/calcite-components/dist/components/calcite-label';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-icon';
import './dc-family-row';
import type { Org, OwnerGroup, Row, Thresholds } from '../../domain/types';
import { COOLDOWN_DAYS } from '../../domain/cooldown';
import { sortRows, type SortKey } from '../../domain/priority';
import { agoText, credit, firstName, plural, roleLabel } from '../shared/text';
import { includedRows, itemOn, sayWhy, sumSvc } from './helpers';
import { loadSession } from '../../auth/session';
import { OwnerThumbs, ownerContentUrl } from './owner-thumbs';

const ROWS_COLLAPSED = 4;
/** DC-100: the first cards are drawn at once; the rest follow a few at a time, so a big org's page never freezes while it builds. */
const FIRST_CARDS = 8, MORE_CARDS = 6;
const sixMonths = Math.round(COOLDOWN_DAYS / 30.4);

/**
 * The owner cards (admin) or the single list (`member`). Tick state lives in the parent (`items`).
 * Fires bubbling `dc-owner-toggle` ({ username, checked }); row events come from dc-family-row.
 */
@customElement('dc-owner-list')
export class DcOwnerList extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) owners: OwnerGroup[] = [];
  @property({ attribute: false }) org!: Pick<Org, 'urlKey'> & { customBaseUrl?: string };
  @property({ attribute: false }) thresholds!: Thresholds;
  @property({ attribute: false }) items: ReadonlyMap<string, boolean> = new Map();
  @property({ attribute: false }) done: ReadonlySet<string> = new Set();
  @property() filterOwner: string | null = null;
  @property({ type: Boolean }) selectable = true;
  @property({ type: Boolean }) member = false;
  @property({ type: Boolean }) depsKnown = true;
  @property() sort: SortKey = 'priority';
  @property({ type: Boolean, attribute: 'can-see-usage' }) canSeeUsage = true;
  /** The scan was stopped early (wording only: "not measured", "not checked"). */
  @property({ type: Boolean }) stopped = false;
  /** DC-096: username to extra words for the "Nudged" chip, e.g. "2 of 4 gone". */
  @property({ attribute: false }) nudgeNotes: ReadonlyMap<string, string> = new Map();
  @state() private expanded = new Set<string>();
  /** How many owner cards are in the page now. It grows a chunk at a time, while the end of the list is near the screen (DC-100b), until every owner is there. */
  @state() private limit = FIRST_CARDS;
  private raf = 0;
  private io: IntersectionObserver | null = null;
  private end: Element | null = null;
  /** DC-115: owners' profile pictures, loaded for the cards that come into view. Off in the demo and the simulator. */
  private thumbs: OwnerThumbs | null = null;
  private picIo: IntersectionObserver | null = null;
  private seen = new WeakSet<Element>();

  override disconnectedCallback(): void {
    this.picIo?.disconnect(); this.picIo = null; this.seen = new WeakSet();
    this.thumbs?.dispose(); this.thumbs = null;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.io?.disconnect(); this.io = null; this.end = null;
    super.disconnectedCallback();
  }

  /** DC-115: ask for the picture of each owner card that scrolls near the screen (4 at a time, once each). */
  private watchPictures(): void {
    if (this.member || typeof IntersectionObserver === 'undefined' || !this.isConnected) return;
    const hash = window.location.hash;
    if (/^#\/(demo|simulate)/.test(hash)) return;
    this.thumbs ??= new OwnerThumbs({ getManager: () => loadSession(), onChange: () => this.requestUpdate() });
    this.picIo ??= new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        this.picIo?.unobserve(e.target);
        const u = (e.target as HTMLElement).dataset.card ?? '';
        this.thumbs?.request(u, this.owners.find((o) => o.owner.username === u)?.owner.thumbnail);
      }
    }, { rootMargin: '200px 0px' });
    for (const el of this.querySelectorAll('[data-card]')) {
      if (this.seen.has(el)) continue;
      this.seen.add(el); this.picIo.observe(el);
    }
  }

  protected override updated(): void {
    this.watchPictures();
    const total = this.filterOwner ? 1 : this.owners.length;
    if (this.member || this.limit >= total) { this.io?.disconnect(); this.io = null; this.end = null; return; }
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (an old test environment): grow a chunk a frame, as DC-100 did.
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.limit += MORE_CARDS; });
      return;
    }
    // DC-100b: at 7,000 layers there are hundreds of owner cards, and drawing them all made every refresh and every rule change
    // a multi-second job. Cards are added as the end of the list comes within about two screens, so what is on show is the same.
    const end = this.querySelector('.owner-end');
    if (!end) return;
    this.io ??= new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) this.limit += MORE_CARDS; }, { rootMargin: '1800px 0px' });
    if (end === this.end) this.io.unobserve(end); // observing again asks for a fresh reading, which adds more cards while the end is still near
    this.end = end;
    this.io.observe(end);
  }

  protected override createRenderRoot(): HTMLElement { return this; }

  private why(r: Row): string { return sayWhy(r, this.canSeeUsage, this.depsKnown, this.stopped); }

  private view(rows: Row[]): Row[] {
    return sortRows(rows, this.sort);
  }

  private toggleMore(u: string) {
    const next = new Set(this.expanded);
    if (!next.delete(u)) next.add(u);
    this.expanded = next;
  }

  private row(r: Row, on: boolean) {
    return html`<dc-family-row .row=${r} .org=${this.org} .why=${this.why(r)} .on=${on} ?selectable=${this.selectable}
      ?member=${this.member} .done=${this.done.has(r.source.id)} .showUsage=${this.canSeeUsage} .depsKnown=${this.depsKnown} .stopped=${this.stopped}></dc-family-row>`;
  }

  /**
   * DC-100b: while maps and apps stream in, most owners' groups come back unchanged (same object); their card is left alone.
   * Everything a card draws is in the list, so a change to any of it draws every card again.
   */
  private cardOf(o: OwnerGroup) {
    return guard([o, this.expanded.has(o.owner.username), this.items, this.done, this.sort, this.selectable, this.member, this.canSeeUsage,
      this.depsKnown, this.stopped, this.org, this.nudgeNotes.get(o.owner.username), this.thumbs?.get(o.owner.username), getLocale()], () => this.card(o));
  }

  private card(o: OwnerGroup) {
    const ow = o.owner, u = ow.username, first = firstName(ow.fullName);
    const open = this.expanded.has(u);
    const all = this.view(o.rows);
    const rows = open ? all : all.slice(0, ROWS_COLLAPSED);
    const on = includedRows(this.items, o).length;
    const thumb = this.thumbs?.get(u);
    const href = ownerContentUrl(this.org, u);
    const avatar = html`<calcite-avatar scale="l" full-name=${ow.fullName} username=${u} thumbnail=${thumb ?? nothing}></calcite-avatar>`;
    return html`<section class="owner ${on === 0 && this.selectable ? 'none' : ''}" aria-label=${ow.fullName} data-card=${u}>
      <div class="owner-top">
        ${href ? html`<a class="owner-pic" href=${href} target="_blank" rel="noopener noreferrer" data-owner-link=${u}
          aria-label=${t('review.owner.openContent', { name: first })}>${avatar}
          <span class="pic-badge" aria-hidden="true"><calcite-icon icon="launch" scale="s"></calcite-icon></span>
          <span class="pic-tip" aria-hidden="true">${t('review.owner.openContentTip', { name: first })}</span></a>` : avatar}
        <div class="owner-id"><strong>${ow.fullName}</strong><span>${roleLabel(ow.role)}</span></div>
        <div class="owner-chips">
          <calcite-chip scale="s" class="c-plain" appearance="outline-fill" kind="neutral" label=${plural(sumSvc(o.rows), 'service', 'services')}>${plural(sumSvc(o.rows), 'service', 'services')}</calcite-chip>
          <calcite-chip scale="s" class="c-reclaim" appearance="outline-fill" kind="neutral" label=${t(o.unmeasured ? 'review.owner.creditsLabelSoFar' : 'review.owner.creditsLabel', { credits: credit(o.credits) })}><i class="sw reclaim"></i>≈ ${credit(o.credits)} ${t(o.unmeasured ? 'review.fig.creditsMonthSoFar' : 'review.fig.creditsMonth')}</calcite-chip>
        </div>
      </div>
      ${o.startCount > 0 ? html`<div class="owner-flags"><span class="owner-start">${tn('review.owner.quickWin', o.startCount, { count: o.startCount })}</span></div>` : nothing}
      ${o.nudgedRecently ? html`<div class="owner-flags"><calcite-chip class="c-nudged" scale="s" icon="clock" appearance="solid" kind="neutral" label=${t('review.owner.nudged', { ago: agoText(o.nudgedDaysAgo) })}${this.nudgeNotes.has(u) ? ` · ${this.nudgeNotes.get(u)}` : ''}>${t('review.owner.nudged', { ago: agoText(o.nudgedDaysAgo) })}${this.nudgeNotes.has(u) ? ` · ${this.nudgeNotes.get(u)}` : ''}</calcite-chip></div>` : nothing}
      <div>${repeat(rows, (r) => r.source.id, (r) => this.row(r, itemOn(this.items, o, r)))}</div>
      ${all.length > ROWS_COLLAPSED ? html`<div class="more-wrap"><calcite-button appearance="transparent" kind="neutral" scale="s" icon-end=${open ? 'chevron-up' : 'chevron-down'}
        @click=${() => this.toggleMore(u)}>${open ? t('review.owner.showFewer') : t('review.owner.showMore', { count: all.length - ROWS_COLLAPSED })}</calcite-button></div>` : nothing}
      ${this.selectable ? html`<div class="owner-foot">
        <calcite-label layout="inline"><calcite-checkbox .checked=${on === o.rows.length} .indeterminate=${on > 0 && on < o.rows.length}
          label=${t('review.owner.includeDigest', { name: first })}
          @calciteCheckboxChange=${(e: Event) => this.dispatchEvent(new CustomEvent('dc-owner-toggle', { detail: { username: u, checked: (e.target as HTMLInputElement).checked }, bubbles: true, composed: true }))}></calcite-checkbox>${t('review.owner.includeDigest', { name: first })}${on === o.rows.length ? nothing : html`<span class="count"> (${t('review.owner.itemCount', { included: on, total: o.rows.length })})</span>`}</calcite-label>
        ${o.nudgedRecently ? html`<p class="why-tick">${t('review.owner.leftUnticked', { name: first, months: sixMonths })}</p>` : nothing}
      </div>` : nothing}
    </section>`;
  }

  private memberList() {
    const rows = this.view(this.owners.flatMap((o) => o.rows));
    const doneCount = rows.filter((r) => this.done.has(r.source.id)).length;
    return html`<section class="owner" aria-label=${t('review.owner.memberLabel')}>
      <div>${repeat(rows, (r) => r.source.id, (r) => this.row(r, false))}</div>
      <div class="owner-foot"><span class="mi-count">${doneCount === 0
        ? t('review.owner.memberIntro')
        : tn('review.owner.done', doneCount, { count: doneCount })}</span></div>
    </section>`;
  }

  override render() {
    if (this.member) return this.memberList();
    const shown = this.filterOwner ? this.owners.filter((o) => o.owner.username === this.filterOwner) : this.owners;
    return html`<div class="owner-list">${repeat(shown.slice(0, this.limit), (o) => o.owner.username, (o) => this.cardOf(o))}</div>
      ${shown.length > this.limit ? html`<div class="owner-end" aria-hidden="true" style="height:1px"></div>` : nothing}`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-owner-list': DcOwnerList } }
