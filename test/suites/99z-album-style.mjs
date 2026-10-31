// Browser suites: the guest's album STYLE controls in the preview editor (docs/guest-shop.md, 「S3 第一步 — 換版型（同張數）、整本底色」):
// 版型 (another template with the SAME slot count for the current spread, plus 鏡像), 背景 (one colour for the whole book, nine
// ids), and the tidied toolbar (page row, action row 版型 | 背景 | 上一版 | 再次編排, 送出結帳 on its own row). The fake Worker
// (test/lib/guest-orders-fake.mjs) mirrors the Layout JSON v2 `background` contract. Suite names start with "album style".
// Synthetic SVG photos, Chromium only: a real phone is Tim's.
import { createRequire } from 'node:module';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, ALB_OWNER, ALB_VIEWER, albReady, albumWorld } from '../lib/album-world.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE } from '../lib/pick-fake.mjs';
import { ordersWorld, ORDERING, serializeLayout, BACKGROUND_IDS } from '../lib/guest-orders-fake.mjs';

export default async function register() {

const SpreadTemplates = createRequire(import.meta.url)('../../book_editor/js/spread_templates.js');
const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, run, opts) => suite(`album style — ${name}`, `${base}/index.html?t=TOK`, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);

// the nine colours, as the contract says (id -> hex), written out here on purpose: the page must agree with the doc, not with itself
const NINE = { white: '#ffffff', cream: '#fff8ee', butter: '#fff4cc', blush: '#fde8ec', peach: '#ffe5d4', mint: '#e3f4e8', sky: '#e1effb', lavender: '#eee8fa', gray: '#eeeeee' };
const LABEL = { white: '白', cream: '奶油', butter: '奶黃', blush: '粉', peach: '蜜桃', mint: '薄荷', sky: '天空', lavender: '薰衣草', gray: '灰' };
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

const catalogue = () => [{ ...SHOP_PRINT_FAKE }, { ...SHOP_ALBUM_FAKE, min_pages: 2, max_pages: 20, extra_page_price: 150 }];
const world = (o = {}) => {
  const products = catalogue();
  const ordering = o.ordering === undefined ? { ...ORDERING } : o.ordering;
  const w = albumWorld({ n: o.n ?? 12, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: products, ordering } });
  return { ...ordersWorld(w, { products, ordering }), products, album: w.ctl };
};
// opts = PLAN_OPTS merged before the viewer opens ({ fit: 'cover' } to get crops, { back: true } for a back cover)
const open = async (page, opts) => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 8000 });
  if (opts) await page.evaluate(o => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, ...o }; }, opts);
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  await page.click('#albumPreviewBtn');
  await albReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
  await page.waitForTimeout(120);
};
const layoutNow = page => page.evaluate(() => AlbumPreview.currentLayout());
const flipTo = async (page, n) => {
  for (let guard = 0; guard < 60; guard++) {
    const at = await page.evaluate(() => { const l = document.getElementById('albumLabel').textContent; return l === '封面' ? 0 : l === '封底' ? 99 : +l.split('/')[0]; });
    if (at === n) return;
    await page.click(at < n ? '#albumNext' : '#albumPrev');
    await page.waitForTimeout(60);
  }
  throw new Error(`could not reach page ${n}`);
};
const click = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.click(); }, sel);
const waitPosts = (w, n) => new Promise((res, rej) => { const t0 = Date.now(); const f = () => w.posts().length >= n ? res() : Date.now() - t0 > 6000 ? rej(new Error(`only ${w.posts().length} POSTs`)) : setTimeout(f, 30); f(); });
const step = (page, name) => page.waitForSelector(`#goSheet[data-step="${name}"]`, { timeout: 5000 });
const plain = l => JSON.stringify(l);
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;
// the spread (1-based page) whose layout has k slots, preferring k = want; returns { page, k }
const spreadWith = (l, want) => {
  const at = l.spreads.findIndex(sp => sp.slots.length === want);
  if (at >= 0) return { page: at + 1, k: want };
  const ix = l.spreads.findIndex(sp => sp.slots.length >= 3 && sp.slots.length <= 7);
  return { page: (ix >= 0 ? ix : 0) + 1, k: l.spreads[ix >= 0 ? ix : 0].slots.length };
};
// the current page's slot boxes as fractions of the page, in slot order (data-slot)
const rects = page => page.evaluate(() => {
  const pg = document.querySelector('.album-slide[data-current="true"] .album-page'), r = pg.getBoundingClientRect();
  return [...pg.querySelectorAll('.album-slot')].sort((a, b) => +a.dataset.slot - +b.dataset.slot).map(b => {
    const q = b.getBoundingClientRect();
    return { x: (q.left - r.left) / r.width, y: (q.top - r.top) / r.height, w: q.width / r.width, h: q.height / r.height };
  });
});
const tplRects = (id, mirrored) => SpreadTemplates.byId(id).slots.map(s => ({ x: mirrored ? 1 - s.x - s.w : s.x, y: s.y, w: s.w, h: s.h }));
const sameRects = (a, b) => a.length === b.length && a.every((r, i) => near(r.x, b[i].x) && near(r.y, b[i].y) && near(r.w, b[i].w) && near(r.h, b[i].h));
const tplIds = page => page.evaluate(() => [...document.querySelectorAll('#albumStyle .album-tpl')].map(b => b.dataset.templateId));
const openStyle = async page => { await page.click('[data-album-style]'); await page.waitForSelector('#albumStyle', { timeout: 3000 }); };
const pickTpl = async (page, id) => {
  await page.evaluate(i => { const b = [...document.querySelectorAll('#albumStyle .album-tpl')].find(x => x.dataset.templateId === i); if (!b) throw new Error('no template ' + i); b.click(); }, id);
  await page.waitForFunction(() => !document.getElementById('albumStyle'), null, { timeout: 3000 });
  await page.waitForTimeout(80);
};
const pickBg = async (page, id) => {
  await page.click('[data-album-bg]'); await page.waitForSelector('#albumBg', { timeout: 3000 });
  await page.evaluate(i => document.querySelector(`#albumBg [data-bg="${i}"]`).click(), id);
  await page.waitForFunction(() => !document.getElementById('albumBg'), null, { timeout: 3000 });
  await page.waitForTimeout(80);
};
const pageBgs = page => page.evaluate(() => [...document.querySelectorAll('.album-page')].map(p => getComputedStyle(p).backgroundColor));
// every page's background, flipping through the whole book (only three pages exist at a time)
const allBgs = async page => {
  const seen = [];
  await flipTo(page, 0);
  for (let g = 0; g < 60; g++) {
    seen.push(...await page.evaluate(() => [...document.querySelectorAll('.album-slide[data-current="true"] .album-page')].map(p => [p.dataset.kind, getComputedStyle(p).backgroundColor])));
    if (await page.evaluate(() => document.getElementById('albumNext').disabled)) break;
    await page.click('#albumNext'); await page.waitForTimeout(50);
  }
  return seen;
};
const cropsOf = l => l.spreads.map(sp => sp.slots.map(x => x.crop));
const withFirstMultiAlt = async page => {            // flip to a spread with alternatives; returns { l, n (1-based), k }
  const l = await layoutNow(page);
  const { page: n, k } = spreadWith(l, 4);
  await flipTo(page, n);
  return { l, n, k };
};

