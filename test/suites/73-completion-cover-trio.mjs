// Browser suites: the 完成頁 cover. When the finals have no landscape photo the cover is up to three PORTRAIT
// photos side by side, each whole in a 2:3 box (the face is not cropped away by a 3:2 banner); a landscape
// final still gives one image. The studio logo is shown whole, not cropped into a circle.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, albKeys, albumWorld } from '../lib/album-world.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const P = [400, 600], L = [600, 400], SQ = [500, 500];
const key = i => albKeys(40)[i - 1];
const STUDIO = { name: '光影工作室', booking_url: null, has_logo: true };

const read = page => page.evaluate(() => {
  const imgs = [...document.querySelectorAll('#cpHero .cp-cover')];
  const frame = document.querySelector('#cpHero .cp-cover-frame');
  return {
    ids: imgs.map(i => i.dataset.photoId),
    boxes: imgs.map(i => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.right)]; }),
    loaded: imgs.map(i => i.complete && i.naturalWidth > 0 && i.classList.contains('on')),
    fw: frame.getBoundingClientRect().width, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
    firstId: document.getElementById('cpCover') ? document.getElementById('cpCover').dataset.photoId : null,
    ids2: [...document.querySelectorAll('#cpCover')].length,
  };
});

const trioCase = (name, shapes, expectIdx, co) => {
  const w = albumWorld({ n: shapes.length, shapes, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO } });
  return suite(`cover trio — ${name}`, `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#cpCover', { timeout: 5000 });
      await page.waitForFunction(n => document.querySelectorAll('#cpHero .cp-cover.on').length === n, expectIdx.length, { timeout: 7000 });
      const s = await read(page);
      ok(`the cover is photos ${expectIdx.join(', ')}, in list order`, JSON.stringify(s.ids) === JSON.stringify(expectIdx.map(key)), JSON.stringify(s));
      ok('positive: every image really loaded', s.loaded.length === expectIdx.length && s.loaded.every(Boolean), JSON.stringify(s));
      ok('only the first carries the #cpCover id (ids stay unique)', s.firstId === key(expectIdx[0]) && s.ids2 === 1, JSON.stringify(s));
      ok('each box is portrait (2:3), so the whole photo shows, not a cropped banner', s.boxes.every(([w2, h]) => Math.abs(w2 / h - 2 / 3) < 0.03 && h > 150), JSON.stringify(s.boxes));
      ok('they sit side by side inside the page, no sideways scroll', s.sw <= s.vw && s.boxes.every(([, , l, r]) => l >= -1 && r <= s.vw + 1) && s.boxes.every((b, i) => i === 0 || b[2] >= s.boxes[i - 1][3] - 1), JSON.stringify(s));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: co });
};

for (const [vp, co] of [['1280px', ALB_DESK], ['390px phone', MOBILE]]) {
  await trioCase(`${vp}: all portrait -> the first three`, [P, P, P, P, P], [1, 2, 3], co);
  await trioCase(`${vp}: squares and landscapes are skipped, portraits kept in order`, [P, SQ, P, P, P], [1, 3, 4], co);
  await trioCase(`${vp}: only two portraits -> two (no empty slot)`, [P, P], [1, 2], co);
  await trioCase(`${vp}: one portrait -> one, still 2:3 not a banner`, [P], [1], co);
}

// a landscape final among the first 12 wins: one image, the 3:2 banner as before
{
  const w = albumWorld({ n: 4, shapes: [P, P, L, P], fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO } });
  await suite('cover trio — a landscape final -> one 3:2 image (not three portraits)', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#cpCover', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('cpCover')?.classList.contains('on'), null, { timeout: 5000 });
      const s = await read(page);
      ok('one image, the landscape photo', s.ids.length === 1 && s.ids[0] === key(3), JSON.stringify(s));
      ok('its box is the landscape banner (wider than tall)', s.boxes[0][0] / s.boxes[0][1] > 1.3, JSON.stringify(s));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── the studio logo: whole, not a cropped circle ──
for (const [vp, co] of [['1280px', ALB_DESK], ['390px phone', MOBILE]]) {
  const w = albumWorld({ n: 4, shapes: [L, L, L, L], fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO } });
  await suite(`completion page logo (${vp}) — shown whole: no circle, no crop`, `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#cpStudio .cp-studio-logo', { timeout: 5000 });
      const d = await page.evaluate(() => {
        const i = document.querySelector('#cpStudio .cp-studio-logo');
        const cs = getComputedStyle(i), r = i.getBoundingClientRect();
        return { radius: cs.borderTopLeftRadius, fit: cs.objectFit, w: r.width, h: r.height, nw: i.naturalWidth, nh: i.naturalHeight, complete: i.complete };
      });
      ok('positive: the logo is there and loaded', d.complete && d.nw > 0 && d.w > 0, JSON.stringify(d));
      ok('not a circle', d.radius === '0px', JSON.stringify(d));
      ok('contained, never cropped (object-fit contain)', d.fit === 'contain', JSON.stringify(d));
      ok('drawn at its own aspect ratio, so all of it shows', Math.abs(d.w / d.h - d.nw / d.nh) < 0.05, JSON.stringify(d));
      ok('big enough to read (at least 32px tall)', d.h >= 32, JSON.stringify(d));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: co });
}

}
