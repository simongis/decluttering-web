// ADR 0013: the warm confirm for "Turn on sending". Controlled: the host owns `open`, runs the group creation, and decides
// what happens next. It opens on "Not now" (the safe default). Events: dc-turn-on-confirm, dc-turn-on-close.
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-notice';
import { turnOnCopy } from './turn-on-copy';
import { LocaleController } from '../../i18n/controller';

@customElement('dc-turn-on-sending')
export class DcTurnOnSending extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ type: Boolean }) open = false;
  /** The host is creating the group. */
  @property({ type: Boolean }) busy = false;
  /** A gentle message if it didn't work; the dialog stays open so the admin can try again or leave. */
  @property() error = '';

  protected override createRenderRoot(): HTMLElement { return this; }

  private focusSafe = (e: Event): void => {
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement & { setFocus?: () => Promise<void> }>('[data-focus]');
    if (el) requestAnimationFrame(() => { if (el.setFocus) void el.setFocus(); else el.focus(); });
  };
  private emit(name: 'dc-turn-on-confirm' | 'dc-turn-on-close'): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  protected override render() {
    const copy = turnOnCopy();
    return html`<calcite-dialog id="turn-on-dialog" data-dialog="turn-on" modal heading=${copy.heading} width-scale="s" .open=${this.open}
      @calciteDialogOpen=${this.focusSafe} @calciteDialogClose=${() => { if (this.open) this.emit('dc-turn-on-close'); }}>
      <ul class="turn-on-points">${copy.points.map((p) => html`<li>${p}</li>`)}</ul>
      ${this.error ? html`<calcite-notice open kind="danger" scale="s" data-turn-on="error" role="alert"><div slot="message">${this.error}</div></calcite-notice>` : nothing}
      <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-action="turn-on-no" data-focus ?disabled=${this.busy}
        @click=${() => this.emit('dc-turn-on-close')}>${copy.no}</calcite-button>
      <calcite-button slot="footer-end" data-action="turn-on-yes" icon-start="group" ?loading=${this.busy} ?disabled=${this.busy}
        @click=${() => this.emit('dc-turn-on-confirm')}>${copy.yes}</calcite-button>
    </calcite-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-turn-on-sending': DcTurnOnSending } }
