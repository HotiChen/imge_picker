// Browser suites: the album preview's cover title and 再次編排 (docs/album-preview.md, "Cover title" and "Re-layout").
// The 完成頁 (a delivered, confirmed project) hands the project title to the preview; the cover shows it at the top;
// 再次編排 re-plans the same photos with another planner `variant`. Nothing is stored. Synthetic SVG photos, Chromium only.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, ALB_VIEWER, albReady, albSnap, albumWorld } from '../lib/album-world.mjs';
import { shopProductsFake } from '../lib/pick-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const world = (o = {}) => albumWorld({
  n: o.n ?? 30,
  fake: { title: o.title ?? '婚禮精修', confirmedAt: T0, studio: { name: '光影工作室', has_logo: false }, shopProducts: shopProductsFake(), ...(o.fake || {}) },
});
const SPIES = ALB_VIEWER;
// the completion page, the shop settled, the entry there; `setup` runs in the page before the press
const open = async (page, setup, phone) => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 8000 });
  if (setup) await page.evaluate(setup);
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  if (phone) await page.tap('#albumPreviewBtn'); else await page.click('#albumPreviewBtn');
  await albReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
  await page.waitForTimeout(150);
};
const closeV = async page => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('albumViewer')); };
const next = async page => { await page.click('#albumNext'); await page.waitForTimeout(120); };
// the title on the current page, measured in the page's own box
const titleGeo = page => page.evaluate(() => {
  const cur = document.querySelector('.album-slide[data-current="true"] .album-page');
  const pr = cur.getBoundingClientRect();
  const t = cur.querySelector('.album-cover-title'), tx = t && t.querySelector('.album-cover-title-text');
  if (!t) return { kind: cur.dataset.kind, none: true, titles: document.querySelectorAll('#albumViewer .album-cover-title').length };
  const r = tx.getBoundingClientRect(), cs = getComputedStyle(tx), tcs = getComputedStyle(t);
  const range = document.createRange(); range.selectNodeContents(tx);
  const rr = range.getBoundingClientRect();
  const g = cur.querySelector('.album-bleed-guide'), gr = g && g.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight);
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { kind: cur.dataset.kind, none: false, text: tx.textContent, dir: t.getAttribute('dir'), html: t.innerHTML, children: tx.children.length,
    page: { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom, w: pr.width, h: pr.height },
    box: { l: r.left, t: r.top, r: r.right, b: r.bottom }, ink: { l: rr.left, t: rr.top, r: rr.right, b: rr.bottom },
    guide: gr ? { l: gr.left, t: gr.top, r: gr.right, b: gr.bottom } : null,
    fs: parseFloat(cs.fontSize), lines: Math.round(r.height / lh), color: cs.color, pe: tcs.pointerEvents, bg: tcs.backgroundImage, ta: cs.textAlign,
    hitIsTitle: !!hit && t.contains(hit), iw: innerWidth, sw: document.documentElement.scrollWidth, titles: document.querySelectorAll('#albumViewer .album-cover-title').length };
});

