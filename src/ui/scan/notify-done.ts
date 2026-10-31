// DC-071b: "Tell me when it's done". Asks for Notification permission only from that click (never on load); without it,
// the tab title is the signal ("Done · Decluttering"). A notification is shown only when the tab is hidden: if the
// person is looking at the page, the page itself says it is done.

import { t } from '../../i18n';

export type NotifyChoice = 'off' | 'notify' | 'title';

/** The parts of the Notification API we use, so tests can pass a fake. */
export interface NotificationLike {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): unknown;
}

const real = (): NotificationLike | undefined =>
  (typeof Notification === 'undefined' ? undefined : (Notification as unknown as NotificationLike));

/** Call only from the button's click handler. Resolves with how we will tell them. */
export async function askToNotify(N: NotificationLike | undefined = real()): Promise<NotifyChoice> {
  if (!N) return 'title';
  if (N.permission === 'granted') return 'notify';
  if (N.permission === 'denied') return 'title';
  try { return (await N.requestPermission()) === 'granted' ? 'notify' : 'title'; } catch { return 'title'; }
}

/** At the end of the scan. Returns true when a notification was shown. */
export function notifyDone(
  choice: NotifyChoice, o: { hidden: boolean; body: string },
  N: NotificationLike | undefined = real(),
): boolean {
  if (choice !== 'notify' || !o.hidden || !N || N.permission !== 'granted') return false;
  try { new N(t('scan.notify.finished-title'), { body: o.body, tag: 'decluttering-scan' }); return true; } catch { return false; }
}

/** What the card says once they've chosen. */
export function notifyNote(choice: NotifyChoice): string {
  if (choice === 'notify') return t('scan.notify.note-notify');
  if (choice === 'title') return t('scan.notify.note-title');
  return t('scan.notify.note-off');
}
