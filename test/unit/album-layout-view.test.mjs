// Node tests for js/album-layout-view.js: the pure part (Layout JSON v2 -> pages with geometry and file names).
// Run: node --test test/unit/album-layout-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../../book_editor/js/spread_templates.js');
const V = require('../../js/album-layout-view.js');

const crop0 = { x: 0, y: 0, scale: 1 };
const s = (k, fit = 'contain', crop = crop0) => ({ photo_key: k, fit, crop });
const tpl = id => T.byId(id);
const layoutOf = (spreads, over = {}) => ({ v: 2, mode: 'auto', cover: s('d/COVER.jpg', 'cover'), spreads, back: null, ...over });

test('isV2 / spreadCount: v 2 object is a v2, v1 and junk are not; the count is the array length or null', () => {
  assert.equal(V.isV2(layoutOf([])), true);
  assert.equal(V.isV2({ v: 2, spreads: 'x' }), true);
  assert.equal(V.isV2({ v: 1, mode: 'photographer', spreads: 12 }), false);
  assert.equal(V.isV2(null), false);
  assert.equal(V.isV2('x'), false);
  assert.equal(V.isV2([]), false);
  assert.equal(V.spreadCount({ v: 2, spreads: 'x' }), null);
  assert.equal(V.spreadCount(layoutOf([{ template: 'pair-portraits', slots: [s('a'), s('b')] }, { template: 'solo-right', slots: [s('c')] }])), 2);
});

test('pagesOf: cover first, then each spread, labels and file names in reading order', () => {
  const r = V.pagesOf(layoutOf([
    { template: 'pair-portraits', slots: [s('d/IMG_002.jpg'), s('d/IMG_003.jpg')] },
    { template: 'solo-right', slots: [s('d/sub/IMG_004.jpg')] },
  ]), T);
  assert.equal(r.pages.length, 3);
  assert.deepEqual(r.pages.map(p => p.label), ['封面', '第1跨頁', '第2跨頁']);
  assert.deepEqual(r.pages.map(p => p.kind), ['cover', 'spread', 'spread']);
  assert.deepEqual(r.pages[0].names, ['COVER.jpg']);
  assert.deepEqual(r.pages[1].names, ['IMG_002.jpg', 'IMG_003.jpg']);
  assert.deepEqual(r.pages[2].names, ['IMG_004.jpg']);
  assert.equal(r.pages.every(p => p.ok), true);
  assert.deepEqual(r.pages[0].slots[0], { key: 'd/COVER.jpg', x: 0, y: 0, w: 1, h: 1, fit: 'cover', crop: crop0 });
});

test('pagesOf: slot geometry is the template\'s, in template slot order', () => {
  const t = tpl('pair-portraits');
  const r = V.pagesOf(layoutOf([{ template: 'pair-portraits', slots: [s('a.jpg'), s('b.jpg')] }], { cover: null }), T);
  const p = r.pages[0];
  assert.equal(p.slots.length, 2);
  p.slots.forEach((sl, i) => { assert.equal(sl.x, t.slots[i].x); assert.equal(sl.y, t.slots[i].y); assert.equal(sl.w, t.slots[i].w); assert.equal(sl.h, t.slots[i].h); });
  assert.deepEqual(p.slots.map(x => x.key), ['a.jpg', 'b.jpg']);
});

test('pagesOf: mirrored flips x -> 1-x-w, y/w/h kept, and the left photo is now on the right', () => {
  for (const id of ['pair-portraits', 'one-two-right', 'hero-strip']) {
    const t = tpl(id);
    const keys = t.slots.map((_, i) => `k${i}.jpg`);
    const mir = V.pagesOf(layoutOf([{ template: id, mirrored: true, slots: keys.map(k => s(k)) }], { cover: null }), T).pages[0];
    mir.slots.forEach((m, i) => {
      assert.ok(Math.abs(m.x - (1 - t.slots[i].x - t.slots[i].w)) < 1e-9, `${id} slot ${i} x`);
      assert.equal(m.y, t.slots[i].y); assert.equal(m.w, t.slots[i].w); assert.equal(m.h, t.slots[i].h);
      assert.equal(m.key, keys[i]);
    });
  }
  // the asymmetric template really moves (positive control: mirrored differs from plain)
  const a = V.pagesOf(layoutOf([{ template: 'one-two-right', slots: [s('a'), s('b'), s('c')] }], { cover: null }), T).pages[0].slots[0].x;
  const b = V.pagesOf(layoutOf([{ template: 'one-two-right', mirrored: true, slots: [s('a'), s('b'), s('c')] }], { cover: null }), T).pages[0].slots[0].x;
  assert.ok(b > a + 0.3, `${a} -> ${b}`);
  // a non-true mirrored value is not a mirror
  const c = V.pagesOf(layoutOf([{ template: 'one-two-right', mirrored: 'yes', slots: [s('a'), s('b'), s('c')] }], { cover: null }), T).pages[0].slots[0].x;
  assert.equal(c, a);
});

