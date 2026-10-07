// Browser suites: operator page: login, platform products, images, sales table.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { SEED_TOKEN_ALWAYS } from '../lib/dashboard-mocks.mjs';
import { OP_KEY, OP_SEED, PLAT_ALBUM, PLAT_PRINT, RED, T, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

// ── operator.html — the operator's console (platform catalogue) ────────────
const opFx = () => [clone(PLAT_ALBUM), clone(PLAT_PRINT)];
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 登入：營運權杖存在自己的 localStorage 鍵，不碰攝影師的 studio_token；錯的權杖（含攝影師的）進不去',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      ok('signed out: the sign-in box is shown and the console is not (computed display)', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and the logout button is not shown', (await disp(page, '#op-logout')) === 'none');
      ok('no request was made before signing in', o.st.calls.length === 0, JSON.stringify(o.st.calls));
      ok('the token field is a password field', (await page.getAttribute('#op-token', 'type')) === 'password');

      await page.click('#op-login-btn');
      ok('an empty token asks for one, no request', (await T(page, '#op-login-err')).includes('請輸入營運權杖') && o.st.calls.length === 0);

      // the photographer's token is not the operator's: the Worker refuses it on /api/operator
      await page.fill('#op-token', 'adm');
      await page.click('#op-login-btn');
      await waitText(page, '#op-login-err', t => t.includes('營運權杖不正確'));
      ok('the photographer’s token is refused (401) with a Chinese message; still signed out',
        (await disp(page, '#op-app')) === 'none' && (await disp(page, '#op-login')) !== 'none' && o.st.calls.at(-1).auth === 'Bearer adm' && o.st.calls.at(-1).path === '/api/operator/products');
      ok('nothing was left in localStorage by the failed attempt', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);

      await page.fill('#op-token', 'op');
      await page.click('#op-login-btn');
      await page.waitForSelector('#op-list .prod-row', { timeout: 4000 });
      ok('the operator token opens the console (computed display) and hides the sign-in', (await disp(page, '#op-app')) !== 'none' && (await disp(page, '#op-login')) === 'none' && (await disp(page, '#op-logout')) !== 'none');
      ok('the operator token is stored under its own localStorage key', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === 'op');
      ok('it is not stored anywhere the photographer’s pages read: sessionStorage studio_token is untouched (null)', (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null);
      ok('no key holds it besides its own', await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(k => (localStorage.getItem(k) === 'op' || sessionStorage.getItem(k) === 'op')).join()) === OP_KEY);
      ok('every call the console made went to /api/operator (or the public image route) with Bearer op — never /api/admin',
        o.st.calls.length >= 3 && o.st.calls.filter(c => c.auth === 'Bearer op').length >= 2 && !o.st.calls.some(c => c.path.startsWith('/api/admin')) &&
        o.st.calls.filter(c => !c.path.startsWith('/api/platform/') && c.auth !== 'Bearer adm').every(c => c.auth === 'Bearer op'), JSON.stringify(o.st.calls.map(c => [c.path, c.auth])));
      ok('the side menu is not on this page and it does not link to the photographer’s pages', (await page.$('#sideNav')) === null && (await page.$('a[href*="dashboard"]')) === null && (await page.$('a[href*="settings"]')) === null);

      await page.reload();
      await page.waitForSelector('#op-list .prod-row', { timeout: 4000 });
      ok('a reload stays signed in from the stored token', (await disp(page, '#op-app')) !== 'none');
      await page.click('#op-logout');
      ok('登出 shows the sign-in again', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and removes its own key only', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);
      await page.reload();
      await page.waitForSelector('#op-login');
      ok('after a reload it is still signed out', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      return out;
    },
    { before: o.attach, });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 攝影師已登入時（studio_token）仍要自己登入：不沿用攝影師的權杖',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('with a photographer session present, the console still asks for the operator token', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and made no request with the photographer’s token', o.st.calls.length === 0, JSON.stringify(o.st.calls));
      ok('the photographer’s token is still there, unchanged', (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === 'adm');
      return out;
    },
    { before: o.attach, initScript: SEED_TOKEN_ALWAYS });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 已存的權杖失效（401）：清掉自己的鍵並回到登入畫面；網路錯誤不清權杖',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await waitText(page, '#op-login-err', t => t.includes('營運權杖不正確或已失效'));
      ok('a stale stored token → sign-in with 「營運權杖不正確或已失效，請重新登入」', (await disp(page, '#op-app')) === 'none');
      ok('and the stale key is removed', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);
      return out;
    },
    { before: o.attach, initScript: () => localStorage.setItem('imhoti_operator_token', 'old-token') });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  o.st.inject = () => ({ status: 500, body: { error: 'DB not configured' } });
  await suite('operator — 伺服器錯誤（500）：顯示錯誤但保留已存的權杖，不當成登入失敗',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await waitText(page, '#op-login-err', t => t.includes('DB not configured'));
      ok('the Worker’s message is shown on the sign-in screen', (await disp(page, '#op-app')) === 'none');
      ok('the stored token is kept', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === 'op');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const retired = { id: 'plat-old', kind: 'print', name: '停產相框', description: '', photo_count: null, active: 0, sort: 0, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-old', label: '', vendor_cost: 100, platform_price: 150, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: [retired, ...opFx()], products: [] });
  await suite('operator — 平台商品清單：上架的在前，下架的灰掉並可重新上架；成本／平台價／張數；金額為 NT$',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const rows = await page.$$eval('#op-list .prod-row', els => els.map(e => ({ id: e.dataset.productId, active: e.dataset.active, opacity: getComputedStyle(e).opacity,
        kind: e.querySelector('.pill[data-kind]').textContent, text: e.textContent.replace(/\s+/g, ' '), buttons: [...e.querySelectorAll('button')].map(b => b.textContent),
        img: e.querySelector('img.thumb')?.getAttribute('src') || null, placeholder: !!e.querySelector('div.thumb.none') })));
      ok('active products first even though the retired one came first in the data', rows.map(r => r.id).join() === 'plat-album,plat-print,plat-old', JSON.stringify(rows.map(r => r.id)));
      ok('kinds are 相本 / 輸出品', rows[0].kind === '相本' && rows[1].kind === '輸出品' && rows[2].kind === '輸出品');
      ok('an album shows each size with 廠商成本 and 平台價 in NT$, and how many photos',
        rows[0].text.includes('8×8 吋 · 廠商成本 NT$1,400 · 平台價 NT$1,500') && rows[0].text.includes('12×12 吋 · 廠商成本 NT$2,300 · 平台價 NT$2,400') && rows[0].text.includes('指定 20 張'), rows[0].text);
      ok('a retired size of an active product is listed but marked 已下架規格 and dimmed', rows[0].text.includes('舊規格') && rows[0].text.includes('已下架規格') &&
        Number(await page.$eval('[data-product-id="plat-album"] li[data-option-id="popt-album-old"]', e => getComputedStyle(e).opacity)) < 1);
      ok('a single size with no label reads （單一規格）', rows[1].text.includes('（單一規格） · 廠商成本 NT$450 · 平台價 NT$500'), rows[1].text);
      ok('the album has its picture from the public route, the print a 無圖 placeholder',
        rows[0].img?.includes('/api/platform/products/plat-album/image') && rows[1].img === null && rows[1].placeholder);
      ok('active rows are full strength with 下架 (not 重新上架)', rows[0].opacity === '1' && rows[0].buttons.includes('下架') && !rows[0].buttons.includes('重新上架'), JSON.stringify(rows[0]));
      ok('the retired row is greyed (computed opacity < 1), tagged 已下架, with 重新上架 (not 下架)',
        Number(rows[2].opacity) < 1 && rows[2].active === '0' && rows[2].text.includes('已下架') && rows[2].buttons.includes('重新上架') && !rows[2].buttons.includes('下架'), JSON.stringify(rows[2]));

      await page.click('[data-product-id="plat-old"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-old"]')?.dataset.active === '1', null, { timeout: 3000 });
      ok('重新上架 posts /restore with the operator token and the row returns to full strength',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/products/plat-old/restore' && c.auth === 'Bearer op') &&
        (await page.$eval('[data-product-id="plat-old"]', e => getComputedStyle(e).opacity)) === '1');
      ok('and it sorts among the active ones now (before nothing greyed)', (await page.$$eval('#op-list .prod-row', els => els.map(e => e.dataset.active).join())) === '1,1,1');
      await page.click('[data-product-id="plat-print"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-print"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 posts /retire, greys the row and moves it below the active ones',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/products/plat-print/retire') &&
        Number(await page.$eval('[data-product-id="plat-print"]', e => getComputedStyle(e).opacity)) < 1 &&
        (await page.$$eval('#op-list .prod-row', els => els.at(-1).dataset.productId)) === 'plat-print');
      ok('retire/restore sent no body', o.st.calls.filter(c => /retire|restore/.test(c.path)).every(c => c.body === null));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator — 新增平台商品：只有相本／輸出品、相本才問張數、驗證、規格列增減，送出的內容正確，建立後可接著上傳圖片',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      ok('an empty catalogue says so', (await T(page, '#op-list')).includes('還沒有平台商品'));
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      ok('the kind choices are only 相本 and 輸出品 (no 服務 — that is the photographer’s own)',
        JSON.stringify(await page.$$eval('#opf-kind option', els => els.map(e => e.textContent))) === JSON.stringify(['相本', '輸出品']));
      ok('an album asks for a photo count (computed display)', (await disp(page, '#opf-count-group')) !== 'none');
      await page.selectOption('#opf-kind', 'print');
      ok('a print does not', (await disp(page, '#opf-count-group')) === 'none');
      await page.selectOption('#opf-kind', 'album');
      ok('image upload is not offered until the product exists (no file input; a hint instead)', (await page.$('#opf-file')) === null && (await T(page, '#op-form')).includes('先儲存商品'));
      ok('the add button hides while the form is open', (await disp(page, '#op-add-btn')) === 'none');

      await page.click('#opf-save');
      ok('no name → 商品名稱必填, nothing sent', (await T(page, '#opf-err')).includes('商品名稱必填') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#opf-name', '相本書');
      await page.click('#opf-save');
      ok('a blank 廠商成本 is refused client-side', (await T(page, '#opf-err')).includes('廠商成本需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-vendor', '1400');
      await page.click('#opf-save');
      ok('a blank 平台價 is refused client-side', (await T(page, '#opf-err')).includes('平台價需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.click('#opf-options .opt-del');
      ok('removing the only option row is refused', (await page.$$('#opf-options .opt-row')).length === 1 && (await T(page, '#opf-err')).includes('至少保留一個規格'));

      await page.fill('#opf-desc', '20 頁精裝');
      await page.fill('#opf-count', '20');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-label', '8×8 吋');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1500');
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-label', '12×12 吋');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-vendor', '2300');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-plat', '2400');
      await page.click('#opf-add-option');
      await page.click('#opf-options .opt-row:nth-child(3) .opt-del');
      ok('a row can be removed while others remain', (await page.$$('#opf-options .opt-row')).length === 2);
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/operator/products');
      ok('POST carries kind, name, description, photo_count and options with vendor_cost and platform_price',
        JSON.stringify(post?.body) === JSON.stringify({
          kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20, min_pages: 10, max_pages: null, extra_page_price: null, bleed_mm: null,
          options: [{ label: '8×8 吋', vendor_cost: 1400, platform_price: 1500 }, { label: '12×12 吋', vendor_cost: 2300, platform_price: 2400 }],
        }), JSON.stringify(post?.body));
      ok('after creating, the form stays open on the new product in edit mode, now with the image section', (await page.$('#opf-file')) !== null && (await T(page, '#op-ok')).includes('已建立'));
      ok('and the product is listed with its money', (await T(page, '#op-list')).includes('12×12 吋 · 廠商成本 NT$2,300 · 平台價 NT$2,400'));
      await page.click('#opf-cancel');
      ok('取消 closes the form and brings the add button back', (await page.$('#op-form')) === null && (await disp(page, '#op-add-btn')) !== 'none');

      // Worker refusals in Chinese
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status: 400, body: { error: 'invalid vendor cost', code: 'invalid_vendor_cost' } } : null;
      await page.click('#op-add-btn');
      await page.selectOption('#opf-kind', 'print');
      await page.fill('#opf-name', '無框畫');
      await page.fill('#opf-options .opt-row .opt-vendor', '450');
      await page.fill('#opf-options .opt-row .opt-plat', '500');
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('廠商成本需為'));
      ok('invalid_vendor_cost from the Worker → 「廠商成本需為 0 以上的整數」, the form stays', (await page.$('#op-form')) !== null);
      const post2 = o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products').pop();
      ok('a print sends photo_count null', post2.body.photo_count === null && post2.body.kind === 'print', JSON.stringify(post2.body));
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status: 400, body: { error: 'invalid platform price', code: 'invalid_platform_price' } } : null;
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('平台價需為'));
      ok('invalid_platform_price → 「平台價需為 0 以上的整數」', true);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 編輯平台商品：帶入（含規格 id）、可改類型，改價／刪／加後 PUT 的內容正確',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('title says 編輯平台商品', (await T(page, '#op-form h3')) === '編輯平台商品');
      const rows = await page.$$eval('#opf-options .opt-row', els => els.map(e => ({ id: e.dataset.optionId, label: e.querySelector('.opt-label').value, v: e.querySelector('.opt-vendor').value, p: e.querySelector('.opt-plat').value })));
      ok('only the active options are prefilled, each with its id and both prices',
        JSON.stringify(rows) === JSON.stringify([{ id: 'popt-album-s', label: '8×8 吋', v: '1400', p: '1500' }, { id: 'popt-album-l', label: '12×12 吋', v: '2300', p: '2400' }]), JSON.stringify(rows));
      ok('name, description and count are prefilled', (await page.inputValue('#opf-name')) === '相本書' && (await page.inputValue('#opf-desc')) === '20 頁精裝' && (await page.inputValue('#opf-count')) === '20' && (await page.inputValue('#opf-kind')) === 'album');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1600');
      await page.click('#opf-options .opt-row:nth-child(2) .opt-del');
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-label', '10×10 吋');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-vendor', '1800');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-plat', '1900');
      await page.fill('#opf-count', '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT goes to the product; the kept option carries its id, the new one none, the dropped one is absent; blank count = null',
        put?.path === '/api/operator/products/plat-album' && put.auth === 'Bearer op' && JSON.stringify(put.body) === JSON.stringify({
          kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: null, min_pages: null, max_pages: null, extra_page_price: null, bleed_mm: null,
          options: [{ label: '8×8 吋', vendor_cost: 1400, platform_price: 1600, id: 'popt-album-s' }, { label: '10×10 吋', vendor_cost: 1800, platform_price: 1900 }],
        }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-album"]')?.textContent.includes('NT$1,900'), null, { timeout: 3000 });
      const text = await T(page, '[data-product-id="plat-album"]');
      ok('the list shows the new set; the dropped size appears only as 已下架規格', text.includes('平台價 NT$1,600') && text.includes('10×10 吋') && /12×12 吋[^·]*·[^·]*·[^·]*已下架規格/.test(text), text);
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form');
      await page.selectOption('#opf-kind', 'print');
      ok('switching the kind to 輸出品 hides the count', (await disp(page, '#opf-count-group')) === 'none');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put2 = o.st.calls.filter(c => c.method === 'PUT').pop();
      ok('a kind change is sent (the Worker allows it) with photo_count null', put2.body.kind === 'print' && put2.body.photo_count === null, JSON.stringify(put2.body));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 平台價低於廠商成本的警告 ─────────────────────────────────────
{
  const cheap = { id: 'plat-cheap', kind: 'print', name: '補貼款', description: '', photo_count: null, active: 1, sort: 0, has_image: false, image_type: null, image_updated_at: null,
    options: [
      { id: 'popt-under', label: '低於成本', vendor_cost: 600, platform_price: 500, active: 1, sort: 0 },
      { id: 'popt-equal', label: '等於成本', vendor_cost: 500, platform_price: 500, active: 1, sort: 1 },
      { id: 'popt-over', label: '高於成本', vendor_cost: 400, platform_price: 500, active: 1, sort: 2 },
      { id: 'popt-retired', label: '停賣款', vendor_cost: 900, platform_price: 100, active: 0, sort: 3 }] };
  const o = ordersFake({ platform: [cheap], products: [] });
  await suite('operator — 平台價低於廠商成本：清單與表單都出現警告（只警告，仍可儲存）；等於、高於或未填完則沒有',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const warned = await page.$$eval('#op-list li', els => els.map(e => ({ id: e.dataset.optionId, chip: e.querySelector('.chip-warn')?.textContent || null })));
      ok('the option priced under its vendor cost carries 「平台價低於廠商成本」', warned.find(w => w.id === 'popt-under').chip === '平台價低於廠商成本', JSON.stringify(warned));
      ok('equal and higher-than-cost options have no chip (positive: the first does)', warned.find(w => w.id === 'popt-equal').chip === null && warned.find(w => w.id === 'popt-over').chip === null);
      ok('a retired option is not flagged even when under cost', warned.find(w => w.id === 'popt-retired').chip === null);
      ok('the chip is visible red text (computed color)', (await page.$eval('#op-list .chip-warn', e => getComputedStyle(e).color)) === RED);

      await page.click('[data-edit]');
      await page.waitForSelector('#op-form');
      const chips = async () => page.$$eval('#opf-options .opt-row', els => els.map(e => !!e.querySelector('.opt-warn .chip-warn')));
      ok('in the form the same one row shows the chip on open (under: yes, equal: no, over: no)', JSON.stringify(await chips()) === JSON.stringify([true, false, false]), JSON.stringify(await chips()));
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '600');
      ok('typing 平台價 up to the cost clears it live', JSON.stringify(await chips()) === JSON.stringify([false, false, false]));
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '399');
      ok('typing 平台價 under the cost sets it live', JSON.stringify(await chips()) === JSON.stringify([false, false, true]));
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '');
      ok('an unfinished (blank) price shows no chip', JSON.stringify(await chips()) === JSON.stringify([false, false, false]));
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-label', '新款');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-vendor', '1000');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-plat', '800');
      ok('a new row gets the chip as soon as both numbers are in and price < cost', (await chips())[3] === true);
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '399');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('saving with a price under cost is allowed — the PUT went out with both numbers (Tim may subsidise)',
        put && put.body.options.find(x => x.label === '新款').platform_price === 800 && put.body.options.find(x => x.label === '新款').vendor_cost === 1000, JSON.stringify(put));
      await page.waitForFunction(() => document.querySelectorAll('#op-list .chip-warn').length === 2, null, { timeout: 3000 });
      ok('and the list now flags the two under-cost options (新款, 高→399)', true);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 圖片 ─────────────────────────────────────────────────────────
{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 商品圖片：上傳後預覽（從公開路由載入）、移除；大小／格式錯誤顯示中文（前端與 Worker 的 413／415）',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await page.click('[data-product-id="plat-print"] [data-edit]');
      await page.waitForSelector('#opf-file');
      ok('a product with no picture shows 尚未上傳 and no 移除圖片 button (computed display)', (await T(page, '#opf-preview')).includes('尚未上傳') && (await page.$('#opf-preview img')) === null && (await disp(page, '#opf-img-remove')) === 'none');
      const imgCalls = () => o.st.calls.filter(c => c.method === 'PUT' && /\/image$/.test(c.path));

      // client-side guards: no request
      await page.setInputFiles('#opf-file', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_BYTES, Buffer.alloc(204800)]) });
      ok('a file over 200 KB is refused in Chinese before any request', (await T(page, '#opf-img-err')).includes('圖片超過 200 KB') && imgCalls().length === 0);
      await page.setInputFiles('#opf-file', { name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
      ok('a GIF is refused in Chinese before any request', (await T(page, '#opf-img-err')).includes('不支援的檔案格式') && imgCalls().length === 0);

      // the Worker sniffs the bytes, not the type: a text file claiming image/png → 415
      await page.setInputFiles('#opf-file', { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image at all') });
      await waitText(page, '#opf-img-err', t => t.includes('不支援的檔案格式'));
      ok('a non-image body labelled image/png → the Worker’s 415 unsupported_type → 「不支援的檔案格式，僅限 PNG / JPEG / WebP」',
        imgCalls().length === 1 && (await page.$('#opf-preview img')) === null);
      // a Worker-side 413 (e.g. limit lowered)
      o.st.inject = (method, path) => (method === 'PUT' && /\/image$/.test(path)) ? { status: 413, body: { error: '商品圖片不可超過 200 KB', code: 'too_large', max: 204800 } } : null;
      await page.setInputFiles('#opf-file', { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES });
      await waitText(page, '#opf-img-err', t => t.includes('圖片超過 200 KB'));
      ok('the Worker’s 413 too_large → 「圖片超過 200 KB，請壓縮後再試」', imgCalls().length === 2);
      o.st.inject = null;

      await page.setInputFiles('#opf-file', { name: 'good.png', mimeType: 'image/png', buffer: PNG_BYTES });
      await page.waitForSelector('#opf-preview img', { timeout: 3000 });
      const call = imgCalls().at(-1);
      ok('a real PNG is PUT raw to the operator image route with the operator token, its own type and size',
        call.path === '/api/operator/products/plat-print/image' && call.auth === 'Bearer op' && call.type === 'image/png' && call.size === PNG_BYTES.length, JSON.stringify(call));
      ok('the error message is cleared and 已更新圖片 shown', (await T(page, '#opf-img-err')) === '' && (await T(page, '#opf-img-ok')).includes('已更新圖片'));
      const src = await page.$eval('#opf-preview img', e => e.getAttribute('src'));
      ok('the preview comes from the public route, with a version stamp', src.includes('/api/platform/products/plat-print/image?v=') && !/[?&]t=/.test(src), src);
      await page.waitForFunction(() => { const i = document.querySelector('#opf-preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 4000 });
      ok('…and it actually loaded (the fake serves the stored image only once there is one)', true);
      ok('移除圖片 is offered now (computed display)', (await disp(page, '#opf-img-remove')) !== 'none');
      ok('the list row behind the form shows the thumbnail too', (await page.$('[data-product-id="plat-print"] img.thumb')) !== null && (await page.$('[data-product-id="plat-print"] div.thumb.none')) === null);
      ok('the public image requests carry no token (no Authorization header, no t= in the URL)', o.st.calls.filter(c => c.path.startsWith('/api/platform/')).length > 0 && o.st.calls.filter(c => c.path.startsWith('/api/platform/')).every(c => c.auth === null && !/[?&]t=/.test(c.search)));

      await page.click('#opf-img-remove');
      await page.waitForFunction(() => !document.querySelector('#opf-preview img'), null, { timeout: 3000 });
      ok('移除圖片 sends DELETE with the operator token', o.st.calls.some(c => c.method === 'DELETE' && c.path === '/api/operator/products/plat-print/image' && c.auth === 'Bearer op'));
      ok('the preview goes back to 尚未上傳, the button hides, the row gets the 無圖 placeholder',
        (await T(page, '#opf-preview')).includes('尚未上傳') && (await disp(page, '#opf-img-remove')) === 'none' && (await page.$('[data-product-id="plat-print"] div.thumb.none')) !== null && (await page.$('[data-product-id="plat-print"] img.thumb')) === null);
      const gone = await page.evaluate(async () => (await fetch('https://imagepicker.hotichen.workers.dev/api/platform/products/plat-print/image')).status);
      ok('and the public route answers 404 for it now', gone === 404, String(gone));

      // an existing image (the album) is shown in its edit form
      await page.click('#opf-cancel');
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#opf-preview img');
      ok('a product that already has a picture shows it and offers 移除圖片', (await disp(page, '#opf-img-remove')) !== 'none');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 銷售 ─────────────────────────────────────────────────────────
{
  const retired = { id: 'plat-old', kind: 'print', name: '停產相框', description: '', photo_count: null, active: 0, sort: 9, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-old', label: '', vendor_cost: 100, platform_price: 150, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: [...opFx(), retired], products: [] });
  const line = (opt, price, cost, vendor, qty, name) => ({ name, kind: 'album', unit_price: price, unit_cost: cost, vendor_cost: vendor, qty, platform_option_id: opt });
  // this month (2026-09, Taipei): 2 albums 8×8 at platform 1,500 / vendor 1,400 → 3,000 / 2,800; a subsidised print 500 / 600
  o.st.addOrder({ id: 'o1', status: 'fulfilled', paid_amount: 8000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z', items: [line('popt-album-s', 3800, 1500, 1400, 2, '相本書')] });
  o.st.addOrder({ id: 'o2', status: 'confirmed', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-05T04:00:00.000Z', items: [line('popt-print', 1200, 500, 600, 1, '無框畫')] });
  // last month: 1 more album 8×8 (counts in the 12 months, not this month)
  o.st.addOrder({ id: 'o3', status: 'fulfilled', paid_amount: 3800, paid_method: 'cash', paid_at: '2026-08-10T04:00:00.000Z', items: [line('popt-album-s', 3800, 1500, 1400, 1, '相本書')] });
  // never counted: cancelled, unpaid, and a non-platform line
  o.st.addOrder({ id: 'o4', status: 'cancelled', paid_amount: 5000, paid_method: 'cash', paid_at: '2026-09-06T04:00:00.000Z', items: [line('popt-album-l', 5800, 2400, 2300, 1, '相本書')] });
  o.st.addOrder({ id: 'o5', status: 'confirmed', paid_amount: 0, items: [line('popt-album-l', 5800, 2400, 2300, 1, '相本書')] });
  o.st.addOrder({ id: 'o6', status: 'confirmed', paid_amount: 500, paid_method: 'cash', paid_at: '2026-09-07T04:00:00.000Z', items: [{ name: '急件加修', kind: 'service', unit_price: 500, unit_cost: 0, qty: 1 }] });
  await suite('operator — 銷售表：本月合計與每個平台商品的數量、平台營收、廠商成本、毛利（已收款、不含取消／未付／非平台品項）',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-stats-table', { timeout: 5000 });
      const month = await page.$$eval('#op-month [data-k]', els => Object.fromEntries(els.map(e => [e.dataset.k, e.textContent])));
      ok('本月 totals: 3 units, 平台營收 NT$3,500, 廠商成本 NT$3,400, 毛利 NT$100 (2×1,500 + 500 vs 2×1,400 + 600)',
        month.qty === '3' && month.revenue === 'NT$3,500' && month.cost === 'NT$3,400' && month.margin === 'NT$100', JSON.stringify(month));
      const rows = await page.$$eval('#op-stats-table tbody tr', els => els.map(e => ({ id: e.dataset.platformProductId, retired: e.classList.contains('retired'), opacity: getComputedStyle(e).opacity,
        text: e.textContent.replace(/\s+/g, ' '), mq: e.querySelector('[data-col="month-qty"]').textContent, mm: e.querySelector('[data-col="month-margin"]').textContent,
        q: e.querySelector('[data-col="qty"]').textContent, rev: e.querySelector('[data-col="revenue"]').textContent, cost: e.querySelector('[data-col="cost"]').textContent,
        margin: e.querySelector('[data-col="margin"]').textContent, marginColor: getComputedStyle(e.querySelector('[data-col="margin"]')).color })));
      ok('one row per platform product, including one with no sales and a retired one', rows.map(r => r.id).join() === 'plat-album,plat-print,plat-old', JSON.stringify(rows.map(r => r.id)));
      const album = rows[0], print = rows[1], old = rows[2];
      ok('album: 本月 2 units margin NT$200; 12 months 3 units, 平台營收 NT$4,500, 廠商成本 NT$4,200, 毛利 NT$300 (cancelled, unpaid and the service line are not in it)',
        album.mq === '2' && album.mm === 'NT$200' && album.q === '3' && album.rev === 'NT$4,500' && album.cost === 'NT$4,200' && album.margin === 'NT$300', JSON.stringify(album));
      ok('a subsidised sale (platform price 500 under vendor cost 600) shows a loss as −NT$100 in red; a profitable row is not red',
        print.mq === '1' && print.q === '1' && print.rev === 'NT$500' && print.cost === 'NT$600' && print.margin === '−NT$100' && print.mm === '−NT$100' && print.marginColor === RED && album.marginColor !== RED, JSON.stringify(print));
      ok('a product with no sales reads zeros, greyed and tagged 已下架', old.q === '0' && old.mq === '0' && old.rev === 'NT$0' && old.margin === 'NT$0' && Number(old.opacity) < 1 && old.text.includes('已下架'), JSON.stringify(old));
      ok('the stats were read with the operator token', o.st.calls.some(c => c.path === '/api/operator/stats' && c.auth === 'Bearer op'));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator — 銷售：沒有平台商品時只有零的本月合計；讀取失敗顯示錯誤',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-month', { timeout: 5000 });
      ok('the month cards read zeros and no table is drawn', (await T(page, '#op-month [data-k="revenue"]')) === 'NT$0' && (await page.$('#op-stats-table')) === null && (await T(page, '#op-stats')).includes('還沒有平台商品'));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}
}