// ── 1. the title on the cover: top, white on a dark fade, centred, inside the page and the viewport, no gestures
for (const [label, co, phone] of [['390px', MOBILE, true], ['1500px', { viewport: { width: 1500, height: 950 } }, false]]) {
  const w = world();
  await suite(`album cover title ${label} — the project title sits at the top of the cover, white on a dark fade, centred, one line, taking no taps`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, null, phone);
      const g = await titleGeo(page);
      ok('the cover page carries exactly one title, with the project title as its text', g.kind === 'cover' && !g.none && g.text === '婚禮精修' && g.titles === 1, JSON.stringify([g.kind, g.text, g.titles]));
      ok('it is plain text (no child elements), dir=auto', g.children === 0 && g.dir === 'auto' && g.html.indexOf('<div class="album-cover-title-text">') === 0, g.html);
      const cx = (g.ink.l + g.ink.r) / 2, pcx = (g.page.l + g.page.r) / 2;
      ok('at the TOP of the cover (its text in the top quarter)', g.ink.b - g.page.t < g.page.h * 0.25 && g.ink.t >= g.page.t, JSON.stringify([g.ink, g.page]));
      ok('centred on the page', Math.abs(cx - pcx) < 2 && g.ta === 'center', `${cx} vs ${pcx}`);
      ok('inside the page and inside the viewport, no horizontal scroll', g.ink.l >= g.page.l && g.ink.r <= g.page.r && g.ink.l >= 0 && g.ink.r <= g.iw && g.sw <= g.iw, JSON.stringify([g.ink, g.iw, g.sw]));
      ok('white text over a dark gradient', g.color === 'rgb(255, 255, 255)' && /linear-gradient\(/.test(g.bg) && /rgba\(0, 0, 0/.test(g.bg), `${g.color} ${g.bg}`);
      ok('one line for a short title, sized in the page (about 7% of its width), not a fixed px', g.lines === 1 && Math.abs(g.fs / g.page.w - 0.07) < 0.004, `${g.fs} / ${g.page.w}`);
      ok('it takes no tap: pointer-events none and a hit test at its middle lands elsewhere', g.pe === 'none' && !g.hitIsTitle, JSON.stringify([g.pe, g.hitIsTitle]));
      // spreads: nothing
      await next(page);
      const s = await titleGeo(page);
      ok('the first spread has no title (and the viewer has only the one title, on the cover)', s.kind === 'spread' && s.none && s.titles === 1, JSON.stringify(s));
      // the page-size ratio, for the two widths, is checked in the next suite via the numbers in the report
      out.push(`info  ${label}: font ${g.fs.toFixed(2)}px on a ${g.page.w.toFixed(0)}px cover`);
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: co });
}

// ── 2. long titles: shrink, wrap to two lines, ellipsis; markup in a title stays text; RTL via dir=auto
{
  const cases = [
    ['a long Chinese title', '這是一個非常非常長的專案名稱用來測試封面標題是否會縮小並且最多只顯示兩行然後以刪節號結尾而不會超出頁面範圍之外的情形', 4],
    ['a long latin title', 'Anna and Brian Wedding Weekend at the Lakeside Estate with Family and Friends, Photographed Over Three Days in September', 4],
    ['a medium title', '安妮與布萊恩的婚禮 2026 秋季精選', 2],
  ];
  for (const [name, title, tier] of cases) {
    const w = world({ title });
    await suite(`album cover title 390px — ${name}: smaller tier, at most two lines, inside the cover and the viewport`,
      `${base}/index.html?t=TOK`,
      async page => {
        const out = [], ok = line(out);
        await open(page, null, true);
        const g = await titleGeo(page);
        ok('the title is drawn with its full text (the ellipsis is CSS, not a cut string)', g.text === title, g.text);
        ok(`it uses the smaller tier ${tier}`, await page.evaluate(() => document.querySelector('.album-cover-title').dataset.tier) === String(tier));
        ok('at most two lines', g.lines >= 1 && g.lines <= 2, String(g.lines));
        ok('smaller than the short-title size, still readable (>= 3% of the page width)', g.fs / g.page.w < 0.07 && g.fs / g.page.w >= 0.03, `${g.fs} / ${g.page.w}`);
        ok('inside the page and the viewport', g.ink.l >= g.page.l - 0.5 && g.ink.r <= g.page.r + 0.5 && g.ink.r <= g.iw && g.sw <= g.iw, JSON.stringify([g.ink, g.page, g.iw]));
        if (name !== 'a medium title') {
          const clip = await page.evaluate(() => { const e = document.querySelector('.album-cover-title-text'); return { over: e.scrollHeight > e.clientHeight + 1, ov: getComputedStyle(e).overflow, lc: getComputedStyle(e).webkitLineClamp }; });
          ok('too long for two lines: clamped (overflow hidden, line-clamp 2)', clip.over && clip.ov === 'hidden' && clip.lc === '2', JSON.stringify(clip));
        }
        const top = await page.evaluate(() => { const t = document.querySelector('.album-cover-title').getBoundingClientRect(), p = document.querySelector('.album-slide[data-current="true"] .album-page').getBoundingClientRect(); return t.height / p.height; });
        ok('the title block never grows past a third of the cover', top < 0.34, String(top));
        return out;
      },
      { before: w.before, initScript: SPIES, contextOptions: MOBILE });
  }
}
{
  const evil = '<img src=x onerror="window.__pwned=1"><b>粗</b>&amp;';
  const w = world({ title: evil });
  await suite('album cover title — markup in a title is text: no element is created, nothing runs', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, null, true);
      const g = await titleGeo(page);
      ok('the text is the literal string', g.text === evil, g.text);
      ok('no child element, the markup is escaped in the DOM', g.children === 0 && /&lt;img/.test(g.html), g.html);
      ok('nothing ran and no <img> inside the title', await page.evaluate(() => !window.__pwned && !document.querySelector('.album-cover-title img')));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}

