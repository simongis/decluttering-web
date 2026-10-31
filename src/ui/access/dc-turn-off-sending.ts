// ADR 0013 / DC-125e: the calm confirm for "Turn off sending". Controlled: the host owns `open`, runs the removal and decides
// what happens next. It opens on "Keep it on" (the safe default). Events: dc-turn-off-confirm, dc-turn-off-close.
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-notice';
import { TURN_OFF } from './turn-off-copy';
import { LocaleController } from '../../i18n/controller';

@customElement('dc-turn-off-sending')
export class DcTurnOffSending extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ type: Boolean }) open = false;
  @property({ type: Boolean }) busy = false;
  /** A gentle message if it didn't work; the dialog stays open and the state is unchanged. */
  @property() error = '';

  protected override createRenderRoot(): HTMLElement { return this; }

  private focusSafe = (e: Event): void => {
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement & { setFocus?: () => Promise<void> }>('[data-focus]');
    if (el) requestAnimationFrame(() => { if (el.setFocus) void el.setFocus(); else el.focus(); });
  };
  private emit(name: 'dc-turn-off-confirm' | 'dc-turn-off-close'): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  protected override render() {
    return html`<calcite-dialog id="turn-off-dialog" data-dialog="turn-off" modal heading=${TURN_OFF.heading} width-scale="s" .open=${this.open}
      @calciteDialogOpen=${this.focusSafe} @calciteDialogClose=${() => { if (this.open) this.emit('dc-turn-off-close'); }}>
      <p>${TURN_OFF.body}</p>
      ${this.error ? html`<calcite-notice open kind="danger" scale="s" data-turn-off="error" role="alert"><div slot="message">${this.error}</div></calcite-notice>` : nothing}
      <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-action="turn-off-keep" data-focus ?disabled=${this.busy}
        @click=${() => this.emit('dc-turn-off-close')}>${TURN_OFF.keep}</calcite-button>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" data-action="turn-off-yes" ?loading=${this.busy} ?disabled=${this.busy}
        @click=${() => this.emit('dc-turn-off-confirm')}>${TURN_OFF.yes}</calcite-button>
    </calcite-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-turn-off-sending': DcTurnOffSending } }
