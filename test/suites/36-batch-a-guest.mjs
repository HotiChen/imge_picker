// Browser suites: guest-page batch A. (1) the 完成頁 hero prefers a LANDSCAPE final (js/completion-page.js setCover);
// (2) the 「正在載入…」 panel (#loadingModal) is a small centred pill, not a tall dimmed column.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, albKeys, albumWorld } from '../lib/album-world.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const P = [400, 600], L = [600, 400], SQ = [500, 500];          // portrait 0.67, landscape 1.5, square
const key = i => albKeys(40)[i - 1];                              // IMG_000i
const W = 'imagepicker.hotichen.workers.dev';
const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── 1. hero choice ────────────────────────────────────────────────────────
// shapes: the aspect of photo i (1-based). tune(page): extra routes on top of the world's (a later route runs first).
const heroCase = (name, shapes, expectIdx, { tune, wait = 5000, n = shapes.length } = {}) => {
  const w = albumWorld({ n, shapes, fake: { title: '婚禮精修', confirmedAt: T0 } });
  return suite(`hero 完成頁 — ${name}`, `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#cpCover', { timeout: wait });
      await page.waitForFunction(() => document.getElementById('cpCover')?.classList.contains('on'), null, { timeout: wait });
      const s = await page.evaluate(() => { const i = document.getElementById('cpCover'); return { id: i.dataset.photoId, nat: i.naturalWidth, n: document.querySelectorAll('#cpHero .cp-cover').length }; });
      ok(`hero is photo ${expectIdx} (${key(expectIdx)})`, s.id === key(expectIdx), JSON.stringify(s));
      ok('positive: the hero image really loaded, exactly one hero img', s.nat > 0 && s.n === 1, JSON.stringify(s));
      return out;
    },
    { before: async page => { await w.before(page); if (tune) await tune(page); }, initScript: OWNER, contextOptions: ALB_DESK });
};
const only400 = (page, k, fn) => page.route(`**/${W}/**`, async route => {
  const u = new URL(route.request().url());
  if (decodeURIComponent(u.pathname.slice(1)) === key(k) && u.searchParams.get('w') === '400') return fn(route);
  return route.fallback();
});

await heroCase('first portrait, second landscape -> the second', [P, L, L, P], 2);
await heroCase('all portrait -> the first (as before)', [P, P, SQ, P], 1);
await heroCase('first landscape -> the first', [L, L, P], 1);
await heroCase('threshold: 1.19 is not landscape, 1.2 is', [[500, 420], [600, 500], L], 2);
await heroCase('a landscape beyond the first 12 is not looked for -> the first', [...Array(12).fill(P), L, L], 1, { n: 14 });
await heroCase('a candidate that fails to load is skipped (2nd errors -> 3rd)', [P, L, L], 3,
  { tune: page => only400(page, 2, r => r.fulfill({ status: 404, body: 'x', headers: CORS })) });
await heroCase('deterministic: a slow 2nd landscape still wins over a fast 3rd', [P, L, L], 2,
  { tune: page => only400(page, 2, async r => { await new Promise(res => setTimeout(res, 700)); return r.fallback(); }) });
await heroCase('a probe that never answers is skipped after the timeout (1st landscape hangs -> 2nd)', [L, L], 2,
  { wait: 9000, tune: page => only400(page, 1, () => new Promise(() => {})) });

// every probe fails: the first final stays the hero as today (its own load is the preview bucket, not 400)
{
  const w = albumWorld({ n: 3, shapes: [P, L, L], fake: { title: '婚禮精修', confirmedAt: T0 } });
  await suite('hero 完成頁 — every candidate probe fails -> the first final is requested as hero', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#cpCover', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('cpCover')?.classList.contains('on'), null, { timeout: 5000 });
      const id = await page.evaluate(() => document.getElementById('cpCover').dataset.photoId);
      ok('hero is the first final', id === key(1), id);
      return out;
    },
    { before: async page => {
        await w.before(page);
        // the 400 thumbnails (probes) fail for the first three photos; the larger preview of the hero still answers
        await page.route(`**/${W}/**`, r => {
          const u = new URL(r.request().url());
          return u.searchParams.get('w') === '400' && /IMG_000[123]/.test(decodeURIComponent(u.pathname)) ? r.fulfill({ status: 404, body: 'x', headers: CORS }) : r.fallback();
        });
      }, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 2. the loading panel ───────────────────────────────────────────────────
const BOUND = { w: 220, h: 110 };
for (const [vp, co] of [['1280x800', { viewport: { width: 1280, height: 800 } }], ['390x844 phone', MOBILE]]) {
  for (const mode of ['ok', 'list fails']) {
    const w = albumWorld({ n: 6, fake: { confirmedAt: null } });
    let release;
    const gate = new Promise(r => { release = r; });
    await suite(`loading panel (${vp}, ${mode}) — a small pill while photos load, gone after`, `${base}/index.html?t=TOK`,
      async page => {
        const out = [], ok = line(out);
        await page.waitForSelector('#loadingModal.active', { timeout: 5000 });
        const look = () => page.evaluate(() => {
          const m = document.getElementById('loadingModal'), c = m.querySelector('.loading-content');
          const r = c.getBoundingClientRect(), mr = m.getBoundingClientRect();
          const sp = m.querySelector('.loading-spinner').getBoundingClientRect();
          return { disp: getComputedStyle(m).display, w: r.width, h: r.height, mw: mr.width, mh: mr.height, txt: m.textContent.trim(),
            centreX: Math.abs(r.left + r.width / 2 - innerWidth / 2), centreY: Math.abs(r.top + r.height / 2 - innerHeight / 2),
            spinner: sp.width > 0 && sp.height > 0, vw: innerWidth,
            overlay: getComputedStyle(m.querySelector('.modal-overlay')).display, noHScroll: document.documentElement.scrollWidth <= innerWidth };
        });
        await page.waitForTimeout(600);   // the slideUp entrance animation (translateY 24px) has to finish
        const a = await look();
        ok('positive control: the panel IS shown while loading, with spinner and 正在載入', a.disp !== 'none' && a.w > 0 && a.spinner && a.txt.includes('正在載入'), JSON.stringify(a));
        ok(`the panel box (and its modal wrapper) is <= ${BOUND.w}x${BOUND.h}`, a.w <= BOUND.w && a.h <= BOUND.h && a.mw <= BOUND.w && a.mh <= BOUND.h, JSON.stringify(a));
        ok('centred on the viewport', a.centreX < 2 && a.centreY < 2, JSON.stringify(a));
        ok('no dimming overlay (the page behind stays visible)', a.overlay === 'none', JSON.stringify(a));
        ok('no horizontal scroll', a.noHScroll, JSON.stringify(a));
        release();
        await page.waitForFunction(() => !document.getElementById('loadingModal').classList.contains('active'), null, { timeout: 5000 });
        const b = await look();
        ok('gone afterwards: not active and computed display none', b.disp === 'none', JSON.stringify(b));
        if (mode === 'ok') {
          await page.waitForSelector('.fg-tile', { timeout: 5000 });
          ok('positive: the photos are there after loading', (await page.$$('.fg-tile')).length === 6);
        }
        return out;
      },
      { before: async page => {
          await w.before(page);
          await page.route(`**/${W}/**`, async route => {
            const u = new URL(route.request().url());
            if (route.request().method() === 'GET' && u.searchParams.has('list')) {
              await gate;
              if (mode === 'list fails') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}', headers: CORS });
            }
            return route.fallback();
          });
        }, initScript: OWNER, contextOptions: co });
  }
}
}
