// Browser suites (Tim 2026-10-19, from his phone):
//  1. a guest link with ONE folder and no subfolders shows no 資料夾 chooser (nothing to choose);
//  2. the 毛片 view of a delivered, unconfirmed project shows the same status strip as the finals view: the pins
//     wording (已送出修改（N 張）), never the old text-request fallback (已通知攝影師，修改中 + 需要修改).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK } from '../lib/album-world.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { RS_OWNER, rsUrl, rsKey, rsPin, rsWorld, rsLine, rsHas, rsUntil } from '../lib/review-stage.mjs';

export default async function register() {
  const sx = (name, url, run, opts) => suite(name, url, async page => {
    const out = [], ok = rsLine(out);
    try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
    return out;
  }, opts);
  const PH = { 'A/': [0, 1, 2].map(i => ({ id: `A/a${i}.jpg`, name: `a${i}.jpg`, size: 9e6, rating: 0 })), 'B/': [{ id: 'B/b0.jpg', name: 'b0.jpg', size: 9e6, rating: 0 }] };
  // true / false, or null when the element is not in the DOM at all (so 'hidden' is told apart from 'broken')
  const rowShown = page => page.evaluate(() => { const r = document.getElementById('guestFolderRow'); return r ? getComputedStyle(r).display !== 'none' && !r.hidden : null; });
  const treeShown = page => page.evaluate(() => { const c = document.getElementById('folderTreeContainer'); return c ? getComputedStyle(c).display !== 'none' : null; });

  // ═════ 1. one folder, no subfolders: no chooser
  for (const [label, opts] of [['390px phone', MOBILE], ['1280px desktop', ALB_DESK]]) {
    const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/'], photosByFolder: PH });
    await sx(`guest folder chooser (${label}) — one folder and no subfolders: nothing to choose, no chooser`, `${base}/index.html?t=TOK`,
      async (page, ok) => {
        await page.waitForSelector('.photo-card', { timeout: 6000 });
        await page.waitForTimeout(500);
        ok('control: the photos are on screen', (await page.$$('.photo-card')).length > 0);
        if (opts === MOBILE) ok('the mobile 資料夾 row is mounted but hidden', (await rowShown(page)) === false, String(await rowShown(page)));
        else ok('the desktop 資料夾 panel is mounted but hidden', (await treeShown(page)) === false, String(await treeShown(page)));
      }, { initScript: RS_OWNER, before: m.attach, contextOptions: opts });
  }
  {
    const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: PH });
    await sx('guest folder chooser (390px) — control: two folders still get the chooser', `${base}/index.html?t=TOK`,
      async (page, ok) => {
        await page.waitForSelector('.photo-card', { timeout: 6000 });
        ok('the 資料夾 row is shown with two folders', await rsUntil(async () => (await rowShown(page)) === true));
      }, { initScript: RS_OWNER, before: m.attach, contextOptions: MOBILE });
  }

  // ═════ 2. the 毛片 view keeps the pins strip
  for (const [label, round] of [['a round waiting', [{ id: 'R1', kind: 'pins', created_at: '2026-09-23T04:00:00.000Z', open: true, note: '卡卡卡', photos: [{ key: rsKey(1), pins: [rsPin(0.4, 0.4, '卡卡卡')] }] }]], ['no round', []]]) {
    const w = rsWorld({ fake: { allowProofDownload: true }, rounds: round });
    await sx(`驗收頁 毛片 view (1280px) — ${label}: the strip keeps the pins wording, no old 需要修改 button`, rsUrl,
      async (page, ok) => {
        await page.waitForSelector('#deliveryProofsBtn', { timeout: 6000 });
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.getElementById('deliveryTitle')?.textContent.startsWith('毛片'), null, { timeout: 5000 });
        await page.waitForTimeout(300);
        const status = (await page.textContent('#deliveryDoneStatus')).trim();
        if (round.length) ok('says 已送出修改（1 張），攝影師處理中', status === '已送出修改（1 張），攝影師處理中', status);
        else ok('says to go back to the finals (no button or marking exists here), not 已通知攝影師', status === '要確認或標示修改，請先回到精修成品', status);
        ok('no old 需要修改 button', !(await rsHas(page, '#doneReviseBtn')));
        // a history entry, if one is offered here, must open a real dialog (no dead button)
        if (await rsHas(page, '#doneHistoryBtn')) {
          await page.click('#doneHistoryBtn');
          ok('the history entry opens its dialog', await rsUntil(async () => !!(await page.textContent('#revHistoryTitle').catch(() => ''))));
        }
        ok('and no action button in the 毛片 view (suite 93)', !(await rsHas(page, '#doneActionBtn')));
      }, { initScript: RS_OWNER, before: w.m.attach, contextOptions: ALB_DESK });
  }
}
