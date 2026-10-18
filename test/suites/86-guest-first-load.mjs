// Browser suites: a guest opening the link (index.html?t=<pick token>): a loading cover with a spinner while the
// state and the first photos are on their way (js/pick.js _boot), gone when they arrive, on an error and on
// the claim overlay; and no 系統自檢 link on a client's page (Tim 2026-10-15).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { ROOT } from '../lib/env.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const world = (o = {}) => pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['20260819/'], pickFiles: ['20260819/a.jpg', '20260819/b.jpg'], ...o });
// the page's state read is held until `release()`; `mode` 'hold' continues to the fake, 401 answers an invalid link
const heldState = (m, mode = 'hold') => {
  let release; const gate = new Promise(r => { release = r; });
  const before = async page => {
    await m.attach(page);
    await page.route('**/api/pick/state', async route => {
      if (mode === 401) { await gate; return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"x"}' }); }
      await gate; return route.fallback();
    });
  };
  return { before, release: () => release() };
};
const bootLook = page => page.evaluate(() => {
  const b = document.getElementById('guestBoot');
  if (!b) return null;
  const r = b.getBoundingClientRect(), cs = getComputedStyle(b), sp = b.querySelector('.spinner');
  return { role: b.getAttribute('role'), text: b.textContent.trim(), pos: cs.position, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight,
    spinner: !!sp && sp.getBoundingClientRect().width > 0 && getComputedStyle(sp).animationName === 'spin', top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === b || b.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)) };
});

// ── 1. the loading cover while the state is slow, gone when it arrives
for (const [label, co] of [['phone 390px', MOBILE], ['desktop 1280px', { viewport: { width: 1280, height: 900 } }]]) {
  const m = world(); const h = heldState(m);
  await suite(`guest first load (${label}) — a spinner cover while the state is slow, gone once the page is up`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#guestBoot', { timeout: 5000 });
      await page.waitForTimeout(300);
      const b = await bootLook(page);
      ok('the cover is there while the state is held: a status with a spinner and the words 載入中', !!b && b.role === 'status' && /載入中/.test(b.text) && b.spinner, JSON.stringify(b));
      ok('it covers the whole viewport and is what a tap in the middle hits', !!b && b.pos === 'fixed' && b.w >= b.vw - 1 && b.h >= b.vh - 1 && b.top, JSON.stringify(b));
      ok('control: the photo grid has not been built yet (the wait is real)', (await page.$$('.photo-card')).length === 0);
      h.release();
      await page.waitForSelector('.photo-card', { timeout: 6000 });
      await page.waitForFunction(() => !document.getElementById('guestBoot'), null, { timeout: 4000 });
      ok('once the page is up the cover is gone from the DOM, and the photos are there', (await page.$$('.photo-card')).length === 2 && (await page.$('#guestBoot')) === null);
      return out;
    },
    { before: h.before, initScript: OWNER, contextOptions: co });
}

// ── 2. an invalid link: the cover goes and the error shows; it never spins forever
{
  const m = world(); const h = heldState(m, 401);
  await suite('guest first load — an invalid link: the cover goes, the error says so',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#guestBoot', { timeout: 5000 });
      h.release();
      await page.waitForFunction(() => !document.getElementById('guestBoot'), null, { timeout: 4000 });
      const e = await page.evaluate(() => { const s = document.getElementById('emptyState'); return { shown: !!s && getComputedStyle(s).display !== 'none', text: s ? s.textContent : '' }; });
      ok('the cover is gone and the error is shown, not an endless spinner', e.shown && /連結已失效/.test(e.text), JSON.stringify(e));
      return out;
    },
    { before: h.before, initScript: OWNER, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

// ── 3. no 系統自檢 on a client's page; the photographer's page keeps it
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = world();
  await suite('guest page — no 系統自檢 link (the photographer\'s index.html still ships it)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      ok('control: index.html does carry the link (id diagLink, the wording, diagnostics.runAll)', /id="diagLink"/.test(html) && /點此進行系統自檢/.test(html) && /diagnostics\.runAll/.test(html));
      await page.waitForSelector('.photo-card', { timeout: 6000 });
      const d = await page.evaluate(() => ({ el: !!document.getElementById('diagLink'), text: /系統自檢/.test(document.body.innerText), footer: !!document.querySelector('footer.app-footer') }));
      ok('on the guest page the link is gone (not hidden) and the wording is nowhere', !d.el && !d.text, JSON.stringify(d));
      ok('control: the footer itself is still there', d.footer, JSON.stringify(d));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

}
