// ADR 0012: "App data in your org", on About. Lists the app's own hidden group and nudge log when they exist in a writable
// org, links to them in ArcGIS Online, and removes either one after an explicit, costed confirm. Renders nothing when its
// properties are missing or the org is read-only, and then sends no request at all. Detection is read only.
// Properties: notifier, nudgeLog, writable, org, signal (aborts detection), sending (disables removal during a send).
// Fires `dc-app-data-removed` ({ what: 'group' | 'log' }) after a removal, so the page can drop what it cached.
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import { customElement, property, state } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-notice';
import { forgetNudgeLog, type NudgeLog } from '../../log';
import type { GroupNotifier } from '../../notify';
import { COPY, canShowAppData, detectAppData, removeAppGroup, removeAppLog, type AppData, type AppDataOrg, type RemoveOutcome } from './app-data';
import './app-data.css';

type Which = 'group' | 'log';

@customElement('dc-app-data')
export class DcAppData extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) notifier: GroupNotifier | null = null;
  @property({ attribute: false }) nudgeLog: NudgeLog | null = null;
  @property({ type: Boolean }) writable = false;
  @property({ attribute: false }) org: AppDataOrg | null = null;
  @property({ attribute: false }) signal: AbortSignal | null = null;
  /** True while a send runs: removing the group then would break it, so removal is off. */
  @property({ type: Boolean }) sending = false;

  @state() private found: AppData | null = null;
  @state() private loading = false;
  @state() private dialog: Which | null = null;
  @state() private working = false;
  @state() private failure: { what: Which; href: string } | null = null;
  @state() private done: Which | null = null;
  private run = 0;

  protected override createRenderRoot(): HTMLElement { return this; }

  protected override updated(changed: PropertyValues): void {
    if (['notifier', 'nudgeLog', 'writable', 'org'].some((k) => changed.has(k))) void this.detect();
  }

  private async detect(): Promise<void> {
    const id = ++this.run;
    this.done = null; this.failure = null;
    if (!canShowAppData(this)) { this.found = null; this.loading = false; return; }
    this.loading = true;
    const res = await detectAppData(this, this.signal).catch(() => null);
    if (id !== this.run) return;
    this.loading = false;
    if (res) this.found = res;
  }

  private async confirm(what: Which): Promise<void> {
    if (this.sending || this.working || !this.org) return;
    this.working = true;
    let outcome: RemoveOutcome;
    if (what === 'group' && this.notifier) outcome = await removeAppGroup(this.notifier, this.org);
    else if (what === 'log' && this.nudgeLog && this.found?.log) outcome = await removeAppLog(this.nudgeLog, this.org, this.found.log.itemId);
    else outcome = { ok: false, message: what === 'group' ? COPY.groupFailed : COPY.logFailed, href: this.found?.[what]?.href ?? '' };
    this.working = false;
    this.dialog = null;
    if (!outcome.ok) { this.failure = { what, href: outcome.href }; return; }
    this.failure = null;
    if (what === 'log') forgetNudgeLog(this.org.id);
    this.found = { ...(this.found ?? { group: null, log: null }), [what]: null };
    this.done = what;
    this.dispatchEvent(new CustomEvent('dc-app-data-removed', { detail: { what }, bubbles: true, composed: true }));
  }

  private link(href: string) {
    return html`<a class="appdata-link" href=${href} target="_blank" rel="noopener noreferrer">${COPY.open}<span class="about-sr">${t('about.newTab')}</span></a>`;
  }

  override render() {
    if (!canShowAppData(this)) return nothing;
    const f = this.found;
    const rows = !!(f?.group || f?.log);
    if (!this.loading && !rows && !this.done && !this.failure) return nothing;
    return html`<section class="appdata" aria-labelledby="appdata-h" data-app-data>
      <h2 id="appdata-h">${COPY.heading}</h2>
      ${this.loading ? html`<p class="appdata-quiet" role="status" data-app-data-loading>${COPY.loading}</p>` : html`<p class="appdata-intro">${COPY.intro}</p>`}
      ${this.done ? html`<p class="appdata-quiet" role="status" data-app-data-done>${this.done === 'group' ? COPY.groupDone : COPY.logDone}</p>` : nothing}
      ${rows ? html`<ul class="appdata-rows">
        ${f?.group ? html`<li class="appdata-row" data-app-data-row="group">
          <div><span class="appdata-name">${COPY.groupRow}</span><span class="appdata-note">${COPY.groupNote}</span></div>
          <div class="appdata-actions">${this.link(f.group.href)}
            <calcite-button appearance="outline" kind="neutral" scale="s" data-action="remove-group" ?disabled=${this.sending}
              @click=${() => { this.dialog = 'group'; }}>${COPY.removeGroup}</calcite-button></div>
        </li>` : nothing}
        ${f?.log ? html`<li class="appdata-row" data-app-data-row="log">
          <div><span class="appdata-name">${COPY.logRow}</span><span class="appdata-note">${COPY.logNote(f.log.sends)}</span></div>
          <div class="appdata-actions">${this.link(f.log.href)}
            <calcite-button appearance="outline" kind="danger" scale="s" data-action="delete-log" ?disabled=${this.sending}
              @click=${() => { this.dialog = 'log'; }}>${COPY.deleteLog}</calcite-button></div>
        </li>` : nothing}
      </ul>` : nothing}
      ${this.sending && rows ? html`<p class="appdata-quiet" data-app-data-busy>${COPY.busy}</p>` : nothing}
      ${this.failure ? html`<calcite-notice class="appdata-fail" open kind="danger" icon="exclamation-mark-triangle" scale="s" data-app-data-failure>
        <div slot="message">${this.failure.what === 'group' ? COPY.groupFailed : COPY.logFailed}${this.failure.href ? html` <a class="appdata-link" href=${this.failure.href} target="_blank" rel="noopener noreferrer">${COPY.open}</a>` : nothing}</div>
      </calcite-notice>` : nothing}

      <calcite-dialog modal heading=${COPY.groupConfirmHeading} width-scale="s" .open=${this.dialog === 'group'}
        @calciteDialogClose=${() => { if (!this.working && this.dialog === 'group') this.dialog = null; }}>
        <p>${COPY.groupConfirm}</p>
        <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-action="keep-group" @click=${() => { this.dialog = null; }}>${COPY.groupKeep}</calcite-button>
        <calcite-button slot="footer-end" kind="danger" data-action="confirm-remove-group" ?loading=${this.working} ?disabled=${this.sending}
          @click=${() => void this.confirm('group')}>${COPY.groupConfirmButton}</calcite-button>
      </calcite-dialog>
      <calcite-dialog modal heading=${COPY.logConfirmHeading} width-scale="s" .open=${this.dialog === 'log'}
        @calciteDialogClose=${() => { if (!this.working && this.dialog === 'log') this.dialog = null; }}>
        <p>${COPY.logConfirm(f?.log?.sends ?? null)}</p>
        <calcite-button slot="footer-start" appearance="transparent" kind="neutral" @click=${() => { this.dialog = null; }}>${COPY.keep}</calcite-button>
        <calcite-button slot="footer-end" kind="danger" data-action="confirm-delete-log" ?loading=${this.working} ?disabled=${this.sending}
          @click=${() => void this.confirm('log')}>${COPY.logConfirmButton}</calcite-button>
      </calcite-dialog>
    </section>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-app-data': DcAppData } }
