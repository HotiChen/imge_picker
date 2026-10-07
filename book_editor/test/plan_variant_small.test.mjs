// node --test book_editor/test/plan_variant_small.test.mjs
//
// 再次編排 on SMALL books: with 4-12 photos most variants used to give the same plan, so the button looked dead.
// For variant > 0 the planner may now also (a) take another cover among the top candidates that pass the cover rules,
// (b) trade slots between same-orientation photos of one spread, (c) mirror a spread left-right.
// "Distinct" = the signature: cover photo + per spread template, mirror state and slot position of every photo.
// Variant 0 stays byte-identical (plan_variant.test.mjs pins the digests). Synthetic photos only.
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
const { wasteOf } = AutoLayout.util;

const HEX = '0123456789abcdef';
const hashOf = n => { let s = (n + 1) * 2654435761 >>> 0, h = ''; for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; } return h; };
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
// the signature the viewer uses too (js/album-preview.js planSignature)
const sig = p => JSON.stringify([p.cover.photoId, p.spreads.map(s => [s.template, !!s.mirrored,
  s.slots.map(x => [x.photoId, Math.round(x.slot.x * 1e4), Math.round(x.slot.y * 1e4), x.slot.face]).sort()])]);
const idsOf = p => p.spreads.flatMap(s => s.slots.map(x => x.photoId)).sort();
const SIZES = [4, 6, 8, 10, 12, 20, 30, 60];
const SEEDS = [1, 2, 3, 4, 5, 6];

test('variants 1..5 give at least 3 distinct plans on every size 4..60 and seed (positive control: variant 0 is not among them for most)', () => {
  let notZero = 0, total = 0;
  for (const n of SIZES) for (const seed of SEEDS) {
    const it = items(seed, n), set = new Set();
    for (let v = 1; v <= 5; v++) set.add(sig(plan(it, { variant: v })));
    assert.ok(set.size >= 3, `${n} photos seed ${seed}: ${set.size} distinct of variants 1..5`);
    total++; if (!set.has(sig(plan(it)))) notZero++;
  }
  assert.ok(notZero > total * 0.7, `variants differ from variant 0 (${notZero}/${total})`);
});

test('every variant keeps all photos, the cover rules, the fold rule, the hero gap, and is deterministic', () => {
  let coverChanged = 0, mirrored = 0, spans = 0;
  const risky = i => (i % 3 === 0 ? 0.95 : 0.1);
  for (const n of SIZES) for (const seed of SEEDS) for (const fold of [() => 0.1, risky]) {
    const it = items(seed, n, fold), base = plan(it), foldOf = new Map(it.map(x => [x.id, x.foldRisk])), asp = new Map(it.map(x => [x.id, x.aspect]));
    const w0 = wasteOf(asp.get(base.cover.photoId), AutoLayout.SPREAD_DEFAULTS.coverAspect);
    for (let v = 1; v <= 5; v++) {
      const p = plan(it, { variant: v }), l = `${n}/${seed}/v${v}`;
      assert.equal(sig(p), sig(plan(it, { variant: v })), `${l}: deterministic`);
      assert.deepEqual(idsOf(p), idsOf(base), `${l}: same photos inside`);
      // cover rules: same waste tier as the normal pick (<= 25% of the A4 page, else <= 45%), and 4+ photos only
      const cw = wasteOf(asp.get(p.cover.photoId), AutoLayout.SPREAD_DEFAULTS.coverAspect);
      if (n < 4 || w0 > 0.45) assert.equal(p.cover.photoId, base.cover.photoId, l);
      else assert.ok(cw <= (w0 <= 0.25 ? 0.25 : 0.45) + 1e-9, `${l}: cover waste ${cw}`);
      if (p.cover.photoId !== base.cover.photoId) coverChanged++;
      const at = [];
      p.spreads.forEach((s, i) => {
        if (s.mirrored) mirrored++;
        for (const x of s.slots) {
          if (x.slot.face === 'span') {
            spans++;
            assert.ok(foldOf.get(x.photoId) < AutoLayout.FOLD.LIMIT, `${l}: ${x.photoId} across the fold`);
          }
          // mirrored or not, a slot stays inside the spread and a left slot ends at or before the fold
          assert.ok(x.slot.x >= -1e-9 && x.slot.x + x.slot.w <= 1 + 1e-9, `${l}: slot inside`);
          if (x.slot.face === 'left') assert.ok(x.slot.x + x.slot.w <= 0.5 + 1e-9, `${l}: left face stays left of the fold`);
          if (x.slot.face === 'right') assert.ok(x.slot.x >= 0.5 - 1e-9, `${l}: right face stays right of the fold`);
        }
        if (s.slots.some(x => x.slot.face === 'span')) at.push(i);
      });
      assert.ok(at.every((x, i) => i === 0 || x - at[i - 1] > HERO_GAP), `${l}: hero gap`);
      assert.ok(p.spreads.every(s => s.slots.every(x => x.fit === 'contain')), `${l}: fit`);
    }
  }
  assert.ok(coverChanged > 20 && mirrored > 50 && spans > 0, `positive controls: cover ${coverChanged}, mirrored ${mirrored}, spans ${spans}`);
});

