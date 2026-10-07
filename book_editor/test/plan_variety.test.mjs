// node --test book_editor/test/plan_variety.test.mjs
//
// planSpreads option `variety` (default on; 0 / false / null = the cheapest book as before, no `variety` key in the result).
// Soft preferences on top of the hard rules, measured by result.variety = { distinctCounts, maxSameRun, repeatedTemplates,
// distinctTemplates, heroSpreads }:
//   1. no more than 2 spreads in a row with the same photo count, never the same template twice running;
//   2. a book of >= 6 spreads has >= 3 distinct photo counts and a lone-photo through-spread (hero) when a suitable photo exists;
//   3. under a tight maxSpreads (average over 5) the counts still vary (4,6,5,5 rather than 5,5,5,5);
//   4. when the counts are forced, the templates still differ.
// Hard rules stay: maxSpreads / minSpreads, every photo kept, foldSafe, fit 'contain', the hero gap, similar photos apart.
// Synthetic photos only: these pin the mechanism, not how it looks on a real album.
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
const SpreadTemplates = vm.runInThisContext('SpreadTemplates');
const HERO_GAP = AutoLayout.SPREAD_DEFAULTS.heroGap;

const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625];
// foldRisk 0.1: the subject is off the fold (without it a photo counts as high-risk and may not go on a through-spread)
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
const old = (it, o = {}) => AutoLayout.planSpreads(it, { ...o, variety: 0 });
const sizes = p => p.spreads.map(s => s.slots.length);
const tpls = p => p.spreads.map(s => s.template);
const isHero = s => s.slots.length === 1 && s.slots[0].slot.face === 'span';
const spans = s => s.slots.some(x => x.slot.face === 'span');
const ids = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId)).sort();

// the measures, recomputed from the spreads (not from result.variety)
function measure(p) {
  const k = sizes(p), t = tpls(p);
  let run = 1, maxRun = k.length ? 1 : 0, rep = 0;
  for (let i = 1; i < k.length; i++) { run = k[i] === k[i - 1] ? run + 1 : 1; maxRun = Math.max(maxRun, run); if (t[i] === t[i - 1]) rep++; }
  return { distinct: new Set(k).size, maxRun, rep, heroes: p.spreads.filter(isHero).length, tpl: new Set(t).size };
}
const heroGapOk = p => {
  const at = p.spreads.map((s, i) => (spans(s) ? i : -1)).filter(i => i >= 0);
  return at.every((x, i) => i === 0 || x - at[i - 1] > HERO_GAP);
};

const SEEDS = [1, 2, 3, 4, 5];
const SIZES = [12, 16, 20, 24, 30, 44, 60];
// [photos, options] books with room for variety: an average of at most ~6 per spread, and not so many spreads that
// most of them are forced single photos (a maximum that forces 8 per spread leaves nothing to vary: not asserted here)
const FREE = SIZES.map(n => [n, {}]);
const MINS = [[20, { minSpreads: 10 }], [30, { minSpreads: 10 }], [44, { minSpreads: 16 }], [30, { minSpreads: 8 }]];
const MAXS = [[20, { maxSpreads: 4 }], [24, { maxSpreads: 4 }], [30, { maxSpreads: 6 }], [20, { maxSpreads: 3 }], [20, { maxSpreads: 8 }], [44, { maxSpreads: 9 }]];
const BOOKS = [...FREE, ...MINS, ...MAXS];
const eachBook = (list, fn) => { for (const [n, o] of list) for (const seed of SEEDS) fn(plan(items(seed, n), o), `${n} photos ${JSON.stringify(o)} seed ${seed}`, n, o, seed); };

test('result.variety reports the measures, recomputed from the spreads', () => {
  eachBook(BOOKS, (p, label) => {
    const m = measure(p);
    // heroWanted (plan_hero.test.mjs) is a number next to the measures, not one of them
    assert.equal(typeof p.variety.heroWanted, 'number', label);
    const { heroWanted, ...measures } = p.variety;
    assert.deepEqual(measures, { distinctCounts: m.distinct, maxSameRun: m.maxRun, repeatedTemplates: m.rep, distinctTemplates: m.tpl, heroSpreads: m.heroes }, label);
  });
});

