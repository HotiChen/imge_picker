// Browser suites (2026-10-21): 毛片自動刪除 (docs/delivery.md "Proof retention") on the pages. The Worker side is done and
// tested (worker/test/proof-retention.test.mjs); the fakes (test/lib/proof-retention-fake.mjs, pick-fake.mjs,
// dashboard-mocks.mjs) mirror its routes. Four places:
//  1. admin.html project 設定 modal: 「毛片保存」 (跟工作室 / 不自動刪 / 90 / 180 / 365 / 自訂 14–3650) -> POST .../proofs-retention
//  2. admin.html project page: the old #pd-expiry line is now the deletion status (+ 延後 30 天 / 不要刪 inside the 14-day window)
//  3. settings.html: the studio's 毛片預設保存時間 -> PUT /api/admin/settings {proof_retention_days}
//  4. the client's 完成頁: 下載毛片 entry (-> the existing proofs list) + the deletion note, from GET /api/pick/expiry `proofs`
//  5. dashboard.html: 即將刪毛片 from GET /api/admin/proofs-retention
// Dates are Taipei days whatever the browser's zone (the browser runs in America/Los_Angeles here).
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { albumWorld } from '../lib/album-world.mjs';
import { openSettings } from '../lib/project-helpers.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const DAY = 86400000;
const LA = { ...MOBILE, timezoneId: 'America/Los_Angeles' };
const ago = d => new Date(Date.now() - d * DAY).toISOString();
// the Taipei day as the pages print it: 2027 年 3 月 19 日
const dayText = iso => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(iso));
  const g = k => p.find(x => x.type === k).value;
  return `${g('year')} 年 ${g('month')} 月 ${g('day')} 日`;
};
const initAdmin = `(${ADMIN.toString()})();`;
const URL_ = `${base}/admin.html#project=proj-rt`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-rt', title: '保存專案', ownerName: 'Lin', folders: ['shoot/毛片/'],
  bucketFolders: ['shoot/', 'shoot/毛片/', 'shoot/精修/'], phase: 'retouching', deliveredAt: '2026-09-01T00:00:00.000Z',
  finalFolders: ['shoot/精修/'], ...o });
const settle = async page => {
  await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('pd-expiry') !== null && document.getElementById('pd-retention') !== null, null, { timeout: 5000 });
  await page.waitForTimeout(400);
};
const lineText = page => page.evaluate(() => { const e = document.getElementById('pd-expiry'); const t = document.getElementById('pd-expiry-text'); return e && !e.hidden && e.getClientRects().length && t ? t.textContent.trim() : null; });
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
const CONTRAST = `((el) => {
  const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const layers = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
  let bg = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
  const fg = over(parse(getComputedStyle(el).color), bg);
  const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
})`;

