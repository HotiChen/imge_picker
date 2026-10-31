// Browser suites: the album edit mode's swap picker (「選一張照片換進這格」) as tiles on a 390px phone (js/album-preview.js openPicker,
// css/completion-page.css .album-cand*). Square tiles showing the whole photo, 3 columns; a used photo gets a small 已用 corner
// mark, and only a LIGHT dim, only when free photos are listed next to it (all used = no dim at all). Names start with
// "album picker tiles". Chromium only: Safari (the real cause of the 2.5:1 strips, aspect-ratio ignored on a <button>) is Tim's phone.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_OWNER, albReady, albumWorld } from '../lib/album-world.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE } from '../lib/pick-fake.mjs';
import { ordersWorld, ORDERING } from '../lib/guest-orders-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const world = (n, album = {}) => {
  const products = [{ ...SHOP_PRINT_FAKE }, { ...SHOP_ALBUM_FAKE, min_pages: 2, max_pages: 20, extra_page_price: 150, ...album }];
  const ordering = { ...ORDERING };
  const w = albumWorld({ n, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: products, ordering } });
  return { ...ordersWorld(w, { products, ordering }), products };
};
const sx = (name, w, run) => suite(`album picker tiles — ${name}`, `${base}/index.html?t=TOK`, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
const openPicker = async (page, freeOne) => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 8000 });
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  await page.click('#albumPreviewBtn');
  await albReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
  if (freeOne) {   // the engine always puts every photo in the book: to get a photo that is not in it, point the last slot at a photo the first slot already shows
    const n = await page.evaluate(() => { const sp = AlbumPreview._testViewer().cur.spreads; sp.at(-1).slots.at(-1).photoId = sp[0].slots[0].photoId; return new Set(sp.flatMap(x => x.slots.map(y => y.photoId))).size; });
    if (n >= 12) throw new Error('setup: no photo was freed');
  }
  await page.click('#albumNext');
  await page.waitForTimeout(150);
  await page.click('.album-slide[data-current="true"] .album-slot[data-slot="0"]');
  await page.waitForSelector('#albumCandidates .album-cand', { timeout: 4000 });
  await page.waitForTimeout(100);
};
// everything measured from computed styles / boxes
const tiles = page => page.evaluate(() => {
  const g = document.getElementById('albumCandidates'), gr = g.getBoundingClientRect();
  return {
    cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, mixed: g.dataset.mixed,
    hScroll: g.scrollWidth > g.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1,
    list: [...g.querySelectorAll('.album-cand')].map(b => {
      const r = b.getBoundingClientRect(), img = b.querySelector('img'), m = b.querySelector('.album-cand-badge'), mr = m && m.getBoundingClientRect();
      return { id: b.dataset.photoId, used: b.dataset.used === 'true', cur: b.dataset.current === 'true', w: r.width, h: r.height,
        op: +getComputedStyle(img).opacity, fit: getComputedStyle(img).objectFit, label: b.getAttribute('aria-label'),
        mark: m ? { t: m.textContent, w: mr.width, h: mr.height, inside: mr.left >= r.left - .5 && mr.top >= r.top - .5 && mr.right <= r.right + .5 && mr.bottom <= r.bottom + .5, left: mr.left < r.left + r.width / 2 && mr.top < r.top + r.height / 2 } : null };
    }) };
});

