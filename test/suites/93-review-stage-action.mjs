// Browser suites: the 驗收頁's one action button (docs/delivery.md, "The 驗收頁 is the 毛片 page"): fixed at the
// bottom (desktop: bottom-right), 「精修完成」 with no pins, 「送出（N 張）」 with pins; it always asks first —
// pins: the round dialog (POST /api/pick/revision-round), none: the 確認完成 dialog (POST /api/pick/confirm).
// The old 確認完成 / 送出修改 strip buttons are gone; the strip keeps 回到毛片 and the status.
import { suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK } from '../lib/album-world.mjs';
import { donePosts } from '../lib/delivery-helpers.mjs';
import { RS_OWNER, rsUrl, rsKey, rsPin, rsWorld, rsLine, rsOpen, rsHas, rsSleep, rsUntil, rsRounds, rsPoint, rsModalActive } from '../lib/review-stage.mjs';

export default async function register() {
  const sx = (name, url, run, opts) => suite(name, url, async page => {
    const out = [], ok = rsLine(out);
    try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
    return out;
  }, opts);
  const label = page => page.evaluate(() => document.getElementById('doneActionBtn')?.textContent.replace(/\s/g, '') ?? null);
  const geo = page => page.evaluate(() => {
    const b = document.getElementById('doneActionBtn'), bar = document.getElementById('doneActionBar');
    if (!b || !bar) return null;
    const r = b.getBoundingClientRect(), s = bar.getBoundingClientRect();
    return { pos: getComputedStyle(bar).position, l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height, w: r.width,
      barL: s.left, barR: s.right, barB: s.bottom, vw: innerWidth, vh: innerHeight,
      hit: (() => { const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === b || b.contains(e); })() };
  });
  const SEED = () => [{ photo_key: rsKey(1), marks: [rsPin(0.2, 0.3, '臉修瘦一點'), rsPin(0.6, 0.5, '')] }, { photo_key: rsKey(3), marks: [rsPin(0.4, 0.4, 'x')] }];

  // ═════ 1. no pins: 精修完成 -> the 確認完成 dialog -> the 完成頁
  {
    const w = rsWorld({ fake: { allowProofDownload: true } });
    await sx('驗收頁 action (1280px) — no pins: 「精修完成」 bottom-right; it asks first (確認完成 dialog), 取消 sends nothing, 確認 confirms',
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        ok('the one button says 精修完成', (await label(page)) === '精修完成', await label(page));
        const g = await geo(page);
        ok('fixed at the bottom-right of the window, on top (a click there hits it)', g && g.pos === 'fixed' && g.vw - g.r <= 32 && g.vh - g.b <= 32 && g.l > g.vw / 2 && g.hit, JSON.stringify(g));
        ok('the old strip buttons are gone (確認完成 / 送出修改 / its hint)', !(await rsHas(page, '#doneConfirmBtn')) && !(await rsHas(page, '#doneRoundBtn')) && !(await rsHas(page, '#doneRoundHint')));
        ok('the strip keeps 回到毛片 and the status', (await page.textContent('#deliveryProofsBtn')).trim() === '回到毛片' && (await page.textContent('#deliveryDoneStatus')).includes('精修完成'));
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.getElementById('deliveryTitle')?.textContent.startsWith('毛片'), null, { timeout: 5000 });
        ok('the 毛片 download list has no action button (nothing to confirm or mark there)', !(await rsHas(page, '#doneActionBtn')) && !(await page.evaluate(() => document.body.classList.contains('done-action-on'))));
        await page.click('#deliveryProofsBtn');
        ok('back on the finals it is there again', await rsUntil(async () => (await label(page)) === '精修完成'));
        await page.click('#doneActionBtn');
        ok('pressing it opens the 確認完成 dialog first (nothing is sent)', await rsModalActive(page, 'doneConfirmModal') && donePosts(w.m, 'confirm').length === 0);
        ok('the dialog warns what it means', (await page.textContent('#doneConfirmModal')).includes('確認後攝影師會收到通知'));
        ok('it is not the round dialog', !(await rsModalActive(page, 'doneRoundModal')));
        await page.click('#doneConfirmCancel');
        await rsSleep(200);
        ok('取消 closes it and sends nothing', !(await rsModalActive(page, 'doneConfirmModal')) && donePosts(w.m, 'confirm').length === 0);
        await page.click('#doneActionBtn');
        await page.click('#doneConfirmSubmit');
        ok('確認完成 posts once and the 完成頁 replaces the page', await rsUntil(async () => (await page.$('#completionPage')) !== null) && donePosts(w.m, 'confirm').length === 1);
        ok('the action button is gone with the 驗收頁', !(await rsHas(page, '#doneActionBtn')) && !(await rsHas(page, '#doneActionBar')));
        ok('switched in place: the 完成頁 gallery holds the 8 photos, the standard cards are gone', await rsUntil(async () => (await page.$$('#completionPage .fg-tile')).length === 8) &&
          (await page.$$('#photoGrid .photo-card')).length === 0);
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  // ═════ 2. with pins: 送出（N 張） -> the round dialog -> a sent round; then 精修完成 again
  {
    const w = rsWorld({ drafts: SEED() });
    await sx('驗收頁 action — with pins: 「送出（2 張）」 opens the round dialog; sending posts the round; afterwards 精修完成 (確認完成 dialog)',
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        ok('the button counts the photos with pins: 送出（2 張）', (await label(page)) === '送出（2張）', await label(page));
        await page.click('#doneActionBtn');
        ok('it opens the round dialog: 送出 2 張照片的修改？', await rsModalActive(page, 'doneRoundModal') && (await page.textContent('#doneRoundModalTitle')) === '送出 2 張照片的修改？');
        ok('not the 確認完成 dialog, and nothing sent yet', !(await rsModalActive(page, 'doneConfirmModal')) && rsRounds(w).length === 0);
        ok('the empty-note warning is still there', (await page.textContent('#doneRoundWarn')).includes('有 1 個標示沒有寫說明'));
        await page.click('#doneRoundCancel');
        ok('取消 sends nothing', !(await rsModalActive(page, 'doneRoundModal')) && rsRounds(w).length === 0);
        await page.click('#doneActionBtn');
        await page.fill('#doneRoundNote', '整體亮一點');
        await page.click('#doneRoundSubmit');
        ok('sent: one POST with expect + note; the status says 已送出修改（2 張）', await rsUntil(async () => rsRounds(w).length === 1 && (await page.textContent('#deliveryDoneStatus')) === '已送出修改（2 張），攝影師處理中') &&
          JSON.stringify(rsRounds(w)[0].body) === JSON.stringify({ expect: [{ k: rsKey(1), n: 2 }, { k: rsKey(3), n: 1 }], note: '整體亮一點' }), JSON.stringify(rsRounds(w).map(c => c.body)));
        ok('the button is now 精修完成 (no draft to send)', await rsUntil(async () => (await label(page)) === '精修完成'), await label(page));
        await page.click('#doneActionBtn');
        ok('and it opens the 確認完成 dialog', await rsModalActive(page, 'doneConfirmModal') && !(await rsModalActive(page, 'doneRoundModal')));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  // ═════ 3. the label follows the pins live
  {
    const w = rsWorld();
    await sx('驗收頁 action — the label follows the pins: 精修完成 -> 送出（1 張） after a pin, back after its ×',
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        ok('starts as 精修完成', (await label(page)) === '精修完成');
        await rsOpen(page, 2);
        await page.click('#pickPinBtn');
        const p = await rsPoint(page, 0.5, 0.5);
        await page.mouse.click(p.x, p.y);
        await page.keyboard.press('Enter');
        ok('one pin: 送出（1 張）', await rsUntil(async () => (await label(page)) === '送出（1張）'), await label(page));
        await page.click('#pickPinList .pick-pin-del');
        ok('removed again: 精修完成', await rsUntil(async () => (await label(page)) === '精修完成'), await label(page));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  // ═════ 4. a phone: a full-width bottom bar that never hides the last row
  {
    const w = rsWorld({ drafts: SEED() });
    await sx('驗收頁 action (390px) — a bottom bar across the phone, ≥44px, the last card can be scrolled above it, no sideways scroll',
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        const g = await geo(page);
        ok('fixed to the bottom, across the width, ≥44px tall', g && g.pos === 'fixed' && g.barL <= 1 && g.vw - g.barR <= 1 && Math.abs(g.vh - g.barB) <= 1 && g.h >= 44 && g.w >= g.vw * 0.6 && g.hit, JSON.stringify(g));
        // scroll whatever scrolls to the very end; the last card ends above the bar
        await page.evaluate(() => { document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 1) e.scrollTop = e.scrollHeight; }); window.scrollTo(0, document.documentElement.scrollHeight); });
        await rsSleep(200);
        const last = await page.evaluate(() => { const cards = document.querySelectorAll('#photoGrid .photo-card'); const c = cards[cards.length - 1].getBoundingClientRect();
          return { cb: c.bottom, bt: document.getElementById('doneActionBar').getBoundingClientRect().top, n: cards.length }; });
        ok('the last card is not under the bar', last.n === 8 && last.cb <= last.bt + 1, JSON.stringify(last));
        ok('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: MOBILE });
  }

  // ═════ 5. who has no button
  for (const [who, o, init, status] of [
    ['a viewer', {}, '', '尚待選片人確認完成'],
    ['the confirmed 完成頁', { fake: { confirmedAt: '2026-09-21T03:00:00.000Z' } }, RS_OWNER, null],
  ]) {
    const w = rsWorld(o);
    await sx(`驗收頁 action — ${who}: no action button in the DOM`,
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector(status ? '.photo-card' : '#completionPage .fg-tile', { timeout: 6000 });
        await rsSleep(300);
        if (status) ok('positive: the status says it waits for the picker', (await page.textContent('#deliveryDoneStatus')) === status);
        else ok('positive: the 完成頁 is up', await rsHas(page, '#completionPage'));
        ok('no action button, no bar, no dialogs', !(await rsHas(page, '#doneActionBtn')) && !(await rsHas(page, '#doneActionBar')) && !(await rsHas(page, '#doneConfirmModal')) && !(await rsHas(page, '#doneRoundModal')));
      },
      { before: w.before, initScript: init, contextOptions: ALB_DESK });
  }

  // ═════ 5b. the tour's ？ button and the action button share the bottom: neither covers the other
  for (const [lbl, ctx] of [['1280px', ALB_DESK], ['390px', MOBILE]]) {
    const w = rsWorld();
    await sx(`驗收頁 action (${lbl}) — the tour's ？ sits clear of the action button`,
      rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#doneActionBtn', { timeout: 6000 });
        await page.waitForSelector('.gt-help', { timeout: 6000 });
        const r = await page.evaluate(() => {
          const a = document.getElementById('doneActionBtn').getBoundingClientRect(), h = document.querySelector('.gt-help').getBoundingClientRect();
          const hit = el => { const b = el.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e === el || el.contains(e); };
          return { overlap: !(h.right <= a.left || h.left >= a.right || h.bottom <= a.top || h.top >= a.bottom), helpHit: hit(document.querySelector('.gt-help')), btnHit: hit(document.getElementById('doneActionBtn')), a: [a.left, a.top, a.right, a.bottom], h: [h.left, h.top, h.right, h.bottom] };
        });
        ok('positive: both are on screen and each is what a tap on it hits; they do not overlap', !r.overlap && r.helpHit && r.btnHit, JSON.stringify(r));
      },
      { before: w.before, initScript: `${RS_OWNER}localStorage.setItem('guestTourDeliveredV1', '1');`, contextOptions: ctx });
  }

  // ═════ 6. the preview covers the page: the button is not on top of the open preview
  {
    const w = rsWorld();
    await sx('驗收頁 action — while the preview is open the button does not sit over it',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        const hit = await page.evaluate(() => { const b = document.getElementById('doneActionBtn'); if (!b) return 'none'; const r = b.getBoundingClientRect();
          const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === b || b.contains(e) ? 'button' : 'covered'; });
        ok('the button exists, and a click where it is hits the preview, not the button', hit === 'covered', hit);
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }
}
