// Node tests for book_editor/js/import_layout.js: a guest's Layout JSON v2 -> an editable book.
// Run: node --test test/unit/import-layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import worker from '../../worker/worker.js';
import { fakeBucket, fakeDB, ctx, req } from '../../worker/test/fakes.mjs';
const require = createRequire(import.meta.url);
const T = require('../../book_editor/js/spread_templates.js');
const I = require('../../book_editor/js/import_layout.js');

const sl = (k, fit = 'cover', crop = { x: 0, y: 0, scale: 1 }) => ({ photo_key: k, fit, crop });
const fill = (id, tag = 'p') => T.byId(id).slots.map((_, i) => sl(`d/${tag}-${id}-${i}.jpg`, i % 2 ? 'contain' : 'cover', { x: 0.1 * i, y: i ? -0.05 * i : 0, scale: 1 }));
const sp = (id, mirrored) => ({ template: id, ...(mirrored ? { mirrored: true } : {}), slots: fill(id) });
const layout = (spreads, over = {}) => ({ v: 2, mode: 'auto', cover: sl('d/COVER.jpg'), spreads, back: {}, ...over });
const conv = (l, o = {}) => I.layoutToBook(l, { name: 'N', now: 1000, templates: T, ...o });

// the Worker's own verdict on a PUT of this book
const SECRET = 'sec';
async function workerPut(book) {
  const env = { imagepicker: fakeBucket(), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
  const r = await worker.fetch(req('/api/books/bk1', { method: 'PUT', token: SECRET, body: JSON.stringify(book) }), env, ctx);
  return { status: r.status, body: await r.json(), stored: env.imagepicker._store.get('_books/bk1.json')?.body };
}

const IDS = ['hero-bleed', 'hero-strip', 'pair-portraits', 'pair-bleed-small', 'solo-right', 'solo-left', 'pair-stagger', 'one-two-right'];

test('every template slot rectangle (x,y,w,h x100) lands in the custom layout, mirrored where set', () => {
  for (const mirrored of [false, true]) {
    const all = T.TEMPLATES.map(t => ({ template: t.id, ...(mirrored ? { mirrored: true } : {}), slots: fill(t.id) }));
    const b = conv(layout(all));
    assert.equal(b.pages.filter(p => p.type === 'inner').length, T.TEMPLATES.length);
    for (const p of b.pages.filter(p => p.type === 'inner')) {
      const t = T.byId(p.layout.replace(/^custom-/, '').replace(/-m$/, ''));
      assert.ok(t, p.layout);
      assert.equal(p.layout.endsWith('-m'), mirrored);
      const lay = b._customLayouts[p.layout];
      assert.equal(lay.slots.length, t.slots.length);
      t.slots.forEach((g, j) => {
        const x = mirrored ? 1 - g.x - g.w : g.x;
        for (const [k, v] of [['x', x], ['y', g.y], ['w', g.w], ['h', g.h]]) assert.ok(Math.abs(lay.slots[j][k] - v * 100) < 1e-6, `${t.id}[${j}].${k} ${lay.slots[j][k]} vs ${v * 100}`);
      });
    }
  }
});

test('span / hero templates stay one wide slot; hero-strip keeps its 4 slots', () => {
  const b = conv(layout([sp('hero-bleed'), sp('hero-strip')]));
  const [a, s] = b.pages.filter(p => p.type === 'inner');
  assert.deepEqual(b._customLayouts[a.layout].slots, [{ x: 0, y: 0, w: 100, h: 100 }]);
  assert.equal(a.slots.length, 1);
  assert.equal(s.slots.length, 4);
  assert.equal(b._customLayouts[s.layout].slots.length, 4);
});

test('photo ids, fit and crop are carried slot by slot, in template order', () => {
  const l = layout([sp('pair-portraits'), sp('one-two-right', true)]);
  const b = conv(l);
  const inner = b.pages.filter(p => p.type === 'inner');
  inner.forEach((p, i) => {
    const src = l.spreads[i].slots;
    assert.equal(p.slots.length, src.length);
    src.forEach((s, j) => {
      assert.equal(p.slots[j].photoId, s.photo_key);
      assert.equal(p.slots[j].fit, s.fit);
      assert.deepEqual(p.slots[j].crop, s.crop);
    });
  });
  assert.ok(inner[0].slots.some(s => s.fit === 'contain') && inner[0].slots.some(s => s.fit === 'cover'));
});

test('page order and shape: cover, inner x N, back-cover; settings, locked, ids unique', () => {
  const b = conv(layout([sp('pair-portraits'), sp('solo-right', true), sp('pair-portraits')]), { bleedMm: 2.5 });
  assert.deepEqual(b.pages.map(p => p.type), ['cover', 'inner', 'inner', 'inner', 'back-cover']);
  assert.equal(b.pages[0].layout, 'full-bleed');
  assert.equal(b.pages[0].slots[0].photoId, 'd/COVER.jpg');
  assert.equal(b.pages[4].layout, 'blank');
  assert.deepEqual(b.pages[4].slots, []);
  assert.deepEqual(b.settings, { width: 42, height: 29.7, unit: 'cm', dpi: 300, bleed: 2.5, pagesPerSheet: 2 });
  assert.deepEqual(b.coverSettings, { width: 21, height: 29.7, unit: 'cm', dpi: 300 });
  assert.equal(new Set(b.pages.map(p => p.id)).size, b.pages.length);
  assert.ok(b.pages.every(p => p.locked === false));
  assert.deepEqual(b.clientFolders, []);
  assert.equal(b.notifyUrl, '');
  assert.equal(b.name, 'N');
  // two spreads on the same template share one embedded layout; the mirrored one is a different one
  assert.deepEqual(Object.keys(b._customLayouts).sort(), ['custom-pair-portraits', 'custom-solo-right-m']);
  assert.equal(conv(layout([sp('solo-right')])).settings.bleed, 3);
});

test('back: null / absent -> no back page; {} -> one. cover null -> an empty cover page', () => {
  assert.deepEqual(conv(layout([sp('solo-right')], { back: null })).pages.map(p => p.type), ['cover', 'inner']);
  const noBack = layout([sp('solo-right')]); delete noBack.back;
  assert.deepEqual(conv(noBack).pages.map(p => p.type), ['cover', 'inner']);
  const b = conv(layout([sp('solo-right')], { cover: null }));
  assert.equal(b.pages[0].type, 'cover');
  assert.equal(b.pages[0].slots.length, 1);
  assert.equal(b.pages[0].slots[0].photoId, null);
});

test('the Worker accepts the book as a PUT, byte for byte', async () => {
  const b = conv(layout(IDS.map((id, i) => sp(id, i % 2 === 1))));
  const r = await workerPut(b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(JSON.parse(r.stored), b);
});

test('crops are clamped into the guest range and the Worker still accepts; scale 1', async () => {
  const l = layout([{ template: 'solo-right', slots: [sl('d/a.jpg', 'cover', { x: 99, y: -99, scale: 1 })] }]);
  const b = conv(l);
  assert.deepEqual(b.pages[1].slots[0].crop, { x: 5, y: -5, scale: 1 });
  assert.equal((await workerPut(b)).status, 200);
  const odd = conv(layout([{ template: 'solo-right', slots: [{ photo_key: 'd/a.jpg', fit: 'cover' }] }]));
  assert.deepEqual(odd.pages[1].slots[0].crop, { x: 0, y: 0, scale: 1 });
});

test('the key rule is the Worker\'s: same verdicts as bookPhotoIdSafe, and the Worker agrees', async () => {
  const keys = ['d/ok.jpg', "d/Tim's pick (1) &#%+.jpg", 'd/中文 檔名.jpg', 'd/a"b.jpg', 'd/<b>.jpg', 'd/a`b.jpg', 'd/a\\b.jpg', 'd/a\nb.jpg', 'd/‮b.jpg', 'd/﻿.jpg', 'd/\ud800.jpg', 'd/' + 'x'.repeat(1030), ''];
  for (const k of keys) {
    const l = layout([{ template: 'solo-right', slots: [sl(k)] }]);
    const ours = I.keySafe(k);
    if (ours) {
      assert.equal((await workerPut(conv(l))).status, 200, k);
    } else {
      assert.throws(() => conv(l), /照片路徑/, JSON.stringify(k));
      // and the Worker would have refused the same key if it had got through
      const raw = { pages: [{ type: 'inner', layout: 'blank', slots: [{ photoId: k, crop: { x: 0, y: 0, scale: 1 } }] }] };
      if (k !== '') assert.equal((await workerPut(raw)).status, 400, JSON.stringify(k));
    }
  }
});

test('malformed layouts throw a clear Error, never a half book', () => {
  const bad = [
    [null, /不是客人排的版面/], ['x', /不是客人排的版面/], [{ v: 1, spreads: 3 }, /不是客人排的版面/], [[], /不是客人排的版面/],
    [{ v: 2, spreads: 'no' }, /跨頁清單/], [{ v: 2, spreads: [] }, /沒有任何跨頁/],
    [layout([{ template: 'nope', slots: [sl('a')] }]), /版型不認得/],
    [layout([{ template: '__proto__', slots: [sl('a')] }]), /版型不認得/],
    [layout([{ template: 'pair-portraits', slots: [sl('a')] }]), /照片數和版型不符/],
    [layout([{ template: 'solo-right', slots: [sl('a'), sl('b')] }]), /照片數和版型不符/],
    [layout([{ template: 'solo-right', slots: 'x' }]), /照片數和版型不符/],
    [layout([null]), /沒有版型/], [layout([{ slots: [] }]), /沒有版型/],
    [layout([{ template: 'solo-right', slots: [{ photo_key: 'a', fit: 'fill' }] }]), /填滿方式/],
    [layout([{ template: 'solo-right', slots: [{ photo_key: 3, fit: 'cover' }] }]), /照片路徑/],
    [layout([{ template: 'solo-right', slots: [null] }]), /內容不正確/],
    [layout([{ template: 'solo-right', slots: [sl('a', 'cover', { x: 'a', y: 0, scale: 1 })] }]), /裁切/],
    [layout([{ template: 'solo-right', slots: [sl('a', 'cover', { x: NaN, y: 0, scale: 1 })] }]), /裁切/],
    [layout([{ template: 'solo-right', mirrored: 'yes', slots: [sl('a')] }]), /鏡像/],
    [layout([sp('solo-right')], { cover: { photo_key: 'a"b', fit: 'cover' } }), /封面/],
    [layout(Array.from({ length: 201 }, () => sp('solo-right'))), /過多/],
  ];
  for (const [l, re] of bad) assert.throws(() => conv(l), re, JSON.stringify(l)?.slice(0, 80));
  assert.throws(() => I.layoutToBook(layout([sp('solo-right')]), { name: 'x', templates: {} }), /版型資料庫/);
});

test('the name: guest text is cleaned, truncated, defaulted', () => {
  assert.equal(conv(layout([sp('solo-right')]), { name: '' }).name, '客人排版匯入');
  assert.equal(conv(layout([sp('solo-right')]), { name: undefined }).name, '客人排版匯入');
  assert.equal(conv(layout([sp('solo-right')]), { name: 'a<b>"c‮` d' }).name, 'abc d');
  assert.equal(Array.from(conv(layout([sp('solo-right')]), { name: '長'.repeat(100) }).name).length, 60);
  // the embedded layout names are fixed labels from the template library
  const b = conv(layout([sp('solo-right', true)]), { name: '<script>' });
  assert.match(b._customLayouts['custom-solo-right-m'].name, /^客人排版・.+（鏡像）$/);
});

// ── background (docs/guest-shop.md "S3 第一步"): bg on EVERY page; absent -> byte-identical to before ──
const NINE_BG = { white: '#ffffff', cream: '#fff8ee', butter: '#fff4cc', blush: '#fde8ec', peach: '#ffe5d4', mint: '#e3f4e8', sky: '#e1effb', lavender: '#eee8fa', gray: '#eeeeee' };

test('BACKGROUND_COLORS: the nine ids, frozen', () => {
  assert.deepEqual({ ...I.BACKGROUND_COLORS }, NINE_BG);
  assert.ok(Object.isFrozen(I.BACKGROUND_COLORS));
});

test('background: every page (cover, inner, back-cover) gets bg = the hex, for all nine ids; the Worker still accepts', async () => {
  let n = 0;
  for (const [id, hex] of Object.entries(NINE_BG)) {
    const b = conv(layout([sp('pair-portraits'), sp('solo-right', true)], { back: {}, background: { type: 'color', value: id } }));
    assert.deepEqual(b.pages.map(p => p.type), ['cover', 'inner', 'inner', 'back-cover']);
    assert.deepEqual(b.pages.map(p => p.bg), [hex, hex, hex, hex], id);
    assert.equal((await workerPut(b)).status, 200, id);
    n++;
  }
  assert.equal(n, 9);
});

test('background: absent / null gives the output byte for byte as without the field', () => {
  const base = layout([sp('pair-portraits'), sp('solo-right', true)], { back: {} });
  const plain = JSON.stringify(conv(base));
  assert.ok(conv(base).pages.every(p => p.bg === '#ffffff'));
  assert.equal(JSON.stringify(conv({ ...base, background: null })), plain);
  assert.equal(JSON.stringify(conv({ ...base, background: undefined })), plain);
});

test('background: invalid values are ignored (white), never an error, never copied into the book', () => {
  const base = layout([sp('solo-right')], { back: {} });
  const plain = JSON.stringify(conv(base));
  const bad = [{ type: 'image', value: 'cream' }, { type: 'color', value: 'red' }, { type: 'color', value: '#ff0000' }, { type: 'color', value: 'url(x)' },
    { type: 'color', value: '__proto__' }, { type: 'color', value: 'toString' }, { type: 'color', value: ['cream'] }, { type: 'color' }, { type: 'x', value: 'cream' }, 'cream', 5, [], true];
  for (const background of bad) {
    const out = JSON.stringify(conv({ ...base, background }));
    assert.equal(out, plain, JSON.stringify(background));
  }
  assert.equal(bad.length, 13);
  assert.equal(I.backgroundHex({ type: 'color', value: 'mint' }), '#e3f4e8');
  assert.equal(I.backgroundHex({ type: 'color', value: 'nope' }), null);
});
