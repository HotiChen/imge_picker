// Browser suites: the seat owner's collaborator stats on the guest pick page (docs/co-picking.md "主人的協作者統計"):
// one chip per person who hearted something (我 / each collaborator / 先前的選片人), tap = only that person's hearts.
// Owner only: a collaborator and a viewer have no #pickCollabStats in the DOM. js/pick.js renderCollabStats.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';

export default async function register() {

const FUTURE = ms => new Date(Date.now() + ms).toISOString();
const D = 86400000;
const XSS = '<img src=x onerror="window.__xss=1">';
const url = `${base}/index.html?t=TOK`;
const K = i => `20260819/p${i}.jpg`;
const initKey = key => (key ? `localStorage.setItem('pick_key:TOK', ${JSON.stringify(key)});` : '');
const sel = (rating, by) => ({ rating, note: '', marks: null, updated_by: by, updated_at: '2026-01-01T00:00:00Z' });
// Lia owns picker-0; Mia = collab-1, Ben = collab-2, a second Mia = collab-3; old-1 is neither
const world = (o = {}) => {
  const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', photos: PHOTOS(8), collaborators: [
    { name: 'Mia', key: 'MIA-KEY', expires_at: FUTURE(7 * D) },
    { name: o.benName || 'Ben', key: 'BEN-KEY', expires_at: FUTURE(7 * D) },
    { name: 'Mia', key: 'MIA2-KEY', expires_at: FUTURE(7 * D) },
  ] });
  m.state.pickers.set('old-1', { id: 'old-1', name: '舊人', key: 'OLD-KEY' });
  [[0, 'picker-0'], [1, 'picker-0'], [2, 'picker-0'], [3, 'collab-1'], [4, 'collab-1'], [5, 'collab-2'], [6, 'old-1'], [7, 'collab-3']]
    .forEach(([i, by]) => m.state.selections.set(K(i), sel(1, by)));
  return m;
};
const chips = page => page.$$eval('#pickCollabStats [data-collab-key]', els => els.map(e => ({
  text: e.textContent.trim(), key: e.dataset.collabKey, pressed: e.getAttribute('aria-pressed'), active: e.classList.contains('active') })));
const texts = async page => (await chips(page)).map(c => c.text);
const grid = async page => (await page.$$eval('.photo-card[data-photo-id]', els => els.map(e => e.dataset.photoId)))
  .map(k => Number(k.match(/p(\d+)/)[1])).sort((a, b) => a - b);
const ready = async page => { await page.waitForSelector('.photo-card', { timeout: 5000 }); await page.waitForTimeout(150); };
const tap = async (page, text) => {
  const c = (await chips(page)).find(x => x.text.startsWith(text));
  await page.click(`#pickCollabStats [data-collab-key="${c.key}"]`);
  await page.waitForTimeout(250);
  return c;
};
const filterActive = (page, mode) => page.evaluate(m => document.querySelector(`#pickFilterBar [data-pick-filter="${m}"]`).classList.contains('active'), mode);

