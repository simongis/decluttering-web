import { describe, expect, it } from 'vitest';
import { APPROVAL_MESSAGE, DECLINED_MESSAGE, oauthErrorMessage, oauthMessageFor, parseOAuthError } from './oauth-error';
import { setLocale } from '../i18n';

describe('parseOAuthError', () => {
  it('reads error and description', () => {
    expect(parseOAuthError('?error=access_denied&error_description=No+way')).toEqual({ error: 'access_denied', description: 'No way' });
  });
  it('returns null on a normal return or empty query', () => {
    expect(parseOAuthError('?code=abc&state=xyz')).toBeNull();
    expect(parseOAuthError('')).toBeNull();
  });
});

describe('oauthErrorMessage', () => {
  it('always mentions app approval', () => {
    expect(oauthErrorMessage(new Error('boom'))).toContain('approve');
    expect(oauthErrorMessage(undefined)).toBe(APPROVAL_MESSAGE);
  });
});

describe('oauthMessageFor (DC-125f)', () => {
  it('localizes friendly failures in Spanish', async () => {
    await setLocale('es', false);
    try {
      expect(DECLINED_MESSAGE).toBe('No pasa nada, no se compartió nada. Vuelve a iniciar sesión cuando quieras.');
      expect(oauthMessageFor('server_error', '')).toBe('No se pudo completar el inicio de sesión. Algunas organizaciones solo permiten aplicaciones aprobadas por un administrador. Si es tu caso, la guía de la página Acerca de explica qué debes pedir. Después, vuelve a intentarlo.');
    } finally { await setLocale('en', false); }
  });
  it('treats access_denied as the person saying no, calmly, with no ArcGIS detail', () => {
    expect(oauthMessageFor('access_denied', 'The user denied access')).toBe(DECLINED_MESSAGE);
    expect(DECLINED_MESSAGE).toBe("No problem, nothing was shared. Sign in again whenever you're ready.");
    expect(oauthErrorMessage(new Error('access_denied'))).toBe(DECLINED_MESSAGE);
    // The redirect handler attaches the OAuth code, so a description from ArcGIS doesn't hide a decline.
    expect(oauthErrorMessage(Object.assign(new Error('The user denied your request.'), { code: 'access_denied' }))).toBe(DECLINED_MESSAGE);
    expect(oauthErrorMessage(Object.assign(new Error('Invalid client_id'), { code: 'invalid_request' }))).toContain('approve');
  });
  it('anything else gets the approved-apps text pointing at the About guide, with the detail in brackets', () => {
    expect(APPROVAL_MESSAGE).toContain('guide on the About page');
    expect(APPROVAL_MESSAGE).toContain('approved');
    expect(oauthMessageFor('server_error', 'Boom')).toBe(`${APPROVAL_MESSAGE} (Boom)`);
    expect(oauthMessageFor(undefined, '')).toBe(APPROVAL_MESSAGE);
    expect(oauthErrorMessage(new Error('boom'))).toBe(`${APPROVAL_MESSAGE} (boom)`);
  });
  it('invents no error code for the approved-apps block', () => {
    expect(APPROVAL_MESSAGE).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
