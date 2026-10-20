// Browser suites: guest picking by keyboard — Space toggles the ♥ of "the current photo" (js/app.js _spacePick),
// in the grid and in the enlarged view, through the same click path as the mouse.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const OWNER = { ownerName: 'Rhea', ownerKey: 'RHEA-KEY' };
const KEY0 = '20260819/p0.jpg', KEY1 = '20260819/p1.jpg';
// init scripts are serialised into the page, so they must not use closures
const OWNER_INIT = () => {
  localStorage.setItem('pick_key:TOK', 'RHEA-KEY');
  // after the app's own (document) keydown handler: was this Space prevented / a key repeat?
  window.__space = [];
  window.addEventListener('keydown', e => { if (e.key === ' ') window.__space.push({ prevented: e.defaultPrevented, repeat: e.repeat }); });
};
const WATCH_INIT = () => {
  window.__space = [];
  window.addEventListener('keydown', e => { if (e.key === ' ') window.__space.push({ prevented: e.defaultPrevented, repeat: e.repeat }); });
};
const ADMIN_WATCH_INIT = () => {
  sessionStorage.setItem('studio_token', 'adm');
  window.__space = [];
  window.addEventListener('keydown', e => { if (e.key === ' ') window.__space.push({ prevented: e.defaultPrevented, repeat: e.repeat }); });
};
const puts = m => m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
const heartOn = (page, i) => page.locator('.photo-card').nth(i).locator('.pick-heart-btn.on').count();
const settle = page => page.waitForTimeout(1300); // autosave debounce is 800ms
const spaceLog = page => page.evaluate(() => window.__space);

{
  const m = pickFakeWorker(OWNER);
  await suite('space pick — grid: Space on the current card picks it exactly like a click on ♥, a second Space un-picks',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive control: 3 cards, each with a real ♥ button, none picked yet',
        await page.locator('.photo-card button.pick-heart-btn').count() === 3 && await heartOn(page, 0) === 0);

      // no current photo yet: Space is not ours
      await page.keyboard.press('Space');
      await settle(page);
      const log = await spaceLog(page);
      ok('no current photo: Space is not handled (not preventDefault-ed) and nothing is written',
        log.length === 1 && log[0].prevented === false && puts(m).length === 0 && await heartOn(page, 0) === 0, JSON.stringify([log, puts(m).length]));

      await page.keyboard.press('ArrowRight'); // current = first card, focus moves onto it
      ok('the first card is the current one and has focus (a card, not a button)',
        await page.evaluate(() => { const c = document.querySelector('.photo-card'); return c.classList.contains('is-current') && document.activeElement === c; }));
      await page.keyboard.press('Space');
      ok('Space puts the ♥ on (button class .on) and the card gets pick-picked', await heartOn(page, 0) === 1 &&
        await page.locator('.photo-card').first().evaluate(c => c.classList.contains('pick-picked')));
      ok('Space was preventDefault-ed (the page must not scroll)', (await spaceLog(page)).pop().prevented === true);
      await settle(page);
      ok('one PUT, rating 1 for the first photo',
        puts(m).length === 1 && JSON.stringify(puts(m)[0].body) === JSON.stringify({ upsert: [{ photo_key: KEY0, rating: 1, note: '' }], delete: [] }),
        JSON.stringify(puts(m).map(p => p.body)));

      // the same pick by a mouse click on the next card gives the same request shape
      await page.locator('.photo-card').nth(1).locator('.pick-heart-btn').click();
      await settle(page);
      const viaMouse = puts(m)[1] && puts(m)[1].body;
      ok('a mouse click on the next ♥ writes the same shape (only the key differs)',
        viaMouse && JSON.stringify(viaMouse).replace(KEY1, KEY0) === JSON.stringify(puts(m)[0].body), JSON.stringify(viaMouse));

      await page.mouse.move(0, 0); // the click made the next card current (hover); step back to the first by keyboard
      await page.keyboard.press('ArrowLeft');
      ok('the first card is current again', await page.evaluate(() => document.querySelector('.photo-card').classList.contains('is-current')));
      await page.keyboard.press('Space');
      await settle(page);
      ok('a second Space on the same card un-picks it', await heartOn(page, 0) === 0 &&
        !(await page.locator('.photo-card').first().evaluate(c => c.classList.contains('pick-picked'))));
      const last = puts(m)[puts(m).length - 1];
      ok('and the write names that photo and no longer upserts it at rating 1',
        puts(m).length === 3 && JSON.stringify(last.body).includes(KEY0) && !(last.body.upsert || []).some(u => u.photo_key === KEY0 && u.rating > 0),
        JSON.stringify(last && last.body));
      ok('the other card (picked by the mouse) is untouched', await heartOn(page, 1) === 1);
      return out;
    },
    { before: m.attach, initScript: OWNER_INIT });
}

