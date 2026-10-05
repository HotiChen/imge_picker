// Browser suites: mobile preview gestures (swipe, pinch, double-tap), zoom, annotations, tap
// targets, responsive widths.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { BIG_H, BIG_PHOTO, BIG_W, CANVAS_PX, MOBILE, OLD_FIT_RECT, doubleTapTouch, pinchTouch, realTouch, swipeTouch, touchSequence } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { PHOTOS, mockWorker } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PREVIEW_SETTLED, openBigGuestPreview } from '../lib/project-helpers.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Mobile picking gestures — the preview modal on a phone (task: mobile
// gestures). Guests use phones, often LINE's in-app browser or iOS Safari,
// so the full-size preview needs touch-native swipe/pinch/pan/double-tap on
// top of the existing mouse+keyboard behaviour, which must keep working too.
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Mia', ownerKey: 'MIA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — swipe left/right navigates, swipe down closes; short/diagonal moves do neither',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const counter = () => page.textContent('#photoCounter');
      const isActive = () => page.evaluate(() => document.getElementById('photoModal').classList.contains('active'));

      ok('opens on the first photo', (await counter()) === '1 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 300, 400, 60, 410); // dx=-240 dy=10 — a clean swipe left
      await page.waitForTimeout(50);
      ok('swipe left → next photo', (await counter()) === '2 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 60, 400, 300, 410); // swipe right
      await page.waitForTimeout(50);
      ok('swipe right → previous photo', (await counter()) === '1 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 150, 400, 210, 470); // dx=60 dy=70 — vertical-dominant
      await page.waitForTimeout(50);
      ok('a mostly-vertical move past the 50px horizontal threshold does not navigate',
        (await counter()) === '1 / 5', await counter());
      ok('and does not close either (below the 80px close threshold)', await isActive());

      await swipeTouch(page, '#photoCanvas', 150, 300, 160, 460); // dx=10 dy=160 — down, well past 80px
      await page.waitForTimeout(50);
      ok('swipe down past threshold closes the preview', !(await isActive()));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Nia', ownerKey: 'NIA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — pinch zooms in; once zoomed, a one-finger drag pans instead of navigating',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const zoomPct = () => page.evaluate(() => parseInt(document.getElementById('zoomLevel').textContent, 10));

      ok('starts at 100%', (await zoomPct()) === 100, String(await zoomPct()));

      await pinchTouch(page, '#photoCanvas', 195, 400, 60, 300);
      await page.waitForTimeout(50);
      ok('pinching outward zooms in', (await zoomPct()) > 100, String(await zoomPct()));

      const panBefore = await page.evaluate(() => annotationManager.panX);
      await swipeTouch(page, '#photoCanvas', 300, 400, 100, 410); // would navigate at 100% zoom
      await page.waitForTimeout(50);
      ok('stays on the same photo — the one-finger drag panned instead of navigating',
        (await page.textContent('#photoCounter')) === '1 / 5', await page.textContent('#photoCounter'));
      const panAfter = await page.evaluate(() => annotationManager.panX);
      ok('and the pan actually moved the image', panAfter !== panBefore, `${panBefore} -> ${panAfter}`);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'NIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Owen', ownerKey: 'OWEN-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — double-tap toggles ♥ for the owner while editable, pulses on, and never navigates',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      // The grid card's ♥ sits in the image's bottom-right corner (Tim's ask),
      // inside the image container — not the top-right, where ✎ goes.
      const pos = await page.evaluate(() => {
        const card = document.querySelector('.photo-card');
        const heart = card.querySelector('.pick-heart-btn');
        const img = card.querySelector('.photo-image-container');
        if (!heart || !img) return null;
        const h = heart.getBoundingClientRect(), c = img.getBoundingClientRect();
        return { inImg: heart.parentElement === img, bottomGap: c.bottom - h.bottom, rightGap: c.right - h.right,
                 lowerHalf: h.top > c.top + c.height / 2 };
      });
      ok('the grid ♥ is in the image container', pos?.inImg === true, JSON.stringify(pos));
      ok('the grid ♥ sits in the bottom-right corner',
        pos && pos.lowerHalf && pos.bottomGap >= 0 && pos.bottomGap <= 12 && pos.rightGap >= 0 && pos.rightGap <= 12,
        JSON.stringify(pos));

      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });

      const burst = () => page.evaluate(() => {
        const el = document.querySelector('.canvas-container .pick-heart-burst');
        return el ? { off: el.classList.contains('off'), text: el.textContent,
                      display: getComputedStyle(el).display } : null;
      });

      const state = () => page.evaluate(() => ({
        heartOn: document.querySelector('#modalPhotoRating .pick-heart-btn')?.classList.contains('on') ?? null,
        pulsing: document.querySelector('#modalPhotoRating .pick-heart-btn')?.classList.contains('pick-heart-pulse') ?? false,
        cardPicked: document.querySelector('.photo-card')?.classList.contains('pick-picked') ?? false,
        counter: document.getElementById('photoCounter').textContent,
        rating: app.filteredPhotos[0].rating,
      }));

      let s = await state();
      ok('starts unpicked', s.heartOn === false && s.rating === 0, JSON.stringify(s));

      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      s = await state();
      ok('double-tap turns it on (same code path as the ♥ button)', s.heartOn === true && s.rating === 1, JSON.stringify(s));
      ok('a brief pulse plays on toggle-on', s.pulsing === true, JSON.stringify(s));
      ok('the grid card gets the thick-border highlight too', s.cardPicked === true, JSON.stringify(s));
      ok('the two taps of a double-tap never navigate', s.counter === '1 / 3', s.counter);
      let b = await burst();
      ok('a big ♥ pops over the photo on toggle-on', b && !b.off && b.text === '♥' && b.display !== 'none', JSON.stringify(b));
      await page.waitForTimeout(1200);
      ok('and it clears itself afterwards', (await burst()) === null, JSON.stringify(await burst()));

      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      s = await state();
      ok('a second double-tap toggles it back off', s.heartOn === false && s.rating === 0, JSON.stringify(s));
      ok('and the highlight goes with it', s.cardPicked === false, JSON.stringify(s));
      b = await burst();
      ok('toggle-off pops the hollow ♡ instead', b && b.off && b.text === '♡' && b.display !== 'none', JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OWEN-KEY'), contextOptions: MOBILE });
}

// A landscape photo on a portrait phone leaves black bars above and below
// it. The canvas now fills the whole frame (bars included — see "preview
// zoom" below), so a finger on a bar lands on the canvas, off the photo. The
// helpers above dispatch straight to the canvas; this one uses real touch
// input, so the finger lands on whatever is really at that point. The 1x1
// fixture photo makes nearly the whole frame letterbox.
{
  const m = pickFakeWorker({ ownerName: 'Lea', ownerKey: 'LEA-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — double-tap on the black bars around the photo still likes it; the ‹ › buttons still work',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(200);
      const box = await page.locator('.canvas-container').boundingBox();
      const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + 20);
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.id || el.className) : null;
      }, [x, y]);
      const px = await page.evaluate(CANVAS_PX, [x, y]);
      ok('the tap point is the bar (on the frame-sized canvas, nothing drawn there), not the photo',
        hit === 'photoCanvas' && !!px && px[3] === 0, JSON.stringify({ hit, px }));
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(150);
      await page.touchscreen.tap(x + 3, y + 2);
      await page.waitForTimeout(50);
      const r = await page.evaluate(() => ({ rating: app.filteredPhotos[0].rating,
        burst: !!document.querySelector('.canvas-container .pick-heart-burst'),
        counter: document.getElementById('photoCounter').textContent }));
      ok('double-tapping the bar likes the photo', r.rating === 1, JSON.stringify(r));
      ok('and pops the big ♥', r.burst, JSON.stringify(r));
      ok('and stays on the same photo', r.counter === '1 / 3', r.counter);

      await page.waitForTimeout(500);
      await page.locator('#nextPhotoBtn').tap();
      await page.waitForTimeout(100);
      ok('tapping › still goes to the next photo', (await page.textContent('#photoCounter')) === '2 / 3',
        await page.textContent('#photoCounter'));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LEA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pat', ownerKey: 'PAT-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — a viewer double-tapping the preview changes nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 }); // seat already taken → straight to the grid
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      ok('a viewer gets no clickable heart in the modal at all',
        await page.evaluate(() => document.querySelectorAll('#modalPhotoRating .pick-heart-btn').length === 0));
      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      const rating = await page.evaluate(() => app.filteredPhotos[0].rating);
      ok('and double-tapping the image changes the rating not at all', rating === 0, String(rating));
      ok('and pops no ♥ either',
        await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length === 0));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE }); // no picker key stored → a plain viewer
}

