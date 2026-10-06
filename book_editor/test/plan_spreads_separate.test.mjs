// node --test book_editor/test/plan_spreads_separate.test.mjs
//
// planSpreads, dedupe: 'separate' (the default): near-similar photos are KEPT but kept off the same spread.
// Tim's case: an iPhone screenshot of four same-pose studio frames of one couple on ONE spread. Everything runs on
// synthetic items (what analyze() returns) with hand-made dHashes: no real photo was available.
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
const hashOf = n => {                       // unrelated hashes: Hamming distance ~32 of 64
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
// base with exactly `flips` bits turned over (deterministic: bit positions from a seeded walk)
const flipped = (base, flips, seed = 1) => {
  const bits = base.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('').split('');
  const rnd = lcg(seed), used = new Set();
  while (used.size < flips) used.add(Math.floor(rnd() * 64));
  for (const b of used) bits[b] = bits[b] === '1' ? '0' : '1';
  let out = '';
  for (let i = 0; i < 64; i += 4) out += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  return out;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
let seq = 0;
const item = (id, o = {}) => {
  const aspect = o.aspect ?? 1.5;
  return { id, ok: o.ok ?? true, aspect, orientation: orientationOf(aspect), hash: o.hash ?? hashOf(seq++ + 800000),
    sharpness: o.sharp ?? 50, focus: { x: 0.5, y: 0.5 } };
};
const pad = n => String(n).padStart(3, '0');
const idOf = i => `IMG_${pad(i + 1)}.jpg`;
const POOL = [1.5, 1.5, 1.333, 1.5, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625];
// n photos with unrelated hashes; `clusters` = [[firstIndex, size, flipsEach], ...] share one base hash
function book(seed, n, clusters = [], pool = POOL) {
  const rnd = lcg(seed);
  const items = Array.from({ length: n }, (_, i) => item(idOf(i), { aspect: pool[Math.floor(rnd() * pool.length)],
    sharp: Math.floor(rnd() * 100), hash: hashOf(seed * 1000 + i) }));
  clusters.forEach(([at, size, flips], c) => {
    const base = hashOf(seed * 77 + c + 31337);
    for (let j = 0; j < size; j++) items[at + j] = { ...items[at + j], hash: j === 0 ? base : flipped(base, flips, seed * 10 + c * 3 + j) };
  });
  return items;
}
const placedOf = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId));
// the truth, measured the long way: pairs of photos on one spread whose hashes are within the threshold
function samePairs(plan, items, thr = 12) {
  const byId = new Map(items.map(i => [i.id, i]));
  let n = 0;
  for (const sp of plan.spreads) {
    const ids = sp.slots.map(s => s.photoId);
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) if (hamming(byId.get(ids[a]).hash, byId.get(ids[b]).hash) <= thr) n++;
  }
  return n;
}
const shift = (plan, items) => {            // largest distance a photo moved from its shooting-order place
  const order = items.map(i => i.id);        // ids are already in natural order
  const got = placedOf(plan);
  const cover = plan.cover.photoId;
  const want = order.length <= 3 ? order.filter(x => x !== cover) : order;
  return Math.max(...got.map((id, i) => Math.abs(i - want.indexOf(id))));
};

test('the helper makes what it says: base+flips is exactly that far, unrelated hashes are far', () => {
  const base = hashOf(5);
  for (const f of [0, 3, 8, 12, 20]) assert.equal(hamming(base, flipped(base, f, 4)), f);
  assert.ok(hamming(hashOf(1), hashOf(2)) > 18, 'control: unrelated hashes are not "similar"');
});

// ── the default keeps everything ────────────────────────────────────────────
test('default dedupe is "separate": near-identical shots are kept (nothing dropped as a duplicate), all placed once', () => {
  const items = book(3, 24, [[5, 4, 2]]);        // four frames within 2 bits of each other, would be dropped before
  const p = AutoLayout.planSpreads(items);
  assert.deepEqual(p.dropped, []);
  const placed = placedOf(p);
  assert.equal(placed.length, 24);
  assert.equal(new Set(placed).size, 24);
  const legacy = AutoLayout.planSpreads(items, { dedupe: 'drop' });
  assert.ok(legacy.dropped.length >= 3, "control: dedupe: 'drop' is the old behaviour and does drop them");
  assert.ok(legacy.dropped.every(d => d.reason === 'duplicate'));
});