// ── 3. empty / missing / blank title: nothing is added, the cover is the old markup
{
  const w = world({ title: '' });
  await suite('album cover title — empty, blank or missing title adds nothing: the cover markup is exactly the title-free one', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      const snap = async setTitle => {
        await open(page, setTitle, true);
        const r = await page.evaluate(() => ({ html: document.querySelector('.album-slide[data-current="true"] .album-page').outerHTML, titles: document.querySelectorAll('.album-cover-title').length, titled: document.querySelectorAll('[data-titled]').length }));
        await closeV(page);
        return r;
      };
      const empty = await snap(() => { AlbumPreview.coverTitle = ''; });
      ok('page title empty: the completion page hero says its fallback, the preview cover has no title', (await page.evaluate(() => document.getElementById('cpTitle').textContent)) === '精修成品' && empty.titles === 0 && empty.titled === 0, JSON.stringify([empty.titles, empty.titled]));
      const blank = await snap(() => { AlbumPreview.coverTitle = '   \n'; });
      const missing = await snap(() => { AlbumPreview.coverTitle = undefined; });
      const nonStr = await snap(() => { AlbumPreview.coverTitle = 42; });
      ok('blank, undefined and a non-string title: byte-identical markup to the empty one', blank.html === empty.html && missing.html === empty.html && nonStr.html === empty.html);
      ok('control: the markup is real (it has the cover photo)', /album-img/.test(empty.html) && empty.html.length > 200, String(empty.html.length));
      const titled = await snap(() => { AlbumPreview.coverTitle = '有標題'; });
      ok('control: with a title the cover really changes', titled.titles === 1 && titled.titled === 1 && titled.html !== empty.html);
      const stripped = await page.evaluate(h => { const d = document.createElement('div'); d.innerHTML = h; const p = d.firstElementChild; p.querySelector('.album-cover-title').remove(); p.removeAttribute('data-titled'); return p.outerHTML; }, titled.html);
      ok('and removing the title (and its container marker) gives back exactly the title-free markup', stripped === empty.html);
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}

// ── 4. cover only: the back page, the spreads; and the bleed strip
{
  const w = world();
  await suite('album cover title — back page and every spread have none; with a bleed the title sits inside the trim, not in the dimmed strip', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, () => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, back: true }; AlbumPreview.bleedMm = 10; }, true);
      const c = await titleGeo(page);
      ok('cover: titled, with a trim guide', c.kind === 'cover' && !c.none && c.guide, JSON.stringify(c.guide));
      ok('the title text is inside the trim line (left, right and top), not in the bleed strip', c.guide && c.ink.l >= c.guide.l && c.ink.r <= c.guide.r && c.ink.t >= c.guide.t, JSON.stringify([c.ink, c.guide]));
      ok('control: the bleed strip is really there (the guide is inset from the page)', c.guide.l - c.page.l > 5 && c.guide.t - c.page.t > 5, JSON.stringify([c.guide, c.page]));
      const kinds = [];
      let guard = 0;
      while (!(await page.evaluate(() => document.getElementById('albumNext').disabled)) && guard++ < 40) {
        await next(page);
        const g = await titleGeo(page);
        kinds.push(g.kind + (g.none ? '' : '+TITLE'));
      }
      ok('the last page is the back cover (a plan with back: true), and no page after the cover has a title', kinds[kinds.length - 1] === 'back' && kinds.every(k => !k.includes('TITLE')) && kinds.length >= 3, kinds.join());
      ok('the DOM holds no title now (only the current page and its neighbours exist, none is the cover)', (await titleGeo(page)).titles === 0);
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}

