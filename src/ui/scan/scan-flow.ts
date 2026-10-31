// DC-064: the scan screen's flow, as a pure state machine (no DOM), so app-root only follows it.
//
//   scanning --core--> background --finished--> done
//       |                  |  \--finished(stopped)--> stopped (opens the review: "Stop and review what we have", DC-053)
//       |                  \--review--> (same state, view review: "Review now", maps and apps carry on)
//       \--failed--> error (Stop before the core is an abort: "The scan was stopped.", with Try again)
//
// A cached revisit (ADR 0009) starts on the review (the fast path) and refreshes in the background.
// People stay on Scan until they choose: nothing here moves them to the review except their own click, a stop after the
// core, or the cached fast path.

import { t } from '../../i18n';

export type FlowState = 'idle' | 'scanning' | 'background' | 'done' | 'stopped' | 'error';
export type FlowView = 'scan' | 'review';

export interface Flow {
  state: FlowState;
  view: FlowView;
  /** The scan started from a cached result: the review was shown at once and this run is a refresh. */
  cached: boolean;
}

export type FlowEvent =
  | { type: 'start'; cached: boolean }
  /** The core is in (onData fired the first time): the review could open. */
  | { type: 'core' }
  | { type: 'finished'; stopped: boolean }
  | { type: 'failed' }
  /** The person chose "Review now" or "See what we found". */
  | { type: 'review' }
  /** The person went back to the scan screen from the review. */
  | { type: 'scan' };

export const INITIAL_FLOW: Flow = { state: 'idle', view: 'scan', cached: false };

export function nextFlow(f: Flow, e: FlowEvent): Flow {
  switch (e.type) {
    case 'start': return { state: 'scanning', view: e.cached ? 'review' : 'scan', cached: e.cached };
    case 'core': return f.state === 'scanning' ? { ...f, state: 'background' } : f;
    case 'finished':
      if (f.state !== 'scanning' && f.state !== 'background') return f;
      // A stop after the core means "review what we have"; a finished scan leaves people where they are.
      return e.stopped ? { ...f, state: 'stopped', view: 'review' } : { ...f, state: 'done' };
    // A failed refresh keeps the cached review; a failed first scan shows the error on Scan.
    case 'failed': return f.cached ? { ...f, state: 'done' } : { ...f, state: 'error', view: 'scan' };
    // Before the core there is nothing to review yet.
    case 'review': return f.state === 'scanning' || f.state === 'idle' || f.state === 'error' ? f : { ...f, view: 'review' };
    case 'scan': return { ...f, view: 'scan' };
  }
}

export interface ScanActions {
  /** The main button on Scan, or null while the core is still being read. */
  primary: { label: string; helper?: string } | null;
  /** The Stop button's label (DC-053), or null when there is nothing to stop. */
  stop: string | null;
  retry: boolean;
  /** DC-102: only when stopped: continue the scan in this session, where it left off. */
  resume?: string;
}

export const REVIEW_NOW = 'Review now';
export const REVIEW_NOW_HELPER = 'We’ll keep checking maps and apps in the background.';
export const SEE_RESULTS = 'See what we found';
export const STOP_EARLY = 'Stop scanning';
export const RESUME_SCAN = 'Resume scan';
export const STOP_KEEP = 'Stop and review what we have';

export function scanActions(state: FlowState): ScanActions {
  switch (state) {
    case 'scanning': return { primary: null, stop: t('scan.flow.stop-early'), retry: false };
    case 'background': return { primary: { label: t('scan.flow.review-now'), helper: t('scan.flow.review-helper') }, stop: t('scan.flow.stop-review'), retry: false };
    case 'done': return { primary: { label: t('scan.flow.see-results') }, stop: null, retry: false };
    case 'stopped': return { primary: { label: t('scan.flow.see-results') }, stop: null, retry: false, resume: t('scan.flow.resume') };
    case 'error': return { primary: null, stop: null, retry: true };
    default: return { primary: null, stop: null, retry: false };
  }
}
