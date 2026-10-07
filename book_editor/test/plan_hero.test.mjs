// node --test book_editor/test/plan_hero.test.mjs
//
// planSpreads option `heroRate` (default 0.2 = about one full-bleed single-photo spread per 5 spreads for books of >= 8
// spreads; 0 / false / null = the previous behaviour: one hero from 6 spreads on, none below). Hard rules stay: HERO_GAP spacing,
// never the cover, foldSafe, min/maxSpreads win, no hero from a weak (sharpness below the median) or portrait photo, deterministic.
// result.variety.heroWanted = what the rate asks for (capped by suitable photos and by the gap), heroSpreads = what the plan has.
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
const sizes = p => p.spreads.map(s => s.slots.length);
const isHero = s => s.slots.length === 1 && s.slots[0].slot.face === 'span';
const heroIdx = p => p.spreads.flatMap((s, i) => (isHero(s) ? [i] : []));
const ids = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId)).sort();
const SEEDS = [1, 2, 3, 4, 5, 6];
const total = (n, o = {}, fold) => SEEDS.reduce((a, s) => a + heroIdx(plan(items(s, n, fold), o)).length, 0);

test('default rate: books of 20 / 30 / 44 photos get clearly more heroes than heroRate 0', () => {
  for (const n of [20, 30, 44]) {
    const was = total(n, { heroRate: 0 }), now = total(n);
    assert.ok(n === 20 ? now > was : now >= was + SEEDS.length / 2, `${n} photos: ${was} -> ${now}`);
  }
});

test('default rate: at 30 photos every seed has at least 2 heroes (known-low risk, plenty of suitable photos)', () => {
  for (const s of SEEDS) {
    const p = plan(items(s, 30));
    assert.ok(heroIdx(p).length >= 2, `seed ${s}: ${sizes(p).join('')}`);
  }
});

test('heroRate 0 / false / null is the previous behaviour, plan for plan', () => {
  for (const n of [12, 20, 30]) for (const s of SEEDS) {
    const a = plan(items(s, n), { heroRate: 0 });
    for (const off of [false, null]) assert.deepEqual(plan(items(s, n), { heroRate: off }).spreads, a.spreads);
    assert.ok(a.variety.heroWanted <= 1);
  }
});

test('variety reports heroWanted next to heroSpreads; heroWanted never asks for more than the gap or the suitable photos allow', () => {
  for (const n of [12, 20, 30, 44]) for (const s of SEEDS) {
    const p = plan(items(s, n));
    assert.equal(typeof p.variety.heroWanted, 'number');
    assert.ok(p.variety.heroWanted <= Math.ceil(p.spreads.length / (HERO_GAP + 1)));
    assert.ok(p.variety.heroSpreads <= p.variety.heroWanted + 1 || p.variety.heroSpreads <= Math.ceil(p.spreads.length / (HERO_GAP + 1)));
  }
});

test('heroes keep the gap, are never the cover, every photo is placed once', () => {
  for (const n of [20, 30, 44]) for (const s of SEEDS) {
    const it = items(s, n), p = plan(it), at = heroIdx(p);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] > HERO_GAP, `gap ${at}`);
    const hero = new Set(p.spreads.filter(isHero).map(x => x.slots[0].photoId));
    assert.ok(!hero.has(p.cover.photoId));
    assert.deepEqual(ids(p), it.map(x => x.id).sort());     // the cover photo is also inside, so every photo exactly once in the spreads
  }
});

test('a hero is never a portrait or a photo below the median sharpness', () => {
  for (const n of [20, 30, 44]) for (const s of SEEDS) {
    const it = items(s, n), p = plan(it);
    const sharp = it.map(x => x.sharpness).sort((a, b) => a - b), med = sharp[Math.floor(sharp.length / 2)];
    const by = new Map(it.map(x => [x.id, x]));
    for (const sp of p.spreads.filter(isHero)) {
      const r = by.get(sp.slots[0].photoId);
      assert.notEqual(r.orientation, 'portrait');
      assert.ok(r.sharpness >= med - 1, `sharpness ${r.sharpness} < median ${med}`);
    }
  }
});

test('foldSafe: a photo with a high risk is never a hero, however many heroes are wanted', () => {
  const fold = i => (i % 2 ? 0.9 : 0.1);
  for (const n of [20, 30, 44]) for (const s of SEEDS) {
    const it = items(s, n, fold), p = plan(it, { heroRate: 0.5 });
    const by = new Map(it.map(x => [x.id, x]));
    for (const sp of p.spreads) for (const x of sp.slots) if (x.slot.face === 'span') assert.ok(by.get(x.photoId).foldRisk < AutoLayout.FOLD.LIMIT);
    assert.ok(heroIdx(p).length > 0, 'control: heroes exist');
  }
});

test('with every photo high-risk (or no risk known) there is no hero, and heroWanted says 0 rather than asking for one', () => {
  for (const fold of [() => 0.9, () => null]) for (const n of [12, 30]) {
    const p = plan(items(2, n, fold));
    assert.equal(heroIdx(p).length, 0);
    assert.equal(p.variety.heroWanted, 0);
  }
});

