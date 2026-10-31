import { html } from 'lit';
import { t } from '../i18n';
import type { AccessMode } from '../auth/access';

interface ModeCopy { title: string; lead: string; gets: string[] }

export const MODE_COPY: Record<AccessMode, ModeCopy> = {
  admin: {
    get title() { return t('emails.mode.admin'); },
    get lead() { return t('emails.mode.admin.lead'); },
    get gets() { return [t('emails.mode.admin.scan'), t('emails.mode.admin.review'), t('emails.mode.admin.send')]; },
  },
  'admin-cant-send': {
    get title() { return t('emails.mode.no.send'); },
    get lead() { return t('emails.mode.no.send.lead'); },
    get gets() { return [t('emails.mode.admin.scan'), t('emails.mode.admin.review'), t('emails.mode.no.send.privileges')]; },
  },
  'my-items': {
    get title() { return t('emails.mode.mine'); },
    get lead() { return t('emails.mode.mine.lead'); },
    get gets() { return [t('emails.mode.mine.rules'), t('emails.mode.mine.why'), t('emails.mode.mine.note')]; },
  },
};

export function modePlaceholder(mode: AccessMode, who: string) {
  const c = MODE_COPY[mode];
  return html`
    <section data-page="app" data-mode=${mode}>
      <h1>${t('emails.signed.in', { name: who })}</h1>
      <p>${t('emails.access')} <strong data-mode-label>${c.title}</strong></p>
      <p>${c.lead}</p>
      <p>${t('emails.get')}</p>
      <ul>${c.gets.map((g) => html`<li>${g}</li>`)}</ul>
      <p><em>${t('emails.scan.coming')}</em></p>
    </section>`;
}
