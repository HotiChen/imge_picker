// Browser suite (2026-10-20): 照片保存期限 (docs/delivery.md, "Photo expiry"): R2 deletes every object 180 days after
// its upload. The photographer's project page shows one line in the 照片 card and the 複製交件通知文案 text carries the
// finals' date; the client's 完成頁 shows the date next to 下載全部精修. Dates are read in Asia/Taipei whatever the
// browser's zone (the suites run the page in America/Los_Angeles, where the UTC day and the Taipei day differ).
// The fake Worker (test/lib/pick-fake.mjs expiryOfFake) answers both routes exactly like the real one, incl. null.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { albumWorld } from '../lib/album-world.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const DAY = 86400000;
const LA = { ...MOBILE, timezoneId: 'America/Los_Angeles' };
const URL_ = `${base}/admin.html#project=proj-ex`;
const CLIP = `(() => { window.__clip = []; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__clip.push(t); return Promise.resolve(); } }, configurable: true }); } catch (e) {} })();`;
const initAdmin = `(${ADMIN.toString()})();${CLIP}`;
// 2026-09-19T20:00Z + 180 d = 2027-03-18T20:00Z = 2027/3/19 04:00 in Taipei (but still the 18th in UTC and in Los Angeles)
const EDGE_UPLOADED = '2026-09-19T20:00:00.000Z';
const EDGE_TEXT = '2027 年 3 月 19 日';
// an upload time that makes the photos expire `days` whole days from now, less an hour (so ceil() gives exactly `days`)
const uploadedFor = days => new Date(Date.now() + days * DAY - 3600000 - 180 * DAY).toISOString();
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-ex', title: '期限專案', ownerName: 'Lin', folders: ['shoot/毛片/'],
  bucketFolders: ['shoot/', 'shoot/毛片/', 'shoot/精修/'], ...o });
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] };
const expiryText = page => page.evaluate(() => { const e = document.getElementById('pd-expiry'); return e && !e.hidden && e.getClientRects().length ? e.textContent.trim() : null; });
const settle = async (page, m) => {            // the head is up and the expiry request has been answered (or failed)
  await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('pd-expiry') !== null, null, { timeout: 5000 });
  await page.waitForTimeout(500);
};
// contrast ratio of an element's text against the page behind it (opaque layers composited)
const CONTRAST = `((el) => {
  const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const layers = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
  let bg = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
  const fg = over(parse(getComputedStyle(el).color), bg);
  const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
})`;

