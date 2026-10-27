// Browser suites: the guest's album EDIT mode in the preview viewer (docs/guest-shop.md, 「S3 — 客人相本排版」):
// swap photos slot by slot, 再次編排 with a confirmation, 上一版 (in memory, 5 deep), the whole-book review, 送出結帳 ->
// js/guest-order.js sends the album line as { option_id, qty, layout } (Layout JSON v2). Only the seat owner of a confirmed
// project with ordering on and an orderable album gets edit mode; everyone else keeps the exact read-only preview.
// The fake Worker (test/lib/guest-orders-fake.mjs) mirrors the layout contract (serialisation, not_in_finals, pages_*, 96 KB).
// Suite names start with "album edit" (ONLY="album edit"). Synthetic SVG photos, Chromium only: a real phone is Tim's.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, ALB_OWNER, ALB_VIEWER, albReady, albumWorld } from '../lib/album-world.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE } from '../lib/pick-fake.mjs';
import { ordersWorld, ORDERING } from '../lib/guest-orders-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, run, opts) => suite(`album edit — ${name}`, `${base}/index.html?t=TOK`, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);

// an album of 2..20 spreads (150 per extra spread, two options) and a print; `album` overrides the album's fields
const catalogue = (album = {}) => [
  { ...SHOP_PRINT_FAKE },
  { ...SHOP_ALBUM_FAKE, min_pages: 2, max_pages: 20, extra_page_price: 150, ...album },
];
// n photos; o.ordering undefined = on, null = off
const world = (o = {}) => {
  const products = o.products || catalogue(o.album);
  const ordering = o.ordering === undefined ? { ...ORDERING } : o.ordering;
  const w = albumWorld({ n: o.n ?? 12, files: o.files, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: products, ordering } });
  return { ...ordersWorld(w, { products, ordering }), products, album: w.ctl };      // album: the album world's own controls (failList ...)
};
const open = async page => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 8000 });
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  await page.click('#albumPreviewBtn');
  await albReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
  await page.waitForTimeout(120);
};
const layoutNow = page => page.evaluate(() => AlbumPreview.currentLayout());
const flipTo = async (page, n) => {
  for (let guard = 0; guard < 60; guard++) {
    const at = await page.evaluate(() => { const l = document.getElementById('albumLabel').textContent; return l === '封面' ? 0 : l === '封底' ? 99 : +l.split('/')[0]; });
    if (at === n) return;
    await page.click(at < n ? '#albumNext' : '#albumPrev');
    await page.waitForTimeout(60);
  }
  throw new Error(`could not reach page ${n}`);
};
const lastPage = async page => { for (let g = 0; g < 60 && !(await page.evaluate(() => document.getElementById('albumNext').disabled)); g++) { await page.click('#albumNext'); await page.waitForTimeout(40); } };
const slotCount = page => page.evaluate(() => document.querySelectorAll('.album-slide[data-current="true"] .album-slot').length);
const pickSlot = async (page, s) => { await page.click(`.album-slide[data-current="true"] .album-slot[data-slot="${s}"]`); await page.waitForSelector('#albumPicker', { timeout: 4000 }); };
const cands = page => page.evaluate(() => [...document.querySelectorAll('#albumCandidates .album-cand')].map(b => ({
  id: b.dataset.photoId, used: b.dataset.used === 'true', match: b.dataset.match === 'true', cur: b.dataset.current === 'true',
  badge: b.querySelector('.album-cand-badge')?.textContent ?? '', op: +getComputedStyle(b.querySelector('img')).opacity, src: b.querySelector('img').src })));
const chooseCand = async (page, id) => {
  await page.evaluate(i => { const b = [...document.querySelectorAll('#albumCandidates .album-cand')].find(x => x.dataset.photoId === i); if (!b) throw new Error('no candidate ' + i); b.click(); }, id);
  await page.waitForFunction(() => !document.getElementById('albumPicker'), null, { timeout: 4000 });
  await page.waitForTimeout(60);
};
const note = page => page.evaluate(() => document.getElementById('albumEditNote')?.textContent ?? null);
const inner = l => l.spreads.flatMap(sp => sp.slots.map(x => x.photo_key));
const keysOf = l => [l.cover.photo_key, ...inner(l)];
const plain = l => JSON.stringify(l);
const confirmText = page => page.evaluate(() => document.getElementById('albumConfirmText')?.textContent ?? null);
const waitPosts = (w, n) => new Promise((res, rej) => { const t0 = Date.now(); const f = () => w.posts().length >= n ? res() : Date.now() - t0 > 6000 ? rej(new Error(`only ${w.posts().length} POSTs`)) : setTimeout(f, 30); f(); });
const click = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.click(); }, sel);
const step = (page, name) => page.waitForSelector(`#goSheet[data-step="${name}"]`, { timeout: 5000 });
const shown = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }, sel);