// ═════ 1. the 設定 modal: 毛片保存 ═════
const optionsOf = page => page.$$eval('#pd-ret-select option', os => os.map(o => [o.value, o.textContent.trim()]));
{
  const m = fx({ confirmedAt: ago(5) });
  await suite('99s retention modal — default: the 毛片保存 field lists the six choices, follows the studio (不自動刪), custom box hidden', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    ok('the field is inside the modal', await page.$eval('#pd-retention', e => !!e.closest('#pd-edit-modal') && !!e.closest('#pd-edit-modal .pd-set-sec')));
    const o = await optionsOf(page);
    ok('options: studio / never / 90 / 180 / 365 / custom', JSON.stringify(o) === JSON.stringify([['studio', '跟工作室設定（目前：不自動刪）'], ['never', '不自動刪'], ['90', '客人確認後 90 天'], ['180', '客人確認後 180 天'], ['365', '客人確認後 365 天'], ['custom', '自訂天數…']]), JSON.stringify(o));
    ok('selected: 跟工作室設定', (await page.$eval('#pd-ret-select', e => e.value)) === 'studio');
    ok('the custom box is not visible', !(await shown(page, '#pd-ret-custom')));
    await page.selectOption('#pd-ret-select', 'custom');
    ok('positive: choosing 自訂 shows the box', await shown(page, '#pd-ret-custom'));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(5), settings: { proof_retention_days: 180 } });
  await suite('99s retention modal — the studio option names the studio number (目前：180 天)', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    const o = await optionsOf(page);
    ok('跟工作室設定（目前：180 天）', o[0][1] === '跟工作室設定（目前：180 天）', JSON.stringify(o[0]));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [days, want, custom] of [[0, 'never', ''], [90, '90', ''], [365, '365', ''], [45, 'custom', '45']]) {
  const m = fx({ confirmedAt: ago(5), projectRetentionDays: days });
  await suite(`99s retention modal — the project's own ${days} days is the selected choice (${want})`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    ok(`selected ${want}`, (await page.$eval('#pd-ret-select', e => e.value)) === want, await page.$eval('#pd-ret-select', e => e.value));
    ok(want === 'custom' ? 'the custom box is shown with 45' : 'the custom box is not visible',
      want === 'custom' ? (await shown(page, '#pd-ret-custom')) && (await page.$eval('#pd-ret-custom', e => e.value)) === '45' : !(await shown(page, '#pd-ret-custom')));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [label, pick, custom, body] of [
  ['跟工作室設定 -> {days: null}', 'studio', null, { days: null }], ['不自動刪 -> {days: 0}', 'never', null, { days: 0 }],
  ['180 天 -> {days: 180}', '180', null, { days: 180 }], ['自訂 14 -> {days: 14}', 'custom', '14', { days: 14 }], ['自訂 3650 -> {days: 3650}', 'custom', '3650', { days: 3650 }]]) {
  // the starting point differs from the pick, so the save is a change
  const m = fx({ confirmedAt: ago(5), projectRetentionDays: pick === 'studio' ? 90 : 365 });
  await suite(`99s retention modal — save: ${label}, the answer redraws the field, 已儲存`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    await page.selectOption('#pd-ret-select', pick);
    if (custom !== null) await page.fill('#pd-ret-custom', custom);
    await page.click('#pd-ret-save');
    await page.waitForFunction(() => /已儲存/.test(document.getElementById('pd-ret-ok')?.textContent || ''), null, { timeout: 3000 });
    ok('exactly one POST with exactly that body', m.state.retentionPosts.length === 1 && JSON.stringify(m.state.retentionPosts[0]) === JSON.stringify(body), JSON.stringify(m.state.retentionPosts));
    ok('the field now shows the saved choice', (await page.$eval('#pd-ret-select', e => e.value)) === pick);
    ok('no error text', (await page.textContent('#pd-ret-err')).trim() === '');
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [why, raw] of [['13 (below 14)', '13'], ['3651 (above 3650)', '3651'], ['empty', ''], ['1.5 (not whole)', '1.5'], ['abc', 'abc']]) {
  const m = fx({ confirmedAt: ago(5) });
  await suite(`99s retention modal — custom ${why}: refused in the page, nothing sent`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    await page.selectOption('#pd-ret-select', 'custom');
    await page.evaluate(v => { const e = document.getElementById('pd-ret-custom'); e.removeAttribute('type'); e.value = v; }, raw);
    await page.click('#pd-ret-save');
    await page.waitForTimeout(300);
    ok('the message says 14–3650', /14[–-]3650/.test(await page.textContent('#pd-ret-err')), await page.textContent('#pd-ret-err'));
    ok('no POST', m.state.retentionPosts.length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(5), projectRetentionDays: 90 });
  await suite('99s retention modal — saving without a change says 沒有變更 and sends nothing', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    ok('fixture: 90 is selected', (await page.$eval('#pd-ret-select', e => e.value)) === '90');
    await page.click('#pd-ret-save');
    await page.waitForFunction(() => /沒有變更/.test(document.getElementById('pd-ret-ok')?.textContent || ''), null, { timeout: 3000 });
    ok('no POST', m.state.retentionPosts.length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [status, code, text] of [[409, 'retention_changed', /重新整理/], [409, 'proofs_deleted', /已.*刪除/], [400, 'invalid_body', /不正確|格式/], [500, 'proof_retention_unavailable', /尚未啟用/]]) {
  const m = fx({ confirmedAt: ago(5), retentionPostStatus: { status, body: { error: 'x', code } } });
  await suite(`99s retention modal — the Worker says ${status} ${code}: a readable message, the field keeps the choice, can retry`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    await page.selectOption('#pd-ret-select', '180');
    await page.click('#pd-ret-save');
    await page.waitForFunction(() => (document.getElementById('pd-ret-err')?.textContent || '').trim() !== '', null, { timeout: 3000 });
    const t = await page.textContent('#pd-ret-err');
    ok('the message', text.test(t), t);
    ok('it is not the raw code', !t.includes(code), t);
    ok('the choice is still 180 and the button is enabled again', (await page.$eval('#pd-ret-select', e => e.value)) === '180' && await page.$eval('#pd-ret-save', b => !b.disabled));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(5), retentionAvailable: false });
  await suite('99s retention modal — before the migration (available false): 尚未啟用, no choices, nothing to send', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    ok('the note', /尚未啟用/.test(await page.textContent('#pd-retention')), await page.textContent('#pd-retention'));
    ok('no select, no save button', (await page.$$('#pd-ret-select, #pd-ret-save')).length === 0);
    ok('positive: the other blocks of the modal are there', (await page.$$('#pd-allow-proof-dl, #pd-plan-save')).length === 2);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(200), projectRetentionDays: 90, proofsDeletedAt: ago(10) });
  await suite('99s retention modal — already deleted: the field says so and is locked', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page); await openSettings(page);
    ok('the note with the Taipei date', (await page.textContent('#pd-retention')).includes(`毛片已於 ${dayText(ago(10))} 依設定刪除`), await page.textContent('#pd-retention'));
    ok('the select is disabled (present, not absent)', await page.$eval('#pd-ret-select', e => e.disabled));
    ok('no save button is usable', (await page.$$eval('#pd-ret-save', bs => bs.filter(b => !b.disabled).length)) === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}

// ═════ 2. the project page: the deletion line ═════
{
  // confirmed 50 days ago, studio 90 -> 40 days left, outside the 14-day window
  const m = fx({ confirmedAt: ago(50), settings: { proof_retention_days: 90 } });
  await suite('99s retention line — scheduled, outside the window: 毛片將於 <Taipei day> 刪除（剩 40 天）, calm, no buttons, in the 照片 card', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    const t = await lineText(page);
    ok('the sentence', t === `毛片將於 ${dayText(new Date(Date.parse(ago(50)) + 90 * DAY).toISOString())} 刪除（剩 40 天）`, t);
    ok('it sits in the 照片 card', await page.$eval('#pd-expiry', e => !!e.closest('#pd-photos')));
    ok('calm style (no warn class)', await page.$eval('#pd-expiry', e => !e.classList.contains('pd-expiry--warn')));
    ok('no 延後 / 不要刪 buttons', (await page.$$('#pd-ret-postpone, #pd-ret-never')).length === 0);
    ok('contrast >= 4.5', (await page.$eval('#pd-expiry', new Function('return ' + CONTRAST)())) >= 4.5);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}
{
  // a fixed date through the 14-day-floor: confirmed now, studio 90 -> now+90 d, floor 2027-03-18T20:00Z is later = 2027/3/19 in Taipei
  const FLOOR = '2027-03-18T20:00:00.000Z';
  const m = fx({ confirmedAt: new Date().toISOString(), settings: { proof_retention_days: 90 }, proofsDeleteNextAt: FLOOR });
  await suite('99s retention line — the date is the Taipei day (2027 年 3 月 19 日) with the browser in Los Angeles', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    const t = await lineText(page);
    const left = Math.ceil((Date.parse(FLOOR) - Date.now()) / DAY);
    ok('the sentence', t === `毛片將於 2027 年 3 月 19 日 刪除（剩 ${left} 天）`, t);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: LA });
}
{
  // confirmed 80 days ago, studio 90 -> 10 days left: inside the window
  const m = fx({ confirmedAt: ago(80), settings: { proof_retention_days: 90 } });
  await suite('99s retention line — inside the 14-day window: warning style, 延後 30 天 and 不要刪 shown, readable', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    const t = await lineText(page);
    ok('剩 10 天', !!t && t.endsWith('刪除（剩 10 天）'), t);
    ok('warning style on', await page.$eval('#pd-expiry', e => e.classList.contains('pd-expiry--warn')));
    const b = await page.$$eval('#pd-expiry button', bs => bs.map(x => [x.id, x.textContent.trim(), x.getClientRects().length > 0, Math.round(x.getBoundingClientRect().height)]));
    ok('two buttons, in this order, both shown', JSON.stringify(b.map(x => x.slice(0, 3))) === JSON.stringify([['pd-ret-postpone', '延後 30 天', true], ['pd-ret-never', '不要刪', true]]), JSON.stringify(b));
    ok('tap targets >= 40px', b.every(x => x[3] >= 40), JSON.stringify(b));
    ok('contrast >= 4.5', (await page.$eval('#pd-expiry', new Function('return ' + CONTRAST)())) >= 4.5);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(80), settings: { proof_retention_days: 90 } });
  await suite('99s retention line — 延後 30 天: POST {action: postpone}, the line redraws (the buttons go: now 40 days left), the field follows', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    ok('fixture: the button is there first', await shown(page, '#pd-ret-postpone'));
    await page.click('#pd-ret-postpone');
    await page.waitForFunction(() => /剩 (?!10 )\d+ 天/.test(document.getElementById('pd-expiry-text')?.textContent || ''), null, { timeout: 3000 });
    ok('one POST, exactly {action: postpone}', m.state.retentionPosts.length === 1 && JSON.stringify(m.state.retentionPosts[0]) === '{"action":"postpone"}', JSON.stringify(m.state.retentionPosts));
    const t = await lineText(page);
    ok('90 + 30 = 120 days after the confirmation = 40 days left', !!t && t.endsWith('（剩 40 天）'), t);
    ok('calm again, buttons gone', (await page.$$('#pd-ret-postpone, #pd-ret-never')).length === 0 && await page.$eval('#pd-expiry', e => !e.classList.contains('pd-expiry--warn')));
    await openSettings(page);
    ok('the modal field shows the project number 自訂 120', (await page.$eval('#pd-ret-select', e => e.value)) === 'custom' && (await page.$eval('#pd-ret-custom', e => e.value)) === '120');
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(80), settings: { proof_retention_days: 90 } });
  await suite('99s retention line — 不要刪: POST {action: never}, the line goes away', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    ok('fixture: the line was shown', (await lineText(page)) !== null);
    await page.click('#pd-ret-never');
    await page.waitForFunction(() => document.getElementById('pd-expiry')?.hidden === true, null, { timeout: 3000 });
    ok('one POST, exactly {action: never}', m.state.retentionPosts.length === 1 && JSON.stringify(m.state.retentionPosts[0]) === '{"action":"never"}', JSON.stringify(m.state.retentionPosts));
    ok('no line, no buttons left', (await lineText(page)) === null && (await page.$$('#pd-ret-postpone, #pd-ret-never')).length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [status, code, text] of [[409, 'retention_too_long', /3650/], [409, 'proofs_not_scheduled', /不需要|沒有設定/], [409, 'retention_changed', /重新整理/], [500, 'proof_retention_unavailable', /尚未啟用/]]) {
  const m = fx({ confirmedAt: ago(80), settings: { proof_retention_days: 90 }, retentionPostStatus: { status, body: { error: 'x', code } } });
  await suite(`99s retention line — 延後 refused (${status} ${code}): the message is shown in the card, the buttons stay`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    await page.click('#pd-ret-postpone');
    await page.waitForFunction(() => (document.getElementById('pd-ret-line-err')?.textContent || '').trim() !== '', null, { timeout: 3000 });
    const t = await page.textContent('#pd-ret-line-err');
    ok('the message', text.test(t), t);
    ok('not the raw code', !t.includes(code), t);
    ok('the line and both buttons are still there and enabled', (await lineText(page)) !== null && (await page.$$eval('#pd-expiry button', bs => bs.length === 2 && bs.every(b => !b.disabled))));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
{
  const m = fx({ confirmedAt: ago(200), settings: { proof_retention_days: 90 }, proofsDeletedAt: '2026-10-01T00:00:00.000Z' });
  await suite('99s retention line — deleted: 毛片已於 <day> 依設定刪除, no buttons', URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    const t = await lineText(page);
    ok('the sentence', t === `毛片已於 ${dayText('2026-10-01T00:00:00.000Z')} 依設定刪除`, t);
    ok('no buttons', (await page.$$('#pd-expiry button')).length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}
for (const [why, o] of [
  ['days is 0 (the studio never deletes)', { confirmedAt: ago(50) }],
  ['not confirmed yet (no date)', { settings: { proof_retention_days: 90 } }],
  ['before the migration (available false)', { confirmedAt: ago(50), settings: { proof_retention_days: 90 }, retentionAvailable: false }],
  ['the project says 不要刪 (0)', { confirmedAt: ago(50), settings: { proof_retention_days: 90 }, projectRetentionDays: 0 }]]) {
  const m = fx(o);
  await suite(`99s retention line — ${why}: no line, no old 預計保存 text, the card still works`, URL_, async page => {
    const out = [], ok = line(out);
    await settle(page);
    ok('the retired admin /expiry route is not asked any more', m.state.expiryCalls.admin === 0, String(m.state.expiryCalls.admin));
    ok('no line', (await lineText(page)) === null && !/毛片將於|毛片已於|預計保存/.test(await page.textContent('#pd-photos')));
    ok('positive: the download button is usable', await page.$eval('#pd-download-btn', b => !b.disabled && b.getClientRects().length > 0));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}

// ═════ 3. settings.html ═════
const SET_URL = `${base}/settings.html`;
const setWait = page => page.waitForFunction(() => document.getElementById('set-save-btn') && document.getElementById('set-proof-retention'), null, { timeout: 5000 }).then(() => page.waitForTimeout(300));
{
  const m = dashSettingsMock({ settings: { studio_name: '某某' } });
  await suite('99s settings — 毛片預設保存時間: four choices, 不自動刪 by default, the one-line hint', SET_URL, async page => {
    const out = [], ok = line(out);
    await setWait(page);
    const o = await page.$$eval('#set-proof-retention option', os => os.map(x => [x.value, x.textContent.trim()]));
    ok('options', JSON.stringify(o) === JSON.stringify([['0', '不自動刪（預設）'], ['90', '客人確認後 90 天'], ['180', '客人確認後 180 天'], ['365', '客人確認後 365 天']]), JSON.stringify(o));
    ok('selected 0', (await page.$eval('#set-proof-retention', e => e.value)) === '0');
    ok('the hint', (await page.textContent('#set-proof-retention-hint')).includes('從客人按下確認完成起算；到期前 14 天會提醒你'), await page.textContent('#set-proof-retention-hint'));
    ok('label is tied to the select', (await page.$eval('label[for="set-proof-retention"]', l => l.textContent.trim())) === '毛片預設保存時間');
    return out;
  }, { before: m.attach, initScript: SEED_TOKEN, contextOptions: MOBILE });
}
{
  const m = dashSettingsMock({ settings: { studio_name: '某某', proof_retention_days: 180 } });
  await suite('99s settings — the stored 180 is selected; saving without touching it does not send proof_retention_days; changing to 90 sends 90 once', SET_URL, async page => {
    const out = [], ok = line(out);
    await setWait(page);
    ok('180 selected', (await page.$eval('#set-proof-retention', e => e.value)) === '180');
    await page.click('#set-save-btn');
    await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
    const puts = () => m.seen.filter(r => r.method === 'PUT' && r.path === '/api/admin/settings');
    ok('first PUT has no proof_retention_days', puts().length === 1 && !('proof_retention_days' in puts()[0].body), JSON.stringify(puts()[0]?.body));
    await page.selectOption('#set-proof-retention', '90');
    await page.click('#set-save-btn');
    await page.waitForTimeout(400);
    ok('second PUT carries the number 90', puts().length === 2 && puts()[1].body.proof_retention_days === 90, JSON.stringify(puts()[1]?.body));
    await page.click('#set-save-btn');
    await page.waitForTimeout(400);
    ok('third PUT (unchanged again) does not repeat it', puts().length === 3 && !('proof_retention_days' in puts()[2].body), JSON.stringify(puts()[2]?.body));
    return out;
  }, { before: m.attach, initScript: SEED_TOKEN, contextOptions: MOBILE });
}
{
  const m = dashSettingsMock({ settings: { studio_name: '某某' }, retentionMigrated: false });
  await suite('99s settings — before the migration: choosing 90 shows 尚未啟用 (the Worker says 500 proof_retention_unavailable), nothing claims 已儲存', SET_URL, async page => {
    const out = [], ok = line(out);
    await setWait(page);
    await page.selectOption('#set-proof-retention', '90');
    await page.click('#set-save-btn');
    await page.waitForFunction(() => (document.getElementById('set-err').textContent || '').trim() !== '', null, { timeout: 3000 });
    ok('the message', /尚未啟用/.test(await page.textContent('#set-err')), await page.textContent('#set-err'));
    ok('no 已儲存', (await page.textContent('#set-ok')).trim() === '');
    return out;
  }, { before: m.attach, initScript: SEED_TOKEN, contextOptions: MOBILE });
}

// ═════ 4. the client's 完成頁 ═════
const GURL = `${base}/index.html?t=TOK`;
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const cpUp = async page => {
  await page.waitForSelector('#completionPage #cpDownloadAll', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(500);
};
const cpProofs = page => page.evaluate(() => {
  const vis = e => !!e && !e.hidden && e.getClientRects().length > 0;
  const b = document.getElementById('cpProofsBtn'), n = document.getElementById('cpProofsNote');
  return { btn: vis(b) ? b.textContent.trim() : null, note: vis(n) ? n.textContent.trim() : null, soon: !!n && n.classList.contains('cp-expiry--soon'),
    all: (document.getElementById('completionPage') || document.body).innerText };
});
const PROOF_OWN = { allowProofDownload: true, confirmedAt: ago(50), settings: { proof_retention_days: 90 } };
{
  const w = albumWorld({ n: 6, fake: PROOF_OWN });
  await suite('99s 完成頁 proofs — owner, switch on, 40 days left: 下載毛片 + 毛片將於 X 刪除，要保存請先下載 in 帶回家, calm style', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    const dayAt = dayText(new Date(Date.parse(ago(50)) + 90 * DAY).toISOString());
    ok('the entry', p.btn === '下載毛片', p.btn);
    ok('the note', p.note === `毛片將於 ${dayAt} 刪除，要保存請先下載`, p.note);
    ok('calm style at 40 days', p.soon === false);
    ok('both are in the 帶回家 section, after 下載全部精修', await page.evaluate(() => { const dl = document.getElementById('cpDownload'), a = document.getElementById('cpDownloadAll'), b = document.getElementById('cpProofsBtn'), n = document.getElementById('cpProofsNote'); return dl.contains(b) && dl.contains(n) && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    ok('contrast >= 4.5', (await page.$eval('#cpProofsNote', new Function('return ' + CONTRAST)())) >= 4.5);
    ok('the expiry route was asked once', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: LA });
}
{
  const w = albumWorld({ n: 6, fake: { ...PROOF_OWN, confirmedAt: ago(80) } });
  await suite('99s 完成頁 proofs — inside the 14-day window: the note gets the more visible style, still readable', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    ok('the note is shown with the soon style', !!p.note && p.soon === true, JSON.stringify(p));
    ok('contrast >= 4.5', (await page.$eval('#cpProofsNote', new Function('return ' + CONTRAST)())) >= 4.5);
    ok('the entry is still there', p.btn === '下載毛片');
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { allowProofDownload: true } });
  await suite('99s 完成頁 proofs — can_download but nothing scheduled (the studio never deletes): the entry, no deletion note', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    ok('the entry', p.btn === '下載毛片', JSON.stringify(p));
    ok('no note, no 刪除 wording anywhere', p.note === null && !/刪除/.test(p.all), p.all);
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: PROOF_OWN });
  await suite('99s 完成頁 proofs — 下載毛片 opens the existing proofs list (回到毛片 path); ← 回精修成品 comes back to the 完成頁', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    await page.click('#cpProofsBtn');
    await page.waitForFunction(() => !document.getElementById('completionPage') && document.getElementById('deliveryProofsBtn')?.textContent.trim() === '← 回精修成品', null, { timeout: 5000 });
    ok('the 完成頁 is gone, the proofs bar says ← 回精修成品', true);
    await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
    ok('the proof photo is listed (the one proof file a.jpg)', (await page.$$('#photoGrid .photo-card')).length === 1);
    ok('its title says 毛片', /毛片/.test(await page.textContent('#deliveryTitle')), await page.textContent('#deliveryTitle'));
    await page.click('#deliveryProofsBtn');
    await cpUp(page);
    ok('back: the 完成頁 and its entry', (await cpProofs(page)).btn === '下載毛片');
    ok('the expiry route was not asked again (one per page load)', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { ...PROOF_OWN, allowProofDownload: false } });
  await suite('99s 完成頁 proofs — the switch is off (can_download false): nothing about proofs, the page works', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    ok('the expiry route was asked (the guard ran)', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    ok('no entry, no note, no 毛片 text', p.btn === null && p.note === null && !/毛片/.test(p.all), JSON.stringify(p));
    ok('positive: 下載全部精修 is enabled', await page.$eval('#cpDownloadAll', b => !b.disabled && b.getClientRects().length > 0));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: PROOF_OWN });
  await suite('99s 完成頁 proofs — a viewer (not the seat owner) gets nothing about proofs', GURL, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#completionPage #cpDownloadAll', { timeout: 5000 });
    await page.waitForTimeout(600);
    const p = await cpProofs(page);
    ok('the expiry route was asked', w.m.state.expiryCalls.pick === 1, String(w.m.state.expiryCalls.pick));
    ok('no entry, no note', p.btn === null && p.note === null && !/毛片/.test(p.all), JSON.stringify(p));
    return out;
  }, { before: w.before, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { ...PROOF_OWN, projectRetentionDays: 90, proofsDeletedAt: ago(3) } });
  await suite('99s 完成頁 proofs — deleted: 毛片已依設定刪除 for the owner, no download entry', GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    ok('the deleted note', p.note === '毛片已依設定刪除', JSON.stringify(p));
    ok('no entry', p.btn === null);
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { ...PROOF_OWN, projectRetentionDays: 90, proofsDeletedAt: ago(3) } });
  await suite('99s 完成頁 proofs — deleted, seen by a viewer: nothing', GURL, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#completionPage #cpDownloadAll', { timeout: 5000 });
    await page.waitForTimeout(600);
    const p = await cpProofs(page);
    ok('asked', w.m.state.expiryCalls.pick === 1);
    ok('no note, no entry', p.btn === null && p.note === null && !/毛片/.test(p.all), JSON.stringify(p));
    return out;
  }, { before: w.before, contextOptions: MOBILE });
}
for (const [why, fake] of [['500', { ...PROOF_OWN, expiryFail: 500 }], ['the connection drops', { ...PROOF_OWN, expiryFail: 'net' }]]) {
  const w = albumWorld({ n: 6, fake });
  await suite(`99s 完成頁 proofs — the expiry request fails (${why}): nothing, the page works`, GURL, async page => {
    const out = [], ok = line(out);
    await cpUp(page);
    const p = await cpProofs(page);
    ok('asked', w.m.state.expiryCalls.pick === 1);
    ok('no entry, no note', p.btn === null && p.note === null && !/毛片/.test(p.all), JSON.stringify(p));
    ok('positive: 下載全部精修 is enabled', await page.$eval('#cpDownloadAll', b => !b.disabled && b.getClientRects().length > 0));
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = albumWorld({ n: 6, fake: { ...PROOF_OWN, confirmedAt: null } });
  await suite('99s 驗收頁 (delivered, not confirmed) — no expiry request, no proofs note (positive: the page is up)', GURL, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
    await page.waitForSelector('#deliveryDone', { timeout: 5000 });
    await page.waitForTimeout(400);
    ok('never asked', w.m.state.expiryCalls.pick === 0, String(w.m.state.expiryCalls.pick));
    ok('no 下載毛片 entry on the page (the 驗收頁 has its own 回到毛片)', (await page.$$('#cpProofsBtn, #cpProofsNote')).length === 0);
    ok('positive: 回到毛片 is there', (await page.textContent('#deliveryProofsBtn')).trim() === '回到毛片');
    return out;
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ 5. dashboard.html ═════
const DASH_URL = `${base}/dashboard.html`;
const dashUp = async page => { await page.waitForFunction(() => !/載入中/.test(document.getElementById('todo-list').textContent), null, { timeout: 5000 }); await page.waitForTimeout(400); };
{
  const soon = new Date(Date.now() + 5 * DAY).toISOString(), sooner = new Date(Date.now() + 2 * DAY).toISOString();
  const m = dashSettingsMock({ upcoming: [
    { id: 'p-b', title: '二號專案', proofs_delete_at: sooner, days_left: 2, days: 90, source: 'studio' },
    { id: 'p-a', title: '一號 <b>專案</b>', proofs_delete_at: soon, days_left: 5, days: 180, source: 'project' }] });
  await suite('99s dashboard — 即將刪毛片 lists the Worker\'s upcoming projects in its order, each linking to the project, dates in Taipei', DASH_URL, async page => {
    const out = [], ok = line(out);
    await dashUp(page);
    await page.waitForSelector('#retention-sec:not([hidden])', { timeout: 3000 });
    const rows = await page.$$eval('#retention-list li', ls => ls.map(l => ({ id: l.dataset.retention, text: l.querySelector('span').textContent.trim(), href: l.querySelector('a').getAttribute('href') })));
    ok('two rows in the Worker\'s order', rows.length === 2 && rows[0].id === 'p-b' && rows[1].id === 'p-a', JSON.stringify(rows));
    ok('row 1 text', rows[0].text === `二號專案　毛片將於 ${dayText(sooner)} 刪除（剩 2 天）`, rows[0].text);
    ok('the title is text, not HTML', rows[1].text.startsWith('一號 <b>專案</b>') && (await page.$$('#retention-list b')).length === 0, rows[1].text);
    ok('links to the project page', rows[0].href === 'admin.html#project=p-b' && rows[1].href === 'admin.html#project=p-a', JSON.stringify(rows.map(r => r.href)));
    ok('the heading', (await page.textContent('#retention-sec h2')).trim() === '即將刪毛片');
    ok('positive: the 待處理 list rendered too', (await page.$$('#todo-list li')).length >= 1);
    return out;
  }, { before: m.attach, initScript: SEED_TOKEN, contextOptions: LA });
}
for (const [why, o] of [['an empty upcoming list', {}], ['before the migration', { retentionMigrated: false }], ['the request fails (500)', { retentionStatus: 500 }]]) {
  const m = dashSettingsMock(o);
  await suite(`99s dashboard — ${why}: no 即將刪毛片 section, the rest of the page works`, DASH_URL, async page => {
    const out = [], ok = line(out);
    await dashUp(page);
    ok('the route was asked (the guard ran)', m.seen.some(r => r.path === '/api/admin/proofs-retention'));
    ok('section not visible', !(await shown(page, '#retention-sec')) && (await page.$$('#retention-list li')).length === 0);
    ok('positive: the 待處理 list is up', (await page.textContent('#todo-list')).trim() !== '');
    return out;
  }, { before: m.attach, initScript: SEED_TOKEN, contextOptions: MOBILE });
}

}
