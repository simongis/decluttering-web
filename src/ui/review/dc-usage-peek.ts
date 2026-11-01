// DC-147c: the hover card for a row's monthly bars. One shared calcite-popover (manual control, fixed positioning), owned by
// the owner list. Timings from prototypes/usage-peek/README.md: the bars tint at once (CSS); the card opens after 500 ms on
// pointer hover, 300 ms on keyboard focus, at once when another card closed in the last 800 ms; it closes 300 ms after the
// pointer leaves (the pointer may move into it); Escape closes it at once and it won't reopen until the pointer leaves the
// bars. Touch: no card (the tap opens the panel). The card never takes focus: everything in it is in the panel.
import { LitElement, html, svg, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-popover';
import { LocaleController } from '../../i18n/controller';
import { formatNumber, t } from '../../i18n';
import type { RowBars, RowMonth } from '../../domain/usage-bars';
import { HATCH_ID, type DcUsageBars } from './dc-usage-bars';
import { monthName, monthShort, sayMonth } from './usage-words';

export const OPEN_POINTER_MS = 500, OPEN_FOCUS_MS = 300, CLOSE_MS = 300, WARM_MS = 800;
const W = 264, H = 84, SLOT = W / 12, BW = 14;

@customElement('dc-usage-peek')
export class DcUsagePeek extends LitElement {
  private readonly _locale = new LocaleController(this);
  /** The element whose bars buttons get the card (the owner list). */
  @property({ attribute: false }) root: HTMLElement | null = null;
  @state() private ref: HTMLElement | null = null;
  @state() private bars: RowBars | null = null;
  @state() private rowTitle = '';
  @state() private open = false;
  @state() private month = -1;
  private openTimer = 0;
  private closeTimer = 0;
  private lastClose = 0;
  private suppressed: HTMLElement | null = null;
  private inCard = false;
  private bound: HTMLElement | null = null;

  protected override createRenderRoot(): HTMLElement { return this; }

  override connectedCallback(): void { super.connectedCallback(); document.addEventListener('keydown', this.onKey, true); }
  override disconnectedCallback(): void {
    this.unbind();
    document.removeEventListener('keydown', this.onKey, true);
    clearTimeout(this.openTimer); clearTimeout(this.closeTimer);
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    if (this.root === this.bound) return;
    this.unbind();
    const r = this.root;
    if (!r) return;
    r.addEventListener('pointerover', this.onOver);
    r.addEventListener('pointerout', this.onOut);
    r.addEventListener('focusin', this.onFocus);
    r.addEventListener('focusout', this.onBlur);
    r.addEventListener('click', this.onClick, true);
    this.bound = r;
  }

  private unbind(): void {
    const r = this.bound;
    if (!r) return;
    r.removeEventListener('pointerover', this.onOver);
    r.removeEventListener('pointerout', this.onOut);
    r.removeEventListener('focusin', this.onFocus);
    r.removeEventListener('focusout', this.onBlur);
    r.removeEventListener('click', this.onClick, true);
    this.bound = null;
  }

  private btnOf(e: Event): HTMLElement | null {
    const el = (e.target as Element | null)?.closest?.('dc-usage-bars button.ub') as HTMLElement | null;
    return el && !this.contains(el) ? el : null;
  }

  private arm(btn: HTMLElement, delay: number): void {
    clearTimeout(this.closeTimer);
    if (this.suppressed === btn) return;
    if (this.open && this.ref === btn) return;
    clearTimeout(this.openTimer);
    const warm = this.open || Date.now() - this.lastClose < WARM_MS;
    this.openTimer = window.setTimeout(() => this.show(btn), warm ? 0 : delay);
  }

  private show(btn: HTMLElement): void {
    if (!btn.isConnected) return;
    const host = btn.closest('dc-usage-bars') as DcUsageBars | null;
    const row = btn.closest('dc-family-row') as (HTMLElement & { row?: { source: { title: string } } }) | null;
    if (!host?.bars) return;
    this.bars = host.bars;
    this.rowTitle = row?.row?.source.title ?? '';
    this.ref = btn;
    this.month = -1;
    this.open = true;
  }

  /** Close the card now (a click on the bars, Escape, the panel opening). */
  hide(): void {
    clearTimeout(this.openTimer); clearTimeout(this.closeTimer);
    if (!this.open) return;
    this.open = false;
    this.inCard = false;
    this.lastClose = Date.now();
  }

  private disarm(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    if (!this.open) return;
    this.closeTimer = window.setTimeout(() => { if (!this.inCard) this.hide(); }, CLOSE_MS);
  }

  private onOver = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const btn = this.btnOf(e);
    if (btn) this.arm(btn, OPEN_POINTER_MS);
  };

  private onOut = (e: PointerEvent) => {
    const btn = this.btnOf(e);
    if (!btn || btn.contains(e.relatedTarget as Node | null)) return;
    if (this.suppressed === btn) this.suppressed = null;
    this.disarm();
  };

  private onFocus = (e: FocusEvent) => {
    const btn = this.btnOf(e);
    if (btn && btn.matches(':focus-visible')) this.arm(btn, OPEN_FOCUS_MS);
  };

  private onBlur = (e: FocusEvent) => {
    if (this.btnOf(e)) { clearTimeout(this.openTimer); if (this.open && !this.inCard) this.hide(); }
  };

  private onClick = (e: Event) => { if (this.btnOf(e)) { this.hide(); } };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || (!this.open && !this.openTimer)) return;
    if (!this.open) { clearTimeout(this.openTimer); return; }
    this.suppressed = this.ref;
    this.hide();
    e.stopPropagation();
  };

  private details = () => {
    const btn = this.ref;
    this.hide();
    btn?.click();
  };

  private chart(b: RowBars) {
    // Real requests set the scale; sweep touches are a small tick on the line (as in the row), never a bar.
    const max = Math.max(1, ...b.months.filter((m) => !m.notRead).map((m) => m.requests));
    const y = (v: number) => H - (v / max) * (H - 4);
    const bar = (m: RowMonth, k: number) => {
      const x = k * SLOT + (SLOT - BW) / 2;
      if (m.notRead) return svg`<rect x=${x} y="0" width=${BW} height=${H} rx="2" fill="url(#${HATCH_ID})"></rect>`;
      const hr = H - y(m.requests);
      return svg`${hr > 0 ? svg`<rect class="ub-r" x=${x} y=${H - Math.max(1.5, hr)} width=${BW} height=${Math.max(1.5, hr)} rx="1.5"></rect>`
        : m.swept > 0 ? svg`<rect class="ub-s" x=${x} y=${H - 2} width=${BW} height="2"></rect>` : nothing}`;
    };
    return html`<svg class="pk-svg" width=${W} height=${H + 20} viewBox="0 0 ${W} ${H + 20}" aria-hidden="true">
      <line class="pk-base" x1="0" x2=${W} y1=${H + 0.5} y2=${H + 0.5}></line>
      <line class="pk-grid" x1="0" x2=${W} y1="4.5" y2="4.5"></line>
      ${b.months.map((m, k) => svg`${bar(m, k)}<text class="pk-ax" x=${k * SLOT + SLOT / 2} y=${H + 18} text-anchor="middle">${monthShort(m.month).slice(0, 1)}</text>
        <rect class="pk-hit ${k === this.month ? 'on' : ''}" x=${k * SLOT} y="0" width=${SLOT} height=${H + 20} @pointerenter=${() => { this.month = k; }}></rect>`)}
      ${b.lastUseMonth >= 0 ? svg`<path class="ub-last" d="M${b.lastUseMonth * SLOT + SLOT / 2 - 3} ${H + 7}h6l-3 -5z"></path>` : nothing}
    </svg><span class="pk-max">${formatNumber(max)}</span>`;
  }

  override render() {
    const b = this.bars;
    const m = b && this.month >= 0 ? b.months[this.month] : null;
    return html`<calcite-popover class="pk" label=${t('review.bars.cardLine')} placement="bottom-start" overlay-positioning="fixed" trigger-disabled focus-trap-disabled
        .referenceElement=${this.ref} .open=${this.open && !!this.ref} offset-distance="6">
      ${b ? html`<div class="pk-card" @pointerenter=${() => { this.inCard = true; clearTimeout(this.closeTimer); }}
          @pointerleave=${() => { this.inCard = false; this.disarm(); }}>
        <p class="pk-title">${this.rowTitle}</p>
        <div class="pk-chart">${this.chart(b)}</div>
        <p class="pk-read">${m ? html`<b>${monthName(m.month)}</b> ${sayMonth(m, this.month === b.months.length - 1).join(' · ')}` : t('review.bars.cardPoint')}</p>
        <p class="pk-line">${t('review.bars.cardLine')}</p>
        <button type="button" class="linkish pk-more" tabindex="-1" @click=${this.details}>${t('review.bars.hint')}</button>
      </div>` : nothing}
    </calcite-popover>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-usage-peek': DcUsagePeek } }
