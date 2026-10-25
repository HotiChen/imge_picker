// Browser suite (2026-10-20, trimmed 2026-10-25): 照片保存期限 (docs/delivery.md, "Photo expiry") is retired: the R2
// lifecycle rule no longer deletes, and both routes answer every date null. The pages' dated code was removed, so this
// suite only checks the null answer: the photographer's project page shows no 精修/照片 date, never asks the admin
// /expiry route, the copied 交件通知文案 is the plain text (no 預計保存 line, no stray blank line), and the client's
// 完成頁 has no #cpExpiry note. Each case also asserts a positive (the page is up and usable) so an empty page cannot pass.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { albumWorld } from '../lib/album-world.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const LA = { ...MOBILE, timezoneId: 'America/Los_Angeles' };
const URL_ = `${base}/admin.html#project=proj-ex`;
const CLIP = `(() => { window.__clip = []; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__clip.push(t); return Promise.resolve(); } }, configurable: true }); } catch (e) {} })();`;
const initAdmin = `(${ADMIN.toString()})();${CLIP}`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-ex', title: '期限專案', ownerName: 'Lin', folders: ['shoot/毛片/'],
  bucketFolders: ['shoot/', 'shoot/毛片/', 'shoot/精修/'], ...o });
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] };
const expiryText = page => page.evaluate(() => { const e = document.getElementById('pd-expiry'); return e && !e.hidden && e.getClientRects().length ? e.textContent.trim() : null; });
const settle = async (page, m) => {            // the head is up and the expiry request has been answered (or failed)
  await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('pd-expiry') !== null, null, { timeout: 5000 });
  await page.waitForTimeout(500);
};
// ═════ admin: the 照片 card ═════
// The card's line is the proofs' deletion status (99s-proof-retention-ui.mjs); with the retired answer (no retention
// configured) there is no line, and the page does not ask the /expiry route any more.
{
  const m = fx();
  await suite('99p expiry admin — retired (every date null): no line, no /expiry request, the page still works', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    ok('the admin /expiry route is never asked', m.state.expiryCalls.admin === 0, String(m.state.expiryCalls.admin));
    ok('nothing shown, no 預計保存 text anywhere in the 照片 card', (await expiryText(page)) === null && !/預計保存|超過預計/.test(await page.textContent('#pd-photos')));
    ok('positive: the card is there and its download button is usable', await page.$eval('#pd-download-btn', b => !b.disabled && b.getClientRects().length > 0));
    ok('positive: the ⋯ menu opens', await page.click('#pd-more-btn').then(() => page.$eval('#pd-more-menu', e => !e.hidden)));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}

// ═════ admin: 複製交件通知文案 ═════
// The notice is the usual text only. Before the removal it could end with a blank line + 精修預計保存到 …; the whole text is
// compared so a leftover blank line or sentence fails.
const NOTICE = '期限專案 的成品已經完成，可以看了！\n請從這個連結查看與下載：\n' + 'LINK' + '\n\n看完覺得沒問題，請按頁面上的「確認完成」。\n如果有想調整的地方，請按「需要修改」，寫下想修改的內容，我會再幫您處理。';
{
  const m = fx({ ...DELIVERED });
  await suite('99p expiry notice — delivered: the copied text is exactly the usual notice (no date line, no trailing blank line)', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    await page.click('#pd-more-btn');
    await page.click('#pd-copy-notice-btn');
    await page.waitForFunction(() => window.__clip.length === 1, null, { timeout: 3000 });
    const text = await page.evaluate(() => window.__clip[0]);
    const link = (text.match(/https?:\/\/\S+/) || [''])[0];
    ok('the usual text is there', /的成品已經完成/.test(text) && /確認完成/.test(text), text);
    ok('exactly the usual notice, nothing before or after', link !== '' && text === NOTICE.replace('LINK', link), text);
    ok('no 預計保存 / 保存到 / trailing newline', !/預計保存|保存到/.test(text) && !/\n$/.test(text), text);
    ok('the status says 已複製', (await page.textContent('#pd-copy-notice-status')).trim() === '已複製');
    ok('the admin /expiry route is never asked', m.state.expiryCalls.admin === 0, String(m.state.expiryCalls.admin));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}

// ═════ the client's 完成頁 ═════
const GURL = `${base}/index.html?t=TOK`;
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const cpUp = async page => {
  await page.waitForSelector('#completionPage #cpDownloadAll', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(400);
};
const cpNote = page => page.evaluate(() => { const e = document.getElementById('cpExpiry'); return e && !e.hidden && e.getClientRects().length ? e.textContent.trim() : null; });
for (const [why, fake] of [['no date (null from the Worker)', {}], ['the request fails with 500', { expiryFail: 500 }], ['the connection drops', { expiryFail: 'net' }]]) {
  const w = albumWorld({ n: 6, fake });
  await suite(`99p expiry 完成頁 — ${why}: nothing shown, the page still works`, GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    ok('the expiry route was asked (the guard under test ran)', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    ok('no #cpExpiry element at all, no 預計保存 text', (await page.$('#cpExpiry')) === null && (await cpNote(page)) === null && !/預計保存|超過預計/.test(await page.textContent('#completionPage')));
    ok('positive: the 帶回家 section is there with 下載全部精修 enabled and the gallery up', await page.$eval('#cpDownloadAll', b => !b.disabled && b.getClientRects().length > 0 && !!b.closest('#cpDownload')));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { confirmedAt: null } });
  await suite('99p expiry 驗收頁 (delivered, not confirmed) — no expiry request and no note (positive: the page is up)', GURL, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
    await page.waitForSelector('#deliveryDone', { timeout: 5000 });
    await page.waitForTimeout(400);
    ok('never asked', w.m.state.expiryCalls.pick === 0, String(w.m.state.expiryCalls.pick));
    ok('no completion page, so no note anywhere', (await cpNote(page)) === null && !/預計保存/.test(await page.textContent('body')));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

}
