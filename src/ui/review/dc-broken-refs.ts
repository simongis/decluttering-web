// DC-035a, DC-137: "Maps and apps with missing layers (N)", a calm collapsed block under the owner list. Report only: no
// emails, no ticks. A short note, then a table: map or app (with its ArcGIS item-type icon), owner, how many layers it
// points at that are no longer in the org, last modified, and Esri's content status as ArcGIS Online's chips (that column only
// when one is deprecated or authoritative). Sorted by missing layers, most first;
// every column header sorts. Props in: refs (already filtered by visibleBrokenRefs), org, owners. Renders nothing when empty.
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { formatDate, formatNumber, t, type MessageKey } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-block';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import type { BrokenRef, Org, Owner } from '../../domain/types';
import { itemUrl } from '../../domain/format';
import { ownerNamer, sortBrokenRefs, type BrokenSortKey, type SortDir } from '../../domain/broken-refs';
import { itemTypeIcon, statusChip, statusOf } from './item-chips';

const COLUMNS: { key: BrokenSortKey; label: MessageKey; first: SortDir; num?: boolean }[] = [
  { key: 'title', label: 'review.broken.col.item', first: 'asc' },
  { key: 'owner', label: 'review.broken.col.owner', first: 'asc' },
  { key: 'missing', label: 'review.broken.col.missing', first: 'desc', num: true },
  { key: 'modified', label: 'review.broken.col.modified', first: 'desc' },
  { key: 'deprecated', label: 'review.broken.col.status', first: 'desc' },
];

@customElement('dc-broken-refs')
export class DcBrokenRefs extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) refs: readonly BrokenRef[] = [];
  @property({ attribute: false }) org!: Pick<Org, 'urlKey' | 'customBaseUrl'>;
  @property({ attribute: false }) owners: readonly Owner[] = [];
  @state() private sortKey: BrokenSortKey = 'missing';
  @state() private sortDir: SortDir = 'desc';

  protected override createRenderRoot(): HTMLElement { return this; }

  /** One username -> name map per owner list (thousands of owners in a big org), not a find per sort comparison. */
  private get name(): (u: string) => string { return ownerNamer(this.owners); }

  private sortBy(key: BrokenSortKey, first: SortDir): void {
    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else { this.sortKey = key; this.sortDir = first; }
  }

  private head(c: (typeof COLUMNS)[number]) {
    const active = this.sortKey === c.key;
    const label = t(c.label);
    return html`<th scope="col" class=${c.num ? 'num' : ''} aria-sort=${active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" data-sort=${c.key} title=${t('review.broken.sortBy', { column: label })} @click=${() => this.sortBy(c.key, c.first)}>
        <span>${label}</span>${active ? html`<calcite-icon icon=${this.sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} scale="s"></calcite-icon>` : nothing}
      </button>
    </th>`;
  }

  private row(b: BrokenRef, withStatus: boolean) {
    return html`<tr data-broken=${b.id}>
      <td class="br-item"><span>
        <calcite-icon icon=${itemTypeIcon(b.type)} scale="s" text-label=${b.type} title=${b.type}></calcite-icon>
        <calcite-link href=${itemUrl(this.org, b.id)} target="_blank" rel="noopener">${b.title}</calcite-link>
      </span></td>
      <td class="br-owner">${this.name(b.owner)}</td>
      <td class="num" data-missing>${formatNumber(b.missing.length)}</td>
      <td class="br-date">${b.modified ? formatDate(new Date(b.modified)) : html`<span class="muted">—</span>`}</td>
      ${withStatus ? html`<td class="br-status">${statusChip(b.contentStatus)}</td>` : nothing}
    </tr>`;
  }

  override render() {
    const refs = this.refs;
    if (!refs.length) return nothing;
    const sorted = sortBrokenRefs(refs, this.sortKey, this.sortDir, this.name);
    const heading = t('review.broken.heading', { count: refs.length });
    // The Status column only when something in the list has a status worth showing (deprecated or authoritative).
    const withStatus = refs.some((b) => statusOf(b.contentStatus) !== null);
    const columns = withStatus ? COLUMNS : COLUMNS.filter((c) => c.key !== 'deprecated');
    return html`<calcite-block class="broken" data-broken-refs="block" heading=${heading} collapsible>
      <calcite-icon slot="icon" icon="exclamation-mark-circle" scale="s"></calcite-icon>
      <div class="br-body">
        <p class="br-note muted small">${t('review.broken.note')}</p>
        <div class="br-scroll">
          <table class="br-table">
            <caption class="br-caption">${heading}</caption>
            <thead><tr>${columns.map((c) => this.head(c))}</tr></thead>
            <tbody>${sorted.map((b) => this.row(b, withStatus))}</tbody>
          </table>
        </div>
      </div>
    </calcite-block>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-broken-refs': DcBrokenRefs } }
