// Browser suites: album preview: spreads, contain / cover fit, zoom, hints, back cover.
// Registered by test/run.mjs in file-name order; see test/README.md.
import zlib from 'node:zlib';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, doubleTapTouch, pinchTouch, realTouch, swipeTouch, tapTouch } from '../lib/env.mjs';
import { ALB_DESK, ALB_OWNER, ALB_VIEWER, albGalleryReady, albPending, albReady, albShot, albSnap, albumWorld } from '../lib/album-world.mjs';

export default async function register() {

// ── 7. the A4 album: a single-page cover, spreads of two A4 pages, at most four photos a page,
//      only a through-spread crosses the fold — measured on real pixels, desktop and phone
const albGoTo = async (page, label) => {
  for (let i = 0; i < 80; i++) {
    if ((await albSnap(page)).label === label) return true;
    const s = await albSnap(page);
    if (s.nextDis) return false;
    await page.click('#albumNext');
    await page.waitForTimeout(30);
  }
  return false;
};
// what the current page looks like: its box, every slot as 0..1 fractions of it, the template it claims
const albPageGeo = page => page.evaluate(() => {
  const cur = document.querySelector('.album-slide[data-current="true"] .album-page');
  const pr = cur.getBoundingClientRect();
  const slots = [...cur.querySelectorAll('.album-slot')].map(b => {
    const r = b.getBoundingClientRect();
    return { l: (r.left - pr.left) / pr.width, r: (r.right - pr.left) / pr.width, t: (r.top - pr.top) / pr.height, b: (r.bottom - pr.top) / pr.height, w: r.width, h: r.height,
      img: !!b.querySelector('img') };
  });
  const tpl = typeof SpreadTemplates !== 'undefined' ? SpreadTemplates.byId(cur.dataset.layout) : null;
  return { kind: cur.dataset.kind, layout: cur.dataset.layout, w: pr.width, h: pr.height, slots,
    hero: !!tpl && tpl.tags.includes('hero'), tplSlots: tpl ? tpl.slots.length : null,
    foldAfter: getComputedStyle(cur, '::after').content, label: document.getElementById('albumLabel').textContent };
});
for (const [label, co, init] of [['desktop 1280', ALB_DESK, ALB_OWNER], ['phone 390', MOBILE, ALB_VIEWER]]) {
  const w = albumWorld({ n: 44, dup: { 4: 3 } });
  await suite(`album preview spreads ${label} — A4 cover page, 1.4142 spreads, at most 4 photos a page, only a hero crosses the fold`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      if (label.startsWith('phone')) await page.tap('#albumPreviewBtn'); else await page.click('#albumPreviewBtn');
      await albReady(page);
      const geos = [];
      let guard = 0;
      for (;;) {
        await page.waitForTimeout(40);
        geos.push(await albPageGeo(page));
        if ((await albSnap(page)).nextDis || guard++ > 60) break;
        await page.click('#albumNext');
        await page.waitForFunction(n => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === String(n), geos.length, { timeout: 4000 });
        await page.waitForTimeout(280);
      }
      const cover = geos[0], spreads = geos.slice(1);
      ok('control: a real book — a cover and at least 6 spreads', cover.kind === 'cover' && spreads.length >= 6 && spreads.every(g => g.kind === 'spread'), `${spreads.length} spreads`);
      ok('the cover is one A4 portrait page with exactly one photo, and no fold', Math.abs(cover.w / cover.h - 210 / 297) < 0.008 && cover.slots.length === 1 && cover.slots[0].img && cover.foldAfter === 'none', JSON.stringify([cover.w, cover.h, cover.slots.length, cover.foldAfter]));
      ok('every spread is two A4 pages side by side (420 : 297 = 1.4142)', spreads.every(g => Math.abs(g.w / g.h - 420 / 297) < 0.01), JSON.stringify(spreads.map(g => +(g.w / g.h).toFixed(3))));
      ok('and a spread shows the fold (the shade down its middle)', spreads.every(g => g.foldAfter !== 'none'), spreads.map(g => g.foldAfter).join());
      ok('every slot of a spread carries a photo and matches its template (the count, not just the shape)', spreads.every(g => g.tplSlots === g.slots.length && g.slots.every(s => s.img)), JSON.stringify(spreads.map(g => [g.layout, g.tplSlots, g.slots.length])));
      const eps = 0.004;
      const face = g => ({ left: g.slots.filter(s => s.r <= 0.5 + eps).length, right: g.slots.filter(s => s.l >= 0.5 - eps).length, span: g.slots.filter(s => s.l < 0.5 - eps && s.r > 0.5 + eps).length });
      ok('at most 4 photos on each page of every spread', spreads.every(g => { const f = face(g); return f.left <= 4 && f.right <= 4; }), JSON.stringify(spreads.map(g => face(g))));
      ok('control: the counting is real — some page holds 3 or more photos and some spread holds 5 or more', spreads.some(g => { const f = face(g); return f.left >= 3 || f.right >= 3; }) && Math.max(...spreads.map(g => g.slots.length)) >= 5, JSON.stringify(spreads.map(g => g.slots.length)));
      ok('only a through-spread (hero template) has a photo across the fold, and it has just one', spreads.every(g => { const f = face(g); return f.span === 0 || (g.hero && f.span === 1); }), JSON.stringify(spreads.map(g => [g.layout, g.hero, face(g).span])));
      ok('every photo is on one page or the other, or across the fold: nothing is cut by it', spreads.every(g => { const f = face(g); return f.left + f.right + f.span === g.slots.length; }));
      const overlap = spreads.filter(g => g.slots.some((a, i) => g.slots.some((b, j) => j > i && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.003 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.003)));
      ok('no two photos overlap, and none leaves the page', overlap.length === 0 && spreads.every(g => g.slots.every(s => s.l >= -0.002 && s.r <= 1.002 && s.t >= -0.002 && s.b <= 1.002)), overlap.map(g => g.layout).join());
      ok('no slot is under 25 mm at A4 (420 mm across the spread): the shapes stay legible', spreads.every(g => g.slots.every(s => (s.r - s.l) * 420 >= 24.5 && (s.b - s.t) * 297 >= 24.5)));
      ok('variety on screen: at least 6 different templates in the book', new Set(spreads.map(g => g.layout)).size >= 6, JSON.stringify(spreads.map(g => g.layout)));
      ok('never the same template on two spreads running', spreads.every((g, i) => i === 0 || g.layout !== spreads[i - 1].layout));
      const phone = label.startsWith('phone');
      const sp = spreads[1];
      if (phone) ok('on a 390px phone a spread is the whole width and about 390 x 276', sp.w >= 388 && sp.w <= 390.5 && Math.abs(sp.h - 276) <= 2, `${sp.w}x${sp.h}`);
      else ok('on a desktop the spread is large (over 900px wide) and inside the window', sp.w > 900 && sp.w <= 1280 - 40, `${sp.w}`);
      const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      ok('no sideways scroll', sw.sw <= sw.iw, JSON.stringify(sw));
      await albGoTo(page, '2 / ' + spreads.length);
      await page.waitForTimeout(350);
      await albShot(page, `spread-${label.replace(' ', '-')}`);
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 7b. fit: 'contain' (the default): every photo whole — never cropped, never stretched, centred in its frame.
//      Real pictures of six different shapes; every <img>'s box is measured against its frame and its natural size,
//      and pixels of a screenshot show the bare paper beside a picture (a cropped or stretched photo would not leave any).
const ALB_CONTAIN_SHAPES = [[900, 600], [600, 900], [600, 750], [600, 600], [960, 540], [540, 960], [900, 600], [600, 900], [800, 600], [600, 800]];
// a PNG screenshot -> { w, h, px(x, y) -> [r, g, b] } (8-bit, non-interlaced, any colour type Chromium writes). The page cannot read
// its own rendered pixels (no canvas of the DOM), and nothing else in this file decodes a PNG (pngOf only writes one), so it is here.
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, px: (x, y) => { const o = y * stride + x * bpp; return ct === 0 ? [out[o], out[o], out[o]] : [out[o], out[o + 1], out[o + 2]]; } };
}
// what the current page looks like: for every slot its frame, the picture's own box, its natural size, whether any
// ancestor that clips (overflow other than visible) cuts into the picture
const albFitGeo = page => page.evaluate(() => {
  const cur = document.querySelector('.album-slide[data-current="true"] .album-page');
  const pr = cur.getBoundingClientRect();
  return [...cur.querySelectorAll('.album-slot')].map(b => {
    const im = b.querySelector('img'), a = b.getBoundingClientRect(), r = im.getBoundingClientRect(), cs = getComputedStyle(im);
    let clipped = false;
    for (let e = im.parentElement; e && e !== cur.parentElement; e = e.parentElement) {
      if (getComputedStyle(e).overflow === 'visible') continue;
      const q = e.getBoundingClientRect();
      if (r.left < q.left - 0.75 || r.right > q.right + 0.75 || r.top < q.top - 0.75 || r.bottom > q.bottom + 0.75) clipped = true;
    }
    return { fl: a.left, ft: a.top, fw: a.width, fh: a.height, il: r.left, it: r.top, iw: r.width, ih: r.height,
      nw: im.naturalWidth, nh: im.naturalHeight, fit: b.dataset.fit ?? null, imgFit: cs.objectFit, bg: getComputedStyle(b).backgroundColor,
      clipped, loaded: im.complete && im.naturalWidth > 0, page: { l: pr.left, t: pr.top, w: pr.width, h: pr.height }, kind: cur.dataset.kind };
  });
});
const albPhotosReady = page => page.waitForFunction(() => {
  const ims = [...document.querySelectorAll('.album-slide[data-current="true"] img')];
  return ims.length > 0 && ims.every(im => im.complete && im.naturalWidth > 0 && /px$/.test(im.style.width));
}, null, { timeout: 8000 });
// every page of the book, each as albFitGeo's list; cover first
async function albWalkFit(page, phone, tag) {
  const pages = [];
  for (let guard = 0; guard < 40; guard++) {
    await albPhotosReady(page);
    await page.waitForTimeout(60);
    pages.push(await albFitGeo(page));
    if (tag && pages.length <= 5) await albShot(page, `${tag}-p${pages.length - 1}`);       // SHOTS_ALBUM=<dir>: the cover and four spreads
    if ((await albSnap(page)).nextDis) break;
    if (phone) await page.tap('#albumNext'); else await page.click('#albumNext');
    await page.waitForFunction(n => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === String(n), pages.length, { timeout: 4000 });
    await page.waitForTimeout(280);
  }
  return pages;
}
for (const [label, co, init, phone] of [['desktop 1280', ALB_DESK, ALB_OWNER, false], ['phone 390', MOBILE, ALB_VIEWER, true]]) {
  const w = albumWorld({ n: 40, shapes: ALB_CONTAIN_SHAPES });
  await suite(`album preview contain ${label} — every photo whole in its frame: not cropped, not stretched, centred, nothing clips it`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);
      if (phone) await page.tap('#albumPreviewBtn'); else await page.click('#albumPreviewBtn');
      await albReady(page);
      const pages = await albWalkFit(page, phone, `contain-${label.replace(' ', '-')}`);
      const slots = pages.flat();
      const spreads = pages.slice(1);
      ok('control: a real book — a cover, at least 7 spreads, at least 38 photos measured', pages[0][0].kind === 'cover' && pages[0].length === 1 && spreads.length >= 7 && slots.length >= 38, `${spreads.length} spreads, ${slots.length} slots`);
      ok('every photo is loaded', slots.every(s => s.loaded));
      ok('every frame and picture says contain (data-fit and object-fit), none cover', slots.every(s => s.fit === 'contain' && s.imgFit === 'contain'), JSON.stringify(slots.filter(s => s.fit !== 'contain' || s.imgFit !== 'contain').slice(0, 2)));
      const T = 1;       // px of slack (sub-pixel layout, rounded device pixels)
      const bad = f => slots.filter(s => !f(s)).slice(0, 2).map(s => JSON.stringify({ f: [s.fw, s.fh], i: [s.iw, s.ih], n: [s.nw, s.nh] })).join(' | ');
      ok('the whole photo is inside its frame, on all four sides (nothing cropped)', slots.every(s => s.il >= s.fl - T && s.it >= s.ft - T && s.il + s.iw <= s.fl + s.fw + T && s.it + s.ih <= s.ft + s.fh + T), bad(s => s.il >= s.fl - T && s.it >= s.ft - T && s.il + s.iw <= s.fl + s.fw + T && s.it + s.ih <= s.ft + s.fh + T));
      ok('the picture\'s shown ratio is its own naturalWidth / naturalHeight within 0.5% (not stretched, not squeezed)', slots.every(s => Math.abs((s.iw / s.ih) / (s.nw / s.nh) - 1) <= 0.005), bad(s => Math.abs((s.iw / s.ih) / (s.nw / s.nh) - 1) <= 0.005));
      ok('it is centred in its frame (within 1px on both axes)', slots.every(s => Math.abs(s.il + s.iw / 2 - (s.fl + s.fw / 2)) <= T && Math.abs(s.it + s.ih / 2 - (s.ft + s.fh / 2)) <= T), bad(s => Math.abs(s.il + s.iw / 2 - (s.fl + s.fw / 2)) <= T));
      ok('and as big as the frame allows: it touches the frame on one axis (no needless margin)', slots.every(s => Math.abs(s.iw - s.fw) <= T || Math.abs(s.ih - s.fh) <= T), bad(s => Math.abs(s.iw - s.fw) <= T || Math.abs(s.ih - s.fh) <= T));
      ok('no ancestor that clips (overflow) cuts into a picture', slots.every(s => !s.clipped));
      const shapes = new Set(slots.map(s => (s.nw / s.nh).toFixed(2)));
      ok('control: the test really saw six different shapes (3:2, 2:3, 4:5, 1:1, 16:9, 9:16 and more)', shapes.size >= 6, [...shapes].join());
      ok('control: some picture leaves bare paper at the sides AND some above / below (so "touches on one axis" is not vacuous)',
        slots.some(s => s.fw - s.iw >= 4) && slots.some(s => s.fh - s.ih >= 4), JSON.stringify(slots.slice(0, 3).map(s => [s.fw, s.fh, s.iw, s.ih])));
      const waste = 1 - slots.reduce((a, s) => a + s.iw * s.ih, 0) / slots.reduce((a, s) => a + s.fw * s.fh, 0);
      ok('on screen the bare paper is under 20% of the slot area, over the whole book (the planner picks shapes that fit)', waste < 0.2, waste.toFixed(3));
      ok('the paper is white and the frames add no colour of their own (transparent behind a whole photo)', slots.every(s => s.bg === 'rgba(0, 0, 0, 0)') &&
        await page.evaluate(() => getComputedStyle(document.querySelector('.album-slide[data-current="true"] .album-page')).backgroundColor === 'rgb(255, 255, 255)'), slots[0].bg);
      const cover = pages[0][0];
      ok('the cover is a portrait photo, whole on the A4 page (a portrait fits the tall page: the strip of a landscape is avoided)', cover.nw < cover.nh && (Math.abs(cover.iw - cover.fw) <= T + 1 || Math.abs(cover.ih - cover.fh) <= T + 1), JSON.stringify(cover));
      ok('the cover wastes under 25% of its page', 1 - (cover.iw * cover.ih) / (cover.fw * cover.fh) <= 0.25, JSON.stringify(cover));

      // real pixels: beside a picture there is paper, right inside its edge there is picture
      let probes = 0; const pixelBad = [];
      const goTo = async n => {            // to spread n, whichever way it lies
        for (let g = 0; g < 60; g++) {
          const label = (await albSnap(page)).label, at = label === '封面' ? 0 : +label.split('/')[0];
          if (at === n) return;
          if (phone) await page.tap(at < n ? '#albumNext' : '#albumPrev'); else await page.click(at < n ? '#albumNext' : '#albumPrev');
          await page.waitForTimeout(60);
        }
      };
      for (let i = 1; i < pages.length && probes < 3; i++) {
        await goTo(i);
        await page.waitForTimeout(350);
        await albPhotosReady(page);
        const sp = await albFitGeo(page);
        const cand = sp.map(s => ({ s, mx: Math.max(s.fw - s.iw, s.fh - s.ih) })).filter(c => c.mx >= 8).sort((a, b) => b.mx - a.mx)[0];
        if (!cand) continue;
        const s = cand.s, horiz = s.fw - s.iw >= s.fh - s.ih;       // bare bands left / right, else above / below
        const fold = s.page.l + s.page.w / 2;
        const pt = horiz ? [s.fl + (s.il - s.fl) / 2, s.it + s.ih * 0.3, s.il + 3, s.it + s.ih * 0.3] : [s.il + s.iw * 0.3, s.ft + (s.it - s.ft) / 2, s.il + s.iw * 0.3, s.it + 3];
        if (Math.abs(pt[0] - fold) < s.page.w * 0.06 || Math.abs(pt[2] - fold) < s.page.w * 0.06) continue;     // the fold's shade darkens paper
        const shot = decodePng(await page.screenshot({ scale: 'css' }));
        const paper = shot.px(Math.round(pt[0]), Math.round(pt[1])), inside = shot.px(Math.round(pt[2]), Math.round(pt[3]));
        probes++;
        if (!(Math.min(...paper) >= 205)) pixelBad.push(`paper beside ${s.nw}x${s.nh} is ${paper}`);
        if (!(Math.min(...inside) < 200)) pixelBad.push(`edge of ${s.nw}x${s.nh} is ${inside}`);
      }
      ok('pixels: the bare band beside a picture is paper (light), the pixel just inside its edge is picture (colour) — on 3 spreads', probes === 3 && pixelBad.length === 0, `${probes} probes: ${pixelBad.join(' ; ')}`);
      await albShot(page, `contain-${label.replace(' ', '-')}`);
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 7c. fit: 'cover' stays available (PLAN_OPTS.fit): the old crop-to-fill drawing, the switch back
for (const [label, co, init, phone] of [['desktop 1280', ALB_DESK, ALB_OWNER, false], ['phone 390', MOBILE, ALB_VIEWER, true]]) {
  const w = albumWorld({ n: 40, shapes: ALB_CONTAIN_SHAPES });
  await suite(`album preview cover mode ${label} (PLAN_OPTS.fit = 'cover') — the old drawing: photos fill their frames, cropped`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);
      await page.evaluate(() => { AlbumPreview.PLAN_OPTS = { fit: 'cover' }; });
      if (phone) await page.tap('#albumPreviewBtn'); else await page.click('#albumPreviewBtn');
      await albReady(page);
      const pages = await albWalkFit(page, phone, `cover-${label.replace(' ', '-')}`);
      const slots = pages.flat(), T = 1;
      ok('control: a real book', pages.length >= 8 && slots.length >= 38, `${pages.length} pages`);
      ok('no frame says contain, every picture is object-fit: cover', slots.every(s => s.fit !== 'contain' && s.imgFit === 'cover'), JSON.stringify(slots.slice(0, 2)));
      ok('every picture covers its frame (no gap on any side)', slots.every(s => s.il <= s.fl + T && s.it <= s.ft + T && s.il + s.iw >= s.fl + s.fw - T && s.it + s.ih >= s.ft + s.fh - T));
      ok('and some picture is cut by its frame (shown box wider or taller than the frame, ratio not the photo\'s) — the crop is real', slots.some(s => s.iw > s.fw + 2 || s.ih > s.fh + 2) && slots.some(s => Math.abs((s.iw / s.ih) / (s.nw / s.nh) - 1) <= 0.005 && (s.iw > s.fw + 2 || s.ih > s.fh + 2)));
      ok('the frames keep the old paper-coloured ground (#ece8de)', slots.every(s => s.bg === 'rgb(236, 232, 222)'), slots[0].bg);
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 8. zoom on a phone: double tap, pinch, pan, and the swipe that must not flip while zoomed
const albZ = page => page.evaluate(() => {
  const st = document.getElementById('albumStage');
  const pg = document.querySelector('.album-slide[data-current="true"] .album-page');
  const m = new DOMMatrix(getComputedStyle(pg).transform);
  const r = pg.getBoundingClientRect(), sr = st.getBoundingClientRect();
  return { s: m.a, x: m.e, y: m.f, attr: st.dataset.zoom ?? null, label: document.getElementById('albumLabel')?.textContent ?? '',
    page: { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }, stage: { l: sr.left, r: sr.right, t: sr.top, b: sr.bottom, w: sr.width, h: sr.height },
    touchAction: getComputedStyle(st).touchAction, scrollY: window.scrollY, scrollX: window.scrollX, docScroll: document.documentElement.scrollTop };
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;
{
  const w = albumWorld({ n: 40 });
  await suite('album preview zoom 390px — double tap 2.5x and back, pinch 1x-4x, pan inside the edges, no flip while zoomed, flip again after',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      const logStart = w.log.length;
      await page.tap('#albumPreviewBtn');
      await albReady(page);
      await page.tap('#albumNext');
      await page.waitForFunction(() => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === '1', null, { timeout: 4000 });
      await page.waitForTimeout(350);
      const z0 = await albZ(page);
      const lab = z0.label;
      ok('start: a spread at 1x, nothing moved, the stage takes the touches itself (touch-action none)', z0.s === 1 && near(z0.x, 0, 0.5) && near(z0.y, 0, 0.5) && z0.touchAction === 'none' && z0.attr === '1.00', JSON.stringify(z0));
      ok('control: this is a spread of 390 px (the whole width)', z0.page.w >= 388, JSON.stringify(z0.page));

      // double tap off-centre: 2.5x, and the spot you tapped stays under the finger
      const tapX = z0.stage.l + z0.stage.w / 2 + 70, tapY = z0.stage.t + z0.stage.h / 2 - 20;
      const u = (tapX - z0.page.l) / z0.page.w, v = (tapY - z0.page.t) / z0.page.h;
      await doubleTapTouch(page, '#albumStage', tapX, tapY, 100);
      await page.waitForTimeout(450);
      const z1 = await albZ(page);
      ok('a double tap zooms to 2.5x', near(z1.s, 2.5, 0.02) && z1.attr === '2.50', JSON.stringify([z1.s, z1.attr]));
      // (the 再次編排 row made the stage shorter: the 2.5x spread, about 690px, is now only slightly taller than it, and the pan is then
      // clamped to the edges instead of following the finger, so a page less than 40px taller only has to cover the stage)
      // sideways the page is wider than the window, so the tapped spot can stay put; vertically the 2.5x
      // spread (about 690px) is still shorter than the stage, so it stays centred rather than leaving a gap
      ok('the tapped spot is still under the finger (sideways), and the page stays centred up and down while it is shorter than the window',
        near(z1.page.l + u * z1.page.w, tapX, 3) && (z1.page.h > z1.stage.h + 40 ? near(z1.page.t + v * z1.page.h, tapY, 3) : z1.page.h > z1.stage.h + 1 ? (z1.page.t <= z1.stage.t + 0.6 && z1.page.b >= z1.stage.b - 0.6) : near((z1.page.t + z1.page.b) / 2, (z1.stage.t + z1.stage.b) / 2, 1)), JSON.stringify([z1.page, z1.stage, u, v, tapX, tapY]));
      ok('the page is bigger than the window now, and the label did not change (no flip)', z1.page.w > z1.stage.w * 2 && z1.label === lab, JSON.stringify([z1.page.w, z1.label, lab]));
      ok('control: the zoomed page still covers the window (no blank edge) on the sides it is wider than', z1.page.l <= z1.stage.l + 0.6 && z1.page.r >= z1.stage.r - 0.6, JSON.stringify([z1.page, z1.stage]));
      await albShot(page, 'zoom-2.5-390');

      // a swipe while zoomed pans, never flips
      await swipeTouch(page, '#albumStage', 300, 400, 180, 400);
      await page.waitForTimeout(100);
      const z2 = await albZ(page);
      ok('a swipe while zoomed does not flip the page', z2.label === lab, z2.label);
      ok('...it moves the picture by about the finger (120px left)', z2.x < z1.x - 90 && z2.x > z1.x - 130, JSON.stringify([z1.x, z2.x]));
      await swipeTouch(page, '#albumStage', 180, 400, 330, 430);
      const z3 = await albZ(page);
      ok('...and back (150px right, 30px down: the picture follows, still inside its edges)', z3.label === lab && z3.x > z2.x + 100 && z3.page.l <= z3.stage.l + 0.6, JSON.stringify([z2.x, z3.x]));
      for (let i = 0; i < 6; i++) await swipeTouch(page, '#albumStage', 40, 400, 360, 400);
      const zl = await albZ(page);
      ok('dragged far right: stops with the left edge of the page at the window edge, no blank beyond', near(zl.page.l, zl.stage.l, 0.8) && zl.label === lab, JSON.stringify([zl.page, zl.stage, zl.label]));
      for (let i = 0; i < 8; i++) await swipeTouch(page, '#albumStage', 360, 400, 40, 400);
      const zr = await albZ(page);
      ok('dragged far left: stops with the right edge at the window edge', near(zr.page.r, zr.stage.r, 0.8) && zr.label === lab, JSON.stringify([zr.page, zr.stage]));
      ok('control: the two stops are really different places (the page is bigger than the window)', zr.x < zl.x - 300, JSON.stringify([zl.x, zr.x]));
      // a touch at the screen edge (the browser's back gesture) is left alone, zoomed or not
      // (checked one at a time: the page sits at its left limit here, so a drag from the left edge moves it
      // and a drag from the right edge would move it straight back — together they would cancel out)
      await swipeTouch(page, '#albumStage', 6, 400, 200, 400);
      const ze1 = await albZ(page);
      ok('a drag that starts at the left screen edge is ignored while zoomed too', near(ze1.x, zr.x, 0.5) && ze1.label === lab, JSON.stringify([zr.x, ze1.x]));
      await swipeTouch(page, '#albumStage', 40, 400, 360, 400);        // positive control: from inside the edge it does pan
      const zc = await albZ(page);
      ok('control: the same drag from inside the edge does pan', zc.x > zr.x + 100, JSON.stringify([zr.x, zc.x]));
      await swipeTouch(page, '#albumStage', 384, 400, 150, 400);
      const ze2 = await albZ(page);
      ok('a drag that starts at the right screen edge is ignored too', near(ze2.x, zc.x, 0.5) && ze2.label === lab, JSON.stringify([zc.x, ze2.x]));
      const sc = await albZ(page);
      ok('the page behind never scrolled (not at any point: same position as when the viewer opened)', sc.scrollY === z0.scrollY && sc.scrollX === z0.scrollX && sc.docScroll === z0.docScroll);

      // double tap again: back to 1x, centred
      await doubleTapTouch(page, '#albumStage', 200, 380, 100);
      await page.waitForTimeout(450);
      const z4 = await albZ(page);
      ok('a second double tap restores 1x, centred', z4.s === 1 && near(z4.x, 0, 0.5) && near(z4.y, 0, 0.5) && z4.attr === '1.00', JSON.stringify([z4.s, z4.x, z4.y, z4.attr]));
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      await page.waitForTimeout(350);
      ok('and the swipe flips again once back at 1x', (await albZ(page)).label !== lab, (await albZ(page)).label);

      // slow or far apart taps are not a double tap (positive control above: 100 ms did zoom)
      const lab2 = (await albZ(page)).label;
      await doubleTapTouch(page, '#albumStage', 200, 380, 600);
      await page.waitForTimeout(300);
      ok('two taps 600 ms apart do not zoom', (await albZ(page)).s === 1);
      await tapTouch(page, '#albumStage', 100, 300);
      await page.waitForTimeout(100);
      await tapTouch(page, '#albumStage', 300, 500);
      await page.waitForTimeout(300);
      ok('two taps far apart do not zoom', (await albZ(page)).s === 1);
      await tapTouch(page, '#albumStage', 200, 400);
      await page.waitForTimeout(300);
      ok('a single tap does not zoom, and does not flip', (await albZ(page)).s === 1 && (await albZ(page)).label === lab2);

      // pinch
      await pinchTouch(page, '#albumStage', 195, 400, 80, 240);
      await page.waitForTimeout(150);
      const p1 = await albZ(page);
      ok('pinching out 3x zooms to 3x (and does not flip)', near(p1.s, 3, 0.03) && p1.label === lab2, JSON.stringify([p1.s, p1.label]));
      await pinchTouch(page, '#albumStage', 195, 400, 100, 700);
      const p2 = await albZ(page);
      ok('pinching further stops at 4x', near(p2.s, 4, 0.01), String(p2.s));
      ok('...and the page still covers the window', p2.page.l <= p2.stage.l + 0.8 && p2.page.r >= p2.stage.r - 0.8, JSON.stringify([p2.page, p2.stage]));
      await pinchTouch(page, '#albumStage', 195, 400, 300, 150);
      const p3 = await albZ(page);
      ok('pinching in lowers it (4x -> 2x) and is anchored, not jumping off the page', near(p3.s, 2, 0.05) && p3.page.l <= p3.stage.l + 0.8, JSON.stringify([p3.s, p3.page]));
      await pinchTouch(page, '#albumStage', 195, 400, 300, 20);
      const p4 = await albZ(page);
      ok('pinching in past 1x lands on exactly 1x and recentres', p4.s === 1 && near(p4.x, 0, 0.5) && near(p4.y, 0, 0.5), JSON.stringify([p4.s, p4.x, p4.y]));
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      await page.waitForTimeout(350);
      ok('after a pinch back to 1x the swipe flips', (await albZ(page)).label !== lab2);

      // flipping by the buttons while zoomed lands on a page at 1x
      await doubleTapTouch(page, '#albumStage', 200, 380, 100);
      await page.waitForTimeout(450);
      ok('zoomed again', near((await albZ(page)).s, 2.5, 0.02));
      const lab3 = (await albZ(page)).label;
      await page.tap('#albumNext');
      await page.waitForTimeout(350);
      const nx = await albZ(page);
      ok('下一頁 works while zoomed and the next page is at 1x', nx.label !== lab3 && nx.s === 1 && near(nx.x, 0, 0.5), JSON.stringify([lab3, nx.label, nx.s]));

      // only thumbnails, nothing written, however much it was zoomed
      const during = w.log.slice(logStart);
      const reads = during.filter(r => r.key && w.keys.has(r.key));
      ok('every photo read is a thumbnail bucket, zoom asked for nothing else', reads.length > 0 && reads.every(r => ['400', '1200', '1600'].includes(r.w) && r.download === null), JSON.stringify(reads.filter(r => !['400', '1200', '1600'].includes(r.w)).slice(0, 3)));
      ok('no write request', during.every(r => r.method === 'GET'));
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}

// real touches through the browser (CDP): the double tap and the pinch the page really receives
{
  const w = albumWorld({ n: 30 });
  await suite('album preview zoom 390px — real touch (CDP): double tap, drag and pinch work through the browser',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      await page.tap('#albumPreviewBtn');
      await albReady(page);
      await page.tap('#albumNext');
      await page.waitForFunction(() => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === '1', null, { timeout: 4000 });
      await page.waitForTimeout(350);
      const rt = await realTouch(page);
      const lab = (await albZ(page)).label;
      await rt.doubleTap(195, 380);
      await page.waitForTimeout(450);
      const a = await albZ(page);
      ok('a real double tap zooms to 2.5x', near(a.s, 2.5, 0.03), JSON.stringify([a.s, a.label]));
      await rt.drag(300, 420, 200, 420);
      const b = await albZ(page);
      ok('a real drag pans it (no flip, no page scroll)', b.label === lab && b.x < a.x - 60 && b.scrollY === a.scrollY, JSON.stringify([a.x, b.x, b.label, b.scrollY]));
      await rt.doubleTap(200, 380);
      await page.waitForTimeout(450);
      ok('a real double tap restores', (await albZ(page)).s === 1);
      await rt.pinch(195, 400, 80, 240);
      await page.waitForTimeout(200);
      const c = await albZ(page);
      ok('a real two-finger pinch zooms (about 3x) and does not flip', near(c.s, 3, 0.2) && c.label === lab, JSON.stringify([c.s, c.label]));
      await rt.drag(300, 420, 100, 420);
      ok('a real drag at 3x pans, still no flip', (await albZ(page)).label === lab);
      await rt.pinch(195, 400, 300, 20);
      const d = await albZ(page);
      ok('a real pinch in returns to 1x', d.s === 1 && near(d.x, 0, 0.5), JSON.stringify([d.s, d.x]));
      await rt.drag(300, 420, 90, 425);
      await page.waitForTimeout(350);
      ok('and a real swipe flips again', (await albZ(page)).label !== lab);
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}

// ── 9. zoom on a desktop: double click, wheel, mouse drag
{
  const w = albumWorld({ n: 36 });
  await suite('album preview zoom 1280px — double click, wheel and drag; arrow keys and the buttons still flip',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      const aliveStart = await page.evaluate(() => window.__alive.length);
      await page.click('#albumPreviewBtn');
      await albReady(page);
      await page.click('#albumNext');
      await page.waitForFunction(() => document.querySelector('.album-slide[data-current="true"]')?.dataset.index === '1', null, { timeout: 4000 });
      await page.waitForTimeout(350);
      const z0 = await albZ(page);
      const cx = z0.stage.l + z0.stage.w / 2, cy = z0.stage.t + z0.stage.h / 2;
      await page.mouse.dblclick(cx + 120, cy - 30);
      await page.waitForTimeout(450);
      const z1 = await albZ(page);
      ok('a double click zooms to 2.5x about the cursor', near(z1.s, 2.5, 0.02) && z1.attr === '2.50', JSON.stringify([z1.s, z1.attr]));
      const u = (cx + 120 - z0.page.l) / z0.page.w;
      ok('the spot under the cursor stays there', near(z1.page.l + u * z1.page.w, cx + 120, 3), JSON.stringify([u, z1.page, cx]));
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 60, cy - 20, { steps: 5 });
      await page.mouse.move(cx - 160, cy - 40, { steps: 5 });
      await page.mouse.up();
      const z2 = await albZ(page);
      ok('dragging with the mouse pans (about 160px), without flipping', z2.x < z1.x - 120 && z2.label === z1.label, JSON.stringify([z1.x, z2.x]));
      ok('the cursor says it can be dragged while zoomed', await page.evaluate(() => /grab|move/.test(getComputedStyle(document.getElementById('albumStage')).cursor)));
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(450);
      const z3 = await albZ(page);
      ok('a second double click restores 1x, centred', z3.s === 1 && near(z3.x, 0, 0.5) && near(z3.y, 0, 0.5), JSON.stringify([z3.s, z3.x, z3.y]));
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(80);
      const w1 = await albZ(page);
      ok('the wheel zooms in (up) about the cursor', w1.s > 1.4 && w1.s < 4, String(w1.s));
      await page.mouse.wheel(0, -3000);
      await page.waitForTimeout(80);
      ok('and stops at 4x', near((await albZ(page)).s, 4, 0.01));
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(80);
      const w2 = await albZ(page);
      ok('the wheel the other way returns to exactly 1x, centred', w2.s === 1 && near(w2.x, 0, 0.5) && near(w2.y, 0, 0.5), JSON.stringify([w2.s, w2.x, w2.y]));
      // a flip with the keyboard or the buttons from a zoomed page lands on a page at 1x
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(450);
      const lab = (await albZ(page)).label;
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(350);
      const k = await albZ(page);
      ok('→ while zoomed flips one page, and that page is at 1x', k.label !== lab && k.s === 1, JSON.stringify([lab, k.label, k.s]));
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(450);
      await page.click('#albumPrev');
      await page.waitForTimeout(350);
      ok('‹ while zoomed too', (await albZ(page)).s === 1 && (await albZ(page)).label === lab);
      // the cover zooms too
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(350);
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(450);
      const c = await albZ(page);
      ok('the single-page cover zooms and pans the same way', c.label === '封面' && near(c.s, 2.5, 0.02), JSON.stringify([c.label, c.s]));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      const after = await page.evaluate(() => ({ alive: window.__alive.length, focus: document.activeElement?.id }));
      ok('closing from a zoomed page: no listener left on window / document, focus back on the entry', after.alive === aliveStart && after.focus === 'albumPreviewBtn', JSON.stringify([after, aliveStart]));
      await page.click('#albumPreviewBtn');
      await albReady(page);
      ok('opening again starts at the cover, 1x', (await albZ(page)).label === '封面' && (await albZ(page)).s === 1);
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 10. the hint: phone width only, fades by itself or at the first touch, leaves no timer behind
{
  const w = albumWorld({ n: 20 });
  await suite('album preview hint 390px — one line 雙擊放大・橫放手機看更大, fades by itself; the first touch also clears it; no timer left',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      const timerStart = await page.evaluate(() => window.__timerSeq());
      await page.tap('#albumPreviewBtn');
      await albReady(page);
      const h = await page.evaluate(() => { const e = document.getElementById('albumHint'); if (!e) return null; const r = e.getBoundingClientRect(), s = document.getElementById('albumStage').getBoundingClientRect();
        return { text: e.textContent, op: parseFloat(getComputedStyle(e).opacity), inside: r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom, w: r.width, h: r.height, lines: Math.round((r.height - parseFloat(getComputedStyle(e).paddingTop) - parseFloat(getComputedStyle(e).paddingBottom)) / parseFloat(getComputedStyle(e).lineHeight)), pe: getComputedStyle(e).pointerEvents }; });
      ok('the hint is there on a phone, in one line, with the wording', h && h.text === '雙擊放大・橫放手機看更大' && h.lines <= 1 && h.w > 100, JSON.stringify(h));
      ok('...visible, inside the stage, and it does not catch touches', h && h.op > 0.8 && h.inside && h.pe === 'none', JSON.stringify(h));
      await albShot(page, 'hint-390');
      await page.waitForFunction(() => !document.getElementById('albumHint'), null, { timeout: 9000 });
      ok('it fades away by itself after a few seconds', (await page.$('#albumHint')) === null);
      await page.tap('#albumClose');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      // open again: the first touch clears it before the timer would
      await page.tap('#albumPreviewBtn');
      await albReady(page);
      ok('opening again shows it again', (await page.$('#albumHint')) !== null);
      const tSwipe = Date.now();
      await swipeTouch(page, '#albumStage', 300, 400, 100, 400);
      await page.waitForFunction(() => { const e = document.getElementById('albumHint'); return !e || parseFloat(getComputedStyle(e).opacity) < 0.05; }, null, { timeout: 2500 });
      ok('the first swipe clears it within 2.5 s (the timer alone takes 4.5 s)', Date.now() - tSwipe < 2500, String(Date.now() - tSwipe));
      await page.tap('#albumClose');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      await page.tap('#albumPreviewBtn');
      await albReady(page);
      await page.tap('#albumClose');
      await page.waitForFunction(() => !document.getElementById('albumViewer'), null, { timeout: 3000 });
      await page.waitForTimeout(800);
      ok('closed while the hint was up: no timer of the album is left running', (await albPending(page, timerStart)).length === 0, JSON.stringify(await albPending(page, timerStart)));
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 20 });
  await suite('album preview hint 1280px — no hint on a desktop, and a short window (landscape phone) has none either',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      await page.click('#albumPreviewBtn');
      await albReady(page);
      await page.waitForTimeout(300);
      ok('control: the viewer is up and showing a page', (await albSnap(page)).label === '封面');
      ok('no hint on a desktop', (await page.$('#albumHint')) === null);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(300);
      ok('the hint does not appear because the window got smaller later either', (await page.$('#albumHint')) === null);
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}

// ── 11. the back cover: none unless the plan asks for one; a blank A4 page when it does
for (const [name, planOpts, expectBack] of [['no back cover by default', null, false], ['a back cover when asked (PLAN_OPTS.back)', { back: true }, true]]) {
  const w = albumWorld({ n: 12 });
  await suite(`album preview — ${name}`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await albGalleryReady(page);   // the finals gallery (was .photo-card)
      if (planOpts) await page.evaluate(o => { AlbumPreview.PLAN_OPTS = o; }, planOpts);
      await page.click('#albumPreviewBtn');
      await albReady(page);
      let guard = 0;
      while (!(await albSnap(page)).nextDis && guard++ < 40) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40); }
      await page.waitForTimeout(350);
      const g = await albPageGeo(page);
      const snap = await albSnap(page);
      if (expectBack) {
        ok('the last page is the 封底: a blank A4 portrait page, no photo', g.kind === 'back' && snap.label === '封底' && g.slots.length === 0 && Math.abs(g.w / g.h - 210 / 297) < 0.008, JSON.stringify([g.kind, snap.label, g.slots.length, g.w, g.h]));
        ok('control: the page before it is a spread (the back comes after the inside)', await page.evaluate(() => { document.getElementById('albumPrev').click(); return true; }));
        await page.waitForTimeout(350);
        ok('...labelled n / total, a spread', (await albPageGeo(page)).kind === 'spread' && /^\d+ \/ \d+$/.test((await albSnap(page)).label));
      } else {
        ok('the last page is a spread (no back cover unless asked)', g.kind === 'spread' && /^\d+ \/ \d+$/.test(snap.label), JSON.stringify([g.kind, snap.label]));
      }
      return out;
    },
    { before: w.before, initScript: ALB_OWNER, contextOptions: ALB_DESK });
}
}
