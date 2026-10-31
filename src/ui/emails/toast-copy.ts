// DC-121: the words on the "Send a test to me" toast, in one pure place. ArcGIS Online says success whether or not the
// recipient has a usable address, so the toast says where the test was sent and what to do if it doesn't turn up.
import { onLocaleChange, t } from '../../i18n';

export interface ToastCopy { title: string; message: string }

/** DC-125b: added to the test toast when this test is what just unlocked sending to owners. */
export let UNLOCKED_LINE = 'Looks good? Sending to owners is now unlocked for this session.';
onLocaleChange(() => { UNLOCKED_LINE = t('emails.unlock.line'); });
const unlockedLine = (): string => t('emails.unlock.line');

export function testToast(address: string | undefined, ownerFirstName: string, opts: { unlocked?: boolean } = {}): ToastCopy {
  const to = address?.trim();
  const more = opts.unlocked ? ` ${unlockedLine()}` : '';
  if (!to) return { title: t('emails.test.title.blank'), message: t('emails.test.message.blank', { name: ownerFirstName, more }) };
  return {
    title: t('emails.test.title.address'),
    message: t('emails.test.message.address', { address: to, more }),
  };
}

/**
 * TC4 (2026-10-22): ArcGIS's COM_1132 "Unable to send notification." covers several refusals, and the reason is only in
 * `response.error.details` (docs/research/agol-notify-usage.md). Say what it means in plain words.
 */
export function sendErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message === 'ArcGIS Online did not answer in time') return t('emails.demo.error.once');
  const details = (err as { response?: { error?: { details?: unknown } } }).response?.error?.details;
  const said = Array.isArray(details) ? details.map(String).filter(Boolean).join(' ') : '';
  if (/invalid links?/i.test(said)) {
    return t('emails.error.links');
  }
  if (/not allowed to receive/i.test(said)) {
    return t('emails.error.receive');
  }
  if (said) return t('emails.error.details', { details: said });
  return err.message;
}
