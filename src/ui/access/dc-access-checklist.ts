// DC-111 (FB-67): "What can I do here?" A short, friendly checklist of what this account can do in Decluttering, with a
// tick or a gentle cross per line and a one-line summary. No network: it is worked out from facts sign-in already holds.
// <dc-access-checklist>: props mode, usageReadable, mayOptIn (ADR 0013), optedIn, dismissible, announce. Events: dc-access-dismiss, dc-turn-on-sending, dc-turn-off-sending.
// <dc-access-dialog>: the same list in a Calcite dialog (header menu entry). Props: open, mode, usageReadable, mayOptIn, optedIn. Event: dc-access-close.
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import { capabilities, emailCapability, privilegesOfMode, type AccessMode, type Capability, type CapabilityId } from '../../auth/access';
import { t } from '../../i18n';
import { LocaleController } from '../../i18n/controller';
import '../../styles/access.css';

const ICON: Record<CapabilityId, string> = { view: 'users', usage: 'graph-bar', send: 'envelope', 'org-send': 'organization', email: 'email-address' };
const STATE_ICON = { yes: 'check-circle-f', no: 'x-circle', neutral: 'minus-circle' } as const;
const stateWord = (state: Capability['state']): string => state === 'yes' ? t('access.state.yes') : state === 'no' ? t('access.state.unavailable') : t('access.state.note');

@customElement('dc-access-checklist')
export class DcAccessChecklist extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property() mode: AccessMode = 'admin';
  @property({ type: Boolean }) usageReadable = true;
  /** ADR 0013: an admin in this org may turn sending on (VITE_SENDING). */
  @property({ type: Boolean }) mayOptIn = false;
  /** This admin has turned sending on (their own app group exists). */
  @property({ type: Boolean }) optedIn = false;
  /** DC-121: the signed-in user's profile email. undefined = not known (no row); empty = none on file. */
  @property() email?: string;
  @property({ type: Boolean }) dismissible = false;
  /** Say the summary once (polite) when this appears. Off in the dialog, which announces itself. */
  @property({ type: Boolean }) announce = false;

  protected override createRenderRoot(): HTMLElement { return this; }

  private row(c: Capability) {
    const icon = c.id === 'org-send' && c.state === 'neutral' ? 'lock' : ICON[c.id];
    return html`<li class="ac-row" data-cap=${c.id} data-state=${c.state}>
      <calcite-icon class="ac-icon" icon=${icon} scale="m" aria-hidden="true"></calcite-icon>
      <span class="ac-text"><strong>${c.label}</strong><span>${c.line}</span>${c.action === 'turn-on'
        ? html`<calcite-button data-action="turn-on-sending" scale="s" appearance="outline" kind="brand" icon-start="group"
            @click=${() => this.dispatchEvent(new CustomEvent('dc-turn-on-sending', { bubbles: true, composed: true }))}>${t('access.action.turnOn')}</calcite-button>`
        : c.action === 'turn-off'
        ? html`<calcite-button data-action="turn-off-sending" scale="s" appearance="transparent" kind="neutral"
            @click=${() => this.dispatchEvent(new CustomEvent('dc-turn-off-sending', { bubbles: true, composed: true }))}>${t('access.action.turnOff')}</calcite-button>` : null}</span>
      <span class="ac-mark" data-mark=${c.state}><calcite-icon icon=${STATE_ICON[c.state]} scale="m" aria-hidden="true"></calcite-icon><span class="dc-sr">${stateWord(c.state)}</span></span>
    </li>`;
  }

  protected override render() {
    const c = capabilities(privilegesOfMode(this.mode), this.usageReadable, this.mayOptIn, this.optedIn);
    const mail = emailCapability(this.email);
    const items = mail ? [...c.items, mail] : c.items;
    return html`
      <section class="ac-card" data-access="card" data-level=${c.level} aria-labelledby="dc-ac-h">
        <header class="ac-head">
          <h2 id="dc-ac-h">${t('access.checklist.heading')}</h2>
          ${this.dismissible ? html`<calcite-button data-action="access-dismiss" appearance="transparent" kind="neutral" scale="s" icon-start="x" label=${t('access.checklist.dismiss')}
            @click=${() => this.dispatchEvent(new CustomEvent('dc-access-dismiss', { bubbles: true, composed: true }))}></calcite-button>` : null}
        </header>
        ${this.announce ? html`<p class="dc-sr" role="status" data-access="announce">${c.summary}</p>` : null}
        <ul class="ac-list" aria-label=${t('access.checklist.aria')}>${items.map((i) => this.row(i))}</ul>
        <p class="ac-summary" data-access="summary">${c.summary}</p>
      </section>`;
  }
}

@customElement('dc-access-dialog')
export class DcAccessDialog extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ type: Boolean }) open = false;
  @property() mode: AccessMode = 'admin';
  @property({ type: Boolean }) usageReadable = true;
  @property({ type: Boolean }) mayOptIn = false;
  @property({ type: Boolean }) optedIn = false;
  @property() email?: string;

  protected override createRenderRoot(): HTMLElement { return this; }

  protected override render() {
    return html`
      <calcite-dialog data-access="dialog" heading=${t('access.dialog.heading')} scale="s" width-scale="s" ?open=${this.open}
        @calciteDialogClose=${() => this.dispatchEvent(new CustomEvent('dc-access-close', { bubbles: true, composed: true }))}>
        <dc-access-checklist .mode=${this.mode} .usageReadable=${this.usageReadable} .mayOptIn=${this.mayOptIn} .optedIn=${this.optedIn} .email=${this.email}></dc-access-checklist>
        <calcite-button slot="footer-end" data-action="access-close" @click=${() => this.dispatchEvent(new CustomEvent('dc-access-close', { bubbles: true, composed: true }))}>${t('access.dialog.close')}</calcite-button>
      </calcite-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-access-checklist': DcAccessChecklist; 'dc-access-dialog': DcAccessDialog } }
