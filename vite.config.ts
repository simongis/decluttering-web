import { loadEnv, type Plugin } from 'vite';
import { execSync } from 'node:child_process';

/** The short commit and "+" when there are uncommitted changes, for the header's version line. "unknown" outside git. */
export function gitCommit(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return sha + (dirty ? '+' : '');
  } catch { return 'unknown'; }
}
import { defineConfig } from 'vitest/config';

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/** Cloudflare Web Analytics beacon (DC-104). Build-only; adds nothing without a plain alphanumeric token. */
export function cfBeacon(token: string | undefined): Plugin {
  return {
    name: 'dc-cf-beacon',
    apply: 'build',
    transformIndexHtml() {
      if (!token || !/^[A-Za-z0-9]+$/.test(token)) return undefined;
      return [{
        tag: 'script',
        attrs: { defer: true, src: BEACON_SRC, 'data-cf-beacon': JSON.stringify({ token }) },
        injectTo: 'body',
      }];
    },
  };
}

/** The beacon is wanted only in a production build with the token set: never dev, demo, e2e, tests or forks. */
export function beaconPlugins(mode: string, env: Record<string, string | undefined>): Plugin[] {
  const token = env.VITE_CF_BEACON_TOKEN?.trim();
  return mode === 'production' && token ? [cfBeacon(token)] : [];
}

/**
 * Content Security Policy for the built app (meta tag; build only, so dev keeps Vite's inline client). Scripts come only
 * from this site (plus the Cloudflare beacon); data goes only to ArcGIS (and Cloudflare's page-view endpoint). Styles
 * allow inline because Calcite and the email preview use style attributes. `portal` adds an ArcGIS Enterprise origin.
 */
export function contentSecurityPolicy(portal?: string): string {
  let extra = '';
  try { const o = portal ? new URL(portal).origin : ''; if (o.startsWith('https://') && !/\.arcgis\.com$/i.test(o)) extra = ` ${o}`; } catch { /* not a URL: ArcGIS Online only */ }
  const arcgis = `https://*.arcgis.com${extra}`;
  return [
    "default-src 'self'",
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com https://js.arcgis.com",
    `img-src 'self' data: blob: ${arcgis}`,
    `connect-src 'self' ${arcgis} https://cloudflareinsights.com`,
    "object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-src 'none'",
  ].join('; ');
}

export function cspPlugin(portal?: string): Plugin {
  return {
    name: 'dc-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(portal) }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  return {
    base: process.env.BASE_PATH || '/',
    // The OAuth redirect is registered for port 5173 exactly. Fail loudly when it is taken instead of moving to 5174,
    // where sign-in would fail with "Invalid redirect_uri".
    server: { port: 5173, strictPort: true },
    define: { __DC_COMMIT__: JSON.stringify(gitCommit()) },
    plugins: [cspPlugin(env.VITE_ARCGIS_PORTAL_URL), ...beaconPlugins(mode, env)],
    test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'vite.config.test.ts'] },
  };
});