test("dedupe: 'drop' is the old planner byte for byte (no new keys either)", () => {
  const items = book(4, 30, [[3, 3, 1]]);
  const p = AutoLayout.planSpreads(items, { dedupe: 'drop' });
  assert.deepEqual(Object.keys(p).sort(), ['back', 'cover', 'dropped', 'spreads']);
  assert.equal(p.dropped.length >= 2, true);
});

test('unknown dedupe values mean the default (separate)', () => {
  const items = book(3, 24, [[5, 4, 2]]);
  assert.equal(JSON.stringify(AutoLayout.planSpreads(items, { dedupe: 'nonsense' })), JSON.stringify(AutoLayout.planSpreads(items)));
});

test('failed photos and the same id twice are still dropped in separate mode (only near-duplicates stopped being dropped)', () => {
  const items = book(5, 12);
  items[2] = item(items[2].id, { ok: false });
  items.push({ ...items[7] });
  const p = AutoLayout.planSpreads(items);
  assert.deepEqual(p.dropped.map(d => d.reason).sort(), ['duplicate', 'failed']);
  assert.equal(placedOf(p).length, 11);
  assert.equal(new Set(placedOf(p)).size, 11);
  assert.ok(!placedOf(p).includes(items[2].id));
});

// ── the real case ───────────────────────────────────────────────────────────
test("Tim's case: four same-pose frames in a row are on four different spreads", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const items = book(seed, 28, [[9, 4, 6]]);
    const p = AutoLayout.planSpreads(items);
    assert.equal(samePairs(p, items), 0, `seed ${seed}: two of the four on one spread`);
    assert.equal(p.similarPairs, 0, `seed ${seed}: the plan reports what the test measured`);
    assert.deepEqual(p.similarSpreads, []);
    assert.equal(placedOf(p).length, 28);
    assert.equal(new Set(placedOf(p)).size, 28);
    assert.ok(shift(p, items) <= 10, `seed ${seed}: photos moved ${shift(p, items)} places: not chronological any more`);
  }
});

test('without the separation the same book does put them together (control: the test can fail)', () => {
  let together = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const items = book(seed, 28, [[9, 4, 6]]);
    together += samePairs(AutoLayout.planSpreads(items, { dedupe: 'drop', hashThreshold: -1 }), items) > 0 ? 1 : 0;
  }
  assert.ok(together >= 4, `only ${together} of 8 books had a similar pair on one spread without the separation`);
});

test('several clusters (pairs, triples, fours) in one book, all kept, none together', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const items = book(seed, 60, [[3, 2, 5], [12, 3, 8], [26, 4, 9], [41, 3, 4], [52, 2, 10]]);
    const p = AutoLayout.planSpreads(items);
    assert.equal(samePairs(p, items), 0, `seed ${seed}`);
    assert.equal(p.similarPairs, 0);
    assert.equal(placedOf(p).length, 60);
    assert.ok(shift(p, items) <= 10);
  }
});

test('a similar pair that is looser than the old drop threshold (10 bits) is separated too; a far one (30 bits) is left alone', () => {
  const near = book(21, 26, [[8, 2, 10]]);
  assert.equal(hamming(near[8].hash, near[9].hash), 10);
  assert.equal(AutoLayout.planSpreads(near, { dedupe: 'drop' }).dropped.length, 0, 'control: 10 bits is not a drop under the old rules');
  const p = AutoLayout.planSpreads(near);
  assert.equal(samePairs(p, near), 0);
  const far = book(21, 26, [[8, 2, 30]]);
  const q = AutoLayout.planSpreads(far);
  assert.equal(q.similarPairs, undefined, 'a 30-bit pair is not similar: no similar pass result');
  assert.equal(JSON.stringify(q), JSON.stringify(AutoLayout.planSpreads(book(21, 26), {})), 'and the book is the one an unrelated pair gives (same shapes)');
});

