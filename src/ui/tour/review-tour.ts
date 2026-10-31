// DC-113 (FB-69): the Review tour, built on Driver.js (MIT, ~7.5 kB gzip). Lazy-loaded: nothing here is in the main chunk.
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import '../../styles/tour.css';
import { stepsFor, type TourStep } from './steps';
import { markSeen, writeMark } from './rule';
import { t } from '../../i18n';

const visible = (el: Element): boolean => (el as HTMLElement).getClientRects().length > 0;
const find = (s: TourStep): HTMLElement | null => {
  for (const el of document.querySelectorAll(s.selector)) if (visible(el)) return el as HTMLElement;
  return null;
};

let active: Driver | null = null;

/** Starts the tour on the steps whose target is on screen. Returns false when there is nothing worth showing (fewer than two steps). */
export function startReviewTour(opts: { solo: boolean; onEnd?: () => void }): boolean {
  if (active?.isActive()) return true;
  const steps = stepsFor({ solo: opts.solo }).filter((s) => find(s));
  if (steps.length < 2) return false;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const d: Driver = driver({
    animate: !calm, smoothScroll: false, allowClose: true, allowKeyboardControl: true,
    showProgress: true, progressText: t('tour.progress'), nextBtnText: t('tour.next'), prevBtnText: t('tour.back'), doneBtnText: t('tour.done'), closeBtnLabel: t('tour.skip'),
    stagePadding: 6, stageRadius: 8, overlayOpacity: 0.55, popoverClass: 'dc-tour', disableActiveInteraction: true,
    steps: steps.map((s) => ({ element: () => find(s) ?? document.body, popover: { title: s.title, description: s.text, side: s.side, align: 'start' as const } })),
    onPopoverRender: (pop) => {
      const row = document.createElement('div');
      row.className = 'dc-tour-exits';
      const mk = (label: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.addEventListener('click', onClick);
        row.append(b);
      };
      mk(t('tour.skipButton'), () => { markSeen(); d.destroy(); }); // destroy() skips onDestroyStarted, so the choice is written here
      mk(t('tour.dontShowAgain'), () => { writeMark('never'); d.destroy(); });
      pop.wrapper.append(row);
    },
    // Every way out (Done, Skip, the close cross, Escape, a click outside) ends up here.
    onDestroyStarted: () => { markSeen(); d.destroy(); },
    onDestroyed: () => { active = null; window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' }); opts.onEnd?.(); },
  });
  active = d;
  markSeen(); // once started it counts as seen, so a reload mid-tour does not start it again
  d.drive();
  return true;
}

export function stopReviewTour(): void { active?.destroy(); }
