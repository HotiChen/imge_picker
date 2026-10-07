// Browser suites: tour A (picking) walks through the REAL enlarged view (js/guest-tour.js, css/guest-tour.css).
// 7 steps: ♥ on the grid, 點照片放大 (下一步 really opens the photo through the card's own click), then inside the
// enlarged view: left/right/swipe -> the lightbox ♥ -> 標示修改 -> 完成, then back on the grid: submit.
// The tour never taps, swipes, hearts or pins for the guest. Every suite passes `tour: true`. Chromium only.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, url, run, opts) => suite(name, url, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, { tour: true, ...opts });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; };
const URL_ = `${base}/index.html?t=TOK`;
const OWNER = "localStorage.setItem('pick_key:TOK', 'PIA-KEY');";
const pickWorld = (o = {}) => pickFakeWorker({ ownerName: 'Pia', ownerKey: 'PIA-KEY', photos: PHOTOS(8), ...o });

const waitCard = page => until(() => page.evaluate(() => { const c = document.querySelector('.gt-card'); return !!c && c.getBoundingClientRect().width > 0; }));
const gone = page => until(async () => !(await page.$('.gt-card')));
const gridReady = page => page.waitForFunction(() => document.querySelectorAll('.photo-card').length > 0, null, { timeout: 8000 });
const info = async page => { await sleep(320); return page.evaluate(() => {
  const c = document.querySelector('.gt-card'), ring = document.querySelector('.gt-ring');
  if (!c) return null;
  const r = x => { const b = x.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  return { count: c.querySelector('.gt-count').textContent, text: c.querySelector('.gt-text').textContent,
    card: r(c), ring: ring && getComputedStyle(ring).display !== 'none' ? r(ring) : null,
    vw: document.documentElement.clientWidth, vh: innerHeight, next: c.querySelector('.gt-next').textContent };
}); };
const inside = i => i.card.l >= 0 && i.card.t >= 0 && i.card.r <= i.vw && i.card.b <= i.vh;
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
// a visible element matching `sel` lies inside the ring
const ringHas = (page, sel) => page.evaluate(sel2 => {
  const ring = document.querySelector('.gt-ring'); if (!ring || getComputedStyle(ring).display === 'none') return false;
  const g = ring.getBoundingClientRect();
  return [...document.querySelectorAll(sel2)].some(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left >= g.left - 1 && b.right <= g.right + 1 && b.top >= g.top - 1 && b.bottom <= g.bottom + 1; });
}, sel);
const modalOn = page => page.evaluate(() => document.getElementById('photoModal').classList.contains('active'));
const scrollSig = page => page.evaluate(() => JSON.stringify([scrollY, ...[...document.querySelectorAll('.content,.main-content,.photo-grid,main')].map(e => e.scrollTop)]));
const picked = page => page.evaluate(() => app.photos.filter(p => p.rating > 0).length);
const curIdx = page => page.evaluate(() => app.currentPhotoIndex);
const marks = page => page.evaluate(() => app.photos.reduce((n, p) => n + PickController.marksOf(p.id).length, 0));
const puts = m => m.requests.filter(r => r.method === 'PUT').length;
// writes that pick or pin something (the page's own note save when the guest changes photo is rating 0, empty note)
const pickWrites = m => m.requests.filter(r => r.method === 'PUT' && (r.body?.upsert || []).some(u => u.rating > 0 || (u.marks && u.marks.length))).length;
const next = page => page.click('.gt-next');
const centerOfRing = page => page.evaluate(() => { const r = document.querySelector('.gt-ring').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const NAVSEL = '#prevPhotoBtn, #nextPhotoBtn, .modal-nav-overlay';
const MHEART = '#photoModal #modalPhotoRating .pick-heart-btn';
// start the tour in the state "already hearted by the guest" etc.: walk to the opened lightbox (step 3)
const toStep = async (page, n) => { for (let k = 1; k < n; k++) { await next(page); await sleep(120); } };

// ═════ L1. the whole walk at phone width: nothing is changed by the tour
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — 7 steps: 下一步 on step 2 really opens the photo; navigation, ♥, 標示修改, 完成 point at the real controls; the grid comes back untouched',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: the tour appears', await waitCard(page));
      const name0 = await page.evaluate(() => document.querySelector('.photo-card').dataset.photoId || app.filteredPhotos[0].id);
      const sc0 = await scrollSig(page);
      const rect0 = await page.evaluate(() => JSON.stringify(document.querySelector('.photo-card').getBoundingClientRect()));
      let i = await info(page);
      ok('step 1/7 ring on the grid ♥', i.count === '1/7' && !!i.ring && await ringHas(page, '.photo-card .pick-heart-btn'), JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('step 2/7 ring on a card, text says 放大; the lightbox is NOT open yet', i.count === '2/7' && i.text.includes('放大') && !!i.ring && !(await modalOn(page)), JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('下一步 opened the lightbox on that very photo', await modalOn(page) && (await curIdx(page)) === 0 && (await page.evaluate(() => app.filteredPhotos[0].id)) === name0);
      ok('step 3/7 (navigation): text mentions 左右 and 滑; ring on the real prev/next controls', i.count === '3/7' && i.text.includes('左右') && i.text.includes('滑') && !!i.ring && await ringHas(page, NAVSEL), JSON.stringify(i));
      ok('the popover is inside the viewport, off its ring, and above the lightbox (hit-test)', inside(i) && !overlap(i.card, i.ring) && await page.evaluate(() => { const c = document.querySelector('.gt-card').getBoundingClientRect(); const el = document.elementFromPoint(c.left + c.width / 2, c.top + 8); return !!el.closest('.gt-card'); }), JSON.stringify(i));
      ok('the page did not scroll-jump when the photo opened', (await scrollSig(page)) === sc0);
      await sleep(1000);
      ok('the tour does not navigate by itself: still photo 0', (await curIdx(page)) === 0);
      await next(page);
      i = await info(page);
      ok('step 4/7 (♥): text 愛心, ring on the lightbox ♥ (not hearted yet)', i.count === '4/7' && i.text.includes('愛心') && await ringHas(page, MHEART) && !(await page.$(`${MHEART}.on`)), JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('step 5/7 (photo not ♥, no 標示修改 button): text explains it, no ring', i.count === '5/7' && i.text.includes('標示修改') && !i.ring && !(await page.$('#pickPinBtn')), JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('step 6/7: text about tapping the position and 完成, no ring (not in pin mode)', i.count === '6/7' && i.text.includes('完成') && i.text.includes('位置') && !i.ring, JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('step 7/7: the lightbox is closed again, ring on 送出, last button reads 完成', i.count === '7/7' && !(await modalOn(page)) && await ringHas(page, '#pickSubmitBtn') && i.next === '完成', JSON.stringify(i));
      ok('grid exactly as before: scroll and first card rect', (await scrollSig(page)) === sc0 && (await page.evaluate(() => JSON.stringify(document.querySelector('.photo-card').getBoundingClientRect()))) === rect0);
      ok('nothing picked or marked, no write at all', (await picked(page)) === 0 && (await marks(page)) === 0 && puts(m) === 0);
      await next(page);
      ok('完成 closes the tour', await gone(page));
      ok('forced mode: no seen key written', (await page.evaluate(() => localStorage.getItem('guestTourPickingV1'))) === null);
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}

// ═════ L2. the guest does the real taps: nav, ♥, 標示修改 (the tour waits and never taps)
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — the guest taps the arrow, the ♥ and 標示修改 for real: the nav step stays on the new photo, ♥ and the pin button advance, no pin is placed by the tour',
    URL_, async (page, ok) => {
      await gridReady(page); await waitCard(page);
      await toStep(page, 3);
      let i = await info(page);
      ok('positive: step 3/7 in the lightbox', i.count === '3/7' && await modalOn(page));
      const nb = await page.$eval('#nextPhotoBtn', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(nb.x, nb.y);
      await sleep(500);
      i = await info(page);
      ok('the guest\'s tap on the arrow went to photo 1 and the tour stays on 3/7 with the ring on the controls', (await curIdx(page)) === 1 && i.count === '3/7' && !!i.ring && await ringHas(page, NAVSEL), JSON.stringify(i));
      await next(page);
      i = await info(page);
      ok('step 4/7 on the new photo: ring on its (re-resolved) lightbox ♥', i.count === '4/7' && await ringHas(page, MHEART), JSON.stringify(i));
      ok('still nothing picked or pinned by the tour (the page\'s own note save on changing photo is rating 0)', pickWrites(m) === 0 && (await picked(page)) === 0);
      const c = await centerOfRing(page);
      await page.touchscreen.tap(c.x, c.y);
      ok('the guest\'s ♥ tap hearts photo 1 only', await until(async () => (await picked(page)) === 1 && await page.evaluate(() => app.photos.find(p => p.rating > 0).id === app.filteredPhotos[1].id)));
      i = await info(page);
      ok('the tour moved on by itself to 5/7: ring on the real 標示修改', i.count === '5/7' && await ringHas(page, '#pickPinBtn') && i.text.includes('位置'), JSON.stringify(i));
      ok('and its ring sits off the popover; 44px target', !overlap(i.card, i.ring) && (await page.$eval('#pickPinBtn', e => e.getBoundingClientRect().height)) >= 44);
      ok('pin mode is still off (the tour never enters it)', !(await page.evaluate(() => PickController.pinMode)));
      const c2 = await centerOfRing(page);
      await page.touchscreen.tap(c2.x, c2.y);
      ok('the guest\'s tap on 標示修改 enters pin mode', await until(() => page.evaluate(() => PickController.pinMode === true)));
      i = await info(page);
      ok('6/7: text about 完成, ring on the real 完成 button', i.count === '6/7' && i.text.includes('完成') && await ringHas(page, '#pickPinDoneBtn'), JSON.stringify(i));
      await sleep(700);
      ok('no pin placed by the tour', (await marks(page)) === 0 && pickWrites(m) === 1);
      await next(page);
      i = await info(page);
      ok('7/7: lightbox closed, pin mode off, ring on 送出; the guest\'s one ♥ is the only change', i.count === '7/7' && !(await modalOn(page)) && !(await page.evaluate(() => PickController.pinMode)) && await ringHas(page, '#pickSubmitBtn') && (await picked(page)) === 1 && (await marks(page)) === 0);
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}

// ═════ L3. a photo that is already ♥ skips the ♥ step and shows the real 標示修改
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — an already hearted photo: the ♥ step is skipped, the ring is on the real 標示修改',
    URL_, async (page, ok) => {
      await gridReady(page);
      await page.evaluate(() => { app.togglePickHeart(app.filteredPhotos[0], document.querySelector('.photo-card .pick-heart-btn')); });
      await sleep(300);
      await page.click('.gt-help');
      ok('positive: replay starts', await waitCard(page));
      await toStep(page, 3);
      let i = await info(page);
      ok('3/7 navigation', i.count === '3/7');
      await next(page);
      i = await info(page);
      ok('the ♥ step is skipped: 5/7 with the ring on #pickPinBtn', i.count === '5/7' && await ringHas(page, '#pickPinBtn'), JSON.stringify(i));
      ok('still exactly the guest\'s own ♥', (await picked(page)) === 1);
    }, { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ L4. ending the tour closes the lightbox it opened, but not the guest's own
for (const [how, act] of [['略過', p => p.click('.gt-skip')], ['✕', p => p.click('.gt-x')], ['Esc', p => p.keyboard.press('Escape')]]) {
  const m = pickWorld();
  await sx(`guest tour lightbox (390px) — ${how} inside the tour-opened lightbox closes the tour AND the lightbox`,
    URL_, async (page, ok) => {
      await gridReady(page); await waitCard(page);
      await toStep(page, 4);
      ok('positive: lightbox open at 4/7', await modalOn(page) && (await info(page)).count === '4/7');
      await act(page);
      ok('tour gone', await gone(page));
      ok('lightbox closed', await until(async () => !(await modalOn(page))));
      ok('grid still there and nothing written', (await page.$$('.photo-card')).length > 0 && puts(m) === 0 && (await picked(page)) === 0);
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — a lightbox the GUEST opened during the tour stays open when the tour ends (Esc and 略過); positive: the tour itself keeps running meanwhile',
    URL_, async (page, ok) => {
      await gridReady(page); await waitCard(page);
      await page.evaluate(() => app.openModal(2));
      await sleep(700);
      ok('positive: the tour is still up although the guest opened a lightbox', await modalOn(page) && !!(await page.$('.gt-card')));
      await page.keyboard.press('Escape');
      ok('Esc ends the tour', await gone(page));
      await sleep(300);
      ok('the guest\'s lightbox is still open (the tour did not close it, and Esc did not leak to the page)', await modalOn(page));
      await page.evaluate(() => app.closeModal());
      await page.click('.gt-help'); await waitCard(page);
      await page.evaluate(() => app.openModal(1)); await sleep(500);
      await page.click('.gt-skip');
      await gone(page);
      ok('略過 leaves the guest\'s lightbox open too', await modalOn(page));
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — the guest closes the lightbox mid-tour: the tour skips forward to 送出; 上一步 from step 3 closes the lightbox it opened',
    URL_, async (page, ok) => {
      await gridReady(page); await waitCard(page);
      await toStep(page, 3);
      await page.click('.gt-back');
      let i = await info(page);
      ok('上一步 on step 3 returns to 2/7 and closes the tour-opened lightbox', i.count === '2/7' && !(await modalOn(page)), JSON.stringify(i));
      await next(page);
      ok('下一步 opens it again', await modalOn(page) && (await info(page)).count === '3/7');
      await toStep(page, 4);
      await page.click('#closeModal');
      ok('the guest closed the lightbox', !(await modalOn(page)));
      ok('the tour skipped forward to 送出 (7/7) with the ring on it', await until(async () => (await info(page))?.count === '7/7') && await ringHas(page, '#pickSubmitBtn'));
      await next(page);
      ok('完成 ends it cleanly', await gone(page));
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}

// ═════ L5. desktop
{
  const m = pickWorld();
  await sx('guest tour lightbox (1500px) — desktop: every step inside the viewport and off its ring; the lightbox opens and closes',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tour shows', await waitCard(page));
      for (let s = 1; s <= 7; s++) {
        const i = await info(page);
        ok(`step ${s}/7 inside the viewport and off its ring`, i.count === `${s}/7` && inside(i) && (!i.ring || !overlap(i.card, i.ring)), JSON.stringify(i));
        if (s === 3) ok('the lightbox is open on step 3', await modalOn(page));
        if (s < 7) await next(page);
      }
      ok('lightbox closed on the last step', !(await modalOn(page)));
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;` });
}

// ═════ L6. positive controls: without a tour the page is as before
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — no tour running: a tap on a card opens the lightbox and Esc closes it (the module intercepts nothing)',
    URL_, async (page, ok) => {
      await gridReady(page);
      await sleep(900);
      ok('no tour card, no ring, no dim', !(await page.$('.gt-card')) && !(await page.$('.gt-ring')) && !(await page.$('.gt-dim')));
      await page.evaluate(() => document.querySelector('.photo-card').click());
      ok('the card opens the lightbox', await until(() => modalOn(page)));
      await page.keyboard.press('Escape');
      ok('Esc closes the lightbox', await until(async () => !(await modalOn(page))));
    }, { before: m.attach, initScript: `${OWNER}localStorage.setItem('guestTourPickingV1','1');localStorage.setItem('guestTourDeliveredV1','1');`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour lightbox (390px) — a viewer gets no tour even with FORCE on; positive: the grid is there',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: photos listed', (await page.$$('.photo-card')).length > 0);
      await sleep(1500);
      ok('no card, no ？', !(await page.$('.gt-card')) && !(await page.$('.gt-help')));
    }, { before: m.attach, initScript: "localStorage.setItem('pick_key:TOK','WRONG-KEY');window.GUEST_TOUR_FORCE = true;", contextOptions: MOBILE });
}

}
