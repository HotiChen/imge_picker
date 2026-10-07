// Browser suites: album bleed — the trim guide in the guest's album preview (AlbumPreview.bleedMm) and the
// editor's ?bleed= hand-over. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { mockWorker } from '../lib/editor-mocks.mjs';
import { ALB_DESK, ALB_OWNER, ALB_VIEWER, albGalleryReady, albReady, albumWorld } from '../lib/album-world.mjs';

export default async function register() {

// What the current page is made of, measured on real pixels: the page box, the guide (if any), every slot.
const geo = page => page.evaluate(() => {
  const cur = document.querySelector('.album-slide[data-current="true"] .album-page');
  const pr = cur.getBoundingClientRect();
  const g = cur.querySelector('.album-bleed-guide');
  const gr = g && g.getBoundingClientRect();
  const slots = [...cur.querySelectorAll('.album-slot')].map(b => {
    const r = b.getBoundingClientRect();
    return { l: r.left - pr.left, r: r.right - pr.left, t: r.top - pr.top, b: r.bottom - pr.top, contain: b.dataset.fit === 'contain' };
  });
  return { kind: cur.dataset.kind, bleed: cur.dataset.bleed ?? null, w: pr.width, h: pr.height, slots,
    guide: gr ? { l: gr.left - pr.left, r: gr.right - pr.left, t: gr.top - pr.top, b: gr.bottom - pr.top, w: gr.width, h: gr.height,
      shadow: getComputedStyle(g).boxShadow, border: getComputedStyle(g).borderTopStyle, pe: getComputedStyle(g).pointerEvents } : null,
    guides: cur.querySelectorAll('.album-bleed-guide').length, html: cur.outerHTML };
});
const open = async (page, { bleed, plan, phone, edgeOnly }) => {
  if (edgeOnly) page.evaluate(async () => {
    // The planner picks few edge-to-edge templates on its own. The engine loads on the press, so wait for it and
    // append one spread of each edge template (every slot fit 'cover') to what the real planner returned.
    while (typeof AutoLayout === 'undefined' || typeof SpreadTemplates === 'undefined' || !AutoLayout.planSpreads) await new Promise(r => setTimeout(r, 2));
    const real = AutoLayout.planSpreads;
    AutoLayout.planSpreads = (...a) => {
      const plan = real(...a);
      const ids = [plan.cover.photoId, ...plan.spreads.flatMap(s => s.slots.map(x => x.photoId))];
      for (const id of ['hero-bleed', 'hero-wide', 'pair-bleed-small', 'hero-strip', 'grid4-big', 'big-grid4']) {
        const t = SpreadTemplates.byId(id);
        plan.spreads.push({ template: id, slots: t.slots.map((s, i) => ({ photoId: ids[i % ids.length], crop: { x: 0, y: 0, scale: 1 }, fit: 'cover', slot: { x: s.x, y: s.y, w: s.w, h: s.h } })) });
      }
      return plan;
    };
  });
  await page.evaluate(([b, p]) => { if (b !== 'unset') AlbumPreview.bleedMm = b; if (p) AlbumPreview.PLAN_OPTS = p; }, [bleed === undefined ? 'unset' : bleed, plan || null]);
  await albGalleryReady(page);
  if (phone) await page.tap('#albumPreviewBtn'); else await page.click('#albumPreviewBtn');
  await albReady(page);
  await page.waitForTimeout(150);
};
const closeV = async page => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('albumViewer')); };
const goNext = async page => { if (await page.evaluate(() => document.getElementById('albumNext').disabled)) return false; await page.click('#albumNext'); await page.waitForTimeout(120); return true; };