// ── 0. the Worker contract the fake mirrors (pure, no page)
await sx('the fake Worker\'s background contract: only { type: "color", value in the nine } or absent / null; the rest is 400 invalid_layout', async (page, ok) => {
  const lay = bg => {
    const l = { v: 2, mode: 'auto', cover: null, spreads: [{ template: 'pair-portraits', slots: [{ photo_key: 'a.jpg', fit: 'contain', crop: { x: 0, y: 0, scale: 1 } }, { photo_key: 'b.jpg', fit: 'contain', crop: { x: 0, y: 0, scale: 1 } }] }], back: null };
    if (bg !== undefined) l.background = bg;
    return l;
  };
  ok('the table has the nine ids', plain(BACKGROUND_IDS) === plain(Object.keys(NINE)), plain(BACKGROUND_IDS));
  ok('positive: absent, null and every colour id serialise (and absent leaves no key)', serializeLayout(lay()) && !('background' in serializeLayout(lay())) && !('background' in serializeLayout(lay(null)))
    && BACKGROUND_IDS.every(id => plain(serializeLayout(lay({ type: 'color', value: id })).background) === plain({ type: 'color', value: id })));
  ok('an extra field is dropped', plain(serializeLayout(lay({ type: 'color', value: 'mint', x: 1 })).background) === plain({ type: 'color', value: 'mint' }));
  ok('type image, an unknown colour, no value, a string, an array are all refused',
    [{ type: 'image', value: 'mint' }, { type: 'color', value: 'red' }, { type: 'color' }, 'mint', ['mint'], { type: 'color', value: '#fff8ee' }].every(b => serializeLayout(lay(b)) === null));
  ok('a template with the wrong slot count is refused (existing rule)', serializeLayout({ ...lay(), spreads: [{ template: 'triptych', slots: lay().spreads[0].slots }] }) === null);
}, { before: world().before, initScript: ALB_OWNER, contextOptions: ALB_DESK });

