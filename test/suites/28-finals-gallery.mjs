// Browser suites: finals gallery: hero, rows, lightbox, chips, share, escaping.
// Registered by test/run.mjs in file-name order; see test/README.md.
import zlib from 'node:zlib';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, swipeTouch } from '../lib/env.mjs';
import { DL, LUM, donePosts, listed, modalShown } from '../lib/delivery-helpers.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Finals gallery — the delivered finish page as a web album (js/finals-gallery.js,
// js/pick.js _renderFinals): hero, justified rows, lightbox, folder chips, share.
// The picking view and the 下載毛片原檔 list keep their own look (suites above).
// ═══════════════════════════════════════════════════════════════════════════

// real PNGs of a given shape (only the ratio matters; kept tiny), so the page
// measures naturalWidth / naturalHeight exactly as it would a thumbnail
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngOf(w, h, c1, c2) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2, o = y * (w * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(c1[k] + (c2[k] - c1[k]) * t);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const hue = h => { const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (0.55 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
// portrait / landscape / square / wide / 4:5 — the shapes a wedding set has
const FG_SHAPES = [[90, 60], [60, 90], [60, 60], [96, 54], [60, 75], [90, 60], [60, 90]];
const fgPngs = new Map();
function fgImage(key) {
  const m = /(\d+)\.jpg$/.exec(key);
  if (!m) return null;
  const i = +m[1], [w, h] = FG_SHAPES[i % FG_SHAPES.length], k = `${w}x${h}:${i % 12}`;
  if (!fgPngs.has(k)) fgPngs.set(k, pngOf(w, h, hue((i % 12) * 30), hue((i % 12) * 30 + 70)));
  return fgPngs.get(k);
}
const fgFiles = (n, folder = 'shoot/精修/') => Array.from({ length: n }, (_, i) => `${folder}f${String(i + 1).padStart(3, '0')}.jpg`);
const FG_PROOFS = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg'];
const fgWorld = (files, o = {}) => pickFakeWorker({
  ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
  deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: [...FG_PROOFS, ...files], title: '婚禮精修', imageFor: fgImage,
  studio: { name: '光影工作室', booking_url: null, has_logo: true }, ...o });
const FG_DESK = { viewport: { width: 1280, height: 900 } };
// listeners on document/window by type: a test can show a lightbox leaves none behind
const FG_LISTENERS = () => {
  const live = new Set(), add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  let seq = 0; const ids = new WeakMap();
  const idOf = fn => { if (!ids.has(fn)) ids.set(fn, ++seq); return ids.get(fn); };
  const tag = t => (t === document ? 'D' : t === window ? 'W' : null);
  const cap = o => !!(o === true || (o && o.capture));
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    const k = tag(this);
    if (k && typeof fn === 'function') live.add(`${k}|${type}|${cap(opt)}|${idOf(fn)}`);
    return add.call(this, type, fn, opt);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opt) {
    const k = tag(this);
    if (k && typeof fn === 'function') live.delete(`${k}|${type}|${cap(opt)}|${idOf(fn)}`);
    return rem.call(this, type, fn, opt);
  };
  window.__listeners = () => live.size;
};
// the init scripts are strings: a function passed to addInitScript cannot see this file's closures
const FG_OWNER = `localStorage.setItem('pick_key:TOK', 'ZOE-KEY');`;
const FG_OWNER_LISTEN = `localStorage.setItem('pick_key:TOK', 'ZOE-KEY'); (${FG_LISTENERS.toString()})();`;
const fgTiles = page => page.$$eval('#fgRows .fg-tile', ts => ts.map(t => t.dataset.photoId));
const fgReady = (page, n) => page.waitForFunction(n => document.querySelectorAll('#fgRows .fg-tile').length === n, n, { timeout: 8000 });
// wait until the layout stops changing (loads finished, no more reflows) and the eager images are in
const fgSettle = (page, quiet = 500) => page.evaluate(async quiet => {
  let last = -1, since = performance.now();
  const t0 = performance.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 60));
    const n = window.FinalsGallery.stats.layouts;
    const eagerDone = [...document.querySelectorAll('#fgRows img')].filter(i => i.loading !== 'lazy').every(i => i.complete);
    if (n !== last || !eagerDone) { last = n; since = performance.now(); }
    if (performance.now() - since >= quiet) return { layouts: n, ms: Math.round(performance.now() - t0 - quiet) };
    if (performance.now() - t0 > 12000) return { layouts: n, ms: -1 };
  }
}, quiet);
// the rows as they are on screen: per row the tile boxes, plus the container width
const fgGeom = page => page.evaluate(() => {
  const host = document.getElementById('fgRows');
  const W = host.clientWidth;
  const rows = [...host.querySelectorAll('.fg-row')].map(r => {
    const bs = [...r.querySelectorAll('.fg-tile')].map(t => { const b = t.getBoundingClientRect(); return { id: t.dataset.photoId, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, img: t.querySelector('img') }; });
    return { n: bs.length, tops: bs.map(b => b.t), hs: bs.map(b => b.h), span: bs.length ? bs[bs.length - 1].r - bs[0].l : 0,
      gaps: bs.slice(1).map((b, i) => b.l - bs[i].r), ids: bs.map(b => b.id),
      ratios: bs.map(b => [b.w / b.h, b.img && b.img.naturalHeight ? b.img.naturalWidth / b.img.naturalHeight : null]), top: bs.length ? bs[0].t : 0, h: bs.length ? bs[0].h : 0 };
  });
  return { W, rows, sw: document.documentElement.scrollWidth, iw: innerWidth };
});
const fgReqs = m => m.requests.filter(r => r.method === 'GET' && !r.path.startsWith('/api/') && r.path !== '/' && !r.search.includes('list='));
const fgW = r => new URLSearchParams(r.search).get('w');
const fgName = r => decodeURIComponent(r.path).split('/').pop();
const fgRowsOk = (g, tol = 1.5) => g.rows.slice(0, -1).every(r => Math.abs(r.span - g.W) <= tol && Math.max(...r.hs) - Math.min(...r.hs) <= 1);

