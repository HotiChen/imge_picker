// node --test book_editor/test/plan_spreads_minspreads.test.mjs
//
// planSpreads({ minSpreads }): the product (相本書) needs at least N spreads INSIDE the book (cover and back are not
// counted). The planner reaches N with fewer photos per spread, single-photo spreads and through-spreads (heroes),
// never by cropping (fit stays 'contain'), never by dropping a photo, and reports { wanted, achieved, met,
// photosNeeded }. Synthetic items only (what analyze() returns).
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
const ST = vm.runInThisContext('SpreadTemplates');

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

// every rule that does not depend on minSpreads, plus the no-crop promise
function validBook(p, items, label) {
  const T = p.spreads.map(s => s.template);
  const placed = placedOf(p);
  assert.equal(new Set(placed).size, placed.length, `${label}: a photo twice`);
  const usable = items.filter(i => i.ok).length;
  assert.equal(placed.length, usable === 1 ? 0 : (usable <= 3 ? usable - 1 : usable), `${label}: a photo was dropped or invented`);
  for (const id of placed) assert.ok(items.some(i => i.id === id));
  p.spreads.forEach((sp, n) => {
    assert.equal(sp.id, `spread-${n + 1}`);
    const t = ST.byId(sp.template);
    assert.ok(t, `${label}: unknown template`);
    assert.ok(ST.validate([t]).ok, `${label}: ${t.id} fails the validator`);
    assert.equal(sp.slots.length, t.slots.length);
    sp.slots.forEach((s, i) => {
      assert.equal(s.fit, 'contain', `${label}: slot not contain`);
      assert.deepEqual(s.crop, { x: 0, y: 0, scale: 1 }, `${label}: a crop`);
      assert.deepEqual({ ...s.slot }, { x: t.slots[i].x, y: t.slots[i].y, w: t.slots[i].w, h: t.slots[i].h, face: t.slots[i].face });
    });
    const left = t.slots.filter(s => s.face === 'left').length, right = t.slots.filter(s => s.face === 'right').length;
    assert.ok(left <= 4 && right <= 4);
  });
  if (p.cover) { assert.equal(p.cover.fit, 'contain'); assert.deepEqual(p.cover.crop, { x: 0, y: 0, scale: 1 }); }
  for (let i = 1; i < T.length; i++) assert.notEqual(T[i], T[i - 1], `${label}: ${T[i]} twice running at ${i}`);
  for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `${label}: two heroes within 5 spreads at ${i}`);
}

// ── the contract ────────────────────────────────────────────────────────────
test('no minSpreads: no minSpreads key, the old result; invalid values are ignored the same way', () => {
  const items = mixed(1, 30);
  const base = AutoLayout.planSpreads(items);
  assert.equal(base.minSpreads, undefined);
  for (const bad of [undefined, null, 0, -3, NaN, 'x', {}, Infinity, 0.4]) {
    const p = AutoLayout.planSpreads(items, { minSpreads: bad });
    assert.equal(JSON.stringify(p), JSON.stringify(base), `minSpreads: ${String(bad)} must be ignored`);
  }
});

test('minSpreads 10 on 8 photos: not feasible, met:false, photosNeeded reported (> 8), nothing dropped, best achievable plan', () => {
  for (const seed of [1, 2, 3, 4]) {
    const items = mixed(seed, 8);
    const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
    assert.equal(p.minSpreads.wanted, 10);
    assert.equal(p.minSpreads.met, false);
    assert.equal(p.minSpreads.achieved, p.spreads.length);
    assert.ok(p.spreads.length < 10);
    assert.ok(p.minSpreads.photosNeeded > 8, `seed ${seed}: photosNeeded ${p.minSpreads.photosNeeded}`);
    assert.ok(p.minSpreads.photosNeeded >= 10, 'one photo per spread is the very least');
    validBook(p, items, `8 photos seed ${seed}`);
    const natural = AutoLayout.planSpreads(items);
    assert.ok(p.spreads.length > natural.spreads.length, 'it got as close as it could: more spreads than the natural plan');
  }
});

test('minSpreads 10 on 14 photos: met (mixed portrait and landscape), no crop, hero gap intact, validator passes', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const items = mixed(seed, 14);
    const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
    assert.equal(p.minSpreads.met, true, `seed ${seed}: ${JSON.stringify(p.minSpreads)}`);
    assert.ok(p.spreads.length >= 10, `seed ${seed}: ${p.spreads.length} spreads`);
    assert.equal(p.minSpreads.achieved, p.spreads.length);
    assert.equal(p.minSpreads.wanted, 10);
    assert.ok(p.minSpreads.photosNeeded <= 14, `seed ${seed}`);
    validBook(p, items, `14 photos seed ${seed}`);
  }
});

