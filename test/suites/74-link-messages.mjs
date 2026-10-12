// Browser suites: the 複製連結 message depends on the project's stage (選片中 / 已送出·精修中 / 已交件 / 已完成), four templates in
// 設定 (pick_link_message, link_message_submitted / _delivered / _done). Fakes mirror the Worker (test/lib/pick-fake.mjs,
// test/lib/dashboard-mocks.mjs). Chromium only; a real iPhone / LINE clipboard is not covered.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN_ALWAYS, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const CLIP = `(${ADMIN.toString()})();
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const iso = '2026-09-01T00:00:00.000Z';
const DEF = {
  pick: '{專案名稱} 的選片連結來囉 😊\n{連結}\n\n麻煩用手機點開連結，慢慢挑喜歡的照片，選好之後按「完成提交」，我就會收到了。\n（請由負責選片的人先打開連結喔）',
  submitted: '{專案名稱} 的選片我收到囉 😊\n我會開始精修，完成後會再通知你。\n\n你也可以從這個連結看目前的狀態：\n{連結}',
  delivered: '{專案名稱} 的精修照片完成囉 ✨\n{連結}\n\n請點開連結看看，有想調整的地方可以在照片上標記並送出修改；都沒問題的話，請按「確認完成」。',
  done: '謝謝你的信任 🙏\n這是 {專案名稱} 的完成頁，可以回顧精修照片，也能看相簿和商品資訊：\n{連結}',
};
const FIELD = { pick: 'pick_link_message', submitted: 'link_message_submitted', delivered: 'link_message_delivered', done: 'link_message_done' };
const fill = (t, title, tok) => t.replaceAll('{專案名稱}', title).replaceAll('{連結}', `LINK:${tok}`);
const SAVED = {
  pick_link_message: 'PICK {專案名稱} {連結}',
  link_message_submitted: 'SUBM {專案名稱} {連結}',
  link_message_delivered: 'DELI {專案名稱} {連結}',
  link_message_done: 'DONE {專案名稱} {連結}',
};
// one project per stage; hand-written expectation: tok -> stage
const ROWS = [
  { id: 'p-sub', title: 'S 已送出', phase: 'submitted', token: 'S-TOK' },
  { id: 'p-ret', title: 'R 精修中', phase: 'retouching', token: 'R-TOK' },
  { id: 'p-del', title: 'D 已交件', phase: 'retouching', delivered_at: iso, token: 'D-TOK' },
  { id: 'p-rev', title: 'V 待修改', phase: 'retouching', delivered_at: iso, open_revision_count: 2, token: 'V-TOK' },
  { id: 'p-con', title: 'C 客戶確認', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'guest', token: 'C-TOK' },
  { id: 'p-pho', title: 'P 標記完成', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'photographer', token: 'P-TOK' },
];
const EXPECT = { 'PL-TOK': 'pick', 'S-TOK': 'submitted', 'R-TOK': 'submitted', 'D-TOK': 'delivered', 'V-TOK': 'delivered', 'C-TOK': 'done', 'P-TOK': 'done' };
const TITLES = { 'PL-TOK': '王小明 婚紗', 'S-TOK': 'S 已送出', 'R-TOK': 'R 精修中', 'D-TOK': 'D 已交件', 'V-TOK': 'V 待修改', 'C-TOK': 'C 客戶確認', 'P-TOK': 'P 標記完成' };
const world = settings => pickFakeWorker({ projectId: 'proj-pl', title: '王小明 婚紗', folders: ['shoot/毛片/'], phase: 'picking', listToken: 'PL-TOK', settings, extraProjects: ROWS });
// the link text is the page's own projectLink(); compare with the token it ends in instead of the whole URL
const textFor = async (page, tok) => {
  await page.click(`[data-copy-link="${tok}"]`);
  await page.waitForSelector('#pd-share-link', { timeout: 3000 });
  const t = await page.$eval('#sl-text', e => e.value);
  await page.click('#sl-close-btn');
  await page.waitForSelector('#pd-share-link', { state: 'detached', timeout: 3000 });
  return t.replace(/https?:\/\/\S*index\.html\?t=([A-Z-]+)/g, 'LINK:$1');
};
const ready = async page => { await page.waitForSelector('[data-copy-link]', { timeout: 5000 }); await page.waitForTimeout(400); };
const checkAll = async (page, ok, settings, toks) => {
  for (const tok of toks) {
    const st = EXPECT[tok];
    const want = fill(settings[FIELD[st]] ?? DEF[st], TITLES[tok], tok);
    const got = await textFor(page, tok);
    ok(`${tok} (${st}) gets the ${st} message`, got === want, JSON.stringify([got, want]));
  }
};
const ALL_ACTIVE = ['PL-TOK', 'S-TOK', 'R-TOK', 'D-TOK', 'V-TOK'];

