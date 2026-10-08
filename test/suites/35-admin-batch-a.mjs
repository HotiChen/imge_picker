// Browser suites: photographer-side batch A — 看全部毛片 (review view, all-proofs mode), the 交件
// notice dialog + 複製交付通知文案, status badge colours, and whole-row click on the project list.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { ADMIN_BUCKET } from '../lib/delivery-helpers.mjs';

export default async function register() {

const ADMIN_SRC = `(${ADMIN.toString()})();`;
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const detailGets = (m, id) => m.requests.filter(r => r.method === 'GET' && r.path === `/api/admin/projects/${id}`).length;
// the studio-token mint is a POST but writes nothing in D1/R2; every other non-GET is a write
const writes = m => m.requests.filter(r => r.method !== 'GET' && r.path !== '/api/auth/studio-token');

// ═══════════════════════════════════════════════════════════════════════════
// 1 — 看全部毛片: index.html?project=<id> in its all-proofs mode
// ═══════════════════════════════════════════════════════════════════════════
const PROOFS = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg', 'shoot/毛片/c.jpg', 'shoot/毛片/d.jpg', 'shoot/毛片/sub/e.jpg'];
const allWorld = () => {
  const m = pickFakeWorker({ projectId: 'proj-all', ownerName: 'Grace', folders: ['shoot/毛片/'], pickFiles: [...PROOFS, 'shoot/精修/final1.jpg'] });
  m.state.selections.set('shoot/毛片/a.jpg', { rating: 5, note: '請修痘痘', marks: [{ x: 0.2, y: 0.3, note: '這裡' }], updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('shoot/毛片/c.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('shoot/毛片/d.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  return m;
};
const cards = page => page.evaluate(() => [...document.querySelectorAll('.photo-card')].map(c => ({
  id: c.dataset.photoId,
  heart: !!c.querySelector('.pick-heart-btn.on'),
  note: !!c.querySelector('.pv-note-badge'),
  pins: !!c.querySelector('.pv-pin-badge'),
})));

{
  const m = allWorld();
  await suite('35 看全部毛片 — admin 專案詳情有「看全部毛片」連結，指向 index.html?project=<id>&mode=all（同分頁）',
    `${base}/admin.html#project=proj-all`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-view-all-btn', { timeout: 5000 });
      const r = await page.$eval('#pd-view-all-btn', a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim(), tag: a.tagName }));
      ok('a plain link reading 看全部毛片', r.tag === 'A' && r.text === '看全部毛片' && !r.target, JSON.stringify(r));
      ok('to the review view in all mode', r.href === 'index.html?project=proj-all&mode=all', r.href);
      const seePicks = await page.$eval('#pd-sec-selections .pd-sec-head a.pd-link', a => a.getAttribute('href'));
      ok('看照片 → (the picks) is still there and unchanged', seePicks === 'index.html?project=proj-all', seePicks);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = allWorld();
  await suite('35 看全部毛片 — ?mode=all 列出專案資料夾（含子資料夾）的每一張，選中的有 ♥/💬/📍，沒選的沒有；只寫入零筆',
    `${base}/index.html?project=proj-all&mode=all`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length >= 5, null, { timeout: 5000 }).catch(() => {});
      const cs = await cards(page);
      ok('floor: all 5 proofs are listed (the subfolder one too), not just the 2 picks', cs.length === 5, String(cs.length));
      ok('exactly the proofs, none of the finals folder', JSON.stringify(cs.map(c => c.id).sort()) === JSON.stringify([...PROOFS].sort()), JSON.stringify(cs.map(c => c.id)));
      const by = Object.fromEntries(cs.map(c => [c.id.split('/').pop(), c]));
      ok('picked a.jpg and c.jpg carry the ♥', by['a.jpg'].heart && by['c.jpg'].heart);
      ok('un-picked b.jpg, e.jpg and the rating-0 d.jpg carry none', !by['b.jpg'].heart && !by['e.jpg'].heart && !by['d.jpg'].heart);
      ok('a.jpg shows its 💬 and 📍, the others do not', by['a.jpg'].note && by['a.jpg'].pins && !by['c.jpg'].note && !by['b.jpg'].pins);
      await page.waitForFunction(() => /全部毛片 ·/.test(document.getElementById('pvBannerText').textContent), null, { timeout: 5000 });
      const banner = await page.$eval('#pvBannerText', e => e.textContent);
      ok('the banner says 全部毛片 · 5 張 and that the client picked 2', /全部毛片/.test(banner) && /5 張/.test(banner) && /選了 2 張/.test(banner), banner);
      const t = await page.$$eval('#pvModeToggle [data-pv-mode]', bs => bs.map(b => [b.dataset.pvMode, b.textContent, b.getAttribute('aria-pressed')]));
      ok('toggle: 客人選的 / 全部毛片, 全部毛片 pressed', JSON.stringify(t) === JSON.stringify([['picks', '客人選的', 'false'], ['all', '全部毛片', 'true']]), JSON.stringify(t));
      // the photos load through the studio credential only
      const lists = m.requests.filter(r => r.search.includes('list='));
      ok('floor: the proofs were listed (folder + subfolder)', lists.length >= 2, String(lists.length));
      ok('every listing carried the studio token as Authorization, no share token', lists.every(r => r.auth === 'Bearer adm' && !r.t), JSON.stringify(lists.map(r => [r.auth, r.t])));
      ok('nothing was written (GET only)', writes(m).length === 0, JSON.stringify(writes(m).map(r => r.method + r.path)));
      ok('selections were not touched', m.state.selections.size === 3);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = allWorld();
  await suite('35 看全部毛片 — 預設仍是客人選的（2 張）；切換 全部毛片 → 客人選的 來回，網址 ?mode 跟著變，不寫入',
    `${base}/index.html?project=proj-all`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      let cs = await cards(page);
      ok('default = picks: only the 2 rating>0 photos', cs.length === 2 && cs.every(c => c.heart), JSON.stringify(cs));
      ok('and no listing was requested yet', m.requests.filter(r => r.search.includes('list=')).length === 0);
      const pressed = () => page.$$eval('#pvModeToggle [data-pv-mode]', bs => bs.map(b => b.dataset.pvMode + ':' + b.getAttribute('aria-pressed')).join());
      ok('客人選的 is pressed', (await pressed()) === 'picks:true,all:false', await pressed());
      const bannerPicks = await page.$eval('#pvBannerText', e => e.textContent);
      ok('banner names the owner', bannerPicks.includes('Grace') && bannerPicks.includes('2 張'), bannerPicks);

      await page.click('[data-pv-mode="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 5, null, { timeout: 5000 });
      cs = await cards(page);
      ok('toggled to 全部毛片: 5 photos, 2 flagged', cs.length === 5 && cs.filter(c => c.heart).length === 2, JSON.stringify(cs));
      ok('pressed state follows', (await pressed()) === 'picks:false,all:true', await pressed());
      ok('the address says mode=all (reload keeps the view)', new URL(page.url()).searchParams.get('mode') === 'all', page.url());

      await page.click('[data-pv-mode="picks"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 5000 });
      cs = await cards(page);
      ok('back to 客人選的: the 2 picks again', cs.length === 2 && cs.every(c => c.heart), JSON.stringify(cs));
      ok('the address drops mode', !new URL(page.url()).searchParams.has('mode'), page.url());
      const listsBefore = m.requests.filter(r => r.search.includes('list=')).length;
      await page.click('[data-pv-mode="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 5, null, { timeout: 5000 });
      ok('toggling again reuses the listing (no second round of requests)', m.requests.filter(r => r.search.includes('list=')).length === listsBefore);
      ok('nothing was written', writes(m).length === 0, JSON.stringify(writes(m).map(r => r.method + r.path)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = allWorld();
  await suite('35 看全部毛片 — 全部毛片裡點一張沒選的照片：預覽可開（唯讀，沒有 ♥ 也沒有標示）',
    `${base}/index.html?project=proj-all&mode=all`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 5, null, { timeout: 5000 });
      await page.click('.photo-card[data-photo-id="shoot/毛片/b.jpg"]');
      await page.waitForFunction(() => document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      const name = await page.$eval('#modalPhotoName', e => e.textContent);
      ok('the preview opens on the un-picked photo', name === 'b.jpg', name);
      ok('no pins section for a photo with none', (await page.$('#pvPinSection')) === null);
      ok('still nothing written', writes(m).length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-all', ownerName: 'Grace', folders: ['shoot/毛片/'], listFail: 500 });
  await suite('35 看全部毛片 — 毛片資料夾讀不到：說清楚，而不是假裝「沒有照片」；客人選的照常',
    `${base}/index.html?project=proj-all&mode=all`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#emptyState', { state: 'visible', timeout: 5000 });
      const h = await page.$eval('#emptyState h2', e => e.textContent);
      ok('the empty state says it could not be read', /無法讀取/.test(h), h);
      ok('no photo card', (await page.$$('.photo-card')).length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 — 交件後複製通知文案
// ═══════════════════════════════════════════════════════════════════════════
const HOSTILE = `<img src=x onerror="window.__pwned=1">&amp; "引號" 'q' \${x}`;
const dnWorld = (title = '婚禮 Amy&Ben') => pickFakeWorker({
  projectId: 'proj-dn', title, phase: 'retouching', ownerName: 'Zoe', folders: ['shoot/毛片/'],
  finalFolders: ['shoot/精修/'], bucketFolders: ADMIN_BUCKET,
  pickFiles: ['shoot/毛片/IMG_1.jpg', 'shoot/精修/a.jpg'], listToken: 'LINK-TOK-1',
});
const CLIP_OK = `${ADMIN_SRC}
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
// no Clipboard API at all; execCommand records what was selected when it ran
const CLIP_NONE = `${ADMIN_SRC}
  window.__exec = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  document.execCommand = function (cmd) {
    const el = document.activeElement;
    window.__exec.push({ cmd, tag: el && el.tagName, sel: el && typeof el.value === 'string' ? el.value.substring(el.selectionStart, el.selectionEnd) : null });
    return true;
  };`;
const CLIP_REJECT = `${ADMIN_SRC}
  window.__exec = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
  document.execCommand = function (cmd) {
    const el = document.activeElement;
    window.__exec.push({ cmd, sel: el && typeof el.value === 'string' ? el.value.substring(el.selectionStart, el.selectionEnd) : null });
    return true;
  };`;
const CLIP_BROKEN = `${ADMIN_SRC}
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  document.execCommand = () => false;`;
const deliverAndWait = async page => {
  await page.waitForSelector('#pd-deliver-btn:not([disabled])', { timeout: 5000 });
  await page.click('#pd-deliver-btn');
  await page.waitForSelector('#pd-deliver-notice', { timeout: 5000 });
};

{
  const m = dnWorld();
  await suite('35 交件通知 — 交件成功後跳出對話框：有標題、連結、確認完成/需要修改，沒有釘子；複製寫入剛好那段文字',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-deliver-btn', { timeout: 5000 });
      ok('before 交件 there is no dialog (positive: the button is there)', (await page.$('#pd-deliver-notice')) === null);
      await deliverAndWait(page);
      ok('the deliver call was made', m.requests.some(r => r.method === 'POST' && r.path.endsWith('/deliver')));
      const d = await page.evaluate(() => {
        const box = document.querySelector('#pd-deliver-notice [role="dialog"]');
        const r = box.getBoundingClientRect();
        return { text: document.getElementById('dn-text').value, copy: document.getElementById('dn-copy-btn').textContent,
          visible: r.width > 100 && r.height > 100, display: getComputedStyle(document.getElementById('pd-deliver-notice')).display };
      });
      ok('the dialog is really on screen', d.visible && d.display !== 'none', JSON.stringify(d));
      ok('the button reads 📋 複製交付通知文案', d.copy === '📋 複製交付通知文案', d.copy);
      ok('the text has the project title', d.text.includes('婚禮 Amy&Ben'), d.text);
      ok('and the client link (the same shape as 複製連結: index.html?t=<token>)', /index\.html\?t=LINK-TOK-1(\s|$)/.test(d.text), d.text);
      ok('it names 確認完成 and 需要修改', d.text.includes('「確認完成」') && d.text.includes('「需要修改」'), d.text);
      ok('it never mentions pins (釘 / 標記 / pin)', !/釘|標記|標示|pin/i.test(d.text), d.text);
      await page.click('#dn-copy-btn');
      await page.waitForFunction(() => document.getElementById('dn-status').textContent === '已複製', null, { timeout: 3000 });
      const clip = await page.evaluate(() => window.__clip);
      ok('copy wrote exactly the text shown, once', clip.length === 1 && clip[0] === d.text, JSON.stringify(clip));
      ok('and 已複製 is shown', (await page.$eval('#dn-status', e => e.textContent)) === '已複製');
      await page.click('#dn-close-btn');
      ok('關閉 removes the dialog', (await page.$('#pd-deliver-notice')) === null);
      ok('the project is delivered behind it', (await page.$('[data-delivered-status]')) !== null);
      return out;
    },
    { before: m.attach, initScript: CLIP_OK });
}

{
  const m = dnWorld();
  await suite('35 交件通知 — 沒有 Clipboard API：改用選取 + execCommand("copy")，選到的正是那段文字，顯示已複製',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await deliverAndWait(page);
      const text = await page.$eval('#dn-text', e => e.value);
      await page.click('#dn-copy-btn');
      await page.waitForFunction(() => document.getElementById('dn-status').textContent === '已複製', null, { timeout: 3000 });
      const ex = await page.evaluate(() => window.__exec);
      ok('execCommand("copy") ran once', ex.length === 1 && ex[0].cmd === 'copy', JSON.stringify(ex));
      ok('with exactly the whole message selected', ex[0].sel === text && text.length > 40, JSON.stringify(ex[0]));
      ok('the throw-away textarea is gone again', (await page.$$('body > textarea')).length === 0);
      return out;
    },
    { before: m.attach, initScript: CLIP_NONE });
}

{
  const m = dnWorld();
  await suite('35 交件通知 — Clipboard API 拒絕（權限）：同樣退回選取複製；兩條路都失敗就說複製失敗，不假裝已複製',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await deliverAndWait(page);
      const text = await page.$eval('#dn-text', e => e.value);
      await page.click('#dn-copy-btn');
      await page.waitForFunction(() => document.getElementById('dn-status').textContent !== '', null, { timeout: 3000 });
      const ex = await page.evaluate(() => window.__exec);
      ok('a rejected writeText falls through to execCommand with the message selected', ex.length === 1 && ex[0].sel === text, JSON.stringify(ex));
      ok('and says 已複製', (await page.$eval('#dn-status', e => e.textContent)) === '已複製');
      return out;
    },
    { before: m.attach, initScript: CLIP_REJECT });
}

{
  const m = dnWorld();
  await suite('35 交件通知 — 兩條複製路都失敗：顯示複製失敗（不顯示已複製），文字仍在框裡可手動複製',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await deliverAndWait(page);
      await page.click('#dn-copy-btn');
      await page.waitForFunction(() => document.getElementById('dn-status').textContent !== '', null, { timeout: 3000 });
      const s = await page.$eval('#dn-status', e => e.textContent);
      ok('says it failed', /失敗/.test(s) && !/^已複製/.test(s), s);
      ok('the message is still in the box to copy by hand', (await page.$eval('#dn-text', e => e.value)).includes('確認完成'));
      return out;
    },
    { before: m.attach, initScript: CLIP_BROKEN });
}

{
  const m = dnWorld(HOSTILE);
  await suite('35 交件通知 — 專案名稱含 HTML / 引號 / ${}：對話框與文案只當文字，不執行、不長出元素',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-deliver-btn', { timeout: 5000 });
      await deliverAndWait(page);
      const r = await page.evaluate(() => ({
        text: document.getElementById('dn-text').value,
        imgs: document.querySelectorAll('#pd-deliver-notice img, #pd-deliver-notice [onerror]').length,
        pwned: window.__pwned === 1,
        overlayKids: document.querySelector('#pd-deliver-notice [role="dialog"]').children.length,
      }));
      ok('the title is in the text verbatim', r.text.includes(HOSTILE), r.text);
      ok('no element was created from it, nothing ran', r.imgs === 0 && !r.pwned);
      ok('the dialog has its 4 own children only (title, note, textarea, actions)', r.overlayKids === 4, String(r.overlayKids));
      await page.click('#dn-copy-btn');
      await page.waitForFunction(() => document.getElementById('dn-status').textContent === '已複製', null, { timeout: 3000 });
      ok('and it is copied verbatim', (await page.evaluate(() => window.__clip[0])) === r.text);
      return out;
    },
    { before: m.attach, initScript: CLIP_OK });
}

{
  const m = dnWorld();
  await suite('35 交件通知 — 已交件期間，交件區塊有小按鈕「複製交付通知文案」，複製同一段文字；尚未交件時沒有',
    `${base}/admin.html#project=proj-dn`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-deliver-btn', { timeout: 5000 });
      ok('not delivered yet: no copy button', (await page.$('#pd-copy-notice-btn')) === null);
      await deliverAndWait(page);
      const first = await page.$eval('#dn-text', e => e.value);
      await page.click('#dn-close-btn');
      await page.waitForSelector('#pd-copy-notice-btn', { timeout: 3000 });
      const label = await page.$eval('#pd-copy-notice-btn', b => b.textContent);
      ok('delivered: the button reads 複製交付通知文案', label === '複製交付通知文案', label);
      await page.click('#pd-copy-notice-btn');
      await page.waitForFunction(() => document.getElementById('pd-copy-notice-status').textContent === '已複製', null, { timeout: 3000 });
      const clip = await page.evaluate(() => window.__clip);
      ok('it copies the same message as the dialog', clip.length === 1 && clip[0] === first, JSON.stringify(clip));
      page.once('dialog', d => d.accept());
      await page.click('#pd-undeliver-btn');
      await page.waitForSelector('#pd-deliver-btn', { timeout: 3000 });
      ok('after 取消交件 the button is gone again', (await page.$('#pd-copy-notice-btn')) === null);
      return out;
    },
    { before: m.attach, initScript: CLIP_OK });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 — 狀態顏色
// ═══════════════════════════════════════════════════════════════════════════
const seenColours = { amber: [], coral: [], green: [], grey: [] };
let badgesScanned = 0;
const GROUP_OF = { 'st-progress': 'amber', 'st-action': 'coral', 'st-done': 'green', 'st-neutral': 'grey' };
// every badge in `scope`: text, its st-* class, computed colours, contrast of text on its own background
const scanBadges = (page, scope) => page.evaluate(sel => {
  const parse = c => c.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  return [...document.querySelectorAll(`${sel} .badge`)].map(b => {
    const cs = getComputedStyle(b);
    const fg = parse(cs.color), bg = parse(cs.backgroundColor);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { text: b.textContent.trim(), cls: [...b.classList].find(c => c.startsWith('st-')) || null, color: cs.color, bg: cs.backgroundColor,
      ratio: (hi + 0.05) / (lo + 0.05), alpha: bg.length > 3 ? bg[3] : 1 };
  });
}, scope);

const STATES = [
  { name: '選片中', opts: { phase: 'picking' }, expect: { '選片中': 'st-progress' }, list: { '選片中': 'st-progress' } },
  { name: '已送出（等攝影師）', opts: { phase: 'submitted' }, expect: { '已送出': 'st-action' }, list: { '已送出': 'st-action' } },
  { name: '精修中', opts: { phase: 'retouching' }, expect: { '精修中': 'st-progress' }, list: { '精修中': 'st-progress' } },
  { name: '精修中 + 已交件', opts: { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] },
    expect: { '精修中': 'st-progress', '已交件': 'st-done' }, list: { '已交件': 'st-done' } },
  { name: '已交件 + 待修改 1', opts: { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], revisions: [{ message: '背景路人' }] },
    expect: { '精修中': 'st-progress', '已交件': 'st-done', '待修改 1': 'st-action' }, list: { '待修改 1': 'st-action' } },
  { name: '客戶已確認', opts: { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], confirmedAt: '2026-09-21T00:00:00.000Z' },
    expect: { '已交件': 'st-done', '客戶已確認': 'st-done' }, list: { '客戶已確認': 'st-done' } },
  { name: '已送出 + 已修改', opts: { phase: 'submitted' }, mutate: m => { m.state.project.modified_after_submit = 1; },
    expect: { '已送出': 'st-action', '已修改': 'st-neutral' }, list: { '已送出': 'st-action' } },
  { name: '已標記完成', opts: { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], confirmedAt: '2026-09-21T00:00:00.000Z', confirmedBy: 'photographer' },
    expect: { '已交件': 'st-done', '已標記完成': 'st-done' }, list: { '已標記完成': 'st-done' } },
];
for (const st of STATES) {
  const m = pickFakeWorker({ projectId: 'proj-st', ownerName: 'Zoe', folders: ['shoot/毛片/'], ...st.opts });
  if (st.mutate) st.mutate(m);
  await suite(`35 狀態顏色 — ${st.name}：列表（每列只有一個徽章）與詳情標題（全部徽章）的每個徽章各有自己的顏色類別、文字對比 ≥ 4.5`,
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#proj-recent-list [data-project-row] .badge', { timeout: 5000 });
      for (const [where, scope] of [['list row', '#proj-recent-list [data-project-row]'], ['detail header', '.pd-head']]) {
        if (where === 'detail header') {
          await page.click('[data-project-row] [data-open-project]');
          await page.waitForSelector('.pd-head .badge', { timeout: 5000 });
        }
        const bs = await scanBadges(page, scope);
        const byText = Object.fromEntries(bs.map(b => [b.text, b]));
        // the list row shows ONE badge (the most important state); the detail header keeps all of them
        const expect = where === 'list row' ? st.list : st.expect;
        ok(`${where}: floor — scanned at least the ${Object.keys(expect).length} expected badges`, bs.length >= Object.keys(expect).length, JSON.stringify(bs.map(b => b.text)));
        if (where === 'list row') ok('list row: exactly one badge', bs.length === 1, JSON.stringify(bs.map(b => b.text)));
        for (const [text, cls] of Object.entries(expect)) {
          const b = bs.find(x => x.text === text || x.text.startsWith(text));
          ok(`${where}: ${text} has ${cls}`, !!b && b.cls === cls, JSON.stringify(b));
          if (b && b.cls) { seenColours[GROUP_OF[b.cls]].push({ color: b.color, bg: b.bg }); }
        }
        ok(`${where}: every badge has a st-* class and an opaque background`, bs.every(b => b.cls && b.alpha === 1), JSON.stringify(bs));
        ok(`${where}: every badge text is >= 4.5:1 on its own background`, bs.every(b => b.ratio >= 4.5), JSON.stringify(bs.map(b => [b.text, b.ratio.toFixed(2)])));
        badgesScanned += bs.length;
      }
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-arch', ownerName: 'Zoe', folders: ['shoot/毛片/'], phase: 'picking', archivedAt: '2026-09-30T00:00:00.000Z' });
  await suite('35 狀態顏色 — 已封存：灰色（中性），其他沒列到的徽章也是灰色',
    `${base}/admin.html#project=proj-arch`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('.pd-head .badge', { timeout: 5000 });
      const bs = await scanBadges(page, '.pd-head');
      const arch = bs.find(b => b.text === '已封存');
      ok('已封存 is st-neutral', !!arch && arch.cls === 'st-neutral', JSON.stringify(bs));
      ok('contrast >= 4.5', !!arch && arch.ratio >= 4.5, arch && arch.ratio.toFixed(2));
      if (arch) seenColours.grey.push({ color: arch.color, bg: arch.bg });
      badgesScanned += bs.length;
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('35 狀態顏色 — 四組顏色（琥珀 / 珊瑚紅 / 綠 / 灰）的背景與文字計算色彼此都不同，且各組內一致',
  `${base}/admin.html`,
  async () => {
    const out = [], ok = okFn(out);
    ok('floor: badges were scanned in the state suites above', badgesScanned >= 22, String(badgesScanned));
    const groups = Object.keys(seenColours);
    for (const g of groups) {
      ok(`group ${g}: at least 2 badges seen`, seenColours[g].length >= 2, String(seenColours[g].length));
      ok(`group ${g}: one background and one text colour throughout`,
        new Set(seenColours[g].map(x => x.bg)).size === 1 && new Set(seenColours[g].map(x => x.color)).size === 1, JSON.stringify(seenColours[g].slice(0, 3)));
    }
    const bgs = groups.map(g => seenColours[g][0] && seenColours[g][0].bg);
    const fgs = groups.map(g => seenColours[g][0] && seenColours[g][0].color);
    ok('the four backgrounds are all different', new Set(bgs).size === 4 && bgs.every(Boolean), JSON.stringify(bgs));
    ok('the four text colours are all different', new Set(fgs).size === 4 && fgs.every(Boolean), JSON.stringify(fgs));
    return out;
  },
  { initScript: ADMIN });

// ═══════════════════════════════════════════════════════════════════════════
// 4 — 整列可點
// ═══════════════════════════════════════════════════════════════════════════
const ROW_CLIP = `${ADMIN_SRC}
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const rowWorld = () => pickFakeWorker({ projectId: 'proj-row', title: '整列專案', ownerName: 'Zoe', folders: ['shoot/毛片/'], phase: 'picking', listToken: 'ROW-TOK' });
const detailOpen = page => page.evaluate(() => {
  const p = document.getElementById('project-detail-panel');
  return !!p && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0;
});

{
  const m = rowWorld();
  await suite('35 整列可點 — 點列上的空白處（標題、挑選人文字）就開啟專案詳情，網址 hash 設好，只開一次',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      ok('the row is focusable and is a button for assistive tech', await page.$eval('[data-project-row]', r => r.tabIndex === 0 && r.getAttribute('role') === 'button'));
      ok('positive: 開啟 and 複製連結 are still in the row', !!(await page.$('[data-project-row] [data-open-project]')) && !!(await page.$('[data-project-row] [data-copy-link]')));
      ok('the detail is closed at the start', (await detailOpen(page)) === false);
      await page.click('[data-project-row] .pd-owner');
      await page.waitForSelector('#project-detail-body .pd-head', { timeout: 5000 });
      ok('the detail opened', await detailOpen(page));
      ok('it is this project', (await page.$eval('#project-detail-body .pd-head h3', e => e.textContent)) === '整列專案');
      ok('the hash is #project=proj-row', (await page.evaluate(() => location.hash)) === '#project=proj-row');
      await page.waitForTimeout(300);
      ok('opened once: one detail request', detailGets(m, 'proj-row') === 1, String(detailGets(m, 'proj-row')));
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

{
  const m = rowWorld();
  await suite('35 整列可點 — 點列裡的「複製連結」複製連結並跳出分享視窗（見 56），但不開專案',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForFunction(() => window.__clip.length === 1, null, { timeout: 3000 });
      const clip = await page.evaluate(() => window.__clip[0]);
      ok('it copied the pick link', /index\.html\?t=ROW-TOK$/.test(clip), clip);
      await page.waitForTimeout(400);
      ok('the detail did not open', (await detailOpen(page)) === false);
      ok('no hash was set', (await page.evaluate(() => location.hash)) === '');
      ok('no detail request was made', detailGets(m, 'proj-row') === 0);
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

{
  const m = rowWorld();
  await suite('35 整列可點 — 點「開啟」開一次（不會因為冒泡開兩次）',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-open-project]', { timeout: 5000 });
      await page.click('[data-project-row] [data-open-project]');
      await page.waitForSelector('#project-detail-body .pd-head', { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('opened', await detailOpen(page));
      ok('exactly one detail request', detailGets(m, 'proj-row') === 1, String(detailGets(m, 'proj-row')));
      ok('one history entry pushed for it (hash set)', (await page.evaluate(() => location.hash)) === '#project=proj-row');
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

for (const key of ['Enter', ' ']) {
  const m = rowWorld();
  await suite(`35 整列可點 — 鍵盤：焦點在列上按 ${key === ' ' ? 'Space' : key} 開啟；焦點在「開啟」按 Enter 也只開一次`,
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      await page.focus('[data-project-row]');
      ok('the row itself holds focus', await page.evaluate(() => document.activeElement === document.querySelector('[data-project-row]')));
      await page.keyboard.press(key);
      await page.waitForSelector('#project-detail-body .pd-head', { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('the detail opened', await detailOpen(page));
      ok('hash set', (await page.evaluate(() => location.hash)) === '#project=proj-row');
      ok('one detail request', detailGets(m, 'proj-row') === 1, String(detailGets(m, 'proj-row')));
      ok('Space did not scroll the page away (default prevented)', (await page.evaluate(() => window.scrollY)) === 0);
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

{
  const m = rowWorld();
  await suite('35 整列可點 — 焦點在「開啟」按鈕按 Enter：只開一次（列的 keydown 不重複處理）',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-open-project]', { timeout: 5000 });
      await page.focus('[data-project-row] [data-open-project]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#project-detail-body .pd-head', { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('opened', await detailOpen(page));
      ok('exactly one detail request', detailGets(m, 'proj-row') === 1, String(detailGets(m, 'proj-row')));
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

{
  const m = rowWorld();
  await suite('35 整列可點 — 游標 pointer，hover 與鍵盤焦點都有看得見的樣式',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      const snap = () => page.$eval('[data-project-row]', r => { const cs = getComputedStyle(r); return { cursor: cs.cursor, bg: cs.backgroundColor, border: cs.borderColor, outline: cs.outlineStyle, ow: cs.outlineWidth }; });
      const base0 = await snap();
      ok('cursor: pointer', base0.cursor === 'pointer', base0.cursor);
      ok('no outline at rest', base0.outline === 'none' || base0.ow === '0px', JSON.stringify(base0));
      await page.hover('[data-project-row] .pd-owner');
      await page.waitForTimeout(350);   // past the .12s transition
      const hov = await snap();
      ok('hover changes the row look (background and border)', hov.bg !== base0.bg && hov.border !== base0.border, JSON.stringify([base0, hov]));
      await page.mouse.move(2, 2);
      await page.keyboard.press('Shift');
      await page.focus('[data-project-row]');
      const foc = await snap();
      ok('keyboard focus draws an outline', foc.outline !== 'none' && foc.ow !== '0px', JSON.stringify(foc));
      return out;
    },
    { before: m.attach, initScript: ROW_CLIP });
}

}