test('rule 1: at most 2 spreads in a row with the same photo count, never the same template twice in a row', () => {
  eachBook(BOOKS, (p, label) => {
    const m = measure(p);
    assert.ok(p.spreads.length >= 2, label);
    assert.ok(m.maxRun <= 2, `${label}: ${sizes(p)}`);
    assert.equal(m.rep, 0, `${label}: ${tpls(p)}`);
  });
});

test('rules 1 and 3 on a wider sweep (8 seeds): odd sizes, a minimum of 8, maxima that leave an average of 6 to 7', () => {
  // these books were found by scanning: without the 3rd-in-a-row price or the per-count price in the planner they break the rules
  const sweep = [[20, { minSpreads: 8 }], [22, { minSpreads: 8 }], [22, {}], [32, { maxSpreads: 6 }], [40, { maxSpreads: 6 }], [52, { maxSpreads: 7 }]];
  let n = 0;
  for (const [photos, o] of sweep) for (let seed = 1; seed <= 8; seed++) {
    if (photos === 52 && seed === 2) continue;       // 7.4 per spread: the library's own capacity (8) leaves one choice
    const p = plan(items(seed, photos), o), m = measure(p), S = p.spreads.length, label = `${photos} ${JSON.stringify(o)} seed ${seed}: ${sizes(p)}`;
    n++;
    assert.ok(m.maxRun <= 2, label);
    assert.equal(m.rep, 0, label);
    assert.ok(m.distinct >= (S >= 6 ? 3 : 2), label);
    if (o.maxSpreads) assert.ok(S <= o.maxSpreads && p.maxSpreads.met, label);
    if (o.minSpreads) assert.ok(S >= o.minSpreads && p.minSpreads.met, label);
  }
  assert.equal(n, 47);
});

test('rule 2: from 6 spreads on, >= 3 distinct photo counts and a lone through-spread, spaced by the hero gap', () => {
  let long = 0;
  eachBook([...FREE, ...MINS, [20, { maxSpreads: 8 }], [24, { maxSpreads: 8 }]], (p, label) => {
    const m = measure(p);
    if (p.spreads.length < 6) return;
    long++;
    assert.ok(m.distinct >= 3, `${label}: ${sizes(p)}`);
    assert.ok(m.heroes >= 1, `${label}: no lone through-spread in ${sizes(p)} ${tpls(p)}`);
    assert.ok(heroGapOk(p), `${label}: through-spreads closer than the gap: ${tpls(p)}`);
  });
  assert.ok(long >= 40, `floor: only ${long} books of 6+ spreads were checked`);
});

test('rule 3: under a tight maxSpreads the counts still vary, photosAllowed stays correct, and the result says so', () => {
  const tight = [[20, { maxSpreads: 4 }], [24, { maxSpreads: 4 }], [30, { maxSpreads: 6 }], [20, { maxSpreads: 3 }]];
  eachBook(tight, (p, label, n, o) => {
    const k = sizes(p), m = measure(p);
    assert.ok(k.length <= o.maxSpreads, label);
    assert.ok(n / k.length > 4.9, `${label}: control: the average is really tight (${n / k.length})`);
    assert.ok(m.distinct >= 2, `${label}: flat ${k}`);
    assert.equal(p.maxSpreads.met, true, label);
    assert.equal(p.maxSpreads.photosAllowed, 8 * o.maxSpreads, `${label}: photosAllowed is the library's capacity, 8 per spread`);
    assert.equal(p.variety.distinctCounts, m.distinct, label);
    assert.equal(p.preferredPerSpread.overflowSpreads, k.filter(x => x > 5).length, `${label}: the overflow is reported`);
    assert.equal(k.reduce((a, b) => a + b, 0), n, label);
  });
  // the example in the brief: 20 photos in 4 spreads is not 5,5,5,5
  for (const seed of SEEDS) assert.notDeepEqual(sizes(plan(items(seed, 20), { maxSpreads: 4 })), [5, 5, 5, 5]);
});