test('pagesOf: fit is contain only when exactly contain; crop is sanitised, scale defaults to 1', () => {
  const r = V.pagesOf(layoutOf([{ template: 'pair-portraits', slots: [
    { photo_key: 'a', fit: 'contain', crop: { x: 0.25, y: -0.5, scale: 1 } },
    { photo_key: 'b', fit: 'bogus', crop: { x: 'x', y: Infinity, scale: -3 } }] }], { cover: null }), T).pages[0];
  assert.equal(r.slots[0].fit, 'contain');
  assert.deepEqual(r.slots[0].crop, { x: 0.25, y: -0.5, scale: 1 });
  assert.equal(r.slots[1].fit, 'cover');
  assert.deepEqual(r.slots[1].crop, { x: 0, y: 0, scale: 1 });
});

test('pagesOf: unknown template / wrong slot count -> page not ok, but its readable names are still listed', () => {
  const r = V.pagesOf(layoutOf([
    { template: 'no-such-template', slots: [s('d/A.jpg'), s('d/B.jpg')] },
    { template: 'pair-portraits', slots: [s('d/C.jpg')] },
    { template: '__proto__', slots: [s('d/D.jpg')] },
    { template: 'solo-right', slots: [s('d/E.jpg')] },
  ]), T);
  assert.deepEqual(r.pages.map(p => p.ok), [true, false, false, false, true]);
  assert.deepEqual(r.pages[1].names, ['A.jpg', 'B.jpg']);
  assert.deepEqual(r.pages[2].names, ['C.jpg']);
  assert.deepEqual(r.pages[3].names, ['D.jpg']);
  assert.deepEqual(r.pages[1].slots, []);
  assert.equal(r.pages[4].ok, true);
});

test('pagesOf: malformed layouts never throw', () => {
  const bad = [null, undefined, 5, 'x', [], {}, { v: 2 }, { v: 2, spreads: null }, { v: 2, spreads: 'x' }, { v: 2, spreads: [null, 5, 'x', [], {}, { template: 5, slots: 'x' }, { template: 'solo-right' }, { template: 'solo-right', slots: [null] }, { template: 'solo-right', slots: [{}] }, { template: 'solo-right', slots: [{ photo_key: 5 }] }] },
    { v: 2, cover: 5, spreads: [] }, { v: 2, cover: { photo_key: {} }, spreads: [] }, { v: 2, spreads: [], back: 'x' }];
  for (const l of bad) {
    assert.doesNotThrow(() => V.pagesOf(l, T), JSON.stringify(l));
    assert.doesNotThrow(() => V.listText(V.pagesOf(l, T).pages), JSON.stringify(l));
  }
  assert.equal(V.pagesOf(null, T).unreadable, true);
  assert.equal(V.pagesOf({ v: 2, spreads: 'x' }, T).unreadable, true);
  assert.equal(V.pagesOf(layoutOf([]), T).unreadable, false);
  // templates missing entirely (the library failed to load) -> every spread is not ok, names kept
  const r = V.pagesOf(layoutOf([{ template: 'solo-right', slots: [s('d/Z.jpg')] }]), null);
  assert.deepEqual(r.pages.map(p => p.ok), [true, false]);
  assert.deepEqual(r.pages[1].names, ['Z.jpg']);
});

test('pagesOf: a back cover shows as a blank page; a cover that is null is skipped; spreads are capped', () => {
  const r = V.pagesOf(layoutOf([{ template: 'solo-right', slots: [s('a.jpg')] }], { cover: null, back: {} }), T);
  assert.deepEqual(r.pages.map(p => p.label), ['第1跨頁', '封底']);
  assert.deepEqual(r.pages[1].slots, []);
  const many = Array.from({ length: 1000 }, () => ({ template: 'solo-right', slots: [s('a.jpg')] }));
  assert.ok(V.pagesOf(layoutOf(many), T).pages.length <= V.MAX_SPREADS + 2);
});

test('baseName and listText: the print-shop line', () => {
  assert.equal(V.baseName('a/b/IMG_1.jpg'), 'IMG_1.jpg');
  assert.equal(V.baseName('IMG_1.jpg'), 'IMG_1.jpg');
  const r = V.pagesOf(layoutOf([
    { template: 'pair-portraits', slots: [s('d/IMG_002.jpg'), s('d/IMG_003.jpg')] },
    { template: 'solo-right', slots: [s('d/IMG_004.jpg')] },
  ]), T);
  assert.equal(V.listText(r.pages), '封面: COVER.jpg / 第1跨頁: IMG_002.jpg, IMG_003.jpg / 第2跨頁: IMG_004.jpg');
  assert.equal(V.listText([]), '');
});

