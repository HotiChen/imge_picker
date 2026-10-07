// Browser suites: S2 guest ordering, the PHOTOGRAPHER side (docs/guest-shop.md, 「S2 — built」): guest orders on
// orders.html and in the admin project detail (badge, contact card, 專案目前未交件 warning, 確認訂單 / 取消, 清除客人個資),
// the dashboard 待確認訂單 todo, settings 匯款資訊, and the phone layout (390px) of all of it.
// The fakes mirror the Worker answers exactly (test/lib/orders-fake.mjs contact/project_delivered/list_price/layout/erase-contact,
// test/lib/dashboard-mocks.mjs transfer_info). Chromium only; a real phone still has to look at it.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, SEED_TOKEN_ALWAYS, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ADMIN_PICKS, ordersFake, waitText } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };

// Hostile guest strings: markup, a bidi override, a spreadsheet formula, a line break.
const EVIL_NAME = '<img src=x onerror="window.__pwn=1">‮evil';
const EVIL_LINE = '=HYPERLINK("http://evil.example","x")';
const EVIL_NOTE = '<script>window.__pwn=2</script>第一行\n第二行 <b>粗</b>';
const EVIL_PHOTO = '20260819/<img src=x onerror=window.__pwn=3>IMG_0042.jpg';

// The orders every page below shows. `delivered` false for proj-nd (the 專案目前未交件 case).
function fixtures() {
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列', 'proj-nd': '未交件專案' }, delivered: { 'proj-nd': false } });
  const guest = (id, extra) => o.st.addOrder({ id, source: 'guest', status: 'requested', delivery_method: 'pickup', consent_version: 'v1', ...extra });
  guest('g1', { project_id: 'proj-1', guest_note: EVIL_NOTE,
    contact: { name: EVIL_NAME, phone: '0912-345-678', line: EVIL_LINE, erased_at: null },
    items: [{ kind: 'print', name: '無框畫', option_label: '30×40', unit_price: 1200, list_price: 1500, qty: 2, photo_keys: [EVIL_PHOTO] },
            { kind: 'album', name: '相本書', option_label: '8×8 吋', unit_price: 4200, list_price: 3800, qty: 1, photo_keys: [],
              layout: { v: 1, mode: 'photographer', source: 'all_finals', spreads: 12 } }] });
  guest('g2', { project_id: 'proj-nd', contact: { name: '林小姐', phone: '0912 345 678 (晚上)', line: null, erased_at: null },
    items: [{ kind: 'print', name: '無框畫', unit_price: 1000, list_price: 1000, qty: 1, photo_keys: ['20260819/IMG_7.jpg'] }] });
  guest('g3', { project_id: 'proj-1', status: 'confirmed', contact: { name: '陳先生', phone: null, line: 'chen_line', erased_at: null },
    items: [{ kind: 'print', name: '無框畫', unit_price: 900, list_price: 900, qty: 1, photo_keys: ['20260819/IMG_9.jpg'] }] });
  guest('g4', { project_id: 'proj-1', status: 'cancelled', contact: { name: '已取消的客人', phone: '0900111222', line: null, erased_at: null },
    items: [{ kind: 'print', name: '無框畫', unit_price: 900, list_price: 900, qty: 1, photo_keys: ['20260819/IMG_9.jpg'] }] });
  guest('g5', { project_id: 'proj-1', contact: { name: '王小姐', phone: null, line: null, erased_at: '2026-09-29T02:00:00.000Z' },
    items: [{ kind: 'print', name: '無框畫', unit_price: 900, list_price: 900, qty: 1, photo_keys: ['20260819/IMG_5.jpg'] }] });
  // an admin-created order: no contact, still 待確認 in the plain wording
  o.st.addOrder({ id: 'a1', source: 'admin', status: 'requested', project_id: 'proj-1', items: [{ name: '相框', unit_price: 500, qty: 1 }] });
  o.st.addOrder({ id: 'a2', source: 'admin', status: 'confirmed', project_id: 'proj-1', items: [{ name: '相框', unit_price: 700, qty: 1 }] });
  return o;
}

