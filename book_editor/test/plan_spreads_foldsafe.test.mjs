// node --test book_editor/test/plan_spreads_foldsafe.test.mjs
//
// planSpreads({ foldSafe }) (default true): a template with a `face: 'span'` slot (the hero family, a photo across
// the fold) takes only photos whose foldRisk is low (item.foldRisk < AutoLayout.FOLD.LIMIT); a missing foldRisk is
// HIGH. It is a hard rule, never relaxed for minSpreads, the waste floor or the hero-gap relaxations. foldSafe:false
// is the old behaviour. Result: foldSpans (spreads with a span slot) and foldAvoided (high-risk photos the old
// behaviour would have put on a span), present only when > 0 and only with foldSafe.
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
const LIMIT = AutoLayout.FOLD.LIMIT;

const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
const pad = n => String(n).padStart(3, '0');
const id = i => `IMG_${pad(i)}.jpg`;
// foldRisk: a number, or undefined = "no pixel data" (the key is then absent, as for a hash-only item)
const item = (i, o = {}) => {
  const aspect = o.aspect ?? 1.5;
  const it = { id: id(i), ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(i + 700000), sharpness: o.sharp ?? 50, focus: { x: 0.5, y: 0.5 } };
  if (o.risk !== undefined) it.foldRisk = o.risk;
  return it;
};
const book = (n, f) => Array.from({ length: n }, (_, k) => item(k + 1, f(k)));
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625, 2.4, 0.4];
const NORMAL = [1.5, 1.5, 1.333, 1.5, 0.667, 0.667, 0.8, 0.75, 1.0, 1.778, 0.5625];
function randomBook(seed, n, riskOf, pool = NORMAL) {
  const rnd = lcg(seed);
  return Array.from({ length: n }, (_, k) => item(k + 1, { aspect: pool[Math.floor(rnd() * pool.length)], sharp: Math.floor(rnd() * 100), risk: riskOf(rnd, k) }));
}
const tpl = tid => ST.byId(tid);
const isSpanTpl = tid => tpl(tid).slots.some(s => s.face === 'span');
const spanPhotos = plan => plan.spreads.flatMap(s => s.slots.filter(x => x.slot.face === 'span').map(x => x.photoId));
const placedOf = plan => plan.spreads.flatMap(s => s.slots.map(x => x.photoId));
const riskById = items => new Map(items.map(i => [i.id, i.foldRisk === undefined ? 1 : i.foldRisk]));

// the rules of this file, on one result
function checkFold(plan, items, label) {
  const risk = riskById(items);
  for (const sp of plan.spreads) {
    for (const s of sp.slots) {
      if (s.slot.face === 'span') assert.ok(risk.get(s.photoId) < LIMIT, `${label}: ${s.photoId} (risk ${risk.get(s.photoId)}) sits across the fold in ${sp.template}`);
    }
    if (isSpanTpl(sp.template)) assert.ok(sp.slots.some(s => s.slot.face === 'span'));
  }
  const survivors = items.filter(i => i.ok && !plan.dropped.some(d => d.id === i.id));
  const placed = placedOf(plan);
  const expected = survivors.length === 1 ? 0 : survivors.length <= 3 ? survivors.length - 1 : survivors.length;
  assert.equal(placed.length, expected, `${label}: a photo was dropped or doubled`);
  assert.equal(new Set(placed).size, placed.length, `${label}: a photo twice`);
  for (const sp of plan.spreads) for (const s of sp.slots) {
    assert.equal(s.fit, 'contain'); assert.deepEqual({ ...s.crop }, { x: 0, y: 0, scale: 1 });
  }
  const spans = plan.spreads.filter(sp => isSpanTpl(sp.template)).length;
  if (spans) assert.equal(plan.foldSpans, spans, `${label}: foldSpans`); else assert.equal('foldSpans' in plan, false, `${label}: foldSpans absent when none`);
}

// ── the contract ────────────────────────────────────────────────────────────
test('default is foldSafe: photos without foldRisk (hash-only items) never go across the fold; foldSafe:false does', () => {
  const items = book(40, k => ({ aspect: 1.5, sharp: 60 + (k % 7) * 5 }));          // no foldRisk anywhere
  const old = AutoLayout.planSpreads(items, { foldSafe: false });
  assert.ok(spanPhotos(old).length >= 1, 'control: sharp landscapes with no risk data do get a through-spread when the rule is off');
  const def = AutoLayout.planSpreads(items);
  assert.deepEqual(spanPhotos(def), [], 'default: no data = high risk = no span');
  assert.equal(JSON.stringify(def), JSON.stringify(AutoLayout.planSpreads(items, { foldSafe: true })), 'default equals foldSafe:true');
  assert.equal(JSON.stringify(AutoLayout.planSpreads(items, { foldSafe: 0 })), JSON.stringify(def), 'only an explicit false switches it off (0 is not false)');
  checkFold(def, items, 'default');
});