test('drawBox: cover fills the slot like fitCoverImage, contain keeps the whole photo like containBox', () => {
  // 3:2 photo in a 100x100 slot
  const c = V.drawBox('cover', 300, 200, 100, 100, { x: 0, y: 0, scale: 1 });
  assert.ok(Math.abs(c.h - 100) < 1e-9 && Math.abs(c.w - 150) < 1e-9 && Math.abs(c.left - -25) < 1e-9 && Math.abs(c.top) < 1e-9);
  const k = V.drawBox('contain', 300, 200, 100, 100, { x: 0, y: 0, scale: 1 });
  assert.ok(Math.abs(k.w - 100) < 1e-9 && Math.abs(k.h - 200 / 3) < 1e-9 && Math.abs(k.left) < 1e-9 && Math.abs(k.top - (100 - 200 / 3) / 2) < 1e-9);
  const off = V.drawBox('cover', 300, 200, 100, 100, { x: 0.1, y: -0.2, scale: 1 });
  assert.ok(Math.abs(off.left - (-25 + 10)) < 1e-9 && Math.abs(off.top - -20) < 1e-9);
  const z = V.drawBox('cover', 0, 0, 100, 100, crop0);
  assert.deepEqual(z, { left: 0, top: 0, w: 100, h: 100 });
});

test('imageUrl: thumbnail only (w=1200), encoded per segment, token in t=, never an original', () => {
  const u = V.imageUrl('https://w.example', 'dir/a b#c?d.jpg', 'TOK');
  assert.equal(u, 'https://w.example/dir/a%20b%23c%3Fd.jpg?w=1200&t=TOK');
  assert.ok(!/download/.test(u));
  assert.equal(V.imageUrl('https://w.example', 'a.jpg', ''), 'https://w.example/a.jpg?w=1200');
  assert.equal(V.imageUrl('https://w.example', '', 't'), '');
});

// ── background (docs/guest-shop.md "S3 第一步"): the table is ImportLayout.BACKGROUND_COLORS, the one copy ──
const IL = require('../../book_editor/js/import_layout.js');
const COLORS = IL.BACKGROUND_COLORS;
const NINE = { white: '#ffffff', cream: '#fff8ee', butter: '#fff4cc', blush: '#fde8ec', peach: '#ffe5d4', mint: '#e3f4e8', sky: '#e1effb', lavender: '#eee8fa', gray: '#eeeeee' };
const NAMES = { white: '白', cream: '奶油', butter: '奶黃', blush: '粉', peach: '蜜桃', mint: '薄荷', sky: '天空', lavender: '薰衣草', gray: '灰' };
const withBg = bg => layoutOf([{ template: 'pair-portraits', slots: [s('a.jpg'), s('b.jpg')] }], { background: bg, back: {} });

test('background: each of the nine ids colours the cover, the spread and the back (floor: all nine)', () => {
  assert.deepEqual({ ...COLORS }, NINE);
  let n = 0;
  for (const [id, hex] of Object.entries(NINE)) {
    const r = V.pagesOf(withBg({ type: 'color', value: id }), T, COLORS);
    assert.deepEqual(r.pages.map(p => p.kind), ['cover', 'spread', 'back']);
    assert.deepEqual(r.pages.map(p => p.bg), [hex, hex, hex], id);
    assert.deepEqual(r.background, { id, name: NAMES[id], hex }, id);
    n++;
  }
  assert.equal(n, 9);
});

test('background: none / null / no table -> white and no label; garbage never throws and is white', () => {
  const white = r => r.pages.every(p => p.bg === '#ffffff') && r.pages.length === 3;
  for (const bg of [undefined, null]) { const r = V.pagesOf(withBg(bg), T, COLORS); assert.ok(white(r)); assert.equal(r.background, null); }
  assert.ok(white(V.pagesOf(withBg({ type: 'color', value: 'cream' }), T)));          // table unavailable
  assert.equal(V.pagesOf(withBg({ type: 'color', value: 'cream' }), T).background, null);
  const hostile = [{ type: 'image', value: 'cream' }, { type: 'image', url: 'x' }, { type: 'color', value: 'red' }, { type: 'color', value: '#ff0000' },
    { type: 'color', value: 'url(javascript:1)' }, { type: 'color', value: '__proto__' }, { type: 'color', value: 'constructor' }, { type: 'color', value: 'toString' },
    { type: 'color', value: ['cream'] }, { type: 'color', value: { toString: 'cream' } }, { type: 'color' }, { type: 'colour', value: 'cream' }, 'cream', 7, [], true, { value: 'cream' }];
  for (const bg of hostile) {
    const r = V.pagesOf(withBg(bg), T, COLORS);
    assert.ok(white(r), JSON.stringify(bg));
    assert.equal(r.background, null, JSON.stringify(bg));
  }
  assert.equal(hostile.length, 17);
});

test('background: a table that is itself garbage (hex not #rrggbb) is white', () => {
  const r = V.pagesOf(withBg({ type: 'color', value: 'cream' }), T, { cream: 'red; background:url(x)' });
  assert.ok(r.pages.every(p => p.bg === '#ffffff'));
  assert.equal(r.background, null);
});
