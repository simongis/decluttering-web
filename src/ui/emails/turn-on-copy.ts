// ADR 0013: the words of the “Turn on sending” opt-in, shared with the access checklist.
import { onLocaleChange, t } from '../../i18n';

export function turnOnCopy() {
  return {
    heading: t('access.turnOn.heading'),
    points: [t('access.turnOn.point.control'), t('access.turnOn.point.group'), t('access.turnOn.point.frequency'), t('access.turnOn.point.off')],
    yes: t('access.turnOn.yes'),
    no: t('access.turnOn.no'),
    next: t('access.turnOn.next'),
  };
}

export let TURN_ON_HEADING = '';
export let TURN_ON_POINTS: readonly string[] = [];
export let TURN_ON_YES = '';
export let TURN_ON_NO = '';
export let TURN_ON_NEXT = '';

function refreshTurnOnCopy(): void {
  const copy = turnOnCopy();
  TURN_ON_HEADING = copy.heading;
  TURN_ON_POINTS = copy.points;
  TURN_ON_YES = copy.yes;
  TURN_ON_NO = copy.no;
  TURN_ON_NEXT = copy.next;
}

refreshTurnOnCopy();
onLocaleChange(refreshTurnOnCopy);
