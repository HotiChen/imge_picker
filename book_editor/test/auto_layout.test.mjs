// node --test book_editor/test/auto_layout.test.mjs
//
// AutoLayout.analyze (I/O, injected) and AutoLayout.plan (pure) plus the old
// AutoLayout.run, which must keep producing exactly what the editor got before.
// layouts.js + auto_layout.js are loaded the way a page loads them: plain
// scripts, in that order, no bundler, no module system, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLegacy, photosOf, withFakeBrowser, lcg } from './legacy-fixture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');

// ── load like a page ────────────────────────────────────────────────────────
// Fresh contexts first: loading must not throw without a DOM and must add
// exactly the globals we say it adds.
const probe = vm.createContext({});
vm.runInContext(read('layouts.js'), probe, { filename: 'layouts.js' });
const layoutsGlobals = Object.keys(probe).sort();
const probe2 = vm.createContext({});
vm.runInContext(read('auto_layout.js'), probe2, { filename: 'auto_layout.js' });
const autoGlobals = Object.keys(probe2).sort();
const autoDefined = vm.runInContext('typeof AutoLayout', probe2);

vm.runInThisContext(read('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(read('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
const LAYOUTS = vm.runInThisContext('LAYOUTS');
const U = AutoLayout.util;

// ── helpers ─────────────────────────────────────────────────────────────────
const HEX = '0123456789abcdef';
const flip = (hex, bits) => {   // flips the first `bits` bits
  const out = hex.split('');
  for (let b = 0; b < bits; b++) {
    const i = Math.floor(b / 4);
    out[i] = HEX[parseInt(out[i], 16) ^ (1 << (b % 4))];
  }
  return out.join('');
};
const H0 = '0123456789abcdef';
const hashOf = n => {           // distinct, far-apart hashes (>= 20 bits apart)
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
let seq = 0;
const item = (id, o = {}) => {
  const aspect = o.aspect ?? 1.5;
  return {
    id, ok: o.ok ?? true, aspect, orientation: o.orientation ?? orientationOf(aspect),
    hash: o.hash ?? hashOf(seq++), sharpness: o.sharp ?? 50, focus: o.focus ?? { x: 0.5, y: 0.5 },
  };
};
const pad = n => String(n).padStart(3, '0');
const photoIdsOf = plan => plan.pages.flatMap(p => p.slots.map(s => s.photoId));
const hero = p => p.layout === 'full-bleed';

// crop geometry via the real fitCoverImage (what the editor, viewer and exporter share)
function geometry(photoAspect, slotAspect, crop) {
  const slotW = Math.round(slotAspect * 100000), slotH = 100000;
  const img = {
    parentElement: { clientWidth: slotW, clientHeight: slotH },
    naturalWidth: Math.round(photoAspect * 100000), naturalHeight: 100000,
    dataset: { scale: String(crop.scale), cropx: String(crop.x), cropy: String(crop.y), rot: '0' },
    style: {},
  };
  globalThis.fitCoverImage(img);
  return {
    left: parseFloat(img.style.left), top: parseFloat(img.style.top),
    w: parseFloat(img.style.width), h: parseFloat(img.style.height), slotW, slotH,
  };
}
// where the focus point lands inside the slot, 0..1 on each axis
function focusInSlot(photoAspect, slotAspect, crop, focus) {
  const g = geometry(photoAspect, slotAspect, crop);
  return { x: (g.left + focus.x * g.w) / g.slotW, y: (g.top + focus.y * g.h) / g.slotH,
    covers: g.left <= 2 && g.top <= 2 && g.left + g.w >= g.slotW - 2 && g.top + g.h >= g.slotH - 2 };
}

// a seeded random photo set
function randomItems(seed, n, { aspects, sharp = true } = {}) {
  const rnd = lcg(seed);
  const pool = aspects || [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625, 2.4, 0.4];
  const items = [];
  for (let i = 0; i < n; i++) {
    const aspect = pool[Math.floor(rnd() * pool.length)];
    items.push(item(`IMG_${pad(i + 1)}.jpg`, {
      aspect, sharp: sharp ? Math.floor(rnd() * 100) : 50, hash: hashOf(seed * 1000 + i),
      focus: { x: rnd(), y: rnd() },
    }));
  }
  return items;
}

// every structural rule plan promises, checked on one result
function checkPlan(plan, items, label, opts = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const survivors = items.filter(i => i.ok && !plan.dropped.some(d => d.id === i.id));
  const placed = photoIdsOf(plan);
  const m = placed.length;
  // coverage: each placed once, none dropped, none missing (cover may repeat inside)
  assert.equal(new Set(placed).size, m, `${label}: a photo is placed twice`);
  for (const id of placed) assert.ok(byId.has(id) && !plan.dropped.some(d => d.id === id), `${label}: ${id} dropped or unknown`);
  const expected = survivors.length === 2 || survivors.length === 3 ? survivors.length - 1 : survivors.length;
  if (survivors.length > 0) assert.equal(m, expected, `${label}: wrong number of placed photos`);
  // no empty slot, slot counts match the layout, scale 1
  const layouts = opts.layouts || LAYOUTS;
  for (const p of plan.pages) {
    const def = layouts[p.layout];
    assert.ok(def, `${label}: unknown layout ${p.layout}`);
    assert.equal(p.slots.length, def.slots.length, `${label}: slot count of ${p.layout}`);
    assert.equal(p.type, 'inner');
    for (const s of p.slots) {
      assert.ok(s.photoId, `${label}: empty slot`);
      assert.equal(s.crop.scale, 1);
    }
  }
  // never the same layout three pages running
  for (let i = 2; i < plan.pages.length; i++) {
    const [a, b, c] = [plan.pages[i - 2].layout, plan.pages[i - 1].layout, plan.pages[i].layout];
    assert.ok(!(a === b && b === c), `${label}: ${a} three pages running at ${i}`);
  }
  // hero: at most one full-bleed in any four consecutive pages
  for (let i = 0; i + 4 <= plan.pages.length; i++) {
    const n = plan.pages.slice(i, i + 4).filter(hero).length;
    assert.ok(n <= 1, `${label}: ${n} full-bleed pages within pages ${i + 1}-${i + 4}`);
  }
  // the last page is not one lonely photo, unless that photo is a full-bleed closer or the whole book
  if (plan.pages.length > 0 && m > 1) {
    const last = plan.pages[plan.pages.length - 1];
    assert.ok(last.slots.length > 1 || hero(last), `${label}: last page is a lone ${last.layout}`);
  }
  // mixed orientation never goes into a 3-slot layout
  for (const p of plan.pages) {
    if (p.slots.length !== 3) continue;
    const kinds = new Set(p.slots.map(s => byId.get(s.photoId).orientation).filter(o => o !== 'square'));
    assert.ok(kinds.size <= 1, `${label}: mixed orientations in ${p.layout}: ${[...kinds]}`);
  }
  // every crop leaves the focus visible and the photo covering its slot
  const pa = opts.pageAspect ?? 1;
  const slots = plan.pages.flatMap(p => p.slots.map((s, i) => ({ s, def: layouts[p.layout].slots[i] })));
  for (const { s, def } of slots) {
    const it = byId.get(s.photoId);
    const f = { x: Math.min(0.8, Math.max(0.2, it.focus.x)), y: Math.min(0.8, Math.max(0.2, it.focus.y)) };
    const r = focusInSlot(it.aspect, (def.w / def.h) * pa, s.crop, f);
    assert.ok(r.covers, `${label}: crop leaves a gap for ${s.photoId}: ${JSON.stringify({ aspect: it.aspect, slot: (def.w / def.h) * pa, crop: s.crop, geo: geometry(it.aspect, (def.w / def.h) * pa, s.crop) })}`);
    assert.ok(r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1, `${label}: focus off-slot for ${s.photoId}: ${r.x},${r.y}`);
  }
  return slots.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// Loading
// ═════════════════════════════════════════════════════════════════════════════
test('auto_layout.js loads with no DOM and adds only AutoLayout', () => {
  assert.equal(autoDefined, 'object');
  assert.deepEqual(autoGlobals, [], 'auto_layout.js must not create window properties');
  assert.equal(typeof AutoLayout.analyze, 'function');
  assert.equal(typeof AutoLayout.plan, 'function');
  assert.equal(typeof AutoLayout.run, 'function');
});

test('layouts.js loads with no DOM; the globals it adds are only declarations', () => {
  assert.deepEqual(layoutsGlobals, [
    // _encode*/_num/_oneOf/_safe*: the book-data sanitisers (audit FE-1)
    '_coverImgHTML', '_encodeKey', '_encodeUrlPart', '_escapeHtml', '_num', '_oneOf', '_originalUrl',
    '_renderTextLayerHTML', '_safeColor', '_safeFont', '_thumbUrl',
    'appendPageGuides', 'fitCoverImage', 'pageLabel', 'pageZOrder', 'removePageGuides',
    'renderPageHTML', 'renderPageThumbnailHTML',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// run(): the old API is untouched
// ═════════════════════════════════════════════════════════════════════════════
test('run() produces exactly the pages the pre-refactor engine did (5 styles + default)', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(dir, 'auto_layout.legacy-golden.json'), 'utf8'));
  const now = await recordLegacy(AutoLayout);
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  // positive: the recording is not empty and really contains the interesting layouts
  assert.ok(now['thirteen/magazine'].length >= 5);
  assert.ok(now['thirteen/story'].some(p => p.layout === '3-up'));
  for (const k of Object.keys(golden)) assert.deepEqual(now[k], golden[k], k);
});

test('run() needs no analyze options: a photo that fails to load is treated as landscape, as before', async () => {
  await withFakeBrowser(async () => {
    Math.random = lcg();
    const pages = await AutoLayout.run([{ id: 'p07' }, { id: 'p04' }], 'story');   // p07 never loads
    assert.equal(pages.length, 1);
    assert.equal(pages[0].layout, '2-up-v');                                      // landscape + landscape
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// pure helpers
// ═════════════════════════════════════════════════════════════════════════════
test('naturalCompare: numbers are numbers, case and zero padding do not reorder', () => {
  const sorted = ['IMG_10.jpg', 'IMG_9.jpg', 'img_2.jpg', 'IMG_100.jpg', 'IMG_09.jpg', 'IMG_1.jpg']
    .sort(U.naturalCompare);
  assert.deepEqual(sorted, ['IMG_1.jpg', 'img_2.jpg', 'IMG_9.jpg', 'IMG_09.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
  assert.ok(U.naturalCompare('IMG_9.jpg', 'IMG_10.jpg') < 0);
  assert.ok(U.naturalCompare('IMG_10.jpg', 'IMG_9.jpg') > 0);
  assert.equal(U.naturalCompare('IMG_9.jpg', 'IMG_9.jpg'), 0);
  assert.ok(U.naturalCompare('IMG_2.jpg', 'IMG_10.jpg') < 0);
  // trailing/leading structure
  assert.ok(U.naturalCompare('a2', 'a10') < 0);
  assert.ok(U.naturalCompare('a', 'a1') < 0);
  assert.ok(U.naturalCompare('2a', 'a2') < 0);
});

test('hamming counts differing bits; an empty or mismatched hash is "unknown", never close', () => {
  assert.equal(U.hamming(H0, H0), 0);
  assert.equal(U.hamming(H0, flip(H0, 1)), 1);
  assert.equal(U.hamming(H0, flip(H0, 6)), 6);
  assert.equal(U.hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(U.hamming('', ''), Infinity);
  assert.equal(U.hamming(H0, ''), Infinity);
  assert.equal(U.hamming(H0, 'abc'), Infinity);
});

test('dHash: bit = left pixel brighter than right, row by row (9x8 grey -> 16 hex)', () => {
  const grad = f => Array.from({ length: 72 }, (_, i) => f(i % 9));
  assert.equal(U.dHash(grad(x => x * 10)), '0000000000000000');          // brightens to the right
  assert.equal(U.dHash(grad(x => 255 - x * 10)), 'ffffffffffffffff');    // darkens to the right
  const flat = U.dHash(grad(() => 100));
  assert.equal(flat, '0000000000000000');                                // equal is not "brighter"
  // one row differs: only that row's byte changes
  const g = grad(x => x * 10);
  for (let x = 0; x < 9; x++) g[3 * 9 + x] = 255 - x * 10;
  assert.equal(U.dHash(g), '000000ff00000000');
});

test('sharpnessOf: flat 0, soft ramp low, hard edges high', () => {
  const flat = new Array(1024).fill(120);
  const ramp = Array.from({ length: 1024 }, (_, i) => (i % 32) * 4);
  const checker = Array.from({ length: 1024 }, (_, i) => ((i % 32) + Math.floor(i / 32)) % 2 ? 255 : 0);
  const stripes = Array.from({ length: 1024 }, (_, i) => (Math.floor((i % 32) / 4) % 2 ? 255 : 0));
  assert.equal(U.sharpnessOf(flat), 0);
  assert.ok(U.sharpnessOf(ramp) < 1, 'a linear ramp has no second derivative');
  assert.ok(U.sharpnessOf(stripes) > 100);
  assert.ok(U.sharpnessOf(checker) > U.sharpnessOf(stripes));
});

test('focusOf: centre of gradient energy, clamped to 0.2..0.8; flat -> centre', () => {
  const at = (cx, cy) => {      // a bright 4x4 square centred near (cx,cy) in 32 px units on black
    const g = new Array(1024).fill(0);
    for (let y = cy - 2; y < cy + 2; y++) for (let x = cx - 2; x < cx + 2; x++) g[y * 32 + x] = 255;
    return U.focusOf(g);
  };
  const flat = U.focusOf(new Array(1024).fill(90));
  assert.deepEqual(flat, { x: 0.5, y: 0.5 });
  const mid = at(16, 16);
  assert.ok(Math.abs(mid.x - 0.5) < 0.03 && Math.abs(mid.y - 0.5) < 0.03, JSON.stringify(mid));
  const right = at(24, 16);
  assert.ok(right.x > 0.7 && right.x <= 0.8, JSON.stringify(right));
  const corner = at(3, 3);
  assert.equal(corner.x, 0.2);   // clamped, not 0.1
  assert.equal(corner.y, 0.2);
  const far = at(29, 29);
  assert.equal(far.x, 0.8);
  assert.equal(far.y, 0.8);
});

// ═════════════════════════════════════════════════════════════════════════════
// analyze
// ═════════════════════════════════════════════════════════════════════════════
// A fake picture: natural size plus a function giving the grey level at (u,v) in 0..1.
const picture = (w, h, paint = (u) => u * 255) => ({ naturalWidth: w, naturalHeight: h, paint });
const pixelsOf = (img, w, h) => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = img.paint((x + 0.5) / w, (y + 0.5) / h);
    const o = (y * w + x) * 4;
    out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
  }
  return out;
};
const delay = ms => new Promise(r => setTimeout(r, ms));

test('analyze: one entry per id, in input order, with aspect, orientation, hash, sharpness and focus', async () => {
  const pics = {
    a: picture(600, 400, u => u * 255),                                // landscape, brightens right
    b: picture(400, 600, u => 255 - u * 255),                          // portrait, darkens right
    c: picture(500, 500, (u, v) => ((u * 16 | 0) + (v * 16 | 0)) % 2 ? 255 : 0),   // square, checker
  };
  const urls = [];
  const res = await AutoLayout.analyze(['a', 'b', 'c'], {
    urlFor: id => { urls.push(id); return `u://${id}`; },
    loadImage: async url => pics[url.slice(4)],
    pixelsOf,
  });
  assert.deepEqual(urls.sort(), ['a', 'b', 'c']);
  assert.deepEqual(res.map(r => r.id), ['a', 'b', 'c']);
  assert.ok(res.every(r => r.ok));
  assert.equal(res[0].aspect, 1.5);
  assert.equal(res[0].orientation, 'landscape');
  assert.ok(Math.abs(res[1].aspect - 400 / 600) < 1e-9);
  assert.equal(res[1].orientation, 'portrait');
  assert.equal(res[2].orientation, 'square');
  assert.equal(res[0].hash, '0000000000000000');
  assert.equal(res[1].hash, 'ffffffffffffffff');
  assert.match(res[2].hash, /^[0-9a-f]{16}$/);
  assert.ok(res[2].sharpness > 100 && res[0].sharpness < 1, JSON.stringify(res.map(r => r.sharpness)));
  for (const r of res) {
    assert.ok(r.focus.x >= 0.2 && r.focus.x <= 0.8 && r.focus.y >= 0.2 && r.focus.y <= 0.8);
  }
});

test('analyze: orientation thresholds (square within 5%)', async () => {
  const sizes = { s1: [1000, 1000], s2: [1040, 1000], s3: [1060, 1000], s4: [1000, 1060], s5: [1000, 1040] };
  const res = await AutoLayout.analyze(Object.keys(sizes), {
    urlFor: id => id, loadImage: async id => picture(...sizes[id]), pixelsOf,
  });
  assert.deepEqual(res.map(r => r.orientation), ['square', 'square', 'landscape', 'portrait', 'square']);
});

test('analyze: never more than `concurrency` loads at once, and it does reach the limit', async () => {
  for (const [conc, expectMax] of [[3, 3], [1, 1], [undefined, 6]]) {
    let inflight = 0, peak = 0, started = 0;
    const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
    const res = await AutoLayout.analyze(ids, {
      urlFor: id => id,
      loadImage: async id => { started++; inflight++; peak = Math.max(peak, inflight); await delay(5); inflight--; return picture(300, 200); },
      pixelsOf, ...(conc ? { concurrency: conc } : {}),
    });
    assert.equal(res.length, 30);
    assert.equal(started, 30);
    assert.equal(peak, expectMax, `concurrency ${conc}`);
  }
});

test('analyze: a photo that fails to load does not fail the rest', async () => {
  const res = await AutoLayout.analyze(['ok1', 'bad', 'ok2', 'boom'], {
    urlFor: id => id,
    loadImage: async id => {
      if (id === 'bad') throw new Error('404');
      if (id === 'boom') return null;                       // a loader that resolves nothing is a failure too
      return picture(600, 400);
    },
    pixelsOf,
  });
  assert.deepEqual(res.map(r => [r.id, r.ok]), [['ok1', true], ['bad', false], ['ok2', true], ['boom', false]]);
  assert.equal(res[0].aspect, 1.5);
  const bad = res[1];
  assert.equal(typeof bad.aspect, 'number');
  assert.equal(bad.hash, '');
  assert.equal(bad.sharpness, 0);
  assert.deepEqual(bad.focus, { x: 0.5, y: 0.5 });
  const all = await AutoLayout.analyze(['x', 'y'], { urlFor: id => id, loadImage: async () => { throw new Error('offline'); }, pixelsOf });
  assert.deepEqual(all.map(r => r.ok), [false, false]);
});

test('analyze: pixels unreadable (tainted canvas) keeps the photo, without a hash', async () => {
  const res = await AutoLayout.analyze(['a'], {
    urlFor: id => id, loadImage: async () => picture(300, 600),
    pixelsOf: () => { throw new Error('SecurityError'); },
  });
  assert.equal(res[0].ok, true);
  assert.equal(res[0].aspect, 0.5);
  assert.equal(res[0].orientation, 'portrait');
  assert.equal(res[0].hash, '');
  assert.equal(res[0].sharpness, 0);
  assert.deepEqual(res[0].focus, { x: 0.5, y: 0.5 });
});

test('analyze: an image with no size is a failure, not a NaN aspect', async () => {
  const res = await AutoLayout.analyze(['a'], { urlFor: id => id, loadImage: async () => ({ naturalWidth: 0, naturalHeight: 0 }), pixelsOf });
  assert.equal(res[0].ok, false);
});

test('analyze: an abort stops launching loads and rejects with AbortError', async () => {
  const ac = new AbortController();
  let started = 0;
  const ids = Array.from({ length: 40 }, (_, i) => `i${i}`);
  const p = AutoLayout.analyze(ids, {
    urlFor: id => id, concurrency: 2, signal: ac.signal, pixelsOf,
    loadImage: async () => { started++; if (started === 3) ac.abort(); await delay(5); return picture(300, 200); },
  });
  await assert.rejects(p, e => e.name === 'AbortError');
  await delay(30);
  assert.ok(started >= 3 && started < 10, `started ${started}`);   // stopped, not drained
});

test('analyze: an already-aborted signal loads nothing', async () => {
  const ac = new AbortController(); ac.abort();
  let started = 0;
  await assert.rejects(AutoLayout.analyze(['a', 'b'], {
    urlFor: id => id, signal: ac.signal, pixelsOf, loadImage: async () => { started++; return picture(1, 1); },
  }), e => e.name === 'AbortError');
  assert.equal(started, 0);
});

test('analyze: the signal reaches loadImage so a real loader can cancel', async () => {
  let seen = null;
  const ac = new AbortController();
  await AutoLayout.analyze(['a'], { urlFor: id => id, signal: ac.signal, pixelsOf, loadImage: async (url, o) => { seen = o && o.signal; return picture(3, 2); } });
  assert.equal(seen, ac.signal);
});

test('analyze: empty input is an empty array and touches nothing', async () => {
  assert.deepEqual(await AutoLayout.analyze([], { urlFor: () => { throw new Error('no'); } }), []);
});

test('analyze: works with no global driveManager (urlFor is the only URL source)', async () => {
  assert.equal(typeof globalThis.driveManager, 'undefined');
  const res = await AutoLayout.analyze(['a'], { urlFor: id => `x://${id}`, loadImage: async u => picture(300, 200), pixelsOf });
  assert.equal(res[0].ok, true);
});

test('analyze: aspectOnly never reads pixels (used by run())', async () => {
  let reads = 0;
  const res = await AutoLayout.analyze(['a'], { aspectOnly: true, urlFor: id => id, loadImage: async () => picture(300, 200), pixelsOf: () => { reads++; return new Uint8ClampedArray(4); } });
  assert.equal(reads, 0);
  assert.equal(res[0].aspect, 1.5);
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: dedupe
// ═════════════════════════════════════════════════════════════════════════════
const dupOf = (plan, id) => plan.dropped.find(d => d.id === id);

test('plan dedupe: identical neighbours collapse to the sharper one, in either order', () => {
  for (const [sa, sb, keep, lose] of [[80, 30, 'IMG_001', 'IMG_002'], [30, 80, 'IMG_002', 'IMG_001']]) {
    const items = [
      item('IMG_001', { hash: H0, sharp: sa }), item('IMG_002', { hash: H0, sharp: sb }),
      item('IMG_003', { hash: hashOf(3) }), item('IMG_004', { hash: hashOf(4) }), item('IMG_005', { hash: hashOf(5) }),
    ];
    const plan = AutoLayout.plan(items);
    assert.deepEqual(plan.dropped, [{ id: lose, reason: 'duplicate', of: keep }]);
    assert.ok(photoIdsOf(plan).includes(keep));
    assert.ok(!photoIdsOf(plan).includes(lose));
    assert.notEqual(plan.cover?.photoId, lose);
  }
});

test('plan dedupe: equal sharpness keeps the earlier photo', () => {
  const plan = AutoLayout.plan([
    item('IMG_001', { hash: H0, sharp: 40 }), item('IMG_002', { hash: H0, sharp: 40 }),
    item('IMG_003'), item('IMG_004'), item('IMG_005'),
  ]);
  assert.deepEqual(plan.dropped, [{ id: 'IMG_002', reason: 'duplicate', of: 'IMG_001' }]);
});

test('plan dedupe: the threshold is inclusive (6 bits apart is a duplicate, 7 is not)', () => {
  const mk = bits => AutoLayout.plan([
    item('IMG_001', { hash: H0 }), item('IMG_002', { hash: flip(H0, bits) }),
    item('IMG_003'), item('IMG_004'), item('IMG_005'),
  ]).dropped.length;
  assert.equal(mk(0), 1);
  assert.equal(mk(6), 1);
  assert.equal(mk(7), 0);
});

test('plan dedupe: hashThreshold and window are options', () => {
  const four = (opts) => AutoLayout.plan([
    item('IMG_001', { hash: H0 }), item('IMG_002', { hash: flip(H0, 10) }), item('IMG_003'), item('IMG_004'), item('IMG_005'),
  ], opts).dropped.length;
  assert.equal(four({}), 0);
  assert.equal(four({ hashThreshold: 10 }), 1);
  assert.equal(four({ hashThreshold: 9 }), 0);
  assert.equal(four({ hashThreshold: 0 }), 0);
});

test('plan dedupe: only neighbours count — identical photos further apart than the window are kept', () => {
  const build = gap => {
    const items = [item('IMG_001', { hash: H0 })];
    for (let i = 0; i < gap - 1; i++) items.push(item(`IMG_${pad(i + 2)}`));
    items.push(item(`IMG_${pad(gap + 1)}`, { hash: H0 }));
    return items;
  };
  assert.equal(AutoLayout.plan(build(5)).dropped.length, 1, 'five apart is inside the default window');
  assert.equal(AutoLayout.plan(build(6)).dropped.length, 0, 'six apart is outside it');
  assert.equal(AutoLayout.plan(build(6), { window: 6 }).dropped.length, 1);
  assert.equal(AutoLayout.plan(build(2), { window: 1 }).dropped.length, 0);
  assert.equal(AutoLayout.plan(build(1), { window: 1 }).dropped.length, 1);
});

test('plan dedupe: neighbours means shooting order, not input order', () => {
  // IMG_10 sits next to IMG_9 once sorted naturally, though it is last in the input
  const items = [item('IMG_1'), item('IMG_2'), item('IMG_3'), item('IMG_4'), item('IMG_5'),
    item('IMG_6'), item('IMG_7'), item('IMG_8'), item('IMG_9', { hash: H0 }), item('IMG_10', { hash: H0 })];
  const shuffled = [items[9], items[3], items[8], ...items.slice(0, 3), ...items.slice(4, 8)];
  const plan = AutoLayout.plan(shuffled);
  assert.equal(plan.dropped.length, 1);
  assert.deepEqual(plan.dropped.map(d => d.reason), ['duplicate']);
});

test('plan dedupe: a long run of burst shots keeps the sharpest, not a chain of survivors', () => {
  const items = [];
  for (let i = 0; i < 5; i++) items.push(item(`IMG_${pad(i + 1)}`, { hash: flip(H0, i % 3), sharp: [10, 20, 90, 30, 40][i] }));
  items.push(item('IMG_006'), item('IMG_007'), item('IMG_008'), item('IMG_009'));
  const plan = AutoLayout.plan(items);
  assert.deepEqual(plan.dropped.map(d => [d.id, d.of]).sort(), [['IMG_001', 'IMG_003'], ['IMG_002', 'IMG_003'], ['IMG_004', 'IMG_003'], ['IMG_005', 'IMG_003']]);
});

test('plan dedupe: a photo with no hash is never a duplicate of anything', () => {
  const plan = AutoLayout.plan([item('IMG_001', { hash: '' }), item('IMG_002', { hash: '' }), item('IMG_003', { hash: '' }), item('IMG_004', { hash: H0 }), item('IMG_005', { hash: '' })]);
  assert.deepEqual(plan.dropped, []);
});

test('plan dedupe: the same id twice is a duplicate of itself', () => {
  const plan = AutoLayout.plan([item('IMG_001'), item('IMG_001'), item('IMG_002'), item('IMG_003'), item('IMG_004')]);
  assert.deepEqual(plan.dropped, [{ id: 'IMG_001', reason: 'duplicate', of: 'IMG_001' }]);
  assert.equal(photoIdsOf(plan).filter(x => x === 'IMG_001').length, 1);
});

test('plan failed: failed photos go to dropped and never into a page or the cover', () => {
  const items = [item('IMG_001'), item('IMG_002', { ok: false, sharp: 999 }), item('IMG_003'), item('IMG_004'), item('IMG_005')];
  const plan = AutoLayout.plan(items);
  assert.deepEqual(plan.dropped, [{ id: 'IMG_002', reason: 'failed' }]);
  assert.ok(!photoIdsOf(plan).includes('IMG_002'));
  assert.notEqual(plan.cover.photoId, 'IMG_002');
  assert.equal(photoIdsOf(plan).length, 4);
  const bad = AutoLayout.plan([item('IMG_001', { aspect: NaN }), item('IMG_002', { aspect: 0 }), item('IMG_003')]);
  assert.deepEqual(bad.dropped.map(d => d.reason), ['failed', 'failed']);
});

test('plan failed: everything failed -> empty book, everything dropped', () => {
  const plan = AutoLayout.plan([item('IMG_001', { ok: false }), item('IMG_002', { ok: false })]);
  assert.deepEqual(plan, { cover: null, pages: [], dropped: [{ id: 'IMG_001', reason: 'failed' }, { id: 'IMG_002', reason: 'failed' }] });
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: order
// ═════════════════════════════════════════════════════════════════════════════
test('plan order: filename natural sort is the shooting order (IMG_9 before IMG_10)', () => {
  const ids = ['IMG_10', 'IMG_9', 'IMG_100', 'IMG_2', 'IMG_1', 'IMG_20'];
  const plan = AutoLayout.plan(ids.map(id => item(id, { aspect: 0.667 })), { pages: 1 });
  assert.deepEqual([...photoIdsOf(plan)].sort(U.naturalCompare), ['IMG_1', 'IMG_2', 'IMG_9', 'IMG_10', 'IMG_20', 'IMG_100']);
  // within the plan, order is the natural order up to the in-page re-seating
  const pos = id => photoIdsOf(plan).indexOf(id);
  assert.ok(Math.floor(pos('IMG_1') / 4) <= Math.floor(pos('IMG_100') / 4));
  const lexical = [...ids].sort();
  assert.notDeepEqual(lexical, [...ids].sort(U.naturalCompare), 'sanity: the two orders differ on this data');
});

test("plan order: order:'given' keeps the caller's order (a delivered gallery order)", () => {
  const ids = ['z9', 'a1', 'm5', 'b2', 'y8', 'c3', 'x7', 'd4'];
  const items = ids.map(id => item(id, { aspect: 0.667 }));
  const given = AutoLayout.plan(items, { order: 'given', pages: 2 });
  const natural = AutoLayout.plan(items, { pages: 2 });
  assert.deepEqual(new Set(photoIdsOf(given).slice(0, 4)), new Set(ids.slice(0, 4)), 'first page = first four as given');
  assert.deepEqual(new Set(photoIdsOf(natural).slice(0, 4)), new Set(['a1', 'b2', 'c3', 'd4']));
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: shape, edges, determinism
// ═════════════════════════════════════════════════════════════════════════════
test('plan edges: empty input', () => {
  assert.deepEqual(AutoLayout.plan([]), { cover: null, pages: [], dropped: [] });
});

test('plan edges: one photo -> cover and a single page showing it', () => {
  const plan = AutoLayout.plan([item('IMG_001', { aspect: 1.5 })]);
  assert.equal(plan.cover.photoId, 'IMG_001');
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0].slots.length, 1);
  assert.equal(plan.pages[0].slots[0].photoId, 'IMG_001');
});

test('plan edges: two or three photos — the cover is not repeated inside; four or more it is allowed to be', () => {
  for (const n of [2, 3]) {
    const items = Array.from({ length: n }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: i === 1 ? 90 : 10 }));
    const plan = AutoLayout.plan(items);
    assert.equal(plan.cover.photoId, 'IMG_002', `n=${n}: sharpest is the cover`);
    assert.ok(!photoIdsOf(plan).includes('IMG_002'));
    assert.equal(photoIdsOf(plan).length, n - 1);
    assert.ok(plan.pages.length >= 1);
  }
  const four = Array.from({ length: 4 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: i === 1 ? 90 : 10 }));
  assert.ok(photoIdsOf(AutoLayout.plan(four)).includes('IMG_002'), 'with four, nothing is wasted on the cover');
});

test('plan edges: all portrait, all landscape, all square, all identical, extreme ratios', () => {
  const sets = {
    portrait: randomItems(1, 17, { aspects: [0.667, 0.8, 0.75] }),
    landscape: randomItems(2, 17, { aspects: [1.5, 1.333, 1.778] }),
    square: randomItems(3, 17, { aspects: [1, 1.02, 0.98] }),
    panoramas: randomItems(4, 11, { aspects: [3.5, 5, 0.2, 0.25] }),
    mixed: randomItems(5, 23),
  };
  for (const [name, items] of Object.entries(sets)) {
    const plan = AutoLayout.plan(items);
    checkPlan(plan, items, name);
    assert.ok(plan.pages.length > 0, name);
  }
  const same = Array.from({ length: 6 }, (_, i) => item(`IMG_${pad(i + 1)}`, { hash: H0 }));
  const plan = AutoLayout.plan(same);
  assert.equal(plan.dropped.length, 5, 'identical photos inside one window collapse to one');
  assert.ok(plan.dropped.every(d => d.reason === 'duplicate' && d.of === plan.cover.photoId));
  assert.equal(plan.cover.photoId, 'IMG_001');
  assert.equal(photoIdsOf(plan).length, 1);
  // beyond the window the same picture comes back as a new group: 9 identical -> 2 kept
  const nine = AutoLayout.plan(Array.from({ length: 9 }, (_, i) => item(`IMG_${pad(i + 1)}`, { hash: H0 })));
  assert.equal(nine.dropped.length, 7);
});

test('plan: a page of two portraits is side by side, a page of two landscapes is stacked', () => {
  let h = 0, v = 0;
  for (let seed = 400; seed < 440; seed++) {
    const items = randomItems(seed, 20 + seed % 25, { aspects: [1.5, 1.333, 0.667, 0.8, 0.75, 1.5, 0.667] });
    const byId = new Map(items.map(i => [i.id, i]));
    const plan = AutoLayout.plan(items);
    for (const p of plan.pages) {
      if (p.slots.length !== 2) continue;
      const kinds = p.slots.map(s => byId.get(s.photoId).orientation);
      if (kinds[0] === 'portrait' && kinds[1] === 'portrait') { assert.equal(p.layout, '2-up-h', `seed ${seed}`); h++; }
      if (kinds[0] === 'landscape' && kinds[1] === 'landscape') { assert.equal(p.layout, '2-up-v', `seed ${seed}`); v++; }
    }
  }
  assert.ok(h >= 10 && v >= 10, `only ${h} portrait pairs and ${v} landscape pairs were seen`);
});

test('plan is deterministic and pure: same input twice -> identical output, input untouched', () => {
  const items = randomItems(7, 40);
  const frozen = JSON.stringify(items);
  items.forEach(i => { Object.freeze(i); Object.freeze(i.focus); });
  Object.freeze(items);
  const realRandom = Math.random;
  Math.random = () => { throw new Error('plan must not use Math.random'); };
  let a, b;
  try { a = AutoLayout.plan(items); b = AutoLayout.plan(items); } finally { Math.random = realRandom; }
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  assert.ok(a.pages.length > 5);
  const a2 = AutoLayout.plan(randomItems(7, 40), { pages: 12 });
  const b2 = AutoLayout.plan(randomItems(7, 40), { pages: 12 });
  assert.equal(JSON.stringify(a2), JSON.stringify(b2));
});

test('plan: only the "auto" style exists', () => {
  assert.throws(() => AutoLayout.plan([item('a')], { style: 'magazine' }), /style/);
  assert.doesNotThrow(() => AutoLayout.plan([item('a')], { style: 'auto' }));
});

test('plan: ids of pages are unique and stable', () => {
  const plan = AutoLayout.plan(randomItems(8, 30));
  const ids = plan.pages.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.ok(plan.pages.every(p => p.bg === '#ffffff'));
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: pacing rules, on many seeded sets
// ═════════════════════════════════════════════════════════════════════════════
test('plan pacing: every structural rule holds on 80 seeded sets of 0..70 photos', () => {
  let totalSlots = 0, withHero = 0, with3 = 0, with4 = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const n = (seed * 7) % 71;
    const items = randomItems(seed, n);
    const plan = AutoLayout.plan(items);
    totalSlots += checkPlan(plan, items, `seed ${seed} n=${n}`);
    if (plan.pages.some(hero)) withHero++;
    if (plan.pages.some(p => p.layout === '3-up')) with3++;
    if (plan.pages.some(p => p.layout === '4-grid')) with4++;
  }
  // positive: the checks above ran on real material, not on empty plans
  assert.ok(totalSlots > 1000, `only ${totalSlots} slots were checked`);
  assert.ok(withHero >= 10, `hero pages appeared in only ${withHero} sets`);
  assert.ok(with3 >= 5 && with4 >= 5, `3-up in ${with3} sets, 4-grid in ${with4}`);
});

test('plan pacing: whatever the page size, the same rules hold (spread 2:1, tall 0.7)', () => {
  for (const pageAspect of [2, 0.7, 1.4]) {
    for (let seed = 100; seed < 110; seed++) {
      const items = randomItems(seed, 10 + seed % 40);
      const plan = AutoLayout.plan(items, { pageAspect });
      checkPlan(plan, items, `aspect ${pageAspect} seed ${seed}`, { pageAspect });
    }
  }
});

test('plan pacing: hero pages go to sharp landscape photos, and no more than one in four pages', () => {
  // 60 landscape photos, sharpness spread evenly, asking for lots of pages so singles are common
  const items = Array.from({ length: 60 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: (i * 37) % 100 }));
  const plan = AutoLayout.plan(items, { pages: 40 });
  const heroes = plan.pages.filter(hero);
  assert.ok(heroes.length >= 4, `expected the cap to be reached, got ${heroes.length} hero pages`);
  assert.ok(heroes.length <= Math.ceil(plan.pages.length / 4), `${heroes.length} heroes in ${plan.pages.length} pages`);
  const sharpOf = id => items.find(i => i.id === id).sharpness;
  const median = [...items.map(i => i.sharpness)].sort((a, b) => a - b)[30];
  for (const h of heroes) assert.ok(sharpOf(h.slots[0].photoId) >= median, `hero photo ${h.slots[0].photoId} (sharp ${sharpOf(h.slots[0].photoId)}) is below the median`);
  checkPlan(plan, items, 'hero');
});

test('plan pacing: a portrait is not a hero when a sharp landscape is available', () => {
  const items = [];
  for (let i = 0; i < 24; i++) items.push(item(`IMG_${pad(i + 1)}`, { aspect: i % 2 ? 0.667 : 1.5, sharp: 50 + (i % 2 ? 40 : 0) + i % 7 }));
  // portraits are the sharper ones here; landscape must still get the full-page slots
  const plan = AutoLayout.plan(items, { pages: 16 });
  const heroes = plan.pages.filter(hero);
  assert.ok(heroes.length >= 1);
  const asp = id => items.find(i => i.id === id).aspect;
  const portraitHeroes = heroes.filter(h => asp(h.slots[0].photoId) < 1);
  assert.equal(portraitHeroes.length, 0, 'portrait photos should not take the full-bleed pages here');
});

test('plan pacing: never three pages running with the same layout (all-landscape and all-portrait books)', () => {
  for (const aspect of [1.5, 0.667]) {
    const items = Array.from({ length: 40 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect }));
    const plan = AutoLayout.plan(items);
    checkPlan(plan, items, `aspect ${aspect}`);
    const layouts = new Set(plan.pages.map(p => p.layout));
    assert.ok(layouts.size >= 2, `only ${[...layouts]} used`);
    // positive: repeats do happen (two running is fine), so the rule is what limits them
    const twice = plan.pages.some((p, i) => i > 0 && plan.pages[i - 1].layout === p.layout);
    assert.ok(plan.pages.length >= 10 && twice !== undefined);
  }
});

test('plan pacing: the last page is never one stray photo (every n from 4 to 30)', () => {
  for (let n = 4; n <= 30; n++) {
    for (const aspects of [[1.5], [0.667], [1.5, 0.667]]) {
      const items = randomItems(n * 31, n, { aspects });
      const plan = AutoLayout.plan(items);
      const last = plan.pages[plan.pages.length - 1];
      assert.ok(last.slots.length > 1 || hero(last), `n=${n}: last page is a lone ${last.layout}`);
    }
  }
});

test('plan pacing: a mixed trio is never forced into a 3-slot layout; three portraits can be', () => {
  // L P L P L P ... would be tempting for 3-up if orientation were ignored
  const mixed = Array.from({ length: 30 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: i % 2 ? 0.667 : 1.5 }));
  const plan = AutoLayout.plan(mixed, { pages: 11 });
  checkPlan(plan, mixed, 'mixed');
  const ports = Array.from({ length: 30 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 0.667 }));
  const planP = AutoLayout.plan(ports, { pages: 11 });
  checkPlan(planP, ports, 'ports');
  assert.ok(planP.pages.some(p => p.layout === '3-up'), 'three portraits in a row are a good 3-up');
});

test('plan pacing: panoramas and ultra-tall photos get a layout that does not crush them', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(item(`IMG_${pad(i + 1)}`, { aspect: i % 5 === 2 ? 4 : 1.5 }));
  const plan = AutoLayout.plan(items);
  checkPlan(plan, items, 'pano');
  for (const p of plan.pages) p.slots.forEach((s, i) => {
    const asp = items.find(it => it.id === s.photoId).aspect;
    if (asp !== 4) return;
    const def = LAYOUTS[p.layout].slots[i];
    const slotAspect = def.w / def.h;
    const kept = Math.min(asp, slotAspect) / Math.max(asp, slotAspect);
    assert.ok(kept >= 0.4, `panorama in ${p.layout} slot ${i} keeps only ${(kept * 100).toFixed(0)}%`);
  });
});

test('plan pacing: even when a page count is demanded, no photo is squeezed to a sliver', () => {
  // a 4:1 panorama keeps 25% in a square cell; with another landscape in a stacked pair it keeps 50%
  const items = Array.from({ length: 24 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: i % 6 === 2 ? 4 : 1.5 }));
  for (const pages of [7, 9, 12]) {
    const plan = AutoLayout.plan(items, { pages });
    checkPlan(plan, items, `pages ${pages}`);
    for (const p of plan.pages) p.slots.forEach((s, i) => {
      const asp = items.find(it => it.id === s.photoId).aspect;
      const def = LAYOUTS[p.layout].slots[i];
      const slotAspect = def.w / def.h;
      const kept = Math.min(asp, slotAspect) / Math.max(asp, slotAspect);
      assert.ok(kept >= 0.4, `pages ${pages}: ${asp} in ${p.layout} slot ${i} keeps ${(kept * 100).toFixed(0)}%`);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: target page count
// ═════════════════════════════════════════════════════════════════════════════
test('plan pages target: approaches the requested count, more or fewer than the default', () => {
  const items = randomItems(21, 48);
  const dflt = AutoLayout.plan(items).pages.length;
  const counts = {};
  for (const target of [16, 20, 26, 32, 40]) {
    const plan = AutoLayout.plan(items, { pages: target });
    counts[target] = plan.pages.length;
    assert.ok(Math.abs(plan.pages.length - target) <= 2, `asked ${target}, got ${plan.pages.length}`);
    checkPlan(plan, items, `target ${target}`);
  }
  assert.ok(counts[16] < dflt && dflt < counts[40], `default ${dflt}, counts ${JSON.stringify(counts)}`);
  assert.ok(counts[16] < counts[26] && counts[26] < counts[40]);
});

test('plan pages target: impossible targets give the closest possible book', () => {
  const items = randomItems(22, 30);
  const few = AutoLayout.plan(items, { pages: 1 });
  const many = AutoLayout.plan(items, { pages: 500 });
  assert.ok(few.pages.length >= Math.ceil(30 / 4) && few.pages.length <= 12, `few: ${few.pages.length}`);
  assert.ok(many.pages.length >= 24, `many: ${many.pages.length}`);
  checkPlan(few, items, 'few'); checkPlan(many, items, 'many');
  assert.equal(AutoLayout.plan(items, { pages: 0 }).pages.length > 0, true);
  assert.equal(AutoLayout.plan(items, { pages: NaN }).pages.length > 0, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: cover
// ═════════════════════════════════════════════════════════════════════════════
test('plan cover: the sharpest photo whose shape suits the cover', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: 20 + i }));
  items[4] = item('IMG_005', { aspect: 1.5, sharp: 95 });
  assert.equal(AutoLayout.plan(items).cover.photoId, 'IMG_005');
  items[4] = item('IMG_005', { aspect: 1.5, sharp: 30 });
  items[9] = item('IMG_010', { aspect: 1.5, sharp: 96 });
  assert.equal(AutoLayout.plan(items).cover.photoId, 'IMG_010', 'not the first photo, not a fixed one');
});

test('plan cover: skips a razor-sharp panorama, a failed photo and a dropped duplicate loser', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: 20 + i }));
  items.push(item('IMG_013', { aspect: 5, sharp: 500 }));
  items.push(item('IMG_014', { aspect: 1.5, sharp: 400, ok: false }));
  const plan = AutoLayout.plan(items);
  assert.equal(plan.cover.photoId, 'IMG_012');
  const dups = [item('IMG_001', { hash: H0, sharp: 90 }), item('IMG_002', { hash: H0, sharp: 99 }), ...items.slice(2, 8)];
  const plan2 = AutoLayout.plan(dups);
  assert.equal(plan2.cover.photoId, 'IMG_002');                 // the sharper twin survives and wins
  assert.deepEqual(plan2.dropped, [{ id: 'IMG_001', reason: 'duplicate', of: 'IMG_002' }]);
});

test('plan cover: coverAspect decides what suits — a tall cover wants a portrait', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push(item(`IMG_${pad(i + 1)}`, { aspect: i === 3 ? 0.7 : 1.5, sharp: i === 3 ? 40 : 70 + i }));
  assert.equal(AutoLayout.plan(items, { coverAspect: 0.7 }).cover.photoId, 'IMG_004');
  assert.equal(AutoLayout.plan(items, { coverAspect: 1.5 }).cover.photoId, 'IMG_010');
});

test('plan cover: ties go to the earlier photo', () => {
  const items = Array.from({ length: 8 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: 50 }));
  assert.equal(AutoLayout.plan(items).cover.photoId, 'IMG_001');
});

test('plan cover: the cover photo is not wasted — it still appears inside, and never as a hero twin', () => {
  const items = randomItems(31, 30);
  const plan = AutoLayout.plan(items);
  assert.ok(photoIdsOf(plan).includes(plan.cover.photoId));
  const heroPhotos = plan.pages.filter(hero).map(p => p.slots[0].photoId);
  assert.ok(!heroPhotos.includes(plan.cover.photoId), 'same photo full-page twice');
  // the cover is by construction the sharpest landscape — the best hero candidate there is.
  // Many pages wanted, so full-bleed pages are plentiful; it must still not take one.
  const lands = Array.from({ length: 24 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, sharp: i === 9 ? 99 : 10 + i }));
  const p2 = AutoLayout.plan(lands, { pages: 16 });
  assert.equal(p2.cover.photoId, 'IMG_010');
  const heroes = p2.pages.filter(hero).map(p => p.slots[0].photoId);
  assert.ok(heroes.length >= 2, `expected several hero pages, got ${heroes.length}`);
  assert.ok(photoIdsOf(p2).includes('IMG_010') && !heroes.includes('IMG_010'));
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: crop focus
// ═════════════════════════════════════════════════════════════════════════════
test('crop: the focus lands inside the slot and the photo still covers it (real fitCoverImage geometry)', () => {
  for (const [pa, sa, f] of [
    [1.5, 1, { x: 0.8, y: 0.5 }], [1.5, 1, { x: 0.2, y: 0.5 }], [0.667, 1, { x: 0.5, y: 0.2 }], [0.667, 1, { x: 0.5, y: 0.8 }],
    [3, 1, { x: 0.2, y: 0.5 }], [3, 1, { x: 0.8, y: 0.5 }], [1, 1, { x: 0.8, y: 0.8 }], [1.5, 0.5, { x: 0.3, y: 0.5 }],
    [0.5, 2, { x: 0.5, y: 0.7 }], [1.778, 0.58, { x: 0.75, y: 0.5 }],
  ]) {
    const c = U.cropFor(pa, sa, f);
    const r = focusInSlot(pa, sa, c, f);
    assert.ok(r.covers, `photo ${pa} in slot ${sa}: gap`);
    assert.ok(r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1, `photo ${pa} in slot ${sa}: focus at ${r.x},${r.y}`);
    const centred = focusInSlot(pa, sa, { x: 0, y: 0, scale: 1 }, f);
    const dist = o => Math.abs(o.x - 0.5) + Math.abs(o.y - 0.5);
    assert.ok(dist(r) <= dist(centred) + 1e-9, 'moves the focus towards the middle, never away');
    assert.equal(c.scale, 1);
  }
});

test('crop: exact numbers — the focus is brought to the middle of the slot when there is room', () => {
  // 3:1 photo in a square slot: draws 3 slot-widths wide; focus at 0.4 -> shift 3*(0.5-0.4)=0.3
  const c = U.cropFor(3, 1, { x: 0.4, y: 0.5 });
  assert.ok(Math.abs(c.x - 0.3) < 1e-4, JSON.stringify(c));
  assert.equal(c.y, 0);
  const r = focusInSlot(3, 1, c, { x: 0.4, y: 0.5 });
  assert.ok(Math.abs(r.x - 0.5) < 1e-3);
  // portrait 2:3 in a square slot: draws 1.5 slot-heights tall; focus at y=0.35 -> shift 1.5*0.15
  const p = U.cropFor(2 / 3, 1, { x: 0.5, y: 0.35 });
  assert.equal(p.x, 0);
  assert.ok(Math.abs(p.y - 0.225) < 1e-4, JSON.stringify(p));
  // same aspect: nothing to crop
  assert.deepEqual(U.cropFor(1.5, 1.5, { x: 0.2, y: 0.8 }), { x: 0, y: 0, scale: 1 });
  // slight overflow: limited by the room there is (5%: 1.1 -> max 0.05)
  const s = U.cropFor(1.1, 1, { x: 0.2, y: 0.5 });
  assert.ok(Math.abs(s.x - 0.05) < 1e-4, JSON.stringify(s));
  // an off-centre focus to the right moves the picture the other way
  assert.ok(U.cropFor(3, 1, { x: 0.7, y: 0.5 }).x < 0);
});

test('crop: the focus is clamped to 0.2..0.8 first, so an edge hit does not drag the photo off its subject', () => {
  const edge = U.cropFor(3, 1, { x: 0, y: 0.5 });
  const clamped = U.cropFor(3, 1, { x: 0.2, y: 0.5 });
  assert.deepEqual(edge, clamped);
  assert.ok(Math.abs(clamped.x - 0.9) < 1e-4, JSON.stringify(clamped));   // 3 * 0.3, not the 1.0 maximum
  assert.deepEqual(U.cropFor(3, 1, { x: 1, y: 0.5 }), U.cropFor(3, 1, { x: 0.8, y: 0.5 }));
  assert.deepEqual(U.cropFor(0.4, 1, { x: 0.5, y: -3 }), U.cropFor(0.4, 1, { x: 0.5, y: 0.2 }));
  // plan applies it: a focus of 0 or 0.2 yields the same crop in the cover
  const mk = fx => AutoLayout.plan([item('IMG_001', { aspect: 3, focus: { x: fx, y: 0.5 } })]).cover.crop;
  assert.deepEqual(mk(0), mk(0.2));
  assert.ok(Math.abs(mk(0.2).x - 0.9) < 1e-4);
});

test('crop: slot aspect comes from the layout and the page shape (a spread is not a square)', () => {
  // 2-up-h slots are 50x100 %: on a 2:1 page that is a 1:1 slot, on a 1:1 page 1:2
  const items = Array.from({ length: 6 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 1.5, focus: { x: 0.2, y: 0.5 } }));
  const spread = AutoLayout.plan(items, { pages: 3, pageAspect: 2, layouts: { '2-up-h': LAYOUTS['2-up-h'], '1-up': LAYOUTS['1-up'] } });
  const square = AutoLayout.plan(items, { pages: 3, pageAspect: 1, layouts: { '2-up-h': LAYOUTS['2-up-h'], '1-up': LAYOUTS['1-up'] } });
  const h = pl => pl.pages.find(p => p.layout === '2-up-h');
  const a = h(spread), b = h(square);
  assert.ok(a && b);
  assert.ok(Math.abs(a.slots[0].crop.x - U.cropFor(1.5, 1, { x: 0.2, y: 0.5 }).x) < 1e-3);
  assert.ok(Math.abs(b.slots[0].crop.x - U.cropFor(1.5, 0.5, { x: 0.2, y: 0.5 }).x) < 1e-3);
  assert.notEqual(a.slots[0].crop.x, b.slots[0].crop.x);
});

test('crop: plan puts the focus crop on every slot and the cover (not the default 0,0)', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: i % 2 ? 0.667 : 1.5, focus: { x: 0.25, y: 0.3 } }));
  const plan = AutoLayout.plan(items);
  const nonzero = plan.pages.flatMap(p => p.slots).filter(s => s.crop.x !== 0 || s.crop.y !== 0);
  assert.ok(nonzero.length >= 8, `only ${nonzero.length} slots carry a focus crop`);
  assert.ok(plan.cover.crop.x !== 0 || plan.cover.crop.y !== 0);
  checkPlan(plan, items, 'crop');
});

