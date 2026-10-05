// Browser suites: settings 商品清單: platform products, custom services, adopt / edit / retire.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { PROD_ALBUM, PROD_PRINT, PROD_SERVICE_OFF, RED, T, clone, disp, ordersFake, platFx, waitText } from '../lib/orders-fake.mjs';

export default async function register() {
{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT), clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 商品清單：平台商品有圖與平台價、自訂服務有成本，下架的灰掉並可重新上架，金額為 NT$',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const rows = await page.$$eval('.prod-row', els => els.map(e => ({
        id: e.dataset.productId, retired: e.classList.contains('retired'), opacity: getComputedStyle(e).opacity, adopted: e.dataset.adopted,
        kind: e.querySelector('.pill[data-kind]').textContent, text: e.textContent.replace(/\s+/g, ' '),
        buttons: [...e.querySelectorAll('button')].map(b => b.textContent),
        img: e.querySelector('img.prod-thumb') ? e.querySelector('img.prod-thumb').getAttribute('src') : null,
        placeholder: !!e.querySelector('div.prod-thumb.none'),
      })));
      ok('three products listed, active first', rows.map(r => r.id).join() === 'prod-album,prod-print,prod-svc', JSON.stringify(rows.map(r => r.id)));
      ok('kinds shown as 相本 / 輸出品 / 服務, not album/print/service',
        rows.map(r => r.kind).join() === '相本,輸出品,服務', JSON.stringify(rows.map(r => r.kind)));
      ok('an adopted album shows 平台價 and 售價 per option as NT$1,234-style money, no 成本 column',
        rows[0].text.includes('8×8 吋 · 平台價 NT$1,500 · 售價 NT$3,800') && rows[0].text.includes('12×12 吋 · 平台價 NT$2,400 · 售價 NT$5,800') && !rows[0].text.includes('成本'), rows[0].text);
      ok('it is tagged 平台商品; a custom service is not', rows[0].text.includes('平台商品') && !rows[2].text.includes('平台商品'), rows[2].text);
      ok('a retired option of an active product is not listed', !rows[0].text.includes('舊規格'));
      ok('an option with no label reads （單一規格）', rows[1].text.includes('（單一規格） · 平台價 NT$500 · 售價 NT$1,200'), rows[1].text);
      ok('the album says how many photos it is set for', rows[0].text.includes('指定 20 張'));
      ok('a custom service still shows 售價 and 成本', rows[2].text.includes('售價 NT$500 · 成本 NT$0'), rows[2].text);
      ok('the adopted album shows the platform image from the public route (no token in the URL)',
        rows[0].img && rows[0].img.includes('/api/platform/products/plat-album/image') && !rows[0].img.includes('adm') && !rows[0].img.includes('t='), String(rows[0].img));
      await page.waitForFunction(() => { const i = document.querySelector('[data-product-id="prod-album"] img.prod-thumb'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 4000 });
      ok('…and it actually loaded', true);
      ok('an adopted product with no platform image shows a 無圖 placeholder, not a broken img', rows[1].img === null && rows[1].placeholder);
      ok('a custom product has no thumbnail slot at all', rows[2].img === null && !rows[2].placeholder);
      ok('active rows are full strength and offer 下架 (not 重新上架)',
        !rows[0].retired && rows[0].opacity === '1' && rows[0].buttons.includes('下架') && !rows[0].buttons.includes('重新上架'), JSON.stringify(rows[0]));
      ok('the retired row is greyed (computed opacity < 1), tagged 已下架 and offers 重新上架 (not 下架)',
        rows[2].retired && Number(rows[2].opacity) < 1 && rows[2].text.includes('已下架') && rows[2].buttons.includes('重新上架') && !rows[2].buttons.includes('下架'), JSON.stringify(rows[2]));
      ok('no warning anywhere while every 售價 is at or above 平台價', (await page.$$('.warn-below')).length === 0 && (await page.$$('[data-below]')).length === 0);
      ok('the catalogue was read with the admin token', o.st.calls[0]?.auth === 'Bearer adm');

      await page.click('[data-product-id="prod-svc"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '1', null, { timeout: 3000 });
      ok('重新上架 posts /restore and the row comes back at full strength',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-svc/restore') &&
        (await page.$eval('[data-product-id="prod-svc"]', e => getComputedStyle(e).opacity)) === '1');
      await page.click('[data-product-id="prod-print"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-print"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 posts /retire and greys the row',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-print/retire') &&
        Number(await page.$eval('[data-product-id="prod-print"]', e => getComputedStyle(e).opacity)) < 1);
      ok('retire/restore sent no body', o.st.calls.filter(c => /retire|restore/.test(c.path)).every(c => c.body === null));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, products: [] });
  await suite('設定 — 新增服務：自訂商品只有服務（沒有類型選單、不問張數），驗證、規格列增減，送出的內容正確',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      ok('an empty catalogue points to both ways in', (await T(page, '#prod-list')).includes('從平台加入') && (await T(page, '#prod-list')).includes('新增服務'));
      ok('the add button now reads 新增服務', (await T(page, '#prod-add-btn')).includes('新增服務'));
      ok('no form until asked', (await page.$('#prod-form')) === null);
      await page.click('#prod-add-btn');
      await page.waitForSelector('#prod-form');
      ok('the form is 新增服務', (await T(page, '#prod-form h3')) === '新增服務' && (await page.getAttribute('#prod-form', 'data-kind')) === 'service');
      ok('there is no kind select and no album/print choice anywhere in the form',
        (await page.$('#pf-kind')) === null && (await page.$$('#prod-form select')).length === 0 && !(await T(page, '#prod-form')).includes('相本書') && !(await T(page, '#prod-form')).includes('無框畫、放大'));
      ok('and no photo-count field (removed from the DOM, not just hidden)', (await page.$('#pf-count-group')) === null && (await page.$('#pf-count')) === null);
      ok('the add buttons hide while the form is open (computed display)', (await disp(page, '#prod-add-btn')) === 'none' && (await disp(page, '#plat-add-btn')) === 'none');

      await page.click('#pf-save');
      ok('no name → a Chinese error and nothing sent', (await T(page, '#pf-err')).includes('商品名稱必填') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#pf-name', '急件加修');
      await page.click('#pf-save');
      ok('a blank price is refused client-side', (await T(page, '#pf-err')).includes('售價需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.click('#pf-options .opt-del');
      ok('removing the only option row is refused, the row stays',
        (await page.$$('#pf-options .opt-row')).length === 1 && (await T(page, '#pf-err')).includes('至少保留一個規格'));

      await page.fill('#pf-desc', '三天內交件');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-label', '加修 1 張');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-price', '500');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-cost', '100');
      await page.click('#pf-add-option');
      ok('新增規格 adds a row', (await page.$$('#pf-options .opt-row')).length === 2);
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-label', '加修 5 張');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-price', '2000');
      await page.click('#pf-add-option');
      await page.click('#pf-options .opt-row:nth-child(3) .opt-del');
      ok('a row can be removed while others remain', (await page.$$('#pf-options .opt-row')).length === 2);
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/admin/products');
      ok('POST carries kind service, name, description, photo_count null and the options (blank cost = 0)',
        JSON.stringify(post?.body) === JSON.stringify({
          name: '急件加修', description: '三天內交件', photo_count: null,
          options: [{ label: '加修 1 張', price: 500, cost: 100 }, { label: '加修 5 張', price: 2000, cost: 0 }], kind: 'service',
        }), JSON.stringify(post?.body));
      ok('the form is gone from the DOM and the add buttons are back', (await page.$('#prod-form')) === null && (await disp(page, '#prod-add-btn')) !== 'none' && (await disp(page, '#plat-add-btn')) !== 'none');
      await page.waitForSelector('.prod-row');
      ok('the new service is listed with its money and tagged 服務', (await T(page, '.prod-row')).includes('加修 5 張 · 售價 NT$2,000 · 成本 NT$0') && (await T(page, '.prod-row .pill[data-kind]')) === '服務');
      ok('and 已儲存商品 is shown', (await T(page, '#prod-ok')).includes('已儲存商品'));

      // the Worker's own refusals are shown in Chinese, and the form stays
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products') ? { status: 400, body: { error: 'invalid price', code: 'invalid_price' } } : null;
      await page.click('#prod-add-btn');
      await page.fill('#pf-name', '外拍加時');
      await page.fill('#pf-options .opt-row .opt-price', '1200');
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價需為'));
      ok('a server error code becomes a Chinese sentence and the form stays open', (await page.$('#prod-form')) !== null);
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products') ? { status: 400, body: { error: 'platform only', code: 'platform_only' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('從平台加入'));
      ok('platform_only (should the Worker ever refuse) → 「相本與輸出品要從「從平台加入」新增…」', (await T(page, '#pf-err')).includes('自訂商品只能是服務'));
      o.st.inject = null;
      // the real fake refuses an album from the custom route, so the fake mirrors the Worker
      const direct = await page.evaluate(async () => {
        const r = await fetch('https://imagepicker.hotichen.workers.dev/api/admin/products', { method: 'POST', headers: { 'Authorization': 'Bearer adm', 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'album', name: 'x', options: [{ label: '', price: 1 }] }) });
        return { status: r.status, body: await r.json() };
      });
      ok('the fake answers 400 platform_only for a custom album, like the Worker', direct.status === 400 && direct.body.code === 'platform_only', JSON.stringify(direct));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const svc = { ...clone(PROD_SERVICE_OFF), active: 1, options: [
    { id: 'opt-a', label: '加修 1 張', price: 500, cost: 100, active: 1, sort: 0 }, { id: 'opt-b', label: '加修 5 張', price: 2000, cost: 0, active: 1, sort: 1 },
    { id: 'opt-old', label: '停賣', price: 1, cost: 0, active: 0, sort: 2 }] };
  const o = ordersFake({ customProducts: true, products: [svc] });
  await suite('設定 — 編輯自訂服務：規格帶入（含 id），改價／刪／加後 PUT 的內容正確（不送 kind）',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('[data-product-id="prod-svc"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('title says 編輯商品, still no kind select', (await T(page, '#prod-form h3')) === '編輯商品' && (await page.$('#pf-kind')) === null && (await page.getAttribute('#prod-form', 'data-mode')) === 'edit');
      const rows = await page.$$eval('#pf-options .opt-row', els => els.map(e => ({ id: e.dataset.optionId, label: e.querySelector('.opt-label').value, price: e.querySelector('.opt-price').value, cost: e.querySelector('.opt-cost').value })));
      ok('only the active options are prefilled, each keeping its id',
        JSON.stringify(rows) === JSON.stringify([
          { id: 'opt-a', label: '加修 1 張', price: '500', cost: '100' }, { id: 'opt-b', label: '加修 5 張', price: '2000', cost: '0' }]), JSON.stringify(rows));
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-price', '600');
      await page.click('#pf-options .opt-row:nth-child(2) .opt-del');
      await page.click('#pf-add-option');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-label', '加修 3 張');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-price', '1400');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT goes to the product, without kind; the kept option carries its id, the new one none, the removed one is absent',
        put?.path === '/api/admin/products/prod-svc' && JSON.stringify(put.body) === JSON.stringify({
          name: '急件加修', description: '', photo_count: null,
          options: [{ label: '加修 1 張', price: 600, cost: 100, id: 'opt-a' }, { label: '加修 3 張', price: 1400, cost: 0 }],
        }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('.prod-row')?.textContent.includes('NT$1,400'), null, { timeout: 3000 });
      const text = await T(page, '.prod-row');
      ok('the list shows the new set and no longer the dropped option', text.includes('NT$600') && text.includes('加修 3 張') && !text.includes('加修 5 張'), text);
      await page.click('[data-edit]');
      await page.waitForSelector('#prod-form');
      await page.click('#pf-cancel');
      ok('取消 closes the form without a request', (await page.$('#prod-form')) === null && o.st.calls.filter(c => c.method === 'PUT').length === 1);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: CUSTOM_PRODUCTS off (the default) / on ────────────────────────
{
  const m = dashSettingsMock();
  const svcOn = { ...clone(PROD_SERVICE_OFF), id: 'prod-svc-on', name: '外拍加時', active: 1, options: [{ id: 'opt-on', label: '', price: 800, cost: 0, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), svcOn, clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 自訂商品關閉（預設）：沒有「新增服務」按鈕（不在 DOM），舊的自訂服務只剩下架',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      ok('the list was read and the fake said custom products are off', o.st.calls.some(c => c.method === 'GET' && c.path === '/api/admin/products') && o.st.customProducts === false);
      ok('從平台加入 is there and shown (computed display)', (await page.$('#plat-add-btn')) !== null && (await disp(page, '#plat-add-btn')) !== 'none');
      ok('新增服務 is not in the DOM at all', (await page.$('#prod-add-btn')) === null);
      const buttonTexts = await page.$$eval('button', els => els.map(e => e.textContent));
      ok('no button anywhere reads 新增服務', !buttonTexts.some(t => t.includes('新增服務')), JSON.stringify(buttonTexts));
      const rows = await page.$$eval('.prod-row', els => els.map(e => ({ id: e.dataset.productId, buttons: [...e.querySelectorAll('button')].map(b => b.textContent) })));
      ok('all three products are still listed', rows.map(r => r.id).join() === 'prod-album,prod-svc-on,prod-svc', JSON.stringify(rows));
      ok('the adopted product keeps 編輯 and 下架', JSON.stringify(rows[0].buttons) === JSON.stringify(['編輯', '下架']), JSON.stringify(rows[0]));
      ok('an active custom service offers 下架 only', JSON.stringify(rows[1].buttons) === JSON.stringify(['下架']), JSON.stringify(rows[1]));
      ok('a retired custom service offers nothing (no 重新上架, no 編輯)', rows[2].buttons.length === 0, JSON.stringify(rows[2]));
      ok('the retired one is still greyed and tagged 已下架',
        Number(await page.$eval('[data-product-id="prod-svc"]', e => getComputedStyle(e).opacity)) < 1 && (await T(page, '[data-product-id="prod-svc"]')).includes('已下架'));

      await page.click('[data-product-id="prod-svc-on"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc-on"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 on a custom service posts /retire and greys it',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-svc-on/retire') &&
        Number(await page.$eval('[data-product-id="prod-svc-on"]', e => getComputedStyle(e).opacity)) < 1);
      ok('…and it now offers nothing either', (await page.$$('[data-product-id="prod-svc-on"] button')).length === 0);

      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form');
      await page.click('#plat-close');
      await page.waitForFunction(() => !document.getElementById('plat-form'), null, { timeout: 3000 });
      ok('opening and closing 從平台加入 does not bring 新增服務 back', (await page.$('#prod-add-btn')) === null && (await disp(page, '#plat-add-btn')) !== 'none');

      ok('custom_products_disabled reads 「目前只能從平台加入商品」',
        (await page.evaluate(() => window.Orders.errorText({ error: 'x', code: 'custom_products_disabled' }, 403))) === '目前只能從平台加入商品');
      const direct = await page.evaluate(async () => {
        const call = async (method, path, body) => {
          const r = await fetch(`https://imagepicker.hotichen.workers.dev${path}`, { method, headers: { 'Authorization': 'Bearer adm', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
          return [r.status, (await r.json()).code];
        };
        return [
          await call('POST', '/api/admin/products', { kind: 'service', name: 'x', options: [{ label: '', price: 1 }] }),
          await call('PUT', '/api/admin/products/prod-svc', { name: 'x' }),
          await call('POST', '/api/admin/products/prod-svc/restore'),
        ];
      });
      ok('the fake answers 403 custom_products_disabled for create, edit and restore, like the Worker',
        JSON.stringify(direct) === JSON.stringify([[403, 'custom_products_disabled'], [403, 'custom_products_disabled'], [403, 'custom_products_disabled']]), JSON.stringify(direct));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [] });
  await suite('設定 — 自訂商品關閉（預設）：空清單只指向「從平台加入」',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('#prod-list').textContent.includes('載入中'), null, { timeout: 3000 });
      const text = await T(page, '#prod-list');
      ok('the empty hint points to 從平台加入', text.includes('從平台加入'), text);
      ok('…and never mentions 新增服務', !text.includes('新增服務'), text);
      ok('新增服務 is not in the DOM', (await page.$('#prod-add-btn')) === null);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, products: [clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 自訂商品開啟：「新增服務」在「從平台加入」旁邊，自訂服務可編輯與重新上架',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.waitForSelector('#prod-add-btn', { timeout: 3000 });
      ok('新增服務 is shown (computed display) and reads ＋ 新增服務',
        (await disp(page, '#prod-add-btn')) !== 'none' && (await T(page, '#prod-add-btn')).includes('新增服務'));
      ok('it sits right after 從平台加入, in the same row',
        await page.$eval('#prod-add-btn', e => e.previousElementSibling?.id === 'plat-add-btn' && e.parentElement === document.getElementById('plat-add-btn').parentElement));
      ok('there is exactly one', (await page.$$('#prod-add-btn')).length === 1);
      const buttons = await page.$$eval('[data-product-id="prod-svc"] button', els => els.map(e => e.textContent));
      ok('a retired custom service offers 編輯 and 重新上架', JSON.stringify(buttons) === JSON.stringify(['編輯', '重新上架']), JSON.stringify(buttons));
      await page.click('#prod-add-btn');
      await page.waitForSelector('#prod-form');
      ok('it opens the 新增服務 form', (await T(page, '#prod-form h3')) === '新增服務');
      ok('and hides itself while the form is open', (await disp(page, '#prod-add-btn')) === 'none');
      await page.click('#pf-cancel');
      ok('取消 brings it back', (await disp(page, '#prod-add-btn')) !== 'none' && (await page.$$('#prod-add-btn')).length === 1);

      // the switch goes off while the page is open: the next read takes 新增服務 out of the DOM
      await page.click('[data-product-id="prod-svc"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '1', null, { timeout: 3000 });
      o.st.customProducts = false;
      await page.click('[data-product-id="prod-svc"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('after a re-read with the switch off, 新增服務 is gone from the DOM', (await page.$('#prod-add-btn')) === null && (await disp(page, '#plat-add-btn')) !== 'none');
      ok('…and the retired custom service offers nothing', (await page.$$('[data-product-id="prod-svc"] button')).length === 0);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: 從平台加入 ────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  const retiredPlat = { id: 'plat-frame', kind: 'print', name: '已停產相框', description: '', photo_count: null, active: 0, sort: 5, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-frame', label: '', vendor_cost: 100, platform_price: 100, active: 1, sort: 0 }] };
  const o = ordersFake({ customProducts: true, platform: [...platFx(), retiredPlat], products: [clone(PROD_PRINT)] });
  await suite('設定 — 從平台加入：只列上架的平台商品（圖、說明、規格與平台價），已加入的顯示「已加入」並開編輯，勾規格填售價（≥ 平台價）後送出',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      ok('nothing of the platform list is shown until asked', (await page.$('#plat-form')) === null);
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form .plat-card');
      const cards = await page.$$eval('.plat-card', els => els.map(e => ({ id: e.dataset.platformId, adopted: e.dataset.adopted, text: e.textContent.replace(/\s+/g, ' '),
        img: e.querySelector('img.prod-thumb')?.getAttribute('src') || null, ticks: e.querySelectorAll('.pick-check').length })));
      ok('only the two active platform products are listed (not the retired 已停產相框)', cards.map(c => c.id).join() === 'plat-album,plat-print', JSON.stringify(cards.map(c => c.id)));
      ok('the album card has its image (public route), description, photo count and both active sizes with 平台價 — not the retired 舊規格',
        cards[0].img?.includes('/api/platform/products/plat-album/image') && cards[0].text.includes('20 頁精裝') && cards[0].text.includes('指定 20 張') &&
        cards[0].text.includes('8×8 吋') && cards[0].text.includes('平台價 NT$1,500') && cards[0].text.includes('12×12 吋') && cards[0].text.includes('平台價 NT$2,400') && !cards[0].text.includes('舊規格'), cards[0].text);
      ok('the vendor cost is nowhere on the page', !(await T(page, 'body')).includes('1,400') && !(await T(page, 'body')).includes('2,300'));
      ok('the album is not adopted yet: two tick boxes, unticked', cards[0].adopted === '0' && cards[0].ticks === 2);
      ok('the already-adopted 無框畫 says 已加入, has no picker and no 加入 button, but an 編輯 button',
        cards[1].adopted === '1' && cards[1].text.includes('已加入') && cards[1].ticks === 0 &&
        (await page.$('[data-platform-id="plat-print"] [data-plat-add]')) === null && (await page.$('[data-platform-id="plat-print"] [data-plat-edit]')) !== null, cards[1].text);
      ok('the add buttons are hidden while the panel is open', (await disp(page, '#prod-add-btn')) === 'none' && (await disp(page, '#plat-add-btn')) === 'none');

      const sel = (opt, part) => `[data-platform-id="plat-album"] [data-platform-option-id="${opt}"] .${part}`;
      ok('售價 is prefilled with 平台價 but disabled until the size is ticked',
        (await page.inputValue(sel('popt-album-s', 'pick-price'))) === '1500' && await page.$eval(sel('popt-album-s', 'pick-price'), e => e.disabled));
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      ok('nothing ticked → 「請至少勾選一個規格」 and no request', (await T(page, '[data-platform-id="plat-album"] .plat-err')).includes('請至少勾選一個規格') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'));
      await page.check(sel('popt-album-s', 'pick-check'));
      ok('ticking enables the price', !(await page.$eval(sel('popt-album-s', 'pick-price'), e => e.disabled)));
      await page.fill(sel('popt-album-s', 'pick-price'), '1499');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      const floorMsg = await T(page, '[data-platform-id="plat-album"] .plat-err');
      ok('售價 1,499 under 平台價 1,500 is refused client-side with the floor named, nothing sent',
        floorMsg.includes('售價不能低於平台價') && floorMsg.includes('NT$1,500') && floorMsg.includes('8×8 吋') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'), floorMsg);
      await page.fill(sel('popt-album-s', 'pick-price'), '1500.5');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      ok('a non-integer price is refused', (await T(page, '[data-platform-id="plat-album"] .plat-err')).includes('售價需為 0 以上的整數') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'), await T(page, '[data-platform-id="plat-album"] .plat-err'));
      await page.fill(sel('popt-album-s', 'pick-price'), '1500');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      await page.waitForFunction(() => !document.getElementById('plat-form'), null, { timeout: 3000 });
      ok('a price exactly at 平台價 is accepted (the floor is inclusive)', true);
      const post = o.st.calls.find(c => c.path === '/api/admin/products/from-platform');
      ok('POST carries the platform product and only the ticked option with its price',
        post?.method === 'POST' && JSON.stringify(post.body) === JSON.stringify({ platform_product_id: 'plat-album', options: [{ platform_option_id: 'popt-album-s', price: 1500 }] }), JSON.stringify(post));
      await page.waitForSelector('[data-adopted="1"][data-product-id]:not([data-product-id="prod-print"])');
      const added = await page.$$eval('.prod-row', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
      ok('the new adopted album is listed with 平台價 and 售價, and 已加入平台商品 is shown',
        added.some(t => t.includes('相本書') && t.includes('8×8 吋 · 平台價 NT$1,500 · 售價 NT$1,500')) && (await T(page, '#prod-ok')).includes('已加入平台商品'), JSON.stringify(added));
      ok('the panel is gone and the add buttons are back', (await page.$('#plat-form')) === null && (await disp(page, '#plat-add-btn')) !== 'none');

      // reopen: the album is now 已加入, 編輯 opens that product's edit form
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form .plat-card');
      ok('the album card now reads 已加入 too', (await page.getAttribute('[data-platform-id="plat-album"]', 'data-adopted')) === '1' && (await T(page, '[data-platform-id="plat-album"]')).includes('已加入'));
      await page.click('[data-platform-id="plat-album"] [data-plat-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      ok('編輯 closes the panel and opens the adopted product’s edit form', (await page.$('#plat-form')) === null && (await T(page, '#prod-form')).includes('相本書'));
      await page.click('#pf-cancel');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [] });
  await suite('設定 — 從平台加入：Worker 的拒絕（below_platform_price、already_adopted 競態、retired）顯示中文，卡片跟著更新',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('.plat-card');
      const opt = 'popt-print';
      const card = '[data-platform-id="plat-print"]';
      await page.check(`${card} [data-platform-option-id="${opt}"] .pick-check`);
      // the operator raised the platform price after the page loaded: the page still says 500, the Worker says 700
      o.st.platform.find(p => p.id === 'plat-print').options[0].platform_price = 700;
      await page.click(`${card} [data-plat-add]`);
      await waitText(page, `${card} .plat-err`, t => t.includes('售價不能低於平台價'));
      ok('below_platform_price from the Worker → 「售價不能低於平台價」 and the panel stays', (await page.$('#plat-form')) !== null);
      ok('nothing was created', o.st.products.length === 0);
      // an adopt racing another tab: 409 already_adopted → message, and the card flips to 已加入
      o.st.platform.find(p => p.id === 'plat-print').options[0].platform_price = 500;
      o.st.products.push({ ...clone(PROD_PRINT), id: 'prod-raced' });
      await page.click(`${card} [data-plat-add]`);
      await waitText(page, `${card} .plat-err`, t => t.includes('已經加入過'));
      ok('409 already_adopted → 「已經加入過這個平台商品了」', true);
      await page.waitForFunction(() => document.querySelector('[data-platform-id="plat-print"]')?.dataset.adopted === '1', null, { timeout: 3000 });
      ok('…and after the re-read the card reads 已加入 with 編輯, and the list has the other tab’s product',
        (await page.$(`${card} [data-plat-edit]`)) !== null && (await page.$('[data-product-id="prod-raced"]')) !== null);
      // the platform retired the product meanwhile
      await page.click('#plat-close');
      ok('關閉 closes the panel', (await page.$('#plat-form')) === null);
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products/from-platform') ? { status: 400, body: { error: 'unknown platform product', code: 'unknown_platform_product' } } : null;
      await page.click('#plat-add-btn');
      await page.waitForSelector('[data-platform-id="plat-album"] .pick-check');
      await page.check('[data-platform-id="plat-album"] [data-platform-option-id="popt-album-s"] .pick-check');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      await waitText(page, '[data-platform-id="plat-album"] .plat-err', t => t.includes('找不到這個平台商品'));
      ok('unknown_platform_product → 「找不到這個平台商品，請重新整理」', true);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: [], products: [] });
  await suite('設定 — 從平台加入：平台沒有商品時說明，讀取失敗顯示錯誤而不是空白',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form');
      ok('an empty platform says so', (await T(page, '#plat-form')).includes('平台目前沒有可加入的商品'));
      await page.click('#plat-close');
      o.st.inject = (method, path) => path === '/api/admin/platform-products' ? { status: 500, body: { error: 'no such table' } } : null;
      await page.click('#plat-add-btn');
      await waitText(page, '#prod-err', t => t.includes('讀取平台商品失敗'));
      ok('a failed read says 讀取平台商品失敗 and gives the buttons back', (await page.$('#plat-form')) === null && (await disp(page, '#plat-add-btn')) !== 'none');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: adopted products — edit, warning, unavailable ─────────────────
{
  const m = dashSettingsMock();
  const plat = platFx();
  const o = ordersFake({ platform: plat, products: [clone(PROD_ALBUM)] });
  // the operator raised 8×8 to NT$4,000 — the photographer still sells it at NT$3,800
  o.st.platform[0].options[0].platform_price = 4000;
  await suite('設定 — 平台價調整後：低於平台價的規格顯示紅字警告，其他規格不受影響',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const lis = await page.$$eval('.prod-row li', els => els.map(e => ({ id: e.dataset.optionId, below: e.dataset.below || null, text: e.textContent.replace(/\s+/g, ' '),
        warn: e.querySelector('.warn-below') ? { text: e.querySelector('.warn-below').textContent, color: getComputedStyle(e.querySelector('.warn-below')).color } : null })));
      ok('the 8×8 option (售價 3,800 < 平台價 4,000) shows the red warning with the exact sentence',
        lis[0].below === '1' && lis[0].warn?.text === '平台價已調整，售價低於平台價，請更新' && lis[0].warn.color === RED && lis[0].text.includes('平台價 NT$4,000 · 售價 NT$3,800'), JSON.stringify(lis[0]));
      ok('the 12×12 option (售價 5,800 ≥ 平台價 2,400) has no warning', lis[1].below === null && lis[1].warn === null, JSON.stringify(lis[1]));

      await page.click('[data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      const optSel = id => `#pf-options [data-platform-option-id="${id}"]`;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價不能低於平台價'));
      ok('saving with the price still under the raised 平台價 is refused client-side, naming NT$4,000',
        (await T(page, '#pf-err')).includes('NT$4,000') && !o.st.calls.some(c => c.method === 'PUT'), await T(page, '#pf-err'));
      await page.fill(`${optSel('popt-album-s')} .pick-price`, '4200');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      await page.waitForSelector('.prod-row li');
      ok('after raising 售價 to NT$4,200 the warning is gone (positive: the row shows the new price)',
        (await page.$$('.warn-below')).length === 0 && (await T(page, '.prod-row')).includes('售價 NT$4,200'), await T(page, '.prod-row'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('設定 — 編輯平台商品：只能改規格與售價（不能改名稱／類型／說明），PUT 只送 options，下架規格顯示不可用',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      const box = '#pf-options';
      ok('no editable name, description, kind or count — the platform’s',
        (await page.$('#pf-name')) === null && (await page.$('#pf-desc')) === null && (await page.$('#pf-kind')) === null && (await page.$('#pf-count')) === null && (await T(page, '#prod-form')).includes('由平台管理'));
      const rows = await page.$$eval(`${box} .pick-row`, els => els.map(e => ({ id: e.dataset.platformOptionId, checked: e.querySelector('.pick-check').checked,
        price: e.querySelector('.pick-price')?.value ?? null, disabled: e.querySelector('.pick-price')?.disabled ?? null, text: e.textContent.replace(/\s+/g, ' ') })));
      ok('both active platform sizes are rows, ticked, with the photographer’s 售價 (not 平台價); the retired 舊規格 is not offered',
        rows.length === 2 && rows.every(r => r.checked) && rows[0].price === '3800' && rows[1].price === '5800' && !rows.some(r => r.id === 'popt-album-old'), JSON.stringify(rows));
      ok('each row shows its 平台價 floor', rows[0].text.includes('平台價 NT$1,500') && rows[1].text.includes('平台價 NT$2,400'));
      await page.uncheck(`${box} [data-platform-option-id="popt-album-l"] .pick-check`);
      await page.fill(`${box} [data-platform-option-id="popt-album-s"] .pick-price`, '1000');
      await page.click('#pf-save');
      ok('售價 1,000 under 平台價 1,500 is refused, no PUT', (await T(page, '#pf-err')).includes('售價不能低於平台價') && !o.st.calls.some(c => c.method === 'PUT'));
      await page.fill(`${box} [data-platform-option-id="popt-album-s"] .pick-price`, '4000');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT sends only options: the kept size repriced, the unticked one left out (the Worker retires it) — no name/kind/description/photo_count',
        put?.path === '/api/admin/products/prod-album' && JSON.stringify(put.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 4000 }] }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-album"]')?.textContent.includes('NT$4,000'), null, { timeout: 3000 });
      const text = await T(page, '[data-product-id="prod-album"]');
      ok('the list shows the new price and no longer the dropped size', text.includes('售價 NT$4,000') && !text.includes('12×12 吋'), text);

      // add the size back: unticked rows are offered again
      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('the dropped size is offered again, unticked, price prefilled with 平台價',
        !(await page.isChecked(`${box} [data-platform-option-id="popt-album-l"] .pick-check`)) && (await page.inputValue(`${box} [data-platform-option-id="popt-album-l"] .pick-price`)) === '2400');
      await page.check(`${box} [data-platform-option-id="popt-album-l"] .pick-check`);
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put2 = o.st.calls.filter(c => c.method === 'PUT').pop();
      ok('PUT lists both in platform order, the re-added one at its 平台價',
        JSON.stringify(put2.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 4000 }, { platform_option_id: 'popt-album-l', price: 2400 }] }), JSON.stringify(put2.body));

      // unticking everything
      await page.click('[data-product-id="prod-print"] [data-edit]');
      await page.waitForSelector('#prod-form');
      await page.uncheck(`${box} .pick-check`);
      await page.click('#pf-save');
      ok('nothing left ticked → 「請至少勾選一個規格」', (await T(page, '#pf-err')).includes('請至少勾選一個規格') && o.st.calls.filter(c => c.method === 'PUT').length === 2);
      // the Worker's own refusals
      await page.check(`${box} .pick-check`);
      o.st.inject = (method, path) => method === 'PUT' ? { status: 400, body: { error: 'platform managed', code: 'platform_managed' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('由平台管理'));
      ok('platform_managed → 「名稱、類型、說明與張數由平台管理…」, the form stays', (await page.$('#prod-form')) !== null);
      o.st.inject = (method, path) => method === 'PUT' ? { status: 400, body: { error: 'below platform price', code: 'below_platform_price' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價不能低於平台價'));
      ok('below_platform_price from the Worker → 「售價不能低於平台價」', true);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const plat = platFx();
  const o = ordersFake({ platform: plat, products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  // the platform retired the album's 12×12 size and the whole 無框畫 product
  o.st.platform[0].options[1].active = 0;
  o.st.platform[1].active = 0;
  await suite('設定 — 平台下架的規格／商品：清單標「平台已下架」並變灰，編輯時不能勾選；整個商品下架則不能改規格',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const li = await page.$$eval('[data-product-id="prod-album"] li', els => els.map(e => ({ id: e.dataset.optionId, off: e.dataset.unavailable || null, opacity: getComputedStyle(e).opacity, text: e.textContent.replace(/\s+/g, ' ') })));
      ok('the retired 12×12 size reads 平台已下架 and is dimmed; the live 8×8 is not',
        li[1].off === '1' && li[1].text.includes('平台已下架') && Number(li[1].opacity) < 1 && li[0].off === null && !li[0].text.includes('平台已下架') && li[0].opacity === '1', JSON.stringify(li));
      ok('a retired size never shows the price warning', (await page.$$('[data-product-id="prod-album"] .warn-below')).length === 0);
      const pr = await page.$eval('[data-product-id="prod-print"]', e => ({ text: e.textContent.replace(/\s+/g, ' '), opacity: getComputedStyle(e).opacity, active: e.dataset.active, cls: e.className }));
      ok('the product the platform retired is tagged 平台已下架 and dimmed, though the photographer never retired it',
        pr.text.includes('平台已下架') && Number(pr.opacity) < 1 && pr.active === '1', JSON.stringify(pr));
      ok('its option is marked unavailable too', (await page.$('[data-product-id="prod-print"] li[data-unavailable="1"]')) !== null);

      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form');
      const rows = await page.$$eval('#pf-options .pick-row', els => els.map(e => ({ id: e.dataset.platformOptionId, checked: e.querySelector('.pick-check').checked, disabled: e.querySelector('.pick-check').disabled,
        price: !!e.querySelector('.pick-price'), text: e.textContent.replace(/\s+/g, ' ') })));
      ok('the live size is a normal ticked row; the retired one is listed, unticked, disabled, with no price box',
        rows.length === 2 && rows[0].checked && !rows[0].disabled && rows[0].price && rows[1].id === 'popt-album-l' && !rows[1].checked && rows[1].disabled && !rows[1].price && rows[1].text.includes('平台已下架'), JSON.stringify(rows));
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('saving sends only the live size (the retired one is dropped, never sent — the Worker would answer retired_option)',
        JSON.stringify(put.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 3800 }] }), JSON.stringify(put.body));

      await page.click('[data-product-id="prod-print"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('a product the platform retired: an explanation, every row disabled, 儲存 disabled',
        (await T(page, '#prod-form')).includes('平台已下架這個商品') && await page.$eval('#pf-save', e => e.disabled) && await page.$eval('#pf-options .pick-check', e => e.disabled));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM)] });
  await suite('設定 — 不連到營運頁：側邊選單沒有 operator 連結，頁面只帶攝影師權杖，即使瀏覽器裡有營運權杖也不用',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('.plat-card');
      ok('the side menu has items (positive) but none points at operator.html',
        (await page.$$('#sideNav .side-nav-item')).length >= 8 && (await page.$$('a[href*="operator"]')).length === 0);
      ok('every request the page made carried the photographer’s token, none the operator’s',
        o.st.calls.filter(c => !c.path.startsWith('/api/platform/')).length >= 2 && o.st.calls.filter(c => !c.path.startsWith('/api/platform/')).every(c => c.auth === 'Bearer adm') && !o.st.calls.some(c => c.path.startsWith('/api/operator')), JSON.stringify(o.st.calls.map(c => [c.path, c.auth])));
      ok('the operator token is still in localStorage, untouched', (await page.evaluate(() => localStorage.getItem('imhoti_operator_token'))) === 'op');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: () => { sessionStorage.setItem('studio_token', 'adm'); localStorage.setItem('imhoti_operator_token', 'op'); } });
}
}