test('40 photos with minSpreads 10: the result is exactly the one without minSpreads, plus the report', () => {
  for (const seed of [1, 2, 3]) {
    const items = mixed(seed, 40);
    const a = AutoLayout.planSpreads(items), b = AutoLayout.planSpreads(items, { minSpreads: 10 });
    assert.ok(a.spreads.length >= 8, 'control');
    const { minSpreads, ...rest } = b;
    assert.equal(JSON.stringify(rest), JSON.stringify(a), `seed ${seed}: a wanted count that is already met changed the plan`);
    assert.equal(minSpreads.met, true);
    assert.equal(minSpreads.achieved, a.spreads.length);
    if (a.spreads.length < 10) assert.fail('40 photos should make 10 spreads by themselves');
  }
});

test('met exactly when the natural plan is short: a count between natural and the maximum is reached with the fewest extra spreads', () => {
  const items = mixed(7, 24);
  const nat = AutoLayout.planSpreads(items).spreads.length;
  const want = nat + 2;
  const p = AutoLayout.planSpreads(items, { minSpreads: want });
  assert.equal(p.minSpreads.met, true);
  assert.ok(p.spreads.length >= want && p.spreads.length <= want + 1, `${nat} natural, wanted ${want}, got ${p.spreads.length}`);
  validBook(p, items, 'between');
});

test('photosNeeded is exact on a uniform book: planning that many photos meets, one fewer does not', () => {
  for (const aspect of [1.5, 0.667, 1.0]) {
    for (const want of [3, 6, 10]) {
      const p = AutoLayout.planSpreads(uniform(5, aspect), { minSpreads: want });
      const need = p.minSpreads.photosNeeded;
      assert.ok(Number.isInteger(need) && need >= want, `aspect ${aspect} want ${want}: ${need}`);
      const at = AutoLayout.planSpreads(uniform(need, aspect), { minSpreads: want });
      assert.equal(at.minSpreads.met, true, `aspect ${aspect} want ${want}: ${need} photos should meet`);
      const below = AutoLayout.planSpreads(uniform(need - 1, aspect), { minSpreads: want });
      assert.equal(below.minSpreads.met, false, `aspect ${aspect} want ${want}: ${need - 1} photos should not`);
      // and everything above keeps meeting it (the search assumes that)
      for (let n = need; n <= need + 8; n++) assert.equal(AutoLayout.planSpreads(uniform(n, aspect), { minSpreads: want }).minSpreads.met, true, `n=${n}`);
    }
  }
});

test('photosNeeded is the same number whatever the photo count of the call (it is a property of the aspect mix)', () => {
  const items = mixed(9, 30);
  const a = AutoLayout.planSpreads(items, { minSpreads: 10 }).minSpreads.photosNeeded;
  const b = AutoLayout.planSpreads(items.slice(0, 12), { minSpreads: 10 }).minSpreads.photosNeeded;
  assert.ok(Number.isInteger(a) && Number.isInteger(b));
  assert.ok(Math.abs(a - b) <= 3, `${a} vs ${b}: the aspect mix of the first 12 differs a little, not a lot`);
});

test('wanted 1 and 2: the cover is not a spread; 1 photo is a cover alone', () => {
  const one = AutoLayout.planSpreads(mixed(1, 1), { minSpreads: 1 });
  assert.equal(one.spreads.length, 0);
  assert.deepEqual(one.minSpreads, { wanted: 1, achieved: 0, met: false, photosNeeded: 2 });
  const two = AutoLayout.planSpreads(mixed(1, 2), { minSpreads: 1 });
  assert.equal(two.minSpreads.met, true);
  assert.equal(two.spreads.length, 1);
  const none = AutoLayout.planSpreads([], { minSpreads: 10 });
  assert.equal(none.spreads.length, 0);
  assert.equal(none.minSpreads.met, false);
  assert.equal(none.minSpreads.achieved, 0);
  assert.ok(none.minSpreads.photosNeeded >= 10);
  assert.equal(none.cover, null);
});

test('back: true adds a blank page that is not counted', () => {
  const items = mixed(2, 16);
  const p = AutoLayout.planSpreads(items, { minSpreads: 10, back: true });
  assert.deepEqual(p.back, {});
  assert.equal(p.minSpreads.achieved, p.spreads.length);
  validBook(p, items, 'back');
});

test('fractions are rounded down: 9.9 means 9', () => {
  const items = mixed(3, 14);
  assert.equal(AutoLayout.planSpreads(items, { minSpreads: 9.9 }).minSpreads.wanted, 9);
});

// ── shapes of books ─────────────────────────────────────────────────────────
test('all portrait, all landscape, panoramas: reaches the count with enough photos, never crops, never throws', () => {
  for (const [name, pool] of [['portrait', [0.667, 0.75, 0.8]], ['landscape', [1.5, 1.333, 1.778]], ['harsh', [2.4, 0.4, 1.5, 0.5625]]]) {
    for (const n of [4, 8, 14, 20, 26]) {
      const items = mixed(40 + n, n, pool);
      const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
      validBook(p, items, `${name} ${n}`);
      assert.equal(p.minSpreads.achieved, p.spreads.length);
      assert.equal(p.minSpreads.met, p.spreads.length >= 10);
      if (n >= 26) assert.equal(p.minSpreads.met, true, `${name} ${n}: ${JSON.stringify(p.minSpreads)}`);
    }
  }
});