// ── 1. desktop: hero, justified rows, order, buckets, the album entry last
{
  const files = fgFiles(40);
  const m = fgWorld(files);
  await suite('finals gallery 1280px — hero, even rows, data order, thumbnails only, 相本預覽 under the last row',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 40);
      const st = await fgSettle(page);
      ok('control: the layout settled (no endless reflow)', st.ms >= 0, JSON.stringify(st));
      const dom = await page.evaluate(() => ({
        hero: !!document.getElementById('fgHero'), title: document.getElementById('fgTitle')?.textContent,
        studio: document.querySelector('#fgStudio .fg-studio-name')?.textContent, logo: document.querySelector('#fgStudio img')?.src || null,
        cover: document.getElementById('fgCover')?.src || null, coverKey: document.getElementById('fgCover')?.dataset.photoId || null,
        oldCards: document.querySelectorAll('.photo-card').length, oldGrid: getComputedStyle(document.getElementById('photoGrid')).display,
        sidebar: getComputedStyle(document.querySelector('aside.sidebar')).display, bodyCls: document.body.classList.contains('fg-mode'),
        share: !!document.getElementById('fgShare'), chips: !!document.getElementById('fgChips'),
        heroH: document.getElementById('fgHero').getBoundingClientRect().height,
        galleries: document.querySelectorAll('#finalsGallery').length,
      }));
      ok('one gallery with a hero: the project title and the studio name + logo', dom.galleries === 1 && dom.hero && dom.title === '婚禮精修' && dom.studio === '光影工作室' && /\/api\/studio\/logo$/.test(dom.logo || ''), JSON.stringify(dom));
      ok('the cover is the first final in gallery order, as a ?w= bucket through the token', dom.coverKey === files[0] && /\?w=(1200|1600)&t=TOK$/.test(dom.cover || '') && dom.cover.includes(encodeURI(files[0])), dom.cover);
      ok('the old card grid was never built (no .photo-card) and is not shown; no sidebar', dom.oldCards === 0 && dom.oldGrid === 'none' && dom.sidebar === 'none' && dom.bodyCls, JSON.stringify(dom));
      ok('a share button; no folder chips for one folder', dom.share && !dom.chips);
      ok('the hero is tall but leaves the first row on screen', dom.heroH >= 240 && dom.heroH <= 560, dom.heroH);
      const g = await fgGeom(page);
      ok('no horizontal scroll', g.sw <= g.iw, JSON.stringify([g.sw, g.iw]));
      ok('rows exist (40 photos make several)', g.rows.length >= 6 && g.rows.every(r => r.n >= 1), g.rows.length);
      ok('tiles are in data order (the old gallery sorted by name): row after row, left to right',
        JSON.stringify(g.rows.flatMap(r => r.ids)) === JSON.stringify(files), JSON.stringify(g.rows.flatMap(r => r.ids)).slice(0, 120));
      ok('every row: all tiles on one line, one height (±1px)', g.rows.every(r => Math.max(...r.tops) - Math.min(...r.tops) <= 1 && Math.max(...r.hs) - Math.min(...r.hs) <= 1),
        JSON.stringify(g.rows.map(r => [r.hs.map(Math.round), r.tops.map(Math.round)])));
      const full = g.rows.slice(0, -1);
      ok('every row but the last fills the width: tiles + gaps = the container (±1.5px)', full.every(r => Math.abs(r.span - g.W) <= 1.5), JSON.stringify(full.map(r => [Math.round(r.span), g.W])));
      ok('gaps are about 6px', g.rows.every(r => r.gaps.every(x => Math.abs(x - 6) <= 1)), JSON.stringify(g.rows.map(r => r.gaps.map(Math.round))));
      ok('row heights stay near the 320px target (200..420)', full.every(r => r.h >= 200 && r.h <= 420), JSON.stringify(full.map(r => Math.round(r.h))));
      const last = g.rows[g.rows.length - 1];
      ok('the last row is not stretched: it is at most the target height and stops short of the width', last.h <= 321 && last.span < g.W - 1, JSON.stringify([last.h, last.span, g.W]));
      const known = g.rows.flatMap(r => r.ratios).filter(([, b]) => b), unknown = g.rows.flatMap(r => r.ratios).filter(([, b]) => !b);
      ok('every loaded tile has its photo\'s own shape (tile w/h = natural w/h, ±0.5%: gaps are taken out of the width before the height is chosen); the first 36 are loaded', known.length >= 36 && known.every(([a, b]) => Math.abs(a / b - 1) < 0.005), JSON.stringify([known.length, known.filter(([a, b]) => Math.abs(a / b - 1) >= 0.005).slice(0, 4)]));
      ok('a not-yet-loaded (lazy) tile holds the 3:2 placeholder shape', unknown.every(([a]) => Math.abs(a / 1.5 - 1) < 0.005), JSON.stringify(unknown));
      ok('control: portraits and landscapes are both there', g.rows.some(r => r.ratios.some(([a]) => a < 0.9)) && g.rows.some(r => r.ratios.some(([a]) => a > 1.4)));
      // requests: thumbnails only
      const reqs = fgReqs(m).filter(r => decodeURIComponent(r.path).includes('精修'));
      ok('control: the page asked for the finals (cover + tiles)', new Set(reqs.map(r => r.path)).size >= 38, reqs.length);
      ok('every photo read is a ?w= bucket (400 / 1200 / 1600) — no original, no download=1',
        reqs.every(r => ['400', '1200', '1600'].includes(fgW(r)) && !r.search.includes('download')), JSON.stringify(reqs.filter(r => !['400', '1200', '1600'].includes(fgW(r))).slice(0, 3)));
      ok('1280px / DPR1: tiles ask the 400 bucket, only the cover a big one', reqs.filter(r => fgW(r) !== '400').every(r => fgName(r) === 'f001.jpg') && reqs.some(r => fgW(r) === '400'), JSON.stringify(reqs.filter(r => fgW(r) !== '400').map(r => r.path + r.search)));
      ok('nothing of the proofs was read', !m.requests.some(r => decodeURIComponent(r.path).includes('毛片') || decodeURIComponent(r.search).includes('毛片')));
      // the album entry: inside the gallery, after the rows, below the last tile
      const e = await page.evaluate(() => {
        const entry = document.getElementById('albumPreviewEntry'), rows = document.getElementById('fgRows');
        const lastTile = [...rows.querySelectorAll('.fg-tile')].pop().getBoundingClientRect();
        return { inside: !!entry && !!entry.closest('#finalsGallery'), prev: entry?.previousElementSibling?.id, top: entry?.getBoundingClientRect().top, lastB: lastTile.bottom, n: document.querySelectorAll('#albumPreviewEntry').length };
      });
      ok('the 相本預覽 entry is the last thing: right after #fgRows, below the last photo, once', e.inside && e.prev === 'fgRows' && e.top >= e.lastB - 0.5 && e.n === 1, JSON.stringify(e));
      if (process.env.SHOTS) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.SHOTS}/desktop-top.png` });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.SHOTS}/desktop-bottom.png` });
      }
      await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView());
      await page.click('#albumPreviewBtn');
      await page.waitForSelector('#albumViewer', { timeout: 5000 });
      ok('pressing it still opens the album viewer', true);
      await page.click('#albumClose');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      ok('✕ closes it and the focus is back on the entry button', await page.evaluate(() => document.activeElement?.id === 'albumPreviewBtn'));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}

