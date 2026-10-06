// node --test book_editor/test/plan_spreads_maxspreads.test.mjs
//
// planSpreads({ maxSpreads }): the product caps the inside spreads at N. The planner stays at or under N by packing more
// photos on each spread (up to 8, at most 4 per face), never by cropping (fit stays 'contain') and never by dropping a
// photo; when even the densest packing does not fit it returns the densest plan with met:false and photosAllowed.
// Synthetic items only (what analyze() returns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lcg } from './legacy-fixture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');
vm.runInThisContext(read('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(read('spread_templates.js'), { filename: 'spread_templates.js' });
vm.runInThisContext(read('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
// foldSafe (default true, plan_spreads_foldsafe.test.mjs) needs a foldRisk on every item; the fixtures here carry none,
// so they run the planner without that rule (the behaviour every assertion in this file was written against).
{ const planSpreads = AutoLayout.planSpreads; AutoLayout.planSpreads = (items, o = {}) => planSpreads(items, { foldSafe: false, ...o }); }
const ST = vm.runInThisContext('SpreadTemplates');
const hamming = AutoLayout.util.hamming;

const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
const pad = n => String(n).padStart(3, '0');
const mk = (i, aspect, sharp, hseed) => ({ id: `IMG_${pad(i + 1)}.jpg`, ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(hseed * 1000 + i),
  sharpness: sharp, focus: { x: 0.5, y: 0.5 } });
const NORMAL = [1.5, 1.5, 1.333, 1.5, 0.667, 0.667, 0.8, 0.75, 1.0, 1.778, 0.5625];
const mixed = (seed, n, pool = NORMAL) => { const rnd = lcg(seed); return Array.from({ length: n }, (_, i) => mk(i, pool[Math.floor(rnd() * pool.length)], Math.floor(rnd() * 100), seed)); };
const uniform = (n, aspect) => Array.from({ length: n }, (_, i) => mk(i, aspect, 50 + (i % 7), 9));
const placedOf = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId));
const tag = id => ST.byId(id).tags;
const isHero = id => tag(id).includes('hero');
const faces = t => ({ left: t.slots.filter(s => s.face === 'left').length, right: t.slots.filter(s => s.face === 'right').length });

// every rule that does not depend on a bound, plus the no-crop and nothing-dropped promises
function validBook(p, items, label) {
  const T = p.spreads.map(s => s.template);
  const placed = placedOf(p);
  const usable = items.filter(i => i.ok).length;
  assert.equal(new Set(placed).size, placed.length, `${label}: a photo twice`);
  assert.equal(placed.length, usable === 1 ? 0 : (usable <= 3 ? usable - 1 : usable), `${label}: a photo was dropped or invented`);
  assert.deepEqual(p.dropped, [], `${label}: nothing may be dropped`);
  p.spreads.forEach((sp, n) => {
    assert.equal(sp.id, `spread-${n + 1}`);
    const t = ST.byId(sp.template);
    assert.ok(t && ST.validate([t]).ok, `${label}: ${sp.template} fails the validator`);
    assert.equal(sp.slots.length, t.slots.length);
    const f = faces(t);
    assert.ok(f.left <= 4 && f.right <= 4, `${label}: more than 4 on a face`);
    assert.ok(sp.slots.length <= 8);
    sp.slots.forEach((s, i) => {
      assert.equal(s.fit, 'contain', `${label}: slot not contain`);
      assert.deepEqual(s.crop, { x: 0, y: 0, scale: 1 }, `${label}: a crop`);
      assert.deepEqual({ ...s.slot }, { x: t.slots[i].x, y: t.slots[i].y, w: t.slots[i].w, h: t.slots[i].h, face: t.slots[i].face });
    });
  });
  if (p.cover) { assert.equal(p.cover.fit, 'contain'); assert.deepEqual(p.cover.crop, { x: 0, y: 0, scale: 1 }); }
  for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `${label}: two heroes within 5 spreads at ${i}`);
}

// ── the contract ────────────────────────────────────────────────────────────
test('no maxSpreads: no maxSpreads key and the old result; invalid values are ignored the same way', () => {
  const items = mixed(1, 30);
  const base = AutoLayout.planSpreads(items);
  assert.equal(base.maxSpreads, undefined);
  for (const bad of [undefined, null, 0, -3, NaN, 'x', {}, Infinity, 0.4]) {
    assert.equal(JSON.stringify(AutoLayout.planSpreads(items, { maxSpreads: bad })), JSON.stringify(base), `maxSpreads: ${String(bad)} must be ignored`);
  }
});

test('a maximum the natural plan already meets changes nothing but the report', () => {
  for (const seed of [1, 2, 3]) {
    const items = mixed(seed, 40);
    const a = AutoLayout.planSpreads(items), b = AutoLayout.planSpreads(items, { maxSpreads: 30 });
    const { maxSpreads, ...rest } = b;
    assert.equal(JSON.stringify(rest), JSON.stringify(a), `seed ${seed}`);
    assert.equal(maxSpreads.met, true);
    assert.equal(maxSpreads.wanted, 30);
    assert.equal(maxSpreads.achieved, a.spreads.length);
    assert.equal(a.spreads.length <= 30, true);
  }
});

test('feasible maximum: 40 photos in at most 8 spreads, denser spreads, every photo kept once, contain, valid', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const items = mixed(seed, 40);
    const nat = AutoLayout.planSpreads(items).spreads.length;
    assert.ok(nat > 8, 'control: the natural plan is over the limit');
    const p = AutoLayout.planSpreads(items, { maxSpreads: 8 });
    assert.equal(p.maxSpreads.met, true, `seed ${seed}: ${JSON.stringify(p.maxSpreads)}`);
    assert.ok(p.spreads.length <= 8, `seed ${seed}: ${p.spreads.length} spreads`);
    assert.equal(p.maxSpreads.achieved, p.spreads.length);
    assert.equal(p.maxSpreads.wanted, 8);
    assert.ok(p.maxSpreads.photosAllowed >= 40);
    validBook(p, items, `max 8 seed ${seed}`);
  }
});

