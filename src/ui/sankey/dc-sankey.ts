import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import '@esri/calcite-components/dist/components/calcite-chip';
import '@esri/calcite-components/dist/components/calcite-tooltip';
import type { OwnerGroup } from '../../domain/types';
import { fmtInt } from '../../domain/format';
import { shapeSankey, type SankeyOwner } from './shape';

const credit = (c: number): string => (c < 10 ? c.toFixed(1) : fmtInt(c));
const plural = (n: number, a: string, b: string): string => `${fmtInt(n)} ${n === 1 ? a : b}`;

interface NodeDatum { id: string; kind: 'owner' | 'clear' | 'risk'; owner?: SankeyOwner }
interface LinkDatum { owner: string }
interface Laid { x0: number; x1: number; y0: number; y1: number }

/** The drawing width when the slot can't be measured; DC-090 (finding 9): otherwise it follows the slot so text stays 12 px. */
const W_DEFAULT = 820;
/** Below this the labels either side would collide, so the drawing scales down instead. */
const W_MIN = 600;

/** Owners -> "Stale, on their own" / "Stale, but used by maps or apps", valued in credits a month. */
@customElement('dc-sankey')
export class DcSankey extends LitElement {
  @property({ attribute: false }) owners: OwnerGroup[] = [];
  /** Selected owner username, or null. */
  @property() selected: string | null = null;
  @state() private hovered: string | null = null;
  @state() private W = W_DEFAULT;
  private ro: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver((es) => {
      const w = Math.round(es[0]?.contentRect.width ?? 0);
      if (w > 0) { const next = Math.max(W_MIN, w); if (Math.abs(next - this.W) > 2) this.W = next; } // 0: hidden, keep the last width
    });
    this.ro.observe(this);
  }
  override disconnectedCallback(): void { this.ro?.disconnect(); this.ro = null; super.disconnectedCallback(); }

  static styles = css`
    :host {
      display: block;
      --_stale: var(--dc-stale-solid, var(--dc-raspberry, #b01f59));
      --_risk: var(--dc-risk-solid, var(--dc-amber, #faa61a));
      --_nudged: var(--dc-nudged, #34434f);
      --_clear-flow: var(--dc-dot-found, #b5c2cc);
    }
    .chips { margin-block-end: 0.5rem; }
    svg { width: 100%; height: auto; display: block; }
    text { font: 12px var(--dc-font-sans, system-ui, sans-serif); fill: var(--calcite-color-text-1, #151515); }
    .sub { fill: var(--calcite-color-text-3, #6a6a6a); }
    .link { fill: none; transition: stroke-opacity 0.15s; }
    /* DC-135: the console look rounds the bars into pills. */
    .bar { rx: var(--dc-sankey-rx, 2px); }
    .link.flow-clear { stroke: var(--_clear-flow); stroke-opacity: 0.55; }
    .link.flow-risk { stroke: var(--_risk); stroke-opacity: 0.4; }
    svg.hovering .link { stroke-opacity: 0.12; }
    svg.hovering .link.on { stroke-opacity: 0.8; }
    .node { cursor: pointer; outline: none; }
    .node .nm { fill: var(--calcite-color-text-link, #0063a3); }
    .node:hover .nm, .node:focus-visible .nm, .node.sel .nm { text-decoration: underline; }
    .node .chev { fill: none; stroke: var(--calcite-color-text-link, #0063a3); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .node .focus { fill: none; stroke: transparent; stroke-width: 2; }
    .node:focus-visible .focus { stroke: var(--calcite-color-brand, #007ac2); }
    .node.sel .focus { stroke: var(--calcite-color-brand, #007ac2); stroke-width: 1; }
    svg.hovering .node.dim { opacity: 0.35; }
    .node.static { cursor: default; }
    .node.static .nm { fill: var(--calcite-color-text-1, #151515); }
    @media (prefers-reduced-motion: reduce) { .link { transition: none; } }
  `;

  private select(id: string | null): void {
    this.dispatchEvent(new CustomEvent('dc-owner-select', { detail: { owner: id }, bubbles: true, composed: true }));
  }

  private onKey(e: KeyboardEvent, id: string): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(id); }
  }

  protected updated(): void {
    // Calcite tooltips need their reference element; supply it once the nodes exist.
    for (const tip of this.renderRoot.querySelectorAll<HTMLElement & { referenceElement?: Element | null }>('calcite-tooltip')) {
      tip.referenceElement = this.renderRoot.querySelector(`[data-node="${CSS.escape(tip.dataset.for ?? '')}"]`);
    }
  }

  render() {
    const shape = shapeSankey(this.owners);
    if (!shape.owners.length) return nothing;
    // No credits to draw (sizes not measured yet, or views only): d3-sankey would divide by a zero total (DC-053).
    if (!shape.links.length) {
      return html`<p class="sub" data-chart="empty">${this.owners.some((o) => o.unmeasured)
        ? 'The chart appears once storage has been measured.'
        : 'These items have no storage of their own, so there are no credits to chart.'}</p>`;
    }
    const W = this.W;
    const H = Math.max(200, shape.owners.length * 30 + 60);
    const nodes: NodeDatum[] = [
      ...shape.owners.map((o): NodeDatum => ({ id: o.id, kind: 'owner', owner: o })),
      { id: 'clear', kind: 'clear' } as NodeDatum, { id: 'risk', kind: 'risk' } as NodeDatum,
    ].filter((n) => n.kind === 'owner' || shape.links.some((l) => l.target === n.id));
    const graph = sankey<NodeDatum, LinkDatum>()
      .nodeId((d) => d.id).nodeWidth(14).nodePadding(22).nodeSort(null)
      .extent([[220, 4], [W - 215, H - 4]])({
        nodes: nodes.map((n) => ({ ...n })),
        links: shape.links.map((l) => ({ source: l.source, target: l.target, value: l.value, owner: l.owner })) as never,
      });
    const linkPath = sankeyLinkHorizontal<NodeDatum, LinkDatum>();
    const selected = shape.owners.find((o) => o.id === this.selected);

    return html`
      ${selected && !selected.other ? html`<div class="chips">
        <calcite-chip closable scale="s" kind="brand" appearance="outline-fill"
          @calciteChipClose=${() => this.select(null)}>${selected.label}</calcite-chip></div>` : nothing}
      <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Credits a month by owner"
        class=${this.hovered ? 'hovering' : ''}>
        <g>${graph.links.map((l) => {
          const t = l.target as unknown as NodeDatum;
          const on = this.hovered === l.owner;
          return svg`<path class="link ${t.kind === 'clear' ? 'flow-clear' : 'flow-risk'} ${on ? 'on' : ''}"
            d=${linkPath(l) ?? ''} stroke-width=${Math.max(1, l.width ?? 0)}></path>`;
        })}</g>
        <g>${graph.nodes.map((n) => {
          const d = n as unknown as NodeDatum & Laid;
          return d.kind === 'owner' ? this.ownerNode(d) : this.statNode(d, shape.totals[d.kind]);
        })}</g>
      </svg>
      ${shape.owners.map((o) => html`<calcite-tooltip placement="top" close-on-click data-for=${o.id}>
        <b>${o.other ? plural(o.count ?? 0, 'other owner', 'other owners') : o.label}</b><br>
        ${plural(o.services, 'service', 'services')} · ≈ ${credit(o.credits)} credits a month
        ${o.other ? nothing : html`<br>Click to filter the list`}</calcite-tooltip>`)}`;
  }

  private ownerNode(d: NodeDatum & Laid) {
    const o = d.owner as SankeyOwner;
    const cy = (d.y0 + d.y1) / 2;
    const sel = o.id === this.selected;
    const label = o.other
      ? `${o.label}: ${plural(o.count ?? 0, 'owner', 'owners')}, ${credit(o.credits)} credits a month`
      : `${o.label}, ${plural(o.services, 'service', 'services')}, ${credit(o.credits)} credits a month. Filter list.`;
    const tx = o.other ? d.x0 - 8 : d.x0 - 22;
    return svg`<g class="node ${o.other ? 'static' : ''} ${sel ? 'sel' : ''} ${this.hovered && this.hovered !== o.id ? 'dim' : ''}"
      data-node=${o.id}
      role=${o.other ? 'img' : 'button'} tabindex=${o.other ? nothing : 0}
      aria-label=${label} aria-pressed=${o.other ? nothing : sel ? 'true' : 'false'}
      @pointerenter=${() => { this.hovered = o.id; }} @pointerleave=${() => { this.hovered = null; }}
      @focus=${() => { this.hovered = o.id; }} @blur=${() => { this.hovered = null; }}
      @click=${o.other ? nothing : () => this.select(o.id)}
      @keydown=${o.other ? nothing : (e: KeyboardEvent) => this.onKey(e, o.id)}>
      <rect class="bar" x=${d.x0} y=${d.y0} width=${d.x1 - d.x0} height=${Math.max(1, d.y1 - d.y0)} rx="2" style="fill:var(--_nudged)"></rect>
      <rect class="focus" x="4" y=${Math.min(d.y0, cy - 12) - 2} width=${d.x1 - 4} height=${Math.max(d.y1 - d.y0, 24) + 4} rx="4"></rect>
      <text x=${tx} y=${cy} dy="0.32em" text-anchor="end"><tspan class="nm">${o.label}</tspan><tspan class="sub"> · ${credit(o.credits)} credits</tspan></text>
      ${o.other ? nothing : svg`<polyline class="chev" points="${d.x0 - 14},${cy - 4} ${d.x0 - 9},${cy} ${d.x0 - 14},${cy + 4}"></polyline>`}
    </g>`;
  }

  private statNode(d: NodeDatum & Laid, t: { credits: number; services: number }) {
    const clear = d.kind === 'clear';
    const cy = (d.y0 + d.y1) / 2;
    return svg`<g>
      <rect class="bar" x=${d.x0} y=${d.y0} width=${d.x1 - d.x0} height=${Math.max(1, d.y1 - d.y0)} rx="2" style="fill:${clear ? 'var(--_stale)' : 'var(--_risk)'}"></rect>
      <text x=${d.x1 + 8} y=${cy} dy="-0.1em">${clear ? 'Stale, on their own' : 'Stale, but used by maps or apps'}</text>
      <text class="sub" x=${d.x1 + 8} y=${cy} dy="1.05em">${credit(t.credits)} credits · ${plural(t.services, 'service', 'services')}</text>
    </g>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'dc-sankey': DcSankey } }
