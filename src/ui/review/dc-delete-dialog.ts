// ADR 0016: the confirm-and-run dialog for deleting layers from Review. Controlled by the host (`open`, `items`); it runs the
// delete itself through the `remover` it is given, so the dialog and the allow-listed remover are the only way a delete happens.
// Three states in one dialog: confirm (the list, the warnings, a typed word), working (progress and Stop) and done (what went
// and what didn't). Events: dc-items-removed ({ ids: every id that is gone, views included }), dc-delete-close.
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-input';
import '@esri/calcite-components/dist/components/calcite-label';
import '@esri/calcite-components/dist/components/calcite-notice';
import '@esri/calcite-components/dist/components/calcite-progress';
import { formatMB } from '../../domain/format';
import { formatNumber, t, tn, type MessageKey } from '../../i18n';
import { LocaleController } from '../../i18n/controller';
import type { ItemRemover, RemoveOutcome } from '../../remove/remover';
import type { RemovalCandidate } from '../../remove/plan';
import { deleteReportCsv, reportFileName } from '../../remove/report';

type Phase = 'confirm' | 'working' | 'done';
export interface ItemsRemovedDetail { ids: string[] }

@customElement('dc-delete-dialog')
export class DcDeleteDialog extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ type: Boolean }) open = false;
  /** What would be deleted: only layers this user may delete. */
  @property({ attribute: false }) items: RemovalCandidate[] = [];
  /** How many chosen layers were left out because this user may not delete them. */
  @property({ type: Number }) leftOut = 0;
  /** The signed-in username, named in the dialog so it is clear whose account does the delete. */
  @property() user = '';
  @property({ attribute: false }) remover: ItemRemover | null = null;
  /** The org's name, for the report. */
  @property() org = '';
  /** The layers and the time of the run that finished, for the report (the host's `items` change as the list updates). */
  private ran: { items: RemovalCandidate[]; at: Date } | null = null;
  @state() private phase: Phase = 'confirm';
  @state() private typed = '';
  @state() private progress = { done: 0, total: 0 };
  @state() private outcomes: RemoveOutcome[] = [];
  private ctl: AbortController | null = null;

  protected override createRenderRoot(): HTMLElement { return this; }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) { this.phase = 'confirm'; this.typed = ''; this.outcomes = []; this.progress = { done: 0, total: 0 }; }
  }

  private emitClose(): void { this.dispatchEvent(new CustomEvent('dc-delete-close', { bubbles: true, composed: true })); }

  private get word(): string { return t('review.delete.word'); }
  private get armed(): boolean { return this.typed.trim().toLocaleUpperCase() === this.word.toLocaleUpperCase() && this.items.length > 0 && !!this.remover; }

  private focusTyped = (e: Event): void => {
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement & { setFocus?: () => Promise<void> }>('[data-focus]');
    if (el) requestAnimationFrame(() => { void el.setFocus?.(); });
  };

  private run = async (): Promise<void> => {
    if (!this.armed || this.phase !== 'confirm' || !this.remover) return;
    const items = [...this.items];
    this.phase = 'working';
    this.progress = { done: 0, total: items.length };
    this.ctl = new AbortController();
    let out: RemoveOutcome[];
    try {
      out = await this.remover.removeFamilies(items.map((i) => i.family), {
        signal: this.ctl.signal, onProgress: (done, total) => { this.progress = { done, total }; },
      });
    } catch (e) {
      out = items.map((i) => ({ id: i.id, ok: false as const, reason: 'failed' as const, message: e instanceof Error ? e.message : String(e), removed: [] }));
    }
    this.ctl = null;
    this.ran = { items, at: new Date() };
    this.outcomes = out;
    this.phase = 'done';
    const ids = out.flatMap((o) => o.removed);
    if (ids.length) this.dispatchEvent(new CustomEvent<ItemsRemovedDetail>('dc-items-removed', { detail: { ids }, bubbles: true, composed: true }));
  };

  private stop = (): void => { this.ctl?.abort(); };

  /** ADR 0016: the run as CSV, saved by the browser. Nothing is sent anywhere. */
  private download = (): void => {
    const r = this.ran;
    if (!r) return;
    const csv = deleteReportCsv(r.items, this.outcomes, { at: r.at, by: this.user, org: this.org });
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })); // BOM: Excel reads the accents
    const a = document.createElement('a');
    a.href = url; a.download = reportFileName(r.at); a.hidden = true;
    // Inside the dialog: a modal makes the rest of the page inert, and a click on an inert link does nothing.
    (this.querySelector('calcite-dialog') ?? document.body).append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  private row(c: RemovalCandidate) {
    const size = c.sizeMB === null ? t('review.delete.unknownSize') : formatMB(c.sizeMB);
    return html`<li data-delete-item=${c.id}>
      <b>${c.title}</b> <span class="dd-meta">${t('review.delete.itemMeta', { owner: c.owner, size })}</span>
      ${c.views.length ? html`<span class="dd-meta">${tn('review.delete.views', c.views.length, { count: formatNumber(c.views.length) })}</span>` : nothing}
      ${c.usedBy ? html`<span class="dd-warn">${tn('review.delete.usedBy', c.usedBy, { count: formatNumber(c.usedBy) })}</span>` : nothing}
      ${this.items.length > 1 ? html`<button type="button" class="dd-unpick" data-action="delete-unpick" aria-label=${t('review.delete.unpickLabel', { title: c.title })}
        @click=${() => this.dispatchEvent(new CustomEvent<{ id: string }>('dc-delete-unpick', { detail: { id: c.id }, bubbles: true, composed: true }))}>${t('review.delete.unpick')}</button>` : nothing}
    </li>`;
  }

  private confirm() {
    const n = this.items.length;
    const known = this.items.filter((i) => i.sizeMB !== null);
    const freed = known.reduce((s, i) => s + (i.sizeMB as number), 0);
    return html`
      <p>${t('review.delete.intro', { user: this.user })}</p>
      ${n ? html`<ul class="dd-list" aria-label=${t('review.delete.listLabel')}>${this.items.map((c) => this.row(c))}</ul>` : html`<p data-delete="nothing">${t('review.delete.nothing')}</p>`}
      ${n && known.length ? html`<p class="dd-total" data-delete="total">${t('review.delete.total', { size: formatMB(freed) })}</p>` : nothing}
      ${this.leftOut ? html`<p class="dd-meta" data-delete="left">${tn('review.delete.left', this.leftOut, { count: formatNumber(this.leftOut) })}</p>` : nothing}
      ${n ? html`<calcite-label>${t('review.delete.typeLabel', { word: this.word })}
        <calcite-input data-delete="typed" data-focus scale="s" autocomplete="off" label=${t('review.delete.typeLabel', { word: this.word })} .value=${this.typed}
          @calciteInputInput=${(e: Event) => { this.typed = (e.target as HTMLInputElement).value; }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.run(); }}></calcite-input></calcite-label>` : nothing}
      <calcite-button slot="footer-start" appearance="transparent" kind="neutral" data-action="delete-cancel" @click=${() => this.emitClose()}>${t('review.delete.cancel')}</calcite-button>
      ${n ? html`<calcite-button slot="footer-end" kind="danger" icon-start="trash" data-action="delete-go" ?disabled=${!this.armed} @click=${() => void this.run()}>${tn('review.delete.go', n, { count: formatNumber(n) })}</calcite-button>` : nothing}`;
  }

  private working() {
    const { done, total } = this.progress;
    return html`<p role="status" data-delete="working">${t('review.delete.working', { done: formatNumber(done), total: formatNumber(total) })}</p>
      <calcite-progress value=${total ? done / total : 0} label=${t('review.delete.working', { done: formatNumber(done), total: formatNumber(total) })}></calcite-progress>
      <calcite-button slot="footer-end" kind="neutral" appearance="outline" data-action="delete-stop" @click=${this.stop}>${t('review.delete.stop')}</calcite-button>`;
  }

  private done() {
    const byId = new Map((this.ran?.items ?? this.items).map((i) => [i.id, i]));
    const ok = this.outcomes.filter((o) => o.ok);
    const bad = this.outcomes.filter((o) => !o.ok);
    const freed = ok.reduce((s, o) => s + (byId.get(o.id)?.sizeMB ?? 0), 0);
    const usedByAny = ok.some((o) => (byId.get(o.id)?.usedBy ?? 0) > 0);
    return html`<div role="status" data-delete="done">
        <p><b>${tn('review.delete.done', ok.length, { count: formatNumber(ok.length) })}</b>${freed > 0 ? html` ${t('review.delete.freed', { size: formatMB(freed) })}` : nothing}</p>
        ${usedByAny ? html`<p class="dd-meta">${t('review.delete.rescan')}</p>` : nothing}
      </div>
      ${bad.length ? html`<calcite-notice open kind="warning" scale="s" data-delete="failures"><div slot="message">
        <p>${tn('review.delete.notDone', bad.length, { count: formatNumber(bad.length) })}</p>
        <ul class="dd-list">${bad.map((o) => {
          const c = byId.get(o.id);
          const reason = o.ok ? '' : t(`review.delete.reason.${o.reason}` as MessageKey);
          return html`<li data-delete-failed=${o.id}><b>${c?.title ?? o.id}</b> <span class="dd-meta">${reason}${o.removed.length ? ` ${t('review.delete.partial')}` : ''}</span>
            ${!o.ok && o.message && o.reason === 'failed' ? html`<span class="dd-meta">${o.message}</span>` : nothing}</li>`;
        })}</ul></div></calcite-notice>` : nothing}
      <p class="dd-meta" data-delete="report-hint">${t('review.delete.reportHint')}</p>
      <calcite-button slot="footer-start" appearance="outline" kind="neutral" icon-start="download" data-action="delete-report" @click=${this.download}>${t('review.delete.report')}</calcite-button>
      <calcite-button slot="footer-end" data-action="delete-close" @click=${() => this.emitClose()}>${t('review.delete.close')}</calcite-button>`;
  }

  protected override render() {
    const working = this.phase === 'working';
    const n = this.items.length;
    const heading = this.phase === 'done' ? t('review.delete.doneHeading') : tn('review.delete.heading', Math.max(n, 1), { count: formatNumber(n) });
    return html`<calcite-dialog data-dialog="delete" modal heading=${heading} width-scale="s" .open=${this.open}
      ?close-disabled=${working} ?escape-disabled=${working} ?outside-close-disabled=${working}
      @calciteDialogOpen=${this.focusTyped} @calciteDialogClose=${() => { if (this.open && !working) this.emitClose(); }}>
      ${this.phase === 'confirm' ? this.confirm() : this.phase === 'working' ? this.working() : this.done()}
    </calcite-dialog>`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-delete-dialog': DcDeleteDialog } }
