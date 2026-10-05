// Browser suites: album preview: entry, flow, errors, 390px layout.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, ROOT, realTouch, swipeTouch } from '../lib/env.mjs';
import { ALB_DESK, ALB_OWNER, ALB_VIEWER, albGalleryReady, albKeys, albPending, albReady, albShot, albSnap, albumWorld } from '../lib/album-world.mjs';
import { LUM } from '../lib/delivery-helpers.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Album preview, stage 1 (docs/album-preview.md) — the delivered finish page
// gets one entry; pressing it lays the guest's own finals out as an album on
// the phone, read-only. The fake worker below answers exactly what the real
// one does for these reads: `?list=` -> {status, data:[{id,name,size,uploaded}],
// folders}, and `/<key>?w=N&t=` -> the photo with Access-Control-Allow-Origin
// (the engine reads pixels through a crossOrigin canvas), 404 for a miss.
// ═══════════════════════════════════════════════════════════════════════════

const ALB_STAMP = /js\/pick\.js\?v=([^"]+)"/.exec(readFileSync(join(ROOT, 'index.html'), 'utf8'))[1];
const albCur = s => s.slides.find(x => x.cur);
const albExpected = (page, ids) => page.evaluate(async ids => {
  const items = await AutoLayout.analyze(ids, { urlFor: id => driveManager.getImageUrl({ id }, 400) });
  const p = AutoLayout.planSpreads(items, { ...AlbumPreview.PLAN_OPTS, coverAspect: 210 / 297, spreadAspect: 420 / 297 });   // the options the preview itself passes
  return { cover: p.cover && p.cover.photoId, pages: p.spreads.map(x => ({ layout: x.template, ids: x.slots.map(s => s.photoId) })), dropped: p.dropped };
}, ids);
const albEngineLoads = world => world.assets.filter(p => /\/book_editor\/js\/(layouts|spread_templates|auto_layout)\.js/.test(p));

// ── 1. the entry: delivered only, beside (never over) the confirmation block
for (const [label, co, init] of [['owner 1280px', ALB_DESK, ALB_OWNER], ['viewer 390px', MOBILE, ALB_VIEWER]]) {
  const w = albumWorld({ n: 6, fake: { allowProofDownload: true } });
  // REWRITTEN with the finals gallery: the entry now sits under the last row (the last thing on the page),
  // no longer right under the 確認完成 block — that block is a thin strip at the top.
  await suite(`album preview entry ${label} — delivered gallery has it, under the last row, nothing loaded yet`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const owner = label.startsWith('owner');
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      const g = await page.evaluate(() => {
        const R = id => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
        const btn = document.getElementById('albumPreviewBtn');
        const done = document.getElementById('deliveryDone');
        const lastTile = [...document.querySelectorAll('.fg-tile')].pop().getBoundingClientRect();
        const cs = getComputedStyle(btn);
        const buttons = [...done.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { text: b.textContent, hit: hit === b || b.contains(hit) }; });
        return { entry: R('albumPreviewEntry'), done: R('deliveryDone'), bar: R('deliveryBar'), btn: R('albumPreviewBtn'), text: btn.textContent, disp: cs.display,
          order: document.getElementById('albumPreviewEntry').previousElementSibling?.id === 'fgRows' && !!document.getElementById('albumPreviewEntry').closest('#finalsGallery') && done.nextElementSibling?.id !== 'albumPreviewEntry',
          lastTileB: lastTile.bottom,
          buttons, sw: document.documentElement.scrollWidth, iw: innerWidth,
          count: document.querySelectorAll('#albumPreviewBtn').length, viewer: !!document.getElementById('albumViewer') };
      });
      ok('the entry exists, once, with the wording', g.count === 1 && /看看你的照片排成相本/.test(g.text), g.text);
      ok('one line says it is an automatic sketch the photographer can adjust', /系統自動排版的示意/.test(g.text) && /攝影師/.test(g.text), g.text);
      ok('it is the last thing on the page: inside the gallery, right after the rows (and no longer next to the 確認完成 block)', g.order);
      ok('it is shown, tappable size, and inside the viewport width', g.disp !== 'none' && g.btn.h >= 44 && g.btn.l >= 0 && g.btn.r <= g.iw + 0.5, JSON.stringify(g.btn));
      ok('it sits below the last photo and does not overlap the confirmation block, which is above everything', g.entry.t >= g.lastTileB - 0.5 && g.entry.t >= g.done.b - 0.5 && g.done.t >= g.bar.b - 0.5, JSON.stringify([g.bar, g.done, g.entry, g.lastTileB]));
      ok(owner ? '確認完成 / 需要修改 are still there and are what a tap hits'
        : 'a viewer: the status block is there with no buttons, and the entry is still offered', owner
        ? g.buttons.length === 2 && g.buttons.every(b => b.hit) : g.buttons.length === 0, JSON.stringify(g.buttons));
      ok('no horizontal scroll', g.sw <= g.iw);
      ok('the viewer is not in the DOM before the press', !g.viewer);
      const dark = await page.evaluate(`(() => { const L = ${LUM}; const cs = s => getComputedStyle(document.querySelector(s));
        return { body: L(cs('body').backgroundColor), entry: L(cs('#albumPreviewBtn').backgroundColor), text: L(cs('#albumPreviewBtn .album-entry-title').color) }; })()`);
      ok('still the dark client theme (dark entry, light text)', dark.body < 0.2 && dark.entry < 0.3 && dark.text > 0.6, JSON.stringify(dark));
      // nothing loaded, nothing requested for it
      const pre = await page.evaluate(() => ({ layouts: typeof LAYOUTS, auto: typeof AutoLayout, fn: typeof renderPageHTML, tpl: typeof SpreadTemplates }));
      ok('before the press: no layouts.js / spread_templates.js / auto_layout.js requested, no globals', albEngineLoads(w).length === 0 && pre.layouts === 'undefined' && pre.auto === 'undefined' && pre.fn === 'undefined' && pre.tpl === 'undefined', JSON.stringify([albEngineLoads(w), pre]));
      ok('control: the page did ask for its own scripts (the request log works)', w.assets.some(p => /\/js\/pick\.js/.test(p)) && w.assets.some(p => /\/js\/album-preview\.js/.test(p)), w.assets.slice(0, 4).join());
      ok('before the press: only the gallery\'s own reads — the final folder listing and the cover / tile thumbnails (400 / 1200 / 1600 buckets, never an original)',
        w.log.every(r => r.method === 'GET' && (r.path === '/api/pick/state' || r.path === '/api/studio/logo' || r.list === 'shoot/精修/' || (['400', '1200', '1600'].includes(r.w) && r.key.startsWith('shoot/精修/') && !r.download))),
        JSON.stringify(w.log.filter(r => !(r.path === '/api/pick/state' || r.path === '/api/studio/logo' || r.list === 'shoot/精修/' || ['400', '1200', '1600'].includes(r.w)))));
      await albShot(page, `entry-${label.replace(' ', '-')}`);

      // the proofs view is not the finals: the entry goes, and comes back with them
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.getElementById('deliveryTitle')?.textContent.startsWith('毛片'), null, { timeout: 4000 });
      ok('in the 下載毛片原檔 view the entry is gone from the DOM', (await page.$('#albumPreviewEntry')) === null && (await page.$('#albumPreviewBtn')) === null);
      ok('...while the confirmation block is still there (control)', (await page.$('#deliveryDone')) !== null);
      await page.click('#deliveryProofsBtn');
      await page.waitForSelector('#albumPreviewBtn', { timeout: 4000 });
      ok('back on the finals the entry is back, once', (await page.$$('#albumPreviewBtn')).length === 1);
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// picking, and a delivery taken back (the finals stay on the project): no DOM at all
for (const [name, opts] of [
  ['picking', { phase: 'picking', deliveredAt: null, finalFolders: null }],
  ['undelivered with the finals kept', { phase: 'retouching', deliveredAt: null, finalFolders: ['shoot/精修/'] }],
]) {
  const w = albumWorld({ n: 6, fake: opts });
  await suite(`album preview entry — ${name}: no entry in the DOM, nothing requested`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('control: the gallery really loaded cards', (await page.$$('.photo-card')).length > 0);
      const s = await page.evaluate(() => ({ mode: document.getElementById('deliveryBar')?.hidden, done: !!document.getElementById('deliveryDone'),
        entry: !!document.getElementById('albumPreviewEntry'), btn: !!document.getElementById('albumPreviewBtn') }));
      ok('not in delivered mode (no delivery block either)', s.done === false, JSON.stringify(s));
      ok('no entry, no button', !s.entry && !s.btn, JSON.stringify(s));
      ok('no engine script requested', albEngineLoads(w).length === 0);
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 2. the flow on a desktop: progress, cancel-free run, pages, flipping, audit
{
  const w = albumWorld({ n: 48, sub: 6, dup: { 4: 3 } });
  await suite('album preview 1280px — press, progress, cover + pages, flip, only ±1 page drawn, thumbnails only, nothing written',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      // the planner no longer drops near-duplicates by default (dedupe 'separate'); this suite
      // covers the legacy drop path and its note, so it asks for it explicitly
      await page.evaluate(() => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, dedupe: 'drop' }; });
      const logStart = w.log.length;
      const storageStart = await page.evaluate(() => window.__storageWrites.length);
      const aliveStart = await page.evaluate(() => window.__alive.length);
      const timerStart = await page.evaluate(() => window.__timerSeq());

      // hold the thumbnails after the first 24: the progress must show 24/48
      w.ctl.hold = { allow: 24, seen: 0 };
      await page.click('#albumPreviewBtn');
      await page.waitForSelector('#albumViewer', { timeout: 4000 });
      await page.waitForFunction(() => /24\s*\/\s*48/.test(document.getElementById('albumProgress')?.textContent || ''), null, { timeout: 15000 });
      const prog = await page.evaluate(() => {
        const v = document.getElementById('albumViewer'), r = v.getBoundingClientRect(), c = document.getElementById('albumCancel');
        const cr = c.getBoundingClientRect(), hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        return { state: v.dataset.state, text: document.getElementById('albumProgress').textContent, role: v.getAttribute('role'), modal: v.getAttribute('aria-modal'),
          rect: [r.left, r.top, r.width, r.height, innerWidth, innerHeight], cancel: c.textContent, cancelHit: hit === c || c.contains(hit),
          overflow: getComputedStyle(document.documentElement).overflow, focusIn: v.contains(document.activeElement) };
      });
      ok('the viewer covers the whole window, as a dialog', prog.role === 'dialog' && prog.modal === 'true' && prog.rect[0] === 0 && prog.rect[1] === 0 && prog.rect[2] === prog.rect[4] && prog.rect[3] === prog.rect[5], JSON.stringify(prog.rect));
      ok('state loading, text 正在為你排版… 24/48', prog.state === 'loading' && /^正在為你排版…\s*24\s*\/\s*48$/.test(prog.text.trim()), prog.text);
      ok('a cancel button is there and is what a tap hits', /取消/.test(prog.cancel) && prog.cancelHit);
      ok('the page behind does not scroll; focus moved into the dialog', prog.overflow === 'hidden' && prog.focusIn, JSON.stringify([prog.overflow, prog.focusIn]));
      const eng = albEngineLoads(w);
      ok('layouts.js, spread_templates.js, auto_layout.js, once each, only now, with the page\'s own ?v= stamp',
        eng.length === 3 && /layouts\.js\?v=/.test(eng[0]) && /spread_templates\.js\?v=/.test(eng[1]) && /auto_layout\.js\?v=/.test(eng[2]) && eng.every(p => p.endsWith(`?v=${ALB_STAMP}`)), JSON.stringify(eng));
      await page.waitForTimeout(350);
      await albShot(page, 'progress-1280');
      // Tab / Shift+Tab never leave the dialog (it is modal)
      let trapped = true;
      for (let i = 0; i < 6; i++) { await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab'); trapped = trapped && await page.evaluate(() => document.getElementById('albumViewer').contains(document.activeElement)); }
      for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); trapped = trapped && await page.evaluate(() => document.getElementById('albumViewer').contains(document.activeElement)); }
      ok('Tab and Shift+Tab stay inside the dialog', trapped);
      w.release();
      await albReady(page);

      // ── the audit window ends here: what the page asked for, and wrote, while building and viewing
      await page.waitForFunction(() => { const im = document.querySelector('.album-slide[data-current="true"] img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 5000 });
      const snapReady = await albSnap(page);
      const cover = albCur(snapReady);
      ok('ready: on the cover, labelled 封面, one slide current', snapReady.label === '封面' && snapReady.slides.filter(s => s.cur).length === 1 && cover.i === 0, JSON.stringify(snapReady));
      ok('the cover shows one photo, on the single-page cover (not a spread)', cover.ids.length === 1 && cover.layout === 'cover', JSON.stringify(cover));
      ok('on the cover 上一頁 is disabled, 下一頁 is not', snapReady.prevDis === true && snapReady.nextDis === false);
      const shown = await page.evaluate(() => {
        const v = document.getElementById('albumViewer'), cur = v.querySelector('.album-slide[data-current="true"] .album-page'), r = cur.getBoundingClientRect();
        const bar = v.querySelector('.album-viewer-bar').getBoundingClientRect(), foot = v.querySelector('.album-viewer-foot').getBoundingClientRect();
        const im = cur.querySelector('img'), sl = im.parentElement.getBoundingClientRect(), ir = im.getBoundingClientRect();
        return { w: r.width, h: r.height, l: r.left, t: r.top, barB: bar.bottom, footT: foot.top, iw: innerWidth, ih: innerHeight,
          // REWRITTEN for fit: 'contain' (the default): the photo sits WHOLE inside its frame and touches it on one side
          // (it used to fill the frame, cropped); the whole-photo geometry is measured properly in the "album preview contain" suites
          covers: ir.left >= sl.left - 1 && ir.right <= sl.right + 1 && ir.top >= sl.top - 1 && ir.bottom <= sl.bottom + 1
            && (Math.abs(ir.width - sl.width) <= 1 || Math.abs(ir.height - sl.height) <= 1),
          loaded: im.complete && im.naturalWidth > 0, dec: im.decoding, bg: getComputedStyle(v).backgroundColor, color: getComputedStyle(v).color,
          dpr: devicePixelRatio, w: r.width, src: im.src };
      });
      ok('the cover is one A4 portrait page (210 x 297, 0.7071)', Math.abs(shown.w / shown.h - 210 / 297) < 0.01 && shown.h > 500, `${shown.w}x${shown.h}`);
      ok('and it sits in the middle of the window (single page, centred)', Math.abs((shown.l + shown.w / 2) - shown.iw / 2) < 2, JSON.stringify(shown));
      ok('it sits between the bar and the footer, inside the window', shown.t >= shown.barB - 0.5 && shown.t + shown.h <= shown.footT + 0.5 && shown.l >= 0 && shown.l + shown.w <= shown.iw, JSON.stringify(shown));
      ok('the cover photo is loaded and sits whole in its frame, touching it on one side (contain: nothing cropped)', shown.loaded && shown.covers && shown.dec === 'async', JSON.stringify(shown));
      ok('dark ground, light text', await page.evaluate(`(() => { const L = ${LUM}; const v = getComputedStyle(document.getElementById('albumViewer')); return L(v.backgroundColor) < 0.2 && L(v.color) > 0.6; })()`));
      await albShot(page, 'cover-1280');

      // walk every page with the right arrow, auditing each stop
      const ids = w.files;
      const walked = [snapReady];
      let guard = 0;
      while (!(walked.at(-1).nextDis) && guard++ < 60) {
        await page.keyboard.press('ArrowRight');
        const n = walked.length;
        await page.waitForFunction(i => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === String(i), n, { timeout: 4000 });
        walked.push(await albSnap(page));
        if (n === 1 || n === 3) { await page.waitForTimeout(350); await albShot(page, `page-${n}-1280`); }
      }
      const total = walked.length - 1;
      ok('the last page was reached with the key; 下一頁 disabled there', walked.at(-1).nextDis === true && total >= 5, `${total}`);
      ok('labels: 封面, then n / total', walked.every((s, i) => s.label === (i === 0 ? '封面' : `${i} / ${total}`)), JSON.stringify(walked.map(s => s.label)));
      ok('only the current page and its two neighbours exist, at every stop',
        walked.every((s, i) => JSON.stringify(s.slides.map(x => x.i)) === JSON.stringify([i - 1, i, i + 1].filter(x => x >= 0 && x <= total))), JSON.stringify(walked.map(s => s.slides.map(x => x.i))));
      ok('and exactly their photos are in the DOM (no other photo has an <img>; a spread holds up to 8, so three pages at most 24)', walked.every(s => s.imgs === s.slides.reduce((a, x) => a + x.ids.length, 0)) && Math.max(...walked.map(s => s.imgs)) <= 24,
        JSON.stringify(walked.map(s => s.imgs)));
      await page.waitForTimeout(400);           // the slide transition
      ok('the neighbours are out of sight (clipped beside the page), the current one is not',
        await page.evaluate(() => {
          const st = document.getElementById('albumStage').getBoundingClientRect();
          return [...document.querySelectorAll('.album-slide')].every(s => {
            const r = s.getBoundingClientRect(), cur = s.dataset.current === 'true';
            return cur ? (r.left >= st.left - 1 && r.right <= st.right + 1) : (r.left >= st.right - 1 || r.right <= st.left + 1);
          });
        }));

      // every photo once; the repeated shot (index 4 repeats 3) is the one left out
      const everyId = walked.flatMap(s => { const c = albCur(s); return c.ids; });
      const sub = ids.filter(k => k.includes('/加洗/'));
      ok('the subfolder\'s photos are in the album too (positive control)', sub.length === 6 && sub.every(k => everyId.includes(k)), sub.filter(k => !everyId.includes(k)).join());
      ok('no photo outside the finals folders appears; none is used twice except the cover (also inside the book)',
        everyId.every(k => w.keys.has(k)) && everyId.filter(k => !k.includes('/加洗/')).length > 0);
      const dropped = ids.filter(k => !everyId.includes(k));
      ok('exactly the repeated shot is left out', dropped.length === 1 && (dropped[0] === ids[3] || dropped[0] === ids[4]), dropped.join());

      // ── requests so far: list + thumbnails only, nothing written
      const during = w.log.slice(logStart);
      const imgReqs = during.filter(r => r.key && w.keys.has(r.key));
      ok('control: the log saw photo reads', imgReqs.length > 48, `${imgReqs.length}`);
      ok('every photo read is a thumbnail: ?w= present, a pre-generated bucket, token carried, never download', imgReqs.every(r => ['400', '1200', '1600'].includes(r.w) && r.t === 'TOK' && r.download === null), JSON.stringify(imgReqs.filter(r => !['400', '1200', '1600'].includes(r.w)).slice(0, 3)));
      ok('no request for a photo without ?w= (an original), under any name', during.filter(r => w.keys.has(r.key)).every(r => r.w !== null));
      ok('the listings are the final folders only (root and its subfolder)', during.filter(r => r.list !== null).every(r => r.list === 'shoot/精修/' || r.list === 'shoot/精修/加洗/') && during.some(r => r.list === 'shoot/精修/加洗/'), JSON.stringify(during.filter(r => r.list !== null).map(r => r.list)));
      ok('no proof folder was read', during.every(r => !(r.key || '').startsWith('shoot/毛片/') && r.list !== 'shoot/毛片/'));
      ok('no POST / PUT / PATCH / DELETE at all', during.every(r => r.method === 'GET'), JSON.stringify(during.filter(r => r.method !== 'GET')));
      ok('each photo was analysed once (400 thumbnails = the photo count), none twice', during.filter(r => r.w === '400').length === 48 && new Set(during.filter(r => r.w === '400').map(r => r.key)).size === 48);
      // the cover and a spread are different widths, so each gets the bucket for its own displayed size
      const seenW = [...new Set(during.filter(r => r.w !== '400' && w.keys.has(r.key)).map(r => r.w))];
      const wantW = await page.evaluate(() => [...new Set([...document.querySelectorAll('.album-page')].map(p => String(driveManager.previewWidth(p.offsetWidth, devicePixelRatio))))]);
      ok('each page asks for the bucket of its own displayed size (cover and spread), never the 1600 default of renderPageHTML',
        seenW.length >= 1 && seenW.every(x => ['400', '1200', '1600'].includes(x)) && seenW.every(x => wantW.includes(x)), JSON.stringify([seenW, wantW]));
      ok('nothing was stored: localStorage / sessionStorage untouched', (await page.evaluate(() => window.__storageWrites.length)) === storageStart, JSON.stringify(await page.evaluate(() => window.__storageWrites.slice(-3))));

      // ── what the page shows is what plan() makes of the same photos
      const exp = await albExpected(page, ids);
      ok('the cover is the photo plan() chose', cover.ids[0] === exp.cover, `${cover.ids[0]} vs ${exp.cover}`);
      ok('the pages are plan()\'s pages: same count, layouts and photos, in order',
        total === exp.pages.length && exp.pages.every((p, i) => { const c = albCur(walked[i + 1]); return c.layout === p.layout && JSON.stringify(c.ids) === JSON.stringify(p.ids); }),
        JSON.stringify([total, exp.pages.length, walked.slice(1, 4).map(s => albCur(s)), exp.pages.slice(0, 3)]));
      ok('at least three different layouts appear (so the screenshots are not one shape)', new Set(exp.pages.map(p => p.layout)).size >= 3, JSON.stringify([...new Set(exp.pages.map(p => p.layout))]));

      // ── flipping: buttons, keys, and the first page
      await page.click('#albumPrev');
      ok('下一頁 / 上一頁 buttons: 上一頁 goes back one', (await albSnap(page)).label === `${total - 1} / ${total}`);
      await page.click('#albumNext');
      ok('and 下一頁 forward', (await albSnap(page)).label === `${total} / ${total}`);
      for (let i = 0; i < total + 3; i++) await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === '0', null, { timeout: 4000 });
      const back = await albSnap(page);
      ok('← past the cover stays on the cover, 上一頁 disabled', back.label === '封面' && back.prevDis === true);
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === '2', null, { timeout: 4000 });
      ok('arrow keys flip exactly one page each', (await albSnap(page)).label === '2 / ' + total);

      // ── the notes: a repeated shot was skipped
      const note = (await albSnap(page)).note;
      ok('the note says 1 similar photo was skipped', /已略過 1 張相近的照片/.test(note), note);
      ok('and says nothing about a cap (positive: 48 < 240)', !/前 240/.test(note), note);
      const noteStyle = await page.evaluate(() => { const e = document.getElementById('albumNote'); return { c: getComputedStyle(e).color, fs: parseFloat(getComputedStyle(e).fontSize), vis: e.getClientRects().length > 0 }; });
      ok('the note is visible, small and muted', noteStyle.vis && noteStyle.fs <= 14, JSON.stringify(noteStyle));

      // ── close with Esc: focus back on the entry, everything gone
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id, overflow: getComputedStyle(document.documentElement).overflow,
        alive: window.__alive.length, slides: document.querySelectorAll('.album-slide').length, viewer: !!document.getElementById('albumViewer') }));
      ok('Esc closes it; focus is back on the entry button', after.focus === 'albumPreviewBtn' && !after.viewer && after.slides === 0, JSON.stringify(after));
      ok('the page scrolls again', after.overflow !== 'hidden');
      ok('no listener left on window / document', after.alive === aliveStart, `${after.alive} vs ${aliveStart}`);
      await page.waitForTimeout(700);
      ok('no timer is left running that the album started', (await albPending(page, timerStart)).length === 0, JSON.stringify(await albPending(page, timerStart)));
      const reqsAfterClose = w.log.length;
      await page.waitForTimeout(500);
      ok('and no request is made after closing', w.log.length === reqsAfterClose);

      // ── three more open / close rounds: nothing piles up, the engine files are not fetched again
      const engineBefore = albEngineLoads(w).length;
      for (let r = 0; r < 3; r++) {
        const n0 = w.log.length;
        // a double press (r === 0) must not build two viewers or analyse twice
        if (r === 0) await page.evaluate(() => { const b = document.getElementById('albumPreviewBtn'); b.click(); b.click(); });
        else await page.click('#albumPreviewBtn');
        await albReady(page);
        if (r === 0) ok('a double press made one viewer', (await page.$$('#albumViewer')).length === 1);
        ok(`round ${r + 1}: one analysis per photo again (48 × ?w=400, no doubling)`, w.log.slice(n0).filter(x => x.w === '400').length === 48, `${w.log.slice(n0).filter(x => x.w === '400').length}`);
        await page.click('#albumClose');
        await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      }
      const end = await page.evaluate(() => ({ alive: window.__alive.length, focus: document.activeElement?.id,
        layoutsTags: document.querySelectorAll('script[src*="layouts.js"]').length, autoTags: document.querySelectorAll('script[src*="auto_layout.js"]').length,
        tplTags: document.querySelectorAll('script[src*="spread_templates.js"]').length, viewers: document.querySelectorAll('#albumViewer').length }));
      ok('×3: listeners back to the start, one viewer at most, focus on the entry', end.alive === aliveStart && end.viewers === 0 && end.focus === 'albumPreviewBtn', JSON.stringify(end));
      ok('×3: the engine scripts were loaded once in all, one tag each', albEngineLoads(w).length === engineBefore && end.layoutsTags === 1 && end.autoTags === 1 && end.tplTags === 1, JSON.stringify([albEngineLoads(w), end]));
      await page.waitForTimeout(500);
      ok('×3: still no timers left over', (await albPending(page, timerStart)).length === 0, JSON.stringify(await albPending(page, timerStart)));
      ok('×3: the whole session wrote nothing to storage and sent no write request', (await page.evaluate(() => window.__storageWrites.length)) === storageStart && w.log.slice(logStart).every(r => r.method === 'GET'));
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 3. cancel mid-way: back on the gallery, nothing keeps running
{
  const w = albumWorld({ n: 60 });
  await suite('album preview — 取消 aborts the analysis: gallery again, no request, no timer, no viewer',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      const timerStart = await page.evaluate(() => window.__timerSeq());
      const aliveStart = await page.evaluate(() => window.__alive.length);
      w.ctl.hold = { allow: 24, seen: 0 };
      await page.click('#albumPreviewBtn');
      await page.waitForFunction(() => /24\s*\/\s*60/.test(document.getElementById('albumProgress')?.textContent || ''), null, { timeout: 15000 });
      await page.waitForTimeout(300);           // the next batch of 6 is on its way: count it
      const hitsAtCancel = w.ctl.corsHits;
      await page.click('#albumCancel');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      ok('the viewer is gone and the entry has the focus', (await page.evaluate(() => document.activeElement?.id)) === 'albumPreviewBtn');
      ok('control: the gallery is still there with its tiles', (await page.$$('.fg-tile')).length > 0 && (await page.$('#albumPreviewBtn')) !== null);
      // let the held responses go: a live analysis would now carry on and ask for more
      w.release();
      await page.waitForTimeout(900);
      ok('after cancelling, the engine asked for no more photos (even when the held ones come back)', w.ctl.corsHits === hitsAtCancel && hitsAtCancel > 24, `${hitsAtCancel} -> ${w.ctl.corsHits}`);
      ok('no timer left, no listener left', (await albPending(page, timerStart)).length === 0 && (await page.evaluate(() => window.__alive.length)) === aliveStart, JSON.stringify(await albPending(page, timerStart)));
      ok('the viewer did not come back later', (await page.$('#albumViewer')) === null);
      // and a fresh press works after a cancel (state was reset)
      await page.click('#albumPreviewBtn');
      await albReady(page);
      ok('pressing again after a cancel builds the album normally', (await albSnap(page)).label === '封面');
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 3b. the default keeps look-alikes (dedupe 'separate'): every photo is laid out, no 已略過 note
{
  const w = albumWorld({ n: 12, dup: { 4: 3 } });
  await suite('album preview — by default a repeated shot is kept (apart, not dropped): every photo is in the album, no 已略過 note',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);
      await page.click('#albumPreviewBtn');
      await albReady(page);
      const seen = new Set();
      let snap = await albSnap(page), guard = 0;
      for (const id of albCur(snap).ids) seen.add(id);
      while (!snap.nextDis && guard++ < 40) {
        await page.keyboard.press('ArrowRight');
        const i = (snap.slides.find(s => s.cur) || {}).i + 1;
        await page.waitForFunction(i2 => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === String(i2), i, { timeout: 4000 });
        snap = await albSnap(page);
        for (const id of albCur(snap).ids) seen.add(id);
      }
      const missing = w.files.filter(k => !seen.has(k));
      ok('all 12 photos are laid out, the repeated one included (positive: 12 files in the world)', w.files.length === 12 && missing.length === 0, missing.join());
      const note = await page.evaluate(() => document.getElementById('albumViewer')?.textContent ?? '');
      ok('no 「已略過」 note: nothing was dropped', !/已略過/.test(note), note.slice(0, 120));
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 4. few photos, errors, retry, the cap
for (const [name, n, dup, expectRe] of [
  ['one photo', 1, {}, /至少需要 2 張/],
  ['two photos that are the same picture', 2, { 1: 0 }, /至少需要 2 張/],
]) {
  const w = albumWorld({ n, dup });
  await suite(`album preview — ${name}: a friendly message, no album, a way out`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n2, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n2}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      // identical photos only "collapse to one" on the legacy drop path (the default now keeps them all)
      if (Object.keys(dup).length) await page.evaluate(() => { AlbumPreview.PLAN_OPTS = { ...AlbumPreview.PLAN_OPTS, dedupe: 'drop' }; });
      await page.click('#albumPreviewBtn');
      await page.waitForFunction(() => document.getElementById('albumViewer')?.dataset.state === 'few', null, { timeout: 15000 });
      const s = await page.evaluate(() => ({ text: document.getElementById('albumFew')?.textContent ?? null, pages: document.querySelectorAll('.album-page').length,
        nav: !!document.getElementById('albumNext'), label: document.getElementById('albumLabel')?.textContent ?? '' , err: !!document.getElementById('albumError') }));
      ok('the message says at least 2 photos are needed', expectRe.test(s.text || ''), s.text);
      ok('no album pages, no flip buttons, not an error', s.pages === 0 && !s.nav && !s.err, JSON.stringify(s));
      await albShot(page, `few-${n}-${Object.keys(dup).length}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      ok('Esc closes it, focus on the entry', (await page.evaluate(() => document.activeElement?.id)) === 'albumPreviewBtn');
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = albumWorld({ n: 10 });
  await suite('album preview — every photo fails to load: a retryable error, then the retry builds the album',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      w.ctl.failImages = true;
      await page.click('#albumPreviewBtn');
      await page.waitForFunction(() => document.getElementById('albumViewer')?.dataset.state === 'error', null, { timeout: 15000 });
      const e = await page.evaluate(() => ({ text: document.getElementById('albumError')?.textContent ?? '', retry: !!document.getElementById('albumRetry'), pages: document.querySelectorAll('.album-page').length, few: !!document.getElementById('albumFew') }));
      ok('an error state with a 重試 button, no pages, not the few-photos message', /讀取/.test(e.text) && e.retry && e.pages === 0 && !e.few, JSON.stringify(e));
      await albShot(page, 'error');
      w.ctl.failImages = false;
      await page.click('#albumRetry');
      await albReady(page);
      ok('重試 then builds the album (cover first)', (await albSnap(page)).label === '封面');
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = albumWorld({ n: 10 });
  await suite('album preview — the listing fails: the same retryable error, nothing half-built',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      w.ctl.failList = 1;
      const h0 = w.ctl.imageHits;
      await page.click('#albumPreviewBtn');
      await page.waitForFunction(() => document.getElementById('albumViewer')?.dataset.state === 'error', null, { timeout: 15000 });
      ok('error with 重試, and no photo was analysed', !!(await page.$('#albumRetry')) && w.ctl.imageHits === h0, `${h0} -> ${w.ctl.imageHits}`);
      await page.click('#albumRetry');
      await albReady(page);
      ok('retry works once the listing answers', (await albSnap(page)).label === '封面');
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = albumWorld({ n: 40 });
  await suite('album preview — more photos than the cap: the first MAX_PHOTOS are laid out, and it says so',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      ok('the real cap is 240', (await page.evaluate(() => AlbumPreview.MAX_PHOTOS)) === 240);
      await page.evaluate(() => { AlbumPreview.MAX_PHOTOS = 12; });
      const n0 = w.log.length;
      await page.click('#albumPreviewBtn');
      await albReady(page);
      const during = w.log.slice(n0).filter(r => r.w === '400');
      const first12 = [...w.files].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).slice(0, 12);
      ok('only 12 photos were analysed — the first 12 in file order', during.length === 12 && first12.every(k => during.some(r => r.key === k)), JSON.stringify(during.map(r => r.key)));
      const snap = await albSnap(page);
      ok('the note says only the first 12 were used', /已先用前 12 張排版/.test(snap.note), snap.note);
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
{
  const w = albumWorld({ n: 12 });
  await suite('album preview — nothing to skip, nothing to say: no note when every photo is used',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      await page.click('#albumPreviewBtn');
      await albReady(page);
      const s = await albSnap(page);
      ok('control: the album is up', s.label === '封面' && s.slides.length >= 2);
      ok('no 已略過 / 已先用 note', s.note.trim() === '', JSON.stringify(s.note));
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 5. a phone: layout, swipe (and what must not flip), fit, real touch
{
  const w = albumWorld({ n: 36, dup: { 4: 3 } });
  await suite('album preview 390px — fits the phone, swipe flips (and a vertical, short or edge swipe does not), rotation refits',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      await albShot(page, 'entry-with-done-390');
      w.ctl.hold = { allow: 24, seen: 0 };
      await page.tap('#albumPreviewBtn');
      await page.waitForFunction(() => /24\s*\/\s*36/.test(document.getElementById('albumProgress')?.textContent || ''), null, { timeout: 15000 });
      await page.waitForTimeout(400);
      await albShot(page, 'progress-390');
      w.release();
      await albReady(page);
      await albShot(page, 'cover-390');
      const geo = async () => page.evaluate(() => {
        const v = document.getElementById('albumViewer'), vr = v.getBoundingClientRect();
        const cur = v.querySelector('.album-slide[data-current="true"] .album-page').getBoundingClientRect();
        const bar = v.querySelector('.album-viewer-bar').getBoundingClientRect(), foot = v.querySelector('.album-viewer-foot').getBoundingClientRect();
        const btn = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height, r.left, r.right]; };
        // REWRITTEN for fit: 'contain' (was: the photo covers the frame): the photo is whole inside its frame and touches it on one side
        const covered = [...v.querySelectorAll('.album-slide[data-current="true"] .album-slot')].every(s => { const im = s.querySelector('img'); const a = s.getBoundingClientRect(), b = im.getBoundingClientRect();
          return b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1 && (Math.abs(b.width - a.width) <= 1 || Math.abs(b.height - a.height) <= 1); });
        return { vr: [vr.left, vr.top, vr.right, vr.bottom], page: [cur.left, cur.top, cur.width, cur.height], barB: bar.bottom, footT: foot.top, footB: foot.bottom,
          iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, vsw: v.scrollWidth, btns: ['albumPrev', 'albumNext', 'albumClose'].map(btn), covered };
      });
      const g = await geo();
      ok('the viewer is exactly the window, nothing scrolls sideways', g.vr[0] === 0 && g.vr[2] === g.iw && g.vr[3] === g.ih && g.sw <= g.iw && g.vsw <= g.iw, JSON.stringify(g));
      ok('the cover is one A4 portrait page (0.7071), centred, inside the window with a side gutter', Math.abs(g.page[2] / g.page[3] - 210 / 297) < 0.01 && g.page[0] >= 8 && g.page[0] + g.page[2] <= g.iw - 8 && Math.abs(g.page[0] + g.page[2] / 2 - g.iw / 2) < 2, JSON.stringify(g.page));
      ok('the page sits between the bar and the footer; the footer ends inside the window (the bottom bar of a browser cannot cover it: dvh)', g.page[1] >= g.barB - 0.5 && g.page[1] + g.page[3] <= g.footT + 0.5 && g.footB <= g.ih + 0.5, JSON.stringify(g));
      ok('every control is at least 44px', g.btns.every(b => b[0] >= 44 && b[1] >= 44 && b[2] >= 0 && b[3] <= g.iw), JSON.stringify(g.btns));
      ok('the photo sits whole in its frame (contain)', g.covered);

      const cur = async () => (await albSnap(page)).label;
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      ok('swipe left (finger moves left) goes to the next page', (await cur()).startsWith('1 /'), await cur());
      await page.waitForTimeout(350);
      await albShot(page, 'page-1-390');
      const gs = await geo();
      ok('a spread on a 390px phone is the whole width and about 390 x 276 (A4 pages side by side, 1.4142)', gs.page[2] >= 388 && gs.page[2] <= 390.5 && Math.abs(gs.page[2] / gs.page[3] - 420 / 297) < 0.01 && Math.abs(gs.page[3] - 276) <= 2, JSON.stringify(gs.page));
      ok('...between the bar and the footer, no sideways scroll, photos sit whole in their frames', gs.page[1] >= gs.barB - 0.5 && gs.page[1] + gs.page[3] <= gs.footT + 0.5 && gs.sw <= gs.iw && gs.covered, JSON.stringify(gs));
      await swipeTouch(page, '#albumStage', 100, 400, 300, 400);
      ok('swipe right goes back, to the cover', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 100, 400, 300, 400);
      ok('swipe right on the cover stays on the cover', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 200, 300, 200, 650);
      await swipeTouch(page, '#albumStage', 200, 650, 200, 250);
      ok('a vertical swipe does not flip', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 200, 300, 235, 330);
      ok('a short, mostly vertical drift does not flip', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 200, 400, 170, 400);
      ok('a swipe shorter than the threshold does not flip', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 8, 400, 3, 400, 4);
      await swipeTouch(page, '#albumStage', 8, 400, 200, 400);
      await swipeTouch(page, '#albumStage', 382, 400, 150, 400);
      ok('a swipe that starts at the screen edge (the browser\'s own back gesture) is left alone', (await cur()) === '封面');
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      ok('two swipes, two pages', (await cur()).startsWith('2 /'), await cur());
      await page.waitForTimeout(350);
      await albShot(page, 'page-2-390');
      // a finger really on the screen: hit-tested, through the browser
      const rt = await realTouch(page);
      await rt.drag(300, 420, 90, 425);
      ok('a real touch drag (CDP) flips too', (await cur()).startsWith('3 /'), await cur());
      await rt.drag(90, 420, 300, 425);
      ok('and back', (await cur()).startsWith('2 /'), await cur());
      // the buttons by tap
      await page.tap('#albumNext');
      ok('tapping 下一頁 flips', (await cur()).startsWith('3 /'));

      // rotate: the crop is re-fitted to the new frame
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(400);
      const land = await geo();
      ok('landscape phone: viewer fills the window, the spread keeps its 1.4142 shape and fits between bar and footer, photos still sit whole in their frames',
        land.vr[2] === land.iw && land.vr[3] === land.ih && Math.abs(land.page[2] / land.page[3] - 420 / 297) < 0.01 && land.page[1] >= land.barB - 0.5 && land.page[1] + land.page[3] <= land.footT + 0.5 && land.covered && land.sw <= land.iw && land.page[3] >= 240, JSON.stringify(land));
      await albShot(page, 'landscape-390');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      const port = await geo();
      ok('and back to portrait: the spread is the whole width again', port.vr[2] === port.iw && port.covered && port.page[2] <= port.iw + 0.5 && port.page[2] >= port.iw - 2 && Math.abs(port.page[2] / port.page[3] - 420 / 297) < 0.01, JSON.stringify(port));
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: MOBILE });
}

// ── 6. hostile names are never markup, and the crop geometry is the one layouts.js draws
{
  const evil = ['shoot/精修/<img src=x onerror="window.__xss=1">.jpg', 'shoot/精修/a"onload="window.__xss=2.jpg', "shoot/精修/b'><svg onload=window.__xss=3>.jpg"];
  const files = [...evil, ...albKeys(9)];
  const w = albumWorld({ files });
  await suite('album preview — a file name that is HTML stays text: no element, no handler, no script',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      await page.click('#albumPreviewBtn');
      await albReady(page);
      const ids = [];
      for (let i = 0; i < 30; i++) {
        const s = await albSnap(page);
        ids.push(...albCur(s).ids);
        if (s.nextDis) break;
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(n => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === String(n), i + 1, { timeout: 4000 });
      }
      ok('control: the hostile-named photos really are in the album', evil.some(k => ids.includes(k)), `${ids.length} shown`);
      const r = await page.evaluate(() => ({ xss: window.__xss ?? null, strayImg: !!document.querySelector('#albumViewer img[src="x"]'),
        onerr: [...document.querySelectorAll('#albumViewer *')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
        scripts: document.querySelectorAll('#albumViewer script').length,
        imgsOk: [...document.querySelectorAll('#albumViewer img')].every(i => i.src.startsWith('https://imagepicker.hotichen.workers.dev/')),
        text: document.getElementById('albumViewer').textContent }));
      ok('no handler ran, no stray <img src=x>, no script element, no on* attribute', r.xss === null && !r.strayImg && r.onerr === 0 && r.scripts === 0, JSON.stringify(r));
      ok('every <img> points at the Worker', r.imgsOk);
      ok('no file name is printed in the viewer at all', !/IMG_0|onerror|精修/.test(r.text), r.text);
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
}
