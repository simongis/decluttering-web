import { LitElement, html, svg, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sparkGeometry } from './helpers';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';

/** DC-101: say what the bars cover, and that last used also counts opens. */
export const SPARK_TITLE = 'Days with data requests per week, last 13 weeks, today included (UTC). One request makes a day. Context only: Last used also counts opens.';

/** 13 weeks of days with data requests per week (UTC). DC-083: context only; the rule uses last used. */
@customElement('dc-sparkline')
export class DcSparkline extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) weekly: number[] = [];

  protected override createRenderRoot(): HTMLElement { return this; }

  override render() {
    if (!Array.isArray(this.weekly) || !this.weekly.length) return nothing;
    const g = sparkGeometry(this.weekly);
    return html`<span class="spark" title=${t('review.spark.title')}>
      <svg width=${g.width} height=${g.height} viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label=${t('review.spark.days', { count: g.total })} aria-description=${t('review.spark.title')}>
        ${g.bars.map((b) => svg`
          ${b.zero
            ? svg`<rect class="z" x=${b.x} y=${b.y} width="3" height="1"></rect>`
            : svg`<rect class="b" x=${b.x} y=${b.y} width="3" height=${b.h} rx="0.6"></rect>`}`)}
      </svg><small>${t('review.spark.requestDays')}</small></span>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-sparkline': DcSparkline } }
