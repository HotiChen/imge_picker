// Browser suites: settings 商品 — the 「顯示給客人」 switch (docs/guest-shop.md). An adopted product is created with
// guest_visible = 0 and the guest shop lists only guest_visible = 1, so without this switch the shop stays empty.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { PROD_ALBUM, PROD_PRINT, PROD_SERVICE_OFF, clone, ordersFake, platFx } from '../lib/orders-fake.mjs';

const row = id => `[data-product-id="${id}"]`;
const gv = id => `${row(id)} [data-guest-visible]`;
const putsOf = o => o.st.calls.filter(c => c.method === 'PUT' && c.path.startsWith('/api/admin/products/'));
const status = (page, id) => page.$eval(`${row(id)} [data-guest-status]`, e => e.textContent.trim());

export default async function register() {
{
  const underFloor = clone(PROD_PRINT); underFloor.id = 'prod-low'; underFloor.guest_visible = 1;
  underFloor.options[0].price = 400;                       // floor is 500: not sellable
  const retiredOn = clone(PROD_PRINT); retiredOn.id = 'prod-retired'; retiredOn.active = 0;
  const custom = clone(PROD_SERVICE_OFF); custom.id = 'prod-custom'; custom.active = 1;
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT), underFloor, retiredOn, custom] });
  await suite('設定 — 商品「顯示給客人」開關：預設客人看不到，開了才進客人商店；狀態、失敗還原、進行中鎖住、一次只送一個請求',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      ok('five rows listed (floor)', (await page.$$('.prod-row')).length === 5);
      ok('the section explains the switch once', ((await page.textContent('body')).match(/打開後，客人在完成頁看得到這個商品/g) || []).length === 1);
      ok('the three buttons are all still there', (await page.$$(`${row('prod-album')} [data-edit]`)).length === 1 && (await page.$$(`${row('prod-album')} [data-retire]`)).length === 1 && (await page.$$(`${row('prod-retired')} [data-restore]`)).length === 1);

      // a hidden product
      ok('a hidden product has an UNchecked switch labelled 顯示給客人', (await page.$(gv('prod-album'))) !== null && (await page.isChecked(gv('prod-album'))) === false && (await page.textContent(`${row('prod-album')} label:has([data-guest-visible])`)).includes('顯示給客人'));
      ok('…and reads 客人看不到', (await status(page, 'prod-album')) === '客人看不到', await status(page, 'prod-album'));
      ok('a switch that is off shows no warning line', (await page.$$(`${row('prod-album')} [data-warn="guest-shop-hidden"]`)).length === 0);

      // toggle on
      await page.click(gv('prod-album'));
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-album"] [data-guest-status]')?.textContent.trim() === '客人看得到', null, { timeout: 3000 });
      let puts = putsOf(o);
      ok('one PUT, to that product, with exactly {guest_visible:true}', puts.length === 1 && puts[0].path === '/api/admin/products/prod-album' && JSON.stringify(puts[0].body) === '{"guest_visible":true}', JSON.stringify(puts));
      ok('the row now reads 客人看得到, switch checked and enabled again', (await page.isChecked(gv('prod-album'))) && !(await page.isDisabled(gv('prod-album'))));
      ok('the fake Worker stored it (what a reload would show)', o.st.products.find(p => p.id === 'prod-album').guest_visible === 1);
      ok('a fully sellable product shows no warning', (await page.$$(`${row('prod-album')} [data-warn="guest-shop-hidden"]`)).length === 0);
      ok('the other rows were not touched', (await status(page, 'prod-print')) === '客人看不到');
      // toggle off
      await page.click(gv('prod-album'));
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-album"] [data-guest-status]')?.textContent.trim() === '客人看不到', null, { timeout: 3000 });
      puts = putsOf(o);
      ok('toggling back sends exactly {guest_visible:false}', puts.length === 2 && JSON.stringify(puts[1].body) === '{"guest_visible":false}', JSON.stringify(puts));
      ok('…and unchecks', (await page.isChecked(gv('prod-album'))) === false);
      ok('it used the admin token', puts.every(c => c.auth === 'Bearer adm'));

      // ON but unsellable
      ok('an ON product whose only option is under the platform price says so in one line',
        (await page.textContent(`${row('prod-low')} [data-warn="guest-shop-hidden"]`)).includes('已打開，但目前沒有客人買得到的規格'));
      ok('…its switch is checked and it reads 客人看得到', (await page.isChecked(gv('prod-low'))) && (await status(page, 'prod-low')) === '客人看得到');
      // turning the sellable one on never shows the warning, turning the unsellable one off removes it
      await page.click(gv('prod-low'));
      await page.waitForFunction(() => !document.querySelector('[data-product-id="prod-low"] [data-warn="guest-shop-hidden"]'), null, { timeout: 3000 });
      ok('switching the unsellable one off removes the warning', (await status(page, 'prod-low')) === '客人看不到');

      // retired + custom rows
      ok('a retired product has no switch', (await page.$$(gv('prod-retired'))).length === 0);
      ok('…but still shows its state', (await status(page, 'prod-retired')) === '客人看不到');
      ok('a custom service has no switch (the guest shop sells platform products only)', (await page.$$(gv('prod-custom'))).length === 0);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('設定 — 商品「顯示給客人」開關：失敗時還原並顯示錯誤；請求進行中開關鎖住，連點只送一個請求',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      // failure
      o.st.inject = (method, path) => method === 'PUT' ? { status: 400, body: { error: '儲存失敗啦', code: 'invalid_guest_visible_x' } } : null;
      await page.click(gv('prod-album'));
      await page.waitForFunction(() => document.getElementById('prod-err').textContent.includes('儲存失敗啦'), null, { timeout: 3000 });
      ok('a failed save shows the Worker\'s error text in #prod-err', (await page.textContent('#prod-err')).includes('儲存失敗啦'));
      ok('…and puts the switch back to unchecked, enabled', (await page.isChecked(gv('prod-album'))) === false && !(await page.isDisabled(gv('prod-album'))));
      ok('…the row still reads 客人看不到', (await status(page, 'prod-album')) === '客人看不到');
      ok('…and exactly one PUT was attempted', putsOf(o).length === 1);
      o.st.inject = null;

      // in flight + double click
      let release; o.st.hold = new Promise(r => { release = r; });
      await page.click(gv('prod-print'));
      await page.waitForFunction(sel => document.querySelector(sel)?.disabled === true, gv('prod-print'), { timeout: 3000 });
      ok('while the request is in flight the switch is disabled', await page.isDisabled(gv('prod-print')));
      await page.dispatchEvent(gv('prod-print'), 'click').catch(() => {});
      await page.dispatchEvent(gv('prod-print'), 'click').catch(() => {});
      ok('extra clicks while in flight send nothing more', putsOf(o).filter(c => c.path.endsWith('/prod-print')).length === 1, JSON.stringify(putsOf(o).map(c => c.path)));
      ok('a different row\'s switch stays usable', !(await page.isDisabled(gv('prod-album'))));
      release();
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-print"] [data-guest-status]')?.textContent.trim() === '客人看得到', null, { timeout: 3000 });
      ok('after the answer it is enabled, checked, and only one PUT was ever sent for it', !(await page.isDisabled(gv('prod-print'))) && (await page.isChecked(gv('prod-print'))) && putsOf(o).filter(c => c.path.endsWith('/prod-print')).length === 1);
      o.st.hold = null;

      // a real double click
      await page.dblclick(gv('prod-album'));
      await page.waitForTimeout(400);
      ok('a double click sends one request, not two', putsOf(o).filter(c => c.path.endsWith('/prod-album')).length === 2 /* the failed one + this one */, JSON.stringify(putsOf(o).map(c => c.path)));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const hostile = '<img src=x onerror="window.__gvx=1">"\'';
  const plat = platFx(); plat[1].name = hostile;
  const m = dashSettingsMock();
  const o = ordersFake({ platform: plat, products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('設定 — 商品「顯示給客人」開關：390px 手機上點擊區 ≥ 44px、不出現橫向捲動；惡意商品名稱只是文字',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const boxes = await page.$$eval('[data-guest-visible]', els => els.map(e => {
        const l = e.closest('label') || e; const r = l.getBoundingClientRect(); return { w: r.width, h: r.height };
      }));
      ok('both switches rendered (floor)', boxes.length === 2);
      ok('each switch\'s tap area (the label) is at least 44px tall and wide', boxes.every(b => b.h >= 44 && b.w >= 44), JSON.stringify(boxes));
      ok('no horizontal scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await page.evaluate(() => `${document.documentElement.scrollWidth} > ${window.innerWidth}`));
      ok('every switch stays inside the viewport', await page.$$eval('[data-guest-visible]', els => els.every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })));
      ok('a hostile name stays text: no img injected, no handler ran', (await page.$$('.prod-row img[src="x"]')).length === 0 && (await page.evaluate(() => window.__gvx)) === undefined);
      ok('…and is shown verbatim', (await page.textContent(`${row('prod-print')} .prod-name`)) === hostile);
      await page.tap(gv('prod-print'));
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-print"] [data-guest-status]')?.textContent.trim() === '客人看得到', null, { timeout: 3000 });
      ok('tapping works on the phone: checked, one PUT with exactly {guest_visible:true}', (await page.isChecked(gv('prod-print'))) && putsOf(o).length === 1 && JSON.stringify(putsOf(o)[0].body) === '{"guest_visible":true}', JSON.stringify(putsOf(o)));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN, contextOptions: MOBILE });
}
}
