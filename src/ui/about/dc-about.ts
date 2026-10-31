// DC-021: the About page. Seven short sections, each with its detail behind a native <details> expander (keyboard and
// screen-reader friendly, collapsed by default). DC-110 adds two small Calcite-icon diagrams, the GitHub line and the
// self-hosted contact link. Props: none. Makes no network calls, so it works signed out, signed in and in demo.
import { LitElement, html, nothing } from 'lit';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import { customElement, property } from 'lit/decorators.js';
import { hrefOf, type Route } from '../../routes/router';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-button';
import { ABOUT_INTRO, ABOUT_SECTIONS, APPROVED_APPS_LINK_TEXT, APPROVED_APPS_URL, OPEN_DISCLAIMER, CONTACT_LINK_TEXT, CONTACT_URL, FLOWS, backLabel, issuesLine, repoLine, type Block, type FlowId } from './content';
import './dc-app-data';
import type { AppDataOrg } from './app-data';
import type { GroupNotifier } from '../../notify';
import type { NudgeLog } from '../../log';
import '../../styles/about.css';

// The GitHub mark (octicon mark-github, 16 px), monochrome. Calcite has no brand icons.
const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

@customElement('dc-about')
export class DcAbout extends LitElement {
  private readonly _locale = new LocaleController(this);
  /** FB-70: the route About was opened from; app-root sets it. Drives the Back link. */
  @property({ attribute: false }) previous: Route = 'landing';
  /** ADR 0012: what the "App data in your org" section needs. With no notifier or log, or a read-only org, it renders nothing. */
  @property({ attribute: false }) notifier: GroupNotifier | null = null;
  @property({ attribute: false }) nudgeLog: NudgeLog | null = null;
  @property({ type: Boolean }) writable = false;
  @property({ attribute: false }) org: AppDataOrg | null = null;
  @property({ attribute: false }) signal: AbortSignal | null = null;
  /** True while a send runs. */
  @property({ type: Boolean }) sending = false;

  protected override createRenderRoot(): HTMLElement { return this; }

  private block(b: Block) {
    return 'p' in b ? html`<p>${b.p}</p>` : html`<ul>${b.ul.map((x) => html`<li>${x}</li>`)}</ul>`;
  }

  private flow(id: FlowId) {
    const f = FLOWS[id];
    return html`<div class="about-flow" role="img" aria-label=${f.label} data-flow=${id}>
      <ol class="about-flow-steps" aria-hidden="true">
        ${f.steps.map((s) => html`<li class="about-flow-step">
          <span class="about-flow-icon"><calcite-icon icon=${s.icon} scale="l"></calcite-icon></span>
          <span class="about-flow-label">${s.label}</span>
          <span class="about-flow-note">${s.note}</span>
        </li>`)}
      </ol>
    </div>`;
  }

  private repo() {
    const r = repoLine(import.meta.env.VITE_REPO_URL as string | undefined);
    const mark = html`<svg class="about-gh" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d=${GITHUB_PATH}></path></svg>`;
    return html`<p class="about-repo"><a href=${r.href} target="_blank" rel="noopener noreferrer">${mark}<span>${r.text}</span></a></p>`;
  }

  private disclaimer() {
    const r = repoLine(import.meta.env.VITE_REPO_URL as string | undefined);
    return html`<p class="about-disclaimer" data-about="disclaimer">${OPEN_DISCLAIMER.before}<a href=${r.href} target="_blank" rel="noopener noreferrer">${OPEN_DISCLAIMER.linkText}<span class="about-sr">${t('about.newTab')}</span></a>${OPEN_DISCLAIMER.after}</p>`;
  }

  private issues() {
    const i = issuesLine(import.meta.env.VITE_REPO_URL as string | undefined);
    return html`<p>${i.before}<a href=${i.link.href} target="_blank" rel="noopener noreferrer">${i.link.text}<span class="about-sr">${t('about.newTab')}</span></a>${i.after}</p>`;
  }

  private appData() {
    return html`<dc-app-data .notifier=${this.notifier} .nudgeLog=${this.nudgeLog} ?writable=${this.writable} .org=${this.org} .signal=${this.signal} ?sending=${this.sending}></dc-app-data>`;
  }

  override render() {
    return html`<article class="about">
      <a class="about-back" href=${hrefOf(this.previous)}><calcite-icon icon="arrow-left" scale="s" aria-hidden="true"></calcite-icon>${backLabel(this.previous)}</a>
      <h1>${t('about.pageTitle')}</h1>
      <p class="about-intro">${ABOUT_INTRO}</p>
      ${ABOUT_SECTIONS.map((s) => html`<section class="about-sec" aria-labelledby=${`about-h-${s.id}`}>
        <h2 id=${`about-h-${s.id}`}>${s.title}</h2>
        <p class="about-lead">${s.lead}</p>
        ${s.flow ? this.flow(s.flow) : nothing}
        ${s.id === 'open' ? this.repo() : nothing}
        ${s.detail.length ? html`<details class="about-more" data-section=${s.id}>
          <summary>${t('about.moreDetail')}</summary>
          <div class="about-detail">${s.detail.map((b) => this.block(b))}
            ${s.id === 'approved' ? html`<p><a class="about-esri" href=${APPROVED_APPS_URL} target="_blank" rel="noopener noreferrer">${APPROVED_APPS_LINK_TEXT}<span class="about-sr">${t('about.newTab')}</span></a></p>` : nothing}
            ${s.id === 'open' ? this.issues() : nothing}
            ${s.id === 'open' ? html`<p><calcite-button class="about-contact" href=${CONTACT_URL} target="_blank" rel="noopener noreferrer" appearance="outline" scale="s" icon-start="envelope">${CONTACT_LINK_TEXT}<span class="about-sr">${t('about.newTab')}</span></calcite-button></p>` : nothing}
          </div>
        </details>` : nothing}
        ${s.id === 'open' ? this.disclaimer() : nothing}
      </section>${s.id === 'email' ? this.appData() : nothing}`)}
    </article>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-about': DcAbout } }