test('exactly at the limit: 8 photos a spread, 5 spreads for 40 photos; 8 * N photos fit N spreads, one more does not', () => {
  const items = mixed(2, 40);
  const p = AutoLayout.planSpreads(items, { maxSpreads: 5 });
  assert.equal(p.maxSpreads.met, true);
  assert.equal(p.spreads.length, 5);
  assert.ok(p.spreads.every(s => s.slots.length === 8), 'every spread is full');
  validBook(p, items, 'at the limit');
  for (const x of [2, 3, 5]) {
    const at = AutoLayout.planSpreads(mixed(x, 8 * x), { maxSpreads: x });
    assert.equal(at.maxSpreads.met, true, `${8 * x} photos in ${x} spreads`);
    assert.equal(at.spreads.length, x);
    validBook(at, mixed(x, 8 * x), `exact ${x}`);
    const over = AutoLayout.planSpreads(mixed(x, 8 * x + 1), { maxSpreads: x });
    assert.equal(over.maxSpreads.met, false, `${8 * x + 1} photos cannot fit ${x} spreads`);
  }
});

test('infeasible: 40 photos in 4 spreads: met false, the densest plan (5 spreads), photosAllowed 32, nothing dropped', () => {
  for (const seed of [1, 2, 3]) {
    const items = mixed(seed, 40);
    const p = AutoLayout.planSpreads(items, { maxSpreads: 4 });
    assert.equal(p.maxSpreads.met, false);
    assert.equal(p.maxSpreads.photosAllowed, 32);
    assert.equal(p.maxSpreads.achieved, p.spreads.length);
    assert.equal(p.spreads.length, 5, 'ceil(40 / 8): as dense as it can be');
    assert.equal(placedOf(p).length, 40);
    validBook(p, items, `infeasible ${seed}`);
  }
});

test('photosAllowed is exact: that many photos fit (real planning), one more does not', () => {
  for (const aspect of [1.5, 0.667, 1.0]) {
    for (const x of [1, 2, 3, 5, 8]) {
      const p = AutoLayout.planSpreads(uniform(6, aspect), { maxSpreads: x });
      const allowed = p.maxSpreads.photosAllowed;
      assert.equal(allowed, 8 * x, `aspect ${aspect} max ${x}`);
      assert.equal(AutoLayout.planSpreads(uniform(allowed, aspect), { maxSpreads: x }).maxSpreads.met, true, `${allowed} photos`);
      assert.equal(AutoLayout.planSpreads(uniform(allowed + 1, aspect), { maxSpreads: x }).maxSpreads.met, false, `${allowed + 1} photos`);
    }
  }
});

test('small books: one photo is a cover alone (0 spreads), a maximum of 1 holds up to 8 photos', () => {
  const one = AutoLayout.planSpreads(mixed(1, 1), { maxSpreads: 1 });
  assert.equal(one.spreads.length, 0);
  assert.equal(one.maxSpreads.met, true);
  assert.equal(one.maxSpreads.achieved, 0);
  assert.equal(AutoLayout.planSpreads([], { maxSpreads: 3 }).maxSpreads.met, true);
  for (const n of [2, 3, 4, 8]) {
    const p = AutoLayout.planSpreads(mixed(n, n), { maxSpreads: 1 });
    assert.equal(p.maxSpreads.met, true, `n=${n}`);
    assert.equal(p.spreads.length, 1);
  }
  assert.equal(AutoLayout.planSpreads(mixed(9, 9), { maxSpreads: 1 }).maxSpreads.met, false);
});