test('foldSafe:false is the old object: no foldSpans, no foldAvoided, spans allowed whatever the risk', () => {
  const items = book(40, k => ({ aspect: 1.5, sharp: 60 + (k % 7) * 5, risk: 1 }));
  const p = AutoLayout.planSpreads(items, { foldSafe: false });
  assert.ok(spanPhotos(p).length >= 1);
  assert.equal('foldSpans' in p, false);
  assert.equal('foldAvoided' in p, false);
});

test('a book whose only hero candidate is a high-risk photo gets no span; the same book with foldSafe:false spans it', () => {
  // one sharp landscape, the rest portraits (a portrait is never a hero candidate)
  const items = [item(1, { aspect: 0.7 }), item(2, { aspect: 0.7 }), item(3, { aspect: 1.5, sharp: 95, risk: 0.95 }),
    item(4, { aspect: 0.7 }), item(5, { aspect: 0.7 }), item(6, { aspect: 0.7 })];
  const old = AutoLayout.planSpreads(items, { foldSafe: false });
  assert.deepEqual(spanPhotos(old), [id(3)], 'control: the landscape is the through-spread when the rule is off');
  const safe = AutoLayout.planSpreads(items);
  assert.deepEqual(spanPhotos(safe), []);
  assert.ok(placedOf(safe).includes(id(3)), 'the photo is still in the book');
  checkFold(safe, items, 'only-candidate');
  assert.equal(safe.foldAvoided, 1);
  assert.equal('foldSpans' in safe, false);
});

test('the same book with a low-risk landscape still gets its through-spread', () => {
  const items = [item(1, { aspect: 0.7 }), item(2, { aspect: 0.7 }), item(3, { aspect: 1.5, sharp: 95, risk: 0.1 }),
    item(4, { aspect: 0.7 }), item(5, { aspect: 0.7 }), item(6, { aspect: 0.7 })];
  const p = AutoLayout.planSpreads(items);
  assert.deepEqual(spanPhotos(p), [id(3)]);
  assert.equal(p.foldSpans, 1);
  assert.equal('foldAvoided' in p, false);
  assert.deepEqual(JSON.stringify(p.spreads), JSON.stringify(AutoLayout.planSpreads(items, { foldSafe: false }).spreads), 'when nothing is risky the plan is the old plan');
});

test('the limit: just under is safe, at the limit is not', () => {
  const mk = r => [item(1, { aspect: 0.7 }), item(2, { aspect: 0.7 }), item(3, { aspect: 1.5, sharp: 95, risk: r }), item(4, { aspect: 0.7 }), item(5, { aspect: 0.7 }), item(6, { aspect: 0.7 })];
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(LIMIT - 0.001))), [id(3)]);
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(LIMIT))), []);
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(1))), []);
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(0))), [id(3)]);
});

test('junk risk values count as unknown = high: NaN, a string, null, negative infinity is clamped low only when it is a number', () => {
  const mk = r => [item(1, { aspect: 0.7 }), item(2, { aspect: 0.7 }), { ...item(3, { aspect: 1.5, sharp: 95 }), foldRisk: r }, item(4, { aspect: 0.7 }), item(5, { aspect: 0.7 }), item(6, { aspect: 0.7 })];
  for (const bad of [NaN, 'low', null, undefined, {}, [], Infinity]) assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(bad))), [], `foldRisk ${String(bad)}`);
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(mk(-5))), [id(3)], 'a number below 0 is clamped to 0 (safe)');
});

test('every photo in a span slot is low risk: 60 random books, risks mixed (contain)', () => {
  let spans = 0, avoided = 0, withSpan = 0;
  for (let s = 1; s <= 60; s++) {
    const n = 4 + (s * 7) % 50;
    const items = randomBook(s, n, rnd => (rnd() < 0.5 ? rnd() * 0.45 : 0.55 + rnd() * 0.45));
    const p = AutoLayout.planSpreads(items);
    checkFold(p, items, `seed ${s} n=${n}`);
    spans += spanPhotos(p).length; avoided += p.foldAvoided || 0; if (spanPhotos(p).length) withSpan++;
  }
  assert.ok(spans >= 10 && withSpan >= 10, `control: low-risk photos still get through-spreads (${spans} in ${withSpan} books)`);
  assert.ok(avoided >= 5, `control: some photos were kept off (${avoided})`);
});

