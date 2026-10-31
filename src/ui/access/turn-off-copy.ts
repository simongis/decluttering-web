// ADR 0013 / DC-125e: the words for turning sending off, shared by the checklist and About › App data (a separate file so the two never import each other in a loop).
/** The words, shared with About › App data so both places mean the same thing. */
import { t } from '../../i18n';

export const TURN_OFF = {
  get heading() { return t('access.turnOff.heading'); },
  get body() { return t('access.turnOff.body'); },
  get yes() { return t('access.turnOff.yes'); },
  get keep() { return t('access.turnOff.keep'); },
  get done() { return t('access.turnOff.done'); },
};
