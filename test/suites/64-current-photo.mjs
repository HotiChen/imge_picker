// Browser suites: the photo the preview pane / the enlarged view is showing glows in the grid or list behind it
// (.is-current, js/app.js markCurrent), follows the arrows and the hover, survives a re-render and a switch of view, and is
// scrolled into view when the viewer navigates. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';

export default async function register() {

const cur = (page, sel) => page.evaluate(s => [...document.querySelectorAll(`${s}.is-current`)].map(e => e.dataset.photoId), sel);
const glow = (page, sel) => page.evaluate(s => { const e = document.querySelector(`${s}.is-current`); return e ? getComputedStyle(e).boxShadow : null; }, sel);

{
  const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', photos: PHOTOS(30) });
  await suite('current photo — the grid card of the photo in the enlarged view glows, follows next/prev, stays after closing, and is scrolled into view',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('nothing glows before anything is opened', (await cur(page, '.photo-card')).length === 0);
      await page.locator('.photo-card').nth(1).tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      let c = await cur(page, '.photo-card');
      const ids = await page.$$eval('.photo-card', els => els.map(e => e.dataset.photoId));
      ok('opening photo #2 makes exactly its card current', c.length === 1 && c[0] === ids[1], JSON.stringify([c, ids[1]]));
      const g = await glow(page, '.photo-card');
      ok('and it glows (a box-shadow, not just a class)', !!g && g !== 'none', String(g));
      await page.click('#nextPhotoBtn');
      await page.waitForTimeout(150);
      c = await cur(page, '.photo-card');
      ok('next moves the glow to photo #3, only one at a time', c.length === 1 && c[0] === ids[2], JSON.stringify(c));
      // walk far enough that the card would be off screen, then check it was scrolled into view
      for (let i = 0; i < 20; i++) { await page.click('#nextPhotoBtn'); await page.waitForTimeout(40); }
      await page.waitForTimeout(250);
      const vis = await page.evaluate(() => { const e = document.querySelector('.photo-card.is-current'); const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, id: e.dataset.photoId }; });
      ok('after 21 steps the current card has been scrolled into the page (inside the viewport)', vis.bottom > 0 && vis.top < vis.vh && vis.id === ids[22], JSON.stringify(vis));
      await page.click('#closeModal');
      await page.waitForTimeout(150);
      c = await cur(page, '.photo-card');
      ok('closing the viewer leaves the last photo marked, so you can see where you were', c.length === 1 && c[0] === ids[22], JSON.stringify(c));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Sara', projectId: 'proj-list' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '備註A', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('current photo — the photographer review list: the row shown in the preview glows, also after switching grid / list',
    `${base}/index.html?project=proj-list`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      ok('nothing glows yet', (await cur(page, '.pv-list-row')).length === 0);
      await page.locator('.pv-list-row').nth(1).click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const ids = await page.$$eval('.pv-list-row', els => els.map(e => e.dataset.photoId));
      let c = await cur(page, '.pv-list-row');
      ok('the opened row is current and glows', c.length === 1 && c[0] === ids[1] && (await glow(page, '.pv-list-row')) !== 'none', JSON.stringify(c));
      await page.click('#prevPhotoBtn');
      await page.waitForTimeout(150);
      c = await cur(page, '.pv-list-row');
      ok('prev moves it to the first row', c.length === 1 && c[0] === ids[0], JSON.stringify(c));
      await page.click('#closeModal');
      // switching to the grid and back re-renders: the mark is put back
      await page.click('#headerViewBtn');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForTimeout(150);
      c = await cur(page, '.photo-card');
      ok('in the grid the same photo glows after the re-render', c.length === 1 && c[0] === ids[0], JSON.stringify(c));
      // and the other way: back to the list, the row is marked again
      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      await page.waitForTimeout(150);
      c = await cur(page, '.pv-list-row');
      ok('back in the list the same row glows after the re-render', c.length === 1 && c[0] === ids[0], JSON.stringify(c));
      // the hover also moves the preview pane, and the glow follows it
      await page.locator('.pv-list-row').nth(1).hover();
      await page.waitForTimeout(300);
      c = await cur(page, '.pv-list-row');
      ok('hovering row #2 (the preview pane follows after its short delay) moves the glow there', c.length === 1 && c[0] === ids[1] && (await page.textContent('#previewName')).includes('b.jpg'), JSON.stringify(c));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}
}
