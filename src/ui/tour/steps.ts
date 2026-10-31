// DC-113 (FB-69): the tour's steps. Copy is short and warm (docs/research/copy-pass.md): two sentences at most.
import { onLocaleChange, t } from '../../i18n';
// Targets are light-DOM elements that already exist (calcite hosts and our wrappers), so no shadow-DOM piercing is needed.

export type TourStepId = 'chart' | 'rules' | 'row' | 'tick' | 'next';

export interface TourStep {
  id: TourStepId;
  selector: string;
  title: string;
  text: string;
  side: 'top' | 'bottom' | 'left' | 'right';
  /** Only makes sense when there are people to email. */
  needsPeople?: boolean;
}

function tourSteps(): readonly TourStep[] {
  return [
    { id: 'chart', selector: '.chart-block', side: 'bottom', title: t('tour.chart.title'), text: t('tour.chart.text') },
    { id: 'rules', selector: '.dc-review-side', side: 'right', title: t('tour.rules.title'), text: t('tour.rules.text') },
    { id: 'row', selector: 'dc-owner-list [data-card] calcite-list-item', side: 'top', title: t('tour.row.title'), text: t('tour.row.text') },
    { id: 'tick', selector: 'dc-owner-list [data-card] .owner-foot', side: 'top', needsPeople: true, title: t('tour.tick.title'), text: t('tour.tick.text') },
    { id: 'next', selector: '[data-bar="review"]', side: 'top', needsPeople: true, title: t('tour.next.title'), text: t('tour.next.text') },
  ];
}

export let TOUR_STEPS: readonly TourStep[] = tourSteps();
onLocaleChange(() => { TOUR_STEPS = tourSteps(); });

/** The steps that apply: alone in the org (solo) there is no one to tick or email, so those steps go. */
export function stepsFor(opts: { solo: boolean }): TourStep[] {
  return tourSteps().filter((s) => !(opts.solo && s.needsPeople));
}
