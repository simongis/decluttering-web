/**
 * Friendly sign-in failure text. ADR 0013 decision 8: an org that restricts sign-in to approved apps may need an admin to
 * approve this one. We have not seen the error ArcGIS shows for that, so this is the fallback, not a mapped code.
 */
import { onLocaleChange, t } from '../i18n';

export let APPROVAL_MESSAGE = t('auth.oauth.approval');
export let DECLINED_MESSAGE = t('auth.oauth.declined');
onLocaleChange(() => {
  APPROVAL_MESSAGE = t('auth.oauth.approval');
  DECLINED_MESSAGE = t('auth.oauth.declined');
});

export interface OAuthReturn { error: string; description: string }

/** Reads `?error=...&error_description=...` from an OAuth redirect, or null when there is none. */
export function parseOAuthError(search: string): OAuthReturn | null {
  const p = new URLSearchParams(search);
  const error = p.get('error');
  if (!error) return null;
  return { error, description: p.get('error_description') ?? '' };
}

/** Pure mapping: `access_denied` is a calm "no problem"; anything else gets the approved-apps text, ArcGIS detail in brackets. */
export function oauthMessageFor(code: string | undefined, detail: string): string {
  if (code === 'access_denied') return t('auth.oauth.declined');
  const message = t('auth.oauth.approval');
  return detail ? `${message} (${detail})` : message;
}

export function oauthErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  // The redirect handler attaches the OAuth `code`; older callers threw the bare code as the message.
  const code = (e as { code?: unknown } | null)?.code;
  return oauthMessageFor(typeof code === 'string' ? code : detail.trim() === 'access_denied' ? 'access_denied' : undefined, detail);
}
