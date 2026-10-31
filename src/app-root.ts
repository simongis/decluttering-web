import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import type { Data } from './domain/types';
import { parseRoute, go, homeRoute, hrefOf, type Route } from './routes/router';
import { renderReview, isSolo, onSoloChange } from './routes/review-host';
import { DEMO_ADMIN } from './routes/emails-host';
import { readSeededLog, setNudgeLog } from './log';
import type { DemoOrg } from './demo/demo-org';
import type { CacheEntry } from './cache/scanCache';
import { canRescan, rescanClock } from './cache/rescan';
import { rescanEstimate } from './ui/scan/estimate';
import { loadCached, runScan, type ScanTap } from './routes/scan-run';
import type { ScanStages } from './scan/types';
import { INITIAL_FLOW, nextFlow, type Flow, type FlowEvent } from './ui/scan/scan-flow';
import { APP_TITLE, createEtaSmoother, currentLine, tabTitle, usageIn } from './ui/scan/stages-view';
import { notifyDone, type NotifyChoice } from './ui/scan/notify-done';
import { buildDots, type DotModel, type EarlyUsage, type FoundItem } from './ui/scan/dots';
import './ui/scan/dc-scan-screen';
import { beginSignIn, fetchUserThumbnail, handleRedirect, isOAuthReturn, loadAccess, loadSession, signOut, takeReturnTo, type AccessInfo } from './auth/session';
import { canSeeUsage } from './auth/access';
import { oauthMessageFor, parseOAuthError } from './auth/oauth-error';
import { CLIENT_ID } from './auth/config';
import type { RequestFn } from './scan/types';
import { mergeUsageWindow } from './scan/pipeline';
import { countSweeps, onCountSweepsChange, setCountSweeps } from './cache/settings';
import { currentSkin, onSkinChange, setSkin, SKIN_COPY } from './ui/skin/skin';
import { DELTA_ICON, SUN_ICON } from './ui/skin/icons';
import '@esri/calcite-components/dist/components/calcite-navigation-user';
import '@esri/calcite-components/dist/components/calcite-avatar';
import '@esri/calcite-components/dist/components/calcite-select';
import '@esri/calcite-components/dist/components/calcite-option';
import { LOCALES, LOCALE_NAMES, applyProfileLocale, getLocale, isLocale, setLocale, t, tn } from './i18n';
import '@esri/calcite-components/dist/components/calcite-link';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import { LocaleController } from './i18n/controller';
import '@esri/calcite-components/dist/components/calcite-popover';
import './ui/about';
import './ui/access/dc-access-checklist';
import './ui/emails/dc-turn-on-sending';
import './ui/access/dc-turn-off-sending';
import '@esri/calcite-components/dist/components/calcite-alert';
import { TURN_OFF, turnOffSending } from './ui/access/turn-off';
import './ui/steps/dc-steps';
import { stepsFor, type StepId } from './ui/steps/steps';
import { createSessionNotifier, WritesDisabled, type GroupNotifier } from './notify';
import { createSessionNudgeLog, type NudgeLog } from './log';
import { PORTAL_URL } from './auth/config';
import { autoStartReviewTour, closeReviewTour, openReviewTour } from './ui/tour';

/**
 * Dot map updates are coalesced: found pages and sizes can arrive many times a second. The first page draws at once,
 * then the map redraws at most this often (DC-071b, FB-21: a calm cadence, each redraw a gentle settle).
 */
const DOTS_MS = 1000;

/** DC-098: the demo's user in the header menu. */
const DEMO_USER = { fullName: 'Demo admin', username: 'demo_admin' };

/** DC-116: the quick demo (opens straight on Review, no scan): `?fast=1` in the address, or `window.__DC_DEMO_FAST__` (a test hook). */
function demoFast(): boolean {
  try { if (new URLSearchParams(window.location.search).get('fast') === '1') return true; } catch { /* no query */ }
  return (window as unknown as { __DC_DEMO_FAST__?: boolean }).__DC_DEMO_FAST__ === true;
}

/** App shell: landing, demo, the signed-in scan screen, the review screen and the sign-in error page. */
@customElement('app-root')
export class AppRoot extends LitElement {
  private readonly _locale = new LocaleController(this);
  @state() private route: Route = parseRoute(window.location.hash);
  /** DC-135: the console look is on (the header then offers the way back). */
  @state() private consoleSkin = currentSkin() === 'console';
  private offSkin: (() => void) | null = null;
  /** DC-110 (FB-70): the route we came from when About opened, so About can offer a Back link. */
  private beforeAbout: Route | null = null;
  @state() private demoData: Data | null = null;
  @state() private orgName = '';
  @state() private error = '';
  @state() private access: AccessInfo | null = null;
  @state() private signInError = '';
  private oauthErrorForLocale: { error: string; description: string } | null = null;
  @state() private busy = false;
  /**
   * DC-088 (FB-37): set before the first paint when this load returns from ArcGIS sign-in, or restores a session on the
   * landing page. While true the shell shows "Signing you in…" instead of the landing page, until the app or the error
   * page takes over. A plain signed-out visit starts false, so the landing page shows at once.
   */
  @state() private signingIn = isOAuthReturn() || (parseRoute(window.location.hash) === 'landing' && loadSession() !== null);
  /** DC-098: the signed-in user's profile picture as a `blob:` URL (fetched with the token in a header), revoked on sign out. */
  @state() private thumbUrl = '';
  /** DC-098: the account menu is open (the avatar shows as active). */
  @state() private userOpen = false;
  /** DC-111: the access checklist card on the scan screen (once per sign-in) and its dialog from the user menu. */
  @state() private accessCard = false;
  @state() private accessOpen = false;
  /** ADR 0013: this admin has turned sending on (their own app group exists). Read when the checklist is shown. */
  @state() private sendingOn = false;
  @state() private turnOnOpen = false;
  @state() private turnOnBusy = false;
  @state() private turnOnError = '';
  @state() private turnOnErrorKey: 'missingPrivilege' | 'turnOnFailed' | null = null;
  private turnOnPrivilege = '';
  private get turnOnErrorText(): string {
    if (this.turnOnErrorKey === 'missingPrivilege') return t('shell.error.missingPrivilege', { privilege: this.turnOnPrivilege });
    if (this.turnOnErrorKey === 'turnOnFailed') return t('shell.error.turnOnFailed');
    return this.turnOnError;
  }
  @state() private turnOffOpen = false;
  @state() private turnOffBusy = false;
  @state() private turnOffError = '';
  @state() private offToast = false;
  /** DC-098: phones (600 px or less) show the avatar only. */
  private narrowQuery = window.matchMedia('(max-width: 600px)');
  @state() private narrow = this.narrowQuery.matches;
  private onNarrow = () => { this.narrow = this.narrowQuery.matches; };
  /** DC-098: once the review has been shown it stays mounted (hidden) on the scan screen, so its ticks survive a trip there and back. */
  private reviewMounted = false;
  @state() private data: Data | null = null;
  @state() private note = '';
  private noteKind: 'partial' | 'fresh' | null = null;
  private noteRefreshFailed = false;
  private get noteText(): string {
    const base = this.noteKind === 'partial' ? t('shell.scan.partialRefresh') : this.noteKind === 'fresh' ? t('shell.scan.freshlyScanned') : this.note;
    return this.noteRefreshFailed ? t('shell.scan.refreshFailed', { note: base }) : base;
  }
  @state() private refreshing = false;
  @state() private depsKnown = true;
  @state() private scanError = '';
  private scanErrorStopped = false;
  private get scanErrorText(): string { return this.scanErrorStopped ? t('shell.scan.stoppedError') : this.scanError; }
  /** DC-064: scanning -> background (core in) -> done | stopped | error, and which screen shows (scan-flow.ts). */
  @state() private flow: Flow = INITIAL_FLOW;
  /** DC-071b: the scan's three-stage progress (DC-071a), for the current line, the bar and the stage list. */
  @state() private stages: ScanStages | null = null;
  @state() private dots: DotModel = buildDots({ found: [], sized: new Map(), data: null, depsKnown: false });
  /** A smoothed finish estimate, shown only once it is stable; null hides it. */
  @state() private eta: { ms: number; text: string } | null = null;
  /** "Tell me when it's done" (DC-071b): how we'll tell them. */
  @state() private notify: NotifyChoice = 'off';
  private manager: ArcGISIdentityManager | null = null;
  /** DC-074 (dev only): the simulated org's request function; set by `#/simulate`, never in a production build. */
  private simulated: RequestFn | null = null;
  /** DC-094 (dev only): `#/probe-usage` shows the read-only usage probe (src/dev/usage-probe.ts) instead of the app. */
  @state() private probe = false;
  private scanning = false;
  private abort: AbortController | null = null;
  private demoRequested = false;
  /**
   * DC-116 (FB-75): the demo plays the real scan against a made-up org of 437 services (src/demo/, a lazy chunk). Null in
   * the quick demo (`?fast=1`, or `window.__DC_DEMO_FAST__`, which the e2e specs that only need the Review page set): that one
   * loads public/demo/mock-small.json and opens straight on Review.
   */
  private demoOrg: DemoOrg | null = null;
  /** The demo is playing the scan (set at once, before the chunk has loaded). */
  private demoPlay = false;
  /** "Skip to results" was chosen: finish the scan quickly and open Review. */
  private demoSkipping = false;
  private found: FoundItem[] = [];
  private sized = new Map<string, number>();
  private attached = new Map<string, number>();
  /** DC-071c: usage as its windows land (service name to day to count), and the latest window's end; the map uses it once every window is in. */
  private usageByName = new Map<string, Map<number, number>>();
  private usageEnd = 0;
  private usageComplete = false;
  private dotsTimer = 0;
  private dotsAt = 0;