{
  const m = pickFakeWorker(OWNER);
  await suite('space pick — enlarged view: Space picks the photo being shown, again un-picks; the grid ♥ follows',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      ok('positive control: the modal is open on a real ♥ button, not picked',
        await page.locator('#modalPhotoRating button.pick-heart-btn').count() === 1 && await page.locator('#modalPhotoRating .pick-heart-btn.on').count() === 0);
      await page.keyboard.press('ArrowRight'); // second photo in the viewer
      await page.waitForFunction(() => document.getElementById('modalPhotoName').textContent === 'p1.jpg', null, { timeout: 5000 });
      await page.keyboard.press('Space');
      ok('Space turns the modal ♥ on', await page.locator('#modalPhotoRating .pick-heart-btn.on').count() === 1);
      ok('preventDefault-ed', (await spaceLog(page)).pop().prevented === true);
      await settle(page);
      ok('one PUT, rating 1 for the photo shown (p1), nothing for p0',
        puts(m).length === 1 && JSON.stringify(puts(m)[0].body) === JSON.stringify({ upsert: [{ photo_key: KEY1, rating: 1, note: '' }], delete: [] }),
        JSON.stringify(puts(m).map(p => p.body)));
      await page.keyboard.press('Space');
      ok('a second Space turns it off', await page.locator('#modalPhotoRating .pick-heart-btn.on').count() === 0);
      await page.keyboard.press('Space');
      ok('and a third on again', await page.locator('#modalPhotoRating .pick-heart-btn.on').count() === 1);
      await settle(page);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      ok('closing the viewer: the grid card of p1 shows the ♥ on, p0 does not', await heartOn(page, 1) === 1 && await heartOn(page, 0) === 0);
      return out;
    },
    { before: m.attach, initScript: OWNER_INIT });
}