test('too few suitable photos: fewer heroes than the rate asks for, reported, nothing forced', () => {
  const fold = i => (i % 6 === 0 ? 0.1 : 0.9);       // only every sixth photo may span
  const p = plan(items(3, 40, fold));
  assert.ok(p.variety.heroSpreads <= 7);
  assert.ok(p.variety.heroWanted <= 7);
});

test('maxSpreads / minSpreads still win over the hero wish', () => {
  for (const s of SEEDS) {
    const hi = plan(items(s, 30), { maxSpreads: 6 });
    assert.ok(hi.spreads.length <= 6, `max: ${hi.spreads.length}`);
    const lo = plan(items(s, 20), { minSpreads: 9 });
    assert.ok(lo.spreads.length >= 9, `min: ${lo.spreads.length}`);
  }
});

test('deterministic: the same photos and options give the same plan', () => {
  for (const s of SEEDS) assert.deepEqual(plan(items(s, 30)), plan(items(s, 30)));
});

test('a higher heroRate never gives fewer heroes (same photos) ... within the gap', () => {
  for (const s of SEEDS) {
    const a = heroIdx(plan(items(s, 44), { heroRate: 0.1 })).length, b = heroIdx(plan(items(s, 44), { heroRate: 0.3 })).length;
    assert.ok(b >= a, `${a} vs ${b}`);
  }
});

test('short books (under 8 spreads) are not asked for more than the one hero they got before', () => {
  for (const s of SEEDS) assert.ok(plan(items(s, 12)).variety.heroWanted <= 1);
});

test('foldUnknown: the number of photos whose risk was not measured (they count as high-risk); absent when all are known', () => {
  const known = plan(items(2, 30));
  assert.equal('foldUnknown' in known, false);
  const some = plan(items(2, 30, i => (i < 10 ? null : 0.1)));
  assert.equal(some.foldUnknown, 10);
  const none = plan(items(2, 30, () => null));
  assert.equal(none.foldUnknown, 30);
  assert.equal(plan(items(2, 30, () => NaN)).foldUnknown, 30);
});

// n photos shaped by hand: aspect, sharpness, risk per index
const SHARP3 = new Set([8, 20, 32]);
const book = (n, f) => Array.from({ length: n }, (_, i) => {
  const { aspect = 1.5, sharpness = i, foldRisk = 0.1 } = f(i);
  return { id: `IMG_${String(i + 1).padStart(3, '0')}.jpg`, ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(500 + i), sharpness, focus: { x: 0.5, y: 0.5 }, foldRisk };
});

test('heroWanted is capped by the suitable photos: three fold-safe photos (one is the cover) in 40 -> 2 wanted, none else placed', () => {
  const it = book(40, i => ({ sharpness: SHARP3.has(i) ? 100 - i : i, foldRisk: SHARP3.has(i) ? 0.1 : 0.9 }));       // three safe, sharp photos; the cover takes one
  const p = plan(it, { heroRate: 0.5 });
  assert.ok(p.spreads.length >= 11, 'control: the rate and the gap alone would allow 3');
  assert.equal(p.variety.heroWanted, 2);
  assert.ok(heroIdx(p).length <= 2);
  const safe = new Set([...SHARP3].map(i => it[i].id));
  for (const sp of p.spreads.filter(isHero)) assert.ok(safe.has(sp.slots[0].photoId));
});

test('heroWanted is capped by the suitable photos: three landscape photos among portraits -> as many wanted as can be a hero', () => {
  const it = book(60, i => ({ sharpness: SHARP3.has(i) ? 100 - i : i, aspect: SHARP3.has(i) ? 1.5 : 0.667 }));
  const p = plan(it, { heroRate: 0.5 });
  assert.ok(p.spreads.length >= 16, `control: the rate and the gap alone would allow 4 (${p.spreads.length} spreads)`);
  const coverIsOne = [...SHARP3].some(i => it[i].id === p.cover.photoId);      // a portrait cover leaves all three
  assert.equal(p.variety.heroWanted, coverIsOne ? 2 : 3);
  const land = new Set([...SHARP3].map(i => it[i].id));
  for (const sp of p.spreads.filter(isHero)) assert.ok(land.has(sp.slots[0].photoId));
});

test('a book of sharp landscapes only: heroWanted follows the rate and the heroes are all placed', () => {
  const p = plan(book(30, i => ({ sharpness: 50 + (i * 7) % 40 })));
  assert.ok(p.variety.heroWanted >= 2, `wanted ${p.variety.heroWanted}`);
  assert.equal(p.variety.heroSpreads, p.variety.heroWanted);
});

test('a wish that cannot be met is not met with an unsuitable photo: the only suitable photos sit where no hero fits, the heroes stay out of portraits', () => {
  for (const at of [[36, 37, 38], [0, 1, 2], [38, 39, 20]]) {
    const keep = new Set(at);
    const it = book(40, i => ({ sharpness: keep.has(i) ? 100 - i : i, aspect: keep.has(i) ? 1.5 : 0.667 }));
    const p = plan(it, { heroRate: 0.5 });
    for (const sp of p.spreads.filter(isHero)) assert.ok(keep.has(Number(sp.slots[0].photoId.slice(4, 7)) - 1), `${at}: ${sp.slots[0].photoId}`);
  }
});
