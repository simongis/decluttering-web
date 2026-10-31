import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-action';
import '@esri/calcite-components/dist/components/calcite-icon';
import { QUIP_EVERY_MS, QUIP_FADE_MS, QUIP_SHOW_AFTER_MS, createRotation, createTipState, getQuipSource, localizedQuip, safeUrl, type Quip } from './quips';

/**
 * DC-063: one friendly rotating tip under the scan progress (docs/research/waiting-ux.md).
 * Hidden for the first `showAfterMs` (10 s), then a new line every `everyMs` (12 s), never repeated until the list is used up.
 * Pause / Play is the control (WCAG 2.2.2) and stays paused until Play; hover and focus only hold the line while they last.
 * "Read more" opens in a new tab. Not a live region: render it outside the scan's role=status element.
 * The tips stop when the element is removed (the scan ended or the review opened).
 */
@customElement('dc-tips')
export class DcTips extends LitElement {
  @property({ type: Number, attribute: 'show-after-ms' }) showAfterMs = QUIP_SHOW_AFTER_MS;
  @property({ type: Number, attribute: 'every-ms' }) everyMs = QUIP_EVERY_MS;
  @property({ attribute: false }) list?: Quip[];
  private readonly _locale = new LocaleController(this);
  @state() private quip: Quip | null = null;
  @state() private paused = false;

  private rot = createRotation(getQuipSource());
  private tips = createTipState();
  private timer = 0; private showTimer = 0; private fadeTimer = 0; private swapId = 0;
  /** A11Y-09: followed live (see dc-dot-map). */
  private readonly rmq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private reduce = this.rmq?.matches ?? false;
  private onReduceChange = (e: MediaQueryListEvent): void => { this.reduce = e.matches; };

  protected override createRenderRoot(): HTMLElement { return this; }

  override connectedCallback(): void {
    super.connectedCallback();
    this.reduce = this.rmq?.matches ?? false; this.rmq?.addEventListener?.('change', this.onReduceChange);
    this.rot = createRotation(this.list ?? getQuipSource());
    this.addEventListener('pointerenter', this.hold);
    this.addEventListener('pointerleave', this.release);
    this.addEventListener('focusin', this.hold);
    this.addEventListener('focusout', () => setTimeout(this.release));
    if ((this.list ?? getQuipSource()).length) this.showTimer = window.setTimeout(() => { this.set(); this.arm(); }, this.showAfterMs);
  }

  override disconnectedCallback(): void {
    this.tips.stop();
    clearTimeout(this.timer); clearTimeout(this.showTimer); clearTimeout(this.fadeTimer); this.swapId++;
    this.removeEventListener('pointerenter', this.hold);
    this.removeEventListener('pointerleave', this.release);
    this.removeEventListener('focusin', this.hold);
    this.rmq?.removeEventListener?.('change', this.onReduceChange);
    super.disconnectedCallback();
  }

  private set(): void { const q = this.rot.next(); if (q) this.quip = q; }

  /**
   * FB-28: the old line drifts up 4 px and fades (~150 ms), the new one rises in from 6 px below (~200 ms) while the card eases to its new height.
   * Reduced motion: opacity only, same timings. No Web Animations support: the line just changes.
   */
  private async swap(): Promise<void> {
    const token = ++this.swapId;
    clearTimeout(this.fadeTimer);
    this.getAnimations?.().forEach((a) => a.cancel());
    const parts = () => Array.from(this.querySelectorAll<HTMLElement>('.dc-tip-body, .dc-tip > calcite-icon'));
    const out = parts();
    if (!out.length || typeof out[0].animate !== 'function') { this.set(); return; }
    const move = !this.reduce;
    const from = this.offsetHeight;
    const lock = (a: Animation | undefined) => a?.finished.catch(() => undefined);
    await Promise.all(out.map((e) => lock(e.animate(
      move ? [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 -4px' }] : [{ opacity: 1 }, { opacity: 0 }],
      { duration: QUIP_FADE_MS / 2, easing: 'ease-in', fill: 'forwards' }))));
    if (token !== this.swapId || !this.isConnected) return;
    this.set();
    await this.updateComplete;
    if (token !== this.swapId) return;
    const next = parts();
    const to = this.offsetHeight;
    out.forEach((e) => e.getAnimations().forEach((a) => a.cancel()));
    next.forEach((e) => e.animate(
      move ? [{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }] : [{ opacity: 0 }, { opacity: 1 }],
      { duration: QUIP_FADE_MS * 0.7, easing: 'ease-out' }));
    if (move && from !== to) this.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: QUIP_FADE_MS * 0.7, easing: 'ease-out' });
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.tips.running) this.timer = window.setTimeout(() => { void this.swap(); this.arm(); }, this.everyMs);
  }

  private hold = (): void => { this.tips.setHold(true); clearTimeout(this.timer); };
  private release = (): void => {
    if (this.matches(':hover') || this.contains(document.activeElement)) return;
    this.tips.setHold(false); if (this.quip) this.arm();
  };

  private toggle(): void {
    this.paused = this.tips.togglePause();
    if (this.paused) clearTimeout(this.timer); else if (this.quip) this.arm();
  }

  protected override render() {
    const q = this.quip;
    if (!q) return nothing;
    const localized = this.list ? q : localizedQuip(q);
    const href = localized.url ? safeUrl(localized.url) : null;
    return html`
      <div class="dc-tip" role="group" aria-label=${t('scan.tip.while-wait')} data-scan="tip">
        <calcite-icon scale="s" icon=${q.kind === 'tip' ? 'lightbulb' : 'smile'} aria-hidden="true"></calcite-icon>
        <span class="dc-tip-body"><span data-tip="text">${localized.text}</span>${href ? html` <a data-tip="link" href=${href} target="_blank" rel="noopener noreferrer">${localized.linkText || t('scan.tip.read-more')}<span class="dc-sr">${t('scan.tip.opens-new-tab')}</span></a>` : nothing}</span>
        <calcite-action data-tip="pause" scale="s" text-enabled icon=${this.paused ? 'play' : 'pause'} text=${this.paused ? t('scan.tip.play') : t('scan.tip.pause')} aria-pressed=${this.paused ? 'true' : 'false'} @click=${() => this.toggle()}></calcite-action>
        <calcite-action data-tip="next" scale="s" text-enabled icon="chevron-right" text=${t('scan.tip.next')} @click=${() => { void this.swap(); if (this.tips.running) this.arm(); }}></calcite-action>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-tips': DcTips } }