// ── unavoidable ─────────────────────────────────────────────────────────────
test('when it cannot be avoided it is allowed and reported: six similar photos make one valid spread, nothing dropped', () => {
  const base = hashOf(99);
  const items = Array.from({ length: 6 }, (_, i) => item(idOf(i), { hash: flipped(base, i === 0 ? 0 : 3, i + 1) }));
  const p = AutoLayout.planSpreads(items);
  assert.deepEqual(p.dropped, []);
  assert.equal(placedOf(p).length, 6);
  assert.ok(p.spreads.length >= 1);
  assert.ok(p.similarPairs > 0, 'it says some similar pair is still together');
  assert.equal(p.similarPairs, samePairs(p, items, 12));
  assert.ok(p.similarSpreads.length >= 1 && p.similarSpreads.every(id => p.spreads.some(s => s.id === id)));
});

test('look-alikes that cannot all be apart are split as much as the rules allow: six of them make two spreads, not one', () => {
  const base = hashOf(99);
  const items = Array.from({ length: 6 }, (_, i) => item(idOf(i), { hash: flipped(base, i === 0 ? 0 : 3, i + 1) }));
  const p = AutoLayout.planSpreads(items);
  assert.ok(p.spreads.length >= 2, `${p.spreads.length} spread(s)`);
  assert.ok(p.similarPairs < 15, `${p.similarPairs} of 15 pairs together`);
  // five: one 5-photo spread is the cheapest book by taste alone (no rhythm charge, one price); the pair charge splits it
  const five = Array.from({ length: 5 }, (_, i) => item(idOf(i), { hash: flipped(base, i === 0 ? 0 : 2, i + 20) }));
  const q = AutoLayout.planSpreads(five);
  assert.ok(q.spreads.length >= 2, `${q.spreads.length} spread(s) for five look-alikes`);
  assert.ok(q.similarPairs <= 3, `${q.similarPairs} of 10 pairs together`);
});

test('2 and 3 photos (one spread, cover not repeated) with similar hashes: allowed, reported, no throw', () => {
  for (const n of [2, 3]) {
    const base = hashOf(7);
    const items = Array.from({ length: n }, (_, i) => item(idOf(i), { hash: flipped(base, i, 9 + i) }));
    const p = AutoLayout.planSpreads(items);
    assert.equal(p.spreads.length, 1);
    assert.equal(placedOf(p).length, n - 1);
    assert.equal(p.similarPairs, n === 2 ? undefined : 1, `n=${n}`);   // 2 photos: one is the cover, no pair inside; 3: the two inside are look-alikes
  }
});

test('a whole book of look-alikes (every photo similar to its neighbours) still plans: all kept, fewer pairs than the shooting order gives', () => {
  const base = hashOf(123);
  const items = Array.from({ length: 30 }, (_, i) => item(idOf(i), { hash: flipped(base, 2 + (i % 5), 40 + i) }));
  const sep = AutoLayout.planSpreads(items);
  const raw = AutoLayout.planSpreads(items, { dedupe: 'drop', hashThreshold: -1 });
  assert.equal(placedOf(sep).length, 30);
  assert.deepEqual(sep.dropped, []);
  assert.ok(sep.similarPairs <= samePairs(raw, items), `${sep.similarPairs} vs ${samePairs(raw, items)} without separation`);
});

// ── the options ─────────────────────────────────────────────────────────────
test('similarThreshold / similarWindow are options; missing or empty hashes are never similar', () => {
  const items = book(31, 26, [[8, 2, 10]]);
  const tight = AutoLayout.planSpreads(items, { similarThreshold: 8 });
  assert.equal(tight.similarPairs, undefined, 'at 8 bits a 10-bit pair is no longer similar');
  const loose = AutoLayout.planSpreads(items, { similarThreshold: 10 });
  assert.equal(loose.similarPairs, 0);
  const noHash = items.map(i => ({ ...i, hash: '' }));
  assert.equal(AutoLayout.planSpreads(noHash).similarPairs, undefined);
  const win = AutoLayout.planSpreads(items, { similarWindow: 0 });
  assert.equal(win.similarPairs, undefined, 'window 0 compares nothing');
});

test('no similar photo anywhere: no similarPairs key, and the plan is exactly the old planner\'s', () => {
  for (const seed of [1, 2, 3]) {
    const items = book(seed, 40);
    const p = AutoLayout.planSpreads(items), d = AutoLayout.planSpreads(items, { dedupe: 'drop' });
    assert.equal(p.similarPairs, undefined);
    assert.equal(p.similarSpreads, undefined);
    assert.equal(JSON.stringify(p), JSON.stringify(d), `seed ${seed}: separate mode changed a book without similar photos`);
  }
});

