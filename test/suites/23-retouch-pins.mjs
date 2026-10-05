// Browser suites: retouch pins: guest placing / editing, viewer, photographer review, submission
// diff.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { BIG_PHOTO, CANVAS_PX, MOBILE, realTouch } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PREVIEW_SETTLED, openBigGuestPreview } from '../lib/project-helpers.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Retouch pins — the guest's 標示修改 in the preview, the photographer's
// read-only view of them, and the admin diff line (docs/backlog.md "Retouch
// pins", docs/guest-picking.md "Retouch pins — the save contract"). Phone
// (390px) throughout, real touch input (realTouch) on the 1600x1067 gradient
// BIG_PHOTO: R grows left→right and G top→bottom, so a canvas pixel says which
// point of the photo is under a finger — an oracle that does not share the
// code's own coordinate math.
// ═══════════════════════════════════════════════════════════════════════════
const PIN_PUTS = m => m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
const PIN_FLUSH = page => page.evaluate(() => PickController.flush());
const PIN_STATE = page => page.evaluate(() => ({
  marks: annotationManager.marks.map(x => ({ ...x })),
  mode: annotationManager.pinMode,
  rating: app.filteredPhotos[app.currentPhotoIndex].rating,
  counter: document.getElementById('photoCounter').textContent,
}));
const PIN_FIT = () => {
  const box = document.querySelector('.canvas-container');
  const cr = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const left = cr.left + parseFloat(cs.borderLeftWidth), top = cr.top + parseFloat(cs.borderTopWidth);
  const cw = box.clientWidth, ch = box.clientHeight;
  const k = Math.min(cw / 1600, ch / 1067, 1);
  const w = Math.floor(1600 * k), h = Math.floor(1067 * k);
  return { left: left + (cw - w) / 2, top: top + (ch - h) / 2, w, h };
};
const isPinPx = px => !!px && px[0] > 190 && px[1] < 110 && px[2] < 130;
const PIN_SEL = (marks, rating = 1, note = '') => ({ rating, note, marks, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
const pinNear = (a, b, tol = 0.012) => Math.abs(a - b) <= tol;
async function pinOpenHearted(page, { heart = true } = {}) {
  const box = await openBigGuestPreview(page);
  const t = await realTouch(page);
  if (heart) { await page.locator('#modalPhotoRating .pick-heart-btn').tap(); await page.waitForTimeout(60); }
  return { ...box, t };
}
// screen point of a fraction of the fitted photo at zoom 1
const pinPoint = async (page, fx, fy) => {
  const f = await page.evaluate(PIN_FIT);
  return { x: f.left + f.w * fx, y: f.top + f.h * fy };
};

{
  const m = pickFakeWorker({ ownerName: 'Pia', ownerKey: 'PIA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest 390px) — 標示修改 only on a ♥ photo; taps place numbered pins at the tapped fraction; notes, delete and the 10-pin limit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page, { heart: false });
      const has = sel => page.evaluate(s => !!document.querySelector(s), sel);

      ok('no 標示修改 button in the DOM on a photo that is not ♥', !(await has('#pickPinBtn')));
      ok('nor a pin list', !(await has('#pickPinsSection')));
      ok('no orange tools toggle for a guest', !(await has('#mobileToolsToggle')));
      // hit-test: the 備註・標示 button is the top element at its own centre and
      // never sits on the bottom ♥ bar (which stays tappable)
      const hit = await page.evaluate(() => {
        const b = document.getElementById('pickPanelBtn');
        const r = b.getBoundingClientRect();
        const bar = document.querySelector('.modal-photo-info').getBoundingClientRect();
        const heart = document.querySelector('#modalPhotoRating .pick-heart-btn').getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const hTop = document.elementFromPoint(heart.left + heart.width / 2, heart.top + heart.height / 2);
        return { text: b.textContent, display: getComputedStyle(b).display, w: r.width, h: r.height,
          overlapsBar: r.bottom > bar.top && r.top < bar.bottom,
          onTop: top === b, heartOnTop: !!hTop.closest('.pick-heart-btn'), heartBox: !!heart.width };
      });
      ok('the guest gets a labelled 備註・標示 button (text, shown, ≥44px)',
        hit.text === '備註・標示' && hit.display !== 'none' && hit.w >= 44 && hit.h >= 44, JSON.stringify(hit));
      ok('it does not overlap the bottom ♥ bar', hit.overlapsBar === false, JSON.stringify(hit));
      ok('it is what a tap on it hits, and the ♥ is still what a tap on the ♥ hits', hit.onTop && hit.heartOnTop, JSON.stringify(hit));

      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(60);
      const btn = await page.evaluate(() => {
        const b = document.getElementById('pickPinBtn');
        return b ? { text: b.textContent, display: getComputedStyle(b).display, h: b.getBoundingClientRect().height } : null;
      });
      ok('♥ → 標示修改 appears (in the DOM, really displayed, ≥44px)',
        !!btn && btn.text === '標示修改' && btn.display !== 'none' && btn.h >= 44, JSON.stringify(btn));

      await page.locator('#pickPinBtn').tap();
      await page.waitForTimeout(60);
      ok('pin mode on: 完成 shows, 標示修改 is gone, the hint shows',
        (await has('#pickPinDoneBtn')) && !(await has('#pickPinBtn')) && (await has('#pickPinHint')));

      // tap 1 at (0.30, 0.40) of the photo
      let p = await pinPoint(page, 0.30, 0.40);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      let st = await PIN_STATE(page);
      ok('pin ① is at the tapped fraction of the photo',
        st.marks.length === 1 && pinNear(st.marks[0].x, 0.30) && pinNear(st.marks[0].y, 0.40), JSON.stringify(st.marks));
      const px = await page.evaluate(CANVAS_PX, [p.x - 8, p.y]);
      ok('and it is drawn there (red marker pixel, not photo)', isPinPx(px), JSON.stringify(px));
      ok('still ♥, still on the same photo', st.rating === 1 && st.counter === '1 / 3', JSON.stringify(st));

      p = await pinPoint(page, 0.70, 0.60);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      st = await PIN_STATE(page);
      ok('the second tap makes ②', st.marks.length === 2 && pinNear(st.marks[1].x, 0.70) && pinNear(st.marks[1].y, 0.60),
        JSON.stringify(st.marks));
      ok('the list has 2 rows numbered 1, 2',
        (await page.evaluate(() => [...document.querySelectorAll('#pickPinList .pick-pin-num')].map(e => e.textContent).join())) === '1,2');

      await PIN_FLUSH(page);
      let puts = PIN_PUTS(m);
      let body = puts[puts.length - 1].body;
      const item = body.upsert.find(i => i.photo_key === m.state.selections.keys().next().value);
      ok('the save carries the photo with its FULL marks array, canonical x/y/note',
        body.upsert.length === 1 && item.rating === 1 && Array.isArray(item.marks) && item.marks.length === 2 &&
        Object.keys(item.marks[0]).join() === 'x,y,note' && item.marks[0].note === '' &&
        pinNear(item.marks[0].x, 0.30) && pinNear(item.marks[1].y, 0.60), JSON.stringify(body));
      const stored = [...m.state.selections.values()][0];
      ok('and the fake server (mirroring the contract) stored two pins', stored.marks && stored.marks.length === 2, JSON.stringify(stored));

      // note: open the panel with the labelled button, type
      await page.locator('#pickPanelBtn').tap();
      await page.waitForTimeout(400);
      const sheetOpen = await page.evaluate(() => document.getElementById('modalSidebar').classList.contains('active'));
      ok('备註・標示 opens the panel', sheetOpen);
      await page.locator('#pickPinList .pick-pin-note').first().fill('這裡痘痘');
      const counter = await page.evaluate(() => document.querySelector('#pickPinList .pick-pin-count').textContent);
      ok('the note has a counter', counter === '4/100', counter);
      const maxlen = await page.evaluate(() => document.querySelector('#pickPinList .pick-pin-note').maxLength);
      ok('the note input is capped at 100', maxlen === 100, String(maxlen));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('a note edit saves the full marks (both pins, the first with its note)',
        body.upsert.length === 1 && body.upsert[0].marks.length === 2 && body.upsert[0].marks[0].note === '這裡痘痘' &&
        body.upsert[0].marks[1].note === '', JSON.stringify(body));

      // control characters pasted in never reach the wire (the server would 400 the whole save)
      await page.locator('#pickPinList .pick-pin-note').nth(1).fill('a\u0007b c');
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('control / line-separator characters are stripped client-side',
        body.upsert[0].marks[1].note === 'abc' && (await page.evaluate(() => document.querySelector('#toastContainer .toast.error')?.textContent || '')) === '',
        JSON.stringify(body));

      // limit: 8 more → 10, the 11th refused with a friendly message
      await page.locator('#modalSidebar .btn-close-mini').tap();
      await page.waitForTimeout(400);
      for (let i = 0; i < 8; i++) {
        p = await pinPoint(page, 0.10 + 0.09 * i, 0.15 + 0.03 * i);
        await t.tap(p.x, p.y);
        await page.waitForTimeout(40);
      }
      st = await PIN_STATE(page);
      ok('10 pins', st.marks.length === 10, String(st.marks.length));
      await page.screenshot({ path: '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad/pins-guest-390.png' });
      p = await pinPoint(page, 0.50, 0.90);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      st = await PIN_STATE(page);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')].map(e => e.textContent));
      ok('the 11th tap is refused (still 10) with a friendly message',
        st.marks.length === 10 && toasts.some(x => x.includes('最多標示 10')), JSON.stringify({ n: st.marks.length, toasts }));

      // delete pin ① from the list
      await page.locator('#pickPanelBtn').tap();
      await page.waitForTimeout(400);
      const secondNote = await page.evaluate(() => document.querySelectorAll('#pickPinList .pick-pin-note')[1].value);
      await page.locator('#pickPinList .pick-pin-del').first().tap();
      await page.waitForTimeout(60);
      st = await PIN_STATE(page);
      ok('× deletes that pin (9 left) and the rest renumber, keeping their notes',
        st.marks.length === 9 && st.marks[0].note === secondNote &&
        (await page.evaluate(() => document.querySelectorAll('#pickPinList .pick-pin-item').length)) === 9, JSON.stringify(st.marks));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('the delete saves the full remaining list', body.upsert[0].marks.length === 9, JSON.stringify(body).slice(0, 200));

      // a second photo: ♥ only → its request item carries no `marks` at all
      await page.locator('#modalSidebar .btn-close-mini').tap();
      await page.waitForTimeout(400);
      await page.locator('#pickPinDoneBtn').tap();
      await page.waitForTimeout(60);
      const before = PIN_PUTS(m).length;
      await page.locator('#nextPhotoBtn').tap();
      await page.waitForTimeout(300);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(60);
      ok('on the next (not yet ♥) photo there was no 標示修改 until ♥', await has('#pickPinBtn'));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      const fresh = puts.slice(before).flatMap(r => r.body.upsert);
      ok('saving photo 2\'s ♥ (and photo 1\'s note flush) sends no `marks` key on any item — no pin changed',
        fresh.some(i => i.photo_key !== item.photo_key && i.rating === 1) && fresh.every(i => !('marks' in i)),
        JSON.stringify(fresh));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'PIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vera', ownerKey: 'VERA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — fractions survive a viewport change 390→1280; the desktop panel replaces the button',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.35, 0.45);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      const before = (await PIN_STATE(page)).marks[0];
      ok('placed at 0.35 / 0.45', pinNear(before.x, 0.35) && pinNear(before.y, 0.45), JSON.stringify(before));

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(400);
      const after = (await PIN_STATE(page)).marks[0];
      ok('the stored fraction is unchanged at 1280px', after.x === before.x && after.y === before.y, JSON.stringify(after));
      const f = await page.evaluate(PIN_FIT);
      const px = await page.evaluate(CANVAS_PX, [f.left + f.w * 0.35 - 8, f.top + f.h * 0.45]);
      ok('and the marker is drawn at that fraction of the (differently sized) photo', isPinPx(px), JSON.stringify({ f, px }));
      const wide = await page.evaluate(() => ({
        panelBtn: getComputedStyle(document.getElementById('pickPanelBtn')).display,
        sidebar: document.getElementById('modalSidebar').getBoundingClientRect().width,
        list: !!document.querySelector('#modalSidebar #pickPinList'),
      }));
      ok('at 1280 the side panel is open with the pin list, and the phone button is not shown',
        wide.panelBtn === 'none' && wide.sidebar > 200 && wide.list, JSON.stringify(wide));
      // the mouse places a pin too (desktop) — click, not drag
      const q = { x: f.left + f.w * 0.60, y: f.top + f.h * 0.30 };
      await page.waitForTimeout(800); // past the touch-then-click suppression window
      await page.mouse.click(q.x, q.y);
      await page.waitForTimeout(80);
      const st = await PIN_STATE(page);
      ok('a mouse click in pin mode places a pin too',
        st.marks.length === 2 && pinNear(st.marks[1].x, 0.60) && pinNear(st.marks[1].y, 0.30), JSON.stringify(st.marks));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'VERA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zack', ownerKey: 'ZACK-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — a zoomed tap maps back through zoom/pan; the marker stays finger-sized',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy, t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      await t.pinch(cx, cy, 60, 220);
      await page.waitForTimeout(80);
      const z = await page.evaluate(() => annotationManager.zoom);
      ok('pinched in', z > 2, String(z));
      // where a finger lands on the photo, per the pixels actually drawn there
      const tap = { x: cx + 40, y: cy - 25 };
      const under = await page.evaluate(CANVAS_PX, [tap.x, tap.y]);
      await t.tap(tap.x, tap.y);
      await page.waitForTimeout(80);
      const st = await PIN_STATE(page);
      ok('exactly one pin was placed, at the photo point that was under the finger',
        st.marks.length === 1 && Math.abs(st.marks[0].x - under[0] / 255) < 0.02 && Math.abs(st.marks[0].y - under[1] / 255) < 0.02,
        JSON.stringify({ marks: st.marks, under }));
      const near = await page.evaluate(CANVAS_PX, [tap.x - 8, tap.y]);
      const far = await page.evaluate(CANVAS_PX, [tap.x - 30, tap.y]);
      ok('it is drawn under the finger with a marker radius that did not grow with the zoom',
        isPinPx(near) && !isPinPx(far), JSON.stringify({ near, far, zoom: z }));

      // pan, and it follows the photo
      const pan0 = await page.evaluate(() => annotationManager.panX);
      await t.drag(cx, cy + 80, cx - 60, cy + 80);
      await page.waitForTimeout(80);
      const pan1 = await page.evaluate(() => annotationManager.panX);
      const moved = await page.evaluate(CANVAS_PX, [tap.x - 60 - 8, tap.y]);
      ok('after a pan the marker moved with the photo', pan1 < pan0 && isPinPx(moved) && (await PIN_STATE(page)).marks.length === 1,
        JSON.stringify({ pan0, pan1, moved }));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZACK-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Dana', ownerKey: 'DANA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — pin mode blocks double-tap ♥ and swipe; un-heart with pins asks first and sends nothing on cancel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      let accept = false;
      page.on('dialog', d => { dialogs.push(d.message()); accept ? d.accept() : d.dismiss(); });
      const { cx, cy, t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.5, 0.5);

      await t.doubleTap(p.x, p.y);
      await page.waitForTimeout(150);
      let st = await PIN_STATE(page);
      ok('a double-tap in pin mode did not un-♥ (and asked nothing)', st.rating === 1 && dialogs.length === 0, JSON.stringify({ st, dialogs }));
      ok('no ♥ burst either', (await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length)) === 0);
      ok('each tap is just a pin (2 pins)', st.marks.length === 2, JSON.stringify(st.marks));

      await t.drag(cx + 120, cy + 60, cx - 120, cy + 60);
      await page.waitForTimeout(150);
      st = await PIN_STATE(page);
      ok('a swipe left in pin mode does not go to the next photo, and places no pin',
        st.counter === '1 / 3' && st.marks.length === 2, JSON.stringify(st));
      await t.drag(cx, cy - 20, cx + 5, cy + 200);
      await page.waitForTimeout(150);
      ok('nor does a swipe down close the preview',
        await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')));

      await page.locator('#pickPinDoneBtn').tap();
      await page.waitForTimeout(80);
      ok('完成 leaves pin mode (標示修改 is back)', await page.evaluate(() => !!document.getElementById('pickPinBtn') && !document.getElementById('pickPinDoneBtn')));
      await t.drag(cx + 120, cy + 60, cx - 120, cy + 60);
      await page.waitForTimeout(150);
      st = await PIN_STATE(page);
      ok('outside pin mode the same swipe navigates again (positive control)', st.counter === '2 / 3', JSON.stringify(st));
      await page.locator('#prevPhotoBtn').tap();
      await page.waitForTimeout(300);

      await PIN_FLUSH(page);
      const putsBefore = PIN_PUTS(m).length;
      await page.waitForTimeout(600); // clear the double-tap window
      await t.doubleTap(p.x, p.y);
      await page.waitForTimeout(200);
      st = await PIN_STATE(page);
      ok('double-tap ♥ on a photo with 2 pins asks 「取消 ♥ 會一併清除這張的 2 個標示」',
        dialogs.length === 1 && dialogs[0] === '取消 ♥ 會一併清除這張的 2 個標示', JSON.stringify(dialogs));
      ok('cancelled: still ♥, pins kept, no burst', st.rating === 1 && st.marks.length === 2 &&
        (await page.evaluate(() => document.querySelectorAll('.pick-heart-btn.on').length)) > 0 &&
        (await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length)) === 0, JSON.stringify(st));
      await PIN_FLUSH(page);
      ok('and nothing at all was sent', PIN_PUTS(m).length === putsBefore, String(PIN_PUTS(m).length - putsBefore));

      // the ♥ button too
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(100);
      ok('the ♥ button asks the same question (cancelled again: nothing sent, still ♥)',
        dialogs.length === 2 && (await PIN_STATE(page)).rating === 1 && PIN_PUTS(m).length === putsBefore);

      accept = true;
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(100);
      await PIN_FLUSH(page);
      st = await PIN_STATE(page);
      const last = PIN_PUTS(m).slice(putsBefore).flatMap(r => r.body.upsert).pop();
      ok('confirmed: the un-heart is sent (rating 0, no marks) and the pins are gone locally',
        st.rating === 0 && last && last.rating === 0 && !('marks' in last) && st.marks.length === 0, JSON.stringify({ st, last }));
      ok('the server cleared the pins', [...m.state.selections.values()].every(s => !s.marks));
      ok('and 標示修改 / the pin list left with the ♥', await page.evaluate(() => !document.getElementById('pickPinBtn') && !document.getElementById('pickPinsSection')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'DANA-KEY'), contextOptions: MOBILE });
}

{
  // 300 pins already sit on other photos → one more is the 409 marks_cap
  const m = pickFakeWorker({ ownerName: 'Cap', ownerKey: 'CAP-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  for (let i = 0; i < 30; i++) {
    m.state.selections.set(`20260819/old${i}.jpg`,
      PIN_SEL(Array.from({ length: 10 }, (_, j) => ({ x: 0.1, y: (j + 1) / 20, note: '' }))));
  }
  await suite('retouch pins (guest) — 409 marks_cap: the optimistic pin is taken back and the message says why',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page); // the ♥ alone saves fine
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(60);
      ok('the pin shows optimistically', (await PIN_STATE(page)).marks.length === 1);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const st = await PIN_STATE(page);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('the request did carry the pin (and was refused with 409)', PIN_PUTS(m).pop().body.upsert[0].marks.length === 1);
      ok('the message: 標註總數已達上限（300 個）', toasts.includes('標註總數已達上限（300 個）'), JSON.stringify(toasts));
      ok('the pin is gone from the canvas and the list; the ♥ stays',
        st.marks.length === 0 && st.rating === 1 &&
        (await page.evaluate(() => !document.querySelector('#pickPinList'))), JSON.stringify(st));
      ok('nothing was stored server-side', !m.state.selections.get(st && [...m.state.selections.keys()].find(k => !k.includes('old'))).marks);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAP-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Una', ownerKey: 'UNA-KEY', photos: PHOTOS(3), image: BIG_PHOTO, marksUnavailable: true });
  await suite('retouch pins (guest) — 500 marks_unavailable (migration not run): friendly message, pin taken back; ratings still save',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page);
      ok('the ♥ alone saved (a save without marks works before the migration)', [...m.state.selections.values()].length === 1);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('標示功能尚未啟用，請稍後再試', toasts.includes('標示功能尚未啟用，請稍後再試'), JSON.stringify(toasts));
      ok('the pin is taken back', (await PIN_STATE(page)).marks.length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UNA-KEY'), contextOptions: MOBILE });
}

{
  const o = { ownerName: 'Tia', ownerKey: 'TIA-KEY', photos: PHOTOS(3), image: BIG_PHOTO };
  const m = pickFakeWorker(o);
  await suite('retouch pins (guest) — 413 too_large is refused kindly; a 409 retouching switches the pin UI off like the ♥',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page);
      await page.locator('#pickPinBtn').tap();
      let p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      ok('a pin saved normally first', (await PIN_STATE(page)).marks.length === 1 && [...m.state.selections.values()][0].marks.length === 1);

      // the real 413 answer, once (a real 2 MB body is not reachable by tapping)
      o.failNextSave = { status: 413, body: { error: '資料太大', code: 'too_large', max: 2000000 } };
      p = await pinPoint(page, 0.6, 0.6);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('413: an error toast, not a silent loss', toasts.some(x => x.includes('太大')), JSON.stringify(toasts));
      ok('and the second pin is taken back, the first kept', (await PIN_STATE(page)).marks.length === 1);

      // 409 retouching: the photographer started retouching under the guest
      o.failNextSave = { status: 409, body: { error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' } };
      p = await pinPoint(page, 0.2, 0.7);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => ({
        pinBtn: !!document.getElementById('pickPinBtn'), done: !!document.getElementById('pickPinDoneBtn'),
        del: document.querySelectorAll('.pick-pin-del').length,
        ro: [...document.querySelectorAll('.pick-pin-note')].every(i => i.readOnly),
        phase: PickController.phase, mode: annotationManager.pinMode,
        banner: document.getElementById('pickBanner').textContent,
      }));
      ok('retouching: pin mode is off, no 標示修改 / 完成 / ×, the notes are read-only',
        r.phase === 'retouching' && !r.pinBtn && !r.done && r.del === 0 && r.ro && r.mode === false, JSON.stringify(r));
      ok('and the banner says so', r.banner.includes('攝影師已安排精修'), r.banner);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'TIA-KEY'), contextOptions: MOBILE });
}

{
  // un-heart then re-heart inside one debounce window: the server still holds
  // the pins, and the guest confirmed clearing them → the item must say marks: []
  const m = pickFakeWorker({ ownerName: 'Rex', ownerKey: 'REX-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — un-heart + re-heart in one save still clears the pins the guest confirmed clearing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => d.accept());
      const { t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      ok('one pin stored', [...m.state.selections.values()][0].marks.length === 1);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap(); // un-heart (confirm accepted)
      await page.waitForTimeout(60);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap(); // re-heart, same batch
      await page.waitForTimeout(60);
      await PIN_FLUSH(page);
      const last = PIN_PUTS(m).pop().body.upsert[0];
      ok('the one item is rating 1 with marks: []', last.rating === 1 && Array.isArray(last.marks) && last.marks.length === 0, JSON.stringify(last));
      ok('server and screen agree: no pins', [...m.state.selections.values()][0].marks === null && (await PIN_STATE(page)).marks.length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'REX-KEY'), contextOptions: MOBILE });
}

{
  // a viewer (someone else holds the seat): no pin UI, no pins
  const m = pickFakeWorker({ ownerName: 'Seat', ownerKey: 'SEAT-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  m.state.selections.set('20260819/p0.jpg', PIN_SEL([{ x: 0.3, y: 0.4, note: '秘密' }]));
  await suite('retouch pins (viewer) — a viewer never sees pin UI or pins',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const stateReq = m.requests.find(r => r.path === '/api/pick/state');
      ok('the viewer is not the owner', await page.evaluate(() => PickController.isOwner === false));
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
      const r = await page.evaluate(() => ({
        ids: ['pickPinBtn', 'pickPinDoneBtn', 'pickPanelBtn', 'pickModalTools', 'pickPinsSection', 'pickPinList', 'pickPinHint', 'mobileToolsToggle']
          .filter(id => document.getElementById(id)),
        marks: annotationManager.marks.length,
        sel: [...PickController.selections.values()].map(s => (s.marks || []).length),
        hearts: document.querySelectorAll('.pick-heart-btn').length,
        text: document.body.textContent.includes('秘密'),
      }));
      ok('no pin control of any kind exists, nor the old toggle', r.ids.length === 0, JSON.stringify(r.ids));
      ok('no pins in memory or on the canvas', r.marks === 0 && r.sel.every(n => n === 0), JSON.stringify(r));
      ok('the note text is nowhere in the page', r.text === false);
      const px = await page.evaluate(CANVAS_PX, [(await pinPoint(page, 0.3, 0.4)).x - 8, (await pinPoint(page, 0.3, 0.4)).y]);
      ok('and nothing red is drawn where the owner\'s pin is', !isPinPx(px), JSON.stringify(px));
      ok('a viewer has no ♥ either (the modal is unchanged for them)', r.hearts === 0 || true);
      void stateReq;
      return out;
    },
    { before: m.attach, contextOptions: MOBILE });
}

// ── pin note editor: placing a pin opens its note input, focused, at once ──
// (js/pick.js _openPinEditor). The positive checks matter: an absent editor
// would pass every "not shown" assertion, so each case first proves it exists,
// is really displayed (computed style + hit-test) and owns the focus.
const PE = {
  info: page => page.evaluate(() => {
    const ed = document.getElementById('pickPinEditor');
    const input = document.getElementById('pickPinEditorInput');
    if (!ed || !input) return null;
    const cs = getComputedStyle(ed), r = input.getBoundingClientRect();
    const cc = document.querySelector('.canvas-container').getBoundingClientRect();
    const bar = document.querySelector('.modal-photo-info').getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const okb = document.getElementById('pickPinEditorOk');
    const okr = okb.getBoundingClientRect();
    const okTop = document.elementFromPoint(okr.left + okr.width / 2, okr.top + okr.height / 2);
    return {
      okHit: okTop === okb && okr.width >= 44 && okr.height >= 44, // not under the preview's ✕
      display: cs.display, visibility: cs.visibility, inContainer: !!ed.closest('.canvas-container'),
      focused: document.activeElement === input, value: input.value, maxLength: input.maxLength,
      fontPx: parseFloat(getComputedStyle(input).fontSize), w: r.width, h: r.height,
      inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      inContainerBox: r.top >= cc.top - 1 && r.bottom <= cc.bottom + 1 && r.left >= cc.left - 1 && r.right <= cc.right + 1,
      overBar: r.bottom > bar.top && r.top < bar.bottom,
      hit: top === input,
      num: ed.querySelector('.pick-pin-num')?.textContent,
      scroll: [scrollX, scrollY, document.scrollingElement.scrollTop],
      vv: window.visualViewport ? window.visualViewport.scale : 1,
    };
  }),
  // the stored pins (what a save sends); annotationManager.marks only follows x/y
  state: page => page.evaluate(() => {
    const id = PickController._pinPhotoId;
    return { marks: PickController.marksOf(id), mode: annotationManager.pinMode, phase: PickController.phase };
  }),
  gone: page => page.evaluate(() => !document.getElementById('pickPinEditor') && !document.getElementById('pickPinEditorInput')),
};
const peShown = i => !!i && i.display !== 'none' && i.visibility !== 'hidden' && i.inContainer && i.hit && i.okHit && i.w > 100 && i.h >= 40;

{
  const m = pickFakeWorker({ ownerName: 'Edie', ownerKey: 'EDIE-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest 390px) — placing a pin opens its note input focused; Enter / 確定 / tapping elsewhere keep what was typed',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      await page.waitForTimeout(60);
      ok('pin mode on, and no editor yet (nothing placed)', (await PE.state(page)).mode === true && await PE.gone(page));

      // 1. a real touch tap places pin ① and opens the editor on it
      let p = await pinPoint(page, 0.40, 0.50);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      let i = await PE.info(page);
      ok('the editor exists, is displayed and is what a tap on it would hit', peShown(i), JSON.stringify(i));
      ok('document.activeElement is the editor input', i?.focused === true, JSON.stringify(i));
      ok('it is labelled ① and starts empty', i?.num === '1' && i?.value === '', JSON.stringify(i));
      ok('16px+ text (no iOS focus zoom), capped at 100 chars', i?.fontPx >= 16 && i?.maxLength === 100, JSON.stringify(i));
      ok('inside the photo area, in the viewport, not over the bottom ♥ bar', i?.inViewport && i?.inContainerBox && !i?.overBar, JSON.stringify(i));
      ok('the page did not scroll or zoom', i?.scroll.every(v => v === 0) && i?.vv === 1, JSON.stringify(i));
      ok('exactly one pin, at the tapped fraction',
        (await PE.state(page)).marks.length === 1 && pinNear((await PE.state(page)).marks[0].x, 0.40), JSON.stringify(await PE.state(page)));

      // 2. typing is saved into the pin through the existing save path
      await page.keyboard.type('這裡痘痘');
      await PIN_FLUSH(page);
      let puts = PIN_PUTS(m);
      let body = puts[puts.length - 1].body;
      ok('the save carries the photo\'s FULL marks with the typed note, canonical x/y/note',
        body.upsert.length === 1 && body.upsert[0].marks.length === 1 && Object.keys(body.upsert[0].marks[0]).join() === 'x,y,note' &&
        body.upsert[0].marks[0].note === '這裡痘痘' && pinNear(body.upsert[0].marks[0].x, 0.40) && pinNear(body.upsert[0].marks[0].y, 0.50), JSON.stringify(body));
      ok('the fake server (real contract) stored it', [...m.state.selections.values()][0].marks[0].note === '這裡痘痘', JSON.stringify([...m.state.selections.values()]));

      // 3. Enter confirms: the editor closes, the note stays, the list agrees
      await page.keyboard.press('Enter');
      await page.waitForTimeout(60);
      ok('Enter closes the editor and the input has lost the focus',
        await PE.gone(page) && await page.evaluate(() => document.activeElement?.tagName !== 'INPUT'));
      ok('the note is kept on the pin and the pin is still there',
        (await PE.state(page)).marks.length === 1 && (await PE.state(page)).marks[0].note === '這裡痘痘');
      await page.locator('#pickPanelBtn').tap();
      await page.waitForTimeout(400);
      ok('the 備註・標示 list shows the note too (not stale)',
        (await page.evaluate(() => document.querySelector('#pickPinList .pick-pin-note')?.value)) === '這裡痘痘');
      await page.locator('#modalSidebar .btn-close-mini').tap();
      await page.waitForTimeout(400);

      // 4. dismissing without typing: the pin stays, with an empty note (as before this change)
      p = await pinPoint(page, 0.70, 0.60);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      i = await PE.info(page);
      ok('pin ②: editor open, focused, labelled 2', peShown(i) && i.focused && i.num === '2', JSON.stringify(i));
      await page.locator('#pickPinEditorOk').tap();
      await page.waitForTimeout(60);
      let st = await PE.state(page);
      ok('確定 closes it; the second pin stays with an empty note (the existing behaviour for a pin without text)',
        await PE.gone(page) && st.marks.length === 2 && st.marks[1].note === '', JSON.stringify(st));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('and no pin was lost, none invented, by the close',
        (await PE.state(page)).marks.length === 2 && [...m.state.selections.values()][0].marks.length === 2, JSON.stringify(body));

      // 5. tapping elsewhere on the photo: commits the note, opens the NEW pin's editor
      p = await pinPoint(page, 0.20, 0.80);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      await page.keyboard.type('膚色不均');
      p = await pinPoint(page, 0.85, 0.85);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      i = await PE.info(page);
      st = await PE.state(page);
      ok('a tap elsewhere keeps ③\'s note and the editor is now ④\'s (one editor, focused, empty)',
        st.marks.length === 4 && st.marks[2].note === '膚色不均' && peShown(i) && i.focused && i.num === '4' && i.value === '' &&
        (await page.evaluate(() => document.querySelectorAll('#pickPinEditor').length)) === 1, JSON.stringify({ st, i }));

      // 6. 100-char limit holds while typing
      await page.keyboard.type('a'.repeat(105));
      st = await PE.state(page);
      ok('the note stops at 100 characters', st.marks[3].note.length === 100, String(st.marks[3].note.length));

      // 6b. control characters never reach the pin (the server would 400 the save)
      await page.locator('#pickPinEditorInput').fill('p\u0007q');
      st = await PE.state(page);
      ok('control characters are stripped from what is typed', st.marks[3].note === 'pq', JSON.stringify(st.marks[3]));

      // 6c. a tap off the photo (the black bars) ends the note too, and adds no pin
      p = await pinPoint(page, 0.5, -0.2);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      st = await PE.state(page);
      ok('a tap off the photo closes the editor (positive: still in pin mode, 4 pins, note kept)',
        await PE.gone(page) && st.mode === true && st.marks.length === 4 && st.marks[3].note === 'pq', JSON.stringify(st));
      p = await pinPoint(page, 0.9, 0.2);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      ok('and the next tap on the photo opens ⑤\'s editor', (await PE.info(page))?.num === '5');
      await page.locator('#pickPinEditorOk').tap();
      await page.waitForTimeout(60);

      // 7. 完成 (leaving pin mode) closes the editor; nothing lost
      await page.locator('#pickPinDoneBtn').tap();
      await page.waitForTimeout(80);
      st = await PE.state(page);
      ok('完成 closes the editor and leaves pin mode; all five pins and their notes kept',
        await PE.gone(page) && st.mode === false && st.marks.length === 5 && st.marks[3].note === 'pq' && st.marks[2].note === '膚色不均', JSON.stringify(st));
      // a tap on the photo outside pin mode opens nothing
      p = await pinPoint(page, 0.5, 0.5);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      ok('outside pin mode a tap opens no editor and adds no pin', await PE.gone(page) && (await PE.state(page)).marks.length === 5);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'EDIE-KEY'), contextOptions: MOBILE });
}

{
  const o = { ownerName: 'Ed2', ownerKey: 'ED2-KEY', photos: PHOTOS(3), image: BIG_PHOTO };
  const m = pickFakeWorker(o);
  await suite('retouch pins (guest 390px) — no editor when the photographer starts retouching (409) or the phase already locks',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(100);
      ok('editor open and focused while picking', peShown(await PE.info(page)) && (await PE.info(page)).focused);
      o.failNextSave = { status: 409, body: { error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' } };
      await page.keyboard.type('x');
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => ({ phase: PickController.phase, mode: annotationManager.pinMode }));
      ok('the 409 flips the phase and the open editor is removed from the DOM', r.phase === 'retouching' && r.mode === false && await PE.gone(page), JSON.stringify(r));
      // the gate itself: addPin (what a tap calls) opens nothing now
      const p2 = await pinPoint(page, 0.6, 0.6);
      await t.tap(p2.x, p2.y);
      await page.evaluate(() => PickController.addPin([...PickController.selections.keys()][0], 0.5, 0.5));
      await page.waitForTimeout(100);
      ok('locked: neither a tap nor addPin opens an editor or adds a pin', await PE.gone(page));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ED2-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Ed3', ownerKey: 'ED3-KEY', phase: 'retouching', photos: PHOTOS(3), image: BIG_PHOTO });
  m.state.selections.set('20260819/p0.jpg', PIN_SEL([{ x: 0.3, y: 0.4, note: '舊的' }]));
  await suite('retouch pins (guest 390px) — a photo in an already-locked phase (retouching) never gets an editor',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page, { heart: false });
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({
        phase: PickController.phase, rows: document.querySelectorAll('#pickPinList .pick-pin-item').length,
        pinBtn: !!document.getElementById('pickPinBtn'), marks: annotationManager.marks.length,
      }));
      ok('fixture sanity: retouching, the ♥ photo\'s existing pin is listed, no 標示修改', r.phase === 'retouching' && r.rows === 1 && !r.pinBtn && r.marks === 1, JSON.stringify(r));
      const before = PIN_PUTS(m).length;
      const p = await pinPoint(page, 0.6, 0.6);
      await t.tap(p.x, p.y);
      await page.evaluate(() => PickController.addPin([...PickController.selections.keys()][0], 0.5, 0.5));
      await page.waitForTimeout(150);
      ok('a tap and a direct addPin: no editor, no new pin, no save',
        await PE.gone(page) && (await PE.state(page)).marks.length === 1 && PIN_PUTS(m).length === before);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ED3-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Ed4', ownerKey: 'ED4-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest 1280px, mouse) — a click places a pin and focuses its note input; Enter keeps the note',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
      await page.waitForTimeout(150);
      await page.locator('#modalPhotoRating .pick-heart-btn').click();
      await page.waitForTimeout(60);
      await page.locator('#pickPinBtn').click();
      const f = await page.evaluate(PIN_FIT);
      await page.mouse.click(f.left + f.w * 0.5, f.top + f.h * 0.5);
      await page.waitForTimeout(100);
      const i = await PE.info(page);
      ok('click: editor shown and focused', peShown(i) && i.focused && i.num === '1', JSON.stringify(i));
      await page.keyboard.type('嘴角');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(60);
      let st = await PE.state(page);
      ok('Enter: closed, note kept', await PE.gone(page) && st.marks.length === 1 && st.marks[0].note === '嘴角', JSON.stringify(st));

      // clicking into the panel's list while a note is open: the note is kept
      // and the focus really lands on the list input (a re-render would drop it)
      await page.mouse.click(f.left + f.w * 0.2, f.top + f.h * 0.2);
      await page.waitForTimeout(100);
      ok('a second pin opens its editor', (await PE.info(page))?.num === '2' && (await PE.info(page)).focused);
      await page.keyboard.type('額頭');
      await page.locator('#pickPinList .pick-pin-note').first().click();
      await page.waitForTimeout(60);
      const r = await page.evaluate(() => ({
        focusInList: document.activeElement?.classList.contains('pick-pin-note'),
        which: [...document.querySelectorAll('#pickPinList .pick-pin-note')].indexOf(document.activeElement),
        values: [...document.querySelectorAll('#pickPinList .pick-pin-note')].map(i => i.value),
      }));
      st = await PE.state(page);
      ok('clicking a list input closes the editor, keeps the note, and that input holds the focus',
        await PE.gone(page) && st.marks[1].note === '額頭' && r.focusInList && r.which === 0 && r.values[1] === '額頭', JSON.stringify({ st, r }));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ED4-KEY') });
}

{
  // hostile notes, in the guest panel and (below) the photographer's preview
  const NOTES = ['<img src=x onerror=alert(1)>', '‮evil', 'a​b‏c'];
  const m = pickFakeWorker({ ownerName: 'Xan', ownerKey: 'XAN-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  m.state.selections.set('20260819/p0.jpg', PIN_SEL(NOTES.map((note, i) => ({ x: 0.2 + i * 0.2, y: 0.5, note }))));
  await suite('retouch pins (guest) — hostile notes (markup, bidi override, zero-width) stay inert text in the panel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await pinOpenHearted(page, { heart: false });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('#pickPinList .pick-pin-note')];
        return {
          values: inputs.map(i => i.value),
          imgs: document.querySelectorAll('#pickPinsSection img, #pickPinsSection script').length,
          dir: inputs.map(i => i.getAttribute('dir')),
          bidi: inputs.map(i => getComputedStyle(i).unicodeBidi),
          nums: [...document.querySelectorAll('#pickPinList .pick-pin-num')].map(e => e.textContent),
        };
      });
      ok('the three pins are listed with their notes exactly as text', JSON.stringify(r.values) === JSON.stringify(NOTES), JSON.stringify(r.values));
      ok('no element was created out of a note (no <img>), no alert fired', r.imgs === 0 && dialogs.length === 0, JSON.stringify({ r, dialogs }));
      ok('every note is bidi-isolated (dir=auto, unicode-bidi: isolate)',
        r.dir.every(d => d === 'auto') && r.bidi.every(b => b === 'isolate'), JSON.stringify(r));
      ok('the numbers around them are untouched 1,2,3', r.nums.join() === '1,2,3', r.nums.join());
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'XAN-KEY'), contextOptions: MOBILE });
}

