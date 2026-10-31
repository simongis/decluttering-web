import { LitElement, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { LocaleController } from '../../i18n/controller';
import { t } from '../../i18n';
import '@esri/calcite-components/dist/components/calcite-action';
import '@esri/calcite-components/dist/components/calcite-panel';
import '@esri/calcite-components/dist/components/calcite-popover';
import '@esri/calcite-components/dist/components/calcite-icon';
import '@esri/calcite-components/dist/components/calcite-block';
import '@esri/calcite-components/dist/components/calcite-segmented-control';
import '@esri/calcite-components/dist/components/calcite-segmented-control-item';
import '@esri/calcite-components/dist/components/calcite-label';
import '@esri/calcite-components/dist/components/calcite-select';
import '@esri/calcite-components/dist/components/calcite-option';
import '@esri/calcite-components/dist/components/calcite-switch';
import '@esri/calcite-components/dist/components/calcite-dialog';
import '@esri/calcite-components/dist/components/calcite-button';
import '@esri/calcite-components/dist/components/calcite-checkbox';
import type { Option, Thresholds } from '../../domain/types';
import {
  LAST_USED_OPTIONS, PRESETS, PRESET_NAMES, SIZE_OPTIONS, UPDATE_OPTIONS, USED_BY_OPTIONS, matchPreset, ruleLine,
  shouldAskAboutSize, sizeReference, smallItemsMessage, statusToggles, type PresetName, type SizeImpact,
} from '../../domain/stale';
import { suggestSentence, type Suggestion } from '../../domain/suggest';
import { optionsWith, sayRule } from './helpers';

type NumKey = 'minDaysSinceUse' | 'minDaysSinceUpdate' | 'maxUsedBy' | 'minSizeMB';
const FLIP = ['bottom-start', 'bottom-end', 'top-start', 'top-end'] as const; // narrow screens: no room on the right
const SMALL_KEY = 'decluttering:small-items-hidden'; // DC-055: "Don't show this again"
const smallHidden = (): boolean => { try { return localStorage.getItem(SMALL_KEY) === '1'; } catch { return false; } };
const hideSmall = (): void => { try { localStorage.setItem(SMALL_KEY, '1'); } catch { /* private mode */ } };

/**
 * DC-083 / DC-095: what "last used" measures (research 7.2). Plain data, one place to edit. DC-094 may change the definition.
 * `counts` and `aside` each get an icon in the popover; the text says it all.
 */
export const usageInfo = () => t('review.usage.info');
export const usageCounts = () => [t('review.usage.count.open'), t('review.usage.count.data')];
export const usageAside = () => t('review.usage.aside');
export const usageNote = () => t('review.usage.note');
export const usedByInfo = () => t('review.usedBy.info');
export const usageUnknown = () => t('review.usage.unknown');

/** GH-2: what the collapsed Content status block says, so a default exclusion is never out of sight. */
export function statusSummary(th: Thresholds): string {
  const noAuth = !th.includeAuthoritative, noDep = !!th.excludeDeprecated;
  return t(noAuth && noDep ? 'review.filter.status.noBoth' : noAuth ? 'review.filter.status.noAuthoritative'
    : noDep ? 'review.filter.status.noDeprecated' : 'review.filter.status.all');
}

/** DC-095: the starting point table, built from PRESETS so it never drifts from the real numbers. */
const agoShort = (d: number): string => t(d >= 365 ? 'review.filter.agoShort.year' : 'review.filter.agoShort.month', { count: Math.round(d >= 365 ? d / 365 : d / 30) });
const usedByShort = (n: number): string => n === 0 ? t('review.filter.usedByNone') : t('review.filter.usedByFew', { count: n });
export const presetTableHead = (): string[] => ['', t('review.table.lastUsed'), t('review.table.lastUpdated'), t('review.table.usedBy'), t('review.table.size')];
export function presetTableRows(): string[][] {
  return (['gentle', 'balanced', 'strict'] as const).map((k) => {
    const t = PRESETS[k];
    return [PRESET_NAMES[k], `${agoShort(t.minDaysSinceUse)}+`, `${agoShort(t.minDaysSinceUpdate)}+`, usedByShort(t.maxUsedBy), `${t.minSizeMB ?? 0} MB+`];
  });
}

/**
 * "What counts as stale?" panel: presets, plain-number dropdowns.
 * Fires `dc-thresholds-change` with the full Thresholds, and `dc-preset-pick` ({ preset }) when a starting point is chosen.
 * `suggestion` (from suggest()) enables the Suggested starting point; `selected` says which one to show as chosen.
 * When `canSeeUsage` is false the usage filters are disabled.
 * `sizeImpact(toMB)` (DC-055): what a lower minimum size would add. When set, lowering the size below the starting
 * point's asks first, unless it adds nothing.
 */
@customElement('dc-filters')
export class DcFilters extends LitElement {
  private readonly _locale = new LocaleController(this);
  @property({ attribute: false }) thresholds: Thresholds = { ...PRESETS.balanced };
  @property({ type: Boolean, attribute: 'can-see-usage' }) canSeeUsage = true;
  @property({ type: Boolean }) member = false;
  @property({ attribute: false }) suggestion: Suggestion | null = null;
  /** The starting point to show as chosen. Defaults to whatever the numbers match. */
  @property() selected: PresetName | '' = '';
  @property({ attribute: false }) sizeImpact: ((toMB: number) => SizeImpact) | null = null;

  /** The size change waiting on the dialog, with what it adds. */
  @state() private asking: SizeImpact | null = null;
  @query('#small-never') private never?: HTMLInputElement;
  

  protected override createRenderRoot(): HTMLElement { return this; }

  private set(patch: Partial<Thresholds>) {
    this.dispatchEvent(new CustomEvent('dc-thresholds-change', { detail: { ...this.thresholds, ...patch }, bubbles: true, composed: true }));
  }

  private preset(name: string) {
    // Custom keeps the numbers as they are: it only says the starting point is no longer one of the named ones.
    if (name === 'custom') { this.dispatchEvent(new CustomEvent('dc-preset-pick', { detail: { preset: 'custom' }, bubbles: true, composed: true })); return; }
    const t = name === 'suggested' ? this.suggestion?.thresholds : name in PRESETS ? PRESETS[name as keyof typeof PRESETS] : undefined;
    if (!t) return;
    this.dispatchEvent(new CustomEvent('dc-preset-pick', { detail: { preset: name }, bubbles: true, composed: true }));
    // GH-2: the content status toggles are not part of a starting point, so picking one keeps them.
    this.dispatchEvent(new CustomEvent('dc-thresholds-change', { detail: { ...t, ...statusToggles(this.thresholds) }, bubbles: true, composed: true }));
  }

  /** DC-055: lowering the minimum size below the starting point's asks first, when it adds anything. */
  private changeSize(toMB: number) {
    const fromMB = this.thresholds.minSizeMB ?? 0;
    const shown = this.selected || matchPreset(this.thresholds);
    const ref = sizeReference(shown, this.suggestion?.thresholds.minSizeMB);
    if (!this.sizeImpact || this.member || smallHidden() || !shouldAskAboutSize(fromMB, toMB, ref)) { this.set({ minSizeMB: toMB }); return; }
    const imp = this.sizeImpact(toMB);
    if (!imp.families) { this.set({ minSizeMB: toMB }); return; }
    this.asking = imp;
  }

  private answer(include: boolean) {
    const imp = this.asking;
    if (!imp) return;
    if (this.never?.checked) hideSmall();
    this.asking = null;
    if (include) this.set({ minSizeMB: imp.toMB });
    else { const sizeSelect = this.querySelectorAll<HTMLSelectElement>('calcite-select')[3]; if (sizeSelect) sizeSelect.value = String(imp.fromMB); } // restore the size select after cancelling
  }

  /** A hand-edited value that is not in the list gets its own option, so the select never lies. */
  private options(key: NumKey, list: Option[]) {
    const cur = this.thresholds[key] ?? 0;
    return optionsWith(key, list, cur).map((o) => html`<calcite-option value=${String(o.value)} ?selected=${o.value === cur}>${o.label}</calcite-option>`);
  }

  private select(key: NumKey, label: string, list: Option[], disabled = false) {
    return html`<calcite-select scale="s" label=${label} ?disabled=${disabled}
      @calciteSelectChange=${(e: Event) => {
        const v = Number((e.target as HTMLSelectElement).value);
        if (key === 'minSizeMB') this.changeSize(v); else this.set({ [key]: v });
      }}>${this.options(key, list)}</calcite-select>`;
  }

  /**
   * DC-114 (FB-72): fit an opened popover to the screen. Calcite keeps a tall popover attached to its button, so on a short
   * screen it can hang off the bottom. Once open, trim the scrolling body by whatever spills below (or above) the window, then
   * reposition. The close button stays in the header, which never scrolls.
   */
  private fitPopover = (e: Event): void => {
    const pop = e.currentTarget as HTMLElement & { reposition?: (delayed?: boolean) => Promise<void> };
    const body = pop.querySelector<HTMLElement>('.pop');
    const box = pop.shadowRoot?.querySelector<HTMLElement>('.container');
    if (!body || !box) return;
    const MARGIN = 16, MIN = 112;
    body.style.maxHeight = '';
    pop.setAttribute('placement', 'right-start');
    requestAnimationFrame(() => {
      const r = box.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom <= vh - MARGIN && r.top >= MARGIN) return;
      // Calcite shifts a tall popover up until it touches the window edge, so a smaller overshoot is not enough: size the box to
      // the room below the button (where it naturally starts), keeping a clear margin under it. A11Y-06.
      const ref = pop.getRootNode() instanceof Document || pop.getRootNode() instanceof ShadowRoot
        ? (pop.getRootNode() as Document | ShadowRoot).getElementById?.(pop.getAttribute('reference-element') ?? '') : null;
      const rr = ref?.getBoundingClientRect();
      const chrome = r.height - body.clientHeight; // header and borders around the scrolling body
      let room = Math.min(vh - MARGIN - Math.max(MARGIN, rr ? rr.top : r.top), vh - 2 * MARGIN);
      if (rr && room - chrome < 200) { // too little room below the button: grow upwards from it instead
        pop.setAttribute('placement', 'right-end');
        room = Math.min(rr.bottom - MARGIN, vh - 2 * MARGIN);
      }
      body.style.maxHeight = `${Math.max(MIN, Math.min(body.clientHeight, room - chrome - 4))}px`;
      // Then trim whatever still spills (a popover Calcite has already shifted, at the top or the bottom), a few times at most.
      const settle = async (left: number): Promise<void> => {
        await pop.reposition?.(true);
        await new Promise((res) => requestAnimationFrame(res));
        const b = box.getBoundingClientRect();
        const over = Math.max(0, b.bottom - (vh - MARGIN)) + Math.max(0, MARGIN - b.top);
        if (!over || left <= 0 || body.clientHeight <= MIN) return;
        body.style.maxHeight = `${Math.max(MIN, body.clientHeight - over - 4)}px`;
        await settle(left - 1);
      };
      void settle(3);
    });
  };

  /** GH-2: a content status switch. Both read as "Include ...", so on always means more on the list. */
  private toggle(label: string, on: boolean, patch: (on: boolean) => Partial<Thresholds>) {
    return html`<calcite-label layout="inline"><calcite-switch scale="s" .checked=${on}
      @calciteSwitchChange=${(e: Event) => this.set(patch((e.target as HTMLInputElement).checked))}></calcite-switch>${label}</calcite-label>`;
  }

  private smallDialog() {
    const imp = this.asking;
    return html`<calcite-dialog id="small-dlg" modal width-scale="m" heading=${t('review.filter.includeSmall.heading')} ?open=${!!imp}
      @calciteDialogClose=${() => this.answer(false)}>
      <div class="dlg small-dlg"><p class="lede" data-msg="small">${imp ? smallItemsMessage(imp) : ''}</p></div>
      <calcite-label slot="footer-start" layout="inline"><calcite-checkbox id="small-never"></calcite-checkbox>${t('review.filter.includeSmall.never')}</calcite-label>
      <calcite-button slot="footer-end" appearance="outline" @click=${() => this.answer(true)}>${t('review.filter.includeSmall.include')}</calcite-button>
      <calcite-button slot="footer-end" @click=${() => this.answer(false)}>${t('review.filter.includeSmall.keep', { size: imp ? imp.fromMB : '' })}</calcite-button>
    </calcite-dialog>`;
  }

  override render() {
    const thresholds = this.thresholds, u = this.canSeeUsage;
    const preset = this.selected || matchPreset(thresholds);
    const sug = this.suggestion;
    const kinds = (Object.keys(PRESET_NAMES) as PresetName[]).filter((k) => k !== 'suggested' || sug);
    return html`<calcite-panel heading=${t('review.whatStale')}>
      <calcite-block heading=${t('review.filter.startingPoint')} expanded>
        <calcite-action slot="actions-end" id="preset-info" icon="information" scale="s" text=${t('review.filter.howStart')} label=${t('review.filter.howStart')}></calcite-action>
        <calcite-segmented-control width="full" scale="s" label=${t('review.filter.startingPoint')}
          @calciteSegmentedControlChange=${(e: Event) => this.preset((e.target as HTMLInputElement).value)}>
          ${kinds.map((k) =>
            html`<calcite-segmented-control-item value=${k} ?checked=${preset === k}>${PRESET_NAMES[k]}</calcite-segmented-control-item>`)}
        </calcite-segmented-control>
        <p class="words" title=${preset === 'suggested' && sug ? suggestSentence(sug) : nothing}>${u ? ruleLine(thresholds) : sayRule(thresholds, u, this.member)}${preset === 'suggested' && sug ? html`<span class="dc-sr"> ${suggestSentence(sug)}</span>` : nothing}</p>
        <calcite-popover reference-element="preset-info" placement="right-start" .flipPlacements=${FLIP} closable overlay-positioning="fixed" label=${t('review.filter.howStart')} heading=${t('review.filter.startingPoint')} @calcitePopoverOpen=${this.fitPopover}>
          <div class="pop" tabindex="0" role="region" aria-label=${t('review.filter.howStart')}>
            <p><b>${t('review.filter.suggestedLead')}</b> ${t('review.filter.suggestedParagraph', { count: t('review.filter.settingCount') })}</p>
            <p>${t('review.filter.fixedPresets')}</p>
            <table class="pop-table">
              <thead><tr>${presetTableHead().map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
              <tbody>${presetTableRows().map(([name, ...cells]) => html`<tr><th scope="row">${name}</th>${cells.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody>
            </table>
            <p>${t('review.usedBy.info')}</p>
            <p>${t('review.filter.smallServices')}</p>
            <p>${t('review.filter.priorityParagraph')}</p>
          </div>
        </calcite-popover>
      </calcite-block>

      <calcite-block heading=${t('review.filter.adjust')} expanded>
        <calcite-action slot="actions-end" id="usage-info" icon="information" scale="s" text=${t('review.filter.lastUsedHelp')} label=${t('review.filter.lastUsedHelp')}></calcite-action>
        <calcite-popover reference-element="usage-info" placement="right-start" .flipPlacements=${FLIP} closable overlay-positioning="fixed" label=${t('review.filter.lastUsedHelp')} heading=${t('review.filter.lastUsed')} @calcitePopoverOpen=${this.fitPopover}>
          <div class="pop" tabindex="0" role="region" aria-label=${t('review.filter.lastUsedHelp')}>
            <p>${t('review.usage.info')}</p>
            <ul class="pop-list" aria-label=${t('review.filter.counts')}>
              ${[t('review.usage.count.open'), t('review.usage.count.data')].map((c) => html`<li><calcite-icon icon="check-circle" scale="s" aria-hidden="true" class="ok"></calcite-icon><span><b>${t('review.filter.countsLabel')}</b> ${c}</span></li>`)}
              <li><calcite-icon icon="minus-circle" scale="s" aria-hidden="true" class="aside"></calcite-icon><span><b>${t('review.filter.setAside')}</b> ${t('review.usage.aside')}</span></li>
            </ul>
            <p>${t('review.usage.note')}</p>
            <p>${t('review.usage.unknown')}</p>
          </div>
        </calcite-popover>
        <div class="fields">
          <calcite-label>${t('review.filter.lastUsed')}: ${t('review.filter.moreThan')}<span class="sel-ago">${this.select('minDaysSinceUse', t('review.filter.lastUsed'), LAST_USED_OPTIONS, !u)}<span>${t('review.filter.ago')}</span></span></calcite-label>
          ${u ? nothing : html`<p class="hint">${t('review.filter.unavailable')}: ${t('review.filter.rule.noUsage')}</p>`}
          <calcite-label>${t('review.filter.lastUpdated')}: ${t('review.filter.moreThan')}<span class="sel-ago">${this.select('minDaysSinceUpdate', t('review.filter.lastUpdated'), UPDATE_OPTIONS)}<span>${t('review.filter.ago')}</span></span></calcite-label>
          <calcite-label>${t('review.filter.usedBy')}${this.select('maxUsedBy', t('review.filter.usedBy'), USED_BY_OPTIONS)}</calcite-label>
          <calcite-label>${t('review.filter.sizeAtLeast')}${this.select('minSizeMB', t('review.filter.minimumSize'), SIZE_OPTIONS)}</calcite-label>
        </div>
      </calcite-block>

      <calcite-block heading=${t('review.filter.status.heading')} description=${statusSummary(thresholds)} collapsible>
        <div class="fields status-fields">
          ${this.toggle(t('review.filter.status.authoritative'), !!thresholds.includeAuthoritative, (on) => ({ includeAuthoritative: on }))}
          ${this.toggle(t('review.filter.status.deprecated'), !thresholds.excludeDeprecated, (on) => ({ excludeDeprecated: !on }))}
          <p class="hint">${t('review.filter.status.hint')}</p>
        </div>
      </calcite-block>

    </calcite-panel>
    ${this.smallDialog()}`;
  }
}
declare global { interface HTMLElementTagNameMap { 'dc-filters': DcFilters } }