// ═════════ the copied message per stage ═════════
{
  const m = world(SAVED);
  await suite('74 連結訊息 dialog — 每個階段用自己的樣板（選片中 / 已送出 / 精修中 / 已交件 / 待修改→已交件）',
    `${base}/admin.html`,
    async page => { const { out, ok } = line(); await ready(page); await checkAll(page, ok, SAVED, ALL_ACTIVE);
      ok('positive: five rows were checked', ALL_ACTIVE.length === 5); return out; },
    { before: m.attach, initScript: CLIP });
}
{
  const m = world(SAVED);
  await suite('74 連結訊息 dialog — 已完成（客戶確認 / 攝影師標記）用 done 樣板，不是 delivered',
    `${base}/admin.html#tab=done`,
    async page => { const { out, ok } = line(); await ready(page); await checkAll(page, ok, SAVED, ['C-TOK', 'P-TOK']); return out; },
    { before: m.attach, initScript: CLIP });
}
{
  const m = world({});
  await suite('74 連結訊息 dialog — 樣板都是 null：各階段用自己的預設文字',
    `${base}/admin.html`,
    async page => { const { out, ok } = line(); await ready(page); await checkAll(page, ok, {}, ALL_ACTIVE); return out; },
    { before: m.attach, initScript: CLIP });
}
{
  const m = world({});
  await suite('74 連結訊息 dialog — 已完成的預設文字（null）',
    `${base}/admin.html#tab=done`,
    async page => { const { out, ok } = line(); await ready(page); await checkAll(page, ok, {}, ['C-TOK', 'P-TOK']); return out; },
    { before: m.attach, initScript: CLIP });
}
{
  // a Worker from before the migration: the three new fields are absent from the answer altogether
  const old = { pick_link_message: 'PICK {專案名稱} {連結}' };
  const m = world(old);
  await suite('74 連結訊息 dialog — Worker 還沒有新欄位（欄位不存在）：選片中用存的、其他階段用預設',
    `${base}/admin.html`,
    async page => { const { out, ok } = line(); await ready(page); await checkAll(page, ok, old, ['PL-TOK', 'S-TOK', 'D-TOK']); return out; },
    { before: async page => { await m.attach(page); await page.route('**/api/admin/settings', async (route, req) => {
        if (req.method() !== 'GET') return route.fallback();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(old) }); }); },
      initScript: CLIP });
}

// ═════════ settings page ═════════
const puts = m => m.seen.filter(s => s.method === 'PUT' && s.path === '/api/admin/settings');
const save = async page => { await page.evaluate(() => { document.getElementById('set-ok').textContent = ''; document.getElementById('set-err').textContent = ''; });
  await page.click('#set-save-btn'); await page.waitForFunction(() => document.getElementById('set-ok').textContent || document.getElementById('set-err').textContent, null, { timeout: 3000 }); };