{
  const m = pickFakeWorker({ ownerName: 'Ray', ownerKey: 'RAY-KEY', photos: PHOTOS(3) });
  m.state.project.phase = 'retouching';
  await suite('mobile preview — double-tap does nothing once retouching has started, even for the seat holder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      const rating = await page.evaluate(() => app.filteredPhotos[0].rating);
      ok('the seat holder double-tapping while retouching changes nothing', rating === 0, String(rating));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RAY-KEY'), contextOptions: MOBILE });
}

await suite('mobile preview — outside pick mode, double-tap changes nothing (there is no ♥ to toggle)',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      app.openModal(0);
    });
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await doubleTapTouch(page, '#photoCanvas', 195, 400);
    const r = await page.evaluate(() => ({
      hearts: document.querySelectorAll('.pick-heart-btn').length,
      counter: document.getElementById('photoCounter').textContent,
      rating: app.filteredPhotos[0].rating,
    }));
    ok('no heart control exists outside pick mode', r.hearts === 0, String(r.hearts));
    ok('rating is untouched', r.rating === 0, String(r.rating));
    ok('and the two taps did not navigate either', r.counter === '1 / 3', r.counter);
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3), contextOptions: MOBILE });

// ═══════════════════════════════════════════════════════════════════════════
// Preview zoom on a phone (docs/backlog.md, "Preview zoom on a phone"): a
// double-tap while zoomed goes back to fit (like iPhone Photos), the ⟲ is a
// real tap target, and a zoomed photo spreads over the whole frame instead of
// staying clipped to its fitted box. Real touch input (realTouch) and the
// 1600x1067 gradient BIG_PHOTO throughout — the 1x1 PIXEL hides layout bugs.
// ═══════════════════════════════════════════════════════════════════════════