test('rule 4: when the average is exactly forced, the templates still differ', () => {
  // a library with only 5-photo templates (plus singles and pairs, which a lone photo needs): 20 photos in 4 spreads can only be 5,5,5,5
  const fives = SpreadTemplates.TEMPLATES.filter(t => !t.tags.includes('hero') && (t.slots.length === 5 || t.slots.length <= 2));
  assert.ok(fives.filter(t => t.slots.length === 5).length >= 4);
  for (const seed of SEEDS) {
    const p = plan(items(seed, 20), { maxSpreads: 4, templates: fives });
    assert.deepEqual(sizes(p), [5, 5, 5, 5], `control: the counts really are forced (seed ${seed})`);
    assert.equal(p.variety.distinctTemplates, 4, `seed ${seed}: ${tpls(p)}`);
    assert.equal(p.variety.repeatedTemplates, 0);
  }
});

test('hard bounds and every photo kept: maxSpreads, minSpreads, no photo lost or repeated, fit contain, hero gap', () => {
  eachBook(BOOKS, (p, label, n, o) => {
    assert.deepEqual(ids(p), items(1, n).map(x => x.id).sort(), label);
    if (o.maxSpreads) assert.ok(p.spreads.length <= o.maxSpreads, label);
    if (o.minSpreads) assert.ok(p.spreads.length >= o.minSpreads, label);
    assert.ok(p.spreads.every(s => s.slots.every(x => x.fit === 'contain')), `${label}: fit contain`);
    assert.ok(heroGapOk(p), label);
  });
});

test('hard bounds, the books of the brief: 20 photos with maxSpreads 4 and with minSpreads 10', () => {
  for (const seed of SEEDS) {
    const a = plan(items(seed, 20), { maxSpreads: 4 });
    assert.ok(a.spreads.length <= 4 && a.maxSpreads.met);
    const b = plan(items(seed, 20), { minSpreads: 10 });
    assert.ok(b.spreads.length >= 10 && b.minSpreads.met);
    assert.equal(ids(a).length, 20);
    assert.equal(ids(b).length, 20);
  }
});

test('foldSafe stays: no high-risk photo on a through-spread, whatever the variety wants', () => {
  for (const seed of SEEDS) for (const n of [24, 44]) {
    const it = items(seed, n, i => (i % 3 === 0 ? 0.95 : 0.1)), bad = new Set(it.filter(x => x.foldRisk >= AutoLayout.FOLD.LIMIT).map(x => x.id));
    assert.ok(bad.size > 0);
    const p = plan(it);
    assert.ok(p.spreads.some(spans), `seed ${seed} n ${n}: control: there is a through-spread`);
    // only the span slot is on the fold: a hero-strip's small slots may hold a risky photo (plan_spreads_foldsafe.test.mjs)
    for (const s of p.spreads) for (const x of s.slots) if (x.slot.face === 'span') assert.ok(!bad.has(x.photoId), `${x.photoId} across the fold`);
  }
});

test('with no foldRisk at all (unknown = high) no through-spread is forced', () => {
  const p = plan(items(2, 30, () => null));
  assert.equal(p.variety.heroSpreads, 0);
  assert.ok(p.spreads.every(s => !spans(s)));
});

test('look-alikes still kept apart: similarPairs is no worse than without variety', () => {
  for (const seed of SEEDS) {
    const it = items(seed, 30);
    for (let i = 1; i < 30; i += 5) it[i].hash = it[i - 1].hash;     // 6 look-alike pairs
    const a = plan(it), b = old(it);
    assert.ok(b.similarPairs !== undefined && a.similarPairs !== undefined, 'control: the pairs are seen');
    assert.ok(a.similarPairs <= b.similarPairs, `seed ${seed}: ${a.similarPairs} vs ${b.similarPairs}`);
    assert.deepEqual(ids(a), ids(b));
  }
});