test('the 45% floor does not make the minimum fail: with all portrait photos the spreads may be emptier, but the count is met', () => {
  const items = mixed(77, 20, [0.667, 0.667, 0.75]);
  const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
  assert.equal(p.minSpreads.met, true, JSON.stringify(p.minSpreads));
  validBook(p, items, 'portrait floor');
});

test('hero spacing: heroes are used to get there but never closer than 5 spreads (at most 1 in any 5), even in the best-effort plan', () => {
  for (const n of [6, 9, 12, 14, 18]) {
    const items = mixed(90 + n, n, [1.5, 1.5, 1.778, 1.333, 0.667]);
    const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
    const T = p.spreads.map(s => s.template);
    for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `n=${n} at ${i}: ${T.join(',')}`);
  }
});

test('a lone photo on a non-hero spread appears only when needed (single quiet pages), and only when minSpreads is asked for', () => {
  const items = mixed(5, 14);
  const natural = AutoLayout.planSpreads(items);
  assert.ok(natural.spreads.every(s => s.slots.length > 1 || isHero(s.template)), 'control: the natural plan has no lone non-hero photo');
  const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
  assert.ok(p.spreads.some(s => s.slots.length === 1), 'the minimum needs single-photo spreads here');
});

test('rules are given up one at a time: where single quiet pages are enough, the family-run rule still holds', () => {
  let checked = 0;
  for (const n of [16, 18, 20, 22, 24]) {
    for (const seed of [1, 2, 3, 4]) {
      const items = mixed(seed * 10 + n, n);
      const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
      if (!p.minSpreads.met) continue;
      const T = p.spreads.map(s => s.template);
      for (let i = 2; i < T.length; i++) assert.ok(!(tag(T[i])[0] === tag(T[i - 1])[0] && tag(T[i - 1])[0] === tag(T[i - 2])[0]), `n=${n} seed=${seed}: family ${tag(T[i])[0]} three running at ${i}`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `only ${checked} plans checked`);
});

test('the last spread is never a stray non-hero photo unless the plan cannot avoid it, and the cover photo is a valid cover', () => {
  for (const n of [14, 15, 16, 18, 20]) {
    const items = mixed(n, n);
    const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
    const last = p.spreads[p.spreads.length - 1];
    assert.ok(last.slots.length >= 2 || isHero(last.template), `n=${n}: ${last.template}`);
    assert.ok(items.some(i => i.id === p.cover.photoId));
  }
});

test('with look-alikes too: minSpreads and the separation work together, no throw, all photos kept', () => {
  const items = mixed(3, 20);
  items[5] = { ...items[5], hash: items[4].hash }; items[6] = { ...items[6], hash: items[4].hash };
  const p = AutoLayout.planSpreads(items, { minSpreads: 10 });
  assert.equal(placedOf(p).length, 20);
  assert.ok(p.minSpreads.met);
  validBook(p, items, 'sim+min');
  assert.equal(p.dropped.length, 0);
});

test('deterministic, pure, input untouched', () => {
  const items = mixed(4, 14);
  const frozen = JSON.stringify(items);
  const a = AutoLayout.planSpreads(items, { minSpreads: 10 }), b = AutoLayout.planSpreads(JSON.parse(frozen), { minSpreads: 10 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('random'); }; Date.now = () => { throw new Error('clock'); };
  try { AutoLayout.planSpreads(items, { minSpreads: 10 }); } finally { Math.random = r; Date.now = n; }
});

test('a custom templates list without single-photo templates: best effort, still no throw, met:false and photosNeeded null or larger', () => {
  const noSingles = ST.TEMPLATES.filter(t => t.slots.length >= 2);
  const items = mixed(6, 14);
  const p = AutoLayout.planSpreads(items, { minSpreads: 10, templates: noSingles });
  assert.equal(p.minSpreads.met, false);
  assert.ok(p.minSpreads.photosNeeded === null || p.minSpreads.photosNeeded > 14);
  assert.equal(p.minSpreads.achieved, p.spreads.length);
});

test('minSpreads never switches the fit: default is contain, and an explicit cover stays cover', () => {
  const items = mixed(8, 16);
  const con = AutoLayout.planSpreads(items, { minSpreads: 10 });
  assert.ok(con.spreads.every(s => s.slots.every(x => x.fit === 'contain')));
  const cov = AutoLayout.planSpreads(items, { minSpreads: 10, fit: 'cover' });
  assert.ok(cov.spreads.every(s => s.slots.every(x => !('fit' in x))));
});

test('speed: a not-met plan and its photosNeeded search stay cheap (240 photos, wanted 40; 8 photos, wanted 60)', () => {
  const t0 = Date.now();
  AutoLayout.planSpreads(mixed(1, 240), { minSpreads: 40 });
  AutoLayout.planSpreads(mixed(1, 8), { minSpreads: 60 });
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});