// ── 2. phone
{
  const files = fgFiles(40);
  const m = fgWorld(files, { title: '一個很長很長的專案名稱用來測試手機上會不會把版面撐出螢幕之外的情況' });
  await suite('finals gallery 390px — hero, ~200px rows, the 確認完成 strip is thin and above the hero, no sideways scroll',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 40);
      const st = await fgSettle(page);
      ok('control: settled', st.ms >= 0, JSON.stringify(st));
      const g = await fgGeom(page);
      ok('no horizontal scroll', g.sw <= g.iw, JSON.stringify([g.sw, g.iw]));
      const full = g.rows.slice(0, -1);
      ok('rows exist and fill the width (±1.5px), one height each (±1px)', g.rows.length >= 8 && fgRowsOk(g), JSON.stringify(full.map(r => [Math.round(r.span), g.W])));
      ok('row heights near the 200px phone target (130..280)', full.every(r => r.h >= 130 && r.h <= 280), JSON.stringify(full.map(r => Math.round(r.h))));
      ok('gaps about 6px', g.rows.every(r => r.gaps.every(x => Math.abs(x - 6) <= 1)));
      ok('data order', JSON.stringify(g.rows.flatMap(r => r.ids)) === JSON.stringify(files));
      const p = await page.evaluate(() => {
        const R = id => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top + scrollY, b: r.bottom + scrollY, h: r.height, l: r.left, r: r.right }; };
        const cs = id => getComputedStyle(document.getElementById(id));
        return { done: R('deliveryDone'), hero: R('fgHero'), bar: R('deliveryBar'), doneBtns: [...document.querySelectorAll('#deliveryDone button')].map(b => { const r = b.getBoundingClientRect(); return [b.id, Math.round(r.height), r.right <= innerWidth]; }),
          pos: [cs('deliveryDone').position, cs('fgHero').position], title: R('fgTitle'), vh: innerHeight,
          cover: document.getElementById('fgCover')?.src, share: R('fgShare'), order: document.getElementById('deliveryDone').compareDocumentPosition(document.getElementById('fgHero')) & Node.DOCUMENT_POSITION_FOLLOWING };
      });
      ok('the confirmation strip is above the hero, not over it, not fixed', !!p.done && p.done.b <= p.hero.t + 1 && p.pos[0] !== 'fixed' && p.pos[0] !== 'sticky' && !!p.order, JSON.stringify(p));
      ok('the strip is thin on a phone (<= 96px)', p.done.h <= 96, p.done.h);
      ok('its buttons are still there, tappable (>= 40px) and inside the phone', p.doneBtns.length === 2 && p.doneBtns.every(([, h, inside]) => h >= 40 && inside), JSON.stringify(p.doneBtns));
      ok('no delivery bar taking room when the proofs switch is off', p.bar.h === 0, JSON.stringify(p.bar));
      ok('the hero fits the phone: shorter than 62% of the screen, and the long title stays inside', p.hero.h <= p.vh * 0.62 && p.title.r <= 390 + 0.5 && p.title.l >= 0, JSON.stringify([p.hero, p.title]));
      ok('the share button is inside the screen and tappable', p.share && p.share.l >= 0 && p.share.r <= 390 + 0.5 && p.share.h >= 40, JSON.stringify(p.share));
      ok('390px / DPR3: the cover is a 1200 bucket', /\?w=1200&t=TOK$/.test(p.cover || ''), p.cover);
      const reqs = fgReqs(m).filter(r => decodeURIComponent(r.path).includes('精修'));
      ok('tiles on a DPR3 phone ask the 1200 bucket (still never an original)', reqs.length >= 10 && reqs.every(r => fgW(r) === '1200' && !r.search.includes('download')), JSON.stringify(reqs.slice(0, 2)));
      const e = await page.evaluate(() => ({ prev: document.getElementById('albumPreviewEntry')?.previousElementSibling?.id, h: document.getElementById('albumPreviewBtn')?.getBoundingClientRect().height }));
      ok('the album entry is last and tappable', e.prev === 'fgRows' && e.h >= 44, JSON.stringify(e));
      if (process.env.SHOTS) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.SHOTS}/phone-top.png` });
        await page.evaluate(() => window.scrollTo(0, 700));
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.SHOTS}/phone-rows.png` });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.SHOTS}/phone-bottom.png` });
      }
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: MOBILE });
}

// ── 3. only delivered shows it: picking, an undelivered project and the proofs list have none of it
for (const [name, opts] of [
  ['picking', { phase: 'picking', deliveredAt: null, finalFolders: null }],
  ['undelivered with the finals kept', { phase: 'retouching', deliveredAt: null, finalFolders: ['shoot/精修/'] }],
  ['a legacy stamp without finals', { phase: 'retouching', deliveredAt: '2026-09-01T00:00:00.000Z', finalFolders: null }],
]) {
  const m = fgWorld(fgFiles(6), { folders: ['shoot/精修/', 'shoot/毛片/'], ...opts });
  await suite(`finals gallery — ${name}: no hero, no rows, no share, no lightbox in the DOM; the old grid is there`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // attached, not visible: a gallery that wrongly hid the cards must fail the assertions below, not time out here
      await page.waitForSelector('.photo-card', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(300);
      ok('control: the ordinary cards loaded', (await page.$$('.photo-card')).length > 0);
      const s = await page.evaluate(() => ({ g: !!document.getElementById('finalsGallery'), hero: !!document.getElementById('fgHero'), rows: !!document.getElementById('fgRows'),
        tile: !!document.querySelector('.fg-tile'), share: !!document.getElementById('fgShare'), lb: !!document.getElementById('fgLightbox'), cls: document.body.classList.contains('fg-mode'),
        grid: getComputedStyle(document.getElementById('photoGrid')).display, side: getComputedStyle(document.querySelector('aside.sidebar')).display, root: document.documentElement.classList.contains('fg-open') }));
      ok('nothing of the gallery exists', !s.g && !s.hero && !s.rows && !s.tile && !s.share && !s.lb && !s.cls && !s.root, JSON.stringify(s));
      ok('the grid and the sidebar show as before', s.grid !== 'none' && s.side !== 'none', JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}
{
  const m = fgWorld(fgFiles(6), { allowProofDownload: true });
  await suite('finals gallery — the 下載毛片原檔 list is the old card list; back on the finals the gallery is built once, not twice',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      ok('control: the finals gallery is up first', !!(await page.$('#fgHero')) && (await page.$$('.photo-card')).length === 0);
      const bar = await page.evaluate(() => { const b = document.getElementById('deliveryBar'); return { shown: b.getBoundingClientRect().height > 20, hidden: b.hidden, btn: document.getElementById('deliveryProofsBtn').textContent }; });
      ok('the thin bar with 下載毛片原檔 is visible when the switch is on', bar.shown && !bar.hidden && bar.btn === '下載毛片原檔', JSON.stringify(bar));
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
      const s = await page.evaluate(() => ({ g: !!document.getElementById('finalsGallery'), hero: !!document.getElementById('fgHero'), tile: !!document.querySelector('.fg-tile'), share: !!document.getElementById('fgShare'),
        entry: !!document.getElementById('albumPreviewEntry'), cls: document.body.classList.contains('fg-mode'), grid: getComputedStyle(document.getElementById('photoGrid')).display,
        side: getComputedStyle(document.querySelector('aside.sidebar')).display, dl: document.querySelectorAll('.photo-card [data-download]').length, done: !!document.getElementById('deliveryDone') }));
      ok('proofs view: no gallery, no hero, no album entry — the old cards with 下載原檔, sidebar back, confirmation block kept', !s.g && !s.hero && !s.tile && !s.share && !s.entry && !s.cls && s.grid !== 'none' && s.side !== 'none' && s.dl === 2 && s.done, JSON.stringify(s));
      await page.click('#deliveryProofsBtn');
      await fgReady(page, 6);
      const t = await page.evaluate(() => ({ g: document.querySelectorAll('#finalsGallery').length, hero: document.querySelectorAll('#fgHero').length, share: document.querySelectorAll('#fgShare').length,
        entry: document.querySelectorAll('#albumPreviewEntry').length, cards: document.querySelectorAll('.photo-card').length, tiles: document.querySelectorAll('.fg-tile').length }));
      ok('back on the finals: one gallery, one hero, one share, one entry, 6 tiles, no cards', t.g === 1 && t.hero === 1 && t.share === 1 && t.entry === 1 && t.tiles === 6 && t.cards === 0, JSON.stringify(t));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}

// ── 4. order is the gallery's, never a re-sort; an empty folder says so
{
  const keys = ['shoot/精修/f3.jpg', 'shoot/精修/f20.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/f10.jpg', 'shoot/精修/f1.jpg'];
  const m = fgWorld(keys);
  await suite('finals gallery — tile order is the existing gallery order (name sort), not a natural-number re-sort',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 5);
      const ids = await fgTiles(page);
      ok('f1, f10, f2, f20, f3 — what app.js sorts to (control: natural order would be f1 f2 f3 f10 f20)', JSON.stringify(ids.map(k => k.split('/').pop())) === '["f1.jpg","f10.jpg","f2.jpg","f20.jpg","f3.jpg"]', JSON.stringify(ids));
      ok('the cover is the first of them', (await page.$eval('#fgCover', i => i.dataset.photoId)) === 'shoot/精修/f1.jpg');
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}
{
  const m = fgWorld([]);
  await suite('finals gallery — an empty finals folder: the hero stays, no cover, a plain sentence, no errors',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#fgEmpty', { timeout: 5000 });
      const s = await page.evaluate(() => ({ text: document.getElementById('fgEmpty').textContent, cover: !!document.getElementById('fgCover'), tiles: document.querySelectorAll('.fg-tile').length,
        title: document.getElementById('fgTitle')?.textContent }));
      ok('says the folder has no photos yet', s.text === '這裡還沒有照片', JSON.stringify(s));
      ok('no cover image, no tiles, the title is still there', !s.cover && s.tiles === 0 && s.title === '婚禮精修', JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}

// ── 5. the hero does not jump while its photo loads, and starts dark
{
  const m = fgWorld(fgFiles(8), { imageDelay: key => (key.endsWith('f001.jpg') ? 900 : 0) });
  await suite('finals gallery — the hero is a dark box of its final height before the cover arrives: no jump',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#fgCover', { state: 'attached', timeout: 5000 });
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      const before = await page.evaluate(`(() => { const L = ${LUM}; const h = document.getElementById('fgHero'); const r = h.getBoundingClientRect(); const media = h.querySelector('.fg-hero-media');
        const img = document.getElementById('fgCover'); return { h: r.height, top: r.top, bg: L(getComputedStyle(media).backgroundColor), loaded: !!img && img.complete && img.naturalWidth > 0, tileTop: document.querySelector('.fg-tile')?.getBoundingClientRect().top }; })()`);
      ok('control: the cover has not arrived yet (the Worker holds it)', !before.loaded, JSON.stringify(before));
      ok('the placeholder is dark (not a white flash)', before.bg < 0.25, before.bg);
      await page.waitForFunction(() => { const i = document.getElementById('fgCover'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 6000 });
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({ h: document.getElementById('fgHero').getBoundingClientRect().height, tileTop: document.querySelector('.fg-tile')?.getBoundingClientRect().top }));
      ok('the hero kept its height, and the first row did not move (±1px)', Math.abs(after.h - before.h) <= 1 && Math.abs(after.tileTop - before.tileTop) <= 1, JSON.stringify([before, after]));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}

// ── 6. 300 photos: no stall, a bounded number of reflows, resize reflows once, lazy below the fold
{
  const files = fgFiles(300);
  const m = fgWorld(files);
  await suite('finals gallery — 300 photos: settles, few reflows (batched), only the first screens are loaded, resizing reflows without a loop',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const t0 = Date.now();
      await fgReady(page, 300);
      const st = await fgSettle(page);
      ok(`control: settled, within a few seconds (settled ${st.ms}ms after the last reflow; ${Date.now() - t0}ms from navigation)`, st.ms >= 0 && Date.now() - t0 < 9000, JSON.stringify({ st, ms: Date.now() - t0 }));
      ok(`the layouts of the first load are bounded (<= 8), not one per image: ${st.layouts} for 300 photos`, st.layouts <= 8, st.layouts);
      const eager = await page.$$eval('#fgRows img', is => ({ eager: is.filter(i => i.loading !== 'lazy').length, lazy: is.filter(i => i.loading === 'lazy').length }));
      ok('the first screens load eagerly (20..60), the rest lazily', eager.eager >= 20 && eager.eager <= 60 && eager.lazy >= 240, JSON.stringify(eager));
      const asked1 = new Set(fgReqs(m).filter(r => /^f\d+\.jpg$/.test(fgName(r))).map(r => r.path)).size;
      ok('control + lazy: thumbnails were asked for, but far from all 300 before any scroll (20..200)', asked1 >= 20 && asked1 <= 200, asked1);
      const g = await fgGeom(page);
      ok('no horizontal scroll; rows even and filling the width', g.sw <= g.iw && fgRowsOk(g));
      ok('all 300 are placed, in order', JSON.stringify(g.rows.flatMap(r => r.ids)) === JSON.stringify(files));
      const q1 = await page.evaluate(() => window.FinalsGallery.stats.layouts);
      await page.waitForTimeout(700);
      ok('no reflow with nothing happening (no loop)', (await page.evaluate(() => window.FinalsGallery.stats.layouts)) === q1);
      await page.setViewportSize({ width: 820, height: 900 });
      await page.waitForFunction(w => document.getElementById('fgRows').clientWidth < w, 1200, { timeout: 3000 });
      const st2 = await fgSettle(page);
      const g2 = await fgGeom(page);
      ok('resize: rows are rebuilt for the new width (every row but the last fills it)', g2.W < g.W && fgRowsOk(g2), JSON.stringify([g.W, g2.W]));
      ok(`...with a handful of reflows, not a storm (<= 4 more; was ${st2.layouts - q1}), and no horizontal scroll`, st2.layouts - q1 >= 1 && st2.layouts - q1 <= 4 && g2.sw <= g2.iw, JSON.stringify([q1, st2.layouts]));
      for (let y = 0; y < 14; y++) { await page.evaluate(() => window.scrollBy(0, 1400)); await page.waitForTimeout(120); }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const st3 = await fgSettle(page, 700);
      ok(`after scrolling through all 300: settled, still few reflows in all (<= 45; total ${st3.layouts}), none looping`, st3.ms >= 0 && st3.layouts <= 45, JSON.stringify(st3));
      const g3 = await fgGeom(page);
      ok('...and the rows are right: even, in order, inside the width', g3.sw <= g3.iw && fgRowsOk(g3) && JSON.stringify(g3.rows.flatMap(r => r.ids)) === JSON.stringify(files));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}

// ── 7. lightbox, desktop: open, keys, counter, buckets, preload, download, lock, focus, no listener left behind
{
  const files = fgFiles(12);
  const m = fgWorld(files);
  await suite('finals gallery lightbox 1280px — keys, n / total, big bucket, preload ±1, 下載 original on press only, scroll lock, focus back, no listener left',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 12);
      await fgSettle(page);
      const lb = () => page.evaluate(() => {
        const el = document.getElementById('fgLightbox');
        if (!el) return null;
        const img = document.getElementById('fgLbImg');
        return { count: document.getElementById('fgLbCount')?.textContent, name: document.getElementById('fgLbName')?.textContent, src: img?.src || '', role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'),
          dl: document.getElementById('fgLbDownload')?.href || null, prevDis: document.getElementById('fgLbPrev')?.disabled, nextDis: document.getElementById('fgLbNext')?.disabled,
          lock: document.documentElement.classList.contains('fg-open'), overflow: getComputedStyle(document.documentElement).overflow };
      });
      const waitCount = c => page.waitForFunction(c => document.getElementById('fgLbCount')?.textContent === c, c, { timeout: 3000 });
      const base0 = await page.evaluate(() => window.__listeners());
      ok('control: nothing of it exists before a press', (await lb()) === null && !(await page.evaluate(() => document.documentElement.classList.contains('fg-open'))));
      const before = fgReqs(m).length;
      await page.click(`.fg-tile[data-photo-id="${files[2]}"]`);
      await page.waitForSelector('#fgLightbox', { timeout: 3000 });
      let s = await lb();
      ok('a dialog, modal; shows 3 / 12 and the file name', s.role === 'dialog' && s.modal === 'true' && s.count === '3 / 12' && s.name === 'f003.jpg', JSON.stringify(s));
      ok('the photo is a big bucket (1200/1600): 1280px DPR1 asks 1600, through the token', /\?w=1600&t=TOK$/.test(s.src) && s.src.includes(encodeURI(files[2])), s.src);
      ok('the page behind is locked (html.fg-open, overflow hidden)', s.lock && s.overflow === 'hidden', JSON.stringify([s.lock, s.overflow]));
      ok('下載 points at this photo\'s ?download=1&t= original', decodeURI(s.dl) === DL(files[2]), s.dl);
      ok('both arrows are on (middle photo)', s.prevDis === false && s.nextDis === false);
      ok('listeners were added for the lightbox', (await page.evaluate(() => window.__listeners())) > base0);
      await page.waitForTimeout(400);
      const around = fgReqs(m).slice(before).filter(r => fgW(r) === '1600').map(fgName);
      ok('it preloaded the photo before and after (f002, f004) as well as itself', ['f002.jpg', 'f003.jpg', 'f004.jpg'].every(n => around.includes(n)) && around.length <= 4, JSON.stringify(around));
      ok('no original was read and nothing was downloaded just by opening', !fgReqs(m).some(r => r.search.includes('download=1') || !fgW(r)), JSON.stringify(fgReqs(m).filter(r => r.search.includes('download=1') || !fgW(r)).slice(0, 2)));
      await page.keyboard.press('ArrowRight');
      await waitCount('4 / 12');
      s = await lb();
      ok('→ goes to 4 / 12: the image and the download link follow', s.src.includes(encodeURI(files[3])) && decodeURI(s.dl) === DL(files[3]) && s.name === 'f004.jpg', JSON.stringify(s));
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
      await waitCount('2 / 12');
      await page.click('#fgLbNext');
      await waitCount('3 / 12');
      await page.click('#fgLbPrev');
      await waitCount('2 / 12');
      ok('← ← then the › and ‹ buttons move by one each', true);
      await page.keyboard.press('ArrowLeft');
      await waitCount('1 / 12');
      s = await lb();
      ok('first photo: ‹ is disabled and ← stays put', s.prevDis === true && s.nextDis === false);
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(150);
      ok('...(1 / 12 still)', (await lb()).count === '1 / 12');
      for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowRight');
      await waitCount('12 / 12');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
      s = await lb();
      ok('last photo: › is disabled and → stays put', s.count === '12 / 12' && s.nextDis === true && s.prevDis === false);
      const reqsBeforeDl = m.requests.filter(r => r.search.includes('download=1')).length;
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#fgLbDownload')]);
      ok('control: no download request until the press', reqsBeforeDl === 0);
      ok('pressing 下載 saves this photo\'s original (f012.jpg), via the one-byte probe first',
        dl.suggestedFilename() === 'f012.jpg' && m.requests.some(r => r.search.includes('download=1') && r.range === 'bytes=0-0'), dl.suggestedFilename());
      if (process.env.SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${process.env.SHOTS}/desktop-lightbox.png` }); }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('fgLightbox'), null, { timeout: 3000 });
      const after = await page.evaluate(() => ({ lock: document.documentElement.classList.contains('fg-open'), overflow: getComputedStyle(document.documentElement).overflow, active: document.activeElement?.dataset?.photoId || document.activeElement?.tagName, lb: !!document.getElementById('fgLightbox'), listeners: window.__listeners() }));
      ok('Esc closes: element gone, lock released, focus on the photo it ended on (f012)', !after.lb && !after.lock && after.overflow !== 'hidden' && after.active === files[11], JSON.stringify(after));
      ok('listeners are back to what they were', after.listeners === base0, JSON.stringify([base0, after.listeners]));
      for (let i = 0; i < 6; i++) {
        await page.click(`.fg-tile[data-photo-id="${files[i]}"]`);
        await page.waitForSelector('#fgLightbox');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('fgLightbox'));
      }
      const n6 = await page.evaluate(() => ({ listeners: window.__listeners(), lb: document.querySelectorAll('#fgLightbox').length, lock: document.documentElement.classList.contains('fg-open') }));
      ok('six open/close rounds later: still the same listeners, no lightbox, no lock', n6.listeners === base0 && n6.lb === 0 && !n6.lock, JSON.stringify([base0, n6]));
      await page.click(`.fg-tile[data-photo-id="${files[4]}"]`);
      await page.waitForSelector('#fgLightbox');
      await page.click('#fgLbClose');
      await page.waitForFunction(() => !document.getElementById('fgLightbox'));
      ok('✕ closes too, and gives the focus back to the photo that was opened', await page.evaluate(id => document.activeElement?.dataset?.photoId === id, files[4]));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER_LISTEN, contextOptions: FG_DESK });
}

