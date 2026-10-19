// Browser suites: two bugs Tim found on his phone on the 驗收頁 (2026-10-19).
//  1. the sticky strip (回到毛片 + status) and the sticky folder bar (#guestBar) both stuck at the top and overlapped,
//     eating the top of the page;
//  2. after the client sent a round (the photographer has not uploaded the new finals yet) the page still offered
//     「精修完成」 — there is nothing to accept yet, so no action button then.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK } from '../lib/album-world.mjs';
import { RS_OWNER, rsUrl, rsKey, rsPin, rsWorld, rsLine, rsHas, rsUntil } from '../lib/review-stage.mjs';

export default async function register() {
  const sx = (name, url, run, opts) => suite(name, url, async page => {
    const out = [], ok = rsLine(out);
    try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
    return out;
  }, opts);
  const OPEN = () => [{ id: 'R1', kind: 'pins', created_at: '2026-09-23T04:00:00.000Z', open: true, note: '卡卡卡', photos: [{ key: rsKey(1), pins: [rsPin(0.4, 0.4, '卡卡卡')] }] }];
  const rect = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), pos: getComputedStyle(e).position }; }, sel);
  const scrollDown = page => page.evaluate(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 500; window.scrollTo(0, 500); });

  // ═════ 1. the strip and the folder bar do not overlap while scrolling
  for (const [label, opts] of [['390px phone', MOBILE], ['1024px tablet', { viewport: { width: 1024, height: 800 } }]]) {
    const w = rsWorld({ fake: { allowProofDownload: true }, rounds: OPEN() });
    await sx(`驗收頁 strip (${label}) — scrolled down, the sticky strip and the folder bar never overlap`, rsUrl,
      async (page, ok) => {
        await page.waitForSelector('.photo-card', { timeout: 6000 });
        await page.waitForSelector('#deliveryStrip', { timeout: 4000 });
        const before = { strip: await rect(page, '#deliveryStrip'), bar: await rect(page, '#guestBar') };
        ok('control: both exist on this page', !!before.strip && !!before.bar && before.bar.b > before.bar.t, JSON.stringify(before));
        await scrollDown(page);
        await page.waitForTimeout(300);
        const s = await rect(page, '#deliveryStrip'), b = await rect(page, '#guestBar');
        const overlap = Math.min(s.b, b.b) - Math.max(s.t, b.t);
        ok('after scrolling the strip stays on screen (sticky)', s.t >= 0 && s.t < 120 && s.b > s.t, JSON.stringify(s));
        ok('and the folder bar is not stacked under it (no vertical overlap)', overlap <= 0, `overlap ${overlap} strip=${JSON.stringify(s)} bar=${JSON.stringify(b)}`);
      }, { initScript: RS_OWNER, before: w.m.attach, contextOptions: opts });
  }

  // ═════ 2. a round waiting for the photographer: no action button
  {
    const w = rsWorld({ rounds: OPEN() });
    await sx('驗收頁 action (1280px) — a sent round is waiting: no 精修完成 / 送出 button; the status says so', rsUrl,
      async (page, ok) => {
        await page.waitForSelector('.photo-card', { timeout: 6000 });
        await page.waitForFunction(() => document.getElementById('deliveryDoneStatus')?.textContent.includes('攝影師處理中'), null, { timeout: 5000 });
        ok('the status says 已送出修改（1 張），攝影師處理中', (await page.textContent('#deliveryDoneStatus')).includes('已送出修改（1 張），攝影師處理中'));
        ok('no action button and no bar in the DOM', !(await rsHas(page, '#doneActionBtn')) && !(await rsHas(page, '#doneActionBar')));
        ok('the bottom padding reserved for the bar is gone too', await page.evaluate(() => !document.body.classList.contains('done-action-on')));
      }, { initScript: RS_OWNER, before: w.m.attach, contextOptions: ALB_DESK });
  }
  {
    const w = rsWorld({});
    await sx('驗收頁 action (1280px) — control: no round waiting, the button is there', rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        ok('精修完成 is offered', (await page.textContent('#doneActionBtn')).replace(/\s/g, '') === '精修完成');
      }, { initScript: RS_OWNER, before: w.m.attach, contextOptions: ALB_DESK });
  }
}
