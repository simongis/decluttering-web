// The review screen: <dc-review> with the Sankey in its chart slot. Shared by the demo, admin and my-items routes.
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AccessMode } from '../auth/access';
import type { Data, OwnerGroup, Thresholds } from '../domain/types';
import { PRESETS, evaluate } from '../domain/stale';
import { visibleBrokenRefs } from '../domain/broken-refs';
import '../ui/review/index';
import type { SelectionDetail } from '../ui/review/index';
import '../ui/review/dc-broken-refs';
import '../ui/sankey/dc-sankey';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import { RESCAN_ASK_MS, sayRescan } from '../ui/scan/estimate';
import { credit } from '../ui/shared/text';
import { formatNumber, t, tn } from '../i18n';
import { LocaleController } from '../i18n/controller';
import { go, type Route } from './router';
import { setEmailSelection } from './email-selection';
import { applyNudgeLog, getNudgeLog, getNudgeSends, onNudgeLogChange, readSeededLog, setNudgeLog } from '../log';
import { sinceNudges, type SinceNudges } from '../domain/outcomes';
import { countSweeps, onCountSweepsChange, setCountSweeps } from '../cache/settings';

/**
 * DC-103: whether Review found no one to nudge (every flagged owner is the admin). Kept in memory so the Emails step can
 * send the admin back to Review instead of showing an email step with nobody in it. The demo and a normal org are never solo.
 */
let solo = false;
const soloListeners = new Set<() => void>();
export const isSolo = (): boolean => solo;
export const onSoloChange = (fn: () => void): (() => void) => { soloListeners.add(fn); return () => { soloListeners.delete(fn); }; };
const setSolo = (v: boolean): void => { if (solo === v) return; solo = v; for (const fn of [...soloListeners]) fn(); };

export interface ReviewProps { data: Data; mode: AccessMode; canSeeUsage: boolean; username?: string; note?: string; refreshing?: boolean; depsKnown?: boolean; stopped?: boolean; emailsRoute?: Route;
  /** DC-105: Rescan is on offer (the show rule is in cache/rescan.ts); `ms` is the estimate, `measured` whether it came from the last full scan. */
  rescan?: { ms: number; measured: boolean } | null; onRescan?: () => void }