{
  const m = pickFakeWorker(OWNER);
  await suite('space pick — not handled: focused input / button / link, modifiers; a held Space toggles once',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.keyboard.press('ArrowRight'); // current = first card

      // a text box
      await page.evaluate(() => { const i = document.createElement('input'); i.id = 'zz-input'; document.body.appendChild(i); i.focus(); });
      await page.keyboard.press('Space');
      let log = await spaceLog(page);
      ok('focus in an <input>: not handled (not preventDefault-ed), the ♥ stays off',
        log.length === 1 && log[0].prevented === false && await heartOn(page, 0) === 0, JSON.stringify(log));
      await page.evaluate(() => document.getElementById('zz-input').remove());
      await page.evaluate(() => { const e = document.createElement('select'); e.id = 'zz-sel'; e.innerHTML = '<option>a</option>'; document.body.appendChild(e); e.focus(); });
      await page.keyboard.press('Space');
      await page.evaluate(() => document.getElementById('zz-sel').remove());
      await page.evaluate(() => { const e = document.createElement('div'); e.id = 'zz-ce'; e.contentEditable = 'true'; e.textContent = 'x'; document.body.appendChild(e); e.focus(); });
      await page.keyboard.press('Space');
      await page.evaluate(() => document.getElementById('zz-ce').remove());
      log = await spaceLog(page);
      ok('focus in a <select> and in a contenteditable: not handled either',
        log.length === 3 && log.every(l => l.prevented === false) && await heartOn(page, 0) === 0, JSON.stringify(log));

      // a button that is not a ♥: the browser's own click is not doubled by us
      await page.evaluate(() => { const b = document.createElement('button'); b.id = 'zz-btn'; b.type = 'button'; b.textContent = 'x'; window.__btn = 0; b.addEventListener('click', () => window.__btn++); document.body.appendChild(b); b.focus(); });
      await page.keyboard.press('Space');
      log = await spaceLog(page);
      ok('focus on a <button>: the button gets exactly its own click, our handler does nothing (heart stays off)',
        await page.evaluate(() => window.__btn) === 1 && log.length === 4 && log[3].prevented === false && await heartOn(page, 0) === 0, JSON.stringify(log));
      await page.evaluate(() => document.getElementById('zz-btn').remove());

      // the ♥ button itself focused: one toggle (the browser's click), not two
      await page.locator('.photo-card').first().locator('.pick-heart-btn').focus();
      await page.keyboard.press('Space');
      ok('focus on the ♥ button: Space toggles it once (the browser click), not twice', await heartOn(page, 0) === 1);
      await page.locator('.photo-card').first().locator('.pick-heart-btn').click(); // back off
      ok('(reset) off again', await heartOn(page, 0) === 0);
      await settle(page);
      const base0 = puts(m).length;

      // a link
      await page.evaluate(() => { const a = document.createElement('a'); a.id = 'zz-a'; a.href = '#zz'; a.textContent = 'l'; document.body.appendChild(a); a.focus(); });
      await page.keyboard.press('Space');
      ok('focus on a link: not handled', await heartOn(page, 0) === 0 && (await spaceLog(page)).pop().prevented === false);
      await page.evaluate(() => document.getElementById('zz-a').remove());

      // modifiers
      await page.locator('.photo-card').first().focus();
      await page.keyboard.press('Control+Space');
      await page.keyboard.press('Shift+Space');
      await page.keyboard.press('Alt+Space');
      ok('Ctrl / Shift / Alt + Space: not handled (heart stays off)', await heartOn(page, 0) === 0);

      // held key: the first keydown toggles, auto-repeats do not
      const n0 = (await spaceLog(page)).length;
      await page.evaluate(() => { window.__hc = 0; document.querySelector('.photo-card .pick-heart-btn').addEventListener('click', () => window.__hc++); });
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.up('Space');
      const after = (await spaceLog(page)).slice(n0);
      ok('held Space: three keydowns, the 2nd and 3rd flagged repeat', after.length === 3 && !after[0].repeat && after[1].repeat && after[2].repeat, JSON.stringify(after));
      ok('the ♥ is on after the hold (one toggle: three would also be on, so the write count below decides)', await heartOn(page, 0) === 1);
      await settle(page);
      ok('the ♥ was clicked exactly once during the hold (repeats do not toggle)', await page.evaluate(() => window.__hc) === 1, String(await page.evaluate(() => window.__hc)));
      ok('exactly one write for the whole hold', puts(m).length - base0 === 1, String(puts(m).length - base0));
      ok('a repeat is still preventDefault-ed (no page scroll while holding)', after[1].prevented === true && after[2].prevented === true, JSON.stringify(after));
      return out;
    },
    { before: m.attach, initScript: OWNER_INIT });
}

