// Browser suite: 再次編排 must always answer (docs/album-preview.md, "Re-layout feedback"). A small book used to give the same plan
// for most variants, so the button looked dead. Now: a status line on every press, a 「排法 n」 chip, an unchanged plan is never
// shown as new (the viewer moves on to a variant that looks different, or says there is only this layout), a short fade.
// Synthetic SVG photos, Chromium only.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_VIEWER, albReady, albumWorld } from '../lib/album-world.mjs';
import { shopProductsFake } from '../lib/pick-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const world = n => albumWorld({ n, fake: { title: '婚禮精修', confirmedAt: T0, studio: { name: '光影工作室', has_logo: false }, shopProducts: shopProductsFake() } });
const open = async page => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 8000 });
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  await page.tap('#albumPreviewBtn');
  await albReady(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(i => i.complete), null, { timeout: 10000 });
  await page.waitForTimeout(150);
};
// what the guest sees: for every page the layout and where each photo sits (walks the pages, comes back to the first)
const shown = async page => {
  const seq = [];
  const rewind = async () => { await page.evaluate(() => { while (!document.getElementById('albumPrev').disabled) document.getElementById('albumPrev').click(); }); await page.waitForTimeout(80); };
  await rewind();
  for (let guard = 0; guard < 40; guard++) {
    seq.push(await page.evaluate(() => {
      const cur = document.querySelector('.album-slide[data-current="true"] .album-page');
      return cur.dataset.layout + ':' + [...cur.querySelectorAll('.album-slot')].map(s => decodeURIComponent(new URL(s.querySelector('img').src).pathname.slice(1)) + '@' + s.style.left + ',' + s.style.top).sort().join(';');
    }));
    if (await page.evaluate(() => document.getElementById('albumNext').disabled)) break;
    await page.click('#albumNext'); await page.waitForTimeout(80);
  }
  await rewind();
  return seq.join('|');
};
const ui = page => page.evaluate(() => {
  const R = id => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height, w: r.width, hidden: e.hidden, disp: getComputedStyle(e).display, text: e.textContent, dis: e.disabled }; };
  const st = document.getElementById('albumRelayoutStatus');
  return { again: R('albumRelayout'), back: R('albumRelayoutBack'), chip: R('albumRelayoutChip'), status: R('albumRelayoutStatus'),
    role: st?.getAttribute('role'), live: st?.getAttribute('aria-live'), iw: innerWidth, sw: document.documentElement.scrollWidth };
});
const press = async page => { await page.click('#albumRelayout'); await page.waitForTimeout(120); };
const settle = page => page.waitForFunction(() => [...document.querySelectorAll('#albumViewer img')].every(im => im.complete), null, { timeout: 8000 });

