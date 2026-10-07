// node --test book_editor/test/plan_variant.test.mjs
//
// planSpreads option `variant` (re-layout in the guest's album preview): a non-negative integer, default 0.
//   * variant 0 / absent / junk = EXACTLY the plan as it always was (pinned by digests made on the commit before it existed);
//   * variant n > 0 re-rolls only the near-ties (a bigger, differently hashed jitter on the spread cost): same photos, same
//     cover, every hard rule (min/maxSpreads, preferredPerSpread, foldSafe, hero gap, fit) unchanged, result.variant = n,
//     deterministic for (photos, options, variant);
//   * variants 1..5 give at least 3 distinct plans per book, and the waste stays near variant 0's (bounds below).
// Synthetic photos only: these pin the mechanism, not how it looks on a real album.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lcg } from './legacy-fixture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');
vm.runInThisContext(read('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(read('spread_templates.js'), { filename: 'spread_templates.js' });
vm.runInThisContext(read('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
const HERO_GAP = AutoLayout.SPREAD_DEFAULTS.heroGap;

const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625];
function items(seed, n, fold = () => 0.1) {
  const rnd = lcg(seed), out = [];
  for (let i = 0; i < n; i++) {
    const aspect = POOL[Math.floor(rnd() * POOL.length)];
    out.push({ id: `IMG_${String(i + 1).padStart(3, '0')}.jpg`, ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(seed * 1000 + i),
      sharpness: Math.floor(rnd() * 100), focus: { x: rnd(), y: rnd() }, foldRisk: fold(i) });
  }
  return out;
}
const plan = (it, o = {}) => AutoLayout.planSpreads(it, o);
const tpls = p => p.spreads.map(s => s.template).join();
const ids = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId)).sort();
const spans = s => s.slots.some(x => x.slot.face === 'span');
const sha = x => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex');
// mean waste per slot (0 = the photo fills its frame): the planner's own measure
function waste(p, it) {
  const asp = new Map(it.map(x => [x.id, x.aspect]));
  let t = 0, c = 0;
  for (const s of p.spreads) for (const x of s.slots) { t += AutoLayout.util.wasteOf(asp.get(x.photoId), x.slot.w * 420 / (x.slot.h * 297)); c++; }
  return t / c;
}

// ── variant 0 is today's plan, byte for byte ─────────────────────────────
// digests of JSON.stringify(planSpreads(items(seed, n), opts)) made on the commit before `variant` existed
const GOLDEN = [
  [12, 1, {}, '20a12a89d880bdae5018a51311fc8f4d2dd32aa1'],
  [20, 2, {}, '3606bc4521b41c9bcb4638057f3d3db974a5df97'],
  [30, 3, { fit: 'cover' }, 'b313c3aea8a99f8c5d1fd6685eb3bcce314590d8'],
  [44, 4, {}, '45fb9b97fd80d9c9e2899991e4c0345f05e69ad3'],
  [60, 5, {}, '7e811981204d20b84cf9b638d506f20f2341d695'],
  [24, 6, { maxSpreads: 4 }, 'a8881bbf8c83f409476e6fb653faf7cce1cfd3b1'],
  [30, 7, { minSpreads: 10 }, 'be117327259b7a5ed6d39f82d54ad026576bfc43'],
];
test('variant 0 / absent / junk: the plan is byte-identical to the one made before variant existed', () => {
  for (const [n, seed, o, digest] of GOLDEN) {
    for (const v of [undefined, 0, -1, 1.5, '2', null, NaN]) {
      const p = plan(items(seed, n), v === undefined ? o : { ...o, variant: v });
      assert.equal(sha(p), digest, `${n} photos ${JSON.stringify(o)} variant ${String(v)}`);
      assert.ok(!('variant' in p), 'variant 0 reports nothing: the object is the old one');
    }
  }
});

// ── variants ───────────────────────────────────────────────────────────
const SEEDS = [1, 2, 3, 4, 5];
const SIZES = [12, 16, 20, 24, 30, 44, 60];
const BOOKS = [...SIZES.map(n => [n, {}]), [30, { maxSpreads: 6 }], [30, { minSpreads: 10 }], [20, { maxSpreads: 4 }], [44, { minSpreads: 16 }]];
const eachBook = fn => { for (const [n, o] of BOOKS) for (const seed of SEEDS) fn(items(seed, n), o, `${n} photos ${JSON.stringify(o)} seed ${seed}`); };

test('variant n > 0 reports result.variant and is deterministic', () => {
  eachBook((it, o, label) => {
    for (const v of [1, 3, 5]) {
      const a = plan(it, { ...o, variant: v }), b = plan(it, { ...o, variant: v });
      assert.equal(a.variant, v, label);
      assert.equal(sha(a), sha(b), `${label} variant ${v}`);
    }
  });
});

test('variants 1..5 give at least 3 distinct plans per book (positive control: variant 0 differs from some variant)', () => {
  let differs = 0, boundedBooks = 0, boundedVaried = 0;
  eachBook((it, o, label) => {
    const set = new Set();
    for (let v = 0; v <= 5; v++) set.add(tpls(plan(it, { ...o, variant: v })));
    const only = new Set();
    for (let v = 1; v <= 5; v++) only.add(tpls(plan(it, { ...o, variant: v })));
    if (!only.has(tpls(plan(it, o)))) differs++;
    // free books: 3. A book with a bound can be forced (20 photos in 4 spreads is 5, 5, 5, 5: nothing to vary): counted, not demanded
    if (!(o.maxSpreads || o.minSpreads)) assert.ok(only.size >= 3, `${label}: only ${only.size} distinct of variants 1..5`);
    else { boundedBooks++; if (only.size >= 3) boundedVaried++; }
  });
  assert.ok(boundedVaried >= boundedBooks / 2, `bounded books that still vary: ${boundedVaried} of ${boundedBooks}`);
  assert.ok(differs > BOOKS.length * SEEDS.length / 2, `variants usually differ from variant 0 (${differs})`);
});

test('hard rules hold for every variant: photos, cover, bounds, fold, hero gap, fit, preferred count', () => {
  eachBook((it, o, label) => {
    const base = plan(it, o);
    for (let v = 1; v <= 5; v++) {
      const p = plan(it, { ...o, variant: v }), l = `${label} variant ${v}`;
      assert.deepEqual(ids(p), ids(base), `${l}: same photos`);
      assert.equal(p.cover.photoId, base.cover.photoId, `${l}: same cover`);
      assert.deepEqual(p.dropped, base.dropped, l);
      if (o.maxSpreads) assert.ok(p.spreads.length <= o.maxSpreads || base.spreads.length > o.maxSpreads, `${l}: maxSpreads`);
      if (o.minSpreads) assert.ok(p.spreads.length >= o.minSpreads || base.spreads.length < o.minSpreads, `${l}: minSpreads`);
      if (o.maxSpreads) assert.equal(p.maxSpreads.met, base.maxSpreads.met, l);
      if (o.minSpreads) assert.equal(p.minSpreads.met, base.minSpreads.met, l);
      assert.equal(p.preferredPerSpread.met, base.preferredPerSpread.met, `${l}: preferredPerSpread`);
      const at = p.spreads.map((s, i) => (spans(s) ? i : -1)).filter(i => i >= 0);
      assert.ok(at.every((x, i) => i === 0 || x - at[i - 1] > HERO_GAP), `${l}: hero gap`);
      assert.ok(p.spreads.every(s => s.slots.every(x => x.fit === 'contain')), `${l}: fit contain`);
    }
  });
});

test('foldSafe holds for every variant: a high-risk photo is never across the fold (positive control: the risky ones exist)', () => {
  const risky = i => (i % 3 === 0 ? 0.95 : 0.1);
  let riskyPlaced = 0;
  for (const n of [20, 30, 44]) for (const seed of SEEDS) {
    const it = items(seed, n, risky), fold = new Map(it.map(x => [x.id, x.foldRisk]));
    for (let v = 0; v <= 5; v++) {
      const p = plan(it, { variant: v });
      for (const s of p.spreads) for (const x of s.slots) {
        riskyPlaced += fold.get(x.photoId) > 0.9 ? 1 : 0;
        if (x.slot.face === 'span') assert.ok(fold.get(x.photoId) < AutoLayout.FOLD.LIMIT, `${n}/${seed}/v${v}: ${x.photoId} across the fold`);
      }
    }
  }
  assert.ok(riskyPlaced > 50);
});

// Waste bound. Variant 0 is the cheapest book; a variant swaps near-equal choices, so it may waste a little more (or less).
// Bound: mean slot waste (0..1) of a variant within +0.02 of variant 0 on average over all books, and within +0.08 for any one
// book (measured on these books: mean about +0.005, worst about +0.065; 0.08 is 8 percentage points of one frame's area).
test('quality stays close to variant 0: mean waste +0.02 at most, any single book +0.08', () => {
  let sum = 0, cnt = 0, worst = -1;
  eachBook((it, o, label) => {
    const w0 = waste(plan(it, o), it);
    for (let v = 1; v <= 5; v++) {
      const d = waste(plan(it, { ...o, variant: v }), it) - w0;
      sum += d; cnt++; worst = Math.max(worst, d);
      assert.ok(d <= 0.08, `${label} variant ${v}: waste +${d.toFixed(3)}`);
    }
  });
  assert.ok(sum / cnt <= 0.02, `mean +${(sum / cnt).toFixed(4)}`);
  assert.ok(cnt >= 200);
});