test('all portrait, all landscape, panoramas: a feasible maximum is met with no crop, in every shape of book', () => {
  for (const [name, pool] of [['portrait', [0.667, 0.75, 0.8]], ['landscape', [1.5, 1.333, 1.778]], ['harsh', [2.4, 0.4, 1.5, 0.5625]]]) {
    for (const [n, x] of [[24, 6], [40, 8], [30, 4], [16, 2]]) {
      const items = mixed(n * 3 + x, n, pool);
      const p = AutoLayout.planSpreads(items, { maxSpreads: x });
      validBook(p, items, `${name} ${n}/${x}`);
      assert.equal(p.maxSpreads.met, p.spreads.length <= x);
      assert.ok(p.maxSpreads.met, `${name} ${n} in ${x}: ${JSON.stringify(p.maxSpreads)}`);
    }
  }
});

// ── both bounds ─────────────────────────────────────────────────────────────
test('both bounds, minSpreads <= maxSpreads: the plan lands inside the window and reports both', () => {
  for (const [n, lo, hi] of [[14, 10, 12], [40, 6, 8], [24, 6, 10], [40, 10, 14]]) {
    const items = mixed(n, n);
    const p = AutoLayout.planSpreads(items, { minSpreads: lo, maxSpreads: hi });
    assert.ok(p.spreads.length >= lo && p.spreads.length <= hi, `${n} photos [${lo}..${hi}]: ${p.spreads.length}`);
    assert.equal(p.minSpreads.met, true);
    assert.equal(p.maxSpreads.met, true);
    assert.equal(p.minSpreads.achieved, p.spreads.length);
    assert.equal(p.maxSpreads.achieved, p.spreads.length);
    assert.equal(p.minSpreads.wanted, lo); assert.equal(p.maxSpreads.wanted, hi);
    assert.ok(Number.isInteger(p.minSpreads.photosNeeded) && Number.isInteger(p.maxSpreads.photosAllowed));
    validBook(p, items, `window ${n}`);
  }
});

test('both bounds, window impossible for these photos: best effort, met false on the one that fails', () => {
  const few = mixed(3, 8);                                      // too few for 10..12
  const a = AutoLayout.planSpreads(few, { minSpreads: 10, maxSpreads: 12 });
  assert.equal(a.minSpreads.met, false);
  assert.equal(a.maxSpreads.met, true);
  const many = mixed(3, 60);                                   // too many for 3..4 (cap 32)
  const b = AutoLayout.planSpreads(many, { minSpreads: 3, maxSpreads: 4 });
  assert.equal(b.maxSpreads.met, false);
  assert.equal(b.minSpreads.met, true);
  validBook(a, few, 'few'); validBook(b, many, 'many');
});

test('minSpreads greater than maxSpreads is a caller error: no throw, both met:false, the minimum is the one ignored', () => {
  const items = mixed(4, 30);
  const p = AutoLayout.planSpreads(items, { minSpreads: 12, maxSpreads: 8 });
  assert.equal(p.minSpreads.met, false);
  assert.equal(p.maxSpreads.met, false);
  for (const r of [p.minSpreads, p.maxSpreads]) {
    assert.equal(r.error, 'minSpreads-greater-than-maxSpreads');
    assert.equal(r.ignored, 'minSpreads');
    assert.equal(r.achieved, p.spreads.length);
  }
  assert.equal(p.minSpreads.wanted, 12); assert.equal(p.maxSpreads.wanted, 8);
  assert.equal(p.minSpreads.photosNeeded, null);
  assert.equal(p.maxSpreads.photosAllowed, null);
  const maxOnly = AutoLayout.planSpreads(items, { maxSpreads: 8 });
  assert.equal(JSON.stringify(p.spreads), JSON.stringify(maxOnly.spreads), 'the plan is the one the maximum alone gives');
  assert.ok(p.spreads.length <= 8);
  validBook(p, items, 'min>max');
  assert.doesNotThrow(() => AutoLayout.planSpreads([], { minSpreads: 5, maxSpreads: 2 }));
  assert.doesNotThrow(() => AutoLayout.planSpreads(mixed(1, 1), { minSpreads: 5, maxSpreads: 2 }));
  // the minimum is never "met" by a plan that busts the maximum: 40 photos cannot fit 2 spreads, the plan has 5 >= 3
  const big = AutoLayout.planSpreads(mixed(4, 40), { minSpreads: 3, maxSpreads: 2 });
  assert.equal(big.minSpreads.met, false);
  assert.equal(big.maxSpreads.met, false);
  assert.ok(big.spreads.length >= 3);
  const eq = AutoLayout.planSpreads(items, { minSpreads: 8, maxSpreads: 8 });
  assert.equal(eq.minSpreads.error, undefined, 'equal bounds are not an error');
  assert.equal(eq.spreads.length, 8);
});

