// Browser suite: the default message sent to a client with the pick link is editable in 設定 (settings.html
// 「傳給客人的選片訊息」, studio_settings.pick_link_message) and used by admin.html's 傳給客人 dialog. The fakes mirror the
// Worker answers (test/lib/dashboard-mocks.mjs, test/lib/pick-fake.mjs). Chromium only; a real iPhone / LINE still has to look at it.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN_ALWAYS, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const DEFAULT = '{專案名稱} 的選片連結來囉 😊\n{連結}\n\n麻煩用手機點開連結，慢慢挑喜歡的照片，選好之後按「完成提交」，我就會收到了。\n（請由負責選片的人先打開連結喔）';
const ADMIN_SRC = `(${ADMIN.toString()})();`;
const CLIP = `${ADMIN_SRC}
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const TITLE = '王小明 & 陳小美 婚紗';
const dlgWorld = (settings, extra = {}) => pickFakeWorker({ projectId: 'proj-pl', title: TITLE, ownerName: 'Zoe', folders: ['shoot/毛片/'], phase: 'picking', listToken: 'PL-TOK', settings, ...extra });
const openDialog = async page => {
  await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
  await page.waitForTimeout(300);   // let the settings fetch settle
  await page.click('[data-project-row] [data-copy-link]');
  await page.waitForSelector('#pd-share-link', { timeout: 3000 });
  return page.$eval('#sl-text', e => e.value);
};
const puts = m => m.seen.filter(s => s.method === 'PUT' && s.path === '/api/admin/settings');
const save = async page => { await page.click('#set-save-btn'); await page.waitForFunction(() => document.getElementById('set-ok').textContent || document.getElementById('set-err').textContent, null, { timeout: 3000 }); };
const setVal = (page, v) => page.evaluate(x => { const t = document.getElementById('set-pick-link-message'); t.value = x; t.dispatchEvent(new Event('input', { bubbles: true })); }, v);

// ═════════ settings ═════════
{
  const SAVED = '{專案名稱} 你好\n連結：{連結}\n謝謝';
  const m = dashSettingsMock({ settings: { pick_link_message: SAVED } });
  await suite('57 選片訊息 settings — 載入、計數、預覽（純文字）、只在改過時送出、限 1000 字',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-pick-link-message', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('set-pick-link-message').value !== '', null, { timeout: 3000 });
      const val = () => page.$eval('#set-pick-link-message', e => e.value);
      const count = async () => (await page.textContent('#set-pick-link-count')).replace(/\s/g, '');
      ok('the saved template is loaded, line breaks kept', (await val()) === SAVED, await val());
      ok('the label names the field', (await page.textContent('label[for="set-pick-link-message"]')).includes('傳給客人的選片訊息'));
      ok('maxlength 1000', (await page.getAttribute('#set-pick-link-message', 'maxlength')) === '1000');
      ok('a counter shows N/1000', (await count()) === `${[...SAVED].length}/1000`, await count());
      const hint = await page.evaluate(() => document.getElementById('set-pick-link-message').closest('.field-group').textContent);
      ok('the hint lists both placeholders and the auto-append rule', hint.includes('{專案名稱}') && hint.includes('{連結}') && hint.includes('沒寫 {連結} 的話，系統會自動把連結加在最後'), hint);
      const pv = () => page.$eval('#set-pick-link-preview', e => e.textContent);
      ok('the preview shows sample values in place of the placeholders', (await pv()).includes('王小明 & 陳小美 婚紗 你好') && /連結：https:\/\/\S+/.test(await pv()) && !(await pv()).includes('{'), await pv());
      ok('positive: the preview box is visible', await page.$eval('#set-pick-link-preview', e => e.getBoundingClientRect().height > 20));
      await setVal(page, '<img src=x onerror="window.__pwn=1"> {連結}');
      await page.waitForTimeout(100);
      ok('the preview is plain text (no element made, nothing ran)', await page.evaluate(() => window.__pwn === undefined && !document.querySelector('#set-pick-link-preview img')));
      ok('the preview shows the typed tag as text', (await pv()).includes('<img src=x'), await pv());
      await setVal(page, SAVED);
      await page.click('#set-save-btn'); await page.waitForFunction(() => document.getElementById('set-ok').textContent, null, { timeout: 3000 });
      ok('saving other settings without touching the text does NOT name pick_link_message', puts(m).length === 1 && !('pick_link_message' in puts(m)[0].body), JSON.stringify(puts(m)));
      const next = '嗨 {專案名稱}\n{連結}\n\n加油';
      await page.fill('#set-pick-link-message', next);
      ok('the counter follows the typing', (await count()) === `${[...next].length}/1000`);
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('a changed text is sent with its line breaks intact', puts(m).length === 2 && puts(m)[1].body.pick_link_message === next, JSON.stringify(puts(m)[1]?.body));
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('saved again unchanged → not named again', puts(m).length === 3 && !('pick_link_message' in puts(m)[2].body), JSON.stringify(puts(m)[2]?.body));
      await setVal(page, 'あ'.repeat(1001));
      ok('1001 characters: the counter shows it and turns the error colour', (await count()) === '1001/1000' && (await page.$eval('#set-pick-link-count', e => getComputedStyle(e).color)) === 'rgb(192, 57, 43)', await count());
      const before = puts(m).length;
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('1001 is refused before any request', puts(m).length === before && (await page.textContent('#set-err')).includes('1000'), await page.textContent('#set-err'));
      await setVal(page, 'あ'.repeat(1000));
      ok('1000 shows 1000/1000 not red', (await count()) === '1000/1000' && (await page.$eval('#set-pick-link-count', e => getComputedStyle(e).color)) !== 'rgb(192, 57, 43)');
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; document.getElementById('set-err').textContent = ''; });
      await save(page);
      ok('exactly 1000 characters is sent', puts(m).length === before + 1 && [...puts(m).at(-1).body.pick_link_message].length === 1000, String(puts(m).length));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}

{
  const m = dashSettingsMock({ settings: { pick_link_message: '舊的 {連結}' } });
  await suite('57 選片訊息 settings — 還原預設 / 清空：存成 null（不是文字）；預設值也存成 null',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForFunction(() => document.getElementById('set-pick-link-message')?.value === '舊的 {連結}', null, { timeout: 5000 });
      const val = () => page.$eval('#set-pick-link-message', e => e.value);
      ok('positive: the 還原預設 button exists', (await page.textContent('#set-pick-link-reset')).includes('還原預設'));
      await page.click('#set-pick-link-reset');
      ok('還原預設 fills the built-in default', (await val()) === DEFAULT, await val());
      ok('the counter follows', (await page.textContent('#set-pick-link-count')).replace(/\s/g, '') === `${[...DEFAULT].length}/1000`);
      ok('the preview shows the default with the sample title', (await page.textContent('#set-pick-link-preview')).includes('王小明 & 陳小美 婚紗 的選片連結來囉 😊'));
      await save(page);
      ok('saving the default sends null (stored as null, not as text)', puts(m).length === 1 && puts(m)[0].body.pick_link_message === null, JSON.stringify(puts(m)[0]?.body));
      ok('the fake now stores null', m.state.settings.pick_link_message === null);
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('saving again unchanged names nothing', puts(m).length === 2 && !('pick_link_message' in puts(m)[1].body), JSON.stringify(puts(m)[1]?.body));
      await setVal(page, '又改 {連結}');
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('a custom text is sent', puts(m).at(-1).body.pick_link_message === '又改 {連結}');
      await setVal(page, '   ');
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      ok('a blank text clears (null)', puts(m).at(-1).body.pick_link_message === null && m.state.settings.pick_link_message === null, JSON.stringify(puts(m).at(-1).body));
      ok('the preview of a blank box is the default', (await page.textContent('#set-pick-link-preview')).includes('選片連結來囉'));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}

{
  const m = dashSettingsMock({ settings: { pick_link_message: null } });
  await suite('57 選片訊息 settings — 沒設定時文字框顯示預設值；沒動它儲存不會送出',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForFunction(() => document.getElementById('set-pick-link-message')?.value.includes('選片連結來囉'), null, { timeout: 5000 });
      ok('null shows the built-in default', (await page.$eval('#set-pick-link-message', e => e.value)) === DEFAULT);
      await page.waitForFunction(() => document.getElementById('set-name') || true);
      await save(page);
      ok('untouched → not named', puts(m).length === 1 && !('pick_link_message' in puts(m)[0].body), JSON.stringify(puts(m)[0]?.body));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}

{
  const m = dashSettingsMock({ settings: {} });
  await suite('57 選片訊息 settings — 錯誤說人話：invalid_pick_link_message、migration 還沒跑（500）',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-pick-link-message', { timeout: 5000 });
      await page.fill('#set-pick-link-message', '壞\u0001字元 {連結}');
      await save(page);
      const e1 = await page.textContent('#set-err');
      ok('invalid_pick_link_message → a Chinese sentence, not the raw code', e1.includes('訊息格式不正確（1000 字以內，不可含特殊控制字元）') && !/invalid_pick_link_message/.test(e1), e1);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}
{
  const m = dashSettingsMock({ pickLinkMigrated: false });
  await suite('57 選片訊息 settings — migration 還沒跑：500 說明要執行哪個 migration；不動這欄的儲存照常成功',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-pick-link-message', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('set-pick-link-message').value.includes('選片連結來囉'), null, { timeout: 3000 });
      await save(page);
      ok('a save that leaves the field alone works', (await page.textContent('#set-ok')).includes('已儲存') && puts(m).length === 1 && !('pick_link_message' in puts(m)[0].body), await page.textContent('#set-err'));
      await page.fill('#set-pick-link-message', '新的 {連結}');
      await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; });
      await save(page);
      const e = await page.textContent('#set-err');
      ok('the 500 is explained with the migration name', e.includes('這個設定還沒啟用，請先執行 migration（2026-10-10-pick-link-message.sql）') && !/pick_link_message_unavailable/.test(e), e);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}

// ═════════ dialog ═════════
{
  const m = dlgWorld({ pick_link_message: '嗨 {專案名稱}！\n{連結}\n再說一次：{專案名稱} {連結}' });
  await suite('57 選片訊息 dialog — 用存好的樣板：每個佔位符都換掉、標題的 $& 照字面、可編輯、複製的是目前的文字',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      const link = text.match(/https?:\/\/\S*index\.html\?t=PL-TOK/)?.[0];
      ok('positive: a pick link is in the text', !!link, text);
      ok('every placeholder in the template is replaced (both occurrences of each)', text === `嗨 ${TITLE}！\n${link}\n再說一次：${TITLE} ${link}`, text);
      ok('no placeholder is left', !text.includes('{'));
      ok('the textarea is editable now', (await page.$eval('#sl-text', e => !e.readOnly && !e.disabled)));
      const hint = await page.$eval('#pd-share-link', e => ({ t: e.textContent, href: e.querySelector('a')?.getAttribute('href') }));
      ok('a line says the default text can be changed in 設定, with a link to settings.html', hint.t.includes('預設文字可以在「設定」裡修改') && hint.href === 'settings.html', JSON.stringify(hint));
      await page.fill('#sl-text', '改過的一句話 ' + link);
      await page.click('#sl-copy-btn');
      await page.waitForFunction(() => window.__clip.length === 2, null, { timeout: 3000 });
      const clip = await page.evaluate(() => window.__clip);
      ok('the first copy (at the click) is the link alone', clip[0] === link, JSON.stringify(clip));
      ok('複製 copies the CURRENT (edited) text, not the original', clip[1] === '改過的一句話 ' + link, JSON.stringify(clip[1]));
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
{
  const T = 'A$&B$1$`C';
  const m = dlgWorld({ pick_link_message: '{專案名稱}|{連結}' }, { title: T });
  await suite('57 選片訊息 dialog — 專案名稱含 $& / $1 / $` 也照字面放進去',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      ok('the title is inserted verbatim', text.startsWith(T + '|http'), text);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
{
  const m = dlgWorld({ pick_link_message: '{專案名稱} 的連結，請收好' });
  await suite('57 選片訊息 dialog — 樣板沒寫 {連結}：連結加在最後一行',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      ok('the title is replaced and the link is appended on a new line at the end', text.startsWith(`${TITLE} 的連結，請收好\n`) && /\nhttps?:\/\/\S*index\.html\?t=PL-TOK$/.test(text), text);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
{
  const m = dlgWorld({ pick_link_message: '   \n ' });
  await suite('57 選片訊息 dialog — 樣板是空白：用預設文字',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      const link = text.match(/https?:\/\/\S*index\.html\?t=PL-TOK/)?.[0];
      ok('the built-in default with title and link', !!link && text === DEFAULT.replace('{專案名稱}', TITLE).replace('{連結}', link), text);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
{
  const m = dlgWorld({}, { settingsGetStatus: 500 });
  await suite('57 選片訊息 dialog — 讀不到設定（500）：照樣開窗，用預設文字',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      const link = text.match(/https?:\/\/\S*index\.html\?t=PL-TOK/)?.[0];
      ok('default text, dialog opened', !!link && text === DEFAULT.replace('{專案名稱}', TITLE).replace('{連結}', link), text);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
{
  const m = dlgWorld({ pick_link_message: null });
  await suite('57 選片訊息 dialog — 樣板是 null（沒設定）：用預設文字',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      const text = await openDialog(page);
      ok('the default message', text.includes(`${TITLE} 的選片連結來囉 😊`) && text.includes('（請由負責選片的人先打開連結喔）'), text);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}

// ═════════ 390px ═════════
{
  const m = dashSettingsMock({ settings: { pick_link_message: '嗨 {專案名稱}\n{連結}' } });
  await suite('57 選片訊息 390px — settings：文字框、計數、預覽、還原預設在螢幕內，按鈕 ≥44px',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForFunction(() => document.getElementById('set-pick-link-message')?.value !== '', null, { timeout: 5000 });
      const r = await page.evaluate(() => { const g = id => document.getElementById(id).getBoundingClientRect();
        const t = g('set-pick-link-message'), c = g('set-pick-link-count'), p = g('set-pick-link-preview'), b = g('set-pick-link-reset');
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, tl: t.left, tr: t.right, cr: c.right, pl: p.left, pr: p.right, ph: p.height, bh: b.height, bw: b.width, br: b.right }; });
      ok('no horizontal scroll', r.sw <= r.iw, JSON.stringify(r));
      ok('textarea and preview sit inside the 16px gutter', r.tl >= 15 && r.tr <= r.iw - 15 && r.pl >= 15 && r.pr <= r.iw - 15 && r.cr <= r.iw && r.ph > 20, JSON.stringify(r));
      ok('還原預設 is at least 44px tall and inside the screen', r.bh >= 44 && r.bw >= 44 && r.br <= r.iw, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS, contextOptions: MOBILE });
}
{
  const m = dlgWorld({ pick_link_message: '嗨 {專案名稱}\n{連結}' });
  await suite('57 選片訊息 390px — 傳給客人視窗：沒有橫向捲動，按鈕 ≥44px，設定連結可按',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line();
      await openDialog(page);
      const r = await page.evaluate(() => { const g = e => e.getBoundingClientRect(), box = g(document.querySelector('#pd-share-link [role="dialog"]')),
        ta = g(document.getElementById('sl-text')), c = g(document.getElementById('sl-copy-btn')), x = g(document.getElementById('sl-close-btn')), a = g(document.querySelector('#pd-share-link a'));
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, bl: box.left, br: box.right, tl: ta.left, tr: ta.right, ch: c.height, xh: x.height, ah: a.height, aw: a.width, ar: a.right }; });
      ok('no horizontal scroll', r.sw <= r.iw, JSON.stringify(r));
      ok('dialog and textarea inside the screen', r.bl >= 0 && r.br <= r.iw && r.tl >= 0 && r.tr <= r.iw, JSON.stringify(r));
      ok('copy and close buttons are at least 44px tall', r.ch >= 44 && r.xh >= 44, JSON.stringify(r));
      ok('the settings link is a real tap target (≥44px tall) inside the screen', r.ah >= 44 && r.ar <= r.iw, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: CLIP, contextOptions: MOBILE });
}
}
