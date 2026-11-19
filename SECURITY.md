# Security

Please report security problems privately through GitHub's **Report a vulnerability** (Security › Advisories) on this repository, rather than in a public issue. Include steps to reproduce and what you expected.

## Design

- A browser-only app with no backend. Sign-in is ArcGIS Online OAuth 2.0 with PKCE (a public client, no secret). The token is kept in session storage for the tab, sent in request headers or bodies (never in URLs), and revoked on sign-out.
- Every ArcGIS request passes an allow-list before it is sent:
  - the scan is read-only (`src/scan/guard.ts`)
  - sending allows only the app's own hidden group (`src/notify/guard.ts`)
  - the nudge log allows only the app's own table (`src/log/guard.ts`)
  - deleting allows only an item read and a non-permanent delete of a hosted layer the signed-in user may delete (`src/remove/guard.ts`)
- Writes are refused unless sending can be turned on in this org (`VITE_SENDING`: `off`, `list` of org ids, or `opt-in`) **and** the signed-in admin has turned it on for themselves (their own hidden group exists). Sending to owners also needs a successful test to themselves in the same session. Reads of other admins' nudge logs are query-only, behind their own allow-list. Unset means off.
- The built site sets a Content Security Policy. Scripts come only from the site (plus the optional Cloudflare beacon), and data goes only to ArcGIS Online.
- The app never unshares or modifies owners' items. Deleting layers is off unless the build sets `VITE_DELETING=on`; then it deletes only what the signed-in user chooses and confirms, only what their ArcGIS Online privileges allow, and never permanently (ADR 0016). It can also remove its own group and log, and only when you ask (ADR 0012).