test('same rule in cover mode and with the other options: similar photos, maxPerFace, wide spreads, seeds', () => {
  for (let s = 1; s <= 12; s++) {
    const items = randomBook(200 + s, 20 + s, rnd => (rnd() < 0.5 ? 0.1 : 0.9));
    for (const o of [{ fit: 'cover' }, { seed: s }, { maxPerFace: 2 }, { spreadAspect: 2, coverAspect: 1 }, { order: 'given' }, { dedupe: 'drop' }]) {
      const p = AutoLayout.planSpreads(items, o);
      const risk = riskById(items);
      for (const x of spanPhotos(p)) assert.ok(risk.get(x) < LIMIT, `seed ${s} ${JSON.stringify(o)}: ${x}`);
    }
  }
});

test('plannable always: every photo high risk, every n from 1 to 45: no span, nothing dropped, no throw', () => {
  for (let n = 1; n <= 45; n++) {
    const items = book(n, k => ({ aspect: [1.5, 0.7, 1.0][k % 3], sharp: 40 + (k % 9) * 5, risk: 1 }));
    const p = AutoLayout.planSpreads(items);
    checkFold(p, items, `n=${n}`);
    assert.equal(p.spreads.some(sp => isSpanTpl(sp.template)), false, `n=${n}`);
  }
});

test('one photo and two photos: the cover only / one quiet single page, never a span (solo-left / solo-right take the lone photo)', () => {
  const one = AutoLayout.planSpreads([item(1, { risk: 1 })]);
  assert.equal(one.spreads.length, 0); assert.ok(one.cover);
  const two = AutoLayout.planSpreads([item(1, { risk: 1 }), item(2, { risk: 1 })]);
  assert.equal(two.spreads.length, 1);
  assert.ok(['solo-left', 'solo-right'].includes(two.spreads[0].template), two.spreads[0].template);
  const twoOld = AutoLayout.planSpreads([item(1, { risk: 1 }), item(2, { risk: 1 })], { foldSafe: false });
  assert.ok(twoOld.spreads.length === 1);
});

test('three photos (2 inside) and the all-photos-in-one-spread cases still plan', () => {
  for (const n of [3, 4, 5, 8, 9]) {
    const items = book(n, k => ({ aspect: 1.5, sharp: 90 - k, risk: 0.9 }));
    const p = AutoLayout.planSpreads(items);
    checkFold(p, items, `n=${n}`);
    assert.ok(p.spreads.length >= 1);
  }
});

// ── hard against the other rules ────────────────────────────────────────────
test('minSpreads never buys a span with a high-risk photo: it reports met:false rather than cutting a face', () => {
  // 5 photos, every one risky; a minimum of 5 spreads is reachable with quiet single pages, so ask for more than that
  const items = book(5, () => ({ aspect: 1.5, sharp: 80, risk: 0.9 }));
  const p = AutoLayout.planSpreads(items, { minSpreads: 5 });
  checkFold(p, items, 'min 5');
  assert.equal(p.minSpreads.achieved, p.spreads.length);
  const q = AutoLayout.planSpreads(items, { minSpreads: 9 });
  checkFold(q, items, 'min 9');
  assert.equal(q.minSpreads.met, false, 'cannot make 9 spreads from 5 photos');
  for (let s = 1; s <= 10; s++) {
    const b = randomBook(300 + s, 12 + s, () => 0.9);
    for (const min of [4, 8, 12, 20]) {
      const r = AutoLayout.planSpreads(b, { minSpreads: min });
      checkFold(r, b, `seed ${s} min ${min}`);
      assert.equal(r.spreads.some(sp => isSpanTpl(sp.template)), false);
    }
  }
});

test('minSpreads is met with heroes when the photos are safe, exactly as before (the rule does not cost spreads then)', () => {
  for (let s = 1; s <= 8; s++) {
    const b = randomBook(400 + s, 14 + s, () => 0.05);
    for (const min of [6, 10, 14]) {
      const a = AutoLayout.planSpreads(b, { minSpreads: min }), o = AutoLayout.planSpreads(b, { minSpreads: min, foldSafe: false });
      assert.equal(JSON.stringify(a.spreads), JSON.stringify(o.spreads), `seed ${s} min ${min}`);
      assert.equal(a.minSpreads.met, o.minSpreads.met);
    }
  }
});