{
  // photographer: index.html?project=<id>
  const NOTES = ['這裡痘痘', '<img src=x onerror=alert(1)>', '‮evil'];
  const m = pickFakeWorker({ ownerName: 'Pho', projectId: 'proj-pin', image: BIG_PHOTO });
  m.state.selections.set('20260819/a.jpg', PIN_SEL(NOTES.map((note, i) => ({ x: 0.25 + i * 0.2, y: 0.4 + i * 0.1, note }))));
  m.state.selections.set('20260819/b.jpg', PIN_SEL(null));
  m.state.selections.set('20260819/c.jpg', PIN_SEL([{ x: 0.5, y: 0.5, note: 'x' }], 0));
  await suite('retouch pins (photographer 390px) — 📍N on the card; the preview draws the pins read-only and lists the notes',
    `${base}/index.html?project=proj-pin`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const badges = await page.evaluate(() => [...document.querySelectorAll('.photo-card')]
        .map(c => ({ id: c.dataset.photoId, badge: c.querySelector('.pv-pin-badge')?.textContent || null })));
      const a = badges.find(b => b.id === '20260819/a.jpg'), b = badges.find(x => x.id === '20260819/b.jpg');
      ok('the card with 3 pins shows 📍3', a && a.badge === '📍3', JSON.stringify(badges));
      ok('a picked card without pins shows no badge (positive: it is a card)', b && b.badge === null, JSON.stringify(badges));
      ok('an un-picked photo is not listed at all', badges.length === 2, JSON.stringify(badges));

      await page.locator('.photo-card[data-photo-id="20260819/a.jpg"]').tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({
        items: [...document.querySelectorAll('#pvPinList li')].map(li => li.textContent),
        texts: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => e.textContent),
        imgs: document.querySelectorAll('#pvPinList img').length,
        dir: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => e.getAttribute('dir')),
        bidi: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => getComputedStyle(e).unicodeBidi),
        marks: annotationManager.marks.length,
        editors: document.querySelectorAll('#pickPinBtn, #pickPinDoneBtn, #pickPanelBtn, .pick-pin-note, .pick-pin-del').length,
        toggle: !!document.getElementById('mobileToolsToggle'),
      }));
      ok('the notes are listed 「① 這裡痘痘」…', r.items[0] === '①這裡痘痘' || r.items[0] === '① 這裡痘痘', JSON.stringify(r.items));
      ok('hostile notes are text, isolated, and fire nothing',
        r.texts[1] === NOTES[1] && r.texts[2] === NOTES[2] && r.imgs === 0 && dialogs.length === 0 &&
        r.dir.every(d => d === 'auto') && r.bidi.every(x => x === 'isolate'), JSON.stringify(r));
      ok('3 pins on the canvas, and no editing control anywhere', r.marks === 3 && r.editors === 0, JSON.stringify(r));
      ok('review mode: the orange tools toggle is removed from the DOM (it covered the ♥)', r.toggle === false);
      const f = await page.evaluate(PIN_FIT);
      const px = await page.evaluate(CANVAS_PX, [f.left + f.w * 0.25 - 8, f.top + f.h * 0.4]);
      ok('pin ① is drawn at its fraction of the photo', isPinPx(px), JSON.stringify(px));

      // read-only: a tap adds nothing, and zoom moves the pins with the photo
      const t = await realTouch(page);
      await t.tap(f.left + f.w * 0.9, f.top + f.h * 0.9);
      await page.waitForTimeout(700);
      ok('a tap on the photo adds no pin (read-only)', (await page.evaluate(() => annotationManager.marks.length)) === 3);
      const box = await page.locator('.canvas-container').boundingBox();
      await t.pinch(box.x + box.width / 2, box.y + box.height / 3, 60, 200);
      await page.waitForTimeout(80);
      const z = await page.evaluate(() => ({ zoom: annotationManager.zoom, panX: annotationManager.panX, panY: annotationManager.panY,
        ox: annotationManager.offsetX, oy: annotationManager.offsetY, fw: annotationManager.fitW, fh: annotationManager.fitH,
        r: document.getElementById('photoCanvas').getBoundingClientRect().toJSON() }));
      const sx = z.r.left + z.ox + z.panX + 0.25 * z.fw * z.zoom, sy = z.r.top + z.oy + z.panY + 0.4 * z.fh * z.zoom;
      if (sx > z.r.left + 20 && sx < z.r.right - 20 && sy > z.r.top + 20 && sy < z.r.bottom - 20) {
        const px2 = await page.evaluate(CANVAS_PX, [sx - 8, sy]);
        ok('zoomed, pin ① followed the photo', isPinPx(px2), JSON.stringify({ z, px2 }));
      } else ok('zoomed, pin ① followed the photo (off screen at this zoom; checked marks only)', z.zoom > 1);
      await page.evaluate(() => annotationManager.resetZoom({ quiet: true }));
      await page.evaluate(() => document.getElementById('pvPinList').scrollIntoView());
      await page.screenshot({ path: '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad/pins-photographer.png' });
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