test('works in cover fit too (and keeps its rules): spreads valid, none together', () => {
  const items = book(41, 30, [[10, 4, 5]]);
  const p = AutoLayout.planSpreads(items, { fit: 'cover' });
  assert.equal(samePairs(p, items), 0);
  assert.equal(placedOf(p).length, 30);
  const v = ST.validate([...new Set(p.spreads.map(s => s.template))].map(t => ST.byId(t)));
  assert.ok(v.ok, JSON.stringify(v.errors));
});

// ── structure: still a valid book ───────────────────────────────────────────
test('with clusters the book still obeys every hard rule (adjacent, family run, hero gap, no lone non-hero, templates valid)', () => {
  for (const seed of [51, 52, 53, 54, 55]) {
    const items = book(seed, 44, [[4, 4, 5], [17, 3, 7], [30, 4, 3]]);
    const p = AutoLayout.planSpreads(items);
    const T = p.spreads.map(s => s.template);
    const tag = id => ST.byId(id).tags;
    for (let i = 1; i < T.length; i++) assert.notEqual(T[i], T[i - 1]);
    for (let i = 2; i < T.length; i++) assert.ok(!(tag(T[i])[0] === tag(T[i - 1])[0] && tag(T[i - 1])[0] === tag(T[i - 2])[0]), `family run at ${i}`);
    for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(t => tag(t).includes('hero')).length <= 1);
    for (const s of p.spreads) if (s.slots.length === 1) assert.ok(tag(s.template).includes('hero'), `lone ${s.template}`);
    assert.ok(ST.validate([...new Set(T)].map(t => ST.byId(t))).ok === true);
    for (const s of p.spreads) for (const x of s.slots) { assert.equal(x.fit, 'contain'); assert.deepEqual(x.crop, { x: 0, y: 0, scale: 1 }); }
  }
});

test('deterministic, pure: same input same bytes, the input is not touched, no clock or random', () => {
  const items = book(61, 40, [[6, 4, 6], [22, 3, 5]]);
  const frozen = JSON.stringify(items);
  const a = AutoLayout.planSpreads(items), b = AutoLayout.planSpreads(JSON.parse(frozen));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('random'); }; Date.now = () => { throw new Error('clock'); };
  try { AutoLayout.planSpreads(items); } finally { Math.random = r; Date.now = n; }
});

test('chronological overall: the order of photos moves by at most a few places, spreads stay in time order', () => {
  const items = book(71, 50, [[10, 4, 6], [25, 4, 6], [38, 3, 6]]);
  const p = AutoLayout.planSpreads(items);
  assert.ok(shift(p, items) <= 10, `moved ${shift(p, items)}`);
  // the first spread still holds early photos, the last still holds late ones
  const first = p.spreads[0].slots.map(s => items.findIndex(i => i.id === s.photoId));
  const last = p.spreads[p.spreads.length - 1].slots.map(s => items.findIndex(i => i.id === s.photoId));
  assert.ok(Math.max(...first) <= 14 && Math.min(...last) >= 35);
});

