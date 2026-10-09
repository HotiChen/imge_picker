// Browser suites: the photo viewers follow the VISIBLE area of the page (visualViewport), not the layout viewport, so on
// iOS Chrome / LINE the top bar no longer cuts off the ✕ and the bottom bar no longer covers the footer when the
// browser toolbars come and go (js/visual-viewport.js sets --vv-top / --vv-h; css/styles.css reads them).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { BIG_PHOTO, MOBILE } from '../lib/env.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// (an initScript is serialised into the page, so each one is written out in full)
// a visualViewport the test can move: toolbars showing = offset down and shorter
const FAKE_VV = () => {
  const vv = new EventTarget();
  Object.assign(vv, { offsetTop: 0, offsetLeft: 0, scale: 1 });
  // until a test moves it, the visible area is the whole window (read when asked: the window is not laid out yet here)
  let h = null;
  Object.defineProperty(vv, 'height', { get: () => (h === null ? window.innerHeight : h), set: v => { h = v; } });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__vv = vv;
  localStorage.setItem('pick_key:TOK', 'LIA-KEY');
};
const NO_VV = () => {
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
  localStorage.setItem('pick_key:TOK', 'LIA-KEY');
};
const world = () => pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', photos: PHOTOS(2), image: BIG_PHOTO });
const box = page => page.evaluate(() => { const r = document.getElementById('photoModal').getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; });
const move = (page, patch) => page.evaluate(p => { Object.assign(window.__vv, p); window.__vv.dispatchEvent(new Event('resize')); }, patch);

{
  const m = world();
  await suite('visual viewport — the photo modal sits inside the visible area and follows it when the toolbars come and go',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const full = await page.evaluate(() => window.innerHeight);
      let b = await box(page);
      ok('with the toolbars away it fills the screen (top 0, full height)', b.top === 0 && Math.abs(b.h - full) <= 1, JSON.stringify([b, full]));
      await move(page, { offsetTop: 70, height: full - 70 - 90 });
      b = await box(page);
      ok('toolbars showing (70px top, 90px bottom): the modal starts at 70 and is 160px shorter', b.top === 70 && Math.abs(b.h - (full - 160)) <= 1, JSON.stringify([b, full]));
      await page.waitForTimeout(150);
      const fit = await page.evaluate(() => { const cv = document.getElementById('photoCanvas'), ct = cv.parentElement; return { canvasH: cv.height, boxH: ct.clientHeight, canvasW: cv.width, boxW: ct.clientWidth }; });
      ok('the photo canvas was re-measured for the smaller modal (its size equals its container)', fit.canvasH === fit.boxH && fit.canvasW === fit.boxW && fit.boxH > 0, JSON.stringify(fit));
      const x = await page.evaluate(() => { const c = document.getElementById('closeModal'); const r = c && c.getBoundingClientRect(); return { exists: !!c, top: r ? Math.round(r.top) : null }; });
      ok('the ✕ (#closeModal) is therefore not above the visible area (positive: it exists)', x.exists && x.top >= 70, JSON.stringify(x));
      await move(page, { offsetTop: 0, height: full });
      b = await box(page);
      ok('toolbars gone again: back to the full screen', b.top === 0 && Math.abs(b.h - full) <= 1, JSON.stringify([b, full]));
      // a pinch-zoomed page reports a smaller visual viewport: the modal must not shrink to it
      await move(page, { scale: 2, offsetTop: 40, height: Math.round(full / 2) });
      b = await box(page);
      ok('while the page itself is pinch-zoomed the modal keeps its size', b.top === 0 && Math.abs(b.h - full) <= 1, JSON.stringify([b, full]));
      return out;
    },
    { before: m.attach, initScript: FAKE_VV, contextOptions: MOBILE });
}

{
  const m = world();
  await suite('visual viewport — a browser without it keeps the plain full-screen modal',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const full = await page.evaluate(() => window.innerHeight);
      const b = await box(page);
      ok('no visualViewport: top 0 and the full height, no errors', b.top === 0 && Math.abs(b.h - full) <= 1 && (await page.evaluate(() => window.visualViewport === undefined)), JSON.stringify([b, full]));
      return out;
    },
    { before: m.attach, initScript: NO_VV, contextOptions: MOBILE });
}

{
  const files = Array.from({ length: 4 }, (_, i) => `shoot/精修/f${String(i + 1).padStart(3, '0')}.jpg`);
  const m = pickFakeWorker({
    ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: ['shoot/毛片/a.jpg', ...files], title: '婚禮精修',
    studio: { name: '光影工作室', booking_url: null, has_logo: true }, image: BIG_PHOTO });
  await suite('visual viewport — the finals lightbox follows the visible area too',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      await page.locator('.fg-tile').first().click();
      await page.waitForSelector('#fgLightbox', { timeout: 3000 });
      const full = await page.evaluate(() => window.innerHeight);
      const rect = () => page.evaluate(() => { const r = document.getElementById('fgLightbox').getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; });
      let b = await rect();
      ok('toolbars away: full screen', b.top === 0 && Math.abs(b.h - full) <= 1, JSON.stringify([b, full]));
      await move(page, { offsetTop: 70, height: full - 160 });
      b = await rect();
      ok('toolbars showing: it starts at 70 and is 160px shorter', b.top === 70 && Math.abs(b.h - (full - 160)) <= 1, JSON.stringify([b, full]));
      return out;
    },
    { before: m.attach, initScript: FAKE_VV, contextOptions: MOBILE });
}
}
