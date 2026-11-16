/** Build-time sign-in settings (see .env.example). The client ID is public; PKCE has no secret. */
export const CLIENT_ID: string = import.meta.env.VITE_ARCGIS_CLIENT_ID ?? '';
/** ADR 0013: raw VITE_SENDING. Read it only through `SENDING_MODE` in ./sending (unset or junk means off). */
export const SENDING_MODE_RAW: string = import.meta.env.VITE_SENDING ?? '';
/** ADR 0016: raw VITE_DELETING. Read it only through `DELETING_MODE` in ./deleting (anything but `on` means off). */
export const DELETING_RAW: string = import.meta.env.VITE_DELETING ?? '';
/** Orgs that may opt in when VITE_SENDING=list (development and self-hosting). Ignored when it is off or opt-in. */
export const WRITABLE_ORG_IDS: string = import.meta.env.VITE_WRITABLE_ORG_IDS ?? '';
export const PORTAL_URL: string = (import.meta.env.VITE_ARCGIS_PORTAL_URL || 'https://www.arcgis.com').replace(/\/+$/, '');

/** Redirect back to this app's root, whatever origin and base path it is served from. */
export function redirectUri(loc: Pick<Location, 'origin'> = window.location): string {
  return `${loc.origin}${import.meta.env.BASE_URL}`;
}