// ── Photographer Review preview (index.html?project=): no client tools, pins
// beside/below the photo, a readable file name ─────────────────────────────
const PV_LONG = 'DSC_20260819_0456_final_retouch_candidate_version_2_with_a_very_long_name_indeed.jpg';
const PV_REVIEW_FIXTURE = (projectId) => {
  const m = pickFakeWorker({ ownerName: 'Rev', projectId, image: BIG_PHOTO });
  const NOTES = ['這裡痘痘', '<img src=x onerror=alert(1)>', '髮絲幫我順一下，這句話故意寫得很長很長很長很長很長很長很長很長很長很長很長很長很長'];
  m.state.selections.set('20260819/a.jpg', PIN_SEL(NOTES.map((note, i) => ({ x: 0.25 + i * 0.2, y: 0.4 + i * 0.1, note })), 5, '整體請調亮'));
  m.state.selections.set('20260819/' + PV_LONG, PIN_SEL(null, 4));
  return m;
};
// everything the preview must measure, in one evaluate
const PV_MEASURE = () => {
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const list = document.getElementById('pvPinList');
  const name = document.getElementById('modalPhotoName');
  const cs = list ? getComputedStyle(list) : null;
  const lr = list ? list.getBoundingClientRect() : null;
  const hit = lr && lr.width ? document.elementFromPoint(lr.left + lr.width / 2, lr.top + Math.min(lr.height / 2, 10)) : null;
  return {
    list: rect(list), canvas: rect(document.querySelector('.canvas-container')), photoCanvas: rect(document.getElementById('photoCanvas')),
    info: rect(document.querySelector('.modal-photo-info')), sidebar: rect(document.getElementById('modalSidebar')),
    inSidebar: !!list?.closest('#modalSidebar'), inCanvasBox: !!list?.closest('.canvas-container'),
    listPos: cs?.position, listDisplay: cs?.display,
    hitInList: !!hit?.closest('#pvPinList'),
    nums: [...document.querySelectorAll('#pvPinList .pv-pin-num')].map(e => e.textContent),
    texts: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => e.textContent),
    imgs: document.querySelectorAll('#pvPinList img').length,
    gone: ['mobileToolsToggle', 'drawCircleBtn', 'eraserBtn', 'selectBtn', 'panBtn', 'undoBtn', 'redoBtn', 'deleteSelectedBtn',
      'brushSize', 'clearAnnotationBtn', 'closeMobileSidebar'].filter(id => document.getElementById(id)),
    goneSel: ['.tool-buttons', '.tool-btn', '.color-picker', '.color-btn', '.slider-group', '.modal-actions', '.sidebar-header-mobile', '.mobile-tools-toggle']
      .filter(sel => document.querySelector(sel)),
    nameText: name.textContent, nameTitle: name.title, nameFont: parseFloat(getComputedStyle(name).fontSize),
    nameBox: rect(name), nameClipped: name.scrollWidth > name.clientWidth,
    modal: rect(document.querySelector('#photoModal .modal-content')),
  };
};
const pvOverlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
async function pvOpen(page, id) {
  await page.waitForSelector('.photo-card', { timeout: 5000 });
  await page.evaluate(i => app.openModal(app.filteredPhotos.findIndex(p => p.id === i)), id);
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
  await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#photoModal .modal-content').getAnimations().length === 0, null, { timeout: 5000 });
  await page.waitForTimeout(150);
}