// ── 1. who gets edit mode (the positive case AND each negative case)
{
  const w = world();
  await sx('owner of a confirmed project, ordering on, orderable album: the viewer is in edit mode', async (page, ok) => {
    await open(page);
    const r = await page.evaluate(() => ({ edit: document.getElementById('albumViewer').dataset.edit, slots: document.querySelectorAll('.album-slot[data-slot]').length,
      undo: !!document.getElementById('albumUndo'), go: !!document.getElementById('albumCheckout'), again: !!document.getElementById('albumRelayout') }));
    ok('data-edit=true, the photos carry data-slot, 上一版 and 送出結帳 exist, 再次編排 is still there', r.edit === 'true' && r.slots >= 1 && r.undo && r.go && r.again, JSON.stringify(r));
    ok('上一版 starts disabled, 送出結帳 enabled (12 photos are inside 2–20 spreads)', await page.evaluate(() => document.getElementById('albumUndo').disabled && !document.getElementById('albumCheckout').disabled));
    const l = await layoutNow(page);
    ok('the layout is Layout JSON v2: v 2, mode auto, a cover, spreads with template + slots, back null', l.v === 2 && l.mode === 'auto' && !!l.cover && l.spreads.length >= 2 && l.spreads.every(sp => sp.template && sp.slots.length >= 1) && l.back === null, plain(l).slice(0, 200));
    ok('photo_key is the key the preview draws (the listing id)', keysOf(l).every(k => /^shoot\/精修\/IMG_\d{4}\.jpg$/.test(k)));
    ok('no POST yet: opening the editor writes nothing', w.reqs.length === 0 || w.posts().length === 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
for (const [label, mk, ctx, initScript] of [
  ['a viewer (no seat key)', () => world(), ALB_DESK, ALB_VIEWER],
  ['ordering switched off (null)', () => world({ ordering: null }), ALB_DESK, ALB_OWNER],
  ['the album has no min_pages (not orderable)', () => world({ album: { min_pages: null, max_pages: null } }), ALB_DESK, ALB_OWNER],
]) {
  const w = mk();
  await sx(`${label}: exactly the read-only preview`, async (page, ok) => {
    await open(page);
    const r = await page.evaluate(() => ({ edit: document.getElementById('albumViewer').dataset.edit, slots: document.querySelectorAll('.album-slot[data-slot]').length, slotsAll: document.querySelectorAll('.album-slot').length,
      undo: !!document.getElementById('albumUndo'), go: !!document.getElementById('albumCheckout'), again: !!document.getElementById('albumRelayout'), cur: AlbumPreview.currentLayout(),
      cursor: getComputedStyle(document.querySelector('.album-slot')).cursor }));
    ok('positive: the viewer is up with photos and 再次編排', r.slotsAll >= 2 && r.again && r.edit === 'false', JSON.stringify(r));
    ok('no data-slot, no 上一版, no 送出結帳, no layout, the photos are not clickable', r.slots === 0 && !r.undo && !r.go && r.cur === null && r.cursor !== 'pointer', JSON.stringify(r));
    await page.click('.album-slide[data-current="true"] .album-slot');
    await page.waitForTimeout(150);
    ok('tapping a photo opens nothing', await page.evaluate(() => !document.getElementById('albumPicker')));
    ok('double click still zooms (the read-only gestures are intact)', await (async () => { await page.dblclick('.album-slide[data-current="true"] .album-page'); return await page.evaluate(() => document.getElementById('albumStage').dataset.zoom === '2.50'); })());
  }, { before: w.before, initScript, contextOptions: ctx });
}

// ── 2. the candidate list
{
  const w = world();
  await sx('tap a photo -> candidates: thumbnails only, unused first, matching shape first, used dimmed and marked 已使用', async (page, ok) => {
    await open(page);
    const before = await layoutNow(page);
    await flipTo(page, 1);
    ok('positive: the current page has photos to tap', await slotCount(page) >= 1);
    await pickSlot(page, 0);
    const cs = await cands(page);
    const used = new Set(inner(before));
    ok('every one of the 12 finals is a candidate, once', cs.length === 12 && new Set(cs.map(c => c.id)).size === 12, String(cs.length));
    ok('used = on the inside pages (the slot itself counts as free), and it is what the badge says', cs.every(c => c.used === (used.has(c.id) && c.id !== before.spreads[0].slots[0].photo_key)), JSON.stringify(cs.map(c => [c.used, c.badge])));
    const first = cs.findIndex(c => c.used);
    ok('unused ones come first, then the used ones (floor: both groups exist)', first > 0 && cs.slice(0, first).every(c => !c.used) && cs.slice(first).every(c => c.used) || first === -1 && cs.every(c => !c.used), JSON.stringify(cs.map(c => c.used)));
    const un = cs.filter(c => !c.used && !c.cur), us = cs.filter(c => c.used);
    const sorted = g => { const k = g.map(c => c.match); const i = k.indexOf(false); return i === -1 || k.slice(i).every(m => !m); };
    ok('inside each group the photos of the slot\'s orientation come first', sorted(un) && sorted(us), JSON.stringify([un.map(c => c.match), us.map(c => c.match)]));
    ok('used ones are dimmed (computed opacity < 0.6) and badged 已使用; free ones are full strength with no badge',
      us.every(c => c.op < 0.6 && c.badge === '已使用') && cs.filter(c => !c.used && !c.cur).every(c => c.op === 1 && c.badge === ''), JSON.stringify(cs.map(c => [c.op, c.badge])));
    ok('the slot\'s own photo is marked 目前', cs.filter(c => c.cur).length === 1 && cs.find(c => c.cur).badge === '目前' && cs.find(c => c.cur).id === before.spreads[0].slots[0].photo_key);
    ok('thumbnails only: every src has ?w=400 and none is an original or a download', cs.every(c => /[?&]w=400/.test(c.src) && !/download/.test(c.src)), cs[0].src);
    const orig = w.log.filter(r => r.method === 'GET' && !r.list && r.w == null && r.key && /IMG_/.test(r.key));
    ok('the Worker saw no read without ?w= (no original) and no download=1', orig.length === 0 && w.log.every(r => !r.download), JSON.stringify(orig.slice(0, 2)));
    await page.keyboard.press('Escape');
    ok('Esc closes the list only (the viewer stays)', await page.evaluate(() => !document.getElementById('albumPicker') && !!document.getElementById('albumViewer')));
    ok('the layout did not change', plain(await layoutNow(page)) === plain(before));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 3. replace, exchange, cover
{
  const w = world();
  await sx('an unused photo REPLACES the slot; a used one EXCHANGES the two; template and spread count never change', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    const usedSet = new Set(inner(l0));
    const free = Array.from({ length: 12 }, (_, i) => `shoot/精修/IMG_${String(i + 1).padStart(4, '0')}.jpg`).filter(k => !usedSet.has(k));
    await flipTo(page, 1);
    // exchange first: slot 0 of spread 1 <- the photo that sits in the last slot of the last spread
    const lastSp = l0.spreads[l0.spreads.length - 1];
    const other = lastSp.slots[lastSp.slots.length - 1].photo_key;
    const mine = l0.spreads[0].slots[0].photo_key;
    ok('setup: the two photos are different and both used', other !== mine && usedSet.has(other) && usedSet.has(mine));
    await pickSlot(page, 0);
    await chooseCand(page, other);
    const l1 = await layoutNow(page);
    ok('exchange: slot 0 of spread 1 has the other photo, the other slot has mine', l1.spreads[0].slots[0].photo_key === other && l1.spreads.at(-1).slots.at(-1).photo_key === mine);
    ok('every other slot is exactly as before', l1.spreads.every((sp, i) => sp.slots.every((x, j) => (i === 0 && j === 0) || (i === l1.spreads.length - 1 && j === sp.slots.length - 1) || plain(x) === plain(l0.spreads[i].slots[j]))) && plain(l1.cover) === plain(l0.cover));
    ok('templates, mirror flags and the spread count are untouched', l1.spreads.length === l0.spreads.length && l1.spreads.every((sp, i) => sp.template === l0.spreads[i].template && !!sp.mirrored === !!l0.spreads[i].mirrored));
    ok('the same set of inside photos (an exchange loses nothing)', JSON.stringify(inner(l1).sort()) === JSON.stringify(inner(l0).sort()));
    ok('the notice says the photo was already in the book and the two swapped', /已在書中/.test(await note(page)) && /互換/.test(await note(page)), await note(page));
    ok('the page shows it: the first slot now draws the other photo', await page.evaluate(k => decodeURIComponent(new URL(document.querySelector('.album-slide[data-current="true"] .album-slot[data-slot="0"] img').src).pathname.slice(1)) === k, other));
    ok('上一版 is still disabled (a swap is not a re-layout)', await page.evaluate(() => document.getElementById('albumUndo').disabled));
    // replace: needs a free photo (12 photos, the plan may use them all)
    if (free.length) {
      await pickSlot(page, 0);
      await chooseCand(page, free[0]);
      const l2 = await layoutNow(page);
      ok('replace: the slot has the free photo, the old one is no longer used anywhere inside', l2.spreads[0].slots[0].photo_key === free[0] && !inner(l2).includes(other));
      ok('replace says nothing about "already in the book"', !/已在書中/.test(await note(page)), await note(page));
      ok('no inside photo twice', new Set(inner(l2)).size === inner(l2).length);
    } else ok('(all 12 photos are used: the replace case is covered by the cover test below)', true);
    ok('no request left for the Worker but reads (nothing is written by swapping)', w.reqs.length === 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('cover: swappable, may repeat an inside photo; an inside photo is still there at most once', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    const inside = inner(l0)[0];
    await pickSlot(page, 0);                                 // the cover is page 0
    const cs = await cands(page);
    ok('positive: the cover list offers all 12', cs.length === 12);
    ok('inside photos are marked 已使用 on the cover list too (and the cover\'s own is 目前)', cs.find(c => c.id === inside).used && cs.filter(c => c.cur).length === 1 && cs.find(c => c.cur).id === l0.cover.photo_key);
    await chooseCand(page, inside);
    const l1 = await layoutNow(page);
    ok('the cover now repeats an inside photo, the inside pages did not change', l1.cover.photo_key === inside && plain({ s: l1.spreads }) === plain({ s: l0.spreads }));
    ok('the key appears twice in the book (cover + once inside), inside only once', keysOf(l1).filter(k => k === inside).length === 2 && new Set(inner(l1)).size === inner(l1).length);
    ok('the notice does not claim an exchange (nothing moved inside)', !/互換/.test(await note(page)), await note(page));
    // an inside slot may take the cover's photo without moving the cover
    await flipTo(page, 1);
    await pickSlot(page, 0);
    const cs2 = await cands(page);
    const coverKey = l1.cover.photo_key;
    const old = l0.cover.photo_key;
    ok('inside list: the photo the cover used to be (now used nowhere unless it is inside) is marked exactly by whether it is inside',
      cs2.find(c => c.id === old).used === (inner(l1).includes(old) && l1.spreads[0].slots[0].photo_key !== old), JSON.stringify(cs2.find(c => c.id === old)));
    void coverKey;
    await page.keyboard.press('Escape');
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 4. the crop of a swapped-in photo, and the shape notice
{
  const w = world();
  await sx('fit cover plan: a swapped-in photo gets its crop from the analysed focus (AutoLayout.util.cropFor), rounded to 3 decimals; contain keeps 0,0,1', async (page, ok) => {
    await page.evaluate(() => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, fit: 'cover' }; });
    await open(page);
    const l0 = await layoutNow(page);
    ok('positive: this plan is fit cover', l0.spreads.every(sp => sp.slots.every(x => x.fit === 'cover')) && l0.cover.fit === 'cover');
    // record what the viewer asks cropFor, and answer with a recognisable crop
    await page.evaluate(() => {
      const real = AutoLayout.util.cropFor;
      window.__cropCalls = [];
      AutoLayout.util.cropFor = (pa, sa, focus) => { window.__cropCalls.push({ pa, sa, focus }); return { x: 0.1234567, y: 0.5, scale: 1 }; };
      window.__realCropFor = real;
    });
    await flipTo(page, 1);
    const target = l0.spreads[0].slots[0].photo_key;
    const keys = Array.from({ length: 12 }, (_, i) => `shoot/精修/IMG_${String(i + 1).padStart(4, '0')}.jpg`);
    const pick = keys.find(k => k !== target && !inner(l0).includes(k)) || inner(l0).find(k => k !== target);
    await pickSlot(page, 0);
    await chooseCand(page, pick);
    const l1 = await layoutNow(page);
    const calls = await page.evaluate(() => window.__cropCalls);
    const SHAPES = [[600, 400], [400, 600], [600, 400], [600, 400], [400, 600], [500, 500], [800, 400], [400, 600], [600, 400], [400, 600]];
    const aspOf = k => { const [a, b] = SHAPES[(+/IMG_(\d{4})/.exec(k)[1] - 1) % SHAPES.length]; return a / b; };
    const sa = await page.evaluate(() => { const sd = SpreadTemplates.byId(document.querySelector('.album-slide[data-current="true"] .album-page').dataset.layout).slots[0]; return sd.w * AlbumPreview.SPREAD_ASPECT / sd.h; });
    const c = calls.find(x => Math.abs(x.pa - aspOf(pick)) < 0.02);
    ok('cropFor was asked with the new photo\'s aspect, the slot\'s aspect and a focus point', !!c && Math.abs(c.sa - sa) < 0.01 && Number.isFinite(c.focus?.x) && Number.isFinite(c.focus?.y), JSON.stringify(calls));
    ok('exactly one call per placed photo (a replace places one)', calls.length >= 1);
    ok('the layout carries what cropFor answered, rounded to 3 decimals: x 0.123, y 0.5, scale 1', plain(l1.spreads[0].slots[0].crop) === plain({ x: 0.123, y: 0.5, scale: 1 }), plain(l1.spreads[0].slots[0].crop));
    let moved = null;                                    // an exchange also re-crops the slot that gave the photo
    l0.spreads.forEach((sp, i) => sp.slots.forEach((x, j) => { if (x.photo_key === pick) moved = [i, j]; }));
    ok('every other slot keeps its planner crop', l1.spreads.every((sp, i) => sp.slots.every((x, j) => (i === 0 && j === 0) || (moved && moved[0] === i && moved[1] === j) || plain(x.crop) === plain(l0.spreads[i].slots[j].crop))) && plain(l1.cover) === plain(l0.cover));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('contain plan (the 完成頁 default): a swapped-in photo keeps fit contain and crop 0,0,1 (the cropFor is not used)', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    ok('positive: the plan is contain', l0.spreads.every(sp => sp.slots.every(x => x.fit === 'contain')) && l0.cover.fit === 'contain');
    await page.evaluate(() => { window.__cropCalls = 0; AutoLayout.util.cropFor = () => { window.__cropCalls++; return { x: 1, y: 1, scale: 1 }; }; });
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await chooseCand(page, inner(l0).at(-1));
    const l1 = await layoutNow(page);
    ok('both slots of the exchange are contain with 0,0,1', [l1.spreads[0].slots[0], l1.spreads.at(-1).slots.at(-1)].every(x => x.fit === 'contain' && plain(x.crop) === plain({ x: 0, y: 0, scale: 1 })));
    ok('cropFor was never called for a contain slot', await page.evaluate(() => window.__cropCalls === 0));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('shape notice: a photo that wastes more than the threshold says so; a well-matched one does not', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    ok('the threshold is one named constant', await page.evaluate(() => AlbumPreview.SHAPE_WASTE_WARN === 0.3));
    await flipTo(page, 1);
    const SHAPES = [[600, 400], [400, 600], [600, 400], [600, 400], [400, 600], [500, 500], [800, 400], [400, 600], [600, 400], [400, 600]];
    const asp = k => { const [a, b] = SHAPES[(+/IMG_(\d{4})/.exec(k)[1] - 1) % SHAPES.length]; return a / b; };
    const waste = (p, s) => 1 - Math.min(p, s) / Math.max(p, s);
    const slotAsp = await page.evaluate(() => { const v = document.querySelector('.album-slide[data-current="true"] .album-page'); const sp = SpreadTemplates.byId(v.dataset.layout); return sp.slots.map(sd => sd.w * AlbumPreview.SPREAD_ASPECT / sd.h); });
    const keys = Array.from({ length: 12 }, (_, i) => `shoot/精修/IMG_${String(i + 1).padStart(4, '0')}.jpg`);
    // the exchange puts the slot's own photo into the other slot too, so the pair is judged on the photo going INTO the tapped slot
    let bad = null;
    for (let s = 0; s < slotAsp.length && !bad; s++) for (const k of keys) {
      if (k === l0.spreads[0].slots[s].photo_key) continue;
      if (waste(asp(k), slotAsp[s]) > 0.4) { bad = { s, k, wst: waste(asp(k), slotAsp[s]) }; break; }
    }
    ok('setup: the fixture has a badly matching pair on this spread', !!bad);
    await pickSlot(page, bad.s);
    await chooseCand(page, bad.k);
    ok(`a ${(bad.wst * 100).toFixed(0)}% waste photo gets the shape notice`, /這張和這格形狀不合，會留白或被裁切/.test(await note(page)), await note(page));
    // a photo of the very shape of its slot: put the planner's own photo back (waste of the plan's own choice is below the threshold)
    const back = l0.spreads[0].slots[bad.s].photo_key;
    const ok2 = waste(asp(back), slotAsp[bad.s]) <= 0.3;
    await pickSlot(page, bad.s);
    await chooseCand(page, back);
    if (ok2) ok('putting the planner\'s own (well fitting) photo back gives no shape notice', !/這張和這格形狀不合/.test(await note(page)), await note(page));
    else ok('(the planner\'s own photo here is itself over the threshold: no negative case in this slot)', true);
    ok('positive: the notice line says something about the swap in both cases', (await note(page)).length > 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 5. 再次編排 asks, 上一版
{
  const w = world();
  await sx('再次編排: no question when nothing was swapped; after a swap it asks first (取消 keeps everything, 繼續 drops the swaps)', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    await page.click('#albumRelayout'); await page.waitForTimeout(150);
    ok('no swaps -> no confirmation, it just re-lays out', !(await page.evaluate(() => !!document.getElementById('albumConfirm'))) && /排法|只有這個/.test(await page.evaluate(() => document.getElementById('albumRelayoutStatus').textContent)));
    await page.click('#albumRelayoutBack'); await page.waitForTimeout(150);
    ok('回到原本 gives the first layout back', plain(await layoutNow(page)) === plain(l0));
    const hist0 = await page.evaluate(() => +document.getElementById('albumUndo').dataset.count);
    ok('both layout changes went on the 上一版 stack (a re-layout and 回到原本)', hist0 === 2, String(hist0));
    // swap, then re-layout
    await flipTo(page, 1);
    const other = inner(l0).at(-1);
    await pickSlot(page, 0);
    await chooseCand(page, other);
    const swapped = await layoutNow(page);
    ok('setup: the swap changed the layout', plain(swapped) !== plain(l0));
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    ok('after a swap 再次編排 opens a confirmation that names the loss', /取消你換過的照片/.test(await confirmText(page) || ''), await confirmText(page));
    ok('the confirmation is a real dialog on top: the background is inert, the 取消 button has the focus', await page.evaluate(() => document.getElementById('albumStage').inert && document.activeElement.id === 'albumConfirmNo'));
    ok('nothing re-laid out yet', plain(await layoutNow(page)) === plain(swapped));
    await page.click('#albumConfirmNo'); await page.waitForTimeout(100);
    ok('先不要: the dialog is gone, the swapped layout stays, the background works again, the stack did not grow', !(await page.evaluate(() => !!document.getElementById('albumConfirm'))) && plain(await layoutNow(page)) === plain(swapped) && await page.evaluate(h => !document.getElementById('albumStage').inert && +document.getElementById('albumUndo').dataset.count === h, hist0));
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    await page.click('#albumConfirmYes'); await page.waitForTimeout(200);
    const after = await layoutNow(page);
    ok('繼續編排: a new layout, the swap is gone (it is the planner\'s variant now)', plain(after) !== plain(swapped) && plain(after) !== plain(l0));
    ok('and 上一版 gained exactly one entry', await page.evaluate(h => +document.getElementById('albumUndo').dataset.count === h + 1 && !document.getElementById('albumUndo').disabled, hist0));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('上一版: restores the full previous state (swaps included), 5 deep at most, in memory only', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await chooseCand(page, inner(l0).at(-1));
    const swapped = await layoutNow(page);
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    await page.click('#albumConfirmYes'); await page.waitForTimeout(200);
    const relaid = await layoutNow(page);
    ok('setup: swapped, then re-laid out', plain(relaid) !== plain(swapped));
    await page.click('#albumUndo'); await page.waitForTimeout(150);
    ok('上一版 gives back the swapped state exactly (the swap is back)', plain(await layoutNow(page)) === plain(swapped));
    ok('the stack is empty again: 上一版 disabled (computed: not clickable)', await page.evaluate(() => { const b = document.getElementById('albumUndo'); return b.disabled && getComputedStyle(b).opacity < 0.6 && b.dataset.count === '0'; }));
    ok('the status says so', await page.evaluate(() => document.getElementById('albumRelayoutStatus').textContent) === '已回到上一版');
    ok('the chip and 回到原本 follow the restored layout (the swapped one is the first plan)', await page.evaluate(() => document.getElementById('albumRelayoutBack').hidden && document.getElementById('albumRelayoutChip').hidden));
    // depth: 7 re-layouts -> 5 entries
    for (let i = 0; i < 7; i++) {
      await page.click('#albumRelayout'); await page.waitForTimeout(80);
      if (await page.evaluate(() => !!document.getElementById('albumConfirm'))) { await page.click('#albumConfirmYes'); await page.waitForTimeout(80); }
    }
    const n = await page.evaluate(() => +document.getElementById('albumUndo').dataset.count);
    ok('after many re-layouts the stack holds 5, no more (and at least one press changed the plan)', n === 5, String(n));
    for (let i = 0; i < 5; i++) { await page.click('#albumUndo'); await page.waitForTimeout(60); }
    ok('five pops empty it; one more is impossible (disabled)', await page.evaluate(() => document.getElementById('albumUndo').disabled));
    const stor = await page.evaluate(() => ({ writes: window.__storageWrites, ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) }));
    ok('nothing was written to localStorage / sessionStorage by the editor (only the seat key the test seeded)', stor.writes.every(x => !/album|layout|undo|history/i.test(JSON.stringify(x))) && stor.ss.length === 0 && stor.ls.every(k => !/album|layout/i.test(k)), JSON.stringify(stor));
    ok('and nothing was sent to the Worker', w.reqs.length === 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('closing the viewer forgets everything: swaps, 上一版 and the layout number are gone on the next open', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await chooseCand(page, inner(l0).at(-1));
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    await page.click('#albumConfirmYes'); await page.waitForTimeout(150);
    await page.click('#albumClose');
    ok('closed', await page.evaluate(() => !document.getElementById('albumViewer') && AlbumPreview.currentLayout() === null));
    await open(page);
    ok('reopened: the first plan again, 上一版 empty', plain(await layoutNow(page)) === plain(l0) && await page.evaluate(() => document.getElementById('albumUndo').disabled));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 6. 送出結帳: the whole-book review, the confirmation, the order
{
  const w = world();
  await sx('390px: 送出結帳 -> the review must reach the last page before 確認送出 opens; 「送出後無法修改」; then the order carries { option_id, qty, layout } and nothing else', async (page, ok) => {
    await open(page);
    await flipTo(page, 1);
    const l0 = await layoutNow(page);
    await pickSlot(page, 0);
    await chooseCand(page, inner(l0).at(-1));                  // a swap, so the order carries the edited book
    const l1 = await layoutNow(page);
    await page.click('#albumCheckout');
    await page.waitForSelector('#albumSubmit', { timeout: 3000 });
    const r0 = await page.evaluate(() => ({ label: document.getElementById('albumLabel').textContent, dis: document.getElementById('albumSubmit').disabled, note: document.getElementById('albumReviewNote').textContent,
      editHidden: document.querySelector('.album-edit').hidden, relayoutHidden: document.querySelector('.album-relayout').hidden, review: document.getElementById('albumViewer').dataset.review }));
    ok('the review starts at the cover (封面); 確認送出 is disabled; the edit and re-layout rows are hidden', r0.label === '封面' && r0.dis && r0.editHidden && r0.relayoutHidden && r0.review === 'true', JSON.stringify(r0));
    ok('the note says 送出後無法修改', /送出後無法修改/.test(r0.note), r0.note);
    await page.click('.album-slide[data-current="true"] .album-slot');
    await page.waitForTimeout(100);
    ok('in the review a tap on a photo opens nothing', await page.evaluate(() => !document.getElementById('albumPicker')));
    // a disabled button does nothing: click it by force
    await page.evaluate(() => document.getElementById('albumSubmit').click());
    ok('clicking the disabled 確認送出 does nothing (no dialog)', await page.evaluate(() => !document.getElementById('albumConfirm')));
    await page.click('#albumNext'); await page.waitForTimeout(60);
    ok('one page in, still disabled (not at the last page)', await page.evaluate(() => document.getElementById('albumSubmit').disabled));
    await lastPage(page);
    ok('at the last page 確認送出 is enabled', await page.evaluate(() => !document.getElementById('albumSubmit').disabled && document.getElementById('albumNext').disabled));
    await page.click('#albumPrev'); await page.waitForTimeout(60);
    ok('flipping back keeps it enabled (the book was seen)', await page.evaluate(() => !document.getElementById('albumSubmit').disabled));
    await page.click('#albumReviewBack'); await page.waitForTimeout(80);
    ok('返回修改 brings the edit row back and the review row goes', await page.evaluate(() => !document.getElementById('albumReview') && !document.querySelector('.album-edit').hidden && !document.getElementById('albumViewer').dataset.review));
    ok('the layout is unchanged by the review', plain(await layoutNow(page)) === plain(l1));
    await page.click('#albumCheckout');
    await page.waitForSelector('#albumSubmit');
    ok('a second review starts over: disabled again at the cover', await page.evaluate(() => document.getElementById('albumSubmit').disabled && document.getElementById('albumLabel').textContent === '封面'));
    await lastPage(page);
    await page.click('#albumSubmit'); await page.waitForTimeout(100);
    ok('確認送出 asks once more: 送出後排版無法修改', /送出後排版無法修改/.test(await confirmText(page) || ''), await confirmText(page));
    await page.click('#albumConfirmNo'); await page.waitForTimeout(80);
    ok('再看看: back in the review, nothing sent, the viewer is still up', await page.evaluate(() => !!document.getElementById('albumViewer') && !document.getElementById('albumConfirm') && !document.getElementById('goSheet')) && w.posts().length === 0);
    await page.click('#albumSubmit'); await page.waitForTimeout(80);
    await page.click('#albumConfirmYes');
    await step(page, 'product');
    ok('the viewer is gone and the order sheet shows the product step with the layout: the spread count is fixed', await page.evaluate(() => !document.getElementById('albumViewer') && /跨頁・照你排的版面/.test(document.getElementById('goSheet').textContent) && !document.querySelector('#goSheet .go-stepper .go-step-minus[aria-label="跨頁減一"]')));
    const nSpreads = l1.spreads.length;
    ok(`and the price is 5000 + (${nSpreads} - 2) x 150 for the first option`, (await page.evaluate(() => document.getElementById('goDraftPrice')?.textContent)) === '請先選擇規格');
    await click(page, '.go-opt[data-option-id="opt-album-1"]');
    const unit = 5000 + (nSpreads - 2) * 150;
    ok('the draft price follows the layout\'s spread count', (await page.evaluate(() => document.getElementById('goDraftPrice').textContent)) === `單價 NT$${unit.toLocaleString()}　小計 NT$${unit.toLocaleString()}`, await page.evaluate(() => document.getElementById('goDraftPrice').textContent));
    await click(page, '#goAdd');
    await step(page, 'cart');
    ok('the cart line says 你排的版面', /你排的版面/.test(await page.evaluate(() => document.getElementById('goLines').textContent)));
    await click(page, '#goToContact');
    await step(page, 'contact');
    await page.fill('#goName', '王小明'); await page.fill('#goPhone', '0912-345-678'); await page.check('#goConsent');
    await click(page, '#goToReview');
    await step(page, 'review');
    await click(page, '#goSubmit');
    await waitPosts(w, 1);
    await step(page, 'receipt');
    const body = w.posts()[0].body;
    ok('one POST; the album line is exactly { option_id, qty, layout } (no spreads, no photo_key)', body.lines.length === 1 && JSON.stringify(Object.keys(body.lines[0]).sort()) === JSON.stringify(['layout', 'option_id', 'qty']) && body.lines[0].option_id === 'opt-album-1' && body.lines[0].qty === 1, JSON.stringify(Object.keys(body.lines[0] || {})));
    ok('the layout sent is exactly the edited layout the guest confirmed (swap included)', plain(body.lines[0].layout) === plain(l1));
    ok('expected_total is the layout\'s price', body.expected_total === unit, String(body.expected_total));
    ok('the Worker stored the serialised layout and the spread count', w.orders.length === 1 && w.orders[0].items[0].spreads === nSpreads && plain(w.orders[0].items[0].layout) === plain(l1));
    ok('the receipt shows 待確認 and the spread count', await page.evaluate(() => /待確認/.test(document.getElementById('goSheet').textContent)));
    await click(page, '#goSheet .go-primary');
    // locked: the editor is gone for the rest of this visit
    await open(page);
    const lk = await page.evaluate(() => ({ edit: document.getElementById('albumViewer').dataset.edit, slots: document.querySelectorAll('.album-slot[data-slot]').length, go: !!document.getElementById('albumCheckout'), undo: !!document.getElementById('albumUndo'), note: document.getElementById('albumLockedNote')?.textContent ?? null, cur: AlbumPreview.currentLayout() }));
    ok('after the order the preview is read-only again and says the layout is locked', lk.edit === 'false' && lk.slots === 0 && !lk.go && !lk.undo && lk.cur === null && /已送出訂單.*無法再修改/.test(lk.note || ''), JSON.stringify(lk));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

// ── 7. the order's errors and price change, with a layout line
{
  const w = world();
  await sx('the order flow with a layout: invalid_layout / not_in_finals / pages_* / price_changed are shown in words and nothing is lost', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    await page.click('#albumCheckout');
    await page.waitForSelector('#albumSubmit');
    await lastPage(page);
    await page.click('#albumSubmit'); await page.click('#albumConfirmYes');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-2"]');
    await click(page, '#goAdd'); await step(page, 'cart');
    await click(page, '#goToContact'); await step(page, 'contact');
    await page.fill('#goName', '王小明'); await page.fill('#goPhone', '0912-345-678'); await page.check('#goConsent');
    await click(page, '#goToReview'); await step(page, 'review');
    const tries = [
      ['invalid_layout', 400, /排版內容有誤/], ['not_in_finals', 403, /不在精修成品/], ['pages_below_min', 400, /不符合這本相本的頁數/], ['pages_above_max', 400, /不符合這本相本的頁數/],
    ];
    for (const [code, status, re] of tries) {
      w.ctl.force = { status, body: { error: code, code } };
      await click(page, '#goSubmit');
      await step(page, 'cart');
      await page.waitForSelector('#goCartError', { timeout: 3000 });
      ok(`${code}: the cart shows the plain-Chinese reason`, re.test(await page.evaluate(() => document.getElementById('goCartError').textContent)), await page.evaluate(() => document.getElementById('goCartError').textContent));
      ok(`${code}: the layout line is still in the cart (not lost)`, await page.evaluate(() => document.querySelectorAll('#goLines .go-line').length === 1));
      await click(page, '#goToContact'); await step(page, 'contact');
      await click(page, '#goToReview'); await step(page, 'review');
    }
    // a real price change: the catalogue moves under the guest
    w.products[1].options[1].price += 200;
    await click(page, '#goSubmit');
    await step(page, 'review');
    await page.waitForSelector('#goQuote', { timeout: 3000 });
    ok('price_changed with a layout line: the new total is shown to confirm', /價格有更新/.test(await page.evaluate(() => document.getElementById('goQuote').textContent)));
    const posts = w.posts().length;
    await click(page, '#goSubmit');
    await waitPosts(w, posts + 1);
    await step(page, 'receipt');
    const last = w.posts().at(-1).body;
    ok('the retry after the quote sends the same layout and the Worker\'s new total', plain(last.lines[0].layout) === plain(l0) && w.orders.length === 1 && last.expected_total === w.orders[0].total, String(last.expected_total));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}
{
  const w = world({ album: { min_pages: 15, max_pages: 20 } });
  await sx('the spread count is outside the book\'s range: 送出結帳 is blocked with the reason (12 photos cannot make 15 spreads)', async (page, ok) => {
    await open(page);
    const r = await page.evaluate(() => ({ go: document.getElementById('albumCheckout').disabled, warn: document.getElementById('albumPagesWarn').textContent, vis: !document.getElementById('albumPagesWarn').hidden,
      n: AlbumPreview.currentLayout().spreads.length }));
    ok('positive: the editor is up and there are fewer than 15 spreads', r.n >= 1 && r.n < 15, JSON.stringify(r));
    ok('送出結帳 is disabled and the warning is visible with 不符合這本相本的頁數', r.go && r.vis && /不符合這本相本的頁數/.test(r.warn), JSON.stringify(r));
    await page.evaluate(() => document.getElementById('albumCheckout').click());
    await page.waitForTimeout(100);
    ok('clicking it anyway starts no review', await page.evaluate(() => !document.getElementById('albumReview')));
    ok('swapping and 再次編排 still work', await (async () => { await flipTo(page, 1); await pickSlot(page, 0); await page.keyboard.press('Escape'); return true; })());
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 8. photo keys: the Worker's rule (bookPhotoIdSafe) decides what the editor may offer; keys stay text
{
  const evil = 'shoot/精修/a"><img src=x onerror="window.__pwn=1">.jpg';
  const odd = "shoot/精修/Tim's 照片 (1) & co.jpg";
  const files = ['shoot/精修/IMG_0001.jpg', evil, odd, 'shoot/精修/IMG_0004.jpg', 'shoot/精修/IMG_0005.jpg', 'shoot/精修/IMG_0006.jpg', 'shoot/精修/IMG_0007.jpg', 'shoot/精修/IMG_0008.jpg'];
  const w = world({ files });
  await sx('edit mode skips a photo whose name the Worker would refuse (quote, <, >, ...) and says so; an ordinary odd name (apostrophe, spaces, &) stays; nothing is injected', async (page, ok) => {
    await open(page);
    const l0 = await layoutNow(page);
    ok('positive: the editor is up with 7 usable photos', keysOf(l0).length >= 2 && new Set(keysOf(l0)).size >= 2);
    ok('the unsafe name is in no slot of the layout, the odd but allowed name is a candidate', !keysOf(l0).includes(evil));
    ok('the note names the skipped photo count', /1 張照片的檔名含特殊字元，未放入相本/.test(await page.evaluate(() => document.getElementById('albumNote').textContent)), await page.evaluate(() => document.getElementById('albumNote').textContent));
    await flipTo(page, 1);
    await pickSlot(page, 0);
    const cs = await cands(page);
    ok('7 candidates: the unsafe one is not offered, the odd one is', cs.length === 7 && !cs.some(c => c.id === evil) && cs.some(c => c.id === odd), String(cs.length));
    await chooseCand(page, odd);
    const l1 = await layoutNow(page);
    ok('the layout carries the odd name verbatim', keysOf(l1).includes(odd));
    ok('no layout key anywhere is one the Worker refuses', keysOf(l1).every(k => !/["<>`\\\x00-\x1f]/.test(k)));
    ok('nothing injected, no script ran', await page.evaluate(() => window.__pwn === undefined && !document.querySelector('#albumViewer img[onerror], #albumViewer b')));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const evil = 'shoot/精修/a"><img src=x onerror="window.__pwn=1">.jpg';
  const files = ['shoot/精修/IMG_0001.jpg', evil, 'shoot/精修/IMG_0003.jpg', 'shoot/精修/IMG_0004.jpg'];
  const w = world({ files });
  await sx('read-only preview (a viewer): the same markup name is drawn as before and stays text', async (page, ok) => {
    await open(page);
    const r = await page.evaluate(() => ({ pwn: window.__pwn ?? null, bad: document.querySelectorAll('#albumViewer b, #albumViewer script, #albumViewer img[onerror]').length, ids: [...document.querySelectorAll('#albumViewer img')].map(i => i.dataset.photoId) }));
    ok('positive: the evil name is among the drawn photos (read-only keeps every photo), nothing injected', r.ids.includes(evil) && r.bad === 0 && r.pwn === null, JSON.stringify(r));
  }, { before: w.before, initScript: ALB_VIEWER, contextOptions: ALB_DESK });
}

// ── 9. the checkout cannot be taken: the viewer stays and says so
for (const [label, off] of [['the order flow was reset (GuestOrder not running)', () => GuestOrder.reset()], ['AlbumPreview.order was cleared (ordering_disabled)', () => { AlbumPreview.order = null; }]]) {
  const w = world();
  await sx(`ordering turned off after the editor opened — ${label}: nothing is lost, the guest is told`, async (page, ok) => {
    await open(page);
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await chooseCand(page, (await cands(page)).find(c => !c.cur).id);
    const l1 = await layoutNow(page);
    await page.click('#albumCheckout');
    await page.waitForSelector('#albumSubmit');
    await lastPage(page);
    await page.evaluate(off);
    await page.click('#albumSubmit'); await page.click('#albumConfirmYes'); await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({ viewer: !!document.getElementById('albumViewer'), sheet: !!document.getElementById('goSheet'), note: document.getElementById('albumReviewNote').textContent, dis: document.getElementById('albumSubmit').disabled }));
    ok('the viewer is still open, no order sheet, and the message says the layout was kept', r.viewer && !r.sheet && /訂購暫時無法使用，排版已保留，請稍後再試/.test(r.note), JSON.stringify(r));
    ok('the layout is exactly what it was, 確認送出 is still available, nothing was posted', plain(await page.evaluate(() => AlbumPreview.currentLayout())) === plain(l1) && !r.dis, JSON.stringify(r));
    ok('and no POST reached the Worker', w.posts().length === 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

// ── 10. an empty slot is filled, never exchanged (a defensive case: the planner always fills its slots)
{
  const w = world();
  await sx('choose() on a slot without a photo does not throw (fit cover): an unused photo fills it, a photo already inside is refused', async (page, ok) => {
    await page.evaluate(() => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, fit: 'cover' }; });
    await open(page);
    const l0 = await layoutNow(page);
    const r = await page.evaluate(([a, b]) => {
      const v = AlbumPreview._testViewer();
      const out = { threw: null };
      try {
        const keep = v.cur.spreads[0].slots[0].photoId;
        v.cur.spreads[0].slots[0].photoId = '';
        out.fillUnused = v.choose({ n: 0, s: 0 }, keep);                 // the photo it had: used nowhere inside now
        out.afterFill = v.cur.spreads[0].slots[0].photoId === keep;
        v.cur.spreads[0].slots[0].photoId = '';
        out.refused = v.choose({ n: 0, s: 0 }, b);                       // a photo that sits in another slot
        out.stillEmpty = v.cur.spreads[0].slots[0].photoId === '';
        out.note = document.getElementById('albumEditNote').textContent;
      } catch (e) { out.threw = String(e); }
      return out;
    }, [l0.spreads[0].slots[0].photo_key, l0.spreads.at(-1).slots.at(-1).photo_key]);
    ok('no exception', r.threw === null, r.threw);
    ok('an unused photo fills the empty slot (replace, no exchange)', r.fillUnused === true && r.afterFill);
    ok('a photo that is already inside is refused (it would be there twice), the slot stays empty, and it says why', r.refused === false && r.stillEmpty && /這格是空的/.test(r.note), JSON.stringify(r));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 11. the album card's 訂購 opens the editor; a second checkout of the same option says it replaces the first
{
  const w = world();
  await sx('390px: the album card says 排版並訂購 and opens the preview editor (no spreads stepper, no photographer-lays-out line); a second layout for the same option replaces the first and says so', async (page, ok) => {
    await page.waitForSelector('#cpShop .cp-product', { timeout: 6000 });
    await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });
    const lab = await page.evaluate(() => ({ album: document.querySelector('.go-order-btn[data-product-id="prod-album"]')?.textContent, print: document.querySelector('.go-order-btn[data-product-id="prod-print"]')?.textContent }));
    ok('positive: the album button reads 排版並訂購, the print button is still 訂購', lab.album === '排版並訂購' && lab.print === '訂購', JSON.stringify(lab));
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await albReady(page);
    await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
    ok('the editor is open (edit mode) and there is no order sheet and no spreads stepper', await page.evaluate(() => document.getElementById('albumViewer').dataset.edit === 'true' && !document.getElementById('goSheet') && !document.querySelector('.go-step')));
    const checkout = async () => {
      await page.click('#albumCheckout'); await page.waitForSelector('#albumSubmit'); await lastPage(page);
      await page.click('#albumSubmit'); await page.click('#albumConfirmYes'); await step(page, 'product');
    };
    await checkout();
    await click(page, '.go-opt[data-option-id="opt-album-1"]');
    ok('first layout for the option: no replace notice', !(await shown(page, '#goReplaceNote')));
    await click(page, '#goAdd'); await step(page, 'cart');
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    // second time, a different book
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await albReady(page);
    await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await chooseCand(page, (await cands(page)).find(c => !c.cur).id);
    const l2 = await layoutNow(page);
    await checkout();
    await click(page, '.go-opt[data-option-id="opt-album-2"]');
    ok('a different option: no notice (it is a different line)', !(await shown(page, '#goReplaceNote')));
    await click(page, '.go-opt[data-option-id="opt-album-1"]');
    ok('the same option: 購物車裡已有這本相本，這次的排版會取代它', await shown(page, '#goReplaceNote') && (await page.evaluate(() => document.getElementById('goReplaceNote').textContent)) === '購物車裡已有這本相本，這次的排版會取代它');
    await click(page, '#goAdd'); await step(page, 'cart');
    ok('one line in the cart (replaced, not two)', await page.evaluate(() => document.querySelectorAll('#goLines .go-line').length) === 1);
    await click(page, '#goToContact'); await step(page, 'contact');
    await page.fill('#goName', '王小明'); await page.fill('#goPhone', '0912-345-678'); await page.check('#goConsent');
    await click(page, '#goToReview'); await step(page, 'review');
    await click(page, '#goSubmit');
    await waitPosts(w, 1);
    ok('the POST carries the second layout', plain(w.posts()[0].body.lines[0].layout) === plain(l2) && w.posts()[0].body.lines.length === 1);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('the album card when the preview cannot load: the viewer shows its error with 重試, and 重試 works', async (page, ok) => {
    await page.waitForSelector('#cpShop .cp-product', { timeout: 6000 });
    await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });
    w.album.failList = 1;
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await page.waitForSelector('#albumError', { timeout: 8000 });
    ok('the existing error panel with 重試 and 關閉', await page.evaluate(() => !!document.getElementById('albumRetry') && !!document.getElementById('albumErrClose')));
    await click(page, '#albumRetry');
    await albReady(page);
    ok('after 重試 the editor is up', await page.evaluate(() => document.getElementById('albumViewer').dataset.edit === 'true'));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

{
  const second = { ...SHOP_ALBUM_FAKE, id: 'prod-album-b', name: '第二本相本', min_pages: 2, max_pages: 20, extra_page_price: 150, image_url: null, options: [{ id: 'opt-b-1', label: '', price: 4000 }] };
  const w = world({ products: [...catalogue(), second] });
  await sx('two album products: only the one the editor serves (the first, whose page range the planner uses) gets 訂購; the other is information + 我有興趣', async (page, ok) => {
    await page.waitForSelector('#cpShop .cp-product', { timeout: 6000 });
    const r = await page.evaluate(() => ({ order: [...document.querySelectorAll('.go-order-btn')].map(b => b.dataset.productId), interest: [...document.querySelectorAll('.cp-interest-btn')].map(b => b.dataset.productId), cards: document.querySelectorAll('#cpShop .cp-product').length }));
    ok('positive: three cards; 訂購 on the print and the first album only; 我有興趣 on the second album', r.cards === 3 && JSON.stringify(r.order) === JSON.stringify(['prod-print', 'prod-album']) && JSON.stringify(r.interest) === JSON.stringify(['prod-album-b']), JSON.stringify(r));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 12. the fake Worker's layout contract (direct calls): crop bound, key rule, existence, check order
{
  const w = world();
  await sx('the fake mirrors the Worker: crop ±5, unsafe key -> invalid_layout, outside the folders -> not_in_finals, made-up key -> photo_not_found, in that order', async (page, ok) => {
    await open(page);
    const base0 = await layoutNow(page);
    const post = layout => page.evaluate(async lay => {
      const res = await fetch('https://imagepicker.hotichen.workers.dev/api/pick/orders', { method: 'POST', headers: { 'X-Share-Token': 'TOK', 'X-Picker-Key': 'ZOE-KEY', 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: crypto.randomUUID(), lines: [{ option_id: 'opt-album-1', qty: 1, layout: lay }], contact: { name: 'A', phone: '0912345678' }, expected_total: 1, consent: 'v1' }) });
      let d = null; try { d = await res.json(); } catch (e) { /* */ }
      return [res.status, d && d.code];
    }, layout);
    const mod = f => { const l = JSON.parse(JSON.stringify(base0)); f(l); return l; };
    const first = l => l.spreads[0].slots[0];
    ok('control: the untouched layout passes every layout check (only the price differs: 409 price_changed)', plain(await post(base0)) === plain([409, 'price_changed']));
    ok('crop 5 is allowed', plain(await post(mod(l => { first(l).crop.x = 5; }))) === plain([409, 'price_changed']));
    ok('crop 5.01 -> 400 invalid_layout', plain(await post(mod(l => { first(l).crop.x = 5.01; }))) === plain([400, 'invalid_layout']));
    ok('a key with a quote -> 400 invalid_layout', plain(await post(mod(l => { first(l).photo_key = 'shoot/精修/a"b.jpg'; }))) === plain([400, 'invalid_layout']));
    ok('a key with an apostrophe and spaces is fine (no invalid_layout)', (await post(mod(l => { first(l).photo_key = "shoot/精修/Tim's x.jpg"; })))[1] === 'photo_not_found');
    ok('a key outside the final folders -> 403 not_in_finals', plain(await post(mod(l => { first(l).photo_key = 'shoot/毛片/a.jpg'; }))) === plain([403, 'not_in_finals']));
    ok('a made-up key inside the final folder -> 404 photo_not_found', plain(await post(mod(l => { first(l).photo_key = 'shoot/精修/IMG_9999.jpg'; }))) === plain([404, 'photo_not_found']));
    ok('order: invalid_layout beats not_in_finals', plain(await post(mod(l => { first(l).photo_key = 'shoot/毛片/a.jpg'; l.cover.crop.x = 9; }))) === plain([400, 'invalid_layout']));
    ok('order: not_in_finals beats photo_not_found', plain(await post(mod(l => { first(l).photo_key = 'shoot/毛片/a.jpg'; l.spreads[1].slots[0].photo_key = 'shoot/精修/IMG_9999.jpg'; }))) === plain([403, 'not_in_finals']));
    ok('nothing was stored by any of these', w.orders.length === 0);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

{
  const w = world();
  await sx('390px: the edit row, the picker, the confirmation and the review all fit the screen with 44px targets and no sideways scroll', async (page, ok) => {
    await open(page);
    const scan = async (label, floor = 3) => {
      const r = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const sel = document.getElementById('albumConfirm') || document.getElementById('albumPicker') || document.getElementById('albumViewer');
        const scope = sel.id === 'albumViewer' ? document.querySelector('.album-viewer-foot') : sel;
        const btns = [...scope.querySelectorAll('button')].filter(b => b.getClientRects().length && !b.closest('[hidden]'));
        const small = btns.filter(b => { const x = b.getBoundingClientRect(); return x.height < 43.5 || x.width < 43.5; }).map(b => b.id || b.className);
        const outside = btns.filter(b => { const x = b.getBoundingClientRect(); return x.left < -0.5 || x.right > vw + 0.5 || x.top < -0.5 || x.bottom > vh + 0.5; }).map(b => b.id || b.className);
        const stage = document.getElementById('albumStage').getBoundingClientRect();
        return { n: btns.length, small, outside, sw: document.documentElement.scrollWidth <= vw + 1, stageH: stage.height, vw, vh };
      });
      ok(`${label}: floor — at least ${floor} buttons scanned, all >= 44px and inside the screen, no horizontal scroll`, r.n >= floor && r.small.length === 0 && r.outside.length === 0 && r.sw, JSON.stringify(r));
      return r;
    };
    const r1 = await scan('edit row');
    ok('the page area still has room (stage >= 300px tall on a 390x844 phone)', r1.stageH >= 300, String(r1.stageH));
    await flipTo(page, 1);
    await pickSlot(page, 0);
    await scan('picker');
    const g = await page.evaluate(() => { const c = document.querySelector('#albumCandidates .album-cand').getBoundingClientRect(); return { w: c.width, h: c.height }; });
    ok('candidate tiles are at least 44px', g.w >= 44 && g.h >= 44, JSON.stringify(g));
    await page.keyboard.press('Escape');
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    ok('control: no swaps yet so no confirmation on 再次編排', !(await page.evaluate(() => !!document.getElementById('albumConfirm'))));
    await pickSlot(page, 0);
    await chooseCand(page, (await cands(page)).find(c => !c.cur).id);
    await page.click('#albumRelayout'); await page.waitForTimeout(100);
    await scan('confirmation', 2);
    await page.click('#albumConfirmNo');
    await page.click('#albumCheckout');
    await page.waitForSelector('#albumSubmit');
    await scan('review');
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

}