for (const n of [4, 5, 6]) {
  const w = world(n);
  await suite(`album re-layout feedback 390px — ${n} photos: every press answers, a changed plan really looks different, chip, 回到原本`, `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page);
      const u0 = await ui(page);
      ok('the status line exists (role=status, aria-live=polite), empty before any press; no chip yet', u0.status && u0.role === 'status' && u0.live === 'polite' && u0.status.text === '' && (!u0.chip || u0.chip.hidden), JSON.stringify([u0.role, u0.live, u0.status?.text]));
      const first = await shown(page);
      let prev = first, changed = 0, only = 0, lastVariantNo = 1;
      for (let i = 1; i <= 7; i++) {
        await press(page); await settle(page);
        const u = await ui(page), cur = await shown(page);
        const said = u.status.text;
        const m = /^已換成排法 (\d+)$/.exec(said);
        if (m) {
          changed++;
          ok(`press ${i}: says 已換成排法 ${m[1]}, and the pages really changed`, cur !== prev, said);
          ok(`press ${i}: the chip shows 排法 ${m[1]} (visible) and 回到原本 is visible`, !u.chip.hidden && u.chip.disp !== 'none' && u.chip.text === `排法 ${m[1]}` && !u.back.hidden, JSON.stringify([u.chip.text, u.chip.hidden]));
          ok(`press ${i}: the layout number only goes up`, +m[1] > lastVariantNo, `${m[1]} after ${lastVariantNo}`);
          lastVariantNo = +m[1];
        } else {
          only++;
          ok(`press ${i}: says there is only this layout, and the pages are untouched`, said === '這本相本照片不多，目前只有這個排法' && cur === prev, said);
          ok(`press ${i}: the button is still usable`, !u.again.dis && u.again.h >= 44);
        }
        prev = cur;
      }
      ok('on a small book the presses mostly give a new look (at least 3 of 7)', changed >= 3, `changed ${changed}, only ${only}`);
      ok('every press produced a message (changed + only = 7)', changed + only === 7);
      const u1 = await ui(page);
      ok('390px: no horizontal scroll, the status and the chip are inside the screen, buttons >= 44px, nothing overlaps', u1.sw <= u1.iw && u1.status.l >= 0 && u1.status.r <= u1.iw && u1.chip.r <= u1.iw && u1.again.h >= 44 && u1.back.h >= 44
        && (u1.again.r <= u1.back.l || u1.back.r <= u1.again.l) && (u1.back.r <= u1.chip.l + 1 || u1.chip.r <= u1.back.l), JSON.stringify([u1.again, u1.back, u1.chip, u1.status]));
      await page.click('#albumRelayoutBack'); await page.waitForTimeout(150); await settle(page);
      const u2 = await ui(page);
      ok('回到原本: exactly the first layout again, chip hidden and emptied, 回到原本 hidden, status says so', (await shown(page)) === first && u2.chip.hidden && u2.chip.disp === 'none' && u2.chip.text === '' && u2.back.hidden && u2.status.text === '已回到原本排法', JSON.stringify([u2.chip, u2.status.text]));
      const stored = await page.evaluate(() => window.__storageWrites.filter(x => /album|variant|relayout|排法/i.test(JSON.stringify(x))));
      ok('no storage writes', stored.length === 0, JSON.stringify(stored));
      ok('no request but GET', w.log.every(r => r.method === 'GET'));
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}

{
  const w = world(5);
  await suite('album re-layout feedback 390px — an identical plan is never shown as new: skipped to a different variant, or "only this layout"', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page);
      const first = await shown(page);
      // (a) variants 1..3 are the first plan again, variant 4 is a real change: one press must jump to 排法 5
      await page.evaluate(() => {
        const real = AutoLayout.planSpreads;
        window.__calls = [];
        AutoLayout.planSpreads = (it, o) => { window.__calls.push(o.variant || 0); const v = o.variant || 0; return real(it, { ...o, variant: v >= 1 && v <= 3 ? 0 : v }); };
      });
      await press(page); await settle(page);
      const a = await ui(page), calls = await page.evaluate(() => window.__calls);
      ok('identical variants 1..3 are skipped: the chip says 排法 5 and the status 已換成排法 5', a.chip.text === '排法 5' && a.status.text === '已換成排法 5', JSON.stringify([a.chip.text, a.status.text, calls]));
      ok('and what is shown really differs from before', (await shown(page)) !== first);
      // (b) every variant is the same plan: the message, the plan and the chip stay, again and again, the button stays usable
      await page.click('#albumRelayoutBack'); await page.waitForTimeout(150);
      await page.evaluate(() => { const real = AutoLayout.planSpreads; AutoLayout.planSpreads = (it, o) => { window.__calls.push(o.variant || 0); return real(it, { ...o, variant: 0 }); }; window.__calls = []; });
      const errs = []; page.on('pageerror', e => errs.push(String(e)));
      for (let i = 0; i < 3; i++) {
        await press(page);
        const u = await ui(page);
        ok(`same-plan press ${i + 1}: the message, no chip, 回到原本 still hidden, button usable`, u.status.text === '這本相本照片不多，目前只有這個排法' && u.chip.hidden && u.back.hidden && !u.again.dis, JSON.stringify([u.status.text, u.chip.hidden, u.back.hidden]));
      }
      ok('the plan on screen is untouched', (await shown(page)) === first);
      const tried = await page.evaluate(() => window.__calls);
      ok('it tried about 12 variants per press (the stub chain counts each twice), not forever', tried.length >= 3 * 12 && tried.length <= 3 * 13 * 2, String(tried.length));
      ok('no page error', errs.length === 0, errs.join(';'));
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}

{
  const w = world(5);
  await suite('album re-layout feedback 390px — the page visibly re-draws (short fade), none under reduced motion', `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await open(page);
      const probe = () => page.evaluate(() => { const s = document.getElementById('albumStage'); return { cls: s.classList.contains('album-redraw'), anim: getComputedStyle(s).animationName, dur: getComputedStyle(s).animationDuration }; });
      const idle = await probe();
      ok('control: not animating before a press', !idle.cls && idle.anim === 'none', JSON.stringify(idle));
      await page.evaluate(() => { document.getElementById('albumRelayout').click(); });
      const during = await probe();
      ok('right after a press the stage plays the ~250ms fade', during.cls && /albumRedraw/.test(during.anim) && during.dur === '0.25s', JSON.stringify(during));
      await page.waitForTimeout(500);
      const after = await probe();
      ok('and it is gone again afterwards', !after.cls && after.anim === 'none', JSON.stringify(after));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { document.getElementById('albumRelayout').click(); });
      const rm = await probe();
      ok('prefers-reduced-motion: no animation (the status line still answers)', rm.anim === 'none' && (await ui(page)).status.text !== '', JSON.stringify(rm));
      return out;
    },
    { before: w.before, initScript: ALB_VIEWER, contextOptions: MOBILE });
}

}
