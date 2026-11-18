import { defineConfig, devices } from '@playwright/test';

// Vite preview defaults to port 4173 (the dev server uses 5173). Parallel workers set E2E_PORT (e.g. 4183) so each run
// builds into its own folder and serves it on its own port, and never tests another worker's build.
const port = Number(process.env.E2E_PORT) || 4173;
const own = port !== 4173;
const outDir = own ? `dist-e2e-${port}` : 'dist';

export default defineConfig({
  testDir: 'e2e',
  testIgnore: '**/*.test.mjs', // node --test files (e.g. fence.test.mjs), not Playwright specs
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: own
      ? `npx vite build --outDir ${outDir} --emptyOutDir && npx vite preview --outDir ${outDir} --port ${port} --strictPort`
      : 'npm run build && npm run preview -- --strictPort',
    url: `http://localhost:${port}`,
    // Always build and serve this checkout: a server left on the port could be an older build, and the specs would test it.
    reuseExistingServer: false,
    timeout: 180_000,
    // ADR 0016: the specs cover deleting, so the build under test has it on whatever the local .env says.
    env: { VITE_DELETING: 'on' },
  },
});
