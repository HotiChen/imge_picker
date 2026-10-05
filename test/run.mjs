// Browser-based tests, for the parts that only have meaning in a real engine:
// CSS-driven crop geometry, canvas thumbnail generation, layout, touch, themes.
//
//   node test/run.mjs
//   ONLY=<text>[|<text>…] node test/run.mjs     # just the suites whose name contains the text
//
// Needs Playwright's chromium (npx playwright install chromium). The Worker's
// own tests need none of this — run those with:
//
//   node --test "worker/test/*.test.mjs"
//
// Layout (details in test/README.md):
//   test/lib/harness.mjs   static server, chromium, suite(), the failure / ran counters
//   test/lib/*.mjs         helpers and fakes shared by more than one suite file
//   test/suites/NN-*.mjs   the suites, one topic per file; each file's default export
//                          registers its suites. Files run in file-name order.
import { readdirSync } from 'node:fs';
import { stats, ONLY, browser, server } from './lib/harness.mjs';

const SUITES_DIR = new URL('./suites/', import.meta.url);
const files = readdirSync(SUITES_DIR).filter(f => f.endsWith('.mjs')).sort();
for (const f of files) {
  const { default: register } = await import(new URL(f, SUITES_DIR));
  if (typeof register !== 'function') throw new Error(`test/suites/${f} must export default an async function that registers its suites`);
  await register();
}

await browser.close();
server.close();
// A filter that matches nothing must not read as a pass.
if (!stats.ran) { stats.failed++; console.log(`\nFAIL  ONLY=${JSON.stringify(ONLY)} matched no suite`); }
if (ONLY) console.log(`\n(ONLY=${JSON.stringify(ONLY)}: ${stats.ran} suites ran, the rest were skipped)`);
console.log(stats.failed ? `\n${stats.failed} failing` : '\nall passed');
process.exit(stats.failed ? 1 : 0);
