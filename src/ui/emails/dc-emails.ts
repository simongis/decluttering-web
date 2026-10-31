// DC-019: the Emails step (prototype D's email.js, re-implemented in Lit). Write and preview one digest per owner,
// send a test to yourself, and only after an explicit confirm send real digests, one owner at a time, with pause,
// resume and retry. Who may send what is decided in ./gate; digests are built in ./digest; the run is ./send-queue.
// Light DOM, so the global Calcite and token styles apply (src/styles/emails.css).
import { t, tn, tnParts } from '../../i18n';
import { LocaleController } from '../../i18n/controller';
import { noEmailLine, selectAll, selectionOf, selectNone, splitByEmail } from './select';
import { sendErrorText, testToast } from './toast-copy';
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import '@esri/calcite-components/dist/components/calcite-action';
import '@esri/calcite-components/dist/components/calcite-alert';
import '@esri/calcite-components/dist/components/calcite-avatar';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-checkbox';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-input';
import '@esri/calcite-components/dist/components/calcite-label';
import '@esri/calcite-components/dist/components/calcite-loader';
import '@esri/calcite-components/dist/components/calcite-notice';
import '@esri/calcite-components/dist/components/calcite-panel';
import '@esri/calcite-components/dist/components/calcite-progress';
import '@esri/calcite-components/dist/components/calcite-radio-button';
import '@esri/calcite-components/dist/components/calcite-radio-button-group';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import '../../styles/emails.css';
import { GROUP_TITLE, type GroupNotifier } from '../../notify';
import { getLogChoice, getNudgeLog, getNudgeSends, getOthersUnreadable, LOG_TITLE, setLogChoice, setNudgeLog, withSend, type LogChoice, type NudgeLog } from '../../log';
import { othersUnreadableLine, renudgeLine } from '../../domain/cooldown';
import { agoText, credit, plural } from '../shared/text';
import {
  buildDigest, chipsToTokens, emailHtml, esc, fillSubject, firstName, outsideLinks, PH_LABEL, PLACEHOLDERS, TONES, tokensToChips, totalCredits,
  usedPlaceholders, type Admin, type EmailOrg, type EmailOwner, type PlaceholderKey, type ToneKey,
} from './digest';
import { nextSendStep, sendGate, type Gate, type SendStep } from './gate';
import './dc-turn-on-sending';
import { TURN_ON_NEXT } from './turn-on-copy';
import { effectiveLimits, forgetPageSends, planSend, recordPageSend, sentTodayFor, type SendPlan } from './limits';
import { createSendQueue, tidyLine, tidyWarning, type QueueItem, type QueueSnapshot, type SendQueue } from './send-queue';

const INTRO_KEY = 'dc-email-intro-hidden';
const introHidden = (): boolean => { try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; } };

/** The template draft survives leaving and coming back to this step, in memory only (it can name nobody). */
const draft: { tone: ToneKey; subject: string; tpl: string; dirty: boolean } = {
  tone: 'friendly', subject: TONES.friendly.subject, tpl: TONES.friendly.html, dirty: false,
};

type SetupState = 'work' | 'done' | 'reuse';
interface Toast { title: string; message: string; kind: 'success' | 'danger' }
type Dialog = 'intro' | 'turn-on' | 'confirm' | 'tone' | 'link' | null;

const phaseLabel = (phase: QueueItem['phase']): string => t(({ waiting: 'emails.run.waiting', sending: 'emails.run.sending', done: 'emails.run.done', failed: 'emails.run.failed', skipped: 'emails.run.skipped', 'not-added': 'emails.run.not.added' } as const)[phase]);

@customElement('dc-emails')
export class DcEmails extends LitElement {
  private readonly _locale = new LocaleController(this);
  /** Every owner on the review's list; `rows` holds only their ticked items (none: shown, but can't be sent to). */
  @property({ attribute: false }) owners: EmailOwner[] = [];
  @property({ attribute: false }) admin: Admin = { name: '', username: '' };
  @property({ attribute: false }) org: EmailOrg = { name: '' };
  /** null: this org is read-only in this build (DC-058), so nothing can be sent. */
  @property({ attribute: false }) notifier: GroupNotifier | null = null;
  @property({ type: Boolean }) demo = false;
  /** This org may opt in to sending (VITE_SENDING, ADR 0013). Not the same as "this admin has": see `optedIn`. */
  @property({ type: Boolean }) writable = false;
  /** DC-125b: owner sends are unlocked for this session. The host sets it after `dc-emails-test-sent`; only the host's word counts. */
  @property({ type: Boolean }) ownerSendsUnlocked = false;
  /** DC-017: the nudge log (null: no log possible here, e.g. a read-only org). */
  @property({ attribute: false }) nudgeLog: NudgeLog | null = null;
  /** The org the review data is from: the remembered log choice and the in-memory log are per org. */
  @property() orgId = '';

  @state() private tone: ToneKey = draft.tone;
  @state() private subject = draft.subject;
  @state() private tpl = draft.tpl;
  @state() private ticked = new Set<string>();
  @state() private sel: string | null = null;
  @state() private canCreate: boolean | null = null;
  @state() private missing = '';
  @state() private setup: SetupState | null = null;
  /** DC-068: what tidying the group before this run did. */
  @state() private tidy: { line: string | null; warn: string | null } | null = null;
  @state() private testBusy = false;
  @state() private testSentAt: number | null = null;
  @state() private step: SendStep = 'compose';
  @state() private mode: 'all' | 'one' = 'all';
  @state() private oneIdx = 0;
  @state() private snap: QueueSnapshot | null = null;
  @state() private dialog: Dialog = null;
  @state() private toast: Toast | null = null;
  @state() private live = '';
  @state() private lifeChoice: 'keep' | 'remove' = 'keep';
  @state() private groupRemoved: 'no' | 'working' | 'yes' = 'no';
  /** DC-017: null while unknown. */
  @state() private logExists: boolean | null = null;
  @state() private logChoice: LogChoice = 'log';
  @state() private logSetup: SetupState | null = null;
  @state() private logged = 0;
  @state() private logWarn = '';
  /** The choice in force for the run under way (fixed at confirm). */
  private logOn = false;
  private pendingTone: ToneKey | null = null;
  private queue: SendQueue | null = null;
  /** DC-125d: this run's sends that now have a log row, so reading the log back can stop counting them twice. */
  private runPageSends: Date[] = [];
  private savedRange: Range | null = null;
  private returnFocus: HTMLElement | null = null;
  private checkedFor: GroupNotifier | null | undefined = undefined;

  @query('.em-editor') private editor!: HTMLElement;

  protected override createRenderRoot(): HTMLElement { return this; }

  /* ------------------------------------------------------------ derived */
  private get ctx() { return { admin: this.admin, org: this.org }; }
  private get template() { return { subject: this.subject, html: this.tpl }; }
  /** DC-121: who has no email on file (none are flagged when no address was loaded at all). */
  private get noEmail(): Set<string> { return new Set(splitByEmail(this.owners).noEmail.map((o) => o.username)); }
  private get sendable(): EmailOwner[] { const no = this.noEmail; return this.owners.filter((o) => o.rows.length > 0 && !no.has(o.username)); }
  private get picked(): EmailOwner[] { return this.sendable.filter((o) => this.ticked.has(o.username)); }
  /** DC-125d: this admin's owner emails today (own log rows dated today, plus sends made here that the log hasn't re-read). */
  private get sentToday(): number { return sentTodayFor(this.orgId, this.admin.username, getNudgeSends(this.orgId)); }
  private get limits() { return effectiveLimits(this.demo); }
  /** DC-125d: how many of the ticked owners go in this run (the per-run and per-day limits). */
  private get plan(): SendPlan { return planSend(this.picked.length, this.sentToday, this.limits); }
  /** The first `plan.go` ticked owners, in the current order; the rest stay ticked for the next run. */
  private get toSend(): EmailOwner[] { return this.picked.slice(0, this.plan.go); }
  private get previewOwner(): EmailOwner | undefined {
    return this.sendable.find((o) => o.username === this.sel) ?? this.picked[0] ?? this.sendable[0];
  }
  private get gate(): Gate {
    return sendGate({
      demo: this.demo, ownerSendsUnlocked: this.ownerSendsUnlocked, mayOptIn: this.writable && !!this.notifier,
      // Opted in = this admin's own app group exists (ADR 0013). Known once the role check has run (canCreate stays null until then).
      optedIn: !!this.notifier?.group,
      canCreate: this.notifier ? this.canCreate : false, missing: this.missing, owners: this.picked.length,
      adminEmail: this.admin.email, sentToday: this.sentToday, perDay: this.limits.perDay,
    });
  }