// ── 1. bleed 0 / null / junk: the old drawing, byte for byte (same markup whatever spelling of "none")
{
  const w = albumWorld({ n: 12 });
  await suite('album bleed: 0, null, undefined, junk and negative all draw the old page (no guide, no data-bleed, same markup)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      ok('the property defaults to 0', (await page.evaluate(() => AlbumPreview.bleedMm)) === 0);
      const variants = [undefined, 0, null, 'abc', -3, NaN];
      const seen = [];
      for (const v of variants) {
        await page.evaluate(() => { delete AlbumPreview.bleedMm; });
        await open(page, { bleed: v });
        const first = await geo(page);
        await goNext(page);
        const second = await geo(page);
        seen.push({ v, first, second });
        await closeV(page);
      }
      ok('every variant ran', seen.length === variants.length);
      ok('no page has a guide or a data-bleed', seen.every(s => [s.first, s.second].every(g => g.guides === 0 && g.guide === null && g.bleed === null)), JSON.stringify(seen.map(s => [s.first.guides, s.first.bleed])));
      ok('the markup is identical in every variant (cover and first spread)',
        seen.every(s => s.first.html === seen[0].first.html && s.second.html === seen[0].second.html));
      ok('positive control: the cover has a photo slot filling the page', seen[0].first.slots.length === 1 && Math.abs(seen[0].first.slots[0].l) < 0.5 && Math.abs(seen[0].first.slots[0].r - seen[0].first.w) < 0.5, JSON.stringify(seen[0].first.slots));
      const viaEntry = await page.evaluate(() => {
        const r = [];
        for (const v of [3, 2.5, 99, 'x', null, 0, -1]) { AlbumPreview.syncEntry({ show: false, bleedMm: v }); r.push(AlbumPreview.bleedMm); }
        AlbumPreview.syncEntry({ show: false }); r.push(AlbumPreview.bleedMm);   // no key: left alone
        return r;
      });
      ok('syncEntry({ bleedMm }) sets it, clamped to 0-10, junk = 0, absent = unchanged', JSON.stringify(viaEntry) === JSON.stringify([3, 2.5, 10, 0, 0, 0, 0, 0]), JSON.stringify(viaEntry));
      return out;
    },
    { initScript: ALB_OWNER, before: w.before, contextOptions: ALB_DESK });
}

// ── 2. bleed on, fit: 'cover': guide at 3/210 and 3/420 of the width, edge photos run into the strip, nothing sits half way
{
  const w = albumWorld({ n: 30 });
  await suite('album bleed 3mm, cover fit: the guide sits at the trim, edge photos run into the bleed, the rest stay put',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // the planner picks few edge-to-edge templates on its own: hand it only the ones with a slot on the page edge
      // (the engine loads on the press, so the filter waits for it and lands before the planning starts)
      await open(page, { bleed: 3, plan: { fit: 'cover' }, edgeOnly: true });
      const c = await geo(page);
      ok('cover: data-bleed is 3 and one guide exists', c.bleed === '3' && c.guides === 1, `${c.bleed} ${c.guides}`);
      const bx = c.w * 3 / 210, by = c.h * 3 / 297;
      ok('cover: the guide is inset 3/210 of the width and 3/297 of the height',
        Math.abs(c.guide.l - bx) < 1 && Math.abs(c.w - c.guide.r - bx) < 1 && Math.abs(c.guide.t - by) < 1 && Math.abs(c.h - c.guide.b - by) < 1,
        JSON.stringify([c.guide, bx, by]));
      ok('the guide is dashed, dims the strip (box-shadow), and never takes a touch', c.guide.border === 'dashed' && /rgba\(0, 0, 0, 0\.\d+\)/.test(c.guide.shadow) && c.guide.pe === 'none', JSON.stringify(c.guide));
      ok('cover: the photo runs to the sheet edge on all four sides (into the bleed)',
        c.slots.length === 1 && Math.abs(c.slots[0].l) < 0.5 && Math.abs(c.slots[0].t) < 0.5 && Math.abs(c.slots[0].r - c.w) < 0.5 && Math.abs(c.slots[0].b - c.h) < 0.5, JSON.stringify(c.slots));
      // every spread: slot edges are inside the trim, or exactly on the sheet edge (bleed) — never half way
      let pages = 0, reached = 0, spreadDx = null;
      for (let i = 0; i < 30; i++) {
        if (!(await goNext(page))) break;
        const g = await geo(page);
        if (g.kind !== 'spread') break;
        pages++;
        const bxs = g.w * 3 / 420, bys = g.h * 3 / 297;
        if (spreadDx === null) spreadDx = [g.guide.l - bxs, g.w - g.guide.r - bxs, g.guide.t - bys];
        for (const s of g.slots) {
          const inL = s.l > 0.6 && s.l < bxs - 0.6, inR = s.r < g.w - 0.6 && s.r > g.w - bxs + 0.6;
          const inT = s.t > 0.6 && s.t < bys - 0.6, inB = s.b < g.h - 0.6 && s.b > g.h - bys + 0.6;
          if (inL || inR || inT || inB) out.push(`FAIL  a slot edge sits inside the bleed strip, half way: ${JSON.stringify(s)}`);
          if (s.l < -0.6 || s.t < -0.6 || s.r > g.w + 0.6 || s.b > g.h + 0.6) out.push(`FAIL  a slot leaves the sheet: ${JSON.stringify(s)}`);
          if (s.l < 0.6 || s.t < 0.6 || s.r > g.w - 0.6 || s.b > g.h - 0.6) reached++;
        }
      }
      ok('spreads were checked', pages >= 2, String(pages));
      ok('spread: the guide is inset 3/420 of the width (the page is two A4)', spreadDx && Math.abs(spreadDx[0]) < 1 && Math.abs(spreadDx[1]) < 1 && Math.abs(spreadDx[2]) < 1, JSON.stringify(spreadDx));
      ok('positive: some spread slot runs into the bleed', reached > 0, String(reached));
      return out;
    },
    { initScript: ALB_OWNER, before: w.before, contextOptions: ALB_DESK });
}