{
  const w = world({ title: '這是一個非常非常長的專案名稱用來測試封面標題在有出血的時候是否仍然留在裁切線之內而不會跑進被裁掉的那一圈' });
  await suite('album cover title 390px — a long title with a bleed stays inside the trim line on both sides', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, () => { AlbumPreview.bleedMm = 10; }, true);
      const c = await titleGeo(page);
      ok('control: two full lines (the text reaches across the page)', c.lines === 2 && c.ink.r - c.ink.l > c.page.w * 0.6, JSON.stringify([c.lines, c.ink, c.page.w]));
      ok('left and right ink edges are inside the trim guide, and the top too', c.guide && c.ink.l >= c.guide.l && c.ink.r <= c.guide.r && c.ink.t >= c.guide.t, JSON.stringify([c.ink, c.guide]));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}

// ── 5. 再次編排: the button, the variants, the bounds, the clamp, 回到原本, nothing stored
{
  const w = world({ n: 30 });
  await suite('album re-layout 390px — button is 44px and on screen, another layout each press, 回到原本 restores; same photos, counters, cover title redrawn, bounds kept', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, () => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, minSpreads: 4, maxSpreads: 7 }; }, true);
      const geo = () => page.evaluate(() => {
        const R = id => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, disp: cs.display, hidden: e.hidden }; };
        return { again: R('albumRelayout'), back: R('albumRelayoutBack'), cap: document.getElementById('albumRelayoutCap')?.textContent, iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth,
          text: document.getElementById('albumRelayout')?.textContent, backText: document.getElementById('albumRelayoutBack')?.textContent };
      });
      const g0 = await geo();
      ok('再次編排 is there, >= 44px tall, on screen, with the label', g0.again && g0.text === '再次編排' && g0.again.h >= 44 && g0.again.w >= 44 && g0.again.l >= 0 && g0.again.r <= g0.iw && g0.again.t >= 0 && g0.again.b <= g0.ih, JSON.stringify(g0.again));
      ok('回到原本 exists but is hidden until a variant is active (not displayed)', g0.back && g0.backText === '回到原本' && g0.back.hidden && g0.back.disp === 'none', JSON.stringify(g0.back));
      ok('the caption says the layout is automatic and invites another', /系統自動排版的示意/.test(g0.cap || '') && /換個排法/.test(g0.cap || ''), g0.cap);
      ok('no horizontal scroll', g0.sw <= g0.iw);
      const plan = async () => { // the full layout sequence of the viewer: walk the pages
        const seq = [];
        await page.evaluate(() => { while (!document.getElementById('albumPrev').disabled) document.getElementById('albumPrev').click(); });
        await page.waitForTimeout(100);
        for (let guard = 0; guard < 40; guard++) {
          const s = await albSnap(page); const c = s.slides.find(x => x.cur);
          seq.push(`${c.layout}:${c.ids.join('+')}`);
          if (s.nextDis) break;
          await page.click('#albumNext'); await page.waitForTimeout(90);
        }
        await page.evaluate(() => { while (!document.getElementById('albumPrev').disabled) document.getElementById('albumPrev').click(); });
        await page.waitForTimeout(100);
        return seq;
      };
      const l0 = await plan();
      const photos = seq => seq.slice(1).flatMap(s => s.split(':')[1].split('+')).sort().join();
      ok('the first layout has a cover and 4..7 spreads (the bounds)', l0.length >= 5 && l0.length - 1 <= 7, String(l0.length));
      const seen = new Set([l0.join('|')]);
      const layouts = [];
      for (let i = 1; i <= 4; i++) {
        await page.click('#albumRelayout'); await page.waitForTimeout(250);
        await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(im => im.complete), null, { timeout: 8000 });
        const l = await plan();
        layouts.push(l); seen.add(l.join('|'));
        ok(`press ${i}: still the same photos on the spreads, spread count inside 4..7`, photos(l) === photos(l0) && l.length - 1 >= 4 && l.length - 1 <= 7, `${photos(l).length} vs ${photos(l0).length}; ${l.length - 1}`);
      }
      ok('the presses give at least 3 distinct layouts in all (the first one included)', seen.size >= 3, String(seen.size));
      const g1 = await geo();
      ok('回到原本 is shown now (visible, >= 44px, on screen)', !g1.back.hidden && g1.back.disp !== 'none' && g1.back.h >= 44 && g1.back.r <= g1.iw && g1.back.l >= 0, JSON.stringify(g1.back));
      ok('buttons do not overlap and the page has no horizontal scroll', (g1.again.r <= g1.back.l || g1.back.r <= g1.again.l) && g1.sw <= g1.iw);
      // counters and clamp: go to the LAST page, re-layout, the index is clamped into the new page list
      await page.evaluate(() => { while (!document.getElementById('albumNext').disabled) document.getElementById('albumNext').click(); });
      await page.waitForTimeout(150);
      await page.click('#albumRelayout'); await page.waitForTimeout(250);
      const s = await albSnap(page);
      const total = s.slides.length ? await page.evaluate(() => { const l = document.getElementById('albumLabel').textContent; return l; }) : '';
      ok('after a re-layout on the last page the counter is a valid "n / total" (n <= total) and a current slide exists', /^(\d+) \/ (\d+)$/.test(total) && +RegExp.$1 <= +RegExp.$2 && !!s.slides.find(x => x.cur), total);
      // 2nd spread kept: index stays when it still exists
      await page.evaluate(() => { while (!document.getElementById('albumPrev').disabled) document.getElementById('albumPrev').click(); });
      await next(page); await next(page);
      const before = await page.evaluate(() => document.getElementById('albumLabel').textContent);
      await page.click('#albumRelayout'); await page.waitForTimeout(250);
      const after = await page.evaluate(() => document.getElementById('albumLabel').textContent);
      ok('on spread 2 a re-layout stays on page index 2 ("2 / total")', /^2 \/ \d+$/.test(before) && /^2 \/ \d+$/.test(after), `${before} -> ${after}`);
      // cover title redrawn
      await page.evaluate(() => { while (!document.getElementById('albumPrev').disabled) document.getElementById('albumPrev').click(); });
      await page.waitForTimeout(150);
      await page.click('#albumRelayout'); await page.waitForTimeout(250);
      const ct = await titleGeo(page);
      ok('on the cover a re-layout redraws the cover with its title', ct.kind === 'cover' && !ct.none && ct.text === '婚禮精修' && ct.titles === 1, JSON.stringify([ct.kind, ct.text, ct.titles]));
      // 回到原本
      await page.click('#albumRelayoutBack'); await page.waitForTimeout(250);
      const focusOnAgain = await page.evaluate(() => document.activeElement?.id === 'albumRelayout');
      const back = await plan();
      ok('回到原本 gives exactly the first layout again', back.join('|') === l0.join('|'));
      const g2 = await geo();
      ok('and 回到原本 hides itself again, the focus moved to 再次編排', g2.back.hidden && g2.back.disp === 'none' && focusOnAgain, JSON.stringify(g2.back));
      // determinism: press once = the same as the first press before
      await page.click('#albumRelayout'); await page.waitForTimeout(250);
      const again1 = await plan();
      ok('deterministic: the first press after 回到原本 gives the same layout as the first press before', again1.join('|') === layouts[0].join('|'));
      // nothing stored, nothing sent
      const stored = await page.evaluate(() => window.__storageWrites.filter(w => /album|variant|relayout/i.test(JSON.stringify(w))));
      ok('nothing was written to storage for any of it', stored.length === 0, JSON.stringify(stored));
      ok('no request but GET', w.log.every(r => r.method === 'GET'), JSON.stringify(w.log.filter(r => r.method !== 'GET')));
      // closing resets the variant
      await closeV(page);
      await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
      await page.tap('#albumPreviewBtn'); await albReady(page); await page.waitForTimeout(150);
      const g3 = await geo();
      const reopened = await plan();
      ok('closing and reopening starts from the first layout, 回到原本 hidden', g3.back.hidden && reopened.join('|') === l0.join('|'));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}
{
  const w = world({ n: 30 });
  await suite('album re-layout 390px — the clamp: on the last page, a shorter variant lands on ITS last page (counter n / total follows)', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, null, true);
      // the planner is wrapped so a variant gives a shorter book (2 spreads)
      await page.evaluate(() => { const real = AutoLayout.planSpreads; AutoLayout.planSpreads = (it, o) => { const p = real(it, o); if (o.variant) p.spreads = p.spreads.slice(0, 2); return p; }; });
      await page.evaluate(() => { while (!document.getElementById('albumNext').disabled) document.getElementById('albumNext').click(); });
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => document.getElementById('albumLabel').textContent);
      await page.click('#albumRelayout'); await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ label: document.getElementById('albumLabel').textContent, next: document.getElementById('albumNext').disabled, slides: [...document.querySelectorAll('.album-slide')].map(x => x.dataset.index) }));
      const n0 = +/^\d+ \/ (\d+)$/.exec(before)?.[1];
      ok('control: the first book is longer than 2 spreads, we were on its last page', n0 > 2 && new RegExp(`^${n0} / ${n0}$`).test(before), before);
      ok('after the press the counter is 2 / 2 and next is disabled (clamped to the shorter book)', after.label === '2 / 2' && after.next, JSON.stringify(after));
      ok('only slides of the new book exist (indexes 1, 2)', after.slides.every(i => +i <= 2) && after.slides.length >= 2, JSON.stringify(after.slides));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}
{
  const w = world({ n: 30 });
  await suite('album re-layout 390px — an unmet maximum: the kind sentence is in the footer before and after a press (re-planned with the same bounds)', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, () => { AlbumPreview.PLAN_OPTS = { fit: 'contain', maxSpreads: 2 }; }, true);
      const read = () => page.evaluate(() => ({ n: document.querySelectorAll('#albumBounds').length, t: document.getElementById('albumBounds')?.textContent ?? null,
        total: document.getElementById('albumLabel').textContent, behind: document.querySelector('#completionPage .cp-hint')?.textContent ?? null }));
      const a = await read();
      ok('control: with 30 photos and a maximum of 2 spreads the sentence is there', a.n === 1 && /超過/.test(a.t || ''), JSON.stringify(a));
      await page.click('#albumRelayout'); await page.waitForTimeout(300);
      const b = await read();
      ok('after a press: still exactly one sentence (not duplicated, not lost) and it is reported to the page behind', b.n === 1 && /超過/.test(b.t || '') && /超過/.test(b.behind || ''), JSON.stringify(b));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: MOBILE });
}
{
  const w = world({ n: 30 });
  await suite('album re-layout 1500px — the button works with the mouse, the title and the controls fit', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page, null, false);
      const a = await albSnap(page);
      await page.click('#albumRelayout'); await page.waitForTimeout(250);
      const b = await albSnap(page);
      ok('a press keeps the viewer ready on the same page, with the counters', b.state === 'ready' && b.label === a.label && b.imgs > 0, JSON.stringify([a.label, b.label]));
      const r = await page.evaluate(() => { const e = document.getElementById('albumRelayout').getBoundingClientRect(); return { b: e.bottom, h: e.height, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
      ok('on screen, >= 44px, no horizontal scroll', r.b <= r.ih && r.h >= 44 && r.sw <= r.iw, JSON.stringify(r));
      const g = await titleGeo(page);
      ok('the cover title is still there after the press', !g.none && g.text === '婚禮精修' && g.ink.l >= g.page.l && g.ink.r <= g.page.r, JSON.stringify([g.none, g.text]));
      return out;
    },
    { before: w.before, initScript: SPIES, contextOptions: ALB_DESK });
}

}