test('deterministic: the same input gives the same plan; the input is not touched', () => {
  const it = items(3, 30), frozen = JSON.stringify(it);
  for (const o of [{}, { maxSpreads: 4 }, { minSpreads: 9 }]) assert.equal(JSON.stringify(plan(it, o)), JSON.stringify(plan(JSON.parse(frozen), o)));
  assert.equal(JSON.stringify(it), frozen);
});

test('variety: 0 / false / null is the previous behaviour, with no variety key; anything else is on', () => {
  const it = items(2, 30);
  const a = old(it), b = plan(it, { variety: false }), c = plan(it, { variety: null });
  assert.equal(a.variety, undefined);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  const on = plan(it);
  assert.ok(on.variety);
  assert.deepEqual(on, plan(it, { variety: true }));
  assert.deepEqual(on, plan(it, { variety: 1 }));
  assert.notDeepEqual(on, a, 'control: variety changes this book');
});

test('positive controls: the previous behaviour fails the new assertions', () => {
  // the rules of the brief as one predicate, run on the old and the new plan of every book
  const breaks = p => {
    const m = measure(p), S = p.spreads.length, out = [];
    if (m.maxRun > 2) out.push('run');
    if (m.rep > 0) out.push('repeat');
    if (S >= 6 && m.distinct < 3) out.push('counts');
    if (S >= 6 && m.heroes === 0) out.push('hero');
    return out;
  };
  const tally = fn => { const t = {}; let books = 0; for (const [n, o] of [...FREE, ...MINS, [20, { maxSpreads: 4 }], [24, { maxSpreads: 4 }], [20, { maxSpreads: 3 }], [20, { maxSpreads: 8 }]]) for (const seed of SEEDS) { books++; for (const r of breaks(fn(items(seed, n), o))) t[r] = (t[r] || 0) + 1; } return { t, books }; };
  const o = tally(old), nw = tally(plan);
  assert.deepEqual(nw.t, {}, `the new plans break no rule: ${JSON.stringify(nw.t)}`);
  assert.ok((o.t.hero || 0) >= 5, `old plans without a lone through-spread: ${JSON.stringify(o.t)}`);
  assert.ok((o.t.run || 0) >= 5, `old plans with a run of one count: ${JSON.stringify(o.t)}`);
  // tight maximum: the old plan is 5,5,5,5 on every seed of the brief's example
  for (const seed of SEEDS) assert.deepEqual(sizes(old(items(seed, 20), { maxSpreads: 4 })), [5, 5, 5, 5], `old, seed ${seed}`);
  // forced counts: the old plan repeats a template where the new one does not
  const fives = SpreadTemplates.TEMPLATES.filter(t => !t.tags.includes('hero') && (t.slots.length === 5 || t.slots.length <= 2));
  const oldRepeats = SEEDS.filter(seed => old(items(seed, 20), { maxSpreads: 4, templates: fives }).spreads.length > new Set(tpls(old(items(seed, 20), { maxSpreads: 4, templates: fives }))).size);
  assert.ok(oldRepeats.length >= 2, `old plans that reuse a template although 6 fit: seeds ${oldRepeats}`);
});

test('the new plans do not cost much: the spread count stays within 30% (or 3) of the previous plan when unbounded', () => {
  for (const seed of SEEDS) for (const n of SIZES) {
    const a = plan(items(seed, n)).spreads.length, b = old(items(seed, n)).spreads.length;
    // heroRate (default 0.2, plan_hero.test.mjs) adds lone-photo spreads: 40% here (was 30%); heroRate 0 keeps the 30%
    assert.ok(Math.abs(a - b) <= Math.max(3, Math.round(b * 0.4)), `seed ${seed} n ${n}: ${a} vs ${b}`);
    const z = plan(items(seed, n), { heroRate: 0 }).spreads.length;
    assert.ok(Math.abs(z - b) <= Math.max(3, Math.round(b * 0.3)), `heroRate 0, seed ${seed} n ${n}: ${z} vs ${b}`);
  }
});
