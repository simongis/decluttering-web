// npm run clean: removes what builds and test runs leave behind, so the next build, preview or test starts from nothing.
// dist/ (the build), dist-e2e-*/ (per-port e2e builds), test-results/ and playwright-report/, and Vite's dependency
// cache (node_modules/.vite). Stop the dev server first: it uses that cache.
import { readdirSync, rmSync } from 'node:fs';

const fixed = ['dist', 'test-results', 'playwright-report', 'node_modules/.vite'];
const builds = readdirSync('.', { withFileTypes: true }).filter((d) => d.isDirectory() && /^dist-e2e-\d+$/.test(d.name)).map((d) => d.name);
for (const p of [...fixed, ...builds]) {
  rmSync(p, { recursive: true, force: true });
  console.log(`removed ${p}`);
}