// In-page helpers shared by these suites.
const ZOOM_STATE = () => ({
  zoom: parseInt(document.getElementById('zoomLevel').textContent, 10),
  panX: annotationManager.panX, panY: annotationManager.panY,
  rating: app.filteredPhotos[0].rating,
  burst: document.querySelectorAll('.pick-heart-burst').length,
  counter: document.getElementById('photoCounter').textContent,
});
const isPhotoPx = px => !!px && px[3] === 255 && Math.abs(px[2] - 60) <= 8;
const sameColour = (a, b, tol = 3) => !!a && !!b && [0, 1, 2].every(i => Math.abs(a[i] - b[i]) <= tol);

{
  const m = pickFakeWorker({ ownerName: 'Zed', ownerKey: 'ZED-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a double-tap while zoomed goes back to fit and leaves the ♥ alone; at fit it still toggles ♥',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      const st = () => page.evaluate(ZOOM_STATE);

      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      let s = await st();
      ok('a real pinch zooms in first', s.zoom > 150, JSON.stringify(s));

      await t.tap(cx, cy);
      await page.waitForTimeout(500); // past the double-tap window
      s = await st();
      ok('a single tap while zoomed changes nothing', s.zoom > 150 && s.rating === 0, JSON.stringify(s));

      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a double-tap while zoomed goes back to 100%', s.zoom === 100 && s.panX === 0 && s.panY === 0, JSON.stringify(s));
      ok('and does not touch the ♥ (no rating, no burst)', s.rating === 0 && s.burst === 0, JSON.stringify(s));
      const resetToasts = () => page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')]
        .filter(el => el.textContent.includes('已重置縮放')).length);
      ok('quietly — the gesture is its own feedback, no 已重置縮放 toast', (await resetToasts()) === 0, String(await resetToasts()));
      ok('and never navigates', s.counter === '1 / 3', s.counter);

      await page.waitForTimeout(500);
      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a double-tap at fit still toggles ♥ on, as before', s.rating === 1 && s.burst === 1, JSON.stringify(s));
      ok('and stays at 100%', s.zoom === 100, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZED-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pam', ownerKey: 'PAM-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a pan drag while zoomed moves the photo and is never counted as a tap',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      const st = () => page.evaluate(ZOOM_STATE);
      const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);

      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      const s0 = await st();
      ok('zoomed in first', s0.zoom > 150, JSON.stringify(s0));

      const target = await px(cx + 120, cy - 40);
      await t.drag(cx, cy, cx - 120, cy + 40);
      await page.waitForTimeout(50);
      let s = await st();
      ok('the drag pans by the finger’s travel',
        Math.abs(s.panX - s0.panX + 120) <= 2 && Math.abs(s.panY - s0.panY - 40) <= 2, JSON.stringify({ s0, s }));
      const now = await px(cx, cy);
      ok('the photo really moved under the finger', isPhotoPx(target) && sameColour(now, target),
        JSON.stringify({ target, now }));
      ok('still zoomed, same photo, no ♥', s.zoom === s0.zoom && s.counter === '1 / 3' && s.rating === 0,
        JSON.stringify(s));

      await t.drag(cx, cy, cx - 40, cy);
      await t.drag(cx, cy, cx - 40, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('two quick drags are not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));

      await page.waitForTimeout(500);
      await t.tap(cx, cy);
      await t.drag(cx + 1, cy, cx + 41, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a tap then a drag is not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));

      await page.waitForTimeout(500);
      await t.drag(cx, cy, cx - 40, cy);
      await t.tap(cx - 40, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a drag then a tap is not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'PAM-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a viewer’s double-tap while zoomed goes back to fit too (and still no ♥)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      let s = await page.evaluate(ZOOM_STATE);
      ok('zoomed in first', s.zoom > 150, JSON.stringify(s));
      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await page.evaluate(ZOOM_STATE);
      ok('back to 100%', s.zoom === 100, JSON.stringify(s));
      ok('rating untouched, no ♥ popped', s.rating === 0 && s.burst === 0, JSON.stringify(s));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE }); // no picker key → a viewer
}

await suite('preview zoom — the photographer’s double-tap while zoomed goes back to fit too',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      app.openModal(0);
    });
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    const box = await page.locator('.canvas-container').boundingBox();
    const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
    const t = await realTouch(page);
    await t.pinch(cx, cy, 60, 260);
    await page.waitForTimeout(50);
    let s = await page.evaluate(ZOOM_STATE);
    ok('zoomed in first', s.zoom > 150, JSON.stringify(s));
    await t.doubleTap(cx, cy);
    await page.waitForTimeout(50);
    s = await page.evaluate(ZOOM_STATE);
    ok('back to 100%', s.zoom === 100, JSON.stringify(s));
    ok('rating untouched', s.rating === 0, JSON.stringify(s));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3, {}, BIG_PHOTO), contextOptions: MOBILE });