// ── 3. bleed on, contain (default plan): no photo reaches into the strip; guide still shown
for (const [label, co, init, phone] of [['desktop', ALB_DESK, ALB_OWNER, false], ['phone 390', MOBILE, ALB_VIEWER, true]]) {
  const w = albumWorld({ n: 14 });
  await suite(`album bleed 3mm, contain fit ${label}: the whole photo stays inside the trim line`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page, { bleed: 3, phone });
      let checked = 0, bad = 0, containSeen = 0;
      for (let i = 0; i < 6; i++) {
        const g = await geo(page);
        ok(`page ${i}: guide present`, g.guides === 1 && !!g.guide);
        const wmm = g.kind === 'spread' ? 420 : 210;
        const bxs = g.w * 3 / wmm, bys = g.h * 3 / 297;
        for (const s of g.slots) {
          checked++;
          if (s.contain) containSeen++;
          if (s.l < bxs - 0.6 || s.t < bys - 0.6 || s.r > g.w - bxs + 0.6 || s.b > g.h - bys + 0.6) bad++;
        }
        if (!(await goNext(page))) break;
      }
      ok('slots were scanned (floor)', checked >= 4, String(checked));
      ok('they are contain slots', containSeen === checked, `${containSeen}/${checked}`);
      ok('none reaches into the bleed strip', bad === 0, String(bad));
      return out;
    },
    { initScript: init, before: w.before, contextOptions: co });
}

// ── 4. the editor takes the product's number from ?bleed=
{
  const run = (label, query, expect) => suite(`editor ?bleed= ${label}`,
    `${base}/book_editor/index.html${query}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.waitForTimeout(500);
      const got = await page.evaluate(() => ({ s: window.bookEditor.book.settings.bleed, v: document.getElementById('bookBleed').value, hint: document.getElementById('exportSizeHint').textContent, w: window.bookEditor.book.settings.width, h: window.bookEditor.book.settings.height }));
      ok(`book bleed is ${expect}`, got.s === expect, JSON.stringify(got));
      ok(`the input shows ${expect}`, +got.v === expect, JSON.stringify(got));
      if (expect === 2.5) ok('the export hint carries it (page size + 0.5 cm)', got.hint.includes(`${+(got.w + 0.5).toFixed(2)} × ${+(got.h + 0.5).toFixed(2)}`), got.hint);
      return out;
    },
    { initScript: () => { sessionStorage.setItem('studio_token', 'x'); try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {} }, before: mockWorker(8) });
  await run('2.5 is applied to the book and the input', '?bleed=2.5', 2.5);
  await run('0 is a real value (no bleed), not "missing"', '?bleed=0', 0);
  await run('junk is ignored (default 3)', '?bleed=abc', 3);
  await run('more than 10 mm is ignored (the product can never say it)', '?bleed=99', 3);
  await run('negative is ignored', '?bleed=-1', 3);
}

}
