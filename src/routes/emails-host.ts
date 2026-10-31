// DC-019: the Emails step's host. Builds the notifier and hands <dc-emails> the owners ticked on Review.
//  - Demo: the real notifier code on an in-memory fake org (nothing leaves the browser).
//  - Signed in, an org that may opt in (VITE_SENDING, ADR 0013): the session notifier (own allow-list), wrapped so owner
//    sends throw while `ownerSendsUnlocked` is false. It turns true only after this admin's own test send succeeds in this
//    session (DC-125b, ui/emails/unlock: sessionStorage, per user and org, cleared on sign-out). The test send
//    goes to the signed-in admin only, and only once the admin has turned sending on.
//  - Signed in, any other org: no notifier at all; writing and previewing still work.
import { LitElement, html, type PropertyValues } from 'lit';
import { t } from '../i18n';
import { LocaleController } from '../i18n/controller';
import { customElement, property, state } from 'lit/decorators.js';
import type { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import { createSessionNotifier, WritesDisabled, type GroupNotifier } from '../notify';
import { PORTAL_URL } from '../auth/config';
import { gateNotifier, gateNudgeLog } from '../ui/emails/gate';
import { createDemoNotifier, createDemoNudgeLog } from '../ui/emails/demo-notifier';
import { createUnlock, type Unlock } from '../ui/emails/unlock';
import { createSessionNudgeLog, type NudgeLog } from '../log';
import type { Admin, EmailOwner } from '../ui/emails/digest';
import { emailOwners, getEmailSelection } from './email-selection';
import { go } from './router';
import { isSolo, onSoloChange } from './review-host';
import '../ui/emails/dc-emails';

export const DEMO_ADMIN: Admin = { name: 'Alex Ivanov', username: 'demo_admin', email: 'you@example.org' };

/** The demo's group starts with two people left over from an "earlier run", so the tidy line can be seen. */
const DEMO_LEFTOVERS = ['demo_left_over_1', 'demo_left_over_2'];

export interface EmailsHostProps {
  demo: boolean;
  manager?: ArcGISIdentityManager | null;
  admin: Admin;
  orgId: string;
  orgName: string;
  writable: boolean;
}

@customElement('app-emails')
export class AppEmails extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ type: Boolean }) demo = false;
  @property({ attribute: false }) manager: ArcGISIdentityManager | null = null;
  @property({ attribute: false }) admin: Admin = DEMO_ADMIN;
  @property() orgId = '';
  @property() orgName = '';
  /** This org may opt in to sending (AccessInfo.writable, from VITE_SENDING). */
  @property({ type: Boolean }) writable = false;
  /**
   * Owner sends are unlocked for this session (DC-125b): true only after a successful test for this user and org. The
   * notifier and log wrappers read it at every call, and <dc-emails> follows it through its `ownerSendsUnlocked` prop.
   * Fail closed: it starts false and anything but a successful test (or the stored mark for this user and org) leaves it so.
   */
  @state() protected ownerSendsUnlocked = false;
  private unlock: Unlock | null = null;
  private notifier: GroupNotifier | null = null;
  /** DC-017: the nudge log (demo: an in-memory table; real: the session log, created and written only once owner sends are unlocked). */
  private nudgeLog: NudgeLog | null = null;
  private built = false;
  /** DC-103: Review found no one to nudge, so this step has no one in it: it sends the admin back to Review. */
  private offSolo: (() => void) | null = null;
  private memo: { sel: unknown; owners: EmailOwner[] } | null = null;

  /** Owners from the review's selection, worked out once per selection. */
  private ownersFor(sel: NonNullable<ReturnType<typeof getEmailSelection>>): EmailOwner[] {
    if (this.memo?.sel !== sel) this.memo = { sel, owners: emailOwners(sel) };
    return this.memo.owners;
  }

  protected override createRenderRoot(): HTMLElement { return this; }

  override connectedCallback(): void {
    super.connectedCallback();
    this.offSolo = onSoloChange(() => this.requestUpdate());
  }
  override disconnectedCallback(): void {
    this.offSolo?.(); this.offSolo = null;
    super.disconnectedCallback();
  }

  private build(): void {
    if (this.built || this.solo) return; // nothing is built for a solo org: no group, no log table
    this.built = true;
    if (this.demo) {
      // The second ticked owner stalls once so "Try again" can be seen (as in prototype D).
      const sel = getEmailSelection();
      const owners = sel ? this.ownersFor(sel).filter((o) => o.rows.length) : [];
      const failOnceFor = owners.length > 1 ? owners[1]!.username : null;
      this.notifier = createDemoNotifier({ self: this.admin.username, delayMs: 250, failOnceFor, leftover: DEMO_LEFTOVERS }).notifier;
      this.nudgeLog = createDemoNudgeLog({ self: this.admin.username, orgId: this.orgId, delayMs: 150 }).log;
      return;
    }
    if (!this.writable || !this.manager) { this.notifier = null; return; }
    try {
      const real = createSessionNotifier(this.manager, { portal: PORTAL_URL, self: this.admin.username, orgId: this.orgId });
      const unlocked = (): boolean => this.ownerSendsUnlocked === true && this.unlock?.unlocked() === true;
      this.notifier = gateNotifier(real, unlocked);
      this.nudgeLog = gateNudgeLog(createSessionNudgeLog(this.manager, { portal: PORTAL_URL, self: this.admin.username, orgId: this.orgId }), unlocked);
    } catch (e) {
      if (!(e instanceof WritesDisabled)) throw e;
      this.notifier = null;
      this.nudgeLog = null;
    }
  }

  private get solo(): boolean { return isSolo(); }

  protected override willUpdate(changed: PropertyValues): void {
    // A different signed-in user or org gets its own unlock, which starts locked unless this session already tested for it.
    if (!this.unlock || changed.has('admin') || changed.has('orgId')) {
      this.unlock = this.demo ? null : createUnlock(this.admin.username, this.orgId);
      this.ownerSendsUnlocked = this.unlock?.unlocked() === true;
    }
    this.build();
  }

  /** <dc-emails> says the admin's own test was accepted by ArcGIS: unlock owner sends for this session. */
  private onTestSent = (): void => {
    if (this.demo || !this.unlock) return;
    this.unlock.testSucceeded();
    this.ownerSendsUnlocked = this.unlock.unlocked();
  };

  protected override updated(): void {
    if (this.solo) go('review');
  }

  protected override render() {
    if (this.solo) return html`<section data-page="emails" data-solo hidden></section>`;
    const sel = getEmailSelection();
    const back = () => go(this.demo ? 'demo' : 'review');
    if (!sel || !sel.items.length) {
      return html`<section data-page="emails" data-empty>
        <h1>${t('emails.empty.heading')}</h1>
        <p>${t('emails.empty.body')}</p>
        <calcite-button data-action="emails-back" icon-start="arrow-left" @click=${back}>${t('emails.back.review')}</calcite-button>
      </section>`;
    }
    return html`<dc-emails data-page="emails" .owners=${this.ownersFor(sel)} .admin=${this.admin} .org=${{ name: this.orgName }}
      .notifier=${this.notifier} .nudgeLog=${this.nudgeLog} orgId=${this.orgId} ?demo=${this.demo} ?writable=${this.demo || this.writable} ?ownerSendsUnlocked=${this.ownerSendsUnlocked}
      @dc-emails-back=${back} @dc-emails-test-sent=${this.onTestSent}></dc-emails>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'app-emails': AppEmails } }