// ── the reorder helper on its own ───────────────────────────────────────────
test('spreadOutOrder: a permutation, at most `shift` places from home, similar photos at least `gap` apart when it can', () => {
  const U = AutoLayout.util;
  assert.equal(typeof U.spreadOutOrder, 'function');
  const nbrs = Array.from({ length: 20 }, () => []);
  const link = (a, b) => { nbrs[a].push(b); nbrs[b].push(a); };
  link(5, 6); link(5, 7); link(5, 8); link(6, 7); link(6, 8); link(7, 8);
  const perm = U.spreadOutOrder(20, nbrs, 3, 6);
  assert.deepEqual([...perm].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  perm.forEach((orig, at) => assert.ok(Math.abs(orig - at) <= 6, `${orig} at ${at}`));
  const at = new Map(perm.map((o, i) => [o, i]));
  for (const [a, b] of [[5, 6], [5, 7], [5, 8], [6, 7], [6, 8], [7, 8]]) assert.ok(Math.abs(at.get(a) - at.get(b)) >= 3, `${a},${b} too close`);
  assert.deepEqual(U.spreadOutOrder(10, Array.from({ length: 10 }, () => []), 3, 6), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'nothing similar: the shooting order');
});

// ── added after the first mutation run (each kills a mutant that survived) ──
test('similarWindow is inclusive: a pair 3 places apart is similar at window 3 and not at window 2', () => {
  const items = book(81, 26);
  items[11] = { ...items[11], hash: items[8].hash };
  assert.equal(typeof AutoLayout.planSpreads(items, { similarWindow: 3 }).similarPairs, 'number');
  assert.equal(AutoLayout.planSpreads(items, { similarWindow: 2 }).similarPairs, undefined);
  const e3 = AutoLayout.util.similarEdges(items, 12, 3), e2 = AutoLayout.util.similarEdges(items, 12, 2);
  assert.deepEqual(e3.edges, [[8, 11]]);
  assert.deepEqual(e2.edges, []);
});

test('spreadOutOrder on 2000 random similarity graphs: always a permutation, nobody further than `shift` from home', () => {
  const U = AutoLayout.util, rnd = lcg(7);
  for (let k = 0; k < 2000; k++) {
    const n = 10 + Math.floor(rnd() * 40), nb = Array.from({ length: n }, () => []);
    for (let e = 0; e < n; e++) { const a = Math.floor(rnd() * n), b = Math.min(n - 1, a + 1 + Math.floor(rnd() * 7)); if (a !== b) { nb[a].push(b); nb[b].push(a); } }
    for (const [gap, sh] of [[3, 6], [4, 8], [5, 10], [6, 12]]) {
      const perm = U.spreadOutOrder(n, nb, gap, sh);
      assert.deepEqual([...perm].sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i));
      perm.forEach((orig, at) => assert.ok(Math.abs(orig - at) <= sh, `n=${n} gap=${gap} shift=${sh}: ${orig} at ${at}`));
    }
  }
});

test('a long book of one shape (templates repeat, the usage re-solve runs) still keeps look-alikes apart', () => {
  for (const seed of [91, 92, 93, 94]) {
    const items = book(seed, 70, [[5, 3, 4], [16, 4, 6], [29, 3, 5], [40, 4, 4], [55, 3, 6]], [1.5]);
    const p = AutoLayout.planSpreads(items);
    assert.equal(samePairs(p, items), 0, `seed ${seed}`);
    assert.equal(p.similarPairs, 0);
  }
});

test('a cluster that cannot be separated fully is still split as far as it can: far fewer pairs together than without the separation', () => {
  let sep = 0, raw = 0;
  for (const seed of [101, 102, 103, 104]) {
    const items = book(seed, 40, [[10, 9, 4]]);
    sep += AutoLayout.planSpreads(items).similarPairs;
    raw += samePairs(AutoLayout.planSpreads(items, { dedupe: 'drop', hashThreshold: -1 }), items);
  }
  assert.ok(raw > 0 && sep < raw / 2, `${sep} pairs with the separation, ${raw} without`);
});

test('separation outranks cost: two portrait look-alikes in a landscape book are apart even though together is the cheaper seat', () => {
  for (const seed of [111, 112, 113]) {
    const items = book(seed, 30, [], [1.5]);
    const base = hashOf(seed);
    items[12] = { ...items[12], aspect: 0.667, orientation: 'portrait', hash: base };
    items[13] = { ...items[13], aspect: 0.667, orientation: 'portrait', hash: flipped(base, 3, seed) };
    const p = AutoLayout.planSpreads(items);
    assert.equal(samePairs(p, items), 0, `seed ${seed}`);
  }
});

test('the hard separation beats any seating cost: tall look-alike pairs in a wide book (together would be much cheaper) are still apart', () => {
  let n = 0;
  for (const seed of [121, 122, 123, 124, 125, 126]) {
    const items = book(seed, 32, [], [2.4]);
    const base = hashOf(seed + 5);
    for (const at of [10, 11, 12]) items[at] = { ...items[at], aspect: 0.5, orientation: 'portrait', hash: flipped(base, at - 10, seed + at) };
    const p = AutoLayout.planSpreads(items);
    assert.equal(samePairs(p, items), 0, `seed ${seed}`);
    n++;
  }
  assert.equal(n, 6);
});