// ═════════════════════════════════════════════════════════════════════════════
// plan: layouts whitelist
// ═════════════════════════════════════════════════════════════════════════════
test('plan layouts: only whitelisted layouts are used; the default never touches custom layouts', () => {
  const only = { 'full-bleed': LAYOUTS['full-bleed'], '1-up': LAYOUTS['1-up'], '2-up-h': LAYOUTS['2-up-h'] };
  for (let seed = 1; seed <= 15; seed++) {
    const items = randomItems(seed + 200, 8 + seed * 2);
    const plan = AutoLayout.plan(items, { layouts: only });
    checkPlan(plan, items, `whitelist ${seed}`, { layouts: only });
    for (const p of plan.pages) assert.ok(p.layout in only, p.layout);
  }
  // a custom layout sitting in the global LAYOUTS is not picked by default
  LAYOUTS['custom-test'] = { name: 'x', preview: 'x', slots: [{ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 50, w: 50, h: 50 }] };
  try {
    const items = randomItems(300, 40);
    const plan = AutoLayout.plan(items);
    assert.ok(plan.pages.length > 0 && plan.pages.every(p => !p.layout.startsWith('custom-')));
  } finally { delete LAYOUTS['custom-test']; }
  // but one handed in explicitly is usable
  const wide = { 'wide-1': { name: 'w', preview: 'w', slots: [{ x: 0, y: 25, w: 100, h: 50 }] }, '2-up-h': LAYOUTS['2-up-h'] };
  const items = Array.from({ length: 10 }, (_, i) => item(`IMG_${pad(i + 1)}`, { aspect: 2 }));
  const plan = AutoLayout.plan(items, { layouts: wide });
  assert.ok(plan.pages.some(p => p.layout === 'wide-1'));
});

test('plan layouts: a whitelist with no single-photo layout cannot place an odd photo — it says so', () => {
  const only = { '2-up-h': LAYOUTS['2-up-h'] };
  assert.throws(() => AutoLayout.plan(randomItems(1, 7), { layouts: only }), /layout/i);
  assert.doesNotThrow(() => AutoLayout.plan([], { layouts: only }));
});