@customElement('app-review')
export class AppReview extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) data!: Data;
  @property() mode: AccessMode = 'admin';
  @property({ type: Boolean }) canSeeUsage = true;
  @property() username = '';
  @property() note = '';
  @property({ type: Boolean }) refreshing = false;
  /** False while maps and apps are still being read: "used by" is unreliable and no family may be called stale on it (ADR 0007). */
  @property({ type: Boolean }) depsKnown = true;
  /** The scan was stopped after the core (DC-053). */
  @property({ type: Boolean }) stopped = false;
  /** DC-105: Rescan, when on offer (null hides it), and what to do when chosen. */
  @property({ attribute: false }) rescan: { ms: number; measured: boolean } | null = null;
  @property({ attribute: false }) onRescan: (() => void) | undefined;
  @state() private rescanAsk = false;
  @state() private thresholds: Thresholds = { ...PRESETS.balanced };
  @state() private selected: string | null = null;
  /** DC-019: where "Next: write the emails" goes (#/emails, or #/demo/emails in the demo). */
  @property() emailsRoute: Route = 'emails';
  @state() private selection: SelectionDetail = { owners: [], items: [], services: 0, credits: 0 };

  /** DC-017: re-render when the nudge log is read or a logged send happens. */
  private offLog: (() => void) | null = null;
  /** DC-086: re-render when "Count days when everything was touched at once" changes (here or on the scan screen). */
  private offSweeps: (() => void) | null = null;
  private memo: { data: Data; log: unknown; out: Data } | null = null;
  private sinceMemo: { data: Data; sends: unknown; partial: boolean; sweeps: boolean; out: SinceNudges | null } | null = null;
  /** DC-096: the demo's nudge log is seeded once per org (public/demo/mock-small-log.json). */
  private static seeded = new Set<string>();

  protected override createRenderRoot(): HTMLElement { return this; }

  override connectedCallback(): void {
    super.connectedCallback();
    this.offLog = onNudgeLogChange(() => this.requestUpdate());
    this.offSweeps = onCountSweepsChange(() => this.requestUpdate());
  }
  override disconnectedCallback(): void {
    clearTimeout(this.sankeyTimer); this.sankeyTimer = 0;
    this.offLog?.(); this.offLog = null;
    this.offSweeps?.(); this.offSweeps = null;
    setSolo(false);
    super.disconnectedCallback();
  }

  /** The data with each owner's lastNotified from the org's nudge log, if one was read (DC-017). Memoised. */
  private get logged(): Data {
    const log = getNudgeLog(this.data.org.id);
    if (this.memo?.data !== this.data || this.memo.log !== log) this.memo = { data: this.data, log, out: applyNudgeLog(this.data, log) };
    return this.memo.out;
  }

  /**
   * DC-096: "Since your nudges", from the sends the log read gave (none: no card). Admin only. A stopped scan, or a role
   * that can't see usage, can't tell "no change" from "not read", so those items are "not checked". Memoised.
   */
  private since(data: Data, countSweeps: boolean): SinceNudges | null {
    if (this.mode === 'my-items') return null;
    const sends = getNudgeSends(data.org.id);
    const partial = this.stopped || !this.canSeeUsage;
    const m = this.sinceMemo;
    if (m?.data !== data || m.sends !== sends || m.partial !== partial || m.sweeps !== countSweeps) {
      this.sinceMemo = { data, sends, partial, sweeps: countSweeps, out: sinceNudges(data, sends, { partial, countSweeps }) };
    }
    return (this.sinceMemo as { out: SinceNudges | null }).out;
  }

  /** DC-096: the demo reads its seeded log (the real read code over an in-memory fake, no network) the first time. */
  private seedDemoLog(): void {
    const id = this.data?.org.id;
    if (this.emailsRoute !== 'demo-emails' || !id || AppReview.seeded.has(id) || getNudgeSends(id)) return;
    AppReview.seeded.add(id);
    void (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}demo/mock-small-log.json`);
        if (!res.ok) return;
        const body = await res.json() as { rows?: unknown };
        if (!Array.isArray(body.rows) || getNudgeSends(id)) return;
        setNudgeLog(id, await readSeededLog({ self: 'demo_admin', orgId: id, rows: body.rows as Record<string, unknown>[] }));
      } catch { /* no demo log: no card */ }
    })();
  }

  protected override willUpdate(): void { this.seedDemoLog(); if (!this.rescan && this.rescanAsk) this.rescanAsk = false; }

  /** DC-105: over about two minutes, ask first; under it, just start. */
  private rescanClick = () => {
    if (!this.rescan) return;
    if (this.rescan.ms > RESCAN_ASK_MS) this.rescanAsk = true; else this.onRescan?.();
  };
  private rescanGo = () => { this.rescanAsk = false; this.onRescan?.(); };
  private rescanNotNow = () => {
    this.rescanAsk = false;
    // The dialog gives focus back as it closes; this makes sure of it.
    requestAnimationFrame(() => (this.querySelector('[data-action="rescan"]') as (HTMLElement & { setFocus?: () => Promise<void> }) | null)?.setFocus?.());
  };

  private rescanControl() {
    const r = this.rescan;
    if (!r) return nothing;
    return html`<calcite-button data-action="rescan" appearance="transparent" kind="neutral" scale="s" icon-start="refresh"
      label=${t('shell.review.rescanLabel', { org: this.data.org.name })} @click=${this.rescanClick}>${t('shell.review.rescan')}</calcite-button>`;
  }

  private rescanDialog() {
    if (!this.rescan) return nothing;
    return html`<calcite-dialog data-dialog="rescan" modal heading=${t('shell.review.rescanHeading', { org: this.data.org.name })} width-scale="s" .open=${this.rescanAsk}
      @calciteDialogClose=${() => { if (this.rescanAsk) this.rescanNotNow(); }}>
      <p>${t('shell.review.rescanDescription', { estimate: sayRescan(this.rescan) })}</p>
      <calcite-button slot="footer-start" data-action="rescan-cancel" appearance="transparent" kind="neutral" @click=${this.rescanNotNow}>${t('shell.review.notNow')}</calcite-button>
      <calcite-button slot="footer-end" data-action="rescan-go" icon-start="refresh" @click=${this.rescanGo}>${t('shell.review.rescan')}</calcite-button>
    </calcite-dialog>`;
  }

  private onSelect = (e: Event) => {
    const rv = e.currentTarget as HTMLElement & { filterOwner: string | null };
    queueMicrotask(() => { this.selected = rv.filterOwner; });
  };

  private onSelection = (e: CustomEvent<SelectionDetail>) => { this.selection = e.detail; setSolo(!!e.detail.solo && this.mode !== 'my-items'); };

  /** Hands the ticked items to the Emails step (in memory only) and goes there. */
  private next = () => {
    setEmailSelection({ data: this.logged, thresholds: this.thresholds, canSeeUsage: this.canSeeUsage, depsKnown: this.depsKnown, countSweeps: countSweeps(this.data.org.id), items: [...this.selection.items] });
    go(this.emailsRoute);
  };

  /** The action bar (admin only): what's ticked, and "Next: write the emails". */
  private actionBar() {
    if (this.mode !== 'admin' || this.selection.solo) return nothing;
    const s = this.selection, n = s.owners.length;
    return html`<div class="actionbar" data-bar="review" role="region" aria-label=${t('shell.review.nextStep')}>
      <div class="actionbar-sum"><b data-bar-main>${n ? tn('shell.review.ownerSummary', n, { count: formatNumber(n), services: tn('shell.review.serviceCount', s.services, { count: formatNumber(s.services) }), credits: credit(s.credits) }) : t('shell.review.noOwners')}</b>
        <span>${n ? t('shell.review.nothingSent') : t('shell.review.tickOwner')}</span></div>
      <calcite-button data-action="to-emails" icon-end="arrow-right" ?disabled=${n === 0} @click=${this.next}>${t('shell.review.nextEmails')}</calcite-button>
    </div>`;
  }

  /**
   * The owners the chart draws. DC-100b: the list comes first. When the data or the rule changes, the chart keeps what it
   * showed until the new figures are worked out, in a task of their own right after (the first time they are worked out at once).
   */
  private sankey: { data: Data; t: Thresholds; counting: boolean; owners: OwnerGroup[] } | null = null;
  private sankeyTimer = 0;
  private sankeyOwners(data: Data, counting: boolean): OwnerGroup[] {
    const s = this.sankey;
    if (s && s.data === data && s.t === this.thresholds && s.counting === counting) return s.owners;
    const work = () => ({ data, t: this.thresholds, counting, owners: evaluate(data, this.thresholds, { countSweeps: counting }).owners });
    if (!s) return (this.sankey = work()).owners;
    clearTimeout(this.sankeyTimer);
    this.sankeyTimer = window.setTimeout(() => { this.sankeyTimer = 0; this.sankey = work(); this.requestUpdate(); }, 0);
    return s.owners;
  }

  protected override render() {
    const data = this.logged;
    const counting = countSweeps(data.org.id);
    const owners = this.mode === 'my-items' ? [] : this.sankeyOwners(data, counting);
    return html`
      <section data-page="review" data-mode=${this.mode} data-deps-known=${String(this.depsKnown)}>
        <dc-review .data=${data} .org=${data.org} .countSweeps=${counting} .since=${this.since(data, counting)}
          @dc-count-sweeps=${(e: CustomEvent<boolean>) => setCountSweeps(data.org.id, e.detail)} .mode=${this.mode} .depsKnown=${this.depsKnown} .stopped=${this.stopped} .canSeeUsage=${this.canSeeUsage} .memberUsername=${this.username} .adminUsername=${this.mode === 'my-items' ? '' : this.username}
          @dc-thresholds-change=${(e: CustomEvent<Thresholds>) => { this.thresholds = e.detail; }}
          @dc-owner-select=${this.onSelect} @dc-selection-change=${this.onSelection}>
          ${this.mode === 'my-items' ? nothing : html`<dc-sankey slot="chart" .owners=${owners} .selected=${this.selected}></dc-sankey>`}
          <!-- DC-090: always rendered (dc-review moves it into its page head, so it must not come and go) -->
          <div slot="context" class="rescan-ctx">
            <p data-note="cache" role="status" ?hidden=${!this.note}>${this.note}${this.note && this.refreshing ? (this.depsKnown ? t('shell.review.refreshing', { note: this.note }) : t('shell.review.checkingDependencies', { note: this.note })) : ''}</p>
            ${this.rescanControl()}
          </div>
        </dc-review>
        <dc-broken-refs .refs=${visibleBrokenRefs(data, { depsComplete: this.depsKnown && !this.stopped, mode: this.mode })} .org=${data.org} .owners=${data.owners}></dc-broken-refs>
        ${this.rescanDialog()}
        ${this.actionBar()}
      </section>`;
  }
}

export function renderReview(p: ReviewProps) {
  return html`<app-review .data=${p.data} .mode=${p.mode} .canSeeUsage=${p.canSeeUsage} .username=${p.username ?? ''} .note=${p.note ?? ''} .refreshing=${!!p.refreshing} .depsKnown=${p.depsKnown ?? true} .stopped=${!!p.stopped} .emailsRoute=${p.emailsRoute ?? 'emails'} .rescan=${p.rescan ?? null} .onRescan=${p.onRescan}></app-review>`;
}