{
  const m = pickFakeWorker({ ownerName: 'Fay', ownerKey: 'FAY-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — the canvas fills the frame; at 100% the photo sits exactly where it did; zoomed, it covers the black bars',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);
      const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);

      const geo = await page.evaluate(() => {
        const c = document.getElementById('photoCanvas'), box = c.parentElement;
        const r = c.getBoundingClientRect(), b = box.getBoundingClientRect(), cs = getComputedStyle(box);
        return { cw: r.width, ch: r.height, bw: box.clientWidth, bh: box.clientHeight,
                 dx: r.left - b.left - parseFloat(cs.borderLeftWidth), dy: r.top - b.top - parseFloat(cs.borderTopWidth) };
      });
      ok('the canvas covers the whole frame', Math.abs(geo.cw - geo.bw) <= 1 && Math.abs(geo.ch - geo.bh) <= 1
        && Math.abs(geo.dx) <= 1 && Math.abs(geo.dy) <= 1, JSON.stringify(geo));
      const contTop = (await page.locator('.canvas-container').boundingBox()).y;
      ok('a landscape photo on a portrait phone leaves bars (the case under test)', old.top - contTop > 40,
        JSON.stringify({ old, contTop }));

      // At 100%: the photo's four corners are where the old fitted canvas put them.
      const tl = await px(old.left + 2, old.top + 2), br = await px(old.left + old.w - 3, old.top + old.h - 3);
      ok('at 100% the photo’s top-left corner is where it was', isPhotoPx(tl) && tl[0] <= 4 && tl[1] <= 4, JSON.stringify(tl));
      ok('and its bottom-right corner too', isPhotoPx(br) && br[0] >= 251 && br[1] >= 251, JSON.stringify(br));
      const above = await px(cx, old.top - 3), below = await px(cx, old.top + old.h + 3);
      ok('the bar just above it is still empty', !isPhotoPx(above), JSON.stringify(above));
      ok('the bar just below it is still empty', !isPhotoPx(below), JSON.stringify(below));

      // Zoom in about the centre with a real pinch.
      const t = await realTouch(page);
      const mid0 = await px(cx, cy);
      await t.pinch(cx, cy, 60, 300);
      await page.waitForTimeout(50);
      const z = await page.evaluate(() => annotationManager.zoom);
      ok('pinched to well over 2x', z > 2, String(z));
      const mid1 = await px(cx, cy);
      ok('the pinch zoomed about its midpoint (same photo point under it)', sameColour(mid1, mid0),
        JSON.stringify({ mid0, mid1 }));
      const barPt = await px(cx, old.top - 20), barPt2 = await px(cx, old.top + old.h + 20);
      ok('zoomed, the old bar above shows the photo', isPhotoPx(barPt), JSON.stringify(barPt));
      ok('and so does the old bar below', isPhotoPx(barPt2), JSON.stringify(barPt2));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'FAY-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Rio', ownerKey: 'RIO-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — rotating the phone re-fits the canvas and the photo to the new frame',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await openBigGuestPreview(page);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(300);
      const geo = await page.evaluate(() => {
        const c = document.getElementById('photoCanvas'), box = c.parentElement;
        const r = c.getBoundingClientRect();
        return { cw: r.width, ch: r.height, bw: box.clientWidth, bh: box.clientHeight };
      });
      ok('after rotating, the canvas still covers the whole frame',
        Math.abs(geo.cw - geo.bw) <= 1 && Math.abs(geo.ch - geo.bh) <= 1, JSON.stringify(geo));
      const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
      const tl = await page.evaluate(CANVAS_PX, [old.left + 2, old.top + 2]);
      const br = await page.evaluate(CANVAS_PX, [old.left + old.w - 3, old.top + old.h - 3]);
      ok('and the photo is re-fitted, corners where a fresh open would put them',
        isPhotoPx(tl) && tl[0] <= 4 && tl[1] <= 4 && isPhotoPx(br) && br[0] >= 251 && br[1] >= 251,
        JSON.stringify({ old, tl, br }));

      // Landscape phone: the bars are now left and right of the photo, so
      // this is where the horizontal centring offset really matters.
      const cont = (await page.locator('.canvas-container').boundingBox());
      ok('the rotated frame has side bars (the case under test)', old.left - cont.x > 40, JSON.stringify({ old, cont }));
      const midY = Math.round(old.top + old.h / 2);
      const left = await page.evaluate(CANVAS_PX, [old.left - 3, midY]);
      ok('the side bar is still empty at 100%', !!left && !isPhotoPx(left), JSON.stringify(left));
      const P = { x: Math.round(old.left + old.w * 0.25), y: midY };
      const p0 = await page.evaluate(CANVAS_PX, [P.x, P.y]);
      const t = await realTouch(page);
      await t.pinch(P.x, P.y, 60, 200);
      await page.waitForTimeout(50);
      const z = await page.evaluate(() => annotationManager.zoom);
      const p1 = await page.evaluate(CANVAS_PX, [P.x, P.y]);
      ok('an off-centre pinch zooms about its midpoint', z > 2 && sameColour(p0, p1), JSON.stringify({ z, p0, p1 }));
      const side = await page.evaluate(CANVAS_PX, [old.left - 20, midY]);
      ok('zoomed, the old side bar shows the photo', isPhotoPx(side), JSON.stringify(side));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RIO-KEY'), contextOptions: MOBILE });
}