  /** DC-086: this org's "Count days when everything was touched at once". */
  private get countingSweeps(): boolean { return countSweeps(this.access?.orgId ?? this.data?.org.id); }
  /** DC-086: the setting changed (on the review or the finish line): redraw the dot map with it. */
  private onSweepsSetting = () => {
    this.refreshDots();
  };
  private offSweeps: (() => void) | null = null;
  /** DC-109: owners ticked on Review (from its selection event), for the step indicator's Emails step; and the solo listener. */
  @state() private ticked = 0;
  private offSolo: (() => void) | null = null;

  /** The core is done and sizes or maps and apps are still being read: Stop now keeps what is known (DC-053). */
  private get background(): boolean { return this.flow.state === 'background'; }
  /** The last scan was stopped after the core: the review shows what was known, with a Resume link. */
  private get stopped(): boolean { return this.flow.state === 'stopped'; }

  /** Moves the flow on, and follows it to the review or back to the scan screen. */
  private step(e: FlowEvent): void {
    const was = this.flow;
    this.flow = nextFlow(was, e);
    // The demo stays on its own route: the flow alone moves it between the scan and the review.
    if (this.demoOrg) return;
    // After sign-out (which stops the scan) the landing page stays put.
    if (!this.manager) return;
    if (this.flow.view !== was.view || e.type === 'start') go(this.flow.view === 'review' ? 'review' : 'app');
  }

  /** Usage for the early dot map: only once every usage window has landed, so last used never reads older than it is. */
  private earlyUsage(): EarlyUsage | null {
    return this.usageComplete && this.usageEnd ? { end: this.usageEnd, byName: this.usageByName } : null;
  }

  /**
   * DC-100c: the scan screen is not mounted while Review (or Emails) shows, yet the map was rebuilt every second (two scoring
   * passes over every family: ~75 ms at 1x, ~300 ms at 4x, on the main thread Review needs). While hidden we only note that the map is
   * behind; it is rebuilt once, in willUpdate, the moment the scan screen is back.
   */
  private dotsBehind = false;
  private get scanShown(): boolean {
    if (this.demoOrg) return this.route === 'demo' && (this.flow.view === 'scan' || !this.data);
    return !(this.route === 'review' || this.route === 'emails') || !this.data;
  }
  private refreshDots(): void {
    if (!this.scanShown) { this.dotsBehind = true; return; }
    this.dotsBehind = false;
    this.dots = buildDots({ found: this.found, sized: this.sized, attached: this.attached, data: this.data, depsKnown: this.depsKnown, usage: this.earlyUsage(), countSweeps: this.countingSweeps });
  }

  private scheduleDots(): void {
    if (this.dotsTimer) return;
    const wait = DOTS_MS - (performance.now() - this.dotsAt);
    this.dotsTimer = window.setTimeout(() => {
      this.dotsTimer = 0; this.dotsAt = performance.now();
      this.refreshDots();
    }, Math.max(16, wait));
  }

  /** Sets the route now (not on the later hashchange), so no frame paints the old route in between. */
  private navigate(route: Route): void {
    if (route === 'about' && this.route !== 'about') this.beforeAbout = this.route;
    this.route = route;
    go(route);
  }

  // Light DOM, so global Calcite and token styles apply.
  protected override createRenderRoot(): HTMLElement { return this; }