test('minSpreads: on risky photos the minimum is met as often as the old planner met it without heroes (single pages do the work)', () => {
  for (let s = 1; s <= 8; s++) {
    const b = randomBook(500 + s, 16 + s, () => 0.9);
    const n = b.length;
    const p = AutoLayout.planSpreads(b, { minSpreads: n - 2 });
    assert.equal(p.minSpreads.met, true, `seed ${s}: ${n - 2} spreads from ${n} photos`);
    checkFold(p, b, `seed ${s}`);
  }
});

test('maxSpreads keeps working under the rule (dense spreads never need a span), all photos kept', () => {
  for (let s = 1; s <= 8; s++) {
    const b = randomBook(600 + s, 30 + s, rnd => rnd());
    for (const max of [4, 6, 10]) {
      const p = AutoLayout.planSpreads(b, { maxSpreads: max });
      checkFold(p, b, `seed ${s} max ${max}`);
      const o = AutoLayout.planSpreads(b, { maxSpreads: max, foldSafe: false });
      assert.equal(p.maxSpreads.met, o.maxSpreads.met, `seed ${s} max ${max}`);
    }
  }
});

test('the waste floor and the hero-gap relaxations never let a high-risk photo onto a span: wide, harsh shapes, hero-heavy libraries', () => {
  for (let s = 1; s <= 10; s++) {
    const items = randomBook(700 + s, 18 + s, () => 0.8, POOL);
    const heroish = ST.TEMPLATES.filter(t => t.tags.includes('hero') || t.slots.length === 2 || t.slots.length === 1);
    for (const o of [{}, { templates: heroish }, { templates: ST.TEMPLATES.filter(t => t.id === 'hero-bleed' || t.slots.length >= 2) }]) {
      const p = AutoLayout.planSpreads(items, o);
      assert.deepEqual(spanPhotos(p), [], `seed ${s}`);
    }
  }
});

test('a library that can only seat a photo on a span cannot take a high-risk one: it throws like any library that cannot seat (foldSafe:false still plans)', () => {
  const heroOnly = ST.TEMPLATES.filter(t => t.id === 'hero-bleed');
  const items = book(4, () => ({ aspect: 1.5, risk: 0.9 }));
  assert.throws(() => AutoLayout.planSpreads(items, { templates: heroOnly }), /cannot seat/);
  assert.doesNotThrow(() => AutoLayout.planSpreads(items, { templates: heroOnly, foldSafe: false }));
  const safeItems = book(4, () => ({ aspect: 1.5, risk: 0.1 }));
  assert.doesNotThrow(() => AutoLayout.planSpreads(safeItems, { templates: heroOnly }));
});

// ── hero-strip and the seat inside a template ───────────────────────────────
test('hero-strip (a span slot plus three small): the safe photo takes the span, the risky ones the small slots', () => {
  const strip = ST.TEMPLATES.filter(t => t.id === 'hero-strip' || t.id === 'solo-left' || t.id === 'solo-right' || t.id === 'pair-portraits' || t.id === 'pair-landscapes');
  const items = [item(1, { aspect: 1.5, sharp: 90, risk: 0.9 }), item(2, { aspect: 1.5, sharp: 90, risk: 0.9 }), item(3, { aspect: 1.5, sharp: 90, risk: 0.9 }), item(4, { aspect: 1.5, sharp: 90, risk: 0.05 })];
  for (const p of [AutoLayout.planSpreads(items, { templates: strip }), AutoLayout.planSpreads(items, { templates: strip, fit: 'cover' })]) {
    const risk = riskById(items);
    for (const x of spanPhotos(p)) assert.ok(risk.get(x) < LIMIT);
    assert.deepEqual(spanPhotos(p), [id(4)], 'control: the strip is used, with the one safe photo on its span');
  }
  assert.deepEqual(spanPhotos(AutoLayout.planSpreads(items, { templates: strip, foldSafe: false })), [id(2)], 'control: the old plan spans a risky photo');
  checkFold(AutoLayout.planSpreads(items, { templates: strip }), items, 'strip');
});