// 12 photos: every finals photo is already in the book, so the list is "all used" (the normal case) plus the slot's own photo
{
  const w = world(12);
  await sx('all photos used (390px): 3 square tiles per row, small corner mark, no dim at all', w, async (page, ok) => {
    await openPicker(page);
    const t = await tiles(page);
    const used = t.list.filter(c => c.used), cur = t.list.filter(c => c.cur);
    ok('floor: at least 12 tiles scanned, of which at least 10 are used, and one is the current photo', t.list.length >= 12 && used.length >= 10 && cur.length === 1, `${t.list.length}/${used.length}/${cur.length}`);
    ok('the grid has 3 columns', t.cols === 3, String(t.cols));
    ok('every tile is roughly square (0.75..1.4 width/height), not a strip', t.list.every(c => c.w / c.h >= 0.75 && c.w / c.h <= 1.4), JSON.stringify(t.list.map(c => [Math.round(c.w), Math.round(c.h)])));
    ok('the whole photo is shown (object-fit: contain)', t.list.every(c => c.fit === 'contain'), t.list[0].fit);
    ok('tap targets are at least 44px both ways', t.list.every(c => c.w >= 44 && c.h >= 44));
    ok('no horizontal scroll (grid or page)', !t.hScroll);
    ok('every used photo has a small mark: <= 24px high, <= 60px wide, inside its tile, in the top-left quarter', used.every(c => c.mark && c.mark.h <= 24 && c.mark.w <= 60 && c.mark.inside && c.mark.left), JSON.stringify(used.slice(0, 2).map(c => c.mark)));
    ok('the used mark says 已用 and the tile is still labelled 已使用的照片 for screen readers', used.every(c => c.mark.t === '已用' && c.label === '已使用的照片'));
    ok('all candidates used: NO tile is darkened (computed img opacity 1 everywhere)', t.mixed === 'false' && t.list.every(c => c.op === 1), JSON.stringify(t.list.map(c => c.op)));
    ok('the current photo carries a clear, small 目前 mark', cur[0].mark && cur[0].mark.t === '目前' && cur[0].mark.h <= 24 && cur[0].mark.inside && cur[0].label === '目前這張', JSON.stringify(cur[0].mark));
    // Safari ignored aspect-ratio on the button: simulate that and the tile must still be square
    await page.addStyleTag({ content: '.album-cand{aspect-ratio:auto !important}' });
    const s = await tiles(page);
    ok('without aspect-ratio (Safari case) the tiles are still square, not 44px strips', s.list.every(c => c.w / c.h >= 0.75 && c.w / c.h <= 1.4), JSON.stringify(s.list.slice(0, 3).map(c => [Math.round(c.w), Math.round(c.h)])));
  });
  await sx('picking a used photo still exchanges the two slots (behaviour unchanged)', w, async (page, ok) => {
    await openPicker(page);
    const before = await page.evaluate(() => AlbumPreview.currentLayout());
    const target = await page.evaluate(() => [...document.querySelectorAll('#albumCandidates .album-cand')].find(b => b.dataset.used === 'true').dataset.photoId);
    const mine = before.spreads[0].slots[0].photo_key;
    ok('positive: the target is another photo that sits somewhere in the book', target !== mine && before.spreads.some(sp => sp.slots.some(x => x.photo_key === target)));
    await page.click(`#albumCandidates .album-cand[data-photo-id="${target}"]`);
    await page.waitForFunction(() => !document.getElementById('albumPicker'), null, { timeout: 4000 });
    const after = await page.evaluate(() => AlbumPreview.currentLayout());
    const flat = l => l.spreads.flatMap(sp => sp.slots.map(x => x.photo_key));
    ok('the slot now holds the picked photo and the old photo moved to where the picked one was', after.spreads[0].slots[0].photo_key === target && flat(after).filter(k => k === mine).length === 1 && flat(after).length === flat(before).length, JSON.stringify([flat(before).slice(0, 4), flat(after).slice(0, 4)]));
  });
}

// one photo taken out of the book (see openPicker): some photos are free, free and used photos are listed together: the used ones get the light dim
{
  const w = world(12);
  await sx('free and used photos together: only the used ones are lightly dimmed (15–20%), free ones are full strength', w, async (page, ok) => {
    await openPicker(page, true);
    const t = await tiles(page);
    const free = t.list.filter(c => !c.used && !c.cur), used = t.list.filter(c => c.used);
    ok('positive control: the list holds free and used photos (floor: 12 tiles, both groups)', t.list.length >= 12 && free.length >= 1 && used.length >= 1 && t.mixed === 'true', `${t.list.length}/${free.length}/${used.length}/${t.mixed}`);
    ok('used photos are dimmed lightly: computed opacity between 0.8 and 0.85 (15–20%), not the old 0.38', used.every(c => c.op >= 0.8 && c.op <= 0.85), JSON.stringify(used.map(c => c.op)));
    ok('free photos are full strength and carry no mark', free.every(c => c.op === 1 && c.mark === null), JSON.stringify(free.slice(0, 3).map(c => [c.op, c.mark])));
    ok('used photos still carry the small mark, current stays marked', used.every(c => c.mark && c.mark.h <= 24 && c.mark.w <= 60 && c.mark.inside) && t.list.filter(c => c.cur).every(c => c.mark && c.mark.t === '目前'));
    ok('3 columns, square, no horizontal scroll here too', t.cols === 3 && t.list.every(c => c.w / c.h >= 0.75 && c.w / c.h <= 1.4) && !t.hScroll);
  });
}

}
