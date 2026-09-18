// Runs the browser-based book-editor tests.
//
//   node book_editor/test/run.mjs
//
// Needs Playwright's chromium (npx playwright install chromium). Serves the
// repo on a throwaway port so the test page can load layouts.js the same way
// the real pages do.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  // strip the query and refuse to escape the repo
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// prefer a local install; fall back to a global one, which is how it is
// available on some machines
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch { /* try a global install next */ }
  try {
    const { execSync } = await import('node:child_process');
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(join(root, 'playwright', 'index.mjs'));
  } catch {
    return null;
  }
}

const pw = await loadPlaywright();
if (!pw) {
  console.error('playwright not found — run: npm i -D playwright && npx playwright install chromium');
  server.close();
  process.exit(2);
}
const { chromium } = pw;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));

await page.goto(`${base}/book_editor/test/crop-geometry.test.html`, { waitUntil: 'load' });
const results = await page.evaluate(() => window.runTests());

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
}
if (pageErrors.length) {
  failed++;
  console.log('\npage errors: ' + pageErrors.join(' | '));
}
console.log(`\n${results.length - failed} / ${results.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
