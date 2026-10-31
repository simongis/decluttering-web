import { LitElement, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-list';
import '@esri/calcite-components/dist/components/calcite-list-item';
import '@esri/calcite-components/dist/components/calcite-checkbox';
import '@esri/calcite-components/dist/components/calcite-label';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-link';
import '@esri/calcite-components/dist/components/calcite-tooltip';
import './dc-sparkline';
import type { Org, Row, Service } from '../../domain/types';
import { itemUrl } from '../../domain/format';
import { sayCredits, saySize } from './helpers';
import { credit } from '../shared/text';
import { PRIORITY_DOTS, PRIORITY_LABELS } from '../../domain/priority';

/** Everything a row draws from its Row, as one string: a new Row object with the same sign draws the same (DC-100). */
const signOf = (r: Row): string =>
  [r.source.id, r.source.title, r.tidy ?? '', r.usedBy, r.sizeKnown, r.sizeMB, r.attachmentMB, r.credits, r.priority, r.priorityReason, r.weekly?.join(','), r.views.map((v) => `${v.id}\u0001${v.title}`).join('\u0002')].join('\u0000');

/**
 * One source layer plus its hosted views (a "family"). Renders a single-item list so Calcite's list-item stays a
 * direct child of its list. Fires bubbling `dc-item-toggle` and `dc-done-toggle` ({ id, checked }).
 */
@customElement('dc-family-row')
export class DcFamilyRow extends LitElement {
  @property({ attribute: false }) row!: Row;
  @property({ attribute: false }) org!: Pick<Org, 'urlKey'>;
  /** The "why" line, already worded for the viewer (see sayWhy). */
  @property() why = '';
  /** Ticked for the digest. */
  @property({ type: Boolean }) on = false;
  /** Show the digest tick (admin mode only). */
  @property({ type: Boolean }) selectable = false;
  /** Member mode: shows "Mark as done" instead of a tick. */
  @property({ type: Boolean }) member = false;
  @property({ type: Boolean }) done = false;
  /** False while maps and apps are still being read: no used-by count, no "Tidy with care". */
  @property({ type: Boolean }) depsKnown = true;
  @property({ type: Boolean, attribute: 'show-usage' }) showUsage = true;
  /** The scan was stopped early: an unmeasured size says "not measured" rather than "not measured yet". */
  @property({ type: Boolean }) stopped = false;

  protected override createRenderRoot(): HTMLElement { return this; }

  private sign = '';
  /** While maps and apps stream in, every Row is a new object; a row whose words and numbers did not change is left alone. */
  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    return !(changed.size === 1 && changed.has('row') && !!this.row && this.sign !== '' && signOf(this.row) === this.sign);
  }

  private link(s: Service) {
    return html`<calcite-link href=${itemUrl(this.org, s)} target="_blank" rel="noopener" icon-end="launch" label="Open ${s.title} in ArcGIS Online">${s.title}</calcite-link>`;
  }

  private emit(name: string, id: string, checked: boolean) {
    this.dispatchEvent(new CustomEvent(name, { detail: { id, checked }, bubbles: true, composed: true }));
  }

  /** Three dots plus the label; the reason line is a tooltip (and read out by screen readers). */
  private cue(r: Row) {
    const id = `prio-${r.source.id}`;
    const n = PRIORITY_DOTS[r.priority];
    return html`<span class="prio ${r.priority}" id=${id} tabindex="0" aria-label="${PRIORITY_LABELS[r.priority]}. ${r.priorityReason}">
      <span class="dots" aria-hidden="true">${[1, 2, 3].map((i) => html`<i class=${i <= n ? 'on' : ''}></i>`)}</span>${PRIORITY_LABELS[r.priority]}</span>
      <calcite-tooltip reference-element=${id} placement="top" close-on-click>${r.priorityReason}</calcite-tooltip>`;
  }

  override render() {
    const r = this.row;
    if (!r) return nothing;
    this.sign = signOf(r);
    const s = r.source;
    const cls = [!this.member && this.selectable && !this.on ? 'off' : '', this.member && this.done ? 'done' : ''].filter(Boolean).join(' ');
    return html`<calcite-list label=${s.title} interaction-mode="static">
      <calcite-list-item value=${s.id} data-id=${s.id} ?expanded=${r.views.length > 0} class=${cls}>
        <span slot="content-start" class="lead">
          ${this.selectable && !this.member
            ? html`<calcite-checkbox label="Include ${s.title} in the digest" .checked=${this.on}
                @calciteCheckboxChange=${(e: Event) => this.emit('dc-item-toggle', s.id, (e.target as HTMLInputElement).checked)}></calcite-checkbox>` : nothing}
          <calcite-icon preload class="svc" icon="feature-layer" scale="s"></calcite-icon>
        </span>
        <div slot="content" class="row-main">
        <div class="row-title">
          ${this.link(s)}
          <span class="why">${this.why}</span>
          ${r.tidy ? html`<span class="tidy"><calcite-icon preload icon="lightbulb" scale="s"></calcite-icon>${r.tidy}</span>` : nothing}
          ${this.member ? html`<calcite-label layout="inline" class="mi-done"><calcite-checkbox .checked=${this.done}
              @calciteCheckboxChange=${(e: Event) => this.emit('dc-done-toggle', s.id, (e.target as HTMLInputElement).checked)}></calcite-checkbox>Mark as done</calcite-label>` : nothing}
        </div>
        <div class="row-end">
          ${this.showUsage ? html`<dc-sparkline .weekly=${r.weekly}></dc-sparkline>` : nothing}
          ${this.depsKnown && r.usedBy > 0 ? html`<calcite-chip class="c-risk" scale="s" appearance="solid" kind="neutral" icon="link" label="Tidy with care">Tidy with care</calcite-chip>` : nothing}
          <calcite-chip class="c-plain" scale="s" appearance="outline-fill" kind="neutral" data-size=${r.sizeKnown ? 'known' : 'unknown'} label=${saySize(r, this.stopped)}>${saySize(r, this.stopped)}</calcite-chip>
          ${r.sizeKnown ? html`<calcite-chip class="c-reclaim" scale="s" appearance="outline-fill" kind="neutral" label=${sayCredits(r)} title=${sayCredits(r)}><i class="sw reclaim"></i>≈ ${credit(r.credits)} credits a month</calcite-chip>` : nothing}
          ${this.cue(r)}
        </div>
        </div>
        ${r.views.map((v) => html`<calcite-list-item value=${v.id}>
          <calcite-icon preload slot="content-start" class="svc" icon="feature-layer" scale="s"></calcite-icon>
          <div slot="content" class="row-title">${this.link(v)}<span class="share">Shares storage with its source</span></div>
        </calcite-list-item>`)}
      </calcite-list-item>
    </calcite-list>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-family-row': DcFamilyRow } }
