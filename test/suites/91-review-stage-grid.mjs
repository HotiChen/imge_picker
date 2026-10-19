// Browser suites: the 驗收頁 (delivered, not yet confirmed) is the 毛片 page — the standard photo grid and the
// standard preview with zoom / pan, no ♥, no web-album gallery; the 完成頁 keeps its own gallery
// (docs/delivery.md, "The 驗收頁 is the 毛片 page").
import { suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK } from '../lib/album-world.mjs';
import { RS_OWNER, rsUrl, rsKey, rsWorld, rsLine, rsOpen, rsHas, rsSleep } from '../lib/review-stage.mjs';

export default async function register() {
  const sx = (name, url, run, opts) => suite(name, url, async page => {
    const out = [], ok = rsLine(out);
    try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
    return out;
  }, opts);

  for (const [label, ctx] of [['1280px', ALB_DESK], ['390px', MOBILE]]) {
    for (const [who, init] of [['owner', RS_OWNER], ['viewer', '']]) {
      const w = rsWorld();
      await sx(`驗收頁 grid (${label}, ${who}) — the standard photo cards, no ♥, no web-album gallery`,
        rsUrl,
        async (page, ok) => {
          await page.waitForSelector('.photo-card', { timeout: 6000 });
          const g = await page.evaluate(() => ({
            cards: [...document.querySelectorAll('#photoGrid .photo-card')].map(c => c.dataset.photoId),
            gallery: !!document.getElementById('finalsGallery'), tiles: document.querySelectorAll('.fg-tile').length,
            hero: !!document.getElementById('fgHero'), hearts: document.querySelectorAll('.pick-heart-btn').length,
            fgMode: document.body.classList.contains('fg-mode'),
            gridShown: getComputedStyle(document.getElementById('photoGrid')).display !== 'none',
            sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
          }));
          ok('positive: the 8 finals are standard cards in #photoGrid, in the gallery order', g.cards.length === 8 && g.cards[0] === rsKey(1) && g.cards[7] === rsKey(8) && g.gridShown, JSON.stringify(g));
          ok('no web-album gallery: no #finalsGallery, no tiles, no hero, no fg-mode', !g.gallery && g.tiles === 0 && !g.hero && !g.fgMode, JSON.stringify(g));
          ok('no ♥ anywhere (hearts are for picking)', g.hearts === 0, String(g.hearts));
          ok('no sideways scroll', !g.sideways);
          ok('the strip is there with its status', await rsHas(page, '#deliveryStrip #deliveryDoneStatus'));
        },
        { before: w.before, initScript: init, contextOptions: ctx });
    }
  }

  {
    const w = rsWorld();
    await sx('驗收頁 preview (1280px) — a card opens the standard preview: zoom in / out / reset work, no ♥, ‹ › flip',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        const m = await page.evaluate(() => ({
          lb: !!document.getElementById('fgLightbox'), counter: document.getElementById('photoCounter').textContent,
          heart: !!document.querySelector('#photoModal .pick-heart-btn'), zoomIn: !!document.getElementById('zoomInBtn'),
          zoom: annotationManager.zoom,
        }));
        ok('positive: the standard modal is open on photo 1 (1 / 8); no finals lightbox', !m.lb && m.counter === '1 / 8', JSON.stringify(m));
        ok('no ♥ in the preview', !m.heart);
        ok('the zoom controls exist', m.zoomIn && m.zoom === 1, JSON.stringify(m));
        await page.click('#zoomInBtn');
        await page.click('#zoomInBtn');
        const z1 = await page.evaluate(() => annotationManager.zoom);
        ok('+ zooms in', z1 > 1.3, String(z1));
        await page.click('#zoomResetBtn');
        ok('⟲ goes back to fit', await page.evaluate(() => annotationManager.zoom) === 1);
        // the wheel zooms about the pointer, the same as on the 毛片 page
        const box = await page.evaluate(() => { const r = annotationManager.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.move(box.x, box.y);
        await page.mouse.wheel(0, -300);
        await rsSleep(100);
        ok('the mouse wheel zooms too', await page.evaluate(() => annotationManager.zoom) > 1);
        await page.click('#nextPhotoBtn');
        ok('› goes to photo 2 and the zoom resets', await page.waitForFunction(() => document.getElementById('photoCounter').textContent === '2 / 8' && annotationManager.zoom === 1, null, { timeout: 4000 }).then(() => true, () => false));
        await page.keyboard.press('Escape');
        ok('Esc closes it', !(await page.evaluate(() => document.getElementById('photoModal').classList.contains('active'))));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  {
    const w = rsWorld({ fake: { confirmedAt: '2026-09-21T03:00:00.000Z' } });
    await sx('驗收頁 grid — positive control: the confirmed 完成頁 keeps its own light gallery (tiles, its lightbox), no standard cards',
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#completionPage .fg-tile', { timeout: 6000 });
        ok('the 完成頁 has its gallery tiles', (await page.$$('#completionPage .fg-tile')).length === 8);
        ok('no standard photo cards under it', (await page.$$('#photoGrid .photo-card')).length === 0);
        ok('the gallery is the light one, without a hero of its own', await page.evaluate(() => document.getElementById('finalsGallery').classList.contains('fg--light') && !document.getElementById('fgHero')));
        await page.click('#completionPage .fg-tile');
        ok('a tile opens the gallery lightbox, not the standard preview', await page.waitForSelector('#fgLightbox', { timeout: 4000 }).then(() => true, () => false) &&
          !(await page.evaluate(() => document.getElementById('photoModal').classList.contains('active'))));
        ok('its lightbox is the light one too', await page.evaluate(() => document.getElementById('fgLightbox').classList.contains('fg-lightbox--light')));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }
}
