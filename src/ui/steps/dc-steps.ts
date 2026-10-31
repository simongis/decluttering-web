// DC-109 (FB-65): the "Scan › Review › Emails" indicator. Light DOM, our tokens, semantic <nav><ol>. It only draws the
// model (steps.ts) and says which step was chosen (`dc-step-go`); the app shell does the navigating.
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { stepLine, type Step, type StepId } from './steps';
import { t } from '../../i18n';
import '../../styles/steps.css';

@customElement('dc-steps')
export class DcSteps extends LitElement {
  @property({ attribute: false }) steps: readonly Step[] = [];
  /** The hash each step goes to, so a link is a real link (middle click, copy address). */
  @property({ attribute: false }) hrefs: Partial<Record<StepId, string>> = {};

  protected override createRenderRoot(): HTMLElement { return this; }

  private go(e: Event, id: StepId): void {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent<StepId>('dc-step-go', { detail: id, bubbles: true, composed: true }));
  }

  private item(s: Step, n: number) {
    const dot = html`<span class="dc-step-dot" aria-hidden="true">${n}</span><span class="dc-step-label">${s.label}</span>`;
    if (s.state === 'current') return html`<span class="dc-step" data-step=${s.id} aria-current="step">${dot}</span>`;
    if (s.state === 'link') {
      return html`<a class="dc-step" data-step=${s.id} href=${this.hrefs[s.id] ?? '#'} aria-label=${t('steps.linkLabel', { label: s.label, n })} @click=${(e: Event) => this.go(e, s.id)}>${dot}</a>`;
    }
    // Disabled but still reachable by keyboard, so its hint can be read (title for the pointer, aria-label for a screen reader).
    return html`<button type="button" class="dc-step" data-step=${s.id} aria-disabled="true" title=${s.hint ?? ''} aria-label=${t('steps.disabledLabel', { label: s.label, n, hint: s.hint ?? '' }).trim()} @click=${(e: Event) => e.preventDefault()}>${dot}</button>`;
  }

  protected override render() {
    if (this.steps.length < 2) return nothing;
    const at = Math.max(0, this.steps.findIndex((s) => s.state === 'current'));
    return html`<nav class="dc-steps" aria-label=${t('steps.nav')} data-steps>
      <ol>${this.steps.map((s, i) => html`<li>${this.item(s, i + 1)}</li>`)}</ol>
      <span class="dc-steps-count" data-steps-count>${t('steps.count', { n: at + 1, total: this.steps.length })}</span>
    </nav>`;
  }

  /** Spoken summary, for tests and tooltips. */
  get line(): string { return stepLine(this.steps); }
}

declare global { interface HTMLElementTagNameMap { 'dc-steps': DcSteps } }