const IDS = { pick: 'set-pick-link', submitted: 'set-link-message-submitted', delivered: 'set-link-message-delivered', done: 'set-link-message-done' };
const TA = { pick: '#set-pick-link-message', submitted: '#set-link-message-submitted', delivered: '#set-link-message-delivered', done: '#set-link-message-done' };
const setVal = (page, st, v) => page.evaluate(([sel, x]) => { const t = document.querySelector(sel); t.value = x; t.dispatchEvent(new Event('input', { bubbles: true })); }, [TA[st], v]);
const pv = (page, st) => page.$eval(`#${IDS[st]}-preview`, e => e.textContent);
const waitLoaded = page => page.waitForFunction(() => document.getElementById('set-pick-link-message')?.value !== '', null, { timeout: 5000 });
const linkKeys = b => Object.keys(b).filter(k => /link_message|pick_link/.test(k));
{
  const m = dashSettingsMock({ settings: { link_message_delivered: '好了 {專案名稱}\n{連結}' } });
  await suite('74 連結訊息 settings — 四個區塊、各自預覽；null 顯示該階段預設；只改一個只送一個欄位',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await waitLoaded(page);
      await page.waitForFunction(() => document.getElementById('set-link-message-delivered').value.startsWith('好了'), null, { timeout: 3000 });
      const labels = await page.$$eval('.link-msg-block > label', ls => ls.map(l => l.textContent.trim()));
      ok('four labelled blocks in order', JSON.stringify(labels) === JSON.stringify(['選片中', '已送出 / 精修中', '已交件', '已完成']), JSON.stringify(labels));
      for (const st of ['pick', 'submitted', 'done']) { const v = await page.$eval(TA[st], e => e.value); ok(`${st}: null shows that stage's default`, v === DEF[st], v); }
      ok('delivered: the saved text is loaded', (await page.$eval(TA.delivered, e => e.value)) === '好了 {專案名稱}\n{連結}');
      for (const st of ['pick', 'submitted', 'delivered', 'done']) {
        const p = await pv(page, st);
        ok(`${st}: preview shows sample title + link, no placeholder left`, p.includes('王小明 & 陳小美 婚紗') && /https:\/\/\S+/.test(p) && !p.includes('{'), p);
      }
      ok('submitted preview is the submitted default', (await pv(page, 'submitted')).includes('的選片我收到囉'), await pv(page, 'submitted'));
      ok('delivered preview is the saved text filled in', (await pv(page, 'delivered')).startsWith('好了 王小明 & 陳小美 婚紗\nhttps'), await pv(page, 'delivered'));
      ok('done preview is the done default', (await pv(page, 'done')).includes('謝謝你的信任'), await pv(page, 'done'));
      await setVal(page, 'done', '完成 {專案名稱} {連結}');
      ok('typing in done updates only its preview', (await pv(page, 'done')).startsWith('完成 王小明 & 陳小美 婚紗 https') && (await pv(page, 'submitted')).includes('的選片我收到囉'), await pv(page, 'done'));
      await save(page);
      ok('only the changed field is sent', puts(m).length === 1 && JSON.stringify(linkKeys(puts(m)[0].body)) === '["link_message_done"]', JSON.stringify(puts(m)[0]?.body));
      ok('the value sent is the text', puts(m)[0].body.link_message_done === '完成 {專案名稱} {連結}');
      await save(page);
      ok('saved again unchanged: none of the four named', puts(m).length === 2 && linkKeys(puts(m)[1].body).length === 0, JSON.stringify(puts(m)[1]?.body));
      await setVal(page, 'submitted', DEF.submitted + ' ');
      await setVal(page, 'pick', '   ');
      await save(page);
      ok('a default text (or blank) over a null field is unchanged: nothing named', puts(m).length === 3 && linkKeys(puts(m)[2].body).length === 0, JSON.stringify(puts(m)[2]?.body));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}
{
  const m = dashSettingsMock({ settings: { link_message_submitted: '舊 {連結}', link_message_done: '舊完成 {連結}' } });
  await suite('74 連結訊息 settings — 各自「還原預設」：只動自己的區塊，存成 null',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForFunction(() => document.getElementById('set-link-message-submitted')?.value === '舊 {連結}', null, { timeout: 5000 });
      ok('positive: four reset buttons', (await page.$$('.link-msg-block button')).length === 4);
      await page.click('#set-link-message-submitted-reset');
      ok('submitted is back to its default', (await page.$eval(TA.submitted, e => e.value)) === DEF.submitted);
      ok('done is untouched', (await page.$eval(TA.done, e => e.value)) === '舊完成 {連結}');
      ok('submitted preview follows', (await pv(page, 'submitted')).includes('的選片我收到囉'));
      await save(page);
      ok('only link_message_submitted: null is sent', puts(m).length === 1 && puts(m)[0].body.link_message_submitted === null && JSON.stringify(linkKeys(puts(m)[0].body)) === '["link_message_submitted"]', JSON.stringify(puts(m)[0]?.body));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}
{
  const m = dashSettingsMock({ settings: {} });
  await suite('74 連結訊息 settings — 400 錯誤說人話（指出是哪個階段）',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await waitLoaded(page);
      for (const [st, code, lab] of [['pick', 'invalid_pick_link_message', '選片中'], ['submitted', 'invalid_link_message_submitted', '已送出'], ['delivered', 'invalid_link_message_delivered', '已交件'], ['done', 'invalid_link_message_done', '已完成']]) {
        await page.fill(TA[st], '壞\u0001字 {連結}');
        await save(page);
        const e = await page.textContent('#set-err');
        ok(`${code} → Chinese sentence naming ${lab}`, e.includes(lab) && e.includes('格式不正確') && !e.includes(code), e);
        await page.fill(TA[st], DEF[st]);
      }
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}
{
  const m = dashSettingsMock({ linkMessagesMigrated: false });
  await suite('74 連結訊息 settings — 新 migration 還沒跑（500 link_messages_unavailable）：說明 migration；不動這三欄的儲存照常成功',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await waitLoaded(page);
      await save(page);
      ok('a save that leaves the three fields alone works', (await page.textContent('#set-ok')).includes('已儲存') && puts(m).length === 1, await page.textContent('#set-err'));
      await setVal(page, 'delivered', '新的 {連結}');
      await save(page);
      const e = await page.textContent('#set-err');
      ok('the 500 names the migration file', e.includes('2026-10-16-link-messages.sql') && !e.includes('link_messages_unavailable'), e);
      ok('positive: a PUT was actually sent with the field', puts(m).length === 2 && puts(m)[1].body.link_message_delivered === '新的 {連結}');
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}
{
  const m = dashSettingsMock({ settings: { pick_link_message: '嗨 {專案名稱}\n{連結}' } });
  await suite('74 連結訊息 390px — settings：四個區塊都在螢幕內、無橫向捲動、文字框約 3 行、按鈕 ≥44px',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await waitLoaded(page);
      const r = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll('.link-msg-block')];
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, n: blocks.length,
          items: blocks.map(b => { const t = b.querySelector('textarea').getBoundingClientRect(), p = b.querySelector('.pick-link-preview').getBoundingClientRect(), bt = b.querySelector('button').getBoundingClientRect();
            return { tl: t.left, tr: t.right, th: t.height, pl: p.left, pr: p.right, ph: p.height, bh: bt.height, bw: bt.width, br: bt.right }; }) };
      });
      ok('four blocks scanned', r.n === 4, JSON.stringify(r));
      ok('no horizontal scroll', r.sw <= r.iw, JSON.stringify([r.sw, r.iw]));
      ok('textareas and previews inside the 16px gutter, previews visible', r.items.every(i => i.tl >= 15 && i.tr <= r.iw - 15 && i.pl >= 15 && i.pr <= r.iw - 15 && i.ph > 20), JSON.stringify(r.items));
      ok('textarea is compact (about 3 rows, under 130px tall)', r.items.every(i => i.th >= 60 && i.th < 130), JSON.stringify(r.items.map(i => i.th)));
      ok('reset buttons >=44px and on screen', r.items.every(i => i.bh >= 44 && i.bw >= 44 && i.br <= r.iw), JSON.stringify(r.items));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS, contextOptions: MOBILE });
}
{
  const m = world(SAVED);
  await suite('74 連結訊息 390px — 傳給客人視窗（已交件）：無橫向捲動',
    `${base}/admin.html`,
    async page => {
      const { out, ok } = line(); await ready(page);
      await page.click('[data-copy-link="D-TOK"]'); await page.waitForSelector('#sl-text');
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, v: document.getElementById('sl-text').value, tr: document.getElementById('sl-text').getBoundingClientRect().right }));
      ok('no horizontal scroll, textarea on screen', r.sw <= r.iw && r.tr <= r.iw, JSON.stringify(r));
      ok('positive: it is the delivered text', r.v.startsWith('DELI D 已交件'), r.v);
      return out;
    },
    { before: m.attach, initScript: CLIP, contextOptions: MOBILE });
}
}