// ═════ admin: the line in the 照片 card ═════
{
  // delivered: the FINALS date is used, not the proofs' (the two differ)
  const m = fx({ ...DELIVERED, expiryUploaded: { proofs: uploadedFor(400 - 180 + 5), finals: EDGE_UPLOADED } });
  await suite('99p expiry admin — delivered: the line uses the finals date (Taipei day, browser in Los Angeles) and the days left', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    const t = await expiryText(page);
    const left = Math.ceil((Date.parse('2027-03-18T20:00:00.000Z') - Date.now()) / DAY);
    ok('the line says 照片預計保存到 2027 年 3 月 19 日（剩 N 天）', t === `照片預計保存到 ${EDGE_TEXT}（剩 ${left} 天）`, t);
    ok('it sits in the 照片 card', await page.$eval('#pd-expiry', e => !!e.closest('#pd-photos')));
    ok('asked once for this page load', m.state.expiryCalls.admin === 1, String(m.state.expiryCalls.admin));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}
{
  // not delivered (finals kept or not): the proofs' date
  const m = fx({ expiryUploaded: { proofs: EDGE_UPLOADED, finals: uploadedFor(3) }, finalFolders: ['shoot/精修/'] });
  await suite('99p expiry admin — not delivered: the line uses the proofs date even when final_folders is set', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    ok('fixture: final_folders is set and delivered_at is not', m.state.project.final_folders && !m.state.project.delivered_at);
    const t = await expiryText(page);
    ok('the proofs date (not the 3-day finals one)', !!t && t.includes(`照片預計保存到 ${EDGE_TEXT}（剩 `), t);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}
for (const [days, warn] of [[31, false], [30, true], [1, true]]) {
  const m = fx({ expiryUploaded: { proofs: uploadedFor(days) } });
  await suite(`99p expiry admin — ${days} days left: ${warn ? 'warning style' : 'normal style'}, text readable (>= 4.5:1)`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    const t = await expiryText(page);
    ok(`the line shows 剩 ${days} 天`, !!t && t.endsWith(`（剩 ${days} 天）`), t);
    const look = await page.$eval('#pd-expiry', e => ({ warn: e.classList.contains('pd-expiry--warn'), weight: getComputedStyle(e).fontWeight, color: getComputedStyle(e).color }));
    ok(warn ? 'warning style is on' : 'warning style is off', look.warn === warn, JSON.stringify(look));
    const ratio = await page.$eval('#pd-expiry', new Function('return ' + CONTRAST)());
    ok('contrast >= 4.5', ratio >= 4.5, String(ratio));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ expiryUploaded: { proofs: new Date(Date.now() - 181 * DAY).toISOString() } });
  await suite('99p expiry admin — past the date: 已超過預計保存期限，檔案可能已被刪除 (no date, no days)', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    const t = await expiryText(page);
    ok('the past wording', t === '已超過預計保存期限，檔案可能已被刪除', t);
    ok('warning style', await page.$eval('#pd-expiry', e => e.classList.contains('pd-expiry--warn')));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ expiryUploaded: { proofs: uploadedFor(100) }, expiryTruncated: true });
  await suite('99p expiry admin — truncated scan: （估計） is added', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    const t = await expiryText(page);
    ok('the line ends with （估計）', !!t && t.startsWith('照片預計保存到 ') && t.endsWith('（剩 100 天）（估計）'), t);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [why, o] of [['no photos (date null)', {}], ['the request fails with 500', { expiryFail: 500, expiryUploaded: { proofs: uploadedFor(10) } }],
  ['the connection drops', { expiryFail: 'net', expiryUploaded: { proofs: uploadedFor(10) } }]]) {
  const m = fx(o);
  await suite(`99p expiry admin — ${why}: no line, the page still works`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    ok('the expiry route was asked (the guard under test ran)', m.state.expiryCalls.admin === 1, String(m.state.expiryCalls.admin));
    ok('nothing shown, no 預計保存 text anywhere in the 照片 card', (await expiryText(page)) === null && !/預計保存|超過預計/.test(await page.textContent('#pd-photos')));
    ok('positive: the card is there and its download button is usable', await page.$eval('#pd-download-btn', b => !b.disabled && b.getClientRects().length > 0));
    ok('positive: the ⋯ menu opens', await page.click('#pd-more-btn').then(() => page.$eval('#pd-more-menu', e => !e.hidden)));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}

// ═════ admin: 複製交件通知文案 ═════
{
  const m = fx({ ...DELIVERED, expiryUploaded: { finals: EDGE_UPLOADED, proofs: uploadedFor(5) } });
  await suite('99p expiry notice — the copied text carries the finals date, on its own line, after the usual text', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    await page.click('#pd-more-btn');
    await page.click('#pd-copy-notice-btn');
    await page.waitForFunction(() => window.__clip.length === 1, null, { timeout: 3000 });
    const text = await page.evaluate(() => window.__clip[0]);
    ok('the usual text is still there', /的成品已經完成/.test(text) && /確認完成/.test(text), text);
    ok(`it says 精修預計保存到 ${EDGE_TEXT}，請在這之前下載保存`, text.includes(`精修預計保存到 ${EDGE_TEXT}，請在這之前下載保存`), text);
    ok('the proofs date (5 days) is not used', !text.includes('剩'), text);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}
for (const [why, o] of [['the expiry request fails', { expiryFail: 500 }], ['the finals folders hold no photos', { expiryUploaded: {} }]]) {
  const m = fx({ ...DELIVERED, ...o });
  await suite(`99p expiry notice — ${why}: the copy still works, exactly the old text`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page, m);
    await page.click('#pd-more-btn');
    await page.click('#pd-copy-notice-btn');
    await page.waitForFunction(() => window.__clip.length === 1, null, { timeout: 3000 });
    const text = await page.evaluate(() => window.__clip[0]);
    ok('copied the notice', /的成品已經完成/.test(text), text);
    ok('no 預計保存 sentence', !/預計保存/.test(text), text);
    ok('the status says 已複製', (await page.textContent('#pd-copy-notice-status')).trim() === '已複製');
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
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
for (const [days, soon] of [[31, false], [30, true]]) {
  const w = albumWorld({ n: 6, fake: { expiryUploaded: { finals: uploadedFor(days) } } });
  await suite(`99p expiry 完成頁 — ${days} days left: the date next to 下載全部精修, ${soon ? 'more visible style' : 'calm style'}`, GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const t = await cpNote(page);
    const d = new Date(Date.now() + days * DAY - 3600000);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
    const g = k => p.find(x => x.type === k).value;
    ok('the sentence with the Taipei date', t === `照片預計保存到 ${g('year')} 年 ${g('month')} 月 ${g('day')} 日，請在這之前下載保存`, t);
    ok('it is in the 帶回家 section, after the 下載全部精修 button', await page.evaluate(() => { const dl = document.getElementById('cpDownload'), b = document.getElementById('cpDownloadAll'), n = document.getElementById('cpExpiry'); return dl.contains(n) && dl.contains(b) && !!(b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    ok(soon ? 'soon style on' : 'soon style off', await page.$eval('#cpExpiry', e => e.classList.contains('cp-expiry--soon')) === soon);
    ok('contrast >= 4.5', (await page.$eval('#cpExpiry', new Function('return ' + CONTRAST)())) >= 4.5);
    ok('asked once', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    ok('not scary: no 警告 / 危險 wording', !/警告|危險|刪除/.test(t));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: LA });
}
{
  const w = albumWorld({ n: 6, fake: { expiryUploaded: { finals: EDGE_UPLOADED } } });
  await suite('99p expiry 完成頁 — the date is the Taipei day (browser in Los Angeles)', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    ok(`says ${EDGE_TEXT}`, (await cpNote(page)) === `照片預計保存到 ${EDGE_TEXT}，請在這之前下載保存`, await cpNote(page));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: LA });
}
for (const [why, fake] of [['no date (null from the Worker)', {}], ['the request fails with 500', { expiryFail: 500, expiryUploaded: { finals: uploadedFor(5) } }],
  ['the connection drops', { expiryFail: 'net', expiryUploaded: { finals: uploadedFor(5) } }]]) {
  const w = albumWorld({ n: 6, fake });
  await suite(`99p expiry 完成頁 — ${why}: nothing shown, the page still works`, GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    ok('the expiry route was asked (the guard under test ran)', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    ok('no note', (await cpNote(page)) === null && !/預計保存/.test(await page.textContent('#completionPage')));
    ok('positive: 下載全部精修 is enabled and the gallery is up', await page.$eval('#cpDownloadAll', b => !b.disabled && b.getClientRects().length > 0));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { confirmedAt: null, expiryUploaded: { finals: uploadedFor(5) } } });
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