// ── 1. the chooser
{
  const w = world();
  await sx('版型: lists exactly the templates with the same slot count, current marked, wireframes with the span slot across the fold', async (page, ok) => {
    await open(page);
    ok('positive: edit mode has a 版型 button on a spread', await (async () => { await flipTo(page, 1); return page.evaluate(() => !!document.querySelector('[data-album-style]') && !document.querySelector('[data-album-style]').hidden); })());
    const { l, n, k } = await withFirstMultiAlt(page);
    await openStyle(page);
    const want = SpreadTemplates.TEMPLATES.filter(t => t.slots.length === k).map(t => t.id);
    const got = await tplIds(page);
    ok(`the chooser lists exactly the ${want.length} templates with ${k} slots, in library order`, plain(got) === plain(want), plain(got));
    ok('floor: at least 3 alternatives to the current one', got.length - 1 >= 3, String(got.length));
    ok('no template of another slot count is there', got.every(id => SpreadTemplates.byId(id).slots.length === k));
    const cur = await page.evaluate(() => [...document.querySelectorAll('#albumStyle .album-tpl[data-current="true"]')].map(b => b.dataset.templateId));
    ok('exactly one is marked current, and it is this spread\'s template (and says so for assistive tech)', plain(cur) === plain([l.spreads[n - 1].template])
      && await page.evaluate(() => document.querySelector('#albumStyle .album-tpl[data-current="true"]').getAttribute('aria-current') === 'true'), plain(cur));
    const wf = await page.evaluate(() => [...document.querySelectorAll('#albumStyle .album-tpl')].map(b => ({ id: b.dataset.templateId,
      slots: [...b.querySelectorAll('.album-tpl-slot')].map(s => ({ face: s.dataset.face, x: parseFloat(s.style.left) / 100, w: parseFloat(s.style.width) / 100 })) })));
    ok('every wireframe draws one rectangle per slot, at the template\'s x and width', wf.every(f => f.slots.length === k && f.slots.every((s, i) => near(s.x, SpreadTemplates.byId(f.id).slots[i].x, 0.002) && near(s.w, SpreadTemplates.byId(f.id).slots[i].w, 0.002))), plain(wf).slice(0, 200));
    const spans = wf.flatMap(f => f.slots.filter(s => s.face === 'span'));
    ok('a span slot is marked and crosses the middle of the wireframe (the fold); floor: a 4-slot spread has one (hero-strip)', k !== 4 || spans.length >= 1);
    ok('every marked span rectangle crosses x = 0.5', spans.every(s => s.x < 0.5 && s.x + s.w > 0.5));
    ok('the chooser scrolls (overflow-y auto / scroll) and each template is a button with an accessible name', await page.evaluate(() => /auto|scroll/.test(getComputedStyle(document.getElementById('albumStyleList')).overflowY)
      && [...document.querySelectorAll('#albumStyle .album-tpl')].every(b => b.tagName === 'BUTTON' && (b.getAttribute('aria-label') || '').length > 0)));
    await page.keyboard.press('Escape');
    ok('Esc closes the chooser only', await page.evaluate(() => !document.getElementById('albumStyle') && !!document.getElementById('albumViewer')));
    ok('nothing changed', plain(await layoutNow(page)) === plain(l));
    await flipTo(page, 0);
    ok('the cover has no 版型 button (hidden), the 背景 button is still there', await page.evaluate(() => { const b = document.querySelector('[data-album-style]'); return (!b || b.hidden || getComputedStyle(b).display === 'none') && !!document.querySelector('[data-album-bg]') && document.querySelector('[data-album-bg]').getClientRects().length > 0; }));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 2. switching a template (contain: crops stay 0) and (cover: crops are recomputed for the new shape)
for (const fit of ['contain', 'cover']) {
  const w = world();
  await sx(`版型: choosing another template (fit ${fit}) keeps photo i in slot i, moves the rectangles, ${fit === 'cover' ? 'recomputes every crop with cropFor' : 'keeps crop 0,0,1'}, never touches the count or the cover`, async (page, ok) => {
    await open(page, { fit });
    const { l: before, n, k } = await withFirstMultiAlt(page);
    const old = before.spreads[n - 1];
    const alt = SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== old.template && !t.slots.some(s => s.face === 'span')) || SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== old.template);
    ok('positive: there is an alternative', !!alt && !!old.template);
    await openStyle(page);
    await pickTpl(page, alt.id);
    const after = await layoutNow(page);
    const sp = after.spreads[n - 1];
    ok('the spread now has the new template id', sp.template === alt.id, sp.template);
    ok('photo i is still in slot i (same keys, same order)', plain(sp.slots.map(x => x.photo_key)) === plain(old.slots.map(x => x.photo_key)));
    ok('the book is the same size, the cover and every other spread are untouched', after.spreads.length === before.spreads.length && plain(after.cover) === plain(before.cover)
      && after.spreads.every((s, i) => i === n - 1 || plain(s) === plain(before.spreads[i])));
    ok('the mirror state is unchanged by a template switch (not set when it was not set)', plain(sp.mirrored ?? null) === plain(old.mirrored ?? null));
    const got = await rects(page);
    ok('the viewer redrew at once: the slot rectangles are the new template\'s (within 0.5%)', sameRects(got, tplRects(alt.id, !!sp.mirrored)), plain(got));
    ok('the old rectangles are really gone (floor: at least one moved)', !sameRects(got, tplRects(old.template, !!old.mirrored)));
    const fits = sp.slots.map(x => x.fit);
    if (fit === 'contain') {
      ok('fit contain is kept and the crops stay 0,0,1 like the planner', sp.slots.every(x => x.fit === 'contain' && x.crop.x === 0 && x.crop.y === 0 && x.crop.scale === 1), plain(sp.slots));
    } else {
      ok('fit cover is kept', fits.every(f => f === 'cover'));
      const want = await page.evaluate(([nn, id]) => {
        const v = AlbumPreview._testViewer(), t = SpreadTemplates.byId(id);
        return v.cur.spreads[nn].slots.map((x, i) => { const it = v.photo(x.photoId); const c = AutoLayout.util.cropFor(it.aspect, t.slots[i].w * 420 / (t.slots[i].h * 297), it.focus); return { x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000 }; });
      }, [n - 1, alt.id]);
      ok('each crop is cropFor(photo, the NEW slot aspect, focus) to 3 decimals', sp.slots.every((x, i) => near(x.crop.x, want[i].x, 0.0011) && near(x.crop.y, want[i].y, 0.0011)), plain([sp.slots.map(x => x.crop), want]));
      ok('floor: at least one crop actually changed with the shape', plain(cropsOf(after)[n - 1]) !== plain(cropsOf(before)[n - 1]));
    }
    ok('a template switch is an edit: 再次編排 now asks first, and names the template switch', await (async () => { await click(page, '#albumRelayout'); await page.waitForSelector('#albumConfirm', { timeout: 2000 }); const t = await page.evaluate(() => document.getElementById('albumConfirmText').textContent); await page.click('#albumConfirmNo'); return /取消你換過的照片/.test(t) && /版型/.test(t); })());
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 3. 鏡像
{
  const w = world();
  await sx('鏡像: flips the rectangles left-right for this spread only, sets mirrored only when true, comes off again, and a template chosen afterwards stays mirrored', async (page, ok) => {
    await open(page);
    const { l: before, n, k } = await withFirstMultiAlt(page);
    const t0 = before.spreads[n - 1].template, was = !!before.spreads[n - 1].mirrored;
    const r0 = await rects(page);
    await openStyle(page);
    ok('the mirror toggle is in the chooser, off for an unmirrored spread (aria-pressed)', await page.evaluate(w0 => document.querySelector('[data-album-mirror]').getAttribute('aria-pressed') === String(w0), was));
    await page.click('[data-album-mirror]'); await page.waitForTimeout(80);
    ok('the chooser stays open and its wireframes are drawn mirrored too', await page.evaluate(() => !!document.getElementById('albumStyle')) && await page.evaluate(([id, m]) => {
      const t = SpreadTemplates.byId(id), b = document.querySelector(`#albumStyle .album-tpl[data-template-id="${id}"]`);
      return [...b.querySelectorAll('.album-tpl-slot')].every((s, i) => Math.abs(parseFloat(s.style.left) / 100 - (m ? 1 - t.slots[i].x - t.slots[i].w : t.slots[i].x)) < 0.002);
    }, [t0, !was]));
    await page.keyboard.press('Escape');
    const l1 = await layoutNow(page), r1 = await rects(page);
    ok('the mirror toggle flipped the layout: set to true when it was off, gone when it was on', was ? !('mirrored' in l1.spreads[n - 1]) : l1.spreads[n - 1].mirrored === true, plain(l1.spreads[n - 1]).slice(0, 120));
    ok('every rectangle is flipped: x -> 1 - x - w, y / w / h unchanged', r1.every((r, i) => near(r.x, 1 - r0[i].x - r0[i].w) && near(r.y, r0[i].y) && near(r.w, r0[i].w) && near(r.h, r0[i].h)), plain([r0, r1]));
    ok('the other spreads are untouched', l1.spreads.every((s, i) => i === n - 1 || plain(s) === plain(before.spreads[i])));
    ok('floor: not all rectangles are symmetric (a flip really moved something)', r0.some(r => !near(r.x, 1 - r.x - r.w, 0.01)));
    await openStyle(page); await page.click('[data-album-mirror]'); await page.keyboard.press('Escape'); await page.waitForTimeout(60);
    const l2 = await layoutNow(page);
    ok('off again: back to the first geometry; mirrored is gone when false', sameRects(await rects(page), r0) && (was ? l2.spreads[n - 1].mirrored === true : !('mirrored' in l2.spreads[n - 1])));
    // mirror on, then another template: the spread stays mirrored
    await openStyle(page); await page.click('[data-album-mirror]');
    const alt = SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== t0);
    await pickTpl(page, alt.id);
    const l3 = await layoutNow(page);
    ok('a template chosen while mirrored is drawn mirrored (mirrored stays true)', l3.spreads[n - 1].template === alt.id && l3.spreads[n - 1].mirrored === !was && sameRects(await rects(page), tplRects(alt.id, !was)), plain(l3.spreads[n - 1]).slice(0, 100));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 4. the photo picker on the new geometry
{
  const w = world();
  await sx('after a template switch the picker still swaps photos per slot (已用 mark, exchange) on the new shapes', async (page, ok) => {
    await open(page);
    const { l: before, n, k } = await withFirstMultiAlt(page);
    const alt = SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== before.spreads[n - 1].template);
    await openStyle(page); await pickTpl(page, alt.id);
    const l1 = await layoutNow(page);
    await page.click('.album-slide[data-current="true"] .album-slot[data-slot="0"]');
    await page.waitForSelector('#albumPicker', { timeout: 3000 });
    const cs = await page.evaluate(() => [...document.querySelectorAll('#albumCandidates .album-cand')].map(b => ({ id: b.dataset.photoId, used: b.dataset.used === 'true', cur: b.dataset.current === 'true', badge: b.querySelector('.album-cand-badge')?.textContent ?? '' })));
    ok('positive: 12 candidates, the slot\'s own photo is 目前, the other inside photos are marked 已用', cs.length === 12 && cs.filter(c => c.cur).length === 1 && cs.find(c => c.cur).id === l1.spreads[n - 1].slots[0].photo_key && cs.filter(c => c.used).every(c => c.badge === '已用') && cs.filter(c => c.used).length >= 3);
    const other = cs.find(c => c.used && !c.cur);
    await page.evaluate(i => [...document.querySelectorAll('#albumCandidates .album-cand')].find(x => x.dataset.photoId === i).click(), other.id);
    await page.waitForFunction(() => !document.getElementById('albumPicker'), null, { timeout: 3000 });
    const l2 = await layoutNow(page);
    ok('choosing a photo already in the book exchanges the two slots (the chosen one is in slot 0 now)', l2.spreads[n - 1].slots[0].photo_key === other.id && new Set([l2.cover.photo_key, ...l2.spreads.flatMap(s => s.slots.map(x => x.photo_key))]).size >= 12 - 1);
    ok('the geometry stayed the new template\'s', sameRects(await rects(page), tplRects(alt.id, false)) && l2.spreads[n - 1].template === alt.id);
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 5. 背景
{
  const w = world();
  await sx('背景: nine swatches with Chinese names, current marked; the colour covers the cover, every spread and the back; the layout carries it only when not white', async (page, ok) => {
    await open(page, { back: true });
    const untouched = await layoutNow(page);
    ok('untouched: no `background` key at all', !('background' in untouched));
    await page.click('[data-album-bg]'); await page.waitForSelector('#albumBg', { timeout: 3000 });
    const sw = await page.evaluate(() => [...document.querySelectorAll('#albumBg [data-bg]')].map(b => ({ id: b.dataset.bg, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), bg: getComputedStyle(b.querySelector('.album-swatch') || b).backgroundColor, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    ok('exactly the nine ids, in the contract\'s order', plain(sw.map(s => s.id)) === plain(Object.keys(NINE)), plain(sw.map(s => s.id)));
    ok('their names are 白、奶油、奶黃、粉、蜜桃、薄荷、天空、薰衣草、灰', sw.every(s => s.label.startsWith(LABEL[s.id])), plain(sw.map(s => s.label)));
    ok('each swatch shows its own colour (computed)', sw.every(s => s.bg === rgb(NINE[s.id])), plain(sw.map(s => s.bg)));
    ok('white is the current one (aria-pressed) and only it; targets are at least 44px', sw.filter(s => s.pressed === 'true').map(s => s.id).join() === 'white' && sw.every(s => s.w >= 44 && s.h >= 44), plain(sw.map(s => [s.pressed, s.w, s.h])));
    ok('the table is exposed once, frozen: AlbumPreview.BACKGROUND_COLORS', await page.evaluate(() => Object.isFrozen(AlbumPreview.BACKGROUND_COLORS) && AlbumPreview.BACKGROUND_COLORS.length === 9));
    await page.evaluate(() => document.querySelector('#albumBg [data-bg="cream"]').click());
    await page.waitForFunction(() => !document.getElementById('albumBg'), null, { timeout: 3000 });
    const seen = await allBgs(page);
    ok('the cover, every spread and the back are cream (computed), floor: cover + 2 spreads + back seen', seen.length >= 4 && seen[0][0] === 'cover' && seen.at(-1)[0] === 'back' && seen.every(s => s[1] === rgb(NINE.cream)), plain(seen));
    const l = await layoutNow(page);
    ok('currentLayout() carries background { type: "color", value: "cream" } and nothing else changed', plain(l.background) === plain({ type: 'color', value: 'cream' }) && plain({ ...l, background: undefined }) === plain({ ...untouched, background: undefined }));
    await page.click('[data-album-bg]'); await page.waitForSelector('#albumBg');
    ok('reopened: cream is the marked one', await page.evaluate(() => [...document.querySelectorAll('#albumBg [aria-pressed="true"]')].map(b => b.dataset.bg).join() === 'cream'));
    await page.keyboard.press('Escape');
    await pickBg(page, 'white');
    const lw = await layoutNow(page);
    ok('white again: the key is gone and the layout is byte-identical to the untouched one', !('background' in lw) && plain(lw) === plain(untouched));
    ok('and every page is white again', (await allBgs(page)).every(s => s[1] === rgb(NINE.white)));
    ok('the fit contain letterbox shows the colour: the frame itself has no ground of its own', await (async () => {
      await pickBg(page, 'mint'); await flipTo(page, 1);
      return page.evaluate(m => { const s = document.querySelector('.album-slide[data-current="true"] .album-slot[data-fit="contain"]'); return !!s && getComputedStyle(s).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(s.closest('.album-page')).backgroundColor === m; }, rgb(NINE.mint));
    })());
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 6. re-layout, 上一版
{
  const w = world();
  await sx('再次編排 keeps the background (and asks only for swaps / template switches); 上一版 restores the template AND the background', async (page, ok) => {
    await open(page);
    await pickBg(page, 'mint');
    await click(page, '#albumRelayout'); await page.waitForTimeout(200);
    ok('a background alone is not an edit: 再次編排 runs without asking', await page.evaluate(() => !document.getElementById('albumConfirm')) && (await layoutNow(page)).background?.value === 'mint');
    ok('the new layout is drawn on mint', (await allBgs(page)).every(s => s[1] === rgb(NINE.mint)));
    ok('上一版 now has one entry', await page.evaluate(() => document.getElementById('albumUndo').dataset.count === '1'));
    const { l: base0, n, k } = await withFirstMultiAlt(page);
    const alt = SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== base0.spreads[n - 1].template);
    await openStyle(page); await pickTpl(page, alt.id);
    await pickBg(page, 'sky');
    const edited = await layoutNow(page);
    await click(page, '#albumRelayout'); await page.waitForSelector('#albumConfirm', { timeout: 2000 });
    ok('after a template switch 再次編排 asks, and the text mentions 版型', await page.evaluate(() => /版型/.test(document.getElementById('albumConfirmText').textContent)));
    await page.click('#albumConfirmYes'); await page.waitForTimeout(200);
    const l2 = await layoutNow(page);
    ok('after confirming, the new layout keeps sky', l2.background?.value === 'sky' && plain(l2.spreads) !== plain(edited.spreads));
    await pickBg(page, 'blush');
    await click(page, '#albumUndo'); await page.waitForTimeout(150);
    const l3 = await layoutNow(page);
    ok('上一版 gives back the template switch (the alt template is on that spread again)', plain(l3.spreads) === plain(edited.spreads) && l3.spreads[n - 1].template === alt.id, plain(l3.spreads[n - 1]).slice(0, 80));
    ok('and the background of that version (sky, not blush)', l3.background?.value === 'sky' && (await allBgs(page)).every(s => s[1] === rgb(NINE.sky)));
    ok('and the dirty flag came back too: 再次編排 asks again', await (async () => { await click(page, '#albumRelayout'); const asked = await page.waitForSelector('#albumConfirm', { timeout: 2000 }).then(() => true, () => false); if (asked) await page.click('#albumConfirmNo'); return asked; })());
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 7. the order: what is POSTed
{
  const w = world();
  await sx('送出: the POST body carries background, the switched template and mirrored; the Worker fake stores the same', async (page, ok) => {
    await open(page);
    const { l: base0, n, k } = await withFirstMultiAlt(page);
    const alt = SpreadTemplates.TEMPLATES.find(t => t.slots.length === k && t.id !== base0.spreads[n - 1].template);
    await openStyle(page); await page.click('[data-album-mirror]'); await pickTpl(page, alt.id);
    await pickBg(page, 'lavender');
    const edited = await layoutNow(page);
    ok('positive: the layout has the three edits', edited.spreads[n - 1].template === alt.id && edited.spreads[n - 1].mirrored === true && edited.background.value === 'lavender');
    await page.click('#albumCheckout'); await page.waitForSelector('#albumSubmit');
    ok('the review draws the whole book on lavender (cover first)', (await allBgs(page)).every(s => s[1] === rgb(NINE.lavender)));
    for (let g = 0; g < 60 && !(await page.evaluate(() => document.getElementById('albumNext').disabled)); g++) { await page.click('#albumNext'); await page.waitForTimeout(30); }
    await page.click('#albumSubmit'); await page.click('#albumConfirmYes');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-1"]'); await click(page, '#goAdd'); await step(page, 'cart');
    await click(page, '#goToContact'); await step(page, 'contact');
    await page.fill('#goName', '王小明'); await page.fill('#goPhone', '0912-345-678'); await page.check('#goConsent');
    await click(page, '#goToReview'); await step(page, 'review'); await click(page, '#goSubmit');
    await waitPosts(w, 1);
    const sent = w.posts()[0].body.lines[0].layout;
    ok('the POST layout is exactly the edited layout (template, mirrored, background)', plain(sent) === plain(edited));
    ok('the fake Worker accepted it (a receipt, not a 400) and stored the serialised layout with the background', w.orders.length === 1 && plain(w.orders[0].items[0].layout) === plain(edited) && plain(w.orders[0].items[0].layout.background) === plain({ type: 'color', value: 'lavender' }));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('送出: an untouched book sends no `background` key at all (the payload is today\'s)', async (page, ok) => {
    await open(page);
    await pickBg(page, 'peach'); await pickBg(page, 'white');
    await page.click('#albumCheckout'); await page.waitForSelector('#albumSubmit');
    for (let g = 0; g < 60 && !(await page.evaluate(() => document.getElementById('albumNext').disabled)); g++) { await page.click('#albumNext'); await page.waitForTimeout(30); }
    await page.click('#albumSubmit'); await page.click('#albumConfirmYes');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-1"]'); await click(page, '#goAdd'); await step(page, 'cart');
    await click(page, '#goToContact'); await step(page, 'contact');
    await page.fill('#goName', '王小明'); await page.fill('#goPhone', '0912-345-678'); await page.check('#goConsent');
    await click(page, '#goToReview'); await step(page, 'review'); await click(page, '#goSubmit');
    await waitPosts(w, 1);
    const raw = JSON.stringify(w.posts()[0].body);
    ok('positive: the POST has the album layout', /"layout":\{"v":2/.test(raw));
    ok('no `background` anywhere in the request', !/background/.test(raw), raw.slice(0, 80));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 8. the 390px screen
{
  const w = world();
  await sx('390px: page row, action row 版型 | 背景 | 上一版 | 再次編排, 送出結帳 alone; every control 44px+, nothing overlaps, no horizontal scroll', async (page, ok) => {
    await open(page);
    await flipTo(page, 1);
    const scan = async () => page.evaluate(() => {
      const box = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, id: e.id || e.dataset.albumStyle !== undefined && 'style' || e.dataset.albumBg !== undefined && 'bg' || e.className, dis: e.disabled }; };
      const acts = [...document.querySelectorAll('.album-actions button')].filter(b => b.getClientRects().length > 0).map(box);
      const rest = ['albumPrev', 'albumNext', 'albumCheckout'].map(i => box(document.getElementById(i)));
      const foot = document.querySelector('.album-viewer-foot');
      return { acts, rest, label: box(document.getElementById('albumLabel')), vw: window.innerWidth, docW: document.documentElement.scrollWidth, footW: [foot.scrollWidth, foot.clientWidth],
        cap: parseFloat(getComputedStyle(document.getElementById('albumRelayoutCap')).fontSize), checkoutRow: box(document.getElementById('albumCheckout')), stage: box(document.getElementById('albumStage')),
        order: [...document.querySelectorAll('.album-actions button')].map(b => b.textContent) };
    });
    const r = await scan();
    ok('floor: the action row has 4 controls and the page row + checkout 3 more (7 scanned)', r.acts.length === 4 && r.rest.length === 3 && r.acts.length + r.rest.length === 7, JSON.stringify(r.acts.map(a => a.id)));
    ok('the action row reads 版型 | 背景 | 上一版 | 再次編排 in that order', plain(r.order) === plain(['版型', '背景', '上一版', '再次編排']), plain(r.order));
    ok('every control is at least 44 x 44', [...r.acts, ...r.rest].every(b => b.w >= 44 - 0.5 && b.h >= 44 - 0.5), plain([...r.acts, ...r.rest].map(b => [b.id, Math.round(b.w), Math.round(b.h)])));
    ok('the four action buttons have equal width (within 1px) and sit on one row at 390px', r.acts.every(a => Math.abs(a.w - r.acts[0].w) <= 1 && Math.abs(a.y - r.acts[0].y) <= 1), plain(r.acts.map(a => [Math.round(a.x), Math.round(a.y), Math.round(a.w)])));
    const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
    const all = [...r.acts, ...r.rest, r.label];
    ok('no two controls overlap (page row, action row, checkout)', all.every((a, i) => all.every((b, j) => i >= j || !overlap(a, b))));
    ok('the page row is one line: ‹ label › share one y band', Math.abs(r.rest[0].y - r.rest[1].y) <= 1 && r.label.y >= r.rest[0].y - 1 && r.label.y + r.label.h <= r.rest[0].y + r.rest[0].h + 1);
    ok('送出結帳 is on its own full-width row (wider than any action button, nothing else on its band)', r.checkoutRow.w > 2 * r.acts[0].w && r.acts.every(a => a.y + a.h <= r.checkoutRow.y + 1) && r.checkoutRow.x + r.checkoutRow.w <= r.vw + 0.5);
    ok('no horizontal scroll: the document and the footer fit the 390px width', r.docW <= r.vw && r.footW[0] <= r.footW[1], plain([r.docW, r.vw, r.footW]));
    ok('the caption is quiet: 12px or smaller', r.cap <= 12, String(r.cap));
    ok('the spread keeps its room: the stage is at least 330px tall', r.stage.h >= 330, String(r.stage.h));
    ok('disabled 上一版 is dimmed but readable (opacity between .4 and .75)', await page.evaluate(() => { const o = +getComputedStyle(document.getElementById('albumUndo')).opacity; return document.getElementById('albumUndo').disabled && o >= 0.4 && o <= 0.75; }));
    // the chooser at 390
    await openStyle(page);
    const c = await page.evaluate(() => ({ tpl: [...document.querySelectorAll('#albumStyle .album-tpl')].map(b => { const q = b.getBoundingClientRect(); return { w: q.width, h: q.height }; }),
      mirror: (() => { const q = document.querySelector('[data-album-mirror]').getBoundingClientRect(); return { w: q.width, h: q.height }; })(),
      close: (() => { const q = document.getElementById('albumStyleClose').getBoundingClientRect(); return { w: q.width, h: q.height }; })(),
      docW: document.documentElement.scrollWidth, listW: [document.getElementById('albumStyleList').scrollWidth, document.getElementById('albumStyleList').clientWidth] }));
    ok('chooser: floor of 5 templates, every target 44px+ (templates, mirror, close), no sideways scroll', c.tpl.length >= 5 && [...c.tpl, c.mirror, c.close].every(b => b.w >= 44 && b.h >= 44) && c.docW <= 390 && c.listW[0] <= c.listW[1], plain(c));
    await page.keyboard.press('Escape');
    await page.click('[data-album-bg]'); await page.waitForSelector('#albumBg');
    const s = await page.evaluate(() => [...document.querySelectorAll('#albumBg [data-bg]')].map(b => { const q = b.getBoundingClientRect(); return { w: q.width, h: q.height, in: q.right <= window.innerWidth && q.left >= 0 }; }));
    ok('swatches: nine, 44px+, all inside the 390px screen', s.length === 9 && s.every(b => b.w >= 44 && b.h >= 44 && b.in), plain(s));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

// ── 9. read-only / locked: the new buttons are not there
{
  const w = world();
  await sx('a viewer (no seat key): the preview has no 版型 / 背景 button', async (page, ok) => {
    await open(page);
    const r = await page.evaluate(() => ({ style: !!document.querySelector('[data-album-style]'), bg: !!document.querySelector('[data-album-bg]'), slots: document.querySelectorAll('.album-slot').length, again: !!document.getElementById('albumRelayout'), actions: !!document.querySelector('.album-actions') }));
    ok('positive: the preview is up with photos and 再次編排', r.slots >= 2 && r.again, plain(r));
    ok('no style button, no background button', !r.style && !r.bg, plain(r));
    ok('and the pages are plain white', (await pageBgs(page)).every(c => c === rgb(NINE.white)));
  }, { before: w.before, initScript: ALB_VIEWER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('after the order is placed (lockOrder) the editor is gone: no 版型 / 背景, and the lock note shows', async (page, ok) => {
    await open(page);
    ok('positive: before the lock the buttons exist', await page.evaluate(() => !!document.querySelector('[data-album-bg]')));
    await page.evaluate(() => { AlbumPreview.lockOrder(); AlbumPreview.close(); });
    await page.waitForFunction(() => !document.getElementById('albumViewer'));
    await page.click('#albumPreviewBtn'); await albReady(page);
    const r = await page.evaluate(() => ({ style: !!document.querySelector('[data-album-style]'), bg: !!document.querySelector('[data-album-bg]'), edit: document.getElementById('albumViewer').dataset.edit, note: !!document.getElementById('albumLockedNote') }));
    ok('locked: no buttons, edit=false, the lock note is shown', !r.style && !r.bg && r.edit === 'false' && r.note, plain(r));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 10. safety: DOM only, ids from the library
{
  const w = world();
  await sx('safety: a template id that is not in the library is refused by the viewer, and the chooser builds nodes (no innerHTML of guest strings)', async (page, ok) => {
    await open(page);
    const { l: before, n, k } = await withFirstMultiAlt(page);
    const r = await page.evaluate(([nn, kk]) => {
      const v = AlbumPreview._testViewer();
      const other = SpreadTemplates.TEMPLATES.find(t => t.slots.length !== kk);
      const out = {};
      out.unknown = v.applyTemplate(nn - 1, '<img src=x onerror=alert(1)>', false);
      out.wrongCount = v.applyTemplate(nn - 1, other.id, false);
      out.proto = v.applyTemplate(nn - 1, '__proto__', false);
      out.cover = v.applyTemplate(-1, 'pair-portraits', false);
      out.badBg = (() => { try { v.setBackground('red'); return v.bg; } catch (e) { return 'threw'; } })();
      return out;
    }, [n, k]);
    ok('unknown id, other slot count, __proto__ and "no such spread" are all refused (false) and the layout is unchanged', r.unknown === false && r.wrongCount === false && r.proto === false && r.cover === false && plain(await layoutNow(page)) === plain(before), plain(r));
    ok('an unknown colour id is ignored (the book stays white, no key)', !('background' in await layoutNow(page)), plain(r.badBg));
    const src = await page.evaluate(() => fetch(document.querySelector('script[src*="album-preview"]').src).then(x => x.text()));
    ok('album-preview.js has no innerHTML / insertAdjacentHTML / document.write', !/innerHTML|insertAdjacentHTML|document\.write/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  }, { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

}
