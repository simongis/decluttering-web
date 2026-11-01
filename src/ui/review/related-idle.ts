// DC-147d: idle pre-fetch of relatedItems for the families on screen in the Review list (and the next screen below), so the item panel's "Offline and
// surveys" is often ready before it opens. Runs only when the scan is complete (never during a scan, and never while the
// Emails step is showing: the list is hidden then), after 2 s with no input, a few maps at a time. Any input or scroll drops
// what has not started and waits for the next 2 s of quiet.
import { connectionsOf } from '../../domain/connections';
import { mapsToCheck } from '../../domain/related-extras';
import type { Data, Family } from '../../domain/types';
import { relatedLoader, useRelatedData } from './related-source';

export const IDLE_MS = 2000;
/** Maps asked per idle step. */
export const IDLE_BATCH = 4;

export interface IdleHost extends HTMLElement { data: Data | null; member: boolean; depsKnown: boolean }

const INPUTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

type Ric = (cb: () => void) => number;
const ric: Ric = (cb) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => cb(), { timeout: 1000 }) : window.setTimeout(cb, 0));

export class RelatedIdle {
  private timer = 0;
  private epoch = 0;
  private on = false;

  constructor(private readonly host: IdleHost) {}

  start(): void {
    if (this.on) return;
    this.on = true;
    for (const e of INPUTS) window.addEventListener(e, this.onInput, { capture: true, passive: true });
    this.arm();
  }

  stop(): void {
    this.on = false;
    for (const e of INPUTS) window.removeEventListener(e, this.onInput, { capture: true });
    clearTimeout(this.timer); this.timer = 0;
    this.epoch++;
    relatedLoader.cancelIdle();
  }

  private onInput = () => {
    this.epoch++;
    relatedLoader.cancelIdle();
    this.arm();
  };

  private arm(): void {
    clearTimeout(this.timer);
    if (this.on) this.timer = window.setTimeout(() => { const e = this.epoch; ric(() => this.step(e)); }, IDLE_MS);
  }

  /** The scan is complete, the list is on screen and the page is visible. */
  private allowed(): boolean {
    const h = this.host;
    if (!h.data || h.member || !h.depsKnown || !h.isConnected) return false;
    // A test hook: specs that check what a panel open asks for switch the pre-fetch off, so it can't answer first.
    if ((window as unknown as { __DC_RELATED_IDLE_OFF__?: boolean }).__DC_RELATED_IDLE_OFF__) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    // A hidden list (the Emails step, the scan screen) has no boxes.
    const list = h.querySelector('dc-family-row');
    if (!list || !(list as HTMLElement).getClientRects().length) return false;
    const scan = h.closest('[data-scan-state]')?.getAttribute('data-scan-state');
    return !scan || scan === 'done' || scan === 'stopped';
  }

  /** Families whose row is on screen now, then those within one more screen below (the next to be seen), in that order. */
  private onScreen(): Family[] {
    const now: Family[] = [], next: Family[] = [];
    const vh = window.innerHeight;
    for (const el of this.host.querySelectorAll<HTMLElement & { row?: { family: Family } }>('dc-family-row')) {
      const r = el.getBoundingClientRect();
      if (!el.row || r.height <= 0 || r.bottom <= 0) continue;
      if (r.top < vh) now.push(el.row.family); else if (r.top < 2 * vh) next.push(el.row.family); else break;
    }
    return [...now, ...next];
  }

  private step(epoch: number): void {
    if (!this.on || epoch !== this.epoch) return;
    if (!this.allowed()) { this.arm(); return; }
    const data = this.host.data as Data;
    useRelatedData(data);
    const batch: string[] = [];
    for (const f of this.onScreen()) {
      for (const m of mapsToCheck(connectionsOf(data, f)).maps) {
        if (batch.length >= IDLE_BATCH) break;
        if (!batch.includes(m) && !relatedLoader.result(m) && !relatedLoader.isPending(m)) batch.push(m);
      }
      if (batch.length >= IDLE_BATCH) break;
    }
    if (!batch.length) { this.arm(); return; } // nothing left on screen: look again after the next quiet spell
    void relatedLoader.load(batch, 'idle').then(() => { if (this.on && epoch === this.epoch) ric(() => this.step(epoch)); });
  }
}
