// node --test book_editor/test/preferred_per_spread.test.mjs
//
// planSpreads option preferredPerSpread (default 5; 0 / null = the old behaviour): a spread normally holds at most that
// many photos. A preference only: maxSpreads (hard) beats it, the cap is raised by the least that fits, and the result
// reports { wanted, met, overflowSpreads }.
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
const plan = (items, o = {}) => AutoLayout.planSpreads(items, { foldSafe: false, ...o });

const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625];
const pad = n => String(n).padStart(3, '0');
function items(seed, n) {
  const rnd = lcg(seed), out = [];
  for (let i = 0; i < n; i++) {
    const aspect = POOL[Math.floor(rnd() * POOL.length)];
    out.push({ id: `IMG_${pad(i + 1)}.jpg`, ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(seed * 1000 + i),
      sharpness: Math.floor(rnd() * 100), focus: { x: rnd(), y: rnd() } });
  }
  return out;
}
const sizes = p => p.spreads.map(s => s.slots.length);
const placed = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId)).sort();

test('default: no spread holds more than 5 photos, and the report says so', () => {
  for (const seed of [1, 2, 3, 4, 5]) for (const n of [12, 30, 61]) {
    const p = plan(items(seed, n));
    assert.ok(p.spreads.length > 0);
    assert.ok(Math.max(...sizes(p)) <= 5, `seed ${seed} n ${n}: ${sizes(p)}`);
    assert.deepEqual(p.preferredPerSpread, { wanted: 5, met: true, overflowSpreads: 0 });
  }
});

test('positive case: without the cap the same books do use 6+ photo spreads (the cap changes something)', () => {
  let big = 0;
  for (const seed of [1, 2, 3, 4, 5]) for (const n of [12, 30, 61]) {
    if (Math.max(...sizes(plan(items(seed, n), { preferredPerSpread: 0 }))) > 5) big++;
  }
  assert.ok(big > 0, 'old behaviour never used a 6+ spread on these books: the cap tests prove nothing');
});

test('0 and null are the old behaviour, with no report key', () => {
  const it = items(7, 40);
  const a = plan(it, { preferredPerSpread: 0 }), b = plan(it, { preferredPerSpread: null });
  assert.equal(a.preferredPerSpread, undefined);
  assert.equal(b.preferredPerSpread, undefined);
  assert.deepEqual(a, b);
});

test('a custom value: 3 caps every spread at 3 photos', () => {
  const p = plan(items(2, 30), { preferredPerSpread: 3 });
  assert.ok(Math.max(...sizes(p)) <= 3, String(sizes(p)));
  assert.deepEqual(p.preferredPerSpread, { wanted: 3, met: true, overflowSpreads: 0 });
});

test('all photos kept, none repeated, with the cap', () => {
  const it = items(3, 33);
  const p = plan(it);
  const want = it.map(i => i.id).sort();
  const got = placed(p);
  // the cover photo is repeated inside (4+ photos), so every id appears once inside
  assert.deepEqual(got, want);
});

test('maxSpreads wins: 40 photos in 6 spreads cannot be <= 5 each; the cap rises by the least, and it is reported', () => {
  const it = items(4, 40);
  const p = plan(it, { maxSpreads: 6 });
  assert.equal(p.spreads.length <= 6, true);
  assert.equal(p.maxSpreads.met, true);
  assert.equal(placed(p).length, 40);
  const over = sizes(p).filter(k => k > 5).length;
  assert.ok(over > 0);
  assert.ok(Math.max(...sizes(p)) <= 7, `cap should only rise to 7 (ceil(40/6)): ${sizes(p)}`);
  assert.deepEqual(p.preferredPerSpread, { wanted: 5, met: false, overflowSpreads: over });
});

test('a roomy maxSpreads changes nothing but the report', () => {
  const it = items(4, 40);
  const base = plan(it), withMax = plan(it, { maxSpreads: 30 });
  const { maxSpreads, ...rest } = withMax;
  assert.deepEqual(rest, base);
  assert.equal(maxSpreads.met, true);
  assert.equal(withMax.preferredPerSpread.met, true);
});

test('maxSpreads that nothing can meet: all photos kept, densest plan, reported not met', () => {
  const it = items(5, 100);
  const p = plan(it, { maxSpreads: 5 });
  assert.equal(p.maxSpreads.met, false);
  assert.equal(placed(p).length, 100);
  assert.equal(p.preferredPerSpread.met, false);
  assert.ok(p.preferredPerSpread.overflowSpreads > 0);
});

test('minSpreads is still met with the cap on (more spreads, not fewer)', () => {
  const p = plan(items(6, 30), { minSpreads: 12 });
  assert.equal(p.minSpreads.met, true);
  assert.ok(p.spreads.length >= 12);
  assert.ok(Math.max(...sizes(p)) <= 5);
  assert.equal(p.preferredPerSpread.met, true);
});

test('min and max together keep both, the max beating the preference', () => {
  const p = plan(items(8, 40), { minSpreads: 5, maxSpreads: 6 });
  assert.equal(p.maxSpreads.met, true);
  assert.equal(p.minSpreads.met, true);
  assert.equal(p.preferredPerSpread.met, false);
});

test('fit cover, dedupe drop and foldSafe still work with the cap', () => {
  const it = items(9, 30);
  const cover = plan(it, { fit: 'cover' });
  assert.ok(Math.max(...sizes(cover)) <= 5);
  assert.ok(cover.spreads[0].slots[0].crop);
  const drop = plan(it, { dedupe: 'drop' });
  assert.ok(Math.max(...sizes(drop)) <= 5);
  const fold = AutoLayout.planSpreads(it.map(i => ({ ...i, foldRisk: 0.1 })), {});
  assert.ok(Math.max(...sizes(fold)) <= 5);
  assert.equal(fold.preferredPerSpread.met, true);
});

test('tiny books: 0, 1, 2 photos report met with no overflow', () => {
  for (const n of [0, 1, 2]) {
    const p = plan(items(1, n));
    assert.deepEqual(p.preferredPerSpread, { wanted: 5, met: true, overflowSpreads: 0 });
  }
});

test('invalid values fall back to the default 5 (a fraction rounds down; 1 is allowed)', () => {
  assert.equal(plan(items(1, 20), { preferredPerSpread: 'x' }).preferredPerSpread.wanted, 5);
  assert.equal(plan(items(1, 20), { preferredPerSpread: -2 }).preferredPerSpread, undefined);
  assert.equal(plan(items(1, 20), { preferredPerSpread: 4.9 }).preferredPerSpread.wanted, 4);
});

test('photosAllowed is the real limit of the library (8 per spread), not the preference', () => {
  const p = plan(items(4, 40), { maxSpreads: 6 });
  assert.equal(p.maxSpreads.photosAllowed, 48);
  const q = plan(items(4, 40), { maxSpreads: 6, preferredPerSpread: 0 });
  assert.equal(q.maxSpreads.photosAllowed, 48);
});

test('the cap rises by the least: 33 photos in 6 spreads need 6 per spread, not 7', () => {
  const p = plan(items(4, 33), { maxSpreads: 6 });
  assert.equal(p.maxSpreads.met, true);
  assert.ok(Math.max(...sizes(p)) <= 6, String(sizes(p)));
  assert.ok(p.preferredPerSpread.overflowSpreads > 0);
});
