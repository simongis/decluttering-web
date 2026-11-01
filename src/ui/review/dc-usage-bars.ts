import { LitElement, html, svg, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import { ROW_MONTHS, barHeight, type RowBars } from '../../domain/usage-bars';
import { sayRowCaption, sayRowHeadline } from './usage-words';

/** The row's bars: 12 slots of BAR_SLOT px, bars BAR_W wide and up to BAR_H tall, with headroom for the cap mark. */
export const BAR_W = 8, BAR_SLOT = 11, BAR_H = 22;
const TOP = 3, BASE = TOP + BAR_H, MARK = 6;
/** A month with only sweep touches: a 2 px tick on the line, never a bar. */
const SWEEP_TICK = 2;
export const BARS_WIDTH = ROW_MONTHS * BAR_SLOT - (BAR_SLOT - BAR_W);
export const BARS_HEIGHT = BASE + 1 + MARK;
/** The id of the hatch pattern the owner list draws once (not read). */
export const HATCH_ID = 'dc-ub-hatch';

export interface BarsGeometry {
  /** Real use, sweep-only ticks (light, on the line), cap marks, not-read slots, the last-used marker. One path each. */
  real: string; sweep: string; cap: string; notRead: string; last: string;
}

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${+y.toFixed(2)}h${w}v${+h.toFixed(2)}h${-w}z`;

/** The row's bar paths on the shared scale `top` (see barHeight). Pure: used by the row and its tests. */
export function barsGeometry(b: RowBars, top: number): BarsGeometry {
  const g: BarsGeometry = { real: '', sweep: '', cap: '', notRead: '', last: '' };
  b.months.forEach((m, k) => {
    const x = k * BAR_SLOT;
    if (m.notRead) { g.notRead += rect(x, TOP, BAR_W, BAR_H); return; }
    // Bars are real use only. A month with only sweep touches gets a fixed small tick on the line: never a bar, whatever
    // the count, so a layer only a crawler touched looks flat.
    const { h, capped } = barHeight(m.requests, top, BAR_H);
    if (h > 0) g.real += rect(x, BASE - h, BAR_W, h);
    else if (m.swept > 0) g.sweep += rect(x, BASE - SWEEP_TICK, BAR_W, SWEEP_TICK);
    if (capped) g.cap += rect(x - 1, TOP - 3, BAR_W + 2, 1.5);
  });
  if (b.lastUseMonth >= 0) {
    const cx = b.lastUseMonth * BAR_SLOT + BAR_W / 2;
    g.last = `M${cx - 3} ${BASE + 1 + MARK}h6l-3 -5z`;
  }
  return g;
}

/**
 * DC-147c: the Review row's usage, 12 monthly bars on the list's shared, compressed scale with a caption in days. The whole
 * thing is a button (its name is the panel's headline sentence) that opens the item panel; the owner list gives it the hover
 * card. Colour never carries meaning alone: not read is hatched and captioned, sweep touches are captioned, last use has a mark.
 */
@customElement('dc-usage-bars')
export class DcUsageBars extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) bars: RowBars | null = null;
  /** The shared top (the 95th percentile of the listed month totals). */
  @property({ type: Number }) top = 0;
  /** The scan time, ms (for the date in the name). */
  @property({ type: Number }) scanRef = 0;
  /** Several layers (a source and its views). */
  @property({ type: Boolean }) family = false;

  protected override createRenderRoot(): HTMLElement { return this; }

  override render() {
    const b = this.bars;
    if (!b) return nothing;
    const g = barsGeometry(b, this.top);
    const head = sayRowHeadline(b, this.scanRef, this.family);
    return html`<button type="button" class="ub ub-${b.kind}" data-open-panel aria-haspopup="dialog" aria-label=${t('review.bars.name', { headline: head })}>
      <svg width=${BARS_WIDTH} height=${BARS_HEIGHT} viewBox="0 0 ${BARS_WIDTH} ${BARS_HEIGHT}" aria-hidden="true">${svg`
        <path class="ub-base" d=${rect(0, BASE, BARS_WIDTH, 1)}></path><path class="ub-nr" d=${g.notRead} fill="url(#${HATCH_ID})"></path><path class="ub-r" d=${g.real}></path><path class="ub-s" d=${g.sweep}></path><path class="ub-cap" d=${g.cap}></path><path class="ub-last" d=${g.last}></path>`}
      </svg><span class="ub-cap-t" aria-hidden="true"><span class="ub-t">${sayRowCaption(b)}</span><span class="ub-h">${t('review.bars.hint')}</span></span></button>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-usage-bars': DcUsageBars } }