// ── 8. lightbox, phone: swipe (and the edge guard), tap targets, no sideways scroll
{
  const files = fgFiles(12);
  const m = fgWorld(files);
  await suite('finals gallery lightbox 390px — swipe flips, edge / vertical / short swipes do not, tap targets, no sideways scroll, 1200 bucket',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 12);
      await fgSettle(page);
      const count = () => page.evaluate(() => document.getElementById('fgLbCount')?.textContent);
      await page.click(`.fg-tile[data-photo-id="${files[2]}"]`);
      await page.waitForSelector('#fgLightbox');
      ok('opens at 3 / 12 with the 1200 bucket (390px x DPR3)', (await count()) === '3 / 12' && /\?w=1200&t=TOK$/.test(await page.$eval('#fgLbImg', i => i.src)));
      const geo = await page.evaluate(() => {
        const R = id => { const b = document.getElementById(id).getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right }; };
        return { dl: R('fgLbDownload'), close: R('fgLbClose'), prev: R('fgLbPrev'), next: R('fgLbNext'), sw: document.documentElement.scrollWidth, iw: innerWidth, fixed: getComputedStyle(document.getElementById('fgLightbox')).position,
          stage: R('fgLbStage'), img: R('fgLbImg') };
      });
      ok('download and close are >= 44px and inside the screen', [geo.dl, geo.close].every(b => b.h >= 44 && b.w >= 44 && b.l >= 0 && b.r <= geo.iw + 0.5), JSON.stringify([geo.dl, geo.close]));
      ok('the arrows are >= 44px and inside the screen', [geo.prev, geo.next].every(b => b.h >= 44 && b.w >= 44 && b.l >= 0 && b.r <= geo.iw + 0.5), JSON.stringify([geo.prev, geo.next]));
      ok('full-screen (fixed), no sideways scroll, the photo fits the stage', geo.fixed === 'fixed' && geo.sw <= geo.iw && geo.img.r <= geo.iw + 0.5 && geo.img.w > 100, JSON.stringify(geo));
      await swipeTouch(page, '#fgLbStage', 300, 400, 60, 410);
      await page.waitForFunction(() => document.getElementById('fgLbCount').textContent === '4 / 12', null, { timeout: 3000 });
      ok('swipe left (not from an edge) goes to the next: 4 / 12', true);
      await swipeTouch(page, '#fgLbStage', 80, 400, 330, 410);
      await page.waitForFunction(() => document.getElementById('fgLbCount').textContent === '3 / 12', null, { timeout: 3000 });
      ok('swipe right goes back: 3 / 12', true);
      await swipeTouch(page, '#fgLbStage', 10, 400, 260, 410);
      await page.waitForTimeout(300);
      ok('a swipe that starts within 24px of the left screen edge (the back gesture) is ignored', (await count()) === '3 / 12', await count());
      await swipeTouch(page, '#fgLbStage', 382, 400, 130, 410);
      await page.waitForTimeout(300);
      ok('...and so is one that starts at the right edge', (await count()) === '3 / 12', await count());
      await swipeTouch(page, '#fgLbStage', 200, 200, 200, 520);
      await page.waitForTimeout(300);
      ok('a vertical swipe does nothing', (await count()) === '3 / 12', await count());
      await swipeTouch(page, '#fgLbStage', 220, 400, 195, 402);
      await page.waitForTimeout(300);
      ok('a short swipe (25px) does nothing', (await count()) === '3 / 12', await count());
      await swipeTouch(page, '#fgLbStage', 25, 400, 300, 410);
      await page.waitForFunction(() => document.getElementById('fgLbCount').textContent === '2 / 12', null, { timeout: 3000 });
      ok('control: a swipe starting at 25px (just inside the guard) works', true);
      const dl = await page.$eval('#fgLbDownload', a => decodeURI(a.href));
      ok('the download link follows the swipes', dl === DL(files[1]), dl);
      if (process.env.SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${process.env.SHOTS}/phone-lightbox.png` }); }
      await page.click('#fgLbClose');
      await page.waitForFunction(() => !document.getElementById('fgLightbox'));
      ok('closed: scrolling is free again and the focus is on the tile it ended on', await page.evaluate(id => !document.documentElement.classList.contains('fg-open') && document.activeElement?.dataset?.photoId === id, files[1]));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: MOBILE });
}

// ── 9. folder chips
{
  const files = [...fgFiles(6, 'shoot/精修/'), ...fgFiles(4, 'shoot/精修二/')];
  const m = fgWorld(files, { finalFolders: ['shoot/精修/', 'shoot/精修二/'] });
  await suite('finals gallery 1280px — several finals folders: chips under the hero switch them; the cover stays',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      const chips = () => page.$$eval('#fgChips .fg-chip', cs => cs.map(c => [c.textContent, c.getAttribute('aria-pressed'), c.dataset.folder]));
      ok('two chips, 精修 pressed', JSON.stringify(await chips()) === '[["精修","true","shoot/精修/"],["精修二","false","shoot/精修二/"]]', JSON.stringify(await chips()));
      const pos = await page.evaluate(() => ({ hero: document.getElementById('fgHero').getBoundingClientRect().bottom, chips: document.getElementById('fgChips').getBoundingClientRect(), rows: document.getElementById('fgRows').getBoundingClientRect().top }));
      ok('the chips sit between the hero and the rows', pos.chips.top >= pos.hero - 0.5 && pos.rows >= pos.chips.bottom - 0.5 && pos.chips.height >= 40, JSON.stringify(pos));
      const cover = await page.$eval('#fgCover', i => i.src);
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修二/"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.fg-tile')].every(t => t.dataset.photoId.includes('精修二')) && document.querySelectorAll('.fg-tile').length === 4, null, { timeout: 5000 });
      ok('the second chip shows its own 4 photos', JSON.stringify((await fgTiles(page)).map(k => k.split('/').pop())) === '["f001.jpg","f002.jpg","f003.jpg","f004.jpg"]');
      ok('...it is the pressed one now, and the first is not', JSON.stringify((await chips()).map(c => c[1])) === '["false","true"]');
      ok('the cover did not change (it is the first photo of the first folder)', (await page.$eval('#fgCover', i => i.src)) === cover && (await page.$eval('#fgCover', i => i.dataset.photoId)) === 'shoot/精修/f001.jpg');
      ok('the folder was listed through the token like any other read', listed(m).includes('shoot/精修二/'));
      const g = await fgGeom(page);
      ok('rows are right for the second folder, and the entry still follows them', fgRowsOk(g) && (await page.$eval('#albumPreviewEntry', e => e.previousElementSibling.id)) === 'fgRows');
      if (process.env.SHOTS) { await page.waitForTimeout(800); await page.screenshot({ path: `${process.env.SHOTS}/desktop-chips.png` }); }
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/"]');
      await fgReady(page, 6);
      ok('the first chip brings the 6 back', (await chips())[0][1] === 'true');
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}
{
  const files = [...fgFiles(5, 'shoot/精修/'), 'shoot/精修/sub/f101.jpg', 'shoot/精修/sub/f102.jpg'];
  const m = fgWorld(files);
  await suite('finals gallery 390px — one finals folder with a subfolder: chips for the subfolder and the way back; chips scroll inside, not the page',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 5);
      const chips = () => page.$$eval('#fgChips .fg-chip', cs => cs.map(c => [c.textContent, c.getAttribute('aria-pressed'), c.dataset.folder]));
      ok('the root chip (pressed) and a chip for the subfolder', JSON.stringify(await chips()) === '[["精修","true","shoot/精修/"],["sub","false","shoot/精修/sub/"]]', JSON.stringify(await chips()));
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/sub/"]');
      await page.waitForFunction(() => document.querySelectorAll('.fg-tile').length === 2, null, { timeout: 5000 });
      ok('the subfolder chip opens its 2 photos', JSON.stringify((await fgTiles(page)).map(k => k.split('/').pop())) === '["f101.jpg","f102.jpg"]');
      const c2 = await chips();
      ok('a way back is offered (‹ 上一層) and the root chip stays the pressed one', c2.some(c => c[0] === '‹ 上一層' && c[2] === 'shoot/精修/') && c2.find(c => c[2] === 'shoot/精修/')?.[1] === 'true', JSON.stringify(c2));
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/"]');
      await fgReady(page, 5);
      ok('going back shows the 5 again', true);
      const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, hs: [...document.querySelectorAll('#fgChips .fg-chip')].map(c => Math.round(c.getBoundingClientRect().height)) }));
      ok('no sideways scroll; chips are >= 40px tall', g.sw <= g.iw && g.hs.every(h => h >= 40), JSON.stringify(g));
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: MOBILE });
}

// ── 10. the 確認完成 block: same ids and behaviour, now a thin strip at the top
for (const [label, co, init] of [['owner 1280px', FG_DESK, FG_OWNER], ['viewer 390px', MOBILE, `localStorage.removeItem('pick_key:TOK');`]]) {
  const m = fgWorld(fgFiles(8));
  await suite(`finals gallery — the 確認完成 strip (${label}): ids and flow unchanged, above the hero, not over the photos`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const owner = label.startsWith('owner');
      await fgReady(page, 8);
      await fgSettle(page);
      const r = await page.evaluate(() => {
        const R = id => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top + scrollY, b: b.bottom + scrollY, h: b.height }; };
        const done = document.getElementById('deliveryDone');
        return { ids: ['deliveryDone', 'deliveryDoneStatus', 'doneConfirmBtn', 'doneReviseBtn'].map(i => [i, !!document.getElementById(i)]), done: R('deliveryDone'), hero: R('fgHero'), pos: getComputedStyle(done).position,
          status: document.getElementById('deliveryDoneStatus')?.textContent, state: done.dataset.state, firstTile: R('fgRows'),
          before: !!(document.getElementById('deliveryDone').compareDocumentPosition(document.getElementById('fgHero')) & Node.DOCUMENT_POSITION_FOLLOWING) };
      });
      ok(owner ? 'ids unchanged: deliveryDone, deliveryDoneStatus, doneConfirmBtn, doneReviseBtn' : 'viewer: the status line is there, the buttons are not',
        owner ? r.ids.every(([, v]) => v) : (r.ids[0][1] && r.ids[1][1] && !r.ids[2][1] && !r.ids[3][1]), JSON.stringify(r.ids));
      ok('the wording is unchanged', r.status === (owner ? '滿意的話請按「確認完成」，需要調整請按「需要修改」' : '尚待選片人確認完成') && r.state === 'open', JSON.stringify(r));
      ok('a strip above the hero: it ends where the hero starts, never over it, and is not fixed or sticky', r.done.b <= r.hero.t + 1 && r.pos !== 'fixed' && r.pos !== 'sticky' && r.before, JSON.stringify(r));
      ok('thin: <= 72px on a desktop, <= 96px on a phone', r.done.h <= (label.includes('390') ? 96 : 72), r.done.h);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${label.includes('390') ? 'phone' : 'desktop'}-strip.png` });
      if (owner) {
        await page.click('#doneReviseBtn');
        ok('需要修改 opens its modal over the gallery', await modalShown(page, 'doneReviseModal'));
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('doneReviseModal').classList.contains('active'));
        await page.click('#doneConfirmBtn');
        ok('確認完成 opens its modal', await modalShown(page, 'doneConfirmModal'));
        await page.click('#doneConfirmSubmit');
        // EDITED with the 完成頁 (suite 33): confirming now switches to the light completion page in place; the
        // 驗收頁's ✓ status block is gone, the gallery (same 8 photos) lives on inside the new page.
        await page.waitForSelector('#completionPage', { timeout: 5000 });
        await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length === 8, null, { timeout: 5000 });
        const c = await page.evaluate(() => ({ status: document.getElementById('cpConfirmed').textContent, btns: document.querySelectorAll('#doneConfirmBtn, #doneReviseBtn, #deliveryDone').length, tiles: document.querySelectorAll('.fg-tile').length }));
        ok('confirming works end to end: 已確認完成 on the completion page, no 驗收頁 block left, the gallery carried over', /^已確認完成/.test(c.status) && c.btns === 0 && c.tiles === 8, JSON.stringify(c));
        ok('exactly one POST /api/pick/confirm', donePosts(m, 'confirm').length === 1);
      }
      return out;
    },
    { before: m.attach, initScript: init, contextOptions: co });
}