// ── the rest of the engine around it ────────────────────────────────────────
test('hero spacing and the template rules hold at every maximum (heroes never closer than 5 spreads)', () => {
  for (const [n, x] of [[40, 8], [40, 5], [60, 10], [24, 4]]) {
    const items = mixed(n + x, n, [1.5, 1.778, 1.5, 0.667, 1.333]);
    const p = AutoLayout.planSpreads(items, { maxSpreads: x });
    const T = p.spreads.map(s => s.template);
    for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `${n}/${x}: ${T.join(',')}`);
    for (const s of p.spreads) assert.ok(s.slots.length >= 2 || isHero(s.template), `${n}/${x}: lone ${s.template}`);
  }
});

test('look-alikes yield to the maximum: 16 look-alikes in 2 spreads are together, counted in similarPairs and similarSpreads', () => {
  const base = hashOf(5);
  const items = mixed(6, 16).map(i => ({ ...i, hash: base }));
  const p = AutoLayout.planSpreads(items, { maxSpreads: 2 });
  assert.equal(p.maxSpreads.met, true);
  assert.equal(p.spreads.length, 2);
  const byId = new Map(items.map(i => [i.id, i]));
  let measured = 0;
  for (const sp of p.spreads) { const ids = sp.slots.map(s => s.photoId); for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) if (hamming(byId.get(ids[a]).hash, byId.get(ids[b]).hash) <= 12 && Math.abs(items.findIndex(i => i.id === ids[a]) - items.findIndex(i => i.id === ids[b])) <= 7) measured++; }  // pairs inside the similarWindow (7)
  assert.ok(measured > 0);
  assert.equal(p.similarPairs, measured, 'every pair that ended up together is counted');
  assert.deepEqual(p.similarSpreads, ['spread-1', 'spread-2']);
  assert.equal(placedOf(p).length, 16);
  assert.deepEqual(p.dropped, []);
});

test('look-alikes are still kept apart under a maximum when there is room (a pair of them, 40 photos, max 8)', () => {
  const items = mixed(7, 40);
  items[10] = { ...items[10], hash: items[11].hash };
  const p = AutoLayout.planSpreads(items, { maxSpreads: 8 });
  assert.equal(p.maxSpreads.met, true);
  assert.equal(p.similarPairs, 0);
});

test('works in cover fit and with back: true (the blank back is not a spread)', () => {
  const items = mixed(8, 30);
  const cov = AutoLayout.planSpreads(items, { maxSpreads: 6, fit: 'cover' });
  assert.ok(cov.spreads.length <= 6 && cov.maxSpreads.met);
  assert.ok(cov.spreads.every(s => s.slots.every(x => !('fit' in x))));
  const back = AutoLayout.planSpreads(items, { maxSpreads: 6, back: true });
  assert.deepEqual(back.back, {});
  assert.equal(back.maxSpreads.achieved, back.spreads.length);
});

test('deterministic, pure, input untouched', () => {
  const items = mixed(9, 40);
  const frozen = JSON.stringify(items);
  const a = AutoLayout.planSpreads(items, { maxSpreads: 7 }), b = AutoLayout.planSpreads(JSON.parse(frozen), { maxSpreads: 7 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('random'); }; Date.now = () => { throw new Error('clock'); };
  try { AutoLayout.planSpreads(items, { maxSpreads: 7 }); } finally { Math.random = r; Date.now = n; }
});

test('a maximum is fractions-rounded down: 7.9 means 7', () => {
  assert.equal(AutoLayout.planSpreads(mixed(3, 40), { maxSpreads: 7.9 }).maxSpreads.wanted, 7);
});

test('speed: 240 photos in 30 spreads (all eight-up) and an impossible 240 in 20 stay cheap', () => {
  const t0 = Date.now();
  const a = AutoLayout.planSpreads(mixed(1, 240), { maxSpreads: 30 });
  const b = AutoLayout.planSpreads(mixed(1, 240), { maxSpreads: 20 });
  assert.equal(a.maxSpreads.met, true);
  assert.equal(b.maxSpreads.met, false);
  assert.equal(b.spreads.length, 30);
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
});

test('a template list that cannot hold more than 4 photos a spread: photosAllowed follows it, the best plan is still returned', () => {
  const small = ST.TEMPLATES.filter(t => t.slots.length <= 4);
  const items = mixed(10, 20);
  const p = AutoLayout.planSpreads(items, { maxSpreads: 3, templates: small });
  assert.equal(p.maxSpreads.met, false);
  assert.equal(p.maxSpreads.photosAllowed, 12);
  assert.equal(placedOf(p).length, 20);
});