// What a card on either page shows, read from the DOM.
const readCard = (page, sel) => page.$eval(sel, c => {
  const q = s => c.querySelector(s);
  const vis = e => !!e && e.getClientRects().length > 0;
  const gc = q('[data-guest-card]');
  return {
    status: (q('.ord-status') || q('.badge-status'))?.textContent ?? null,
    hasCard: !!gc, text: c.textContent.replace(/\s+/g, ' '),
    name: q('.gc-name')?.textContent ?? null, nameDir: q('.gc-name')?.getAttribute('dir') ?? null, nameBidi: q('.gc-name') ? getComputedStyle(q('.gc-name')).unicodeBidi : null,
    phone: q('.gc-phone')?.textContent ?? null, tel: q('.gc-phone a[href^="tel:"]')?.getAttribute('href') ?? null,
    lineId: q('.gc-line')?.textContent ?? null, lineIsLink: !!q('.gc-line a'),
    method: q('.gc-method')?.textContent ?? null, consent: q('.gc-consent')?.textContent ?? null, note: q('.gc-note')?.textContent ?? null,
    warn: vis(q('.gc-warn')) ? q('.gc-warn').textContent : null, erased: q('.gc-erased')?.textContent ?? null,
    eraseBtn: vis(q('[data-erase-contact]')), imgs: c.querySelectorAll('img, script').length, links: [...c.querySelectorAll('a')].map(a => a.getAttribute('href')),
    items: [...c.querySelectorAll('.gc-item')].map(i => ({ text: i.textContent.replace(/\s+/g, ' '), photo: i.querySelector('.gc-photo')?.textContent ?? null, spreads: i.querySelector('.gc-spreads')?.textContent ?? null, price: i.querySelector('.gc-price')?.textContent ?? null })),
    btns: [...c.querySelectorAll('[data-status-to]')].map(b => `${b.dataset.statusTo}:${b.textContent}`).join(),
  };
});