// ── 11. share: the link only, never the owner's key
const FG_SHARE_URL = `${base}/index.html?t=TOK`;
const FG_DIRTY = `${base}/index.html?t=TOK&k=ZOE-KEY&owner_key=ZOE-KEY&utm=x#h=ZOE-KEY`;
const fgShareInit = (mode, who = 'owner') => `
  ${who === 'owner' ? `localStorage.setItem('pick_key:TOK', 'ZOE-KEY'); sessionStorage.setItem('picker_key', 'ZOE-KEY'); localStorage.setItem('h', 'ZOE-KEY');` : ''}
  window.__shared = []; window.__copied = []; window.__exec = [];
  const def = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
  ${mode === 'share' ? `def(navigator, 'share', async d => { window.__shared.push(d); });` : ''}
  ${mode === 'cancel' ? `def(navigator, 'share', async d => { window.__shared.push(d); throw new DOMException('cancelled', 'AbortError'); });` : ''}
  ${mode === 'sharefail' ? `def(navigator, 'share', async d => { window.__shared.push(d); throw new DOMException('no', 'NotAllowedError'); });` : ''}
  ${['copy', 'sharefail'].includes(mode) ? `def(navigator, 'clipboard', { writeText: async t => { window.__copied.push(t); } });` : ''}
  ${mode === 'execcopy' ? `def(navigator, 'clipboard', { writeText: async () => { throw new Error('denied'); } }); document.execCommand = c => { window.__exec.push([c, document.activeElement && document.activeElement.value]); return true; };` : ''}
  ${mode === 'nocopy' ? `def(navigator, 'clipboard', { writeText: async () => { throw new Error('denied'); } }); document.execCommand = () => false;` : ''}
  ${['copy', 'execcopy', 'nocopy'].includes(mode) ? `def(navigator, 'share', undefined);` : ''}
`;
for (const [name, mode, who, expectKey] of [
  ['Web Share API (owner, a dirty URL with the key in it)', 'share', 'owner', true],
  ['no Web Share: copied to the clipboard + a toast (owner, dirty URL)', 'copy', 'owner', true],
  ['no clipboard permission: the textarea + execCommand fallback copies (owner, dirty URL)', 'execcopy', 'owner', true],
  ['a viewer (no key anywhere) shares the same clean link', 'share', 'viewer', false],
]) {
  const m = fgWorld(fgFiles(6));
  await suite(`finals gallery share — ${name}`,
    expectKey ? FG_DIRTY : FG_SHARE_URL,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      if (expectKey) {
        const leak = await page.evaluate(() => ({ href: location.href, store: localStorage.getItem('pick_key:TOK') }));
        ok('control: the page\'s own URL and storage DO carry the key (so a naive share would leak it)', leak.href.includes('ZOE-KEY') && leak.store === 'ZOE-KEY', JSON.stringify(leak));
      }
      await page.click('#fgShare');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ shared: window.__shared, copied: window.__copied, exec: window.__exec, toast: document.querySelector('.toast.success .toast-message')?.textContent || null, err: document.querySelector('.toast.error') !== null }));
      const sent = mode === 'share' ? r.shared[0]?.url : mode === 'copy' ? r.copied[0] : r.exec[0]?.[1];
      ok('the link that went out is exactly origin + path + ?t=<token>', sent === FG_SHARE_URL, JSON.stringify(r));
      ok('nothing that went out carries the owner key, an extra query or a hash', !JSON.stringify(r).includes('ZOE-KEY') && !/owner_key|utm|#|[?&]k=/.test(sent || ''), JSON.stringify(r));
      if (mode === 'share') ok('the share sheet gets the project title and exactly one url', r.shared.length === 1 && r.shared[0].title === '婚禮精修' && r.copied.length === 0 && r.toast === null, JSON.stringify(r));
      if (mode === 'copy') ok('copied once, and the toast says 已複製連結', r.copied.length === 1 && r.toast === '已複製連結', JSON.stringify(r));
      if (mode === 'execcopy') ok('copy command ran once on the textarea holding the link, the toast says 已複製連結, no textarea left behind', r.exec.length === 1 && r.exec[0][0] === 'copy' && r.toast === '已複製連結' && (await page.$('textarea[data-fg-copy]')) === null, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: fgShareInit(mode, who), contextOptions: FG_DESK });
}
{
  const m = fgWorld(fgFiles(6));
  await suite('finals gallery share — cancelling the share sheet is silent; a failing share sheet falls back to the clipboard; no way to copy says so',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      await page.click('#fgShare');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ shared: window.__shared.length, copied: window.__copied.length, toasts: document.querySelectorAll('.toast').length }));
      ok('AbortError (the guest closed the sheet): the sheet was asked once, nothing copied, no toast at all', r.shared === 1 && r.copied === 0 && r.toasts === 0, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: fgShareInit('cancel'), contextOptions: FG_DESK });
}
{
  const m = fgWorld(fgFiles(6));
  await suite('finals gallery share — a share sheet that fails (not a cancel) falls back to copying the same clean link',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      await page.click('#fgShare');
      await page.waitForSelector('.toast.success', { timeout: 3000 });
      const r = await page.evaluate(() => ({ shared: window.__shared.length, copied: window.__copied, toast: document.querySelector('.toast.success .toast-message')?.textContent }));
      ok('asked the sheet once, then copied the clean link and said so', r.shared === 1 && JSON.stringify(r.copied) === JSON.stringify([FG_SHARE_URL]) && r.toast === '已複製連結', JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: fgShareInit('sharefail'), contextOptions: FG_DESK });
}
{
  const m = fgWorld(fgFiles(6));
  await suite('finals gallery share — nothing can copy: a plain error toast, no crash',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 6);
      await page.click('#fgShare');
      await page.waitForSelector('.toast.error', { timeout: 3000 });
      ok('says 無法複製連結', (await page.textContent('.toast.error .toast-message')) === '無法複製連結');
      ok('no textarea left behind', (await page.$('textarea[data-fg-copy]')) === null);
      return out;
    },
    { before: m.attach, initScript: fgShareInit('nocopy'), contextOptions: FG_DESK });
}