// ── result fields ───────────────────────────────────────────────────────────
test('foldSpans counts the spreads that use a span slot; foldAvoided the risky photos the old plan would have spanned', () => {
  for (let s = 1; s <= 20; s++) {
    const items = randomBook(800 + s, 24 + s, rnd => (rnd() < 0.5 ? 0.05 : 0.95));
    const safe = AutoLayout.planSpreads(items), old = AutoLayout.planSpreads(items, { foldSafe: false });
    const risk = riskById(items);
    const spans = safe.spreads.filter(sp => isSpanTpl(sp.template)).length;
    assert.equal(safe.foldSpans || 0, spans);
    const avoided = spanPhotos(old).filter(x => risk.get(x) >= LIMIT).length;
    assert.equal(safe.foldAvoided || 0, avoided, `seed ${s}`);
    assert.equal('foldSpans' in safe, spans > 0);
    assert.equal('foldAvoided' in safe, avoided > 0);
  }
});

test('every existing result field is still there; the cover, dropped and back are the old ones', () => {
  const items = randomBook(901, 30, rnd => rnd());
  const p = AutoLayout.planSpreads(items, { back: true, minSpreads: 6, maxSpreads: 12 });
  for (const k of ['cover', 'spreads', 'back', 'dropped', 'minSpreads', 'maxSpreads']) assert.ok(k in p, k);
  assert.deepEqual(p.back, {});
  const o = AutoLayout.planSpreads(items, { back: true, minSpreads: 6, maxSpreads: 12, foldSafe: false });
  assert.deepEqual(Object.keys(o).sort(), ['back', 'cover', 'dropped', 'maxSpreads', 'minSpreads', 'preferredPerSpread', 'spreads']);
});

// ── determinism, purity, validity ───────────────────────────────────────────
test('deterministic, does not mutate the items, no randomness or clock', () => {
  const items = randomBook(77, 40, rnd => rnd());
  const frozen = JSON.stringify(items);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('Math.random'); }; Date.now = () => { throw new Error('Date.now'); };
  let a, b;
  try { a = AutoLayout.planSpreads(items); b = AutoLayout.planSpreads(JSON.parse(frozen)); } finally { Math.random = r; Date.now = n; }
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
});

test('the template library is still valid, and exactly the hero family crosses the fold', () => {
  const v = ST.validate(ST.TEMPLATES);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const spanIds = ST.TEMPLATES.filter(t => t.slots.some(s => s.face === 'span')).map(t => t.id).sort();
  assert.deepEqual(spanIds, ['hero-bleed', 'hero-frame', 'hero-strip', 'hero-wide']);
});

test('enough non-span templates: for every photo count 1..8 the library has one without a span slot', () => {
  for (let k = 1; k <= 8; k++) {
    const some = ST.TEMPLATES.filter(t => t.slots.length === k && !t.slots.some(s => s.face === 'span'));
    assert.ok(some.length >= 1, `no span-free template for ${k} photos`);
  }
});

test('photosNeeded counts through-spreads only for photos that may take them: safe photos need fewer than risky ones (a library with no lone-photo page but a hero)', () => {
  const lib = ST.TEMPLATES.filter(t => ['hero-bleed', 'pair-portraits', 'pair-landscapes', 'one-two-right', 'two-one-left', 'quad-stacks'].includes(t.id));
  const mk = r => book(12, k => ({ aspect: 1.5, sharp: 60 + (k % 9) * 4, risk: r }));
  const safe = AutoLayout.planSpreads(mk(0.05), { templates: lib, minSpreads: 3 });
  const risky = AutoLayout.planSpreads(mk(0.9), { templates: lib, minSpreads: 3 });   // must not throw although a lone synthetic photo cannot be seated
  assert.equal(safe.minSpreads.photosNeeded, 5);
  assert.equal(risky.minSpreads.photosNeeded, 6);
  checkFold(risky, mk(0.9), 'risky');
});

test('photosNeeded / photosAllowed still answer under the rule (synthetic photos carry the same risk mix)', () => {
  const items = randomBook(55, 20, () => 0.9);
  const p = AutoLayout.planSpreads(items, { minSpreads: 30, maxSpreads: 3 });
  assert.equal(p.minSpreads.error, 'minSpreads-greater-than-maxSpreads');
  const q = AutoLayout.planSpreads(items, { minSpreads: 25 });
  assert.equal(typeof q.minSpreads.photosNeeded === 'number' || q.minSpreads.photosNeeded === null, true);
  assert.equal(q.minSpreads.photosNeeded, 25, 'single pages: one photo each, no hero needed');
  const r = AutoLayout.planSpreads(items, { maxSpreads: 3 });
  assert.equal(r.maxSpreads.photosAllowed, 24);
});
