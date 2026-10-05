// Browser suites: admin project orders: create / edit / payments / status.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { ADMIN_PICKS, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, PROD_PRINT, PROD_SERVICE_OFF, T, clone, ordersFake, platFx, waitText } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const todayTaipeiNode = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

{
  const m = pickFakeWorker({ projectId: 'proj-1', title: '訂單專案' });
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  o.st.addOrder({ id: 'ord-a', project_id: 'proj-1', status: 'confirmed', discount: 300, note: '週五取件',
    items: [{ name: '相本書', option_label: '8×8 吋', kind: 'album', unit_price: 1500, unit_cost: 600, qty: 2, photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'] },
            { name: '急件加修', kind: 'service', unit_price: 500, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'ord-b', project_id: 'proj-1', status: 'fulfilled', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 500, qty: 1 }] });
  o.st.addOrder({ id: 'ord-c', project_id: 'proj-1', status: 'cancelled', source: 'system',
    items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10 }] });
  o.st.addOrder({ id: 'ord-other', project_id: 'proj-2', status: 'confirmed', items: [{ name: '別的專案', unit_price: 1, qty: 1 }] });
  await suite('admin — 專案訂單：品項、合計、未收、狀態與付款標籤，按鈕依狀態顯示',
    `${base}/admin.html#project=proj-1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-orders .ord-card', { timeout: 5000 });
      const cards = await page.$$eval('#pd-order-list > .ord-card', els => els.map(e => ({
        id: e.dataset.orderId, status: e.dataset.status, source: e.dataset.source, text: e.textContent.replace(/\s+/g, ' '),
        statusText: e.querySelector('.ord-status').textContent, pay: e.querySelector('.ord-pay')?.textContent ?? null,
        total: e.querySelector('.ord-total').textContent, owed: e.querySelector('.ord-owed').textContent, paid: e.querySelector('.ord-paid').textContent,
        buttons: [...e.querySelectorAll('.ord-actions button')].map(b => b.textContent),
        opacity: getComputedStyle(e).opacity, bg: getComputedStyle(e).backgroundColor, edge: getComputedStyle(e).borderTopStyle,
      })));
      ok('only this project’s three orders, in the container under 訂單', cards.length === 3 && !cards.some(c => c.id === 'ord-other'), JSON.stringify(cards.map(c => c.id)));
      const a = cards.find(c => c.id === 'ord-a'), b = cards.find(c => c.id === 'ord-b'), c = cards.find(c => c.id === 'ord-c');
      ok('lines with name · option, unit price, qty and line subtotal', a.text.includes('相本書 · 8×8 吋') && a.text.includes('NT$1,500') && a.text.includes('× 2') && a.text.includes('NT$3,000') && a.text.includes('急件加修'), a.text);
      ok('total = Σ price×qty − discount (3,500 − 300 = NT$3,200), owed the same when unpaid', a.total === 'NT$3,200' && a.owed === 'NT$3,200' && a.paid === 'NT$0', JSON.stringify([a.total, a.owed, a.paid]));
      ok('the discount is shown', a.text.includes('折扣 −NT$300') && a.text.includes('小計 NT$3,500'));
      ok('cost and margin are shown to the photographer (2×600 = NT$1,200 → 毛利 NT$2,000)', a.text.includes('成本 NT$1,200') && a.text.includes('毛利 NT$2,000'), a.text);
      ok('the note is shown', a.text.includes('備註：週五取件'));
      ok('the photos on a line are listed (2 張)', a.text.includes('照片 2 張'));
      ok('status and payment labels: 已確認 / 未付款', a.statusText === '已確認' && a.pay === '未付款', JSON.stringify([a.statusText, a.pay]));
      ok('a fulfilled, paid order: 已完成 / 已付清, owed NT$0, method and date shown', b.statusText === '已完成' && b.pay === '已付清' && b.owed === 'NT$0' && b.text.includes('現金') && b.text.includes('2026-09-20'), b.text);
      ok('a cancelled order is greyed, tagged 已取消 and 系統建立, with no payment badge', c.statusText === '已取消' && c.pay === null && c.text.includes('系統建立'), JSON.stringify(c));
      // 亮色主題: a cancelled order used to be greyed with opacity, which pulls its muted text under
      // 4.5:1 on the bright theme — it is now set apart by a cream tint and a dashed edge instead.
      // (positive: the live orders keep the white card and solid edge, so the difference is real)
      ok('a cancelled order is set apart (cream tint, dashed edge), the live ones are not',
        c.bg === 'rgb(255, 248, 238)' && c.edge === 'dashed' && a.bg === 'rgb(255, 255, 255)' && a.edge === 'solid' && b.edge === 'solid', JSON.stringify([a.bg, a.edge, b.edge, c.bg, c.edge]));
      ok('confirmed: 完成 / 取消訂單 (not 確認), and 編輯 + 記錄收款, no 清除收款',
        a.buttons.join() === '完成,取消訂單,編輯,記錄收款', a.buttons.join());
      ok('fulfilled: 復原為已確認 / 取消訂單, paid so 清除收款 too',
        b.buttons.join() === '復原為已確認,取消訂單,編輯,記錄收款,清除收款', b.buttons.join());
      ok('cancelled: no buttons at all', c.buttons.length === 0, c.buttons.join());
      ok('with no extra_pick to report, the block is absent', (await page.$('#pd-extra-pick')) === null);
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-x', title: '加挑專案' });
  const o = ordersFake({ products: [], extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-e', order_extra: 6, matches: false } });
  o.st.addOrder({ id: 'ord-e', project_id: 'proj-x', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 6, product_id: null, option_id: null }] });
  await suite('admin — 加挑張數與訂單不符時顯示「加挑張數已變更（原 X → 現 Y），請確認」',
    `${base}/admin.html#project=proj-x`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      const warn = await page.textContent('#pd-extra-warn').catch(() => null);
      ok('the warning names the old and new counts', warn === '加挑張數已變更（原 6 → 現 10），請確認', String(warn));
      const info = await page.textContent('#pd-extra-pick');
      ok('and the block explains the fee: 14 張，上限 4，多挑 10 張 × NT$200 = NT$2,000', info.includes('14 張') && info.includes('上限 4') && info.includes('10 張 × NT$200 = NT$2,000'), info);
      ok('the warning sits inside 訂單, above the list', await page.evaluate(() => {
        const w = document.getElementById('pd-extra-warn'); const l = document.getElementById('pd-order-list');
        return !!document.getElementById('pd-orders').contains(w) && !!(w.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
      }));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  // Before 開始精修 there is no extra-pick order yet: "原 0 → 現 9，請確認" reads
  // as if something changed. It should say the order is created on 開始精修.
  const m = pickFakeWorker({ projectId: 'proj-z', title: '尚未開始精修', phase: 'submitted' });
  const o = ordersFake({ products: [], extra: { count: 19, pick_limit: 10, extra_price: 1000, extra: 9, fee: 9000, order_id: null, order_extra: null, matches: false } });
  await suite('admin — 送出後還沒開始精修：加挑訂單尚未建立，說明「按開始精修時自動建立」而不是「已變更」警告',
    `${base}/admin.html#project=proj-z`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      const pending = await page.textContent('#pd-extra-pending').catch(() => null);
      ok('a neutral note says the order is created when 開始精修 is pressed', !!pending && pending.includes('開始精修') && pending.includes('自動建立'), String(pending));
      ok('the fee line is still shown (9 張 × NT$1,000 = NT$9,000)', (await page.textContent('#pd-extra-pick')).includes('9 張 × NT$1,000 = NT$9,000'));
      ok('and there is no 「已變更」 warning at all', (await page.$('#pd-extra-warn')) === null && !(await page.textContent('#pd-orders')).includes('已變更'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-y', title: '加挑吻合' });
  const o = ordersFake({ products: [], extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-e', order_extra: 10, matches: true } });
  o.st.addOrder({ id: 'ord-e', project_id: 'proj-y', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10, product_id: null, option_id: null }] });
  await suite('admin — 加挑張數吻合時只顯示說明，沒有警告',
    `${base}/admin.html#project=proj-y`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      ok('the fee block is there…', (await page.textContent('#pd-extra-pick')).includes('NT$2,000'));
      ok('…and no warning', (await page.$('#pd-extra-warn')) === null && !(await page.textContent('#pd-orders')).includes('加挑張數已變更'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-z', title: '新增訂單專案' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT), clone(PROD_SERVICE_OFF)] });
  await suite('admin — 新增訂單：只列上架商品的上架規格、挑專案選中的照片、單價可覆寫，送出後列出',
    `${base}/admin.html#project=proj-z`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      ok('a project with no orders says 尚無訂單', (await page.textContent('#pd-orders-empty')) === '尚無訂單');
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option', { timeout: 3000 });
      const optTexts = await page.$$eval('#pd-add-option option', els => els.map(e => e.textContent));
      ok('the picker lists active options of active products only (no 舊規格, no retired 急件加修)',
        optTexts.length === 3 && optTexts.some(t => t.includes('相本書 · 8×8 吋 — NT$3,800')) && optTexts.some(t => t.includes('無框畫 — NT$1,200')) &&
        !optTexts.some(t => t.includes('舊規格') || t.includes('急件')), JSON.stringify(optTexts));
      ok('the add-order button is replaced by the editor while it is open', (await page.$('#pd-order-add-btn')) === null);

      await page.selectOption('#pd-add-option', 'opt-album-s');
      await page.click('#pd-add-line');
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      const lines = await page.$$eval('.ord-line-edit', els => els.map(e => ({ name: e.querySelector('.ord-line-name').textContent.replace(/\s+/g, ' ').trim(), qty: e.querySelector('.ord-qty').value, ph: e.querySelector('.ord-price').placeholder, price: e.querySelector('.ord-price').value,
        photos: [...e.querySelectorAll('.ord-photo')].map(c => c.value) })));
      ok('two lines, qty 1, the catalogue price as placeholder and an empty override',
        lines.length === 2 && lines[0].qty === '1' && lines[0].ph === '3800' && lines[0].price === '' && lines[1].ph === '1200', JSON.stringify(lines));
      ok('each photo line offers exactly the project’s picks (IMG_1, IMG_2 — not the unpicked IMG_3)',
        JSON.stringify(lines[0].photos) === JSON.stringify(['20260819/IMG_1.jpg', '20260819/IMG_2.jpg']) && JSON.stringify(lines[1].photos) === JSON.stringify(lines[0].photos), JSON.stringify(lines.map(l => l.photos)));

      await page.fill('.ord-line-edit:nth-child(1) .ord-qty', '2');
      await page.fill('.ord-line-edit:nth-child(2) .ord-price', '1000');
      await page.click('.ord-line-edit:nth-child(1) summary');
      await page.check('.ord-line-edit:nth-child(1) .ord-photo[value="20260819/IMG_1.jpg"]');
      await page.check('.ord-line-edit:nth-child(1) .ord-photo[value="20260819/IMG_2.jpg"]');
      ok('the photo summary follows the ticks', (await page.textContent('.ord-line-edit:nth-child(1) [data-photo-summary]')) === '照片（2 張）');
      await page.fill('#pd-ed-discount', '100');
      await page.fill('#pd-ed-note', '婚禮加購');
      await page.click('#pd-editor-save');
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/admin/projects/proj-z/orders');
      ok('POST sends option ids, qty, ticked photos, an override only where typed, the discount and note',
        JSON.stringify(post?.body) === JSON.stringify({
          lines: [{ qty: 2, photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'], option_id: 'opt-album-s' },
                  { qty: 1, photo_keys: [], option_id: 'opt-print', unit_price: 1000 }],
          discount: 100, note: '婚禮加購' }), JSON.stringify(post?.body));
      const card = await page.$eval('#pd-order-list .ord-card', e => ({ total: e.querySelector('.ord-total').textContent, text: e.textContent.replace(/\s+/g, ' ') }));
      ok('the editor closes and the order is listed with its computed total (2×3,800 + 1,000 − 100 = NT$8,500)', card.total === 'NT$8,500' && (await page.$('#pd-order-editor')) === null, JSON.stringify(card));
      ok('the add button is back', (await page.$('#pd-order-add-btn')) !== null);

      // errors: a retired option (raced with the catalogue), empty lines
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.click('#pd-editor-save');
      ok('saving with no lines is refused client-side', (await page.textContent('#pd-editor-err')).includes('請至少加入一個品項') && o.st.calls.filter(c => c.method === 'POST' && /orders$/.test(c.path)).length === 1);
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      await page.fill('.ord-line-edit .ord-qty', '0');
      await page.click('#pd-editor-save');
      ok('qty 0 is refused client-side', (await page.textContent('#pd-editor-err')).includes('數量需為 1–999'));
      await page.fill('.ord-line-edit .ord-qty', '1');
      o.st.products.find(p => p.id === 'prod-print').options[0].active = 0;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('已下架'));
      ok('retired_option → 「這個商品規格已下架…」 and the editor stays', (await page.$('#pd-order-editor')) !== null);
      await page.click('#pd-editor-cancel');
      ok('取消 closes the editor', (await page.$('#pd-order-editor')) === null && (await page.$$('#pd-order-list .ord-card')).length === 1);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-f', title: '平台價下限' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('admin — 訂單品項是平台商品：單價不能低於平台價（below_platform_price），平台下架的規格（retired_option）顯示中文',
    `${base}/admin.html#project=proj-f`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.selectOption('#pd-add-option', 'opt-album-s');
      await page.click('#pd-add-line');
      await page.fill('.ord-line-edit .ord-price', '1400');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於平台價'));
      ok('a unit price under 平台價 (1,400 < 1,500) → 「售價不能低於平台價」 from the Worker, the editor stays, nothing created',
        (await page.$('#pd-order-editor')) !== null && o.st.orders.length === 0, await T(page, '#pd-editor-err'));
      await page.fill('.ord-line-edit .ord-price', '1500');
      await page.click('#pd-editor-save');
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 3000 });
      ok('a price exactly at 平台價 is accepted and the line costs the platform price (成本 NT$1,500, 毛利 NT$0)',
        (await T(page, '#pd-order-list .ord-card')).includes('成本 NT$1,500') && (await T(page, '#pd-order-list .ord-card')).includes('毛利 NT$0'), await T(page, '#pd-order-list .ord-card'));
      const listed = await page.evaluate(async () => (await fetch('https://imagepicker.hotichen.workers.dev/api/admin/orders', { headers: { 'Authorization': 'Bearer adm' } })).text());
      ok('the line snapshotted the platform option and cost (stored), and the photographer’s order read never carries vendor_cost',
        o.st.orders[0].items[0].platform_option_id === 'popt-album-s' && o.st.orders[0].items[0].unit_cost === 1500 && o.st.orders[0].items[0].vendor_cost === 1400 &&
        listed.includes('platform_option_id') && !listed.includes('vendor_cost'), listed.slice(0, 200));
      // the platform retires the print between opening the picker and saving
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      o.st.platform.find(p => p.id === 'plat-print').active = 0;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('已下架'));
      ok('a platform-retired option → 「這個商品規格已下架…」 and the editor stays', (await page.$('#pd-order-editor')) !== null && o.st.orders.length === 1);
      await page.click('#pd-editor-cancel');
      // editing the saved order: repricing a platform line under its cost is refused
      await page.click('[data-order-edit]');
      await page.waitForSelector('#pd-order-editor');
      await page.fill('.ord-line-edit .ord-price', '1499');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於平台價'));
      ok('editing a saved platform line under its own snapshotted cost → below_platform_price', o.st.orders[0].items[0].unit_price === 1500);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-n', title: '沒商品' });
  const o = ordersFake({ products: [clone(PROD_SERVICE_OFF)] });
  await suite('admin — 沒有上架商品時，新增訂單指引到設定，而不是給空選單',
    `${base}/admin.html#project=proj-n`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-order-editor');
      await page.waitForFunction(() => !document.getElementById('pd-order-editor').textContent.includes('載入商品中'), null, { timeout: 3000 });
      ok('no picker, a link to settings.html', (await page.$('#pd-add-option')) === null &&
        (await page.$eval('#pd-order-editor a', e => e.getAttribute('href'))) === 'settings.html');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-e', title: '編輯訂單' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  o.st.addOrder({ id: 'ord-e1', project_id: 'proj-e', items: [
    { id: 'it-1', name: '相本書', option_label: '8×8 吋', kind: 'album', option_id: 'opt-album-s', unit_price: 3800, qty: 1, photo_keys: ['20260819/IMG_1.jpg'] },
    { id: 'it-2', name: '無框畫', kind: 'print', option_id: 'opt-print', unit_price: 1200, qty: 1 }] });
  o.st.addOrder({ id: 'ord-e2', project_id: 'proj-e', paid_amount: 5000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ id: 'it-3', name: '相本書', kind: 'album', option_id: 'opt-album-s', unit_price: 5000, qty: 1 }] });
  await suite('admin — 編輯訂單：帶入現有品項，改數量／刪品項／加品項／折扣，PUT 整組；below_paid 與 conflict 顯示中文',
    `${base}/admin.html#project=proj-e`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      // newest first: ord-e2 then ord-e1
      await page.click('[data-order-id="ord-e1"] [data-order-edit]');
      await page.waitForSelector('#pd-order-editor[data-mode="edit"]');
      ok('the editor replaces that order’s card, in place', (await page.$('[data-order-id="ord-e1"].ord-card')) === null && (await page.$('[data-order-id="ord-e2"].ord-card')) !== null);
      const lines = await page.$$eval('.ord-line-edit', els => els.map(e => ({ qty: e.querySelector('.ord-qty').value, price: e.querySelector('.ord-price').value,
        checked: [...e.querySelectorAll('.ord-photo:checked')].map(c => c.value) })));
      ok('existing lines are prefilled: qty, the snapshot price, ticked photos',
        JSON.stringify(lines) === JSON.stringify([{ qty: '1', price: '3800', checked: ['20260819/IMG_1.jpg'] }, { qty: '1', price: '1200', checked: [] }]), JSON.stringify(lines));
      await page.fill('.ord-line-edit:nth-child(1) .ord-qty', '3');
      await page.click('.ord-line-edit:nth-child(2) [data-line-del]');
      ok('移除 drops the line from the editor', (await page.$$('.ord-line-edit')).length === 1);
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      await page.fill('#pd-ed-discount', '50');
      await page.fill('#pd-ed-note', '改過');
      await page.click('#pd-editor-save');
      await page.waitForSelector('[data-order-id="ord-e1"].ord-card', { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT is the whole set: the kept line by id with its snapshot price, the new one by option_id with no override',
        put?.path === '/api/admin/orders/ord-e1' && JSON.stringify(put.body) === JSON.stringify({
          lines: [{ qty: 3, photo_keys: ['20260819/IMG_1.jpg'], id: 'it-1', unit_price: 3800 }, { qty: 1, photo_keys: [], option_id: 'opt-print' }],
          discount: 50, note: '改過' }), JSON.stringify(put));
      ok('the card shows the new total (3×3,800 + 1,200 − 50 = NT$12,550)', (await page.textContent('[data-order-id="ord-e1"] .ord-total')) === 'NT$12,550');

      // below_paid: shrink the paid order under what was received
      await page.click('[data-order-id="ord-e2"] [data-order-edit]');
      await page.waitForSelector('#pd-order-editor');
      await page.fill('.ord-line-edit .ord-price', '1000');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於已收金額'));
      ok('below_paid → 「訂單總額不能低於已收金額…」, the editor stays for a correction', (await page.$('#pd-order-editor')) !== null);
      // conflict: the page says so and re-reads
      o.st.inject = (method, path) => (method === 'PUT') ? { status: 409, body: { error: '訂單剛被修改，請重新整理', code: 'conflict' } } : null;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-order-err', t => t.includes('資料已被更新，請重新整理'));
      ok('conflict → 「資料已被更新，請重新整理」 and the orders are re-read (editor closed, cards back)',
        (await page.$('#pd-order-editor')) === null && (await page.$$('#pd-order-list .ord-card')).length === 2);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-p', title: '收款' });
  const o = ordersFake({ products: [] });
  o.st.addOrder({ id: 'ord-u', project_id: 'proj-p', items: [{ name: '相本書', unit_price: 3200, qty: 1 }] });
  o.st.addOrder({ id: 'ord-part', project_id: 'proj-p', paid_amount: 1000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z', items: [{ name: '無框畫', unit_price: 3200, qty: 1 }] });
  let dialogs = [];
  let answer = true;
  await suite('admin — 記錄收款：預設金額為訂單總額、方式與日期，overpaid 中文提示並留著表單，清除收款要確認',
    `${base}/admin.html#project=proj-p`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      ok('no payment form until asked', (await page.$('[data-pay-form]')) === null);
      await page.click('[data-order-id="ord-u"] [data-pay-open]');
      await page.waitForSelector('[data-order-id="ord-u"] [data-pay-form]');
      const f = await page.$eval('[data-order-id="ord-u"] [data-pay-form]', e => ({ amount: e.querySelector('.pay-amount').value, method: e.querySelector('.pay-method').value,
        methods: [...e.querySelectorAll('.pay-method option')].map(x => x.textContent), date: e.querySelector('.pay-date').value }));
      ok('default amount is what is owed (the whole NT$3,200)', f.amount === '3200', f.amount);
      ok('methods are 現金 / 轉帳 / 其他', f.methods.join() === '現金,轉帳,其他', f.methods.join());
      ok('the date defaults to today (a YYYY-MM-DD, Taipei)', f.date === todayTaipeiNode(), f.date);
      ok('the 記錄收款 button gives way to the form', (await page.$('[data-order-id="ord-u"] [data-pay-open]')) === null);

      await page.fill('[data-order-id="ord-u"] .pay-amount', '9999');
      await page.click('[data-order-id="ord-u"] [data-pay-save]');
      await waitText(page, '[data-order-id="ord-u"] [data-order-err]', t => t.includes('收款金額不能超過訂單總額'));
      ok('overpaid → 「收款金額不能超過訂單總額」, the form stays so the amount can be fixed', (await page.$('[data-order-id="ord-u"] [data-pay-form]')) !== null);
      await page.fill('[data-order-id="ord-u"] .pay-amount', '3200');
      await page.selectOption('[data-order-id="ord-u"] .pay-method', 'transfer');
      await page.click('[data-order-id="ord-u"] [data-pay-save]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-u"] .ord-pay')?.textContent === '已付清', null, { timeout: 3000 });
      const pay = o.st.calls.filter(c => c.path === '/api/admin/orders/ord-u/payment').pop();
      ok('POST /payment carries amount, method and the date', JSON.stringify(pay.body) === JSON.stringify({ paid_amount: 3200, paid_method: 'transfer', paid_at: todayTaipeiNode() }), JSON.stringify(pay.body));
      ok('the card is now 已付清 with 未收 NT$0 and offers 清除收款',
        (await page.textContent('[data-order-id="ord-u"] .ord-owed')) === 'NT$0' && (await page.$('[data-order-id="ord-u"] [data-pay-clear]')) !== null);

      // a part-paid order: the default settles it (paid_amount is the running total, not an extra instalment)
      ok('the part-paid order says 部分已付 and owes NT$2,200', (await page.textContent('[data-order-id="ord-part"] .ord-pay')) === '部分已付' &&
        (await page.textContent('[data-order-id="ord-part"] .ord-owed')) === 'NT$2,200');
      await page.click('[data-order-id="ord-part"] [data-pay-open]');
      ok('its form defaults to the total (NT$3,200) with the earlier method preselected',
        (await page.inputValue('[data-order-id="ord-part"] .pay-amount')) === '3200' && (await page.inputValue('[data-order-id="ord-part"] .pay-method')) === 'cash' &&
        (await page.inputValue('[data-order-id="ord-part"] .pay-date')) === '2026-09-20');
      await page.click('[data-order-id="ord-part"] [data-pay-cancel]');
      ok('取消 closes the form, nothing sent', (await page.$('[data-pay-form]')) === null && o.st.calls.filter(c => /ord-part\/payment/.test(c.path)).length === 0);

      // clearing
      answer = false;
      await page.click('[data-order-id="ord-u"] [data-pay-clear]');
      await page.waitForTimeout(300);
      ok('declining the confirm sends nothing', o.st.calls.filter(c => c.body?.paid_amount === 0).length === 0 && dialogs.some(t => t.includes('清除')));
      answer = true;
      await page.click('[data-order-id="ord-u"] [data-pay-clear]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-u"] .ord-pay')?.textContent === '未付款', null, { timeout: 3000 });
      ok('confirming posts paid_amount 0 and the order is 未付款 again, NT$3,200 owed',
        JSON.stringify(o.st.calls.filter(c => c.body?.paid_amount === 0).pop()?.body) === JSON.stringify({ paid_amount: 0 }) &&
        (await page.textContent('[data-order-id="ord-u"] .ord-owed')) === 'NT$3,200' && (await page.$('[data-order-id="ord-u"] [data-pay-clear]')) === null);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-s', title: '狀態' });
  const o = ordersFake({ products: [] });
  o.st.addOrder({ id: 'ord-s', project_id: 'proj-s', items: [{ name: '相本書', unit_price: 3000, qty: 1 }] });
  o.st.addOrder({ id: 'ord-r', project_id: 'proj-s', status: 'requested', items: [{ name: '無框畫', unit_price: 1200, qty: 1 }] });
  let answer = false;
  const dialogs = [];
  await suite('admin — 狀態按鈕：確認／完成／復原／取消（取消要確認），bad_transition 顯示中文',
    `${base}/admin.html#project=proj-s`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const btns = id => page.$$eval(`[data-order-id="${id}"] [data-status-to]`, els => els.map(e => `${e.dataset.statusTo}:${e.textContent}`).join());
      ok('requested offers 確認 and 取消訂單 (and not 完成)', (await btns('ord-r')) === 'confirmed:確認,cancelled:取消訂單', await btns('ord-r'));
      ok('confirmed offers 完成 and 取消訂單 (and not 確認)', (await btns('ord-s')) === 'fulfilled:完成,cancelled:取消訂單', await btns('ord-s'));

      await page.click('[data-order-id="ord-r"] [data-status-to="confirmed"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-r"]')?.dataset.status === 'confirmed', null, { timeout: 3000 });
      ok('確認 posts {status: confirmed} with no confirm dialog', o.st.calls.some(c => c.path === '/api/admin/orders/ord-r/status' && c.body.status === 'confirmed') && dialogs.length === 0);

      await page.click('[data-order-id="ord-s"] [data-status-to="fulfilled"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'fulfilled', null, { timeout: 3000 });
      ok('完成 → 已完成, and the buttons become 復原為已確認 / 取消訂單', (await btns('ord-s')) === 'confirmed:復原為已確認,cancelled:取消訂單' &&
        (await page.textContent('[data-order-id="ord-s"] .ord-status')) === '已完成');
      await page.click('[data-order-id="ord-s"] [data-status-to="confirmed"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'confirmed', null, { timeout: 3000 });
      ok('復原 goes back to 已確認', (await btns('ord-s')) === 'fulfilled:完成,cancelled:取消訂單');

      await page.click('[data-order-id="ord-s"] [data-status-to="cancelled"]');
      await page.waitForTimeout(300);
      ok('取消訂單 asks first; declining sends nothing and changes nothing',
        dialogs.length === 1 && dialogs[0].includes('取消') && !o.st.calls.some(c => c.body?.status === 'cancelled') &&
        (await page.$eval('[data-order-id="ord-s"]', e => e.dataset.status)) === 'confirmed');
      answer = true;
      await page.click('[data-order-id="ord-s"] [data-status-to="cancelled"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'cancelled', null, { timeout: 3000 });
      // 亮色主題: "greyed" is now a cream tint + dashed edge (opacity would pull its muted text under
      // 4.5:1); the live card it was a moment ago is white with a solid edge, so the change is real
      ok('accepting cancels: set apart (cream tint, dashed edge), 已取消, and no buttons left', (await page.$$('[data-order-id="ord-s"] .ord-actions button')).length === 0 &&
        (await page.$eval('[data-order-id="ord-s"]', e => { const c = getComputedStyle(e); return c.backgroundColor === 'rgb(255, 248, 238)' && c.borderTopStyle === 'dashed'; })) &&
        (await page.$eval('[data-order-id="ord-r"]', e => { const c = getComputedStyle(e); return c.backgroundColor === 'rgb(255, 255, 255)' && c.borderTopStyle === 'solid'; })));

      // a move that lost a race: the Worker says where the order really is
      o.st.inject = (method, path) => /ord-r\/status/.test(path) ? { status: 409, body: { error: '無法從 cancelled 改為 fulfilled', code: 'bad_transition', from: 'cancelled', to: 'fulfilled' } } : null;
      await page.click('[data-order-id="ord-r"] [data-status-to="fulfilled"]');
      await waitText(page, '[data-order-id="ord-r"] [data-order-err]', t => t.includes('無法執行'));
      ok('bad_transition → 「訂單目前是「已取消」，無法執行這個操作，請重新整理」',
        (await page.textContent('[data-order-id="ord-r"] [data-order-err]')) === '訂單目前是「已取消」，無法執行這個操作，請重新整理');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}
}
