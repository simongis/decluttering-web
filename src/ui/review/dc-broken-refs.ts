// DC-035a: "Maps and apps with missing layers (N)", a calm collapsed block under the owner list. Report only: no emails, no
// ticks. Each row is a map or app, its owner, and how many layers it points at that are no longer in the org.
// Props in: refs (already filtered by visibleBrokenRefs), org, owners. Renders nothing for an empty list.
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-block';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import type { BrokenRef, Org, Owner } from '../../domain/types';
import { itemUrl } from '../../domain/format';

@customElement('dc-broken-refs')
export class DcBrokenRefs extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) refs: readonly BrokenRef[] = [];
  @property({ attribute: false }) org!: Pick<Org, 'urlKey' | 'customBaseUrl'>;
  @property({ attribute: false }) owners: readonly Owner[] = [];

  protected override createRenderRoot(): HTMLElement { return this; }

  private name(u: string): string { return this.owners.find((o) => o.username === u)?.fullName || u; }

  private row(b: BrokenRef) {
    const n = b.missing.length;
    return html`<li data-broken=${b.id}>
      <calcite-link href=${itemUrl(this.org, b.id)} target="_blank" rel="noopener" icon-end="launch">${b.title}</calcite-link>
      <span class="br-owner muted small">${this.name(b.owner)}</span>
      <span class="br-what">${n === 1 ? t('review.broken.one') : t('review.broken.many', { count: n })}</span>
    </li>`;
  }

  override render() {
    const refs = this.refs;
    if (!refs.length) return nothing;
    return html`<calcite-block class="broken" data-broken-refs="block" heading=${t('review.broken.heading', { count: refs.length })} collapsible
      description=${t('review.broken.description')}>
      <calcite-icon slot="icon" icon="exclamation-mark-circle" scale="s"></calcite-icon>
      <div class="br-body">
        <p class="br-note muted small">${t('review.broken.note')}</p>
        <ul class="br-list">${refs.map((b) => this.row(b))}</ul>
      </div>
    </calcite-block>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-broken-refs': DcBrokenRefs } }