  /* ------------------------------------------------------------ lifecycle */
  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('owners')) {
      this.ticked = new Set(this.sendable.map((o) => o.username));
      if (!this.sendable.some((o) => o.username === this.sel)) this.sel = this.sendable[0]?.username ?? null;
    }
    if (this.checkedFor !== this.notifier) { this.checkedFor = this.notifier; void this.checkRole(); }
    if (changed.has('orgId')) this.logChoice = getLogChoice(this.orgId) ?? 'log';
    if (changed.has('nudgeLog')) void this.checkLog();
    if (!this.hasUpdated && !introHidden()) { this.returnFocus = null; this.dialog = 'intro'; }
  }

  protected override firstUpdated(): void {
    this.loadEditor(this.tpl);
  }

  /** Reads only: the role's privileges, then whether the app's hidden group is already there. */
  private async checkRole(): Promise<void> {
    const n = this.notifier;
    this.canCreate = null;
    if (!n) return;
    try {
      const r = await n.canCreateGroup();
      if (n !== this.notifier) return;
      this.missing = r.missing ?? '';
      if (r.ok) await n.findGroup();
      this.canCreate = r.ok;
    } catch (e) {
      if (n !== this.notifier) return;
      this.canCreate = false;
      this.missing = '';
      this.showToast(t('emails.notice.role'), e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  /** DC-017: a read only: is the app's nudge log already in the admin's content? */
  private async checkLog(): Promise<void> {
    const l = this.nudgeLog;
    this.logExists = null;
    if (!l) return;
    try {
      const t = await l.find();
      if (l === this.nudgeLog) this.logExists = !!t;
    } catch {
      if (l === this.nudgeLog) this.logExists = false;
    }
  }

  /* ------------------------------------------------------------ editor */
  private loadEditor(tpl: string): void {
    if (this.editor) this.editor.innerHTML = tokensToChips(tpl);
  }
  private readEditor = (): void => {
    this.tpl = chipsToTokens(this.editor.innerHTML);
    draft.tpl = this.tpl; draft.dirty = true;
  };
  private remember = (): void => {
    const s = getSelection();
    if (s?.rangeCount && this.editor.contains(s.anchorNode)) this.savedRange = s.getRangeAt(0).cloneRange();
  };
  private restore(): void {
    this.editor.focus();
    const s = getSelection();
    if (!s) return;
    if (this.savedRange) { s.removeAllRanges(); s.addRange(this.savedRange); return; }
    const r = document.createRange(); r.selectNodeContents(this.editor); r.collapse(false);
    s.removeAllRanges(); s.addRange(r);
  }
  private exec(cmd: string, value?: string): void {
    this.restore();
    document.execCommand(cmd, false, value);
    this.readEditor();
    this.remember();
  }
  private onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  };
  private insertPlaceholder(k: PlaceholderKey): void {
    this.exec('insertHTML', `<span class="ph" contenteditable="false" data-ph="${k}" title=${t('emails.placeholder.title')}>${esc(PH_LABEL[k])}</span>&nbsp;`);
  }
  private addLink = (): void => {
    const input = this.querySelector<HTMLInputElement>('#em-link-url');
    const url = (input?.value ?? '').trim();
    this.closeDialog();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const sel = this.savedRange;
    if (!sel || sel.collapsed) this.exec('insertHTML', `<a href="${esc(url)}">${esc(url)}</a>`);
    else this.exec('createLink', url);
  };

  private onTone = (e: Event): void => {
    const k = (e.target as HTMLInputElement).value as ToneKey;
    if (k === this.tone) return;
    if (!draft.dirty) { this.applyTone(k); return; }
    this.pendingTone = k;
    this.openDialog('tone', null);
  };
  private applyTone(k: ToneKey): void {
    this.tone = k; this.subject = TONES[k].subject; this.tpl = TONES[k].html;
    Object.assign(draft, { tone: k, subject: this.subject, tpl: this.tpl, dirty: false });
    this.loadEditor(this.tpl);
  }
  private keepTone(): void {
    this.pendingTone = null;
    const item = this.querySelector<HTMLElement & { checked: boolean }>(`#em-tone calcite-segmented-control-item[value="${this.tone}"]`);
    if (item) item.checked = true;
  }

  /* ------------------------------------------------------------ dialogs (focus goes back where it came from) */
  private openDialog(d: Exclude<Dialog, null>, from: EventTarget | null): void {
    this.returnFocus = (from as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
    this.dialog = d;
  }
  private closeDialog(): void {
    const was = this.dialog;
    this.dialog = null;
    if (was === 'tone' && this.pendingTone) this.keepTone();
    // A dialog that opened by itself (the first-visit "Before you send") has no opener: go to the page heading, not the logo (A11Y-04).
    const opener = this.returnFocus;
    const back = opener && opener !== document.body && opener.isConnected ? opener : this.querySelector<HTMLElement>('#email-h');
    this.returnFocus = null;
    if (back && was !== 'confirm') requestAnimationFrame(() => {
      const el = back as HTMLElement & { setFocus?: () => Promise<void> };
      if (el.setFocus) void el.setFocus(); else el.focus?.();
    });
  }
  /** A11Y-04: a dialog opens on its marked control (the field, or the safe choice), not on Calcite's Close button. */
  private focusMarked = (e: Event): void => {
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement & { setFocus?: () => Promise<void> }>('[data-focus]');
    if (el) requestAnimationFrame(() => { if (el.setFocus) void el.setFocus(); else el.focus(); });
  };
  private onDialogClose = (d: Dialog) => () => { if (this.dialog === d) this.closeDialog(); };
  private closeIntro = (): void => {
    const skip = this.querySelector<HTMLInputElement>('#em-intro-skip')?.checked;
    try { if (skip) localStorage.setItem(INTRO_KEY, '1'); else localStorage.removeItem(INTRO_KEY); } catch { /* storage blocked: it shows again */ }
    this.closeDialog();
  };

  private showToast(title: string, message: string, kind: Toast['kind'] = 'success'): void {
    this.toast = { title, message, kind };
    this.live = `${title}. ${message}`;
  }

  /* ------------------------------------------------------------ test to me */
  private onTest = (e: Event): void => {
    if (!this.gate.test.ok || this.testBusy || !this.notifier) return;
    // Only the demo's in-memory fake can get here without the group: a real admin must turn sending on first (below).
    if (!this.notifier.group) { this.openDialog('turn-on', e.currentTarget); return; }
    void this.sendTest();
  };

  /* ------------------------------------------------------------ turn on sending (ADR 0013) */
  /** The opt-in is the admin's own hidden group. Opens the warm confirm; nothing is created until they say yes. */
  private onTurnOn = (e: Event): void => {
    if (!this.canTurnOn()) return;
    this.openDialog('turn-on', e.currentTarget);
  };
  /** A real org: only while the gate says "not opted in" (the org may opt in, the role can create groups). The demo's fake: any time. */
  private canTurnOn(): boolean {
    const n = this.notifier;
    if (!n || n.group || this.testBusy) return false;
    return this.demo || this.gate.test.reason === 'not-opted-in';
  }
  private async turnOn(): Promise<void> {
    if (!this.canTurnOn()) return;
    this.testBusy = true;
    try {
      await this.ensureGroup();
      this.requestUpdate();
      this.showToast(t('emails.notice.sending.on'), TURN_ON_NEXT);
    } catch (err) {
      this.showToast(t('emails.notice.sending.error'), sendErrorText(err), 'danger');
    } finally {
      this.testBusy = false;
    }
  }
  private async sendTest(): Promise<void> {
    const n = this.notifier, o = this.previewOwner;
    if (!n || !o || this.testBusy || !this.gate.test.ok) return;
    this.testBusy = true;
    try {
      // The test never creates the group for a real admin: turning sending on is its own, deliberate step (ADR 0013).
      if (!n.group && !this.demo) throw new Error(t('emails.test.off.first'));
      await this.ensureGroup();
      const d = buildDigest(o, this.template, this.ctx, { test: true });
      await n.sendTest(d.subject, d.html); // to the signed-in admin only; there is no way to name anyone else
      this.testSentAt = Date.now();
      // ArcGIS accepted it (a failure threw above and never gets here): tell the host, which unlocks owner sends for this session.
      const first = !this.demo && !this.ownerSendsUnlocked;
      this.dispatchEvent(new CustomEvent('dc-emails-test-sent', { bubbles: true, composed: true }));
      const toast = testToast(this.admin.email, firstName(o.fullName), { unlocked: first });
      this.showToast(toast.title, toast.message);
    } catch (err) {
      this.showToast(t('emails.notice.test.error'), sendErrorText(err), 'danger');
    } finally {
      this.testBusy = false;
    }
  }
  /** Find-or-create the hidden group, showing a status row while it works. */
  private async ensureGroup(): Promise<void> {
    const n = this.notifier!;
    if (n.group) { this.setup = 'reuse'; return; }
    this.setup = 'work';
    try {
      const g = await n.createGroup();
      this.setup = g.reused ? 'reuse' : 'done';
    } catch (e) {
      this.setup = null;
      throw e;
    }
  }

  /* ------------------------------------------------------------ real sends */
  private onReal = (e: Event): void => {
    const next = nextSendStep(this.step, { type: 'ask' }, this.gate);
    if (next !== 'confirming') return;
    this.step = next;
    this.openDialog('confirm', e.currentTarget);
  };
  private cancelConfirm = (): void => {
    this.step = nextSendStep(this.step, { type: 'cancel' }, this.gate);
    this.closeDialog();
  };
  private confirmSend = (): void => {
    const next = nextSendStep(this.step, { type: 'confirm' }, this.gate);
    this.dialog = null;
    if (next === 'sending') {
      // The admin's answer is remembered for next time, and can be changed at any send.
      if (this.nudgeLog) setLogChoice(this.orgId, this.logChoice);
      this.logOn = !!this.nudgeLog && this.logChoice === 'log';
    }
    this.step = next;
    if (next === 'sending') void this.startRun();
  };

  private async startRun(): Promise<void> {
    const n = this.notifier;
    if (!n) { this.step = 'compose'; return; }
    const entries = this.toSend.map((o) => {
      const d = buildDigest(o, this.template, this.ctx);
      return { username: o.username, fullName: o.fullName, subject: d.subject, html: d.html };
    });
    if (!entries.length) { this.step = 'compose'; return; }
    const total = entries.length;
    this.runPageSends = [];
    const q = createSendQueue(entries, async (u, s, h) => {
      const r = await n.sendToOwner(u, s, h);
      if (r.sent && !r.notAdded) {
        // Counted for today's limit at once, whether or not a log row is written.
        const at = new Date();
        recordPageSend(this.orgId, this.admin.username, at);
        if (this.logOn && await this.logSend(u)) this.runPageSends.push(at);
      }
      return r;
    }, (ev) => {
      this.snap = q.snapshot();
      if (ev.type === 'state' && this.snap.halted) {
        const left = this.snap.items.filter((x) => x.phase === 'waiting').length;
        this.live = t('emails.live.stopped', { message: this.snap.halted.message, sent: this.snap.sent, left });
      }
      if (ev.type !== 'phase') return;
      const i = this.snap.items.findIndex((x) => x.username === ev.item.username) + 1;
      const who = ev.item.fullName;
      if (ev.item.phase === 'sending') this.live = t('emails.live.sending', { name: who, index: i, total });
      else if (ev.item.phase === 'done') this.live = t('emails.live.sent', { name: who, sent: this.snap.sent, total });
      else if (ev.item.phase === 'failed' || ev.item.phase === 'not-added') this.live = `${who}: didn’t go through. ${ev.item.error}`;
    }, { gapMs: this.limits.gapMs });
    this.queue = q;
    this.snap = q.snapshot();
    this.toast = null;
    this.oneIdx = 0;
    this.groupRemoved = 'no';
    this.tidy = null;
    this.lifeChoice = 'keep';
    this.logged = 0; this.logWarn = ''; this.logSetup = null;
    this.live = this.mode === 'one' ? t('emails.live.one.mode') : t(total === 1 ? 'emails.live.all.mode.one' : 'emails.live.all.mode.other', { count: total });
    try {
      await this.ensureGroup();
      if (this.logOn) await this.ensureLog();
    } catch (err) {
      this.showToast(t('emails.notice.setup.error'), sendErrorText(err), 'danger');
      this.queue = null; this.snap = null; this.step = 'compose';
      return;
    }
    await this.tidyFirst(n);
    if (this.mode === 'all') { await q.run(); this.afterRun(); }
    else this.requestUpdate();
  }
  /** DC-017: find-or-create the nudge log (the admin chose it at confirm), showing a status row while it works. */
  private async ensureLog(): Promise<void> {
    const l = this.nudgeLog!;
    if (l.table) { this.logSetup = 'reuse'; return; }
    this.logSetup = 'work';
    try {
      const t = await l.create();
      this.logSetup = t.reused ? 'reuse' : 'done';
      this.logExists = true;
    } catch (e) {
      this.logSetup = null;
      throw e;
    }
  }
  /** DC-017: one row per owner actually sent to. A failed row never undoes or fails the send; it warns. */
  private async logSend(username: string): Promise<boolean> {
    const l = this.nudgeLog, o = this.owners.find((x) => x.username === username);
    if (!l || !o) return false;
    const at = new Date();
    try {
      await l.record({ owner: username, sentAt: at, itemIds: o.rows.map((r) => r.id), credits: totalCredits(o.rows), sender: this.admin.username });
      this.logged += 1;
      setNudgeLog(this.orgId, withSend(getNudgeLog(this.orgId), username, at));
      return true;
    } catch (e) {
      this.logWarn = t('emails.log.failed', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
  /** DC-017: after a logged run, read the table back so the review shows what it really holds. */
  private async readBack(): Promise<void> {
    const l = this.nudgeLog;
    if (!l?.table || !this.logged) return;
    try {
      setNudgeLog(this.orgId, await l.read());
      // The log holds this run's logged sends now, so they are counted from it, not twice.
      forgetPageSends(this.orgId, this.admin.username, this.runPageSends);
      this.runPageSends = [];
    } catch { /* the rows just added are already shown, and still counted for today */ }
  }

  /** DC-068 (ADR 0002): each owner-send run starts by taking leftovers out of the app's group. A failure warns, never blocks. */
  private async tidyFirst(n: GroupNotifier): Promise<void> {
    try {
      const r = await n.tidyGroup();
      this.tidy = { line: tidyLine(r), warn: tidyWarning(r) };
      if (this.tidy.line) this.live = this.tidy.line;
    } catch (e) {
      this.tidy = { line: null, warn: t('emails.tidy.failed', { error: e instanceof Error ? e.message : String(e) }) };
    }
  }
  private afterRun(): void {
    const s = this.queue?.snapshot();
    if (s && s.finished && s.failed === 0 && this.mode === 'all') this.finish();
  }
  private finish(): void {
    if (this.queue?.snapshot().running) return;
    this.step = nextSendStep(this.step, { type: 'finished' }, this.gate);
    this.snap = this.queue?.snapshot() ?? null;
    const sent = this.snap?.sent ?? 0;
    // Owners just emailed come off the ticked list, so the next run's first owners are the ones still to go.
    const done = new Set(this.snap?.items.filter((i) => i.phase === 'done').map((i) => i.username) ?? []);
    if (done.size) this.ticked = new Set([...this.ticked].filter((u) => !done.has(u)));
    void this.readBack();
    this.live = sent ? t(sent === 1 ? 'emails.live.done.one' : 'emails.live.done.other', { count: sent }) : t('emails.live.nothing');
    requestAnimationFrame(() => this.querySelector<HTMLElement & { setFocus?: () => void }>('#done-back')?.setFocus?.());
  }
  private togglePause = async (): Promise<void> => {
    const q = this.queue;
    if (!q) return;
    if (q.snapshot().paused) { this.live = t('emails.live.resumed'); await q.resume(); this.afterRun(); }
    else { q.pause(); this.live = t('emails.live.paused'); }
  };
  private retry = async (u: string): Promise<void> => {
    const q = this.queue;
    if (!q || q.snapshot().running) return;
    await q.retry(u);
    this.afterRun();
  };
  /** DC-125d: after ArcGIS refused a send, the admin chooses to carry on from the next owner... */
  private resumeAfterStop = async (): Promise<void> => {
    const q = this.queue;
    if (!q || q.snapshot().running) return;
    this.live = t('emails.live.carry');
    await q.resume();
    this.afterRun();
  };
  /** ...or to stop here: nobody else is sent to. */
  private stopHere = (): void => { this.queue?.skipWaiting(); this.finish(); };
  private giveUp = (): void => { this.queue?.giveUpFailed(); this.finish(); };

  /* one at a time */
  private async oneSend(): Promise<void> {
    const q = this.queue, s = this.snap;
    const cur = s?.items[this.oneIdx];
    if (!q || !cur || s.running) return;
    await q.sendOne(cur.username);
  }
  private oneAdvance(): void {
    if (!this.snap) return;
    if (this.oneIdx + 1 >= this.snap.items.length) this.finish();
    else this.oneIdx += 1;
  }

  private async removeGroup(): Promise<void> {
    const n = this.notifier;
    if (!n?.group) return;
    this.groupRemoved = 'working';
    try {
      await n.deleteGroup();
      this.groupRemoved = 'yes';
      this.live = t('emails.group.removed');
    } catch (e) {
      this.groupRemoved = 'no';
      this.showToast(t('emails.notice.group.remove'), e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  private again = (): void => {
    this.step = nextSendStep(this.step, { type: 'again' }, this.gate);
    this.queue = null; this.snap = null; this.setup = null; this.tidy = null; this.logSetup = null;
  };

  private back = (): void => { this.dispatchEvent(new CustomEvent('dc-emails-back', { bubbles: true, composed: true })); };

  /* ------------------------------------------------------------ rendering */
  private whyOff(o: EmailOwner): { icon: string; text: string } | null {
    if (this.noEmail.has(o.username)) return { icon: 'email-address', text: t('emails.no.email') };
    if (o.rows.length) return null;
    if (o.nudgedRecently) return { icon: 'clock', text: t('emails.nudged', { ago: agoText(o.nudgedDaysAgo) }) };
    return { icon: 'information', text: t('emails.no.items') };
  }

  private renderOwners() {
    const sel = selectionOf(this.sendable.map((o) => o.username), this.ticked), locked = this.step !== 'compose';
    return html`<div class="em-selectbar" data-select-bar style="display:flex;align-items:center;gap:0.25rem;padding:0.25rem 0.5rem;flex-wrap:wrap;">
      <calcite-button data-action="select-all" scale="s" appearance="transparent" kind="neutral" ?disabled=${locked || sel.state === 'all' || !sel.total}
        @click=${() => { this.ticked = selectAll(this.sendable.map((o) => o.username)); }}>${t('emails.select.all')}</calcite-button>
      <calcite-button data-action="select-none" scale="s" appearance="transparent" kind="neutral" ?disabled=${locked || sel.state === 'none'}
        @click=${() => { this.ticked = selectNone(); }}>${t('emails.select.none')}</calcite-button>
      <small class="muted" data-select-count role="status" aria-live="polite">${sel.label}</small>
    </div>
    <ul class="em-owner-list" aria-label=${t('emails.owners')}>${this.owners.map((o) => {
      const why = this.whyOff(o), on = !why && this.ticked.has(o.username), selected = o.username === this.previewOwner?.username;
      return html`<li class="em-owner ${selected ? 'sel' : ''} ${on ? '' : 'off'} ${why ? 'dis' : ''}" data-owner=${o.username}>
        <calcite-checkbox label=${t('emails.select.owner.aria', { name: o.fullName })} ?checked=${on} ?disabled=${!!why || this.step !== 'compose'}
          @calciteCheckboxChange=${(e: Event) => {
            const next = new Set(this.ticked);
            if ((e.target as HTMLInputElement).checked) next.add(o.username); else next.delete(o.username);
            this.ticked = next;
          }}></calcite-checkbox>
        <button type="button" class="em-pick" aria-pressed=${selected ? 'true' : 'false'} ?disabled=${!!why}
          @click=${() => { this.sel = o.username; }}>
          <span class="em-oid"><b>${o.fullName}</b><small>${o.rows.length ? `${plural(o.rows.length, 'item', 'items')} · ≈ ${credit(totalCredits(o.rows))} ${t('emails.credits.month')}` : t('emails.owner.nothing.ticked')}</small>
          ${why ? html`<span class="em-why"><calcite-icon icon=${why.icon} scale="s" aria-hidden="true"></calcite-icon>${why.text}</span>` : nothing}</span>
        </button>
      </li>`;
    })}</ul>`;
  }

  private inbox(o: EmailOwner) {
    const from = this.admin.email ? `<${this.admin.email}>` : `(${t('emails.preview.you')})`;
    return html`<div class="inbox">
      <div class="inbox-meta">
        <div class="inbox-subj" data-preview="subject">${fillSubject(this.subject, o, this.ctx)}</div>
        <div class="inbox-line"><calcite-avatar scale="s" full-name=${this.admin.name} username=${this.admin.username}></calcite-avatar>
          <span><b>${this.admin.name}</b> <span class="muted">${from}</span><br><span class="muted small">${t('emails.preview.to')} ${o.fullName}${o.email ? ` <${o.email}>` : ''}</span></span></div>
      </div>
      <div class="inbox-body" data-preview="body">${unsafeHTML(emailHtml(this.tpl, o, this.ctx))}</div>
    </div>`;
  }

  private renderEditor() {
    const used = usedPlaceholders(this.tpl);
    const outside = outsideLinks(this.tpl);
    return html`<div class="em-edit-body">
      <calcite-segmented-control id="em-tone" width="full" scale="m" label=${t('emails.tone')} @calciteSegmentedControlChange=${this.onTone}>
        ${(Object.keys(TONES) as ToneKey[]).map((k) => html`<calcite-segmented-control-item value=${k} ?checked=${k === this.tone}>${TONES[k].label}</calcite-segmented-control-item>`)}
      </calcite-segmented-control>
      <calcite-label>${t('emails.subject')}<calcite-input id="em-subject" scale="s" label=${t('emails.subject')} .value=${this.subject}
        @calciteInputInput=${(e: Event) => { this.subject = (e.target as HTMLInputElement).value; draft.subject = this.subject; draft.dirty = true; }}></calcite-input></calcite-label>
      <div class="em-tools" role="toolbar" aria-label=${t('emails.format')} @mousedown=${(e: Event) => e.preventDefault()}>
        <calcite-button scale="s" appearance="outline-fill" kind="neutral" label=${t('emails.bold')} @click=${() => this.exec('bold')}><b>B</b></calcite-button>
        <calcite-button scale="s" appearance="outline-fill" kind="neutral" label=${t('emails.italic')} @click=${() => this.exec('italic')}><i>I</i></calcite-button>
        <calcite-button scale="s" appearance="outline-fill" kind="neutral" icon-start="link" label=${t('emails.link')} @click=${(e: Event) => { this.remember(); this.openDialog('link', e.currentTarget); }}></calcite-button>
        <calcite-button scale="s" appearance="outline-fill" kind="neutral" label=${t('emails.bullets')} @click=${() => this.exec('insertUnorderedList')}>&bull; ${t('emails.editor.bullets.text')}</calcite-button>
      </div>
      <div class="em-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label=${t('emails.template.aria')} spellcheck="true"
        @input=${this.readEditor} @paste=${this.onPaste} @keyup=${this.remember} @mouseup=${this.remember} @focusout=${this.remember}></div>
      <div class="em-chips" @mousedown=${(e: Event) => e.preventDefault()}><span class="muted small">${t('emails.placeholder.add')}</span>
        ${PLACEHOLDERS.map(([k, l]) => html`<calcite-button data-ph=${k} scale="s" appearance="outline" kind="brand" icon-start="plus" @click=${() => this.insertPlaceholder(k)}>${l}</calcite-button>`)}
      </div>
      ${used.includes('itemList') ? nothing : html`<calcite-notice open scale="s" kind="warning" icon="exclamation-mark-triangle"><div slot="message">${t('emails.warning.no.items')}</div></calcite-notice>`}
      ${outside.length ? html`<calcite-notice open scale="s" kind="warning" icon="link"><div slot="message">${t('emails.warning.link', { url: outside[0] })}</div></calcite-notice>` : nothing}
    </div>`;
  }

  private setupRow() {
    if (!this.setup) return nothing;
    const tidy = this.tidy;
    const tidyRows = tidy ? html`${tidy.line ? html`<div class="em-setup done" data-tidy="done" role="status"><calcite-icon icon="group" scale="s" aria-hidden="true"></calcite-icon><span>${tidy.line}</span><calcite-icon class="ok" icon="check-circle" scale="s" aria-hidden="true"></calcite-icon></div>` : nothing}
      ${tidy.warn ? html`<div class="em-setup em-warn" data-tidy="warn" role="alert"><calcite-icon icon="exclamation-mark-triangle" scale="s" aria-hidden="true"></calcite-icon><span>${tidy.warn}</span></div>` : nothing}` : nothing;
    const text = this.setup === 'work' ? t('emails.group.creating', { title: GROUP_TITLE })
      : this.setup === 'done' ? t('emails.group.created', { title: GROUP_TITLE })
      : t('emails.group.reuse', { title: GROUP_TITLE });
    return html`${tidyRows}<div class="em-setup ${this.setup}" data-setup=${this.setup}><calcite-icon icon="group" scale="s" aria-hidden="true"></calcite-icon><span>${text}</span>
      ${this.setup === 'work' ? html`<calcite-loader inline label=${t('emails.working')}></calcite-loader>` : html`<calcite-icon class="ok" icon="check-circle" scale="s" aria-hidden="true"></calcite-icon>`}</div>${this.logRow()}`;
  }

  /** DC-017: the nudge log's status while a run is set up, and a warning if a row didn't go in. */
  private logRow() {
    const s = this.logSetup;
    const text = s === 'work' ? t('emails.log.creating', { title: LOG_TITLE })
      : s === 'done' ? t('emails.log.created', { title: LOG_TITLE })
      : t('emails.log.adding', { title: LOG_TITLE });
    return html`${s ? html`<div class="em-setup ${s}" data-log-setup=${s}><calcite-icon icon="table" scale="s" aria-hidden="true"></calcite-icon><span>${text}</span>
      ${s === 'work' ? html`<calcite-loader inline label=${t('emails.working')}></calcite-loader>` : html`<calcite-icon class="ok" icon="check-circle" scale="s" aria-hidden="true"></calcite-icon>`}</div>` : nothing}
      ${this.logWarn ? html`<div class="em-setup em-warn" data-log="warn" role="alert"><calcite-icon icon="exclamation-mark-triangle" scale="s" aria-hidden="true"></calcite-icon><span>${this.logWarn}</span></div>` : nothing}`;
  }

  private renderBar() {
    const g = this.gate, n = this.picked, plan = this.plan;
    const items = n.reduce((s, o) => s + o.rows.length, 0);
    // DC-125d: the button says how many go now (the limits can be fewer than the ticked count).
    const goN = n.length ? plan.go : 0;
    const ownersLabel = plural(goN, 'owner', 'owners');
    const realLabel = t(this.mode === 'one' ? 'emails.button.go.through' : 'emails.button.send.to', { owners: ownersLabel });
    const blockNote = g.test.reason === 'read-only' ? t('emails.gate.unavailable')
      : g.test.reason === 'not-opted-in' ? t('emails.note.opted.off')
      : g.test.reason === 'no-privilege' ? t('emails.note.privilege', { message: g.test.message ?? '' })
      : g.test.reason === 'no-email' ? g.test.message ?? null
      : null;
    // DC-125b: opted in, test possible, owner sends still locked: the test is the next step, so it gets the highlight.
    const testNext = g.test.ok && g.owners.reason === 'test-first';
    return html`<div class="em-bar" data-bar="emails">
      <div class="em-setup-list">${this.setupRow()}</div>
      ${blockNote ? html`<div class="em-setup em-warn" role="note" data-note=${g.test.reason!}><calcite-icon icon="lock" scale="s" aria-hidden="true"></calcite-icon><span>${blockNote}</span></div>` : nothing}
      ${n.length && plan.notes.length ? html`<div class="em-setup" role="note" data-note="send-limit"><calcite-icon icon="information" scale="s" aria-hidden="true"></calcite-icon><span>${plan.notes.join(' ')}</span></div>` : nothing}
      <div class="em-bar-row">
        <div class="em-bar-sum"><b data-bar-main>${n.length ? `${plural(n.length, 'owner', 'owners')} · ${plural(items, 'item', 'items')}` : t('emails.no.one.ticked')}</b>
          <span>${this.testSentAt ? t('emails.note.test.sent') : t('emails.note.test.first')}</span>
          ${testNext && !this.testSentAt ? html`<span class="em-bar-note" data-note="test-each-session"><calcite-icon icon="information" scale="s" aria-hidden="true"></calcite-icon>${t('emails.gate.test.session')}</span>` : nothing}
          ${this.demo ? html`<span class="em-bar-note"><calcite-icon icon="information" scale="s" aria-hidden="true"></calcite-icon>${t('emails.note.demo')}</span>`
            : html`<span class="em-bar-note"><calcite-icon icon="lock" scale="s" aria-hidden="true"></calcite-icon>${t('emails.note.own.org')}</span>`}</div>
        <div class="em-bar-act">
          <calcite-segmented-control id="em-mode" scale="s" label=${t('emails.mode.send.label')} @calciteSegmentedControlChange=${(e: Event) => { this.mode = (e.target as HTMLInputElement).value as 'all' | 'one'; }}>
            <calcite-segmented-control-item value="all" ?checked=${this.mode === 'all'}>${t('emails.mode.all')}</calcite-segmented-control-item>
            <calcite-segmented-control-item value="one" ?checked=${this.mode === 'one'}>${t('emails.mode.one')}</calcite-segmented-control-item>
          </calcite-segmented-control>
          ${g.test.reason === 'not-opted-in'
            ? html`<calcite-button data-action="turn-on" appearance="outline" kind="brand" icon-start="group" ?disabled=${this.testBusy} ?loading=${this.testBusy}
                @click=${this.onTurnOn}>${t('emails.button.turn.on')}</calcite-button>`
            : html`<calcite-button data-action="test" appearance=${testNext ? 'solid' : 'outline'} data-next=${testNext ? 'true' : nothing} kind="brand" icon-start="email-address" ?disabled=${!g.test.ok || !this.previewOwner} ?loading=${this.testBusy}
                @click=${this.onTest}>${t('emails.button.test')}</calcite-button>`}
          <span class="em-real-wrap">
            <calcite-button data-action="send" icon-start="envelope" ?disabled=${!g.owners.ok} title=${g.owners.ok ? '' : g.owners.message ?? ''} aria-description=${g.owners.ok ? nothing : g.owners.message ?? nothing} @click=${this.onReal}>${realLabel}</calcite-button>
            ${g.owners.reason === 'test-first' ? html`<small class="em-off" data-note="test-first">${g.owners.message}</small>` : nothing}
          </span>
        </div>
      </div>
    </div>`;
  }

  private renderCompose() {
    const o = this.previewOwner;
    return html`<div class="em-head">
        <div><h1 id="email-h" tabindex="-1">${t('emails.heading')}</h1>
        <p class="lede">${t('emails.lede')}</p></div>
        <div class="em-head-act">
          <calcite-action icon="information" text=${t('emails.action.before')} text-enabled scale="s" appearance="transparent" @click=${(e: Event) => this.openDialog('intro', e.currentTarget)}></calcite-action>
          <calcite-button data-action="emails-back" appearance="transparent" kind="neutral" icon-start="arrow-left" scale="s" @click=${this.back}>${t('emails.back.review')}</calcite-button>
        </div>
      </div>
      <div class="em-grid">
        <calcite-panel heading=${t('emails.panel.who')} class="em-owners">${this.renderOwners()}</calcite-panel>
        <calcite-panel heading=${t('emails.panel.template')} description=${t('emails.panel.template.description')} class="em-edit">${this.renderEditor()}</calcite-panel>
        <calcite-panel heading=${t('emails.panel.preview')} description=${o ? t('emails.preview.description', { name: o.fullName }) : t('emails.preview.inbox')} class="em-prev">
          <div class="em-prev-body">${o ? this.inbox(o) : html`<p class="muted">${t('emails.preview.empty')}</p>`}</div></calcite-panel>
      </div>
      ${this.renderBar()}`;
  }

  private runRow(it: QueueItem) {
    const icon = it.phase === 'done' ? html`<calcite-icon icon="check-circle" scale="s" class="ok"></calcite-icon>`
      : it.phase === 'failed' || it.phase === 'not-added' ? html`<calcite-icon icon="exclamation-mark-triangle" scale="s" class="bad"></calcite-icon>`
      : it.phase === 'sending' ? html`<calcite-loader inline label=${t('emails.working')}></calcite-loader>` : html`<calcite-icon icon="circle" scale="s"></calcite-icon>`;
    const failed = it.phase === 'failed' || it.phase === 'not-added';
    return html`<li class="run-row ${it.phase}" data-run=${it.username} data-phase=${it.phase}>
      <span class="ri">${icon}</span><calcite-avatar scale="s" full-name=${it.fullName} username=${it.username}></calcite-avatar>
      <span class="rn"><b>${it.fullName}</b><small>${phaseLabel(it.phase)}${failed && it.error ? `: ${it.error}` : ''}</small></span>
      ${failed ? html`<calcite-button scale="s" appearance="outline" kind="brand" icon-start="reset" data-action="retry" ?disabled=${this.snap?.running ?? false}
        @click=${() => void this.retry(it.username)}>${t('emails.try.again')}</calcite-button>` : nothing}
    </li>`;
  }

  private renderRun() {
    const s = this.snap;
    if (!s) return nothing;
    if (this.mode === 'one') return this.renderOne(s);
    const n = s.items.length;
    const settingUp = this.setup === 'work';
    const waiting = s.items.filter((i) => i.phase === 'waiting');
    // DC-125d: a refusal from ArcGIS stops the run while owners are still waiting; nobody else is sent to until the admin says.
    const stopped = !!s.halted && waiting.length > 0 && !s.running;
    const heading = settingUp ? t('emails.run.getting.ready') : stopped ? t('emails.run.stopped') : s.finished ? t('emails.run.nearly.there') : s.paused ? t('emails.run.paused') : t('emails.run.sending.digests');
    const sub = settingUp ? t('emails.run.setup')
      : s.finished ? t('emails.run.summary', { sent: s.sent, failed: s.failed })
      : stopped ? t('emails.run.refused')
      : s.paused ? (s.running ? t('emails.run.finishing') : t('emails.run.paused.wait'))
      : t('emails.run.step');
    return html`<div class="run" data-run-state=${stopped ? 'stopped' : s.finished ? 'finished' : s.paused ? 'paused' : 'running'}>
      <div class="run-head"><div><h1>${heading}</h1><p class="lede">${sub}</p></div>
        <div class="run-act">${s.finished
          ? html`<calcite-button data-action="finish" appearance="outline" kind="neutral" @click=${this.giveUp}>${t('emails.button.finish')}</calcite-button>`
          : stopped ? nothing
          : html`<calcite-button data-action="pause" appearance="outline" kind="neutral" icon-start=${s.paused ? 'play' : 'pause'} ?disabled=${settingUp}
              @click=${this.togglePause}>${s.paused ? t('emails.button.resume') : t('emails.button.pause')}</calcite-button>`}</div></div>
      <div class="em-setup-list">${this.setupRow()}</div>
      ${stopped ? this.renderStopped(s, waiting) : nothing}
      <calcite-progress type="determinate" value=${n ? s.sent / n : 0} label=${t('emails.progress.send')}></calcite-progress>
      <p class="muted small" data-run-count>${t('emails.run.count', { sent: s.sent, total: n })}</p>
      <ul class="run-list" aria-label=${t('emails.owners')}>${s.items.map((it) => this.runRow(it))}</ul>
      ${this.demo ? html`<p class="em-note"><calcite-icon icon="information" scale="s" aria-hidden="true"></calcite-icon>${t('emails.note.demo')}</p>`
        : html`<p class="em-note"><calcite-icon icon="lock" scale="s" aria-hidden="true"></calcite-icon>${t('emails.note.own.org')}</p>`}
    </div>`;
  }

  /** DC-125d: what ArcGIS said, how many went, who is left, and the two ways on. */
  private renderStopped(s: QueueSnapshot, waiting: QueueItem[]) {
    const names = waiting.slice(0, 5).map((i) => i.fullName).join(', ') + (waiting.length > 5 ? t('emails.stopped.more', { count: waiting.length - 5 }) : '');
    const h = s.halted!, who = s.items.find((i) => i.username === h.username)?.fullName ?? h.username;
    return html`<div class="em-setup em-warn" role="alert" data-halted>
      <calcite-icon icon="exclamation-mark-triangle" scale="s" aria-hidden="true"></calcite-icon>
      <span><b>${t('emails.stopped.intro', { name: who })}${t('emails.stopped.said')}<span data-halted-message>${h.message}</span>${t('emails.stopped.close')} ${t(s.sent === 1 ? 'emails.stopped.sent.one' : 'emails.stopped.sent.other', { count: s.sent })} ${t('emails.stopped.left', { count: waiting.length, names, name: who })}</span>
      <span class="run-act">
        <calcite-button scale="s" data-action="resume-halt" icon-start="play" @click=${() => void this.resumeAfterStop()}>${t('emails.button.resume')}</calcite-button>
        <calcite-button scale="s" data-action="stop-here" appearance="outline" kind="neutral" @click=${this.stopHere}>${t('emails.stop.here')}</calcite-button>
      </span></div>`;
  }

  private renderOne(s: QueueSnapshot) {
    const it = s.items[this.oneIdx];
    if (!it) return nothing;
    const o = this.owners.find((x) => x.username === it.username)!;
    const busy = s.running || this.setup === 'work';
    const failed = it.phase === 'failed' || it.phase === 'not-added';
    return html`<div class="run one" data-run-state="one">
      <div class="run-head"><div><h1>${t('emails.one.heading')}</h1>
        <p class="lede">${this.setup === 'work' ? t('emails.run.setup') : t('emails.one.lede', { sent: s.sent })}</p></div>
        <calcite-button data-action="stop" appearance="outline" kind="neutral" ?disabled=${busy} @click=${() => this.finish()}>${t('emails.stop.here')}</calcite-button></div>
      <div class="em-setup-list">${this.setupRow()}</div>
      <calcite-progress type="determinate" value=${this.oneIdx / s.items.length} label=${t('emails.progress')}></calcite-progress>
      <p class="one-count">${t('emails.run.step.count', { current: this.oneIdx + 1, total: s.items.length })}</p>
      <div class="one-card">
        <div class="one-who"><calcite-avatar scale="m" full-name=${o.fullName} username=${o.username}></calcite-avatar>
          <span><b>${o.fullName}</b><small>${plural(o.rows.length, 'item', 'items')} · ≈ ${credit(totalCredits(o.rows))} ${t('emails.credits.month')}</small></span>
          <span class="one-status ${it.phase}" data-phase=${it.phase}>${it.phase === 'waiting' ? '' : `${phaseLabel(it.phase)}${failed && it.error ? `: ${it.error}` : ''}`}</span></div>
        ${this.inbox(o)}
      </div>
      <div class="one-act">
        <calcite-button appearance="transparent" kind="neutral" icon-start="arrow-left" ?disabled=${busy || this.oneIdx === 0} @click=${() => { this.oneIdx -= 1; }}>${t('emails.button.back')}</calcite-button>
        ${it.phase === 'done'
          ? html`<calcite-button data-action="next" icon-end="arrow-right" ?disabled=${busy} @click=${() => this.oneAdvance()}>${t('emails.button.next.owner')}</calcite-button>`
          : html`<calcite-button data-action="skip" appearance="outline" kind="neutral" ?disabled=${busy} @click=${() => { this.queue?.skip(it.username); this.oneAdvance(); }}>${t('emails.button.skip')}</calcite-button>
            <calcite-button data-action="send-one" icon-start="envelope" ?disabled=${busy} ?loading=${it.phase === 'sending'} @click=${() => void this.oneSend()}>${failed ? t('emails.button.try.again') : t('emails.button.send.one')}</calcite-button>`}
      </div>
    </div>`;
  }

  private renderDone() {
    const s = this.snap;
    const sentU = new Set(s?.items.filter((i) => i.phase === 'done').map((i) => i.username) ?? []);
    const sent = this.owners.filter((o) => sentU.has(o.username));
    const items = sent.reduce((a, o) => a + o.rows.length, 0), cr = sent.reduce((a, o) => a + totalCredits(o.rows), 0);
    const notRemoved = s?.notRemoved ?? [];
    const hasGroup = !!this.notifier?.group || this.groupRemoved === 'yes';
    return html`<div class="em-done" data-done=${sent.length}>
      <div class="confetti" aria-hidden="true">${sent.length ? Array.from({ length: 28 }, (_, i) => html`<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.18}s;--c:${['var(--dc-brand-500)', 'var(--dc-pine)', 'var(--dc-amber)', 'var(--dc-raspberry)'][i % 4]};--s:${6 + (i % 3) * 3}px"></i>`) : nothing}</div>
      <div class="done-card">
        <div class="done-badge"><calcite-icon icon="envelope" scale="l"></calcite-icon></div>
        <h1>${sent.length ? t('emails.done.sent.heading') : t('emails.done.none.heading')}</h1>
        <p class="lede">${sent.length
          ? tnParts('emails.done.sent.lede', sent.length).map((p, i) => i % 2 === 0 ? p
            : p === 'items' ? html`<b>${tn('common.unit.items', items, { count: items })}</b>` : p === 'credits' ? html`<b class="cr">${credit(cr)}</b>` : `{${p}}`)
          : t('emails.done.none.line')}</p>
        <ul class="done-facts">
          <li><calcite-icon icon="check" scale="s"></calcite-icon>${t('emails.done.safe')}</li>
          ${hasGroup ? (notRemoved.length
            ? html`<li class="warn"><calcite-icon icon="exclamation-mark-triangle" scale="s"></calcite-icon>${t(notRemoved.length === 1 ? 'emails.done.removed.summary.one' : 'emails.done.removed.summary.other')}</li>`
            : html`<li><calcite-icon icon="check" scale="s"></calcite-icon>${t('emails.done.group.empty')}</li>`) : nothing}
          ${!sent.length ? nothing : this.logged
            ? html`<li data-done-log="kept"><calcite-icon icon="check" scale="s"></calcite-icon>${t(this.logged === 1 ? 'emails.done.logged.one' : 'emails.done.logged.other', { count: this.logged })}</li>`
            : html`<li data-done-log="none"><calcite-icon icon="check" scale="s"></calcite-icon>${t('emails.done.log.none')}</li>`}
          ${this.logWarn ? html`<li class="warn"><calcite-icon icon="exclamation-mark-triangle" scale="s"></calcite-icon>${this.logWarn}</li>` : nothing}
        </ul>
        ${hasGroup ? html`<div class="done-life">
          <h2 class="em-h3"><calcite-icon icon="group" scale="s" aria-hidden="true"></calcite-icon>${t('emails.done.group.heading')}</h2>
          ${this.groupRemoved === 'yes' ? html`<div class="em-setup done" role="status"><span>${t('emails.done.group.removed')}</span></div>` : html`
          <calcite-radio-button-group name="em-life" layout="vertical" scale="m" @calciteRadioButtonGroupChange=${(e: Event) => { this.lifeChoice = (e.target as HTMLInputElement & { selectedItem?: { value: string } }).selectedItem?.value === 'remove' ? 'remove' : 'keep'; }}>
            <calcite-label layout="inline"><calcite-radio-button value="keep" ?checked=${this.lifeChoice === 'keep'}></calcite-radio-button><span><b>${t('emails.done.group.keep')}</b></span></calcite-label>
            <calcite-label layout="inline"><calcite-radio-button value="remove" ?checked=${this.lifeChoice === 'remove'}></calcite-radio-button><span><b>${t('emails.done.group.remove')}</b></span></calcite-label>
          </calcite-radio-button-group>
          ${this.lifeChoice === 'remove' ? html`<calcite-button data-action="remove-group" appearance="outline" kind="danger" icon-start="group" scale="s" ?loading=${this.groupRemoved === 'working'}
            @click=${() => void this.removeGroup()}>${t('emails.done.remove.button')}</calcite-button>` : nothing}`}
        </div>` : nothing}
        <div class="done-act"><calcite-button id="done-back" icon-start="arrow-left" @click=${this.back}>${t('emails.back.review')}</calcite-button>
          <calcite-button appearance="outline" kind="neutral" @click=${this.again}>${t('emails.done.write.more')}</calcite-button></div>
      </div>
    </div>`;
  }

  /** DC-017 (ADR 0005 tier 3): the nudge-log choice in the confirm dialog. */
  private renderLogChoice() {
    if (!this.nudgeLog) {
      return html`<p class="muted small" data-log-choice="unavailable">${t('emails.dialog.log.unavailable')}</p>`;
    }
    const exists = this.logExists === true;
    return html`<h3 class="em-h3">${t('emails.log.question')}</h3>
      <calcite-radio-button-group name="em-log" layout="vertical" scale="m" data-log-choice=${this.logChoice}
        @calciteRadioButtonGroupChange=${(e: Event) => { this.logChoice = (e.currentTarget as HTMLElement & { selectedItem?: { value: string } }).selectedItem?.value === 'none' ? 'none' : 'log'; }}>
        <calcite-label layout="inline"><calcite-radio-button value="log" data-log-option="log" ?checked=${this.logChoice === 'log'}></calcite-radio-button><span>${exists
          ? html`<b>${t('emails.log.add.recommended')}</b> ${t('emails.log.add.description', { title: LOG_TITLE })}`
          : html`<b>${t('emails.log.keep.recommended')}</b> ${t('emails.log.keep.description', { title: LOG_TITLE })}`}
          ${t('emails.log.privacy')}</span></calcite-label>
        <calcite-label layout="inline"><calcite-radio-button value="none" data-log-option="none" ?checked=${this.logChoice === 'none'}></calcite-radio-button><span><b>${t('emails.log.none.title')}</b> ${t('emails.log.none.description')}</span></calcite-label>
      </calcite-radio-button-group>`;
  }

  private renderDialogs() {
    const n = this.toSend, items = n.reduce((s, o) => s + o.rows.length, 0), cr = n.reduce((s, o) => s + totalCredits(o.rows), 0);
    const needGroup = !this.notifier?.group;
    const one = this.mode === 'one';
    const skipped = this.noEmail, noMail = this.owners.filter((o) => o.rows.length > 0 && skipped.has(o.username)).length;
    const noMailLine = noEmailLine(noMail, this.picked.length + noMail);
    const limitNotes = this.plan.notes;
    // DC-125c (ADR 0013 decision 6): a deliberate re-nudge is named, whoever sent the last one.
    const renudge = renudgeLine(n.filter((o) => o.nudgedRecently));
    const othersUnknown = !this.demo && getOthersUnreadable(this.orgId) ? othersUnreadableLine() : '';
    return html`
      <calcite-dialog id="em-intro" modal @calciteDialogOpen=${this.focusMarked} heading=${t('emails.intro.title')} width-scale="s" .open=${this.dialog === 'intro'} @calciteDialogClose=${this.onDialogClose('intro')}>
        <ul class="em-intro">
          <li><calcite-icon icon="envelope" scale="m" aria-hidden="true"></calcite-icon><span>${t('emails.intro.confirm')}</span></li>
          <li><calcite-icon icon="organization" scale="m" aria-hidden="true"></calcite-icon><span>${t('emails.intro.org')}</span></li>
          <li><calcite-icon icon="group" scale="m" aria-hidden="true"></calcite-icon><span>${t('emails.intro.group')}</span></li>
          <li><calcite-icon icon="list-check" scale="m" aria-hidden="true"></calcite-icon><span>${t('emails.intro.pace')}</span></li>
        </ul>
        <calcite-label layout="inline" slot="footer-start"><calcite-checkbox id="em-intro-skip" ?checked=${introHidden()}></calcite-checkbox>${t('emails.intro.skip')}</calcite-label>
        <calcite-button slot="footer-end" data-action="intro-ok" data-focus @click=${this.closeIntro}>${t('emails.intro.got.it')}</calcite-button>
      </calcite-dialog>

      <dc-turn-on-sending .open=${this.dialog === 'turn-on'} @dc-turn-on-close=${() => { if (this.dialog === 'turn-on') this.closeDialog(); }}
        @dc-turn-on-confirm=${() => { this.dialog = null; void this.turnOn(); }}></dc-turn-on-sending>

      <calcite-dialog id="em-confirm" modal @calciteDialogOpen=${this.focusMarked} heading=${one ? t('emails.confirm.one') : t('emails.confirm.all') } width-scale="s" .open=${this.dialog === 'confirm'} @calciteDialogClose=${() => { if (this.dialog === 'confirm') this.cancelConfirm(); }}>
        <div data-confirm>
          <p><b>${plural(n.length, 'owner', 'owners')}</b>${t('emails.confirm.after.items')}<b>${plural(items, 'item', 'items')}</b>${t('emails.confirm.after.count', { credits: credit(cr) })}${one ? t('emails.confirm.one.more') : ''}</p>
          <p>${t('emails.confirm.group', { title: GROUP_TITLE })}${needGroup ? t('emails.confirm.group.create') : ''}</p>
          ${limitNotes.length ? html`<p data-confirm-limit>${limitNotes.join(' ')}</p>` : nothing}
          ${noMailLine ? html`<p data-confirm-noemail>${noMailLine}</p>` : nothing}
          ${renudge ? html`<p data-confirm-renudge>${renudge}</p>` : nothing}
          ${othersUnknown ? html`<p data-confirm-others-unknown class="muted small">${othersUnknown}</p>` : nothing}
          ${this.testSentAt ? nothing : html`<calcite-notice open kind="warning" icon="exclamation-mark-triangle" scale="s"><div slot="message">${t('emails.confirm.test.first')}</div></calcite-notice>`}
          ${this.renderLogChoice()}
        </div>
        <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-focus @click=${this.cancelConfirm}>${t('emails.confirm.go.back')}</calcite-button>
        <calcite-button slot="footer-end" data-action="confirm-send" icon-start="envelope" @click=${this.confirmSend}>${one ? t('emails.confirm.start.one') : t(n.length === 1 ? 'emails.confirm.send.one' : 'emails.confirm.send.other', { count: n.length })}</calcite-button>
      </calcite-dialog>

      <calcite-dialog id="em-tone-dlg" modal @calciteDialogOpen=${this.focusMarked} heading=${t('emails.tone.switch.heading')} width-scale="s" .open=${this.dialog === 'tone'} @calciteDialogClose=${this.onDialogClose('tone')}>
        <p>${t('emails.tone.switch.body', { tone: this.pendingTone ? TONES[this.pendingTone].label : '' })}</p>
        <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-focus @click=${() => this.closeDialog()}>${t('emails.tone.keep')}</calcite-button>
        <calcite-button slot="footer-end" @click=${() => { const k = this.pendingTone; this.pendingTone = null; this.closeDialog(); if (k) this.applyTone(k); }}>${t('emails.tone.replace')}</calcite-button>
      </calcite-dialog>

      <calcite-dialog id="em-link-dlg" modal @calciteDialogOpen=${this.focusMarked} heading=${t('emails.link.add.heading')} width-scale="s" .open=${this.dialog === 'link'} @calciteDialogClose=${this.onDialogClose('link')}>
        <calcite-label>${t('emails.link.web.address')}<calcite-input id="em-link-url" data-focus type="url" placeholder="https://" label=${t('emails.link.web.address')} value="https://"
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.addLink(); }}></calcite-input></calcite-label>
        <p class="muted small">${t('emails.link.safety')}</p>
        <calcite-button slot="footer-end" @click=${this.addLink}>${t('emails.link.add.button')}</calcite-button>
      </calcite-dialog>

      <calcite-alert kind=${this.toast?.kind ?? 'success'} icon=${this.toast?.kind === 'danger' ? 'exclamation-mark-triangle' : 'envelope'} auto-close auto-close-duration="medium" placement="bottom" label=${t('emails.alert.label')}
        .open=${!!this.toast} @calciteAlertClose=${() => { this.toast = null; }}>
        <div slot="title">${this.toast?.title ?? ''}</div><div slot="message" data-toast>${this.toast?.message ?? ''}</div>
      </calcite-alert>`;
  }

  override render() {
    const composing = this.step === 'compose' || this.step === 'confirming';
    return html`<div class="em" data-step=${this.step}>
      <div class="em-compose" ?hidden=${!composing}>${this.renderCompose()}</div>
      ${this.step === 'sending' ? this.renderRun() : nothing}
      ${this.step === 'done' ? this.renderDone() : nothing}
      <p class="dc-sr" role="status" aria-live="polite" data-live>${this.live}</p>
      ${this.renderDialogs()}
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-emails': DcEmails } }
