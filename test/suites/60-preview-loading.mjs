// Browser suite: the guest's enlarged preview while the bigger file is still arriving. The old photo must not stay on the
// canvas: the card's own thumbnail (already in the browser) is shown at once and a loading ring sits over it, and a late
// answer for a photo the guest already left must never be drawn.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { BIG_PHOTO, PIXEL, MOBILE } from '../lib/env.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
// thumbnails (w=400) answer at once; every bigger size is held for 1500ms (p1 for 600ms: it is the one a fast swipe skips past)
const SLOW = (key, w) => (w === '400' ? 0 : key.endsWith('p1.jpg') ? 600 : 1500);
const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', photos: PHOTOS(5), image: BIG_PHOTO, imageFor: (key, w) => (w === '400' ? PIXEL : BIG_PHOTO), imageDelay: SLOW });
await suite('preview loading — the thumbnail stands in with a loading ring until the bigger file arrives; a skipped photo never overwrites',
  `${base}/index.html?t=TOK`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    const state = () => page.evaluate(() => ({
      loading: document.querySelector('.canvas-container').classList.contains('photo-loading'),
      ringShown: (() => { const r = document.querySelector('.canvas-container .canvas-loading'); return !!r && getComputedStyle(r).display !== 'none' && r.getBoundingClientRect().width > 0; })(),
      src: annotationManager.imageElement ? annotationManager.imageElement.src : '',
      counter: document.getElementById('photoCounter').textContent,
    }));
    // the 4th and 5th photos' big files never arrive, for the failure paths below: p3 fails late (its thumbnail is
    // already up when it does), p4 fails at once (before its thumbnail can land)
    await page.route(/p3\.jpg\?w=(1200|1600)/, r => setTimeout(() => r.abort().catch(() => {}), 600));
    await page.route(/p4\.jpg\?w=(1200|1600)/, r => r.abort());
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    // let the grid thumbnails land first: they are what the placeholder reuses
    await page.waitForFunction(() => [...document.querySelectorAll('.photo-card img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });

    await page.locator('.photo-card').first().tap();
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForTimeout(300);
    let s = await state();
    ok('while the big file is on its way the container is marked loading', s.loading, JSON.stringify(s));
    ok('and a loading ring is visible', s.ringShown, JSON.stringify(s));
    ok('the canvas already shows this photo\'s thumbnail (w=400), not nothing', /p0\.jpg\?w=400/.test(s.src), s.src);

    await page.waitForFunction(() => !document.querySelector('.canvas-container').classList.contains('photo-loading'), null, { timeout: 5000 });
    s = await state();
    ok('once the big file is in, the mark and the ring are gone', !s.loading && !s.ringShown, JSON.stringify(s));
    ok('and the canvas holds the big file (not the 400 thumbnail)', /p0\.jpg\?w=(?!400)\d+/.test(s.src), s.src);

    // next photo: the previous one must not stay on screen while p1's file is slow
    await page.click('#nextPhotoBtn');
    await page.waitForTimeout(250);
    s = await state();
    ok('navigating marks loading again at once', s.loading, JSON.stringify(s));
    ok('the canvas no longer holds the PREVIOUS photo (p0): it shows p1\'s thumbnail', /p1\.jpg\?w=400/.test(s.src) && !/p0\.jpg/.test(s.src), s.src);

    // a resize while only the stand-in is up keeps it big (it must not jump back to its own 400px size)
    await page.setViewportSize({ width: 380, height: 780 });
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ loading: document.querySelector('.canvas-container').classList.contains('photo-loading'), scale: annotationManager.scale, w: annotationManager.imageElement && annotationManager.imageElement.width }));
    ok('a resize during the stand-in keeps it scaled up (a 1px stand-in is drawn big)', s.loading && s.w === 1 && s.scale > 1, JSON.stringify(s));

    // skip fast p1 -> p2: p1's late answer (600ms) must not be drawn once the guest is on p2
    await page.click('#nextPhotoBtn');
    await page.waitForTimeout(900); // p1 would have landed by now (600ms), p2 (1500ms) has not
    s = await state();
    ok('on p2 the late p1 answer is not drawn over it', s.counter === '3 / 5' && !/p1\.jpg/.test(s.src), JSON.stringify(s));
    await page.waitForFunction(() => !document.querySelector('.canvas-container').classList.contains('photo-loading'), null, { timeout: 5000 });
    s = await state();
    ok('and p2\'s own file ends up on the canvas', /p2\.jpg\?w=(?!400)\d+/.test(s.src), s.src);
    for (const [n, how] of [[4, 'late, after its thumbnail is up'], [5, 'at once']]) {
      await page.click('#nextPhotoBtn');
      await page.waitForFunction(k => document.getElementById('photoCounter').textContent === `${k} / 5`, n, { timeout: 5000 });
      await page.waitForTimeout(1200);
      s = await page.evaluate(() => ({ img: !!annotationManager.imageElement, loading: document.querySelector('.canvas-container').classList.contains('photo-loading') }));
      ok(`when the big file fails ${how}, the blurry stand-in is cleared and the ring is gone`, !s.img && !s.loading, JSON.stringify(s));
    }
    return out;
  },
  { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LIA-KEY'), contextOptions: MOBILE });
}