// ── 1. owner: chips, order, counts, same-name collaborators distinct, filter, clear (desktop) ──
{
  const m = world();
  await suite('owner collab stats — chips 我 3 / Ben 1 / Mia 2 / Mia (2) 1 / 先前的選片人 1; tap filters to that person, tap again or 全部 clears', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('chips: owner first, collaborators by name, the same name gets (2), 先前的選片人 last',
        JSON.stringify(await texts(page)) === JSON.stringify(['我 3', 'Ben 1', 'Mia 2', 'Mia (2) 1', '先前的選片人 1']), JSON.stringify(await texts(page)));
      const cs = await chips(page);
      ok('five distinct keys (two Mias stay apart)', new Set(cs.map(c => c.key)).size === 5, JSON.stringify(cs));
      ok('none pressed at first', cs.every(c => c.pressed === 'false' && !c.active));
      ok('the stats sit inside the filter bar (moves with it between sidebar and #guestBar)', await page.evaluate(() => !!document.querySelector('#pickFilterBar #pickCollabStats')));
      const mia = await tap(page, 'Mia 2');
      ok('Mia (collab-1) chip: only her hearted photos p3 p4', JSON.stringify(await grid(page)) === '[3,4]', JSON.stringify(await grid(page)));
      const after = await chips(page);
      ok('that chip is marked (aria-pressed + active), the others are not', after.filter(c => c.pressed === 'true' && c.active).length === 1 && after.find(c => c.key === mia.key).pressed === 'true');
      ok('none of 全部/已選/未選 shows as active while a person is chosen', await page.evaluate(() => document.querySelectorAll('#pickFilterBar [data-pick-filter].active').length === 0));
      await page.click(`#pickCollabStats [data-collab-key="${mia.key}"]`);
      await page.waitForTimeout(250);
      ok('tapping again clears: all 8 photos, 全部 active, chip unpressed', (await grid(page)).length === 8 && await filterActive(page, 'all') && (await chips(page)).every(c => c.pressed === 'false'), JSON.stringify(await grid(page)));
      await tap(page, '我');
      ok('我 chip: p0 p1 p2', JSON.stringify(await grid(page)) === '[0,1,2]', JSON.stringify(await grid(page)));
      await tap(page, 'Mia (2)');
      ok('switching straight to the other Mia: only p7', JSON.stringify(await grid(page)) === '[7]', JSON.stringify(await grid(page)));
      await page.click('#pickFilterBar [data-pick-filter="selected"]');
      await page.waitForTimeout(250);
      ok('the existing 已選 clears the person filter: all 8 hearts, chip unpressed, 已選 active',
        (await grid(page)).length === 8 && (await chips(page)).every(c => c.pressed === 'false') && await filterActive(page, 'selected'));
      await tap(page, '先前');
      ok('先前的選片人 chip: p6 only', JSON.stringify(await grid(page)) === '[6]', JSON.stringify(await grid(page)));
      await page.click('#pickFilterBar [data-pick-filter="all"]');
      await page.waitForTimeout(250);
      ok('全部 clears it: 8 photos, no chip pressed, 全部 active', (await grid(page)).length === 8 && (await chips(page)).every(c => c.pressed === 'false') && await filterActive(page, 'all'));
      await tap(page, 'Ben');
      await page.click('#pickFilterBar [data-pick-filter="unselected"]');
      await page.waitForTimeout(250);
      ok('未選 after a person filter clears it (every photo is hearted -> 0 cards), chips unpressed', (await grid(page)).length === 0 && (await chips(page)).every(c => c.pressed === 'false') && await filterActive(page, 'unselected'), JSON.stringify(await grid(page)));
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}

// ── 2. counts follow the owner's own heart and a state re-read; the filter follows too ──
{
  const m = world();
  await suite('owner collab stats — 我 N follows my heart/un-heart, a re-read moves counts, a chip whose person drops to 0 disappears (and its filter ends)', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('start: 我 3', (await texts(page))[0] === '我 3', JSON.stringify(await texts(page)));
      await page.locator(`.photo-card[data-photo-id="${K(0)}"] button.pick-heart-btn`).click();
      await page.waitForTimeout(200);
      ok('un-heart p0: 我 2', (await texts(page))[0] === '我 2', JSON.stringify(await texts(page)));
      await page.locator(`.photo-card[data-photo-id="${K(6)}"] button.pick-heart-btn`).click();
      await page.waitForTimeout(200);
      ok('un-heart p6 (先前的選片人 had it): that chip is gone', !(await texts(page)).some(t => t.startsWith('先前')), JSON.stringify(await texts(page)));
      await page.locator(`.photo-card[data-photo-id="${K(6)}"] button.pick-heart-btn`).click();
      await page.waitForTimeout(200);
      ok('heart p6 again: it is MINE now, 我 3, still no 先前的選片人', (await texts(page))[0] === '我 3' && !(await texts(page)).some(t => t.startsWith('先前')), JSON.stringify(await texts(page)));
      await tap(page, 'Ben');
      ok('Ben filter: p5', JSON.stringify(await grid(page)) === '[5]', JSON.stringify(await grid(page)));
      m.state.selections.delete(K(5));
      m.state.selections.set(K(3), sel(1, 'collab-2'));   // Ben takes over p3 from Mia
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(300);
      const t1 = await texts(page);
      ok('after the re-read: Ben 1 (now p3), Mia 1 (p4)', t1.includes('Ben 1') && t1.includes('Mia 1'), JSON.stringify(t1));
      ok('and the Ben filter shows his new photo p3', JSON.stringify(await grid(page)) === '[3]', JSON.stringify(await grid(page)));
      m.state.selections.delete(K(3));
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(300);
      ok('Ben has nothing left: his chip is gone and the grid is back to all hearts (not an empty grid)',
        !(await texts(page)).some(t => t.startsWith('Ben')) && (await grid(page)).length > 1, JSON.stringify([await texts(page), await grid(page)]));
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}

// ── 3. nothing extra when only the owner hearted; names are text, not HTML ──
{
  const m = world();
  for (const i of [3, 4, 5, 6, 7]) m.state.selections.delete(K(i));
  await suite('owner collab stats — only the owner hearted: no stats element at all; it appears when a collaborator hearts (live re-read)', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('no #pickCollabStats in the DOM', (await page.$('#pickCollabStats')) === null);
      ok('the filter bar is as before (3 buttons)', await page.evaluate(() => document.querySelectorAll('#pickFilterBar [data-pick-filter]').length === 3));
      m.state.selections.set(K(4), sel(1, 'collab-1'));
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(300);
      ok('a collaborator hearted -> 我 3 / Mia 1', JSON.stringify(await texts(page)) === JSON.stringify(['我 3', 'Mia 1']), JSON.stringify(await texts(page)));
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}
{
  const m = world({ benName: XSS });
  await suite('owner collab stats — a collaborator named <img onerror> is text, never markup', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('the chip shows the literal name', (await texts(page)).some(t => t === `${XSS} 1`), JSON.stringify(await texts(page)));
      ok('no element was created from it and the handler never ran', (await page.$('#pickCollabStats img')) === null && (await page.evaluate(() => window.__xss)) === undefined);
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}

// ── 4. collaborator and viewer: not in the DOM at all ──
for (const [who, key] of [['a collaborator', 'MIA-KEY'], ['a viewer (no key)', '']]) {
  const m = world();
  await suite(`owner collab stats — ${who} has no stats element anywhere in the DOM, with other people's hearts on the page`, url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('there are photos and the filter bar is there (the positive side)', (await page.$$('.photo-card')).length === 8 && (await page.$$('#pickFilterBar [data-pick-filter]')).length === 3);
      ok('no #pickCollabStats, no chip', (await page.$('#pickCollabStats')) === null && (await page.$('[data-collab-key]')) === null);
      m.state.selections.set(K(4), sel(1, 'collab-2'));
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(300);
      ok('still none after a state re-read', (await page.$('#pickCollabStats')) === null && (await page.$('[data-collab-key]')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey(key) });
}

// ── 5. phone: 390px, five chips wrap inside the screen, touch size, filter works there too ──
{
  const m = world();
  await suite('owner collab stats — 390px: no horizontal scroll, chips inside the screen and touch-sized, tap filters', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await ready(page);
      ok('five chips', (await chips(page)).length === 5, JSON.stringify(await texts(page)));
      const lay = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('#pickCollabStats [data-collab-key]')).map(e => e.getBoundingClientRect());
        const bar = document.getElementById('guestBar');
        return { w: innerWidth, sw: document.documentElement.scrollWidth, minL: Math.min(...els.map(r => r.left)), maxR: Math.max(...els.map(r => r.right)),
          minH: Math.min(...els.map(r => r.height)), inGuestBar: !!(bar && bar.querySelector('#pickCollabStats')), visible: els.every(r => r.width > 0 && r.height > 0) };
      });
      ok('no horizontal page scroll; every chip within 0..390', lay.w === 390 && lay.sw <= 390 && lay.minL >= 0 && lay.maxR <= 390 && lay.visible, JSON.stringify(lay));
      ok('chips are at least 36px tall; the stats live in #guestBar on a phone', lay.minH >= 36 && lay.inGuestBar, JSON.stringify(lay));
      await tap(page, 'Ben');
      ok('tap on the phone: Ben\'s p5 only', JSON.stringify(await grid(page)) === '[5]', JSON.stringify(await grid(page)));
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY'), contextOptions: MOBILE });
}

}