// ── 12. outside strings are text: file names, folder names, title, studio name
{
  const evil = '<img src=x onerror=window.__xss=1>';
  const hostileKey = `shoot/精修/${evil}9.jpg`;
  const hostileDir = `shoot/${evil}精修三/`;
  const files = [...fgFiles(3), hostileKey, `${hostileDir}f001.jpg`];
  const m = fgWorld(files, { finalFolders: ['shoot/精修/', hostileDir], title: `<img src=x onerror=window.__xss=2>專案`,
    studio: { name: '<img src=x onerror=window.__xss=3>工作室', booking_url: null, has_logo: false } });
  await suite('finals gallery — a file name, folder name, title and studio name that are HTML stay text: no element, no handler',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fgReady(page, 4);
      await fgSettle(page);
      const tileId = (await fgTiles(page)).find(k => k.includes('onerror'));
      ok('control: the hostile-named photo is among the tiles', !!tileId, JSON.stringify(await fgTiles(page)));
      await page.click(`.fg-tile[data-photo-id="${tileId.replace(/"/g, '\\"')}"]`);
      await page.waitForSelector('#fgLightbox');
      const r = await page.evaluate(() => ({ xss: window.__xss ?? null, stray: !!document.querySelector('img[src="x"]'),
        on: [...document.querySelectorAll('#finalsGallery *, #fgLightbox *, #deliveryBar *')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
        title: document.getElementById('fgTitle').textContent, lbName: document.getElementById('fgLbName').textContent, chips: document.getElementById('fgChips')?.textContent || '',
        aria: [...document.querySelectorAll('.fg-tile')].map(t => t.getAttribute('aria-label')).join('|'), studio: document.querySelector('#fgStudio .fg-studio-name')?.textContent,
        scripts: document.querySelectorAll('#finalsGallery script, #fgLightbox script').length }));
      ok('no handler ran, no stray <img src=x>, no on* attribute, no script', r.xss === null && !r.stray && r.on === 0 && r.scripts === 0, JSON.stringify(r));
      ok('the title, studio name, file name and chip label show the markup as plain text', r.title.includes('<img src=x onerror=window.__xss=2>') && r.studio.includes('<img') && r.lbName.includes('<img src=x onerror=window.__xss=1>9.jpg') && r.chips.includes('<img src=x onerror=window.__xss=1>精修三'), JSON.stringify(r));
      ok('the tile labels carry the name as text too', r.aria.includes('<img src=x onerror=window.__xss=1>9.jpg'), r.aria);
      return out;
    },
    { before: m.attach, initScript: FG_OWNER, contextOptions: FG_DESK });
}
}
