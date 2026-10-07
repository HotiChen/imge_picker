// Browser suites: the first-visit guided tour for the client on the pick page (js/guest-tour.js, css/guest-tour.css).
// Tour A = picking (7 steps; the lightbox part is in suite 52), tour B = delivered and not yet confirmed (3 steps), seat owner only. Every suite here
// passes `tour: true` (test/lib/harness.mjs seeds the "seen" keys everywhere else). Chromium only.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { pinsWorld } from '../lib/revision-pins-fake.mjs';

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
const KA = 'guestTourPickingV1', KB = 'guestTourDeliveredV1';
const seed = (a, b) => `${OWNER}${a ? `localStorage.setItem('${KA}','1');` : ''}${b ? `localStorage.setItem('${KB}','1');` : ''}`;

const pickWorld = (o = {}) => pickFakeWorker({ ownerName: 'Pia', ownerKey: 'PIA-KEY', photos: PHOTOS(8), ...o });
const delWorld = (o = {}) => pinsWorld({ n: 8, ...o, fake: { title: '婚禮精修', ownerName: 'Pia', ownerKey: 'PIA-KEY', ...(o.fake || {}) } });

const hasCard = page => page.evaluate(() => { const c = document.querySelector('.gt-card'); return !!c && c.getBoundingClientRect().width > 0; });
const waitCard = page => until(() => hasCard(page));
const noCardFor = async (page, ms = 1600) => { await sleep(ms); return !(await page.$('.gt-card')); };
const gridReady = page => page.waitForFunction(() => document.querySelectorAll('.photo-card, .fg-tile').length > 0, null, { timeout: 8000 });
const storeVal = (page, k) => page.evaluate(k2 => localStorage.getItem(k2), k);
const info = async page => { await sleep(300); return infoNow(page); };   // the ring eases to its target in .18s
const infoNow = page => page.evaluate(() => {
  const c = document.querySelector('.gt-card'), ring = document.querySelector('.gt-ring');
  if (!c) return null;
  const r = x => { const b = x.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const ringOn = !!ring && getComputedStyle(ring).display !== 'none';
  return {
    count: c.querySelector('.gt-count').textContent, text: c.querySelector('.gt-text').textContent,
    card: r(c), ring: ringOn ? r(ring) : null, vw: document.documentElement.clientWidth, vh: innerHeight,
    next: c.querySelector('.gt-next').textContent, backHidden: c.querySelector('.gt-back').hidden,
    inCard: c.contains(document.activeElement),
  };
});
const inside = i => i.card.l >= 0 && i.card.t >= 0 && i.card.r <= i.vw && i.card.b <= i.vh;
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
const nextBtn = page => page.click('.gt-next');

// ═════ A1. tour A, the whole walk at phone width
{
  const m = pickWorld();
  await sx('guest tour (390px) — picking owner: 7 steps, each popover inside the viewport and off its target; finishing marks it seen; nothing is picked by the tour',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: the tour appears once the grid has cards', await waitCard(page));
      ok('key not set before it ends', (await storeVal(page, KA)) === null);
      const shiftBefore = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, c: JSON.stringify(document.querySelector('.photo-card').getBoundingClientRect()) }));
      const texts = [], seenCounts = [];
      for (let step = 1; step <= 7; step++) {
        const i = await info(page);
        if (!i) { ok(`step ${step} has a card`, false); break; }
        texts.push(i.text); seenCounts.push(i.count);
        ok(`step ${step}: counter ${step}/7, popover inside the 390x844 viewport`, i.count === `${step}/7` && inside(i), JSON.stringify(i));
        ok(`step ${step}: focus is inside the card`, i.inCard);
        if (step === 5 || step === 6) ok(`step ${step} is text only here (photo not ♥, not in pin mode): no ring`, !i.ring && i.text.includes(step === 5 ? '標示修改' : '完成') && i.text.includes('位置'), JSON.stringify(i));
        else {
          ok(`step ${step}: a ring is on the target and the popover does not cover it`, !!i.ring && !overlap(i.card, i.ring), JSON.stringify(i));
          const sel = ['.photo-card .pick-heart-btn', '.photo-card', '#prevPhotoBtn, #nextPhotoBtn, .modal-nav-overlay', '#photoModal #modalPhotoRating .pick-heart-btn', null, null, '#pickSubmitBtn'][step - 1];
          await sleep(300);
          const hit = await page.evaluate(({ sel }) => { const rg = document.querySelector('.gt-ring').getBoundingClientRect(); const el = [...document.querySelectorAll(sel)].find(e => { const b = e.getBoundingClientRect(); return b.left >= rg.left - 1 && b.right <= rg.right + 1 && b.top >= rg.top - 1 && b.bottom <= rg.bottom + 1; }); return !!el; }, { sel });
          ok(`step ${step}: the ring encloses a real ${sel}`, hit);
        }
        if (step === 1) {
          const sizes = await page.evaluate(() => [...document.querySelectorAll('.gt-card button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return [b.className, r.width, r.height]; }));
          ok('every visible card button is at least 44px in both directions', sizes.length >= 3 && sizes.every(s => s[1] >= 44 && s[2] >= 44), JSON.stringify(sizes));
          const aria = await page.evaluate(() => { const c = document.querySelector('.gt-card'); return [c.getAttribute('role'), c.getAttribute('aria-live')]; });
          ok('role=dialog, aria-live=polite', aria[0] === 'dialog' && aria[1] === 'polite', String(aria));
          ok('first step has no 上一步', i.backHidden);
        }
        if (step === 7) ok('last step\'s button reads 完成', i.next === '完成', i.next);
        if (step < 7) await nextBtn(page);
      }
      ok('the seven texts are the specified ones', texts[0].includes('點愛心選這張') && texts[1].includes('放大') && texts[2].includes('左右') && texts[2].includes('滑') && texts[3].includes('愛心') && texts[4].includes('標示修改') && texts[5].includes('點照片上要修的位置') && texts[5].includes('完成') && !texts.join('').includes('備註・標示') && texts[6].includes('選好了，按這裡送出'), JSON.stringify(texts));
      const after = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, c: JSON.stringify(document.querySelector('.photo-card').getBoundingClientRect()) }));
      ok('no layout shift: scrollHeight and the first card rect are unchanged while the tour ran', after.sh === shiftBefore.sh && after.c === shiftBefore.c, JSON.stringify([shiftBefore, after]));
      await page.click('.gt-back');
      ok('上一步 from 送出 skips the lightbox steps (it is closed) and lands on 2/7', (await info(page)).count === '2/7');
      for (let k = 0; k < 6; k++) await nextBtn(page);
      ok('完成 closes the card', await until(async () => !(await page.$('.gt-card'))));
      ok('and marks picking seen', (await storeVal(page, KA)) === '1');
      ok('the delivered key is untouched', (await storeVal(page, KB)) === null);
      ok('the tour picked nothing: no write with a rating or a pin (the page\'s own empty note save on closing the lightbox is rating 0), counter at 0', m.requests.filter(r => r.method === 'PUT' && (r.body?.upsert || []).some(u => u.rating > 0 || (u.marks && u.marks.length))).length === 0 && (await page.textContent('#pickCounter')).includes('0'));
    }, { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ A2. outside taps are swallowed; the highlighted target advances; scrolling is free
{
  const m = pickWorld();
  await sx('guest tour (390px) — outside taps do not pick or open a photo; a tap on the highlighted ♥ advances without picking; the page still scrolls',
    URL_, async (page, ok) => {
      await gridReady(page);
      await waitCard(page);
      const cards = await page.$$('.photo-card');
      const other = cards[cards.length - 1];
      await other.scrollIntoViewIfNeeded();
      ok('card still up after scrolling the page (no scroll lock)', await hasCard(page));
      const y1 = await page.evaluate(() => scrollY + document.querySelector('.content, .main-content, #photoGrid')?.scrollTop);
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.content,.main-content,.photo-grid').forEach(e => { e.scrollTop = 0; }); });
      await page.mouse.wheel(0, 600);
      await sleep(250);
      const moved = await page.evaluate(() => scrollY > 0 || [...document.querySelectorAll('.content,.main-content,.photo-grid,main')].some(e => e.scrollTop > 0));
      ok('positive: a wheel scroll moves the page while the tour is up', moved, String(y1));
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.content,.main-content,.photo-grid,main').forEach(e => { e.scrollTop = 0; }); });
      await sleep(300);
      const c0 = await info(page);
      await page.touchscreen.tap(c0.vw / 2, 140);                   // some spot well outside the card (header / photo area)
      await sleep(250);
      const modalOpen = await page.evaluate(() => document.getElementById('photoModal').classList.contains('active'));
      const sel = await page.evaluate(() => app.photos.filter(p => p.rating > 0).length);
      ok('an outside tap neither opens the lightbox nor ♥s, and the step stays 1/7', !modalOpen && sel === 0 && (await info(page)).count === '1/7', JSON.stringify([modalOpen, sel]));
      const heart = await page.evaluate(() => { const r = document.querySelector('.gt-ring').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(heart.x, heart.y);
      await sleep(250);
      const sel2 = await page.evaluate(() => app.photos.filter(p => p.rating > 0).length);
      ok('a tap on the highlighted ♥ advances to 2/7 and does not pick it', (await info(page)).count === '2/7' && sel2 === 0, String(sel2));
      await page.click('.gt-skip');
      await page.evaluate(() => { window.scrollTo(0, 0); });
      const h = await page.$eval('.photo-card .pick-heart-btn', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(h.x, h.y);
      await sleep(250);
      ok('positive: once the tour is gone the very same tap does ♥ the photo (existing gesture intact)', (await page.evaluate(() => app.photos.filter(p => p.rating > 0).length)) === 1);
    }, { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ A3. seen state, skip, ✕, Esc, replay, focus return
{
  const m = pickWorld();
  await sx('guest tour (390px) — already seen: no tour but the ？ button replays it; Esc / ✕ / 略過 each mark seen and a reload stays quiet; focus returns to ？',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('seen key present: no tour', await noCardFor(page));
      ok('positive: the ？ help button is there (owner, picking)', !!(await page.$('.gt-help')));
      await page.click('.gt-help');
      ok('？ replays the tour at step 1/7', await waitCard(page) && (await info(page)).count === '1/7');
      await page.keyboard.press('Escape');
      ok('Esc closes it', await until(async () => !(await page.$('.gt-card'))));
      ok('focus returned to the ？ button', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('gt-help')));
      await page.click('.gt-help'); await waitCard(page);
      await page.click('.gt-x');
      ok('✕ closes it', await until(async () => !(await page.$('.gt-card'))));
      await page.click('.gt-help'); await waitCard(page);
      await page.click('.gt-skip');
      ok('略過 closes it', await until(async () => !(await page.$('.gt-card'))));
    }, { before: m.attach, initScript: seed(true, false), contextOptions: MOBILE });
}
for (const [how, act] of [['略過', p => p.click('.gt-skip')], ['✕', p => p.click('.gt-x')], ['Esc', p => p.keyboard.press('Escape')]]) {
  const m = pickWorld();
  await sx(`guest tour (390px) — ${how} marks it seen; a reload shows no tour`,
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tour shown first', await waitCard(page));
      ok('key not set yet', (await storeVal(page, KA)) === null);
      await act(page);
      ok(`${how}: key set`, await until(async () => (await storeVal(page, KA)) === '1'));
      await page.reload({ waitUntil: 'load' });
      await gridReady(page);
      ok('after reload: grid there, no tour', await noCardFor(page));
    }, { before: m.attach, initScript: `if(!sessionStorage.getItem('__once')){sessionStorage.setItem('__once','1');${OWNER}}`, contextOptions: MOBILE });
}

// ═════ A4. who gets no tour
{
  const m = pickWorld();
  await sx('guest tour (390px) — a viewer (no seat) gets no tour and no ？ button; positive: the grid is there',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: photos are listed for the viewer', (await page.$$('.photo-card')).length > 0);
      ok('no tour card', await noCardFor(page));
      ok('no ？ button', !(await page.$('.gt-help')));
      ok('no tour key written', (await storeVal(page, KA)) === null);
    }, { before: m.attach, initScript: "localStorage.setItem('pick_key:TOK','WRONG-KEY');", contextOptions: MOBILE });
}
{
  const m = pickFakeWorker({ photos: PHOTOS(4) });           // no owner yet: the claim overlay
  await sx('guest tour (390px) — unclaimed link: the name overlay blocks any tour',
    URL_, async (page, ok) => {
      await page.waitForSelector('#pickClaimOverlay:not([hidden])', { timeout: 6000 });
      ok('positive: claim overlay is showing', await page.evaluate(() => getComputedStyle(document.getElementById('pickClaimOverlay')).display !== 'none'));
      ok('no tour', await noCardFor(page));
      ok('no ？', !(await page.$('.gt-help')));
    }, { before: m.attach, contextOptions: MOBILE });
}
{
  const m = pickWorld({ phase: 'retouching' });
  await sx('guest tour (390px) — owner while the photographer is retouching (read-only): no tour, no ？',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: the page shows the retouching notice', (await page.textContent('#pickBanner')).length > 0);
      ok('no tour', await noCardFor(page));
      ok('no ？', !(await page.$('.gt-help')));
    }, { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ A5. storage throws
{
  const m = pickWorld();
  await sx('guest tour (390px) — storage that throws: the page works, the tour shows, finishing does not throw and it does not come back this page load',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tour shown with unreadable storage', await waitCard(page));
      await page.click('.gt-skip');
      ok('closes', await until(async () => !(await page.$('.gt-card'))));
      await page.evaluate(() => PickController._syncTour());
      ok('not shown again within the same page load', await noCardFor(page, 1000));
      ok('positive: the ？ still replays', await (async () => { await page.click('.gt-help'); return waitCard(page); })());
    }, { before: m.attach, contextOptions: MOBILE,
      initScript: `${OWNER.replace("localStorage.setItem('pick_key:TOK', 'PIA-KEY')", "window.__k='PIA-KEY'")}
        const real = Storage.prototype.getItem;
        Storage.prototype.getItem = function (k) { if (String(k).startsWith('guestTour')) throw new Error('blocked'); return k === 'pick_key:TOK' ? 'PIA-KEY' : real.call(this, k); };
        Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('guestTour')) throw new Error('blocked'); };` });
}

// ═════ A6. dialogs
{
  const m = pickWorld();
  await sx('guest tour (390px) — nothing starts under an open lightbox; it starts when that closes; a lightbox the guest opens mid-tour keeps the tour up, another blocker (the loading pill) steps it aside without marking it seen',
    URL_, async (page, ok) => {
      await gridReady(page);
      await page.evaluate(() => { app.openModal(0); });
      await page.waitForFunction(() => document.getElementById('photoModal').classList.contains('active'));
      await page.evaluate(({ a, b }) => { localStorage.removeItem(a); localStorage.removeItem(b); PickController._syncTour(); }, { a: KA, b: KB });
      ok('lightbox open: no tour', await noCardFor(page, 1200));
      await page.evaluate(() => app.closeModal());
      ok('positive: after closing it the tour starts', await waitCard(page));
      await page.evaluate(() => { app.openModal(1); });
      await sleep(700);
      ok('a lightbox opening mid-tour (the guest\'s) keeps the card', await hasCard(page));
      await page.evaluate(() => { document.getElementById('loadingState').style.display = 'block'; });
      ok('another blocker (the loading pill) removes the card', await until(async () => !(await page.$('.gt-card'))));
      ok('and did not mark it seen', (await storeVal(page, KA)) === null);
    }, { before: m.attach, initScript: seed(true, true), contextOptions: MOBILE });
}

// ═════ A6b. module-level gates (defence in depth: the page's own gating is not the only line)
{
  const m = pickWorld();
  await sx('guest tour (390px) — module gates: isOwner false starts nothing and removes the ？; the loading pill holds the start back; each positive control then starts it',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: ？ exists for the owner', !!(await page.$('.gt-help')));
      await page.evaluate(() => GuestTour.maybeStart({ phase: 'picking', isOwner: false }));
      ok('isOwner false: the ？ is removed', !(await page.$('.gt-help')));
      await page.evaluate(({ a }) => { localStorage.removeItem(a); GuestTour.maybeStart({ phase: 'picking', isOwner: false }); }, { a: KA });
      ok('isOwner false with the key unset: no tour', await noCardFor(page, 1200));
      await page.evaluate(() => { document.getElementById('loadingState').style.display = 'block'; GuestTour.maybeStart({ phase: 'picking', isOwner: true }); });
      ok('the loading pill is showing: the tour waits', await noCardFor(page, 1200));
      await page.evaluate(() => { document.getElementById('loadingState').style.display = 'none'; });
      ok('positive: pill gone, owner true: the tour starts', await waitCard(page));
    }, { before: m.attach, initScript: seed(true, false), contextOptions: MOBILE });
}

// ═════ A7. missing targets
{
  const m = pickWorld();
  await sx('guest tour (390px) — a target that vanished is skipped; zero targets means no tour',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tour up', await waitCard(page));
      await nextBtn(page); await nextBtn(page);
      ok('at step 3/7 (the photo is open)', (await info(page)).count === '3/7');
      await page.evaluate(() => document.getElementById('pickSubmitBtn').remove());
      await nextBtn(page); await nextBtn(page); await nextBtn(page); await nextBtn(page);
      ok('the submit button is gone: step 7 is skipped and the tour ends', await until(async () => !(await page.$('.gt-card'))));
      ok('ending that way is finishing: seen', (await storeVal(page, KA)) === '1');
      // zero targets
      await page.evaluate(() => { localStorage.removeItem('guestTourPickingV1'); document.querySelectorAll('.photo-card').forEach(e => e.remove()); });
      await page.evaluate(() => GuestTour.start('picking'));
      ok('no cards and no submit button: start() makes no tour', !(await page.$('.gt-card')));
    }, { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour (390px) — a missing last target is left out of the count (6 steps, not 7)',
    URL_, async (page, ok) => {
      await gridReady(page);
      await page.click('.gt-help').catch(() => {});
      await page.evaluate(() => { GuestTour.close(false); document.getElementById('pickSubmitBtn').remove(); });
      await page.evaluate(() => GuestTour.start('picking'));
      ok('positive: tour starts with the remaining targets', await waitCard(page));
      ok('counter says 1/6', (await info(page)).count === '1/6');
    }, { before: m.attach, initScript: seed(true, false), contextOptions: MOBILE });
}

// ═════ A8. desktop, reduced motion
{
  const m = pickWorld();
  await sx('guest tour (1500px) — desktop: popover inside the viewport on every step; ？ sits bottom-right',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tour shows', await waitCard(page));
      for (let s = 1; s <= 7; s++) {
        const i = await info(page);
        ok(`step ${s}: inside the viewport and off its ring`, inside(i) && (!i.ring || !overlap(i.card, i.ring)), JSON.stringify(i));
        if (s < 7) await nextBtn(page);
      }
      await page.click('.gt-skip');
      const h = await page.$eval('.gt-help', e => { const r = e.getBoundingClientRect(); return { r: r.right, b: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight }; });
      ok('？ is at the bottom-right corner', h.vw - h.r < 40 && h.vh - h.b < 40, JSON.stringify(h));
    }, { before: m.attach, initScript: OWNER });
}
for (const reduce of [true, false]) {
  const m = pickWorld();
  await sx(`guest tour (390px) — prefers-reduced-motion: ${reduce ? 'reduce: the ring does not animate' : 'no-preference: the ring animates (positive control)'}`,
    URL_, async (page, ok) => {
      await gridReady(page);
      await waitCard(page);
      const d = await page.$eval('.gt-ring', e => getComputedStyle(e).transitionDuration);
      const secs = Math.max(...d.split(',').map(x => parseFloat(x)));
      ok(reduce ? 'ring transition duration is 0s' : 'ring transition duration is > 0s', reduce ? secs === 0 : secs > 0, d);
    }, { before: m.attach, initScript: OWNER, contextOptions: { ...MOBILE, reducedMotion: reduce ? 'reduce' : 'no-preference' } });
}

// ═════ A9. the ？ button's place
{
  const m = pickWorld();
  await sx('guest tour (390px) — the ？ button is 44px, inside the viewport, and covers no ♥, counter or submit button at the top or the bottom of the grid',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: the ？ is there', !!(await page.$('.gt-help')));
      for (const where of ['top', 'bottom']) {
        await page.evaluate(w => { const sc = [document.scrollingElement, ...document.querySelectorAll('.content,.main-content,.photo-grid,main')]; sc.forEach(e => { e.scrollTop = w === 'top' ? 0 : 1e6; }); }, where);
        await sleep(250);
        const r = await page.evaluate(() => {
          const rect = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
          const h = rect(document.querySelector('.gt-help'));
          const hit = sel => [...document.querySelectorAll(sel)].map(rect).filter(b => b.w > 0 && b.l < h.right && b.r > h.left && b.t < h.bottom && b.b > h.top).length;
          const heartsVisible = [...document.querySelectorAll('.photo-card .pick-heart-btn')].filter(e => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length;
          return { h, vw: innerWidth, vh: innerHeight, hearts: hit('.photo-card .pick-heart-btn'), submit: hit('#pickSubmitBtn'), counter: hit('#pickCounter'), heartsVisible };
        });
        ok(`${where}: 44px, inside the viewport`, r.h.w >= 44 && r.h.h >= 44 && r.h.l >= 0 && r.h.r <= r.vw && r.h.b <= r.vh, JSON.stringify(r.h));
        ok(`${where}: covers no ♥, no submit, no counter (and hearts are on screen: positive)`, r.hearts === 0 && r.submit === 0 && r.counter === 0 && r.heartsVisible > 0, JSON.stringify(r));
      }
    }, { before: m.attach, initScript: seed(true, false), contextOptions: MOBILE });
}

// ═════ B. delivered
{
  const w = delWorld();
  await sx('guest tour (390px) — delivered, not confirmed, owner: 3 steps pointing at the finals and 確認完成; seen is its own key',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: the tour appears', await waitCard(page));
      const seen = [];
      for (let s = 1; s <= 3; s++) {
        const i = await info(page);
        if (!i) { ok(`step ${s} card`, false); break; }
        seen.push(i.text);
        ok(`step ${s}: ${s}/3, inside viewport, ring present and the card does not cover it`, i.count === `${s}/3` && inside(i) && !!i.ring && !overlap(i.card, i.ring), JSON.stringify(i));
        await sleep(300);
        const what = await page.evaluate(() => { const r = document.querySelector('.gt-ring').getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const el = document.elementsFromPoint(cx, cy).find(e => !e.className.toString().startsWith('gt-')); return el ? (el.closest('.fg-tile') ? 'tile' : el.closest('#doneConfirmBtn') ? 'confirm' : el.tagName) : null; });
        ok(`step ${s}: the ring sits on ${s < 3 ? 'a finals tile' : '確認完成'}`, what === (s < 3 ? 'tile' : 'confirm'), String(what));
        if (s < 3) await nextBtn(page);
      }
      ok('texts: 精修成品 / 標示修改 / 確認完成', seen[0].includes('精修') && seen[1].includes('標示修改') && seen[1].includes('位置') && seen[1].includes('送出修改') && seen[2].includes('確認完成'), JSON.stringify(seen));
      await nextBtn(page);
      ok('完成 closes', await until(async () => !(await page.$('.gt-card'))));
      ok('delivered key set, picking key untouched', (await storeVal(page, KB)) === '1' && (await storeVal(page, KA)) === null);
      ok('positive: the ？ replays the delivered tour (1/3)', await (async () => { await page.click('.gt-help'); return (await waitCard(page)) && (await info(page)).count === '1/3'; })());
    }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = delWorld();
  await sx('guest tour (390px) — delivered, viewer: none; positive: the finals are listed',
    URL_, async (page, ok) => {
      await gridReady(page);
      ok('positive: tiles present', (await page.$$('.fg-tile')).length > 0);
      ok('no tour, no ？', await noCardFor(page) && !(await page.$('.gt-help')));
    }, { before: w.before, contextOptions: MOBILE });
}
{
  const w = delWorld({ fake: { confirmedAt: '2026-09-21T00:00:00.000Z' } });
  await sx('guest tour (390px) — the 完成頁 (delivered and confirmed) gets no tour and no ？',
    URL_, async (page, ok) => {
      await page.waitForSelector('html.cp-on', { timeout: 8000 });
      ok('positive: the 完成頁 is mounted (html.cp-on)', true);
      ok('no tour, no ？', await noCardFor(page) && !(await page.$('.gt-help')) && (await storeVal(page, KB)) === null);
      // the module's own gate: even with every target present, cp-on blocks it; without cp-on the same call starts it
      await page.evaluate(() => { const b = document.createElement('button'); b.id = 'doneConfirmBtn'; b.textContent = 'x'; b.style.cssText = 'position:fixed;top:300px;left:20px;width:80px;height:50px'; document.body.append(b); GuestTour.maybeStart({ phase: 'delivered', isOwner: true }); });
      ok('cp-on set and every target present: still no tour', await noCardFor(page, 1200));
      await page.evaluate(() => { document.documentElement.classList.remove('cp-on'); });
      ok('positive: without cp-on the same state starts the tour', await waitCard(page));
    }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = delWorld();
  await sx('guest tour (390px) — delivered: a lightbox open at start blocks it; closing it lets it start',
    URL_, async (page, ok) => {
      await gridReady(page);
      await page.click('.fg-tile');
      await page.waitForSelector('#fgLightbox');
      await page.evaluate(({ a }) => { localStorage.removeItem(a); PickController._syncTour(); }, { a: KB });
      ok('lightbox open: no tour', await noCardFor(page, 1200));
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.getElementById('fgLbClose')?.click());
      ok('positive: closing it starts the tour', await waitCard(page));
    }, { before: w.before, initScript: seed(false, true), contextOptions: MOBILE });
}


// ═══ test-phase switch: GUEST_TOUR_FORCE shows the tour on every visit and never records "seen" ═══
{
  const m = pickWorld();
  await sx('guest tour (390px) — FORCE on: the tour shows even when both seen keys are set, and finishing does not write them',
    URL_, async (page, ok) => {
      ok('the tour card appears although the seen keys are set', await waitCard(page));
      await page.click('.gt-skip');
      ok('略過 closes it', await until(async () => !(await page.$('.gt-card'))));
      const keys = await page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [KA, KB]);
      ok('forced mode does not write the seen keys (they stay as the test seeded them: "1")', keys[0] === '1' && keys[1] === '1', JSON.stringify(keys));
      await page.reload();
      ok('a reload shows the tour again', await waitCard(page));
    }, { before: m.attach, initScript: `${seed(true, true)}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour (390px) — FORCE on: finishing never writes the seen key (nothing seeded)',
    URL_, async (page, ok) => {
      ok('the tour card appears', await waitCard(page));
      await page.click('.gt-skip');
      ok('closed', await until(async () => !(await page.$('.gt-card'))));
      const keys = await page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [KA, KB]);
      ok('no seen key was written', keys[0] === null && keys[1] === null, JSON.stringify(keys));
    }, { before: m.attach, initScript: `${OWNER}window.GUEST_TOUR_FORCE = true;`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour (390px) — FORCE off (explicit): seen keys set → no tour (positive control for the switch)',
    URL_, async (page, ok) => {
      await page.waitForSelector('.pick-card, .photo-card, [data-key]', { timeout: 8000 }).catch(() => {});
      await sleep(1200);
      ok('no tour card when forced off and seen', !(await hasCard(page)));
      ok('the ？ button is still there (the page itself works)', !!(await page.$('.gt-help')));
    }, { before: m.attach, initScript: `${seed(true, true)}window.GUEST_TOUR_FORCE = false;`, contextOptions: MOBILE });
}


// ═══ the shipped default (window.GUEST_TOUR_FORCE not set at all): first visit only ═══
{
  const m = pickWorld();
  await sx('guest tour (390px) — DEFAULT (no switch set): both seen keys set → no tour; the ？ button is there',
    URL_, async (page, ok) => {
      ok('the page really has no GUEST_TOUR_FORCE set (the shipped default is under test)', (await page.evaluate(() => typeof window.GUEST_TOUR_FORCE)) === 'undefined');
      await page.waitForSelector('.photo-card', { timeout: 8000 }).catch(() => {});
      await sleep(1200);
      ok('no tour card for a returning visitor', !(await hasCard(page)));
      ok('the ？ button is still there', !!(await page.$('.gt-help')));
    }, { before: m.attach, initScript: `${seed(true, true)}delete window.GUEST_TOUR_FORCE;`, contextOptions: MOBILE });
}
{
  const m = pickWorld();
  await sx('guest tour (390px) — DEFAULT (no switch set): a first visit shows it, finishing writes the seen key, a reload shows none',
    URL_, async (page, ok) => {
      ok('GUEST_TOUR_FORCE is not set', (await page.evaluate(() => typeof window.GUEST_TOUR_FORCE)) === 'undefined');
      ok('the tour card appears on a first visit', await waitCard(page));
      await page.click('.gt-skip');
      ok('closed', await until(async () => !(await page.$('.gt-card'))));
      ok('the seen key was written', (await page.evaluate(k => localStorage.getItem(k), KA)) === '1');
      await page.reload();
      await sleep(1500);
      ok('a reload shows no tour', !(await hasCard(page)));
    }, { before: m.attach, initScript: `${OWNER}delete window.GUEST_TOUR_FORCE;`, contextOptions: MOBILE });
}
}
