import { createRequest } from '../scan/request';
import { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import { accessMode, type AccessMode } from './access';
import { CLIENT_ID, PORTAL_URL, redirectUri } from './config';
import { buildMayOptIn } from './sending';
import { oauthErrorMessage, parseOAuthError } from './oauth-error';
import { clearUnlocks } from '../ui/emails/unlock';

const SESSION_KEY = 'decluttering:session';
const SETTINGS_PREFIX = 'decluttering:';
const RETURN_KEY = 'decluttering:return-to';

export interface AccessInfo {
  mode: AccessMode;
  username: string;
  fullName: string;
  orgName: string;
  orgId: string;
  role: string;
  usageReadable: boolean;
  /** ADR 0013: true only when this build lets an admin in this org turn sending on (VITE_SENDING). False means nothing may be sent or created. */
  writable: boolean;
  /** The org's URL key and custom base URL host (portals/self), for links to items and people in the admin's own org. */
  urlKey?: string;
  customBaseUrl?: string;
  /** The user's profile picture file name from `portals/self` (DC-098), if they set one. Fetch it with `fetchUserThumbnail`. */
  thumbnail?: string;
  /** DC-121: the profile email from `portals/self`. Absent = the portal didn't say (unknown, nothing is blocked); '' = none on file. */
  email?: string;
  /** ADR 0015: the user's and the org's ArcGIS Online `culture` (portals/self), e.g. "es-MX", for the app's language. */
  culture?: string;
  orgCulture?: string;
}

export type ReturnResult =
  | { kind: 'none' }
  | { kind: 'signed-in'; manager: ArcGISIdentityManager }
  | { kind: 'error'; message: string };

function oauthOptions() {
  return { clientId: CLIENT_ID, redirectUri: redirectUri(), portal: `${PORTAL_URL}/sharing/rest`, pkce: true, popup: false } as const;
}

/** A same-origin relative path only: starts with one `/`, no `//`, no backslash or control characters. */
export function isSafeReturnPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return false;
  if (p.includes('\\') || [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  try { return new URL(p, window.location.origin).origin === window.location.origin; } catch { return false; }
}

/**
 * Redirect flow with PKCE (no popup). Leaves the page. The only registered redirect URI is the app root, so a page
 * elsewhere on this origin (prototype D's live mode) passes `returnTo`; the app root sends the tab back there after
 * sign-in. Without it, any earlier return-to is cleared.
 */
export function beginSignIn(returnTo?: string): void {
  try {
    if (returnTo && isSafeReturnPath(returnTo)) sessionStorage.setItem(RETURN_KEY, returnTo);
    else sessionStorage.removeItem(RETURN_KEY);
  } catch { /* storage unavailable: sign-in still lands on the app root */ }
  ArcGISIdentityManager.beginOAuth2(oauthOptions());
}

/** Reads and clears the stored return-to path. Returns it only if it is still a safe same-origin path. */
export function takeReturnTo(): string | null {
  let p: string | null;
  try { p = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { return null; }
  return isSafeReturnPath(p) ? p : null;
}

/** Restores a session kept for this tab only. Tokens never touch localStorage. */
export function loadSession(): ArcGISIdentityManager | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const m = ArcGISIdentityManager.deserialize(raw);
    if (m.tokenExpires.getTime() > Date.now()) return m;
    sessionStorage.removeItem(SESSION_KEY); // expired: don't keep the tokens around
    return null;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(m: ArcGISIdentityManager): void {
  sessionStorage.setItem(SESSION_KEY, m.serialize());
}

/**
 * True when this load is the redirect back from ArcGIS sign-in (a code or an OAuth error in the query). Synchronous,
 * so the first paint can show "Signing you in…" instead of the landing page (DC-088, FB-37).
 */
export function isOAuthReturn(search: string = window.location.search): boolean {
  const p = new URLSearchParams(search);
  return p.has('code') || p.has('error');
}

/** Call once on load: finishes an OAuth redirect if there is one and tidies the URL. */
export async function handleRedirect(): Promise<ReturnResult> {
  const search = window.location.search;
  if (!isOAuthReturn(search)) return { kind: 'none' };
  const err = parseOAuthError(search);
  const clean = `${window.location.pathname}${window.location.hash}`;
  try {
    if (err) throw Object.assign(new Error(err.description || err.error), { code: err.error });
    const manager = await ArcGISIdentityManager.completeOAuth2(oauthOptions());
    saveSession(manager);
    return { kind: 'signed-in', manager };
  } catch (e) {
    return { kind: 'error', message: oauthErrorMessage(e) };
  } finally {
    window.history.replaceState(null, '', clean);
  }
}

/**
 * The only two org calls in this app so far: `portals/self`, then a one-day `portals/self/usage` probe.
 * Both are reads (usage is a POST by Esri's design).
 */
export async function loadAccess(manager: ArcGISIdentityManager): Promise<AccessInfo> {
  // Both calls go through the same read-only guard as the scan (src/scan/request.ts).
  const call = createRequest(manager, { portal: PORTAL_URL });
  const self = await call('portals/self', {}, { method: 'GET' }) as {
    id?: string; name?: string; urlKey?: string; customBaseUrl?: string; culture?: string | null;
    user?: { username?: string; fullName?: string; role?: string; privileges?: string[]; thumbnail?: string | null; email?: string | null; culture?: string | null };
  };
  let usageReadable = false;
  try {
    const end = Date.now();
    await call('portals/self/usage', { vars: 'num', groupby: 'name', etype: 'svcusg', stype: 'features', period: '1d', startTime: end - 864e5, endTime: end }, { method: 'POST' });
    usageReadable = true;
  } catch { /* not readable: stays false */ }
  const u = self.user ?? {};
  return {
    mode: accessMode(u.privileges ?? [], usageReadable),
    username: u.username ?? manager.username,
    fullName: u.fullName ?? u.username ?? manager.username,
    orgName: self.name ?? '',
    orgId: self.id ?? '',
    role: u.role ?? '',
    usageReadable,
    writable: buildMayOptIn(self.id ?? ''),
    ...(self.urlKey ? { urlKey: self.urlKey } : {}),
    ...(self.customBaseUrl ? { customBaseUrl: self.customBaseUrl } : {}),
    ...(u.thumbnail ? { thumbnail: u.thumbnail } : {}),
    ...('email' in u ? { email: (u.email ?? '').trim() } : {}),
    ...(u.culture ? { culture: u.culture } : {}),
    ...(self.culture ? { orgCulture: self.culture } : {}),
  };
}

/** Where a user's profile picture lives. Never carries a token: the token goes in a header (DC-098). */
export function userThumbnailUrl(portal: string, username: string, thumbnail: string): string {
  const file = thumbnail.split('/').map(encodeURIComponent).join('/');
  return `${portal.replace(/\/+$/, '')}/sharing/rest/community/users/${encodeURIComponent(username)}/info/${file}`;
}

export interface ThumbnailDeps {
  portal?: string;
  fetchFn?: typeof fetch;
  createUrl?: (b: Blob) => string;
  signal?: AbortSignal;
}

/**
 * DC-098: fetches the signed-in user's profile picture with the token in the `X-Esri-Authorization` header (never in the
 * URL, so it can't leak into history, logs or a Referer) and returns a `blob:` URL for `<img>`. The caller revokes it on
 * sign out. Returns null when there is no picture or anything fails; the avatar then shows initials.
 */
export async function fetchUserThumbnail(
  manager: Pick<ArcGISIdentityManager, 'getToken'>, user: { username: string; thumbnail?: string }, deps: ThumbnailDeps = {},
): Promise<string | null> {
  if (!user.thumbnail || !user.username) return null;
  const url = userThumbnailUrl(deps.portal ?? PORTAL_URL, user.username, user.thumbnail);
  try {
    const token = await manager.getToken(url);
    const res = await (deps.fetchFn ?? fetch)(url, {
      method: 'GET', headers: { 'X-Esri-Authorization': `Bearer ${token}` },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: deps.signal,
    });
    // ArcGIS answers some errors with 200 and JSON, so only an image counts.
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    const blob = await res.blob();
    return deps.createUrl ? deps.createUrl(blob) : URL.createObjectURL(blob);
  } catch { return null; }
}

/**
 * Clears this tab's session; optionally the saved data too (ADR 0009). With `manager`, its refresh token (or access token)
 * is also revoked at ArcGIS Online (one POST, token in the body), so a copy of it stops working too. That call is never
 * awaited: signing out stays instant and works offline.
 */
export async function signOut(opts: { clearData: boolean }, manager?: Pick<ArcGISIdentityManager, 'signOut'> | null): Promise<void> {
  sessionStorage.removeItem(SESSION_KEY);
  clearUnlocks(); // DC-125b: the test-first unlock ends with the session, whatever the data choice
  if (typeof manager?.signOut === 'function') {
    try { void manager.signOut().catch(() => { /* already expired or offline: the local session is gone anyway */ }); } catch { /* same */ }
  }
  if (!opts.clearData) return;
  for (const k of Object.keys(localStorage)) if (k.startsWith(SETTINGS_PREFIX)) localStorage.removeItem(k);
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const d of dbs) if (d.name?.startsWith('decluttering')) indexedDB.deleteDatabase(d.name);
  } catch { /* best effort */ }
}