// Annotations are the photographer's saved data (localStorage, via
// driveManager.saveAnnotations). They're stored in "fitted canvas pixels":
// (0,0) is the photo's top-left, one unit is one screen px at 100% zoom of
// the fitted photo. That space must not change: old circles keep rendering
// on the same spot, new ones are stored the same way.
const OLD_CIRCLE = { type: 'circle', startX: 300, startY: 200, endX: 400, endY: 300,
  color: '#0000ff', size: 3, number: 1, timestamp: 1 };
const BLUE_NEAR = ([x, y, r]) => {
  const c = document.getElementById('photoCanvas');
  const cr = c.getBoundingClientRect();
  const d = c.getContext('2d').getImageData(Math.round(x - cr.left) - r, Math.round(y - cr.top) - r, 2 * r + 1, 2 * r + 1).data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i] < 80 && d[i + 1] < 80) return true;
  return false;
};

await suite('preview annotations — an old saved circle renders on the same spot; new ones are stored in the same space; wheel zoom stays about the cursor',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(circle => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0,
        annotations: i === 0 ? [circle] : [] }));
      driveManager.photos = app.filteredPhotos;
      app.openModal(0);
    }, OLD_CIRCLE);
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);
    const blueNear = (x, y, r = 2) => page.evaluate(BLUE_NEAR, [x, y, r]);
    const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
    const stored = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('r2_photo_picker_annotations') || '{}')['20260819/p0.jpg'] || []);

    // 1. The old circle (centre 350,250, r 50) lands where the old canvas drew it.
    ok('the old circle’s right edge is drawn where it always was', await blueNear(old.left + 400, old.top + 250),
      JSON.stringify(old));
    ok('and its bottom edge', await blueNear(old.left + 350, old.top + 300));
    ok('its middle is photo, not ink', isPhotoPx(await px(old.left + 350, old.top + 250)));
    ok('and nothing is drawn 10px outside the ring', !(await blueNear(old.left + 410, old.top + 250, 1)));

    // 2. A new circle, drawn with the mouse at 100%, is stored in the same space.
    await page.click('#drawCircleBtn');
    await page.mouse.move(old.left + 100, old.top + 80);
    await page.mouse.down();
    await page.mouse.move(old.left + 150, old.top + 140, { steps: 4 });
    await page.mouse.move(old.left + 200, old.top + 190, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    let a = await stored();
    const c2 = a[1];
    ok('the new circle is saved', a.length === 2, JSON.stringify(a));
    ok('in the old coordinate space (fitted-photo pixels from its top-left)',
      !!c2 && Math.abs(c2.startX - 100) <= 1 && Math.abs(c2.startY - 80) <= 1
        && Math.abs(c2.endX - 200) <= 1 && Math.abs(c2.endY - 190) <= 1, JSON.stringify(c2));
    ok('and the old circle is saved back unchanged', JSON.stringify(a[0]) === JSON.stringify(OLD_CIRCLE), JSON.stringify(a[0]));

    // 2b. A drag that runs off the photo ends at its edge (the old photo-
    //     sized canvas ended it there on mouseleave): nothing stored outside.
    //     (Ends halfway into the bar below, still inside the frame — past
    //     the frame, the canvas's own mouseleave ends it, as before.)
    const into = await page.evaluate(t => (t - document.querySelector('.canvas-container').getBoundingClientRect().top) / 2, old.top);
    ok('(the frame has a bar below the photo to drag into)', into >= 10, String(into));
    await page.mouse.move(old.left + 200, old.top + old.h - 100);
    await page.mouse.down();
    await page.mouse.move(old.left + 320, old.top + old.h + into, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    const cEdge = a[2];
    ok('a drag that runs off the photo is stored ending on its edge',
      !!cEdge && Math.abs(cEdge.endY - old.h) <= 1 && Math.abs(cEdge.endX - 320) <= 1
        && Math.abs(cEdge.startY - (old.h - 100)) <= 1, JSON.stringify({ cEdge, h: old.h }));
    await page.evaluate(() => { annotationManager.undo(); }); // back to the two circles
    await page.waitForTimeout(50);
    a = await stored();
    ok('(undo leaves the two circles)', a.length === 2, JSON.stringify(a));

    // 3. Pressing on the black bar (off the photo) draws nothing, as before.
    const cont = await page.evaluate(() => {
      const b = document.querySelector('.canvas-container').getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    const sideBar = old.left - cont.left, topBar = old.top - cont.top;
    ok('this desktop frame has a bar beside or above the photo', Math.max(sideBar, topBar) >= 20, JSON.stringify({ sideBar, topBar }));
    const bx = sideBar >= topBar ? cont.left + sideBar / 2 : old.left + 50;
    const by = sideBar >= topBar ? old.top + 50 : cont.top + topBar / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx + 60, by + 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    ok('a drag starting on the bar adds no circle', a.length === 2, JSON.stringify(a));
    const by2 = sideBar >= topBar ? old.top + 50 : old.top + old.h + topBar / 2;
    const bx2 = sideBar >= topBar ? old.left + old.w + sideBar / 2 : old.left + 50;
    await page.mouse.move(bx2, by2);
    await page.mouse.down();
    await page.mouse.move(bx2 - 60, by2 - 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    ok('nor does one starting on the bar on the far side', a.length === 2, JSON.stringify(a));

    // 4. Wheel zoom about the cursor: the photo point under it stays put.
    await page.click('#panBtn');
    const P = { x: Math.round(old.left + old.w * 0.3), y: Math.round(old.top + old.h * 0.6) };
    const c0 = await px(P.x, P.y), q0 = await px(P.x + 80, P.y);
    await page.mouse.move(P.x, P.y);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
    const z = await page.evaluate(() => annotationManager.zoom);
    ok('the wheel zoomed in', z > 1.4, String(z));
    const c1 = await px(P.x, P.y), q1 = await px(P.x + 80, P.y);
    ok('the photo point under the cursor stayed under it', sameColour(c0, c1), JSON.stringify({ c0, c1 }));
    ok('while the photo around it grew', !!q0 && !!q1 && Math.abs(q1[0] - q0[0]) >= 3, JSON.stringify({ q0, q1 }));
    ok('the old circle grew about the cursor too',
      await blueNear(P.x + (old.left + 400 - P.x) * z, P.y + (old.top + 250 - P.y) * z, 3));

    // 5. Zoomed, draw from a point that was bar at 100% but now shows the
    //    photo: stored in the same space, computed from the gradient colour
    //    (which photo pixel is under the mouse) — independent of the code.
    await page.click('#drawCircleBtn');
    const S = sideBar >= topBar ? { x: Math.round(old.left - 6), y: P.y } : { x: P.x, y: Math.round(old.top - 6) };
    const E = { x: S.x + 120, y: S.y + 90 };
    const sPx = await px(S.x, S.y), ePx = await px(E.x, E.y);
    ok('zoomed, the old bar now shows the photo', isPhotoPx(sPx), JSON.stringify(sPx));
    const worldOf = p => ({ x: p[0] / 255 * (BIG_W - 1) * old.s, y: p[1] / 255 * (BIG_H - 1) * old.s });
    await page.mouse.move(S.x, S.y);
    await page.mouse.down();
    await page.mouse.move(E.x, E.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    const c3 = a[2], ws = sPx && worldOf(sPx), we = ePx && worldOf(ePx);
    ok('a circle drawn while zoomed is stored at the photo point under the mouse',
      !!c3 && !!ws && !!we && Math.abs(c3.startX - ws.x) <= 5 && Math.abs(c3.startY - ws.y) <= 5
        && Math.abs(c3.endX - we.x) <= 5 && Math.abs(c3.endY - we.y) <= 5, JSON.stringify({ c3, ws, we }));

    // 6. Back to fit: the old circle is exactly where it started.
    await page.click('#zoomResetBtn');
    await page.waitForTimeout(50);
    ok('after ⟲ the old circle is back on its original spot', await blueNear(old.left + 400, old.top + 250));
    ok('and the ⟲ button still says 已重置縮放', await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')]
      .some(el => el.textContent.includes('已重置縮放'))));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3, {}, BIG_PHOTO) });

// The photographer's own tool, on a phone: a finger-drawn circle used to be
// lost (stopDrawing read clientX from a TouchEvent → NaN end point), and the
// −/+ buttons zoomed about the photo's top-left instead of the view's centre.
await suite('preview annotations — a circle drawn with a finger is saved with real numbers; the − / + buttons zoom about the centre of the view',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0, annotations: [] }));
      driveManager.photos = app.filteredPhotos;
      app.openModal(0);
    });
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
    const stored = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('r2_photo_picker_annotations') || '{}')['20260819/p0.jpg'] || []);

    // 1. Finger-drawn circle (circle tool): start, move, lift.
    await page.evaluate(() => annotationManager.setTool('circle'));
    const x1 = old.left + 100, y1 = old.top + 80, x2 = old.left + 220, y2 = old.top + 200;
    await touchSequence(page, '#photoCanvas', [
      { type: 'touchstart', points: [{ x: x1, y: y1 }] },
      { type: 'touchmove', points: [{ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }] },
      { type: 'touchmove', points: [{ x: x2, y: y2 }] },
      { type: 'touchend', points: [{ x: x2, y: y2 }] },
    ]);
    await page.waitForTimeout(80);
    const a = await stored();
    const c = a[0];
    ok('a circle was saved', a.length === 1, JSON.stringify(a));
    ok('its numbers are real (no NaN / null)', !!c && [c.startX, c.startY, c.endX, c.endY].every(Number.isFinite), JSON.stringify(c));
    ok('and it runs from where the finger went down to where it lifted',
      !!c && Math.abs(c.startX - 100) <= 2 && Math.abs(c.startY - 80) <= 2 && Math.abs(c.endX - 220) <= 2 && Math.abs(c.endY - 200) <= 2, JSON.stringify(c));

    // 2. − / + zoom about the centre of the view, not the photo's top-left.
    await page.evaluate(() => annotationManager.setTool('pan'));
    await page.evaluate(() => annotationManager.resetZoom({ quiet: true }));
    const centre = await page.evaluate(() => ({ x: annotationManager.fitW / 2, y: annotationManager.fitH / 2 }));
    const beforeWorld = await page.evaluate(() => {
      const m = annotationManager; return { x: (m.fitW / 2 - m.panX) / m.zoom, y: (m.fitH / 2 - m.panY) / m.zoom };
    });
    await page.evaluate(() => { document.getElementById('zoomInBtn').click(); document.getElementById('zoomInBtn').click(); });
    const after = await page.evaluate(() => {
      const m = annotationManager;
      return { z: m.zoom, x: (m.fitW / 2 - m.panX) / m.zoom, y: (m.fitH / 2 - m.panY) / m.zoom };
    });
    ok('the buttons zoomed in', after.z > 1.3, JSON.stringify(after));
    ok('and the photo point in the middle of the view stayed in the middle',
      Math.abs(after.x - beforeWorld.x) <= 1 && Math.abs(after.y - beforeWorld.y) <= 1, JSON.stringify({ beforeWorld, after, centre }));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), contextOptions: MOBILE, before: mockWorker(3, {}, BIG_PHOTO) });