// ═════════════════════ orders.html ═════════════════════
{
  const m = dashSettingsMock();
  const o = fixtures();
  await suite('guest orders — orders.html：badge、聯絡卡、未交件警告、客人字串當純文字',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const rows = await page.$$('.ord-row');
      ok('all 7 orders listed (floor)', rows.length === 7, String(rows.length));
      const g1 = await readCard(page, '[data-order-id="g1"]');
      ok('guest + requested badge reads 「客人下單 · 待確認」', g1.status === '客人下單 · 待確認', String(g1.status));
      const a1 = await readCard(page, '[data-order-id="a1"]');
      ok('positive control: the admin-created requested order keeps the plain 「待確認」 and has no contact card', a1.status === '待確認' && !a1.hasCard && !a1.eraseBtn, JSON.stringify([a1.status, a1.hasCard]));
      const g3 = await readCard(page, '[data-order-id="g3"]');
      ok('a confirmed guest order is plain 已確認 (the badge is only for requested)', g3.status === '已確認', String(g3.status));
      ok('contact card: name, phone (tel link), LINE id (text), 面交, 個資聲明 v1, guest note',
        g1.hasCard && g1.phone.includes('0912-345-678') && g1.tel === 'tel:0912-345-678' && g1.lineId.includes(EVIL_LINE) && !g1.lineIsLink &&
        g1.method.includes('面交') && g1.consent.includes('v1') && g1.note.includes('第一行') && g1.note.includes('第二行'), JSON.stringify(g1));
      ok('the hostile name is text: no <img>/<script> element anywhere in the card, window.__pwn never set, the literal markup is visible',
        g1.imgs === 0 && g1.name.includes('<img src=x onerror=') && (await page.evaluate(() => window.__pwn)) === undefined, JSON.stringify([g1.imgs, g1.name]));
      ok('the name is isolated for bidi (dir=auto + unicode-bidi: isolate)', g1.nameDir === 'auto' && g1.nameBidi === 'isolate', JSON.stringify([g1.nameDir, g1.nameBidi]));
      ok('the note keeps its line break and shows markup as text', g1.note.includes('<script>window.__pwn=2</script>') && (await page.$eval('[data-order-id="g1"] .gc-note', e => getComputedStyle(e).whiteSpace)).startsWith('pre'));
      ok('the =HYPERLINK formula is plain text, not a link', g1.links.every(h => !/evil\.example/.test(h || '')) && g1.lineId.includes('=HYPERLINK('));
      ok('a phone with letters / spaces is text only, no tel: link (positive: g1 has one)', (await readCard(page, '[data-order-id="g2"]')).tel === null && (await readCard(page, '[data-order-id="g2"]')).phone.includes('0912 345 678 (晚上)'));
      ok('a guest with no phone shows no empty 電話 row', g3.phone === null && g3.lineId.includes('chen_line'));
      ok('lines: print photo name (basename), list price vs unit price, album spreads',
        g1.items.length === 2 && g1.items[0].photo === '<img src=x onerror=window.__pwn=3>IMG_0042.jpg' &&
        /NT\$1,500/.test(g1.items[0].price) && /NT\$1,200/.test(g1.items[0].price) && g1.items[1].spreads.includes('12') && /NT\$3,800/.test(g1.items[1].price) && /NT\$4,200/.test(g1.items[1].price), JSON.stringify(g1.items));
      ok('a line whose list price equals the unit price shows one price, not an arrow', !/→/.test((await readCard(page, '[data-order-id="g3"]')).items[0].price), JSON.stringify((await readCard(page, '[data-order-id="g3"]')).items));
      const g2 = await readCard(page, '[data-order-id="g2"]');
      ok('project not delivered: the unmistakable 專案目前未交件 warning', g2.warn !== null && g2.warn.includes('專案目前未交件'), String(g2.warn));
      ok('positive control: a delivered project shows no such warning', g1.warn === null && g3.warn === null);
      ok('a cancelled order shows no not-delivered warning', (await readCard(page, '[data-order-id="g4"]')).warn === null);
      ok('buttons: guest requested → 確認訂單 / 取消訂單; confirmed → 完成 / 取消訂單', g1.btns === 'confirmed:確認訂單,cancelled:取消訂單' && g3.btns === 'fulfilled:完成,cancelled:取消訂單', JSON.stringify([g1.btns, g3.btns]));
      ok('erase button on a guest order with contact values, not on admin orders, and not on an erased one',
        g1.eraseBtn && g3.eraseBtn && !a1.eraseBtn && !(await readCard(page, '[data-order-id="a2"]')).eraseBtn && !(await readCard(page, '[data-order-id="g5"]')).eraseBtn);
      const g5 = await readCard(page, '[data-order-id="g5"]');
      ok('already erased: 個資已清除（2026-09-29）, no phone / LINE rows', g5.erased === '個資已清除（2026-09-29）' && g5.phone === null && g5.lineId === null, JSON.stringify([g5.erased, g5.phone, g5.lineId]));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = fixtures();
  await suite('guest orders — orders.html?status=requested（通知信的連結）直接套用待確認篩選',
    `${base}/orders.html?status=requested`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const ids = await page.$$eval('.ord-row', els => els.map(e => e.dataset.orderId).sort());
      ok('asks the Worker for ?status=requested and lists exactly the requested ones (floor 4)',
        o.st.calls.filter(c => c.path === '/api/admin/orders').every(c => c.search === '?status=requested') && ids.join() === 'a1,g1,g2,g5', JSON.stringify([ids, o.st.calls.map(c => c.search)]));
      ok('the 待確認 chip is the active one', (await page.$$eval('.chip.active', e => e.map(x => x.textContent))).join() === '待確認');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });

  const m2 = dashSettingsMock();
  const o2 = fixtures();
  await suite('guest orders — orders.html 沒有參數時是全部（對照組）；不認得的 status 也回到全部',
    `${base}/orders.html?status=bogus`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      ok('7 orders, no status filter sent', (await page.$$('.ord-row')).length === 7 && o2.st.calls.some(c => c.path === '/api/admin/orders' && c.search === ''), JSON.stringify(o2.st.calls.map(c => c.search)));
      return out;
    },
    { before: async p => { await m2.attach(p); await o2.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = fixtures();
  let answer = false;
  const dialogs = [];
  await suite('guest orders — orders.html：確認訂單、取消（要確認）、清除客人個資（要確認、清完只剩日期）',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      await page.click('[data-order-id="g1"] [data-status-to="confirmed"]');
      await waitText(page, '[data-order-id="g1"]', t => t.includes('已確認'));
      ok('確認訂單 posts {status: confirmed} to the existing status route, no dialog',
        o.st.calls.some(c => c.path === '/api/admin/orders/g1/status' && c.body.status === 'confirmed') && dialogs.length === 0);
      ok('the row now reads 已確認 (no 客人下單 · 待確認 left)', (await readCard(page, '[data-order-id="g1"]')).status === '已確認');

      await page.click('[data-order-id="g2"] [data-status-to="cancelled"]');
      await page.waitForTimeout(250);
      ok('取消訂單 asks first; declining sends nothing', dialogs.length === 1 && !o.st.calls.some(c => c.body?.status === 'cancelled') && (await readCard(page, '[data-order-id="g2"]')).status === '客人下單 · 待確認');
      answer = true;
      await page.click('[data-order-id="g2"] [data-status-to="cancelled"]');
      await waitText(page, '[data-order-id="g2"]', t => t.includes('已取消'));
      ok('accepting cancels it', o.st.calls.some(c => c.path === '/api/admin/orders/g2/status' && c.body.status === 'cancelled'));

      // erase: decline, accept
      answer = false; dialogs.length = 0;
      await page.click('[data-order-id="g3"] [data-erase-contact]');
      await page.waitForTimeout(250);
      ok('清除客人個資 asks first (the dialog names what goes); declining calls nothing',
        dialogs.length === 1 && /個資/.test(dialogs[0]) && !o.st.calls.some(c => /erase-contact/.test(c.path)) && (await readCard(page, '[data-order-id="g3"]')).lineId.includes('chen_line'), dialogs.join('|'));
      answer = true;
      await page.click('[data-order-id="g3"] [data-erase-contact]');
      await waitText(page, '[data-order-id="g3"]', t => t.includes('個資已清除'));
      const c = o.st.calls.filter(x => /erase-contact/.test(x.path));
      ok('accepting POSTs /api/admin/orders/g3/erase-contact once, with no body', c.length === 1 && c[0].method === 'POST' && c[0].path === '/api/admin/orders/g3/erase-contact' && c[0].body === null, JSON.stringify(c));
      const g3 = await readCard(page, '[data-order-id="g3"]');
      ok('afterwards: 個資已清除（date）, no phone / LINE value, no erase button, the name is kept',
        /^個資已清除（\d{4}-\d{2}-\d{2}）$/.test(g3.erased) && g3.lineId === null && g3.phone === null && !g3.text.includes('chen_line') && !g3.eraseBtn && g3.name === '陳先生', JSON.stringify(g3));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], migrated: false, titles: { 'proj-1': 'P' } });
  o.st.addOrder({ id: 'g1', source: 'guest', status: 'requested', project_id: 'proj-1', delivery_method: 'pickup', consent_version: 'v1',
    contact: { name: '王', phone: '0912345678', line: null, erased_at: null }, items: [{ name: '無框畫', unit_price: 1, qty: 1 }] });
  await suite('guest orders — orders.html：清除個資遇到 orders_unavailable，顯示中文、資料原封不動',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      page.on('dialog', d => d.accept());
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      await page.click('[data-erase-contact]');
      await waitText(page, '#orders-err', t => t.length > 0);
      ok('the sentence is plain Chinese', (await page.textContent('#orders-err')) === '客人訂購功能尚未啟用，請先執行 migration', await page.textContent('#orders-err'));
      ok('and the card still shows the phone (nothing was cleared)', (await readCard(page, '[data-order-id="g1"]')).phone.includes('0912345678'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ═════════════════════ admin project detail ═════════════════════
{
  const m = pickFakeWorker({ projectId: 'proj-1', title: '海邊系列' });
  const o = fixtures();
  let answer = true;
  await suite('guest orders — admin 專案詳情：訂單區用同一張聯絡卡、待確認數、清除個資',
    `${base}/admin.html#project=proj-1`,
    async page => {
      const { out, ok } = line();
      page.on('dialog', d => (answer ? d.accept() : d.dismiss()));
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const cards = await page.$$('#pd-order-list > .ord-card');
      ok('this project’s 6 orders (floor), not proj-nd’s', cards.length === 6, String(cards.length));
      const g1 = await readCard(page, '[data-order-id="g1"]');
      ok('badge 客人下單 · 待確認 on the status badge', g1.status === '客人下單 · 待確認', String(g1.status));
      const a1 = await readCard(page, '[data-order-id="a1"]');
      ok('positive control: admin order keeps 待確認 and has no contact card / erase button', a1.status === '待確認' && !a1.hasCard && !a1.eraseBtn);
      ok('contact card: name (dir=auto, isolate), tel link, LINE text, 面交, v1, note — hostile strings inert',
        g1.hasCard && g1.name === EVIL_NAME && g1.nameDir === 'auto' && g1.nameBidi === 'isolate' && g1.tel === 'tel:0912-345-678' && g1.lineId.includes(EVIL_LINE) && !g1.lineIsLink &&
        g1.method.includes('面交') && g1.consent.includes('v1') && g1.note.includes('<script>') && g1.imgs === 0 && (await page.evaluate(() => window.__pwn)) === undefined, JSON.stringify(g1));
      ok('the note is not shown twice (the old 客人留言 line is the card now)', (g1.text.match(/第二行/g) || []).length === 1, g1.text);
      ok('photo name and spreads and list vs unit price are on the lines', g1.items.length === 2 && g1.items[0].photo.includes('IMG_0042') && g1.items[1].spreads.includes('12') && /NT\$1,500/.test(g1.items[0].price), JSON.stringify(g1.items));
      ok('the existing money lines still render (成本 / 毛利 / 合計)', g1.text.includes('成本') && g1.text.includes('毛利') && g1.text.includes('合計'));
      ok('buttons: 確認訂單 / 取消訂單 first, then the existing 編輯 / 記錄收款', g1.btns === 'confirmed:確認訂單,cancelled:取消訂單' && (await page.$$eval('[data-order-id="g1"] .ord-actions button', b => b.map(x => x.textContent))).join() === '確認訂單,取消訂單,編輯,記錄收款');
      ok('the section summary counts the waiting ones: g1, g5, a1 → 待確認 3', (await page.textContent('#pd-sec-orders-btn')).includes('待確認 3'), await page.textContent('#pd-sec-orders-btn'));
      await page.click('[data-order-id="g1"] [data-status-to="confirmed"]');
      await waitText(page, '[data-order-id="g1"] .ord-status', t => t === '已確認');
      ok('確認訂單 posts the status route', o.st.calls.some(c => c.path === '/api/admin/orders/g1/status' && c.body.status === 'confirmed'));
      await page.click('[data-order-id="g3"] [data-erase-contact]');
      await waitText(page, '[data-order-id="g3"]', t => t.includes('個資已清除'));
      const g3 = await readCard(page, '[data-order-id="g3"]');
      ok('erased: 個資已清除（date）, the LINE id is gone from the DOM', /^個資已清除（\d{4}-\d{2}-\d{2}）$/.test(g3.erased) && !g3.text.includes('chen_line') && !g3.eraseBtn, JSON.stringify(g3));
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-nd', title: '未交件專案' });
  const o = fixtures();
  await suite('guest orders — admin 專案詳情：專案未交件時，客人訂單帶著 專案目前未交件 警告',
    `${base}/admin.html#project=proj-nd`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const g2 = await readCard(page, '[data-order-id="g2"]');
      ok('the warning is visible and the order is still there with its buttons (Q13=A: kept, photographer warned)',
        g2.warn !== null && g2.warn.includes('專案目前未交件') && g2.btns.includes('confirmed:確認訂單'), JSON.stringify([g2.warn, g2.btns]));
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

// ═════════════════════ dashboard ═════════════════════
for (const [n, label] of [[3, 'N = 3'], [0, 'N = 0 (positive control: the other todo stays, this one is absent)']]) {
  const m = dashSettingsMock({ stats: { by_phase: { picking: 0, submitted: 1, retouching: 0 }, delivered: 0, archived: 0, per_month: [],
    todo: { submitted_not_retouching: 1, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 0, requested_orders: n } } });
  await suite(`guest orders — dashboard 待辦：待確認訂單 ${label}`,
    `${base}/dashboard.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#todo-list li', { timeout: 5000 });
      const items = await page.$$eval('#todo-list li', els => els.map(e => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), key: e.dataset.todo || null, href: e.querySelector('a')?.getAttribute('href') })));
      const hit = items.find(i => i.key === 'requested-orders');
      ok('the existing todo is still listed (floor)', items.some(i => i.text.startsWith('1 個專案已送出')), JSON.stringify(items));
      if (n) ok('「待確認訂單 3」 links to orders.html?status=requested', !!hit && hit.text.startsWith('待確認訂單 3') && hit.href === 'orders.html?status=requested', JSON.stringify(items));
      else ok('no 待確認訂單 line at 0', !hit && !items.some(i => i.text.includes('待確認訂單')), JSON.stringify(items));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });
}

// ═════════════════════ settings: 匯款資訊 ═════════════════════
{
  const SAVED = '玉山銀行 808\n帳號 1234-5678-9012\n戶名 王小明';
  const m = dashSettingsMock({ settings: { transfer_info: SAVED } });
  await suite('guest orders — settings 匯款資訊：載入、換行保留、計數、只在改過時送出、限 500 字',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-transfer-info', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('set-transfer-info').value !== '', null, { timeout: 3000 });
      const val = () => page.$eval('#set-transfer-info', e => e.value);
      ok('the saved text is loaded with its line breaks', (await val()) === SAVED, JSON.stringify(await val()));
      ok('the hint says clients only see it after the photographer confirms an order', (await page.textContent('main')).includes('確認訂單後'), '');
      ok('a counter shows N / 500', (await page.textContent('#set-transfer-count')).replace(/\s/g, '') === `${[...SAVED].length}/500`, await page.textContent('#set-transfer-count'));
      const puts = () => m.seen.filter(r => r.method === 'PUT' && r.path === '/api/admin/settings');
      await page.click('#set-save-btn');
      await waitText(page, '#set-ok', t => t === '已儲存');
      ok('saving other settings without touching the text does NOT name transfer_info (works before the migration)', puts().length === 1 && !('transfer_info' in puts()[0].body), JSON.stringify(puts()));
      const next = '郵局 700\n帳號 000111\n';
      await page.fill('#set-transfer-info', next);
      ok('the counter follows the typing', (await page.textContent('#set-transfer-count')).replace(/\s/g, '') === `${[...next].length}/500`);
      await page.click('#set-save-btn');
      await waitText(page, '#set-ok', t => t === '已儲存');
      ok('a changed text is sent with its line breaks intact', puts().length === 2 && puts()[1].body.transfer_info === next, JSON.stringify(puts()[1]?.body));
      ok('a cleared text is sent as an empty string', await (async () => {
        await page.fill('#set-transfer-info', '');
        await page.click('#set-save-btn');
        await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存');
        return puts().length === 3 && puts()[2].body.transfer_info === '';
      })(), JSON.stringify(puts().at(-1)?.body));
      // the limit: 501 characters is refused in the browser, 500 goes through
      await page.evaluate(() => { const t = document.getElementById('set-transfer-info'); t.value = 'あ'.repeat(501); t.dispatchEvent(new Event('input', { bubbles: true })); });
      const before = puts().length;
      await page.click('#set-save-btn');
      await page.waitForTimeout(300);
      ok('501 characters: refused with a sentence, nothing sent', puts().length === before && (await page.textContent('#set-err')).includes('500'), await page.textContent('#set-err'));
      ok('the counter turns to the error colour', (await page.$eval('#set-transfer-count', e => getComputedStyle(e).color)) === 'rgb(192, 57, 43)');
      await page.evaluate(() => { const t = document.getElementById('set-transfer-info'); t.value = 'あ'.repeat(500); t.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('#set-save-btn');
      await waitText(page, '#set-ok', t => t === '已儲存');
      ok('exactly 500 characters is sent', puts().length === before + 1 && [...puts().at(-1).body.transfer_info].length === 500, String(puts().length));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS });

  const m2 = dashSettingsMock();
  await suite('guest orders — settings 匯款資訊：invalid_transfer_info 與 orders_unavailable 說人話',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-transfer-info', { timeout: 5000 });
      await page.fill('#set-transfer-info', '帳號\u0001123');
      await page.click('#set-save-btn');
      await waitText(page, '#set-err', t => t.length > 0);
      const e1 = await page.textContent('#set-err');
      ok('invalid_transfer_info → a Chinese sentence, not the raw code', /匯款資訊/.test(e1) && !/invalid_transfer_info/.test(e1), e1);
      ok('and no 已儲存', (await page.textContent('#set-ok')) === '');
      return out;
    },
    { before: m2.attach, initScript: SEED_TOKEN_ALWAYS });

  const m3 = dashSettingsMock({ ordersMigrated: false });
  await suite('guest orders — settings 匯款資訊：migration 沒跑（500 orders_unavailable）→ 客人訂購功能尚未啟用，請先執行 migration',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#set-transfer-info', { timeout: 5000 });
      await page.fill('#set-transfer-info', '玉山 808');
      await page.click('#set-save-btn');
      await waitText(page, '#set-err', t => t.length > 0);
      ok('the sentence is exact', (await page.textContent('#set-err')) === '客人訂購功能尚未啟用，請先執行 migration', await page.textContent('#set-err'));
      ok('and the save button is usable again', !(await page.$eval('#set-save-btn', b => b.disabled)));
      return out;
    },
    { before: m3.attach, initScript: SEED_TOKEN_ALWAYS });
}

// ═════════════════════ 390px ═════════════════════
const phone = page => page.evaluate(() => {
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const inside = [...document.querySelectorAll('main .gc, main [data-guest-card], main .gc *, main .ord-actions button, main .ord-row, main .ord-card, main textarea, main label')].filter(vis);
  return { sw: document.documentElement.scrollWidth, iw: innerWidth, n: inside.length,
    out: inside.filter(e => e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('.side-nav-list')).slice(0, 5).map(e => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)),
    btnH: [...document.querySelectorAll('main [data-status-to], main [data-erase-contact]')].filter(vis).map(b => Math.round(b.getBoundingClientRect().height)) };
});
{
  const m = dashSettingsMock();
  const o = fixtures();
  await suite('guest orders 390px — orders.html：聯絡卡與按鈕換行，不橫向捲動',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const r = await phone(page);
      ok(`no horizontal scroll (${r.sw} <= ${r.iw})`, r.sw <= r.iw, JSON.stringify(r));
      ok('scanned >= 30 elements (floor) and none sticks out', r.n >= 30 && r.out.length === 0, JSON.stringify(r));
      ok('guest buttons exist (floor 6) and are tappable (>= 32px high)', r.btnH.length >= 6 && r.btnH.every(h => h >= 32), JSON.stringify(r.btnH));
      ok('the guest card is as wide as the row (it wraps onto its own line)', await page.$eval('[data-order-id="g1"]', row => { const c = row.querySelector('[data-guest-card]').getBoundingClientRect(), r = row.getBoundingClientRect(); return c.width >= r.width * 0.9; }));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN, contextOptions: MOBILE });
}
{
  const m = pickFakeWorker({ projectId: 'proj-1', title: '海邊系列' });
  const o = fixtures();
  await suite('guest orders 390px — admin 專案詳情訂單卡：不橫向捲動',
    `${base}/admin.html#project=proj-1`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const r = await phone(page);
      ok(`no horizontal scroll (${r.sw} <= ${r.iw})`, r.sw <= r.iw, JSON.stringify(r));
      ok('scanned >= 30 elements (floor) and none sticks out', r.n >= 30 && r.out.length === 0, JSON.stringify(r));
      ok('guest buttons exist (floor 6)', r.btnH.length >= 6, JSON.stringify(r.btnH));
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN, contextOptions: MOBILE });
}
{
  const m = dashSettingsMock({ settings: { transfer_info: '玉山銀行 808\n帳號 1234-5678-9012' } });
  await suite('guest orders 390px — settings 匯款資訊：文字框與計數在螢幕內',
    `${base}/settings.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForFunction(() => document.getElementById('set-transfer-info')?.value !== '', null, { timeout: 5000 });
      const r = await page.evaluate(() => { const t = document.getElementById('set-transfer-info').getBoundingClientRect(), c = document.getElementById('set-transfer-count').getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, tr: t.right, tl: t.left, cr: c.right }; });
      ok('no horizontal scroll', r.sw <= r.iw, JSON.stringify(r));
      ok('the textarea and counter end inside the 16px gutter', r.tl >= 15 && r.tr <= r.iw - 15 && r.cr <= r.iw, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS, contextOptions: MOBILE });
}
{
  const m = dashSettingsMock({ stats: { by_phase: { picking: 0, submitted: 0, retouching: 0 }, delivered: 0, archived: 0, per_month: [],
    todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 0, requested_orders: 12 } } });
  await suite('guest orders 390px — dashboard 待確認訂單 一行不撐寬',
    `${base}/dashboard.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#todo-list li[data-todo="requested-orders"]', { timeout: 5000 });
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, r: document.querySelector('#todo-list li[data-todo="requested-orders"]').getBoundingClientRect().right }));
      ok('inside the screen', r.sw <= r.iw && r.r <= r.iw, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN_ALWAYS, contextOptions: MOBILE });
}
}