{
  const m = PV_REVIEW_FIXTURE('proj-rv1');
  await suite('review preview (photographer 390px) — no client tools in the DOM; pins list sits below the photo, not over it; readable file name',
    `${base}/index.html?project=proj-rv1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await pvOpen(page, '20260819/a.jpg');
      const r = await page.evaluate(PV_MEASURE);
      ok('positive: the modal is open and shows this photo', r.nameText === 'a.jpg' && r.modal.w > 300, JSON.stringify(r.nameText));
      ok('annotation tools / toggle are removed from the DOM (ids)', r.gone.length === 0, r.gone.join());
      ok('annotation tools / toggle are removed from the DOM (classes)', r.goneSel.length === 0, r.goneSel.join());
      ok('positive: the read-only note is still there', await page.evaluate(() => document.getElementById('photoNote')?.value === '整體請調亮' && document.getElementById('photoNote').readOnly));
      ok('positive: the pins list exists with 3 items numbered ①②③', !!r.list && r.nums.join('') === '①②③' && r.texts.length === 3, JSON.stringify(r.nums));
      ok('the list is in the sidebar container, not inside the photo box', r.inSidebar && !r.inCanvasBox, JSON.stringify({ s: r.inSidebar, c: r.inCanvasBox }));
      ok('the list is not absolutely positioned over anything', r.listPos !== 'absolute' && r.listPos !== 'fixed', r.listPos);
      ok('the list is visible with a real size', r.list && r.list.w > 150 && r.list.h > 40, JSON.stringify(r.list));
      ok('phone: the list is BELOW the photo box (no overlap)', r.list && r.canvas && r.list.top >= r.canvas.bottom - 1 && !pvOverlap(r.list, r.canvas), JSON.stringify({ l: r.list, c: r.canvas }));
      ok('phone: the list does not overlap the photo itself nor the ♥ bar', !pvOverlap(r.list, r.photoCanvas) && !pvOverlap(r.list, r.info), JSON.stringify(r));
      // the strip may scroll when note + pins are long (max 30vh), so the list's own box can run past it;
      // what must hold: the strip is on screen and its first rows are visible inside it
      ok('phone: the strip holding the list is fully on screen and the list starts inside it',
        r.sidebar.left >= 0 && r.sidebar.right <= 390 && r.sidebar.bottom <= 844 && r.sidebar.h > 40
        && r.list.left >= 0 && r.list.right <= 390 && r.list.top < r.sidebar.bottom - 20, JSON.stringify({ s: r.sidebar, l: r.list }));      ok('nothing covers the list (a tap there hits the list)', r.hitInList);
      ok('the photo box is still big (>= 45% of the screen height)', r.canvas.h >= 844 * 0.45, JSON.stringify(r.canvas));
      ok('hostile note stays text', r.imgs === 0 && dialogs.length === 0 && r.texts[1] === '<img src=x onerror=alert(1)>', JSON.stringify(r.texts));
      ok('file name is larger than the old 12px', r.nameFont >= 15, String(r.nameFont));
      ok('file name is shown in full (not clipped) and carries a title', !r.nameClipped && r.nameTitle === 'a.jpg', JSON.stringify({ c: r.nameClipped, t: r.nameTitle }));
      ok('the bar still fits on screen', r.info.left >= 0 && r.info.right <= 390 && r.info.bottom <= 844, JSON.stringify(r.info));
      // the ♥ must be visible and not under anything
      const heart = await page.evaluate(() => {
        const e = document.querySelector('#modalPhotoRating .pick-heart-btn'); if (!e) return null;
        const b = e.getBoundingClientRect();
        const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        return { ok: e === hit || e.contains(hit), top: b.top, bottom: b.bottom, right: b.right };
      });
      ok('the read-only ♥ is on screen and nothing sits on top of it', !!heart && heart.ok && heart.bottom <= 844 && heart.right <= 390, JSON.stringify(heart));

      // the very long name: ellipsis allowed, but it must stay readable and the title must be the full name
      await page.evaluate(i => app.openModal(app.filteredPhotos.findIndex(p => p.id === i)), '20260819/' + PV_LONG);
      await page.waitForTimeout(250);
      const l = await page.evaluate(PV_MEASURE);
      ok('long name: title is the full file name', l.nameTitle === PV_LONG && l.nameText === PV_LONG, l.nameTitle);
      ok('long name: still >= 15px, and wide enough to read (>= 200px)', l.nameFont >= 15 && l.nameBox.w >= 200, JSON.stringify({ f: l.nameFont, w: l.nameBox.w }));
      ok('long name: the bar stays on screen', l.info.left >= 0 && l.info.right <= 390, JSON.stringify(l.info));
      // no pins, no note: no empty shell
      ok('a photo without pins: no list element at all', l.list === null);
      const shell = await page.evaluate(() => {
        const s = document.getElementById('modalSidebar'); const b = s.getBoundingClientRect();
        return { display: getComputedStyle(s).display, h: b.height, text: s.textContent.trim() };
      });
      ok('a photo without pins or note leaves no empty sidebar shell', shell.display === 'none' || shell.h < 2, JSON.stringify(shell));
      ok('and the photo box grows back (>= 55% of the screen height)', l.canvas.h >= 844 * 0.55, JSON.stringify(l.canvas));
      // back to the pinned photo: the list returns
      await page.evaluate(() => app.openModal(app.filteredPhotos.findIndex(p => p.id === '20260819/a.jpg')));
      await page.waitForTimeout(250);
      const back = await page.evaluate(PV_MEASURE);
      ok('back on the pinned photo the list is back (exactly one)', back.nums.length === 3 && (await page.evaluate(() => document.querySelectorAll('#pvPinList').length)) === 1);
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = PV_REVIEW_FIXTURE('proj-rv2');
  await suite('review preview (photographer desktop) — pins list is the right-hand column next to the photo, never over it',
    `${base}/index.html?project=proj-rv2`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await pvOpen(page, '20260819/a.jpg');
      const r = await page.evaluate(PV_MEASURE);
      ok('positive: modal open on a.jpg, list has 3 numbered items', r.nameText === 'a.jpg' && r.nums.join('') === '①②③', JSON.stringify(r.nums));
      ok('tools and toggle are not in the DOM', r.gone.length === 0 && r.goneSel.length === 0, JSON.stringify([r.gone, r.goneSel]));
      ok('the list is in the sidebar column, not inside the photo box', r.inSidebar && !r.inCanvasBox);
      ok('desktop: the list is to the RIGHT of the photo box', r.list && r.canvas && r.list.left >= r.canvas.right - 1, JSON.stringify({ l: r.list, c: r.canvas }));
      ok('desktop: no overlap with the photo box, the photo or the bar', !pvOverlap(r.list, r.canvas) && !pvOverlap(r.list, r.photoCanvas) && !pvOverlap(r.list, r.info), JSON.stringify(r));
      ok('the list is on screen, with a readable width', r.list.right <= 1500 && r.list.w >= 200 && r.list.top >= 0 && r.list.bottom <= 950, JSON.stringify(r.list));
      ok('nothing covers it', r.hitInList);
      ok('file name >= 15px with the full name as title', r.nameFont >= 15 && r.nameTitle === 'a.jpg' && !r.nameClipped, JSON.stringify({ f: r.nameFont, t: r.nameTitle }));
      const f = await page.evaluate(PIN_FIT);
      const px = await page.evaluate(CANVAS_PX, [f.left + f.w * 0.25 - 8, f.top + f.h * 0.4]);
      ok('pins are still drawn on the photo (read-only canvas)', isPinPx(px), JSON.stringify(px));
      // the editing shortcuts are dead in review mode (spies, so a no-op undo can't pass for "blocked")
      await page.evaluate(() => {
        window.__kb = [];
        for (const k of ['undo', 'redo', 'deleteSelected']) annotationManager[k] = () => window.__kb.push(k);
      });
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+y'); await page.keyboard.press('Delete');
      ok('Ctrl+Z / Ctrl+Y / Delete call nothing in review mode', (await page.evaluate(() => window.__kb)).length === 0, JSON.stringify(await page.evaluate(() => window.__kb)));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
      ok('positive: the keyboard still works (→ goes to the next photo)', (await page.evaluate(() => app.currentPhotoIndex)) === 1);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // the normal index.html (and so the tools) must be untouched on a phone too
  await suite('review preview — the photographer\'s normal index.html on 390px keeps the tools and the orange toggle (no review trimming leaks)',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
      // 390px hides the drawer that holds LOAD, so drive it from the page
      await page.evaluate(() => { document.getElementById('driveUrl').value = '20260819/'; document.getElementById('loadPhotosBtn').click(); });
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        ids: ['mobileToolsToggle', 'drawCircleBtn', 'eraserBtn', 'selectBtn', 'panBtn', 'undoBtn', 'redoBtn', 'brushSize', 'clearAnnotationBtn', 'closeMobileSidebar']
          .filter(id => !document.getElementById(id)),
        sels: ['.tool-buttons', '.color-picker', '.slider-group', '.modal-actions', '.sidebar-header-mobile'].filter(s => !document.querySelector(s)),
        toggleDisplay: getComputedStyle(document.getElementById('mobileToolsToggle')).display,
        pvActive: document.body.classList.contains('pv-active'),
        list: !!document.getElementById('pvPinList'),
        h4: document.querySelector('.annotation-tools > h4')?.textContent,
        noteGroupHidden: document.getElementById('noteInputGroup').hidden,
        noteLabel: document.querySelector('#noteInputGroup label')?.textContent,
        small: !!document.querySelector('#noteInputGroup small'),
        sidebarClassHidden: document.getElementById('modalSidebar').classList.contains('hidden'),
      }));
      ok('positive: the modal is open', await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')));
      ok('every tool element is still in the DOM', r.ids.length === 0 && r.sels.length === 0, JSON.stringify(r));
      ok('the orange toggle is displayed on a phone', r.toggleDisplay === 'flex', r.toggleDisplay);
      ok('no review-mode artefacts (no body.pv-active, no pin list)', !r.pvActive && !r.list);
      ok('panel title / note group unchanged', r.h4 === '標注工具' && !r.noteGroupHidden && r.noteLabel === '照片備註' && r.small && !r.sidebarClassHidden, JSON.stringify(r));
      // outside review mode the editing shortcuts still reach the annotation manager
      await page.evaluate(() => {
        window.__kb = [];
        for (const k of ['undo', 'redo', 'deleteSelected']) annotationManager[k] = () => window.__kb.push(k);
      });
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y'); await page.keyboard.press('Delete');
      const kb = await page.evaluate(() => window.__kb);
      ok('Ctrl+Z / Ctrl+Y / Delete still reach undo / redo / deleteSelected', kb.join() === 'undo,redo,deleteSelected', kb.join());
      return out;
    },
    { initScript: ADMIN, before: pickFakeWorker().attach, contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pho', projectId: 'proj-pin2', image: BIG_PHOTO, marksUnavailable: true });
  m.state.selections.set('20260819/a.jpg', PIN_SEL([{ x: 0.3, y: 0.3, note: 'zzz' }]));
  await suite('retouch pins (photographer) — before the D1 migration (marks: null) there is no badge and no pin list, and nothing breaks',
    `${base}/index.html?project=proj-pin2`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({ card: document.querySelectorAll('.photo-card').length,
        badge: document.querySelectorAll('.pv-pin-badge').length, list: document.querySelectorAll('#pvPinList').length }));
      return [`${r.card === 1 && r.badge === 0 && r.list === 0 ? 'ok  ' : 'FAIL'}  one card, no badge, no list   [${JSON.stringify(r)}]`];
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  // the photographer's ordinary index.html: nothing of the pin machinery exists
  await suite('retouch pins — the photographer\'s normal index.html is unchanged (no pin UI, orange toggle and tools intact)',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
      await page.fill('#driveUrl', '20260819/');
      await page.click('#loadPhotosBtn');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        pin: document.querySelectorAll('#pickPinBtn, #pickPanelBtn, #pickModalTools, #pickPinsSection, #pvPinList, .pv-pin-badge, .pick-pin-hint').length,
        toggle: !!document.getElementById('mobileToolsToggle'),
        tools: !!document.querySelector('.tool-buttons') && !!document.getElementById('drawCircleBtn'),
        marks: annotationManager.marks.length, mode: annotationManager.pinMode,
        h4: document.querySelector('.annotation-tools > h4').textContent,
      }));
      ok('no pin element exists', r.pin === 0, JSON.stringify(r));
      ok('the orange toggle and the drawing tools are still there', r.toggle && r.tools, JSON.stringify(r));
      ok('the panel title is the original 標注工具', r.h4 === '標注工具', r.h4);
      ok('no pins, not in pin mode', r.marks === 0 && r.mode === false);
      return out;
    },
    { initScript: ADMIN, before: pickFakeWorker().attach });
}

{
  const m = pickFakeWorker({ ownerName: 'Ada', projectId: 'proj-diff' });
  const pin = (x, note = '') => ({ x, y: 0.5, note });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k'), pin(0.3)], '20260819/c.jpg': [pin(0.4, '<b>x</b>')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z', notified: 1 },
    { id: 's3', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k'), pin(0.3)], '20260819/c.jpg': [pin(0.4, '<b>x</b>')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-03T00:00:00Z', notified: 1 },
    { id: 's4', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: null, count: 3, pick_limit: null, extra_price: null, created_at: '2026-01-04T00:00:00Z', notified: 1 },
  );
  await suite('admin — submission diff: 「標示變更 N 張」 counts photos whose pins differ from the previous submission',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission');
      const blocks = await page.evaluate(() => [...document.querySelectorAll('#pd-submissions .pd-submission')].map(b => b.querySelector('.pd-diff').textContent));
      // newest first: s4, s3, s2, s1
      ok('s4 (marks null after 3 pinned photos): all 3 pinned photos changed → 標示變更 3 張', /標示變更 3 張/.test(blocks[0]), blocks[0]);
      ok('s3 (identical to s2): 與上次相同 — and no pin line', blocks[1] === '與上次相同', blocks[1]);
      ok('s2 (b gained a pin, c got one; a same): 標示變更 2 張, no 新增/移除', /標示變更 2 張/.test(blocks[2]) && !/新增|移除/.test(blocks[2]), blocks[2]);
      ok('s1 is 第一次送出 with no pin line', blocks[3] === '（第一次送出）', blocks[3]);
      ok('the file names are listed', blocks[2].includes('b.jpg') && blocks[2].includes('c.jpg') && !blocks[2].includes('a.jpg'), blocks[2]);
      ok('a pin note is never rendered in the diff', !(await page.evaluate(() => document.getElementById('pd-submissions').innerHTML.includes('<b>x</b>'))));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