{
  const m = pickFakeWorker({ ownerName: 'Kai', ownerKey: 'KAI-KEY', photos: [
    // a real camera-length filename, so the bar's name has to give way
    { id: '20260819/DSC_20260819_143015_wedding_ceremony.jpg', name: 'DSC_20260819_143015_wedding_ceremony.jpg', size: 9e6, rating: 0 },
    ...PHOTOS(1)] });
  await suite('tap targets on a mobile viewport — the preview’s ⟲ and − / + zoom buttons are >= 44x44 CSS px, on screen and apart',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      // measure after the modal's slideUp entrance, not mid-slide
      await page.waitForFunction(() => document.querySelector('#photoModal .modal-content').getAnimations().length === 0,
        null, { timeout: 5000 });
      const boxes = await page.evaluate(() => ['zoomOutBtn', 'zoomInBtn', 'zoomResetBtn'].map(id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                 display: getComputedStyle(el).display };
      }));
      for (const b of boxes) {
        ok(`${b?.id} is >= 44x44`, !!b && b.display !== 'none' && b.w >= 44 && b.h >= 44, JSON.stringify(b));
        ok(`${b?.id} is fully on screen`, !!b && b.left >= 0 && b.right <= 390 && b.top >= 0 && b.bottom <= 844, JSON.stringify(b));
      }
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      ok('none of them overlap', boxes.every(Boolean) && !overlap(boxes[0], boxes[1]) && !overlap(boxes[1], boxes[2])
        && !overlap(boxes[0], boxes[2]), JSON.stringify(boxes));
      const hit = await page.evaluate(b => document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)?.closest('button')?.id, boxes[2]);
      ok('a tap on the ⟲ reaches it', hit === 'zoomResetBtn', String(hit));
      const heart = await page.evaluate(() => {
        const r = document.querySelector('#modalPhotoRating .pick-heart-btn')?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      });
      const nameW = await page.evaluate(() => document.getElementById('modalPhotoName').getBoundingClientRect().width);
      ok('the file name keeps a readable width (>= 80px, ellipsised)', nameW >= 80, String(nameW));
      ok('the bigger buttons don’t push the bar’s ♥ off screen or onto them',
        !!heart && heart.left >= 0 && heart.right <= 390 && heart.bottom <= 844
          && boxes.every(b => b && !overlap(b, heart)), JSON.stringify({ heart, boxes }));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'KAI-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Uma', ownerKey: 'UMA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — preloads i±1/i±2 at the responsive width, and never past either end of the list',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const reset = async () => { m.requests.length = 0; await page.evaluate(() => app._preloadedUrls.clear()); };
      const distinctPaths = () => [...new Set(m.requests
        .filter(r => r.method === 'GET' && /^\/20260819\/p\d\.jpg$/.test(r.path))
        .map(r => r.path))].sort();
      const widthOf = path => {
        const r = m.requests.find(r => r.path === path);
        const match = /[?&]w=(\d+)/.exec((r && r.search) || '');
        return match ? match[1] : null;
      };

      await reset();
      await page.evaluate(() => app.openModal(2)); // middle: all four neighbours exist
      await page.waitForTimeout(150);
      ok('preloads both photos before and both after the current one',
        JSON.stringify(distinctPaths()) ===
          JSON.stringify(['/20260819/p0.jpg', '/20260819/p1.jpg', '/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p4.jpg']),
        distinctPaths().join(','));
      ok('at the responsive width bucket (1200 on a 390px/DPR3 phone)',
        widthOf('/20260819/p1.jpg') === '1200', String(widthOf('/20260819/p1.jpg')));

      await reset();
      await page.evaluate(() => app.openModal(0)); // first photo: no i-1/i-2 to ask for
      await page.waitForTimeout(150);
      ok('at the first photo, nothing before it is requested',
        JSON.stringify(distinctPaths()) === JSON.stringify(['/20260819/p0.jpg', '/20260819/p1.jpg', '/20260819/p2.jpg']),
        distinctPaths().join(','));

      await reset();
      await page.evaluate(() => app.openModal(4)); // last photo: no i+1/i+2 to ask for
      await page.waitForTimeout(150);
      ok('at the last photo, nothing past it is requested',
        JSON.stringify(distinctPaths()) === JSON.stringify(['/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p4.jpg']),
        distinctPaths().join(','));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UMA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY', photos: PHOTOS(10) });
  await suite('mobile preview — a fast burst of navigation only preloads around where it settles',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      m.requests.length = 0;
      // fire three preload requests back-to-back, faster than the debounce
      // settles — only the last one should ever reach the network
      await page.evaluate(() => { app.schedulePreload(1); app.schedulePreload(4); app.schedulePreload(8); });
      await page.waitForTimeout(150);
      const got = [...new Set(m.requests
        .filter(r => r.method === 'GET' && /^\/20260819\/p\d\.jpg$/.test(r.path))
        .map(r => r.path))];
      ok('only the final index (8)\'s neighbours are fetched',
        got.length === 3 && ['/20260819/p6.jpg', '/20260819/p7.jpg', '/20260819/p9.jpg'].every(p => got.includes(p)),
        got.join(','));
      ok('the superseded, stale indices (1 and 4) preloaded nothing',
        !got.some(p => ['/20260819/p0.jpg', '/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p5.jpg'].includes(p)),
        got.join(','));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'VIC-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Will', ownerKey: 'WILL-KEY', photos: PHOTOS(2) });
  await suite('responsive preview width — 1200 on a 390px/DPR3 phone; grid thumbnails always stay 400',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const width = await page.evaluate(() => driveManager.previewWidth());
      ok('a 390px/DPR3 phone asks for the 1200 bucket', width === 1200, String(width));
      const thumb = await page.evaluate(() => document.querySelector('.photo-card img').getAttribute('src'));
      ok('grid thumbnails still ask for 400 regardless', /[?&]w=400(&|$)/.test(thumb), thumb);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'WILL-KEY'), contextOptions: MOBILE });
}