test('a mirrored spread is the exact left-right flip of an unmirrored layout of the same template', () => {
  let checked = 0;
  const tplById = new Map(vm.runInThisContext('SpreadTemplates').TEMPLATES.map(t => [t.id, t]));
  for (const n of [4, 8, 12, 30]) for (const seed of SEEDS) for (let v = 1; v <= 5; v++) {
    const p = plan(items(seed, n), { variant: v });
    for (const s of p.spreads) {
      const t = tplById.get(s.template);
      assert.ok(t, 'template exists');
      const flip = !!s.mirrored;
      const want = new Set(t.slots.map(q => JSON.stringify([flip ? Math.round((1 - q.x - q.w) * 1e4) : Math.round(q.x * 1e4), Math.round(q.y * 1e4),
        flip ? (q.face === 'left' ? 'right' : q.face === 'right' ? 'left' : q.face) : q.face])));
      const got = new Set(s.slots.map(x => JSON.stringify([Math.round(x.slot.x * 1e4), Math.round(x.slot.y * 1e4), x.slot.face])));
      assert.deepEqual([...got].sort(), [...want].sort(), `${n}/${seed}/v${v} ${s.template}`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('variant 0 never mirrors or reports a variant', () => {
  for (const n of SIZES) for (const seed of SEEDS) {
    const p = plan(items(seed, n));
    assert.ok(!('variant' in p) && p.spreads.every(s => !('mirrored' in s)));
  }
});

test('under 4 photos the cover and the photos are untouched (few variants is fine)', () => {
  for (const n of [1, 2, 3]) for (const seed of SEEDS) {
    const it = items(seed, n), base = plan(it);
    for (let v = 1; v <= 5; v++) {
      const p = plan(it, { variant: v });
      assert.equal(p.cover.photoId, base.cover.photoId);
      assert.deepEqual(idsOf(p), idsOf(base));
    }
  }
});

test('quality: mean slot waste of variants 1..5 on small books stays within +0.03 of variant 0 (any one book +0.2)', () => {
  const asp = it => new Map(it.map(x => [x.id, x.aspect]));
  let sum = 0, cnt = 0, worst = -1;
  const waste = (p, a) => { let t = 0, c = 0; for (const s of p.spreads) for (const x of s.slots) { t += wasteOf(a.get(x.photoId), x.slot.w * 420 / (x.slot.h * 297)); c++; } return c ? t / c : 0; };
  for (const n of SIZES) for (const seed of SEEDS) {
    const it = items(seed, n), a = asp(it), w0 = waste(plan(it), a);
    for (let v = 1; v <= 5; v++) { const d = waste(plan(it, { variant: v }), a) - w0; sum += d; cnt++; worst = Math.max(worst, d); }
  }
  assert.ok(sum / cnt <= 0.03, `mean +${(sum / cnt).toFixed(4)}`);
  assert.ok(worst <= 0.2, `worst +${worst.toFixed(3)}`);
});
