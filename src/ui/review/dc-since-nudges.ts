// DC-096: "Since your nudges", the calm card above the review summary. It says what changed for the items in past
// digests (no longer in the org, handed over, updated, used again, no change yet) and about how many credits a month
// that is. Correlation only: it never says a change happened because of a nudge. Props in: since, org, owners.
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-block';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import type { Org, Owner } from '../../domain/types';
import { fmtDate, itemUrl } from '../../domain/format';
import { goneWords, OUTCOME_LABEL, outcomeParts, sinceLine, type ItemOutcome, type OwnerOutcome, type SinceNudges } from '../../domain/outcomes';

const ICON: Record<ItemOutcome['outcome'], string> = {
  gone: 'check-circle', handedOver: 'user', updated: 'pencil', used: 'clock', noChange: 'circle', notChecked: 'question',
};

@customElement('dc-since-nudges')
export class DcSinceNudges extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) since: SinceNudges | null = null;
  @property({ attribute: false }) org!: Pick<Org, 'urlKey'>;
  @property({ attribute: false }) owners: readonly Owner[] = [];

  protected override createRenderRoot(): HTMLElement { return this; }

  private name(u: string): string { return this.owners.find((o) => o.username === u)?.fullName || u; }

  private item(x: ItemOutcome) {
    const s = x.service;
    const what = s
      ? html`<calcite-link href=${itemUrl(this.org, s)} target="_blank" rel="noopener" icon-end="launch">${s.title}</calcite-link>`
      : html`<span class="sn-gone-id" title=${x.id}>${t('review.since.gone')}<span class="dc-sr"> ${t('review.since.layerId', { id: x.id })}</span></span>`;
    const label = x.outcome === 'handedOver' && s ? t('review.since.handedTo', { name: this.name(s.owner) }) : OUTCOME_LABEL[x.outcome];
    return html`<li data-outcome=${x.outcome}>
      <calcite-icon icon=${ICON[x.outcome]} scale="s" aria-hidden="true"></calcite-icon>${what}<span class="sn-out">${label}</span>
      ${x.outcome === 'used' ? html`<span class="sn-tip">${t('review.since.usedTip')}</span>` : nothing}</li>`;
  }

  private owner(o: OwnerOutcome) {
    const parts = [goneWords(o.counts, o.credits, false), ...outcomeParts(o.counts)].filter((p): p is string => !!p);
    // Gone first, then the rest in outcome order.
    const order = ['gone', 'handedOver', 'updated', 'used', 'noChange', 'notChecked'];
    const items = [...o.items].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome));
    return html`<div class="sn-owner" data-owner=${o.owner}>
      <div class="sn-head"><strong>${this.name(o.owner)}</strong><span class="muted small">${t('review.since.ownerLine', { date: fmtDate(o.sentAt), parts: parts.join(' · ') })}</span></div>
      <ul class="sn-items">${items.map((x) => this.item(x))}</ul>
    </div>`;
  }

  override render() {
    const s = this.since;
    if (!s) return nothing;
    return html`<calcite-block class="since" data-since="card" heading=${t('review.since.heading')} collapsible description=${sinceLine(s)}>
      <calcite-icon slot="icon" icon="envelope" scale="s"></calcite-icon>
      <div class="sn-body">
        <p class="sn-note muted small">${t('review.since.note')}</p>
        ${s.owners.map((o) => this.owner(o))}
      </div>
    </calcite-block>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-since-nudges': DcSinceNudges } }