  private onHash = () => {
    const next = parseRoute(window.location.hash);
    if (next === 'about' && this.route !== 'about') this.beforeAbout = this.route;
    this.route = next;
    // The browser's back and forward buttons move between the scan and the review too.
    if (this.route === 'app' && this.flow.view === 'review') this.flow = nextFlow(this.flow, { type: 'scan' });
    else if (this.route === 'review' && this.flow.view === 'scan' && this.data) this.flow = nextFlow(this.flow, { type: 'review' });
    void this.ensureDemo();
  };

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHash);
    this.narrowQuery.addEventListener('change', this.onNarrow);
    this.offSweeps = onCountSweepsChange(this.onSweepsSetting);
    this.offSolo = onSoloChange(() => this.requestUpdate());
    this.offSkin = onSkinChange(() => { this.consoleSkin = currentSkin() === 'console'; });
    void this.ensureDemo();
    if (import.meta.env.DEV && await this.maybeSimulate()) { this.signingIn = false; return; }
    if (import.meta.env.DEV && /^#\/probe-usage\/?$/.test(window.location.hash)) { await (await import('./dev/usage-probe')).defineUsageProbe(); this.probe = true; this.signingIn = false; return; }
    const oauthQueryError = parseOAuthError(window.location.search);
    const ret = await handleRedirect();
    // The demo's scan owns the page: a saved sign-in elsewhere must not start a real scan beside it.
    if (this.demoPlay && ret.kind === 'none') { this.signingIn = false; return; }
    // A page elsewhere on this origin asked to come back after sign-in: go there and start nothing here.
    const back = ret.kind === 'none' ? null : takeReturnTo();
    if (ret.kind === 'signed-in' && back) { window.location.replace(back); return; }
    if (ret.kind === 'error') { this.oauthErrorForLocale = oauthQueryError; this.signInError = ret.message; this.navigate('error'); this.signingIn = false; return; }
    const manager = ret.kind === 'signed-in' ? ret.manager : loadSession();
    if (!manager) {
      this.signingIn = false;
      if (this.route === 'app' || this.route === 'review' || this.route === 'emails') this.navigate('landing');
      return;
    }
    this.manager = manager;
    this.busy = true;
    try {
      this.access = await loadAccess(manager);
      await applyProfileLocale(this.access.culture, this.access.orgCulture);
      this.orgName = this.access.orgName;
      this.accessCard = true;
      void this.refreshSendingOn();
      void this.loadThumbnail(manager, this.access);
      if (ret.kind === 'signed-in' || this.route === 'landing') this.navigate('app');
      else if (this.route === 'review' || this.route === 'emails') this.navigate('app');
    } catch (e) {
      this.signInError = e instanceof Error ? e.message : String(e);
      this.navigate('error');
      return;
    } finally {
      this.busy = false;
      this.signingIn = false;
    }
    void this.startScan();
  }

  /** Dev only: `#/simulate?n=7000&speed=1` runs the real scan against a simulated org (src/dev/). Returns true when it took over. */
  private async maybeSimulate(): Promise<boolean> {
    if (!import.meta.env.DEV) return false;
    const sim = await import('./dev/simulate');
    const params = sim.parseSimulate(window.location.hash);
    if (!params) return false;
    const { org, access } = sim.startSimulation(params);
    this.simulated = org.request;
    this.manager = {} as ArcGISIdentityManager; // never used: the simulated request answers every call
    this.access = access;
    this.orgName = access.orgName;
    this.accessCard = true;
    void this.startScan();
    return true;
  }

  override disconnectedCallback(): void {
    clearTimeout(this.tourTimer);
    window.removeEventListener('hashchange', this.onHash);
    this.narrowQuery.removeEventListener('change', this.onNarrow);
    if (this.thumbUrl) URL.revokeObjectURL(this.thumbUrl);
    clearTimeout(this.dotsTimer);
    this.offSweeps?.(); this.offSweeps = null;
    this.offSolo?.(); this.offSolo = null;
    this.offSkin?.(); this.offSkin = null;
    super.disconnectedCallback();
  }

  private onLang = (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    if (isLocale(v)) void setLocale(v);
  };

  /**
   * ADR 0015: the language lives in the account menu, not the header (most people never change it). Each name is written in its
   * own language and marked with its lang; no flags. Hidden when there is only one language.
   */
  private renderLangRow() {
    if (LOCALES.length < 2) return nothing;
    return html`<div class="dc-user-lang">
      <span class="dc-user-lang-label" id="dc-lang-label">${t('lang.label')}</span>
      <calcite-segmented-control data-action="language" scale="s" width="full" aria-labelledby="dc-lang-label" label=${t('lang.label')}
        @calciteSegmentedControlChange=${this.onLang}>
        ${LOCALES.map((l) => html`<calcite-segmented-control-item value=${l} lang=${l} ?checked=${l === getLocale()}>${LOCALE_NAMES[l]}</calcite-segmented-control-item>`)}
      </calcite-segmented-control>
    </div>`;
  }

  /**
   * DC-113 (FB-69): the short first-visit tour of Review (lazy chunk, src/ui/tour/). It opens by itself once, only while Review is on
   * screen (not on the scan screen, and never in the quick demo), and "Show me around" in the user menu opens it again.
   */
  private tourTimer = 0;
  private tourDone = false;
  private tourOpen = false;
  private reviewOnScreen(): boolean {
    if (this.signingIn || this.probe) return false;
    if (this.route === 'review') return !!this.access && !!this.data && !this.busy;
    if (this.route === 'demo') return this.demoOrg ? !!this.data && this.flow.view === 'review' : !!this.demoData;
    return false;
  }
  private tourEnded = () => { this.tourOpen = false; };
  private tourCheck(tries = 0): void {
    if (!this.reviewOnScreen()) {
      clearTimeout(this.tourTimer); this.tourTimer = 0;
      if (this.tourOpen) { this.tourOpen = false; void closeReviewTour(); }
      return;
    }
    if (this.tourDone || this.tourOpen || (this.tourTimer && tries === 0)) return;
    // Give the chart and the list a moment to draw before looking for them.
    this.tourTimer = window.setTimeout(async () => {
      this.tourTimer = 0;
      if (!this.reviewOnScreen()) return;
      const fast = demoFast() || (this.route === 'demo' && !this.demoOrg);
      const myItems = this.querySelector('[data-page="review"]')?.getAttribute('data-mode') === 'my-items';
      const how = await autoStartReviewTour({ fast, myItems, solo: isSolo(), onEnd: this.tourEnded });
      if (how === 'open') { this.tourOpen = true; this.tourDone = true; }
      else if (how === 'skip') this.tourDone = true;
      else if (tries < 8) this.tourCheck(tries + 1);
    }, tries === 0 ? 900 : 700);
  }
  protected override updated(): void {
    this.tourCheck();
    if (this.scanTitle) document.title = t(this.scanTitle === 'stopped' ? 'shell.scan.titleStopped' : 'shell.scan.titleDone', { title: APP_TITLE });
  }
  private showMeAround = () => {
    this.userOpen = false;
    window.setTimeout(async () => { if (await openReviewTour({ solo: isSolo(), onEnd: this.tourEnded })) { this.tourOpen = true; this.tourDone = true; } }, 200);
  };

  private async ensureDemo(): Promise<void> {
    if ((this.route !== 'demo' && this.route !== 'demo-emails') || this.demoRequested) return;
    this.demoRequested = true;
    if (!demoFast()) { this.demoPlay = true; await this.startDemoScan(); return; }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}demo/mock-small.json`);
      if (!res.ok) throw new Error(t('shell.demo.dataFailed', { status: res.status }));
      const data = (await res.json()) as Data;
      this.orgName = data.org.name;
      this.demoData = data;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** DC-116: loads the made-up org (its own chunk) and starts the real scan against it. No sign-in, no network, no cache. */
  private async startDemoScan(): Promise<void> {
    try {
      const { createDemoOrg } = await import('./demo/demo-org');
      const demo = createDemoOrg();
      this.demoOrg = demo;
      this.orgName = demo.access.orgName;
      // Past sends for "Since your nudges", read through the real log code over an in-memory fake. Set before the review is shown.
      setNudgeLog(demo.access.orgId, await readSeededLog({ self: demo.access.username, orgId: demo.access.orgId, rows: demo.nudgeRows() }));
      this.signingIn = false;
      void this.startScan();
    } catch (e) {
      this.demoPlay = false;
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** DC-116: "Skip to results": every waiting call is answered now, the scan finishes in a moment and Review opens. */
  private skipDemo = (): void => {
    if (!this.demoOrg) return;
    this.demoSkipping = true;
    this.demoOrg.org.rush();
  };

  /** The last scan's result as a cache entry, kept so Resume (DC-102) picks up where a stopped scan left off without re-reading. */
  private lastEntry: CacheEntry | null = null;
  /** DC-105: when the results on screen were saved, and whether the last background refresh failed (the two things Rescan's show rule needs). */
  private scanTitle: 'done' | 'stopped' | null = null;
  @state() private savedAt = '';
  @state() private refreshFailed = false;

  /** DC-105 (FB-62): Rescan on Review, only when a fresh scan would tell the admin something new; with the time it will take. */
  private get rescanOffer(): { ms: number; measured: boolean } | null {
    if (!this.data) return null;
    const ok = canRescan({
      running: this.flow.state === 'scanning' || this.flow.state === 'background', stopped: this.stopped, demo: false,
      simulated: !!this.simulated, savedAt: rescanClock(this.lastEntry, this.savedAt), refreshFailed: this.refreshFailed, now: new Date(),
    });
    return ok ? rescanEstimate(this.data.services.length, this.lastEntry?.fullScan) : null;
  }

  /** DC-105: a full scan that ignores the cache (every layer, map and app is read again). The review and its ticks stay put. */
  private rescan = (): void => {
    if (this.scanning) return;
    void this.startScan('rescan');
  };

  /** DC-102: continue a stopped scan in this session: the scan screen, the same results, only what is missing is read. */
  private resumeScan = (): void => {
    if (this.scanning) return;
    this.flow = nextFlow(this.flow, { type: 'scan' });
    if (this.route !== 'app') this.navigate('app');
    void this.startScan('resume');
  };

  /**
   * Cached results first (shown at once, the fast path), then a read-only scan in the background (ADR 0009).
   * Without a cache, people stay on the scan screen until they choose "Review now" (DC-064); maps and apps carry on.
   */
  private async startScan(kind: 'first' | 'resume' | 'rescan' = 'first'): Promise<void> {
    const demo = this.demoOrg;
    const manager = demo ? ({} as ArcGISIdentityManager) : this.manager, access = demo ? demo.access : this.access; // the demo's stand-in is never used: its request answers every call
    if (this.scanning || !manager || !access) return;
    const resume = kind === 'resume', rescan = kind === 'rescan' && !!this.data;
    const fake = !!this.simulated || !!demo;
    this.scanning = true;
    this.scanError = '';
    this.scanErrorStopped = false;
    this.scanTitle = null;
    this.stages = null;
    this.refreshFailed = false;
    // A rescan keeps the last result's full-scan time (for the estimate) until its own scan replaces it.
    if (!resume && !rescan) this.lastEntry = null;
    this.found = []; this.sized = new Map(); this.attached = new Map(); this.dotsAt = 0;
    this.usageByName = new Map(); this.usageEnd = 0; this.usageComplete = false;
    this.eta = null;
    this.notify = 'off';
    document.title = APP_TITLE;
    const smoother = createEtaSmoother();
    let coreIn = false;
    const ctl = (this.abort = new AbortController());
    const t0 = performance.now();
    const cached = fake || resume || rescan ? undefined : await loadCached(access);
    // Resume keeps the results on screen (and the review's ticks) and passes the stopped result back, so finished work isn't read again.
    const previous = rescan ? undefined : resume ? this.lastEntry ?? (fake ? undefined : (await loadCached(access))?.entry) : cached?.entry;
    // Cached links are from the last scan and refresh in the background; a stopped scan's links are not all checked.
    const cachedDeps = !!cached && !cached.entry.incomplete?.deps;
    if (cached) {
      this.data = cached.entry.data;
      this.note = cached.note;
      this.noteKind = null;
      this.noteRefreshFailed = false;
      this.savedAt = cached.entry.savedAt;
      this.lastEntry = cached.entry;
      this.refreshing = true;
      this.depsKnown = cachedDeps;
    } else if (rescan) {
      // The results stay on screen while everything is read again.
      this.refreshing = true;
      this.depsKnown = false;
    } else if (!resume || !this.data) {
      this.data = null;
      this.depsKnown = false;
    } else {
      this.depsKnown = false;
    }
    this.dots = buildDots({ found: [], sized: this.sized, data: this.data, depsKnown: this.depsKnown, countSweeps: this.countingSweeps });
    this.step({ type: 'start', cached: !!cached || rescan });
    try {
      const out = await runScan(manager, access, {
        signal: ctl.signal, previous, request: demo ? demo.org.request : this.simulated ?? undefined,
        onStages: (s: ScanStages) => {
          this.stages = s;
          if (!this.usageComplete && usageIn(s) && this.usageEnd) { this.usageComplete = true; this.scheduleDots(); }
          this.eta = smoother.add(s);
          document.title = tabTitle(s);
        },
        onTap: (e: ScanTap) => {
          if (e.kind === 'found') { this.found = [...this.found, ...e.items]; this.scheduleDots(); }
          else if (e.kind === 'sized') { this.sized.set(e.id, e.sizeMB); if (e.attachmentMB) this.attached.set(e.id, e.attachmentMB); this.scheduleDots(); }
          else if (e.kind === 'usage') {
            this.usageEnd = Math.max(this.usageEnd, e.endTime);
            mergeUsageWindow(this.usageByName, e.rows); // FB-29: same-name rows add up, never overwrite
          }
        },
        onData: (data, state) => {
          this.data = data;
          this.depsKnown = state.depsKnown || cachedDeps;
          this.scheduleDots();
          if (!coreIn) {
            coreIn = true;
            this.step({ type: 'core' });
            // Handy for the manual real-run check; counts and timings only.
            (window as unknown as { __scanCore?: unknown }).__scanCore = { reviewMs: Math.round(performance.now() - t0), unmeasured: state.unmeasured };
          }
        },
      });
      this.lastEntry = out.entry;
      this.savedAt = out.entry.savedAt;
      this.data = out.data;
      this.depsKnown = out.depsComplete;
      this.scanTitle = out.stopped ? 'stopped' : 'done';
      document.title = out.stopped ? t('shell.scan.titleStopped', { title: APP_TITLE }) : t('shell.scan.titleDone', { title: APP_TITLE });
      if (!out.stopped) notifyDone(this.notify, { hidden: document.hidden, body: t('shell.scan.finishedNotice') });
      this.noteKind = cached || rescan ? (out.stopped ? 'partial' : 'fresh') : null;
      this.noteRefreshFailed = false;
      this.note = this.noteKind ? t(this.noteKind === 'partial' ? 'shell.scan.partialRefresh' : 'shell.scan.freshlyScanned') : '';
      this.refreshDots();
      this.step({ type: 'finished', stopped: out.stopped });
      if (this.demoSkipping && !out.stopped) this.step({ type: 'review' });
      // Handy for the manual real-run check; contains counts and timings only.
      (window as unknown as { __scan?: unknown }).__scan = {
        timings: out.timings, coreMs: out.coreMs, sizesMs: out.sizesMs, stopped: out.stopped, unmeasured: out.unmeasured, depsComplete: out.depsComplete,
        warnings: out.warnings, services: out.data.services.length, owners: out.data.owners.length,
        totalMs: Math.round(performance.now() - t0),
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') { this.scanErrorStopped = true; this.scanError = t('shell.scan.stoppedError'); }
      else if (cached || rescan) { this.noteRefreshFailed = true; this.refreshFailed = true; }
      else this.scanError = e instanceof Error ? e.message : String(e);
      this.step({ type: 'failed' });
    } finally {
      this.eta = null;
      this.demoSkipping = false;
      this.refreshing = false;
      this.scanning = false;
      this.abort = null;
    }
  }

  /** Stop: before the core it cancels the scan; after it, it ends the background work and keeps what is known (DC-053). */
  private stopButton() {
    const label = this.background ? t('shell.scan.stopAndReview') : t('shell.scan.stopScanning');
    return html`<calcite-button data-action="stop" class="stop" appearance="outline" kind="brand" icon-start="stop-square-f" @click=${() => this.abort?.abort()}>${label}</calcite-button>`;
  }

  /** On the review while sizes or maps and apps are still being read (with percent and estimate, DC-064), and after a stop. */
  private renderScanStatus() {
    if (this.background) {
      if (this.stages?.finished) return nothing;
      const text = currentLine(this.stages);
      return html`<div data-scan="background" style="display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin-bottom: 0.75rem">
        <span class="dc-sr" role="status">${t('shell.scan.checkingBackground')}</span>
        <span>${text}</span>
        <span class="scan-meta" data-scan="meta">${t('shell.scan.percentDone', { percent: this.stages?.percent ?? 0 })}${this.eta ? ` · ${this.eta.text}` : ''}</span>
        ${this.stopButton()}
        <calcite-button data-action="to-scan" appearance="transparent" kind="brand" icon-start="arrow-left" @click=${() => this.step({ type: 'scan' })}>${t('shell.scan.backToScan')}</calcite-button></div>`;
    }
    if (this.stopped) {
      return html`<div data-note="stopped" role="status" style="display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin-bottom: 0.75rem">
        <span>${t('shell.scan.stoppedEarly')}</span>
        <calcite-button data-action="resume-link" appearance="transparent" kind="brand" icon-start="play" label=${t('shell.scan.resumeLabel', { percent: this.stages?.percent ?? 0 })} @click=${this.resumeScan}>${t('shell.scan.stoppedResume', { percent: this.stages?.percent ?? 0 })}</calcite-button></div>`;
    }
    return nothing;
  }

  /** DC-098: the profile picture, if the user has one; initials otherwise (calcite-avatar). Dropped if they signed out meanwhile. */
  private async loadThumbnail(manager: ArcGISIdentityManager, a: AccessInfo): Promise<void> {
    const url = await fetchUserThumbnail(manager, a);
    if (!url) return;
    if (this.manager !== manager) { URL.revokeObjectURL(url); return; }
    this.thumbUrl = url;
  }

  private async doSignOut(clearData: boolean): Promise<void> {
    this.abort?.abort();
    this.data = null;
    this.lastEntry = null;
    const manager = this.simulated ? null : this.manager; // the simulator's stand-in has no tokens
    this.manager = null;
    await signOut({ clearData }, manager);
    this.access = null;
    this.orgName = '';
    if (this.thumbUrl) URL.revokeObjectURL(this.thumbUrl);
    this.thumbUrl = '';
    this.userOpen = false;
    this.accessCard = this.accessOpen = false;
    this.sendingOn = this.turnOnOpen = this.turnOnBusy = false;
    this.turnOnError = '';
    this.turnOffOpen = this.turnOffBusy = this.offToast = false;
    this.turnOffError = '';
    this.reviewMounted = false;
    this.scanTitle = null;
    document.title = APP_TITLE;
    this.navigate('landing');
  }

  private get signedIn(): boolean { return !!this.manager && !!this.access; }
  private get inDemo(): boolean { return this.route === 'demo' || this.route === 'demo-emails'; }

  /**
   * DC-098 (FB-54): the logo goes to the first stage. Signed in, that is the scan screen showing the finished scan: no
   * new scan starts, and the review stays mounted (hidden) so its ticks are still there on the way back.
   */
  private goHome = (e: Event) => {
    e.preventDefault();
    const to = homeRoute(this.route, this.signedIn);
    if (to === 'app' && this.flow.view === 'review') this.flow = nextFlow(this.flow, { type: 'scan' });
    this.navigate(to);
  };

  /**
   * DC-098 (FB-55): who is signed in, the Calcite way: calcite-navigation-user (avatar only on phones) opening a popover
   * with the name, username and org, then the two sign-out choices. The demo shows a demo user with "Leave the demo".
   */
  private renderUser() {
    const demo = this.inDemo;
    const a = this.access;
    if (!demo && (!a || this.signingIn)) return nothing;
    const fullName = demo || !a ? DEMO_USER.fullName : a.fullName || a.username;
    const username = demo || !a ? DEMO_USER.username : a.username;
    const org = demo || !a ? this.demoData?.org.name ?? this.demoOrg?.access.orgName ?? '' : a.orgName;
    const thumb = demo ? '' : this.thumbUrl;
    return html`
      <div slot="user" class="dc-user">
        <calcite-navigation-user id="dc-user" data-user=${demo ? 'demo' : 'signed-in'} full-name=${fullName} username=${username}
          .thumbnail=${thumb} ?text-disabled=${this.narrow} ?active=${this.userOpen} label=${t('shell.account.menuLabel', { name: fullName })}></calcite-navigation-user>
        <calcite-popover reference-element="dc-user" label=${t('shell.account.popoverLabel')} placement="bottom-end" overlay-positioning="fixed" auto-close
          @calcitePopoverOpen=${() => { this.userOpen = true; }} @calcitePopoverClose=${() => { this.userOpen = false; }}>
          <div class="dc-user-menu" data-menu="user">
            <div class="dc-user-who">
              <calcite-avatar scale="l" full-name=${fullName} username=${username} .thumbnail=${thumb} label=${fullName}></calcite-avatar>
              <div>
                <p class="dc-user-name" data-user-name>${fullName}</p>
                <p class="dc-user-handle">${username}</p>
                ${org ? html`<p class="dc-user-org" data-user-org>${org}</p>` : nothing}
              </div>
            </div>
            ${this.renderLangRow()}
            <div class="dc-user-actions">
              ${this.reviewOnScreen() ? html`<calcite-button data-action="show-tour" width="full" appearance="transparent" icon-start="lightbulb" @click=${this.showMeAround}>${t('shell.account.showTour')}</calcite-button>` : nothing}
              ${demo ? html`
                <calcite-button data-action="leave-demo" width="full" appearance="outline" icon-start="sign-out" @click=${() => { this.userOpen = false; this.navigate('landing'); }}>${t('shell.account.leaveDemo')}</calcite-button>`
              : html`
                <calcite-button data-action="access-open" width="full" appearance="transparent" icon-start="question" @click=${() => { this.userOpen = false; this.accessOpen = true; void this.refreshSendingOn(); }}>${t('shell.account.accessQuestion')}</calcite-button>
                <calcite-button data-action="sign-out-keep" width="full" appearance="outline" icon-start="sign-out" @click=${() => this.doSignOut(false)}>${t('shell.account.signOut')}</calcite-button>
                <calcite-button data-action="sign-out-clear" width="full" appearance="transparent" icon-start="trash" @click=${() => this.doSignOut(true)}>${t('shell.account.signOutClear')}</calcite-button>
                <p class="dc-user-hint">${t('shell.account.clearDataHint')}</p>`}
            </div>
          </div>
        </calcite-popover>
      </div>`;
  }

  private renderLanding() {
    return html`
      <section data-page="landing">
        <h1>${t('shell.landing.title')}</h1>
        <p>${t('shell.landing.description')}</p>
        <p style="display: flex; gap: 0.75rem">
          <calcite-button data-action="sign-in" ?disabled=${!CLIENT_ID} @click=${() => beginSignIn()}>${t('shell.landing.signIn')}</calcite-button>
          <calcite-button data-action="demo" appearance="outline" @click=${() => go('demo')}>${t('shell.landing.tryDemo')}</calcite-button>
        </p>
        ${CLIENT_ID ? nothing : html`<p role="note" data-note="no-client-id">${t('shell.landing.noClientId')}</p>`}
        ${LOCALES.length > 1 ? html`<p class="dc-landing-lang" data-action="landing-language">${LOCALES.filter((l) => l !== getLocale()).map((l) =>
          html`<calcite-link lang=${l} data-locale=${l} @click=${() => void setLocale(l)}>${LOCALE_NAMES[l]}</calcite-link>`)}</p>` : nothing}
      </section>`;
  }

  /** The demo review, and its Emails step (DC-019). The review stays mounted (hidden) so its ticks survive. */
  private renderDemo(emails = false) {
    if (this.demoOrg) return this.renderDemoPlay(emails);
    const d = this.demoData;
    return html`
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      <div ?hidden=${emails}>${d ? renderReview({ data: d, mode: 'admin', canSeeUsage: true, emailsRoute: 'demo-emails' }) : nothing}</div>
      ${emails && d ? html`<app-emails demo .admin=${DEMO_ADMIN} orgId=${d.org.id} orgName=${d.org.name} writable></app-emails>` : nothing}`;
  }

  /**
   * DC-116: the demo as it plays: the scan screen (with a quiet "Skip to results"), then the review, then its Emails step. Same
   * shape as renderSignedIn, but the route stays #/demo and the flow alone says which is showing. The review stays mounted (hidden).
   */
  private renderDemoPlay(wantEmails: boolean) {
    const demo = this.demoOrg as DemoOrg, a = demo.access, data = this.data;
    const emails = wantEmails && !!data;
    const onScan = !emails && (this.flow.view === 'scan' || !data);
    const running = this.flow.state === 'scanning' || this.flow.state === 'background';
    return html`
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${onScan ? html`
        ${this.renderScan(a)}
        <p data-note="demo-scan" style="display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: center; margin-top: 1rem">
          <span>${tn('shell.demo.notice', demo.org.world.services.length)}</span>
          ${running ? html`<calcite-button data-action="skip-demo" scale="s" appearance="transparent" kind="neutral" icon-end="chevrons-right" @click=${this.skipDemo}>${t('shell.demo.skipToResults')}</calcite-button>` : nothing}
        </p>` : nothing}
      ${data && (!onScan || this.reviewMounted) ? html`
      <div ?hidden=${onScan || emails}>
        ${this.renderScanStatus()}
        <div data-scan-state=${this.stopped ? 'stopped' : this.background ? 'running' : 'done'} data-demo="play">
          ${renderReview({ data, mode: 'admin', canSeeUsage: true, depsKnown: this.depsKnown, stopped: this.stopped, emailsRoute: 'demo-emails' })}
        </div>
      </div>` : nothing}
      ${emails && data ? html`<app-emails demo .admin=${DEMO_ADMIN} orgId=${data.org.id} orgName=${data.org.name} writable></app-emails>` : nothing}`;
  }

  private renderScan(a: AccessInfo) {
    return html`
      <dc-scan-screen .mode=${a.mode} .orgName=${a.orgName} .fullName=${a.fullName} .flow=${this.flow.state}
        .stages=${this.stages} .model=${this.dots} .org=${this.data?.org ?? { urlKey: '' }} .eta=${this.eta} .notify=${this.notify}
        .aside=${this.accessCard && !this.demoOrg ? html`<dc-access-checklist dismissible announce .mode=${a.mode} .usageReadable=${a.usageReadable} .mayOptIn=${a.writable} .optedIn=${this.sendingOn} .email=${a.email} @dc-turn-on-sending=${this.askTurnOn} @dc-turn-off-sending=${this.askTurnOff} @dc-access-dismiss=${() => { this.accessCard = false; }}></dc-access-checklist>` : nothing}
        .error=${this.scanErrorText} ?depsKnown=${this.depsKnown && this.flow.state !== 'scanning'}
        @dc-scan-notify=${(e: CustomEvent<NotifyChoice>) => { this.notify = e.detail; }}
        @dc-count-sweeps=${(e: CustomEvent<boolean>) => { const id = this.access?.orgId ?? this.data?.org.id; if (id) setCountSweeps(id, e.detail); }}
        @dc-scan-review=${() => this.step({ type: 'review' })}
        @dc-scan-stop=${() => this.abort?.abort()}
        @dc-scan-resume=${this.resumeScan}
        @dc-scan-retry=${() => void this.startScan()}></dc-scan-screen>`;
  }

  protected override willUpdate(): void {
    if (this.dotsBehind && this.scanShown) this.refreshDots();
    if (this.route === 'landing' && this.ticked) this.ticked = 0;
    if ((this.route === 'review' || this.route === 'emails') && this.access && this.data) this.reviewMounted = true;
    if (this.demoOrg && this.data && (this.flow.view === 'review' || this.route === 'demo-emails')) this.reviewMounted = true;
  }

  /**
   * Signed in: the scan screen, the review and (DC-019) its Emails step. The review stays mounted (hidden) on Emails and,
   * once it has been shown, on the scan screen (DC-098), so its ticks survive. Without results yet, the scan screen.
   */
  /**
   * DC-021: the About page. The page underneath (the scan, the review with its ticks, or the demo) stays mounted but hidden,
   * so a trip to About and back (the browser's Back, or the logo) loses nothing.
   */
  private renderAbout() {
    const under = this.access ? this.renderSignedIn('app') : this.demoData ? this.renderDemo() : nothing;
    const app = this.appData();
    const a = this.access;
    return html`<div hidden>${under}</div><dc-about .previous=${this.beforeAbout ?? homeRoute('landing', this.signedIn)}
      .notifier=${app?.notifier ?? null} .nudgeLog=${app?.nudgeLog ?? null} ?writable=${!!app} @dc-app-data-removed=${(e: CustomEvent<{ what: string }>) => { if (e.detail.what === 'group') this.sendingOn = false; }}
      .org=${a ? { id: a.orgId, urlKey: a.urlKey ?? '', customBaseUrl: a.customBaseUrl } : null}></dc-about>`;
  }

  /** ADR 0013: is this admin opted in? A read: their own app group exists. Unknown or any failure counts as not yet. */
  private async refreshSendingOn(): Promise<void> {
    const a = this.access, n = this.appData()?.notifier;
    if (!a || !n) { this.sendingOn = false; return; }
    try {
      const r = await n.canCreateGroup();
      if (r.ok) await n.findGroup();
      if (this.access === a) this.sendingOn = r.ok && !!n.group;
    } catch { /* stays "not yet": the row offers Turn on, which finds or creates the group */ }
  }
  /** The checklist's "Turn on sending" opens the warm confirm. Nothing is created until the admin says yes there. */
  private askTurnOn = (): void => {
    if (!this.appData()) return;
    this.turnOnError = '';
    this.turnOnErrorKey = null;
    this.accessOpen = false;
    this.turnOnOpen = true;
  };
  private confirmTurnOn = async (): Promise<void> => {
    const n = this.appData()?.notifier, a = this.access;
    if (!n || !a || this.turnOnBusy) return;
    this.turnOnBusy = true;
    this.turnOnError = '';
    this.turnOnErrorKey = null;
    try {
      const r = await n.canCreateGroup();
      if (!r.ok) { this.turnOnPrivilege = r.missing || t('shell.error.createGroupPrivilege'); this.turnOnErrorKey = 'missingPrivilege'; return; }
      await n.createGroup();
      if (this.access === a) { this.sendingOn = true; this.turnOnOpen = false; }
    } catch (e) {
      if (e instanceof Error) this.turnOnError = e.message;
      else this.turnOnErrorKey = 'turnOnFailed';
    } finally {
      this.turnOnBusy = false;
    }
  };

  /** DC-125e: "Turn off sending" opens a calm confirm. Nothing is removed until the admin says yes there. */
  private askTurnOff = (): void => {
    if (!this.appData()) return;
    this.turnOffError = '';
    this.accessOpen = false;
    this.turnOffOpen = true;
  };
  /** Removes the admin's own app group through the guarded path (ADR 0012). The nudge log is not touched. Failure leaves sending on. */
  private confirmTurnOff = async (): Promise<void> => {
    const n = this.appData()?.notifier, a = this.access;
    if (!n || !a || this.turnOffBusy) return;
    this.turnOffBusy = true;
    this.turnOffError = '';
    try {
      const r = await turnOffSending(n, { id: a.orgId, urlKey: a.urlKey ?? '', customBaseUrl: a.customBaseUrl });
      if (this.access !== a) return;
      if (r.ok) { this.sendingOn = false; this.turnOffOpen = false; this.offToast = true; }
      else this.turnOffError = r.message;
    } finally {
      this.turnOffBusy = false;
    }
  };

  /**
   * ADR 0012: the session notifier and log for About's "App data in your org", only when signed in to a writable org (never
   * the demo or the simulator). Built once per session. Read-only orgs get nothing, so nothing is shown or reachable.
   */
  private appDataFor: { manager: ArcGISIdentityManager; notifier: GroupNotifier; nudgeLog: NudgeLog } | null = null;
  private appData(): { notifier: GroupNotifier; nudgeLog: NudgeLog } | null {
    const m = this.manager, a = this.access;
    if (!m || !a || !a.writable || this.simulated) return null;
    if (this.appDataFor?.manager === m) return this.appDataFor;
    try {
      const opts = { portal: PORTAL_URL, self: a.username, orgId: a.orgId };
      this.appDataFor = { manager: m, notifier: createSessionNotifier(m, opts), nudgeLog: createSessionNudgeLog(m, opts) };
      return this.appDataFor;
    } catch (e) {
      if (e instanceof WritesDisabled) return null;
      throw e;
    }
  }

  private renderSignedIn(view: 'app' | 'review' | 'emails') {
    if (this.busy || !this.access) return html`<p data-page="loading">${t('shell.access.loading')}</p>`;
    const a = this.access, data = this.data;
    const onScan = view === 'app' || !data;
    return html`
      ${onScan ? this.renderScan(a) : nothing}
      ${data && (!onScan || this.reviewMounted) ? html`
      <div ?hidden=${onScan || view === 'emails'}>
      ${this.renderScanStatus()}
      <div data-scan-state=${this.stopped ? 'stopped' : this.background ? 'running' : 'done'} data-read-only=${String(!a.writable)}>
        ${!a.writable && a.mode !== 'my-items' ? html`<p role="note" data-note="read-only">${t('shell.access.readOnly')}</p>` : nothing}
        ${renderReview({ data, mode: a.mode, canSeeUsage: canSeeUsage(a.usageReadable), username: a.username, note: this.noteText, refreshing: this.refreshing, depsKnown: this.depsKnown, stopped: this.stopped, rescan: this.rescanOffer, onRescan: this.rescan })}
      </div>
      </div>` : nothing}
      ${view === 'emails' && !onScan ? html`<app-emails ?demo=${!!this.simulated} .manager=${this.manager} .admin=${{ name: a.fullName || a.username, username: a.username, ...(a.email !== undefined ? { email: a.email } : {}) }} orgId=${a.orgId} orgName=${a.orgName} ?writable=${a.writable}></app-emails>` : nothing}`;
  }

  private renderSteps() {
    const steps = this.stepsModel();
    if (!steps) return nothing;
    const demo = this.inDemo;
    const hrefs = { scan: hrefOf(demo ? 'demo' : 'app'), review: hrefOf(demo ? 'demo' : 'review'), emails: hrefOf(demo ? 'demo-emails' : 'emails') };
    return html`<dc-steps .steps=${steps} .hrefs=${hrefs} @dc-step-go=${this.onStep}></dc-steps>`;
  }

  /** DC-088: the calm state between the sign-in redirect and the app. No animation, so nothing to reduce. */
  private renderSigningIn() {
    return html`
      <section data-page="signing-in" role="status" aria-live="polite">
        <h1>${t('shell.signing.title')}</h1>
        <p>${t('shell.signing.description')}</p>
      </section>`;
  }

  private renderError() {
    return html`
      <section data-page="error" role="alert">
        <h1>${t('shell.error.title')}</h1>
        <p>${this.oauthErrorForLocale ? oauthMessageFor(this.oauthErrorForLocale.error, this.oauthErrorForLocale.description) : this.signInError || t('shell.error.generic')}</p>
        <calcite-button @click=${() => go('landing')}>${t('shell.error.back')}</calcite-button>
      </section>`;
  }

  /** DC-109 (FB-65): which step is on screen, or null where the indicator is not shown (landing, About, the error page). */
  private stepsModel() {
    const r = this.route;
    if (this.signingIn || this.probe || !(r === 'app' || r === 'review' || r === 'emails' || r === 'demo' || r === 'demo-emails')) return null;
    const demo = this.inDemo;
    if (!demo && (!this.access || this.busy)) return null;
    const data = demo && !this.demoOrg ? this.demoData : this.data;
    let showing: StepId;
    if (demo) showing = r === 'demo-emails' && data ? 'emails' : this.demoOrg && (this.flow.view === 'scan' || !data) ? 'scan' : 'review';
    else showing = r === 'emails' && data ? 'emails' : r === 'app' || !data ? 'scan' : 'review';
    return stepsFor({ showing, hasData: !!data, hasScan: !(demo && !this.demoOrg), ticked: this.ticked, noEmails: isSolo() || (!demo && this.access?.mode === 'my-items') });
  }

  /** DC-109: a step was chosen. Emails goes through Review's own Next button, which hands the current ticks over. */
  private onStep = (e: CustomEvent<StepId>) => {
    const id = e.detail, demo = this.inDemo;
    if (id === 'emails') { (this.querySelector('app-review [data-action="to-emails"]') as HTMLElement | null)?.click(); return; }
    if (id === 'review') {
      if (demo && this.demoOrg) this.flow = nextFlow(this.flow, { type: 'review' });
      this.navigate(demo ? 'demo' : 'review');
      return;
    }
    if (this.flow.view === 'review') this.flow = nextFlow(this.flow, { type: 'scan' });
    this.navigate(demo ? 'demo' : 'app');
  };

  protected override render() {
    let body;
    if (import.meta.env.DEV && this.probe) body = html`<dc-usage-probe></dc-usage-probe>`;
    else if (this.signingIn) body = this.renderSigningIn();
    else switch (this.route) {
      case 'demo': body = this.renderDemo(); break;
      case 'demo-emails': body = this.renderDemo(true); break;
      case 'app': body = this.renderSignedIn('app'); break;
      case 'review': body = this.renderSignedIn('review'); break;
      case 'emails': body = this.renderSignedIn('emails'); break;
      case 'error': body = this.renderError(); break;
      case 'about': body = this.renderAbout(); break;
      default: body = this.renderLanding();
    }
    return html`
      <calcite-shell @dc-selection-change=${(e: CustomEvent<{ owners: string[] }>) => { this.ticked = e.detail.owners.length; }}>
        <calcite-navigation slot="header" label=${t('shell.navigation.label')}>
          <div slot="logo" class="dc-logo"><a class="dc-home" data-action="home" href=${hrefOf(homeRoute(this.route, this.signedIn))} aria-label=${t('shell.home.label')} @click=${this.goHome}><img src="${import.meta.env.BASE_URL}${this.consoleSkin ? 'brand-mark-console.svg' : 'brand-mark.svg'}" alt=""><span class="dc-name">Decluttering</span></a>${this.orgName ? html`<span class="dc-org">${this.orgName}</span>` : nothing}</div>
          <calcite-button slot="content-end" class="dc-about-link" data-action="about" appearance="transparent" kind="neutral" icon-start="information"
            href=${hrefOf('about')} label=${t('shell.about.label')} ?active=${this.route === 'about'}>${this.narrow ? nothing : t('shell.about.button')}</calcite-button>
          <button type="button" role="switch" slot="content-end" class="dc-skin-toggle" data-action="skin-toggle" aria-checked=${this.consoleSkin ? 'true' : 'false'}
            aria-label=${SKIN_COPY.name} title=${this.consoleSkin ? SKIN_COPY.backLabel : SKIN_COPY.badge}
            @click=${() => setSkin(this.consoleSkin ? 'standard' : 'console')}><span class="dc-skin-track" aria-hidden="true"><span class="dc-skin-knob"><svg viewBox="0 0 24 24" width="14" height="14" focusable="false">${this.consoleSkin ? DELTA_ICON : SUN_ICON}</svg></span></span></button>          ${this.renderUser()}
        </calcite-navigation>
        ${this.access && !this.inDemo ? html`<dc-access-dialog ?open=${this.accessOpen} .mode=${this.access.mode} .usageReadable=${this.access.usageReadable} .mayOptIn=${this.access.writable} .optedIn=${this.sendingOn} .email=${this.access.email} @dc-turn-on-sending=${this.askTurnOn} @dc-turn-off-sending=${this.askTurnOff} @dc-access-close=${() => { this.accessOpen = false; }}></dc-access-dialog>
        <dc-turn-on-sending .open=${this.turnOnOpen} .busy=${this.turnOnBusy} .error=${this.turnOnErrorText} @dc-turn-on-close=${() => { if (!this.turnOnBusy) this.turnOnOpen = false; }} @dc-turn-on-confirm=${this.confirmTurnOn}></dc-turn-on-sending>
        <dc-turn-off-sending .open=${this.turnOffOpen} .busy=${this.turnOffBusy} .error=${this.turnOffError} @dc-turn-off-close=${() => { if (!this.turnOffBusy) this.turnOffOpen = false; }} @dc-turn-off-confirm=${this.confirmTurnOff}></dc-turn-off-sending>
        <calcite-alert kind="success" icon="check-circle" auto-close auto-close-duration="medium" placement="bottom" label=${t('shell.notice.label')} .open=${this.offToast} @calciteAlertClose=${() => { this.offToast = false; }}>
          <div slot="message" data-toast="turn-off">${this.offToast ? TURN_OFF.done : nothing}</div>
        </calcite-alert>` : nothing}
        <main style="padding: 1.25rem 1.5rem; margin-inline: auto; max-width: ${this.route === 'app' ? '72rem' : this.route === 'emails' || this.route === 'demo-emails' ? '88rem' : '76rem'}">${this.renderSteps()}${body}</main>
      </calcite-shell>`;
  }
}