// A bare index.html with no session now leaves for home.html (the "studio
// entrance" suites above), so this desktop-bucket check — which has nothing
// to do with auth — needs a studio_token to stay on the page, same as the
// "photographer mode" suite below.
await suite('responsive preview width — a desktop viewport keeps the 1600 bucket',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.driveManager, null, { timeout: 5000 });
    const width = await page.evaluate(() => driveManager.previewWidth());
    ok('desktop (1500px, DPR1) keeps the largest bucket', width === 1600, String(width));
    return out;
  },
  { initScript: ADMIN });

{
  const m = pickFakeWorker({ ownerName: 'Xin', ownerKey: 'XIN-KEY', photos: PHOTOS(2) });
  await suite('selected highlight (pick mode) — thick coloured border + solid ♥ badge, never a dimming overlay',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const cardStyle = () => page.evaluate(() => {
        const card = document.querySelector('.photo-card');
        const cs = getComputedStyle(card);
        return { picked: card.classList.contains('pick-picked'), borderWidth: cs.borderWidth, borderColor: cs.borderColor };
      });
      let s = await cardStyle();
      ok('an unselected card is not marked picked', s.picked === false, JSON.stringify(s));

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      s = await cardStyle();
      ok('a selected card gets the pick-picked class', s.picked === true, JSON.stringify(s));
      ok('with a clearly thick border', parseFloat(s.borderWidth) >= 3, s.borderWidth);

      // A fresh render (e.g. switching the filter and back) rebuilds the card
      // from scratch via createPhotoCard — the highlight has to come from
      // the photo's own rating there too, not only from the live toggle's
      // direct classList write above.
      await page.evaluate(() => app.renderPhotoGrid());
      s = await cardStyle();
      ok('a freshly re-rendered card is picked-highlighted too, from the start',
        s.picked === true, JSON.stringify(s));

      const overlayCheck = await page.evaluate(() => {
        const container = document.querySelector('.photo-image-container');
        const overlay = container.querySelector('.photo-overlay');
        const img = container.querySelector('.photo-image');
        return {
          overlayIsTransparent: !overlay || getComputedStyle(overlay).backgroundColor === 'rgba(0, 0, 0, 0)',
          imgFilter: getComputedStyle(img).filter,
          imgOpacity: getComputedStyle(img).opacity,
        };
      });
      ok('no semi-transparent overlay dims the photo', overlayCheck.overlayIsTransparent, JSON.stringify(overlayCheck));
      ok('the image itself carries no dimming filter', overlayCheck.imgFilter === 'none', overlayCheck.imgFilter);
      ok('nor any reduced opacity', overlayCheck.imgOpacity === '1', overlayCheck.imgOpacity);

      // same treatment in the preview
      await page.locator('.photo-card').first().click({ position: { x: 5, y: 5 } }); // avoid the ♥ itself
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const modalStyle = await page.evaluate(() => {
        const c = document.querySelector('.canvas-container');
        const cs = getComputedStyle(c);
        return { picked: c.classList.contains('pick-picked'), borderWidth: cs.borderWidth };
      });
      ok('the preview frame is highlighted the same way', modalStyle.picked === true, JSON.stringify(modalStyle));
      ok('with a thick border there too', parseFloat(modalStyle.borderWidth) >= 3, modalStyle.borderWidth);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'XIN-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', photos: PHOTOS(2) });
  await suite('tap targets on a mobile viewport — ♥, the filter buttons, and 完成挑圖/確認送出 are all >= 44x44 CSS px',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const box = sel => page.evaluate(s => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }, sel);

      let b = await box('.pick-heart-btn');
      ok('the ♥ toggle is >= 44x44', !!b && b.w >= 44 && b.h >= 44, JSON.stringify(b));

      b = await box('[data-pick-filter="selected"]');
      ok('a filter button is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));

      b = await box('#pickSubmitBtn');
      ok('完成提交 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));

      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      b = await box('#pickSubmitConfirmBtn');
      ok('確認送出 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}
}
