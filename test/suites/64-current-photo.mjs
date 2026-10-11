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
      // keyboard in the list: ↑ goes to the row above, ↓ to the row below (one column)
      await page.mouse.move(5, 5);
      await page.keyboard.press('ArrowUp');
      c = await cur(page, '.pv-list-row');
      ok('in the list ↑ moves to the row above', c.length === 1 && c[0] === ids[0], JSON.stringify(c));
      await page.keyboard.press('ArrowDown');
      c = await cur(page, '.pv-list-row');
      ok('and ↓ to the row below', c.length === 1 && c[0] === ids[1], JSON.stringify(c));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

// Keyboard: with the focus in the photo area, the arrows move the glow (and the preview pane) card by card, up/down by a
// row; Enter opens the viewer; the viewer's own arrows still flip photos.
{
  const m = pickFakeWorker({ ownerName: 'Sara', projectId: 'proj-grid', photos: PHOTOS(24) });
  for (let i = 0; i < 24; i++) m.state.selections.set(`20260819/p${i}.jpg`, { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('current photo — keyboard: the arrows move the glow through the grid (←→ one card, ↑↓ one row), the preview pane follows, Enter opens it',
    `${base}/index.html?project=proj-grid`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForTimeout(300);
      const ids = await page.$$eval('.photo-card', els => els.map(e => e.dataset.photoId));
      const cols = await page.evaluate(() => { const c = [...document.querySelectorAll('.photo-card')]; return c.filter(e => e.offsetTop === c[0].offsetTop).length; });
      ok('a floor: the grid has several columns and more than one row', cols >= 3 && ids.length > cols * 2, JSON.stringify([cols, ids.length]));
      const where = async () => { const c = await cur(page, '.photo-card'); return c.length === 1 ? ids.indexOf(c[0]) : c; };
      const previewName = () => page.textContent('#previewName');
      await page.mouse.move(5, 5);               // park the mouse so the hover does not interfere
      await page.keyboard.press('ArrowRight');
      ok('first arrow with nothing current: the first card glows', (await where()) === 0, JSON.stringify(await where()));
      await page.keyboard.press('ArrowRight');
      ok('→ moves to the next card', (await where()) === 1);
      ok('and the preview pane shows it', (await previewName()).includes(ids[1].split('/').pop()), await previewName());
      await page.keyboard.press('ArrowDown');
      ok('↓ moves down one row (same column)', (await where()) === 1 + cols, JSON.stringify([await where(), 1 + cols]));
      await page.keyboard.press('ArrowLeft');
      ok('← moves back one card', (await where()) === cols, JSON.stringify(await where()));
      await page.keyboard.press('ArrowUp');
      ok('↑ moves up one row', (await where()) === 0, JSON.stringify(await where()));
      await page.keyboard.press('ArrowUp');
      ok('↑ at the top row stays put (clamped)', (await where()) === 0);
      await page.keyboard.press('ArrowLeft');
      ok('← on the first card stays put', (await where()) === 0);
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      const w = await where();
      ok('walking far down moves the glow and the card is scrolled into view', typeof w === 'number' && w > cols * 2 && (await page.evaluate(() => { const r = document.querySelector('.photo-card.is-current').getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; })), JSON.stringify(w));
      await page.keyboard.press('Control+ArrowLeft');
      ok('a key with a modifier is not ours', (await where()) === w);
      // Enter on a focused button is that button's own: it must not open the viewer
      await page.evaluate(() => { const b = document.createElement('button'); b.id = 'fake-btn'; b.textContent = 'x'; window.__btnClicks = 0; b.addEventListener('click', () => { window.__btnClicks++; }); document.body.appendChild(b); b.focus(); });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      ok('Enter on a focused button clicks that button and does not open the viewer', (await page.evaluate(() => window.__btnClicks)) === 1 && !(await page.evaluate(() => document.getElementById('photoModal').classList.contains('active'))));
      await page.evaluate(() => document.getElementById('fake-btn').remove());
      // ... also when the button sits inside the grid (the guest's ♥ is one)
      await page.evaluate(() => { const b = document.createElement('button'); b.id = 'fake-grid-btn'; b.textContent = '♥'; window.__gridClicks = 0; b.addEventListener('click', () => { window.__gridClicks++; }); document.getElementById('photoGrid').appendChild(b); b.focus(); });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      ok('Enter on a focused button inside the grid clicks it and does not open the viewer', (await page.evaluate(() => window.__gridClicks)) === 1 && !(await page.evaluate(() => document.getElementById('photoModal').classList.contains('active'))));
      await page.evaluate(() => { document.getElementById('fake-grid-btn').remove(); document.activeElement.blur(); });
      await page.keyboard.press('Enter');
      await page.waitForSelector('#photoModal.active', { timeout: 3000 });
      ok('Enter opens the viewer on the glowing photo', (await page.textContent('#modalPhotoName')).includes(ids[w].split('/').pop()), await page.textContent('#modalPhotoName'));
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      ok('in the viewer ↓ goes to the next photo (like →) and the glow follows', (await where()) === w + 1, JSON.stringify(await where()));
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
      ok('↑ goes back', (await where()) === w);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('photoModal').classList.contains('active'), null, { timeout: 3000 });
      // a <select> that has the focus keeps its own arrows
      const before = await where();
      await page.evaluate(() => { const sel = document.createElement('select'); sel.id = 'fake-select'; sel.innerHTML = '<option>a</option><option>b</option>'; document.body.appendChild(sel); sel.focus(); });
      await page.keyboard.press('ArrowRight');
      ok('with a <select> focused the arrows do not move the grid', (await where()) === before, JSON.stringify([await where(), before]));
      await page.evaluate(() => document.getElementById('fake-select').remove());
      // a dialog on screen owns the arrows: the grid behind it does not move
      await page.evaluate(() => { const d = document.createElement('div'); d.className = 'picker-overlay'; d.id = 'fake-dialog'; document.body.appendChild(d); });
      await page.keyboard.press('ArrowRight');
      ok('with a dialog open the arrows do not move the grid behind it', (await where()) === before, JSON.stringify([await where(), before]));
      await page.evaluate(() => document.getElementById('fake-dialog').remove());
      // and at the very end it stops on the last photo
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
      ok('past the last photo the glow stays on the last one (no error)', (await where()) === ids.length - 1, JSON.stringify([await where(), ids.length - 1]));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1500, height: 950 } } });
}
}