{
  const m = pickFakeWorker({ ownerName: 'Bob' });
  await suite('space pick — someone else’s seat (view only): Space writes nothing and is not swallowed',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive control: cards exist and carry the read-only ♥ (span), no button',
        await page.locator('.photo-card span.pick-heart-btn').count() === 3 && await page.locator('.photo-card button.pick-heart-btn').count() === 0);
      await page.keyboard.press('ArrowRight');
      ok('the first card is current', await page.locator('.photo-card.is-current').count() === 1);
      await page.keyboard.press('Space');
      await settle(page);
      ok('Space in the grid is not swallowed either (not preventDefault-ed)', (await spaceLog(page)).pop().prevented === false);
      ok('no write, the ♥ state unchanged', puts(m).length === 0 && await page.locator('.photo-card .pick-heart-btn.on').count() === 0);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.keyboard.press('Space');
      await settle(page);
      ok('in the enlarged view too: no ♥ control, no write, Space not swallowed',
        await page.locator('#modalPhotoRating .pick-heart-btn').count() === 0 && puts(m).length === 0 && (await spaceLog(page)).pop().prevented === false);
      return out;
    },
    { before: m.attach, initScript: WATCH_INIT });
}

{
  const m = pickFakeWorker({ ...OWNER, phase: 'retouching' });
  await suite('space pick — picking closed (精修中): Space gives the same notice as tapping the ♥ and writes nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive control: hearts are read-only spans', await page.locator('.photo-card span.pick-heart-btn').count() === 3);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await page.waitForSelector('#pickNoticeModal.active', { timeout: 3000 });
      ok('the 已安排精修 notice opens', (await page.locator('#pickNoticeBody').textContent()).includes('精修'));
      await settle(page);
      ok('no write, nothing picked', puts(m).length === 0 && await page.locator('.photo-card .pick-heart-btn.on').count() === 0);
      return out;
    },
    { before: m.attach, initScript: OWNER_INIT });
}

{
  const m = pickFakeWorker({ ownerName: 'Grace' });
  m.state.selections.set(KEY0, { rating: 1, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('space pick — photographer review (?project=): Space is not handled, no write',
    `${base}/index.html?project=proj-1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive control: the review view is active and shows the read-only ♥ of the pick',
        await page.evaluate(() => !!(window.ProjectViewController && ProjectViewController.active)) &&
        await page.locator('.photo-card .pick-heart-btn.on').count() === 1);
      await page.keyboard.press('ArrowRight');
      ok('a current card exists', await page.locator('.photo-card.is-current').count() === 1);
      // belt and braces: even with the guest controller flag forced on, the review view must not click anything
      await page.evaluate(() => { window.__hc = 0; window.PickController.active = true;
        document.querySelector('.photo-card.is-current .pick-heart-btn').addEventListener('click', () => window.__hc++); });
      await page.keyboard.press('Space');
      await settle(page);
      ok('the (forced) ♥ of the current card got no click', await page.evaluate(() => { const n = window.__hc; window.PickController.active = false; return n; }) === 0);
      ok('Space: not preventDefault-ed, no write, still one ♥',
        (await spaceLog(page)).pop().prevented === false && puts(m).length === 0 && await page.locator('.photo-card .pick-heart-btn.on').count() === 1);
      return out;
    },
    { before: m.attach, initScript: ADMIN_WATCH_INIT });
}

{
  const m = pickFakeWorker();
  await suite('space pick — plain studio grid (no guest link): Space is not handled',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
      await page.fill('#driveUrl', '20260819/');
      await page.click('#loadPhotosBtn');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive control: studio cards have star ratings and no ♥',
        await page.locator('.photo-card .star-rating').count() > 0 && await page.locator('.photo-card .pick-heart-btn').count() === 0);
      await page.keyboard.press('ArrowRight');
      ok('a current card exists', await page.locator('.photo-card.is-current').count() === 1);
      await page.keyboard.press('Space');
      ok('Space: not preventDefault-ed, no write',
        (await spaceLog(page)).pop().prevented === false && m.requests.filter(r => r.method === 'PUT').length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN_WATCH_INIT });
}

}
