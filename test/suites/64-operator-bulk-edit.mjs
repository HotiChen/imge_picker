// Browser suites: operator page 批次編輯 — the catalogue as one editable table
// (name, page bounds, extra-page price, bleed, option label / cost / price), one
// save for everything changed. Registered by test/run.mjs; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

const fx = () => {
  const a = { ...clone(PLAT_ALBUM), min_pages: 10, max_pages: 40, extra_page_price: 100, bleed_mm: 3 };
  const p = { ...clone(PLAT_PRINT), bleed_mm: null };
  const gone = { ...clone(PLAT_PRINT), id: 'plat-gone', name: '舊商品', active: 0, options: [{ id: 'popt-gone', label: '', vendor_cost: 1, platform_price: 2, active: 1, sort: 0 }] };
  return [a, p, gone];
};
const puts = o => o.st.calls.filter(c => c.method === 'PUT' && /^\/api\/operator\/products\/[^/]+$/.test(c.path));
const prod = id => `#op-bulk .bk-prod[data-product-id="${id}"]`;
const opt = id => `#op-bulk .bk-opt[data-option-id="${id}"]`;
const open = async page => { await page.waitForSelector('#op-list .prod-row', { timeout: 5000 }); await page.click('#op-bulk-btn'); await page.waitForSelector('#op-bulk .bk-prod', { timeout: 3000 }); };
const mk = (out) => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 表格只列上架商品與上架規格；沒改東西時不能存',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      await open(page);
      ok('one header row per active product (2), the retired one is not there', (await page.$$('#op-bulk .bk-prod')).length === 2 && (await page.$(prod('plat-gone'))) === null);
      ok('only active options: 2 for the album + 1 for the print = 3 rows; the retired 舊規格 is not shown', (await page.$$('#op-bulk .bk-opt')).length === 3 && (await page.$(opt('popt-album-old'))) === null);
      ok('cells carry the stored values', (await page.inputValue(`${prod('plat-album')} .bk-name`)) === '相本書' && (await page.inputValue(`${opt('popt-album-s')} .bk-plat`)) === '1500' && (await page.inputValue(`${opt('popt-album-s')} .bk-vendor`)) === '1400' && (await page.inputValue(`${prod('plat-album')} .bk-bleed`)) === '3' && (await page.inputValue(`${prod('plat-album')} .bk-min`)) === '10' && (await page.inputValue(`${prod('plat-album')} .bk-extra`)) === '100');
      ok('a print has no page-bound cells, an album does', (await page.$(`${prod('plat-print')} .bk-min`)) === null && (await page.$(`${prod('plat-album')} .bk-max`)) !== null);
      ok('the save button is disabled with nothing changed', await page.$eval('#bk-save', b => b.disabled));
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1600');
      ok('after one edit it is enabled and counts 1', !(await page.$eval('#bk-save', b => b.disabled)) && (await page.textContent('#bk-save')).includes('1'));
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1500');
      ok('typing the old value back makes it clean again (disabled)', await page.$eval('#bk-save', b => b.disabled));
      ok('no PUT was made by any of this', puts(o).length === 0);
      return out;
    }, { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 只送有改的商品、只送有改的欄位；規格一改就連同所有上架規格（帶 id）一起送',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      await open(page);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1650');
      await page.fill(`${prod('plat-print')} .bk-bleed`, '3.5');
      ok('two products dirty → the button says 2', (await page.textContent('#bk-save')).includes('2'));
      await page.click('#bk-save');
      await waitText(page, '#op-ok', t => t.includes('已儲存'));
      const ps = puts(o);
      ok('exactly two PUTs, one per changed product', ps.length === 2 && ps.map(c => c.path).sort().join() === '/api/operator/products/plat-album,/api/operator/products/plat-print', JSON.stringify(ps.map(c => c.path)));
      const a = ps.find(c => c.path.endsWith('plat-album')).body, p = ps.find(c => c.path.endsWith('plat-print')).body;
      ok('the album body is only {options}: name, bounds and bleed untouched are not sent', Object.keys(a).join() === 'options', JSON.stringify(a));
      ok('…and carries every active option with its id (retired one omitted), edited price in place',
        a.options.length === 2 && a.options.find(x => x.id === 'popt-album-s').platform_price === 1650 && a.options.find(x => x.id === 'popt-album-s').vendor_cost === 1400 && a.options.find(x => x.id === 'popt-album-l').platform_price === 2400, JSON.stringify(a));
      ok('the print body is only {bleed_mm: 3.5} (no options)', Object.keys(p).join() === 'bleed_mm' && p.bleed_mm === 3.5, JSON.stringify(p));
      const al = o.st.platform.find(x => x.id === 'plat-album');
      ok('the stored catalogue changed: price 1650, bounds still 10–40, 舊規格 still retired', al.options.find(x => x.id === 'popt-album-s').platform_price === 1650 && al.min_pages === 10 && al.options.find(x => x.id === 'popt-album-old').active === 0);
      ok('the table is clean again after saving', await page.$eval('#bk-save', b => b.disabled));
      ok('the normal list behind it shows the new price', (await page.textContent('#op-list')).includes('1,650') || (await page.textContent('#op-list')).includes('1650'));

      // clearing a blank-able field sends null
      await page.fill(`${prod('plat-album')} .bk-extra`, '');
      await page.fill(`${prod('plat-album')} .bk-name`, '相本書 2026');
      await page.click('#bk-save');
      await waitText(page, '#op-ok', t => t.includes('已儲存'));
      const b = puts(o).at(-1).body;
      ok('a cleared extra price is sent as null with the new name, nothing else', b.extra_page_price === null && b.name === '相本書 2026' && Object.keys(b).sort().join() === 'extra_page_price,name', JSON.stringify(b));
      return out;
    }, { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 有一格不合法就一個都不送；標出那一格',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      await open(page);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1700');            // fine
      await page.fill(`${prod('plat-print')} .bk-bleed`, '11');             // out of 0–10
      await page.click('#bk-save');
      await page.waitForSelector(`${prod('plat-print')} .bk-bleed[aria-invalid="true"]`, { timeout: 3000 });
      ok('the bad bleed cell is marked invalid', true);
      ok('and NOTHING was sent, not even the good edit', puts(o).length === 0, JSON.stringify(puts(o)));
      ok('an error line says what is wrong', (await page.textContent('#bk-err')).trim().length > 0);
      for (const [sel, v, label] of [[`${opt('popt-album-l')} .bk-plat`, '12.5', 'a non-whole price'], [`${opt('popt-album-l')} .bk-vendor`, '', 'a blank cost'], [`${prod('plat-album')} .bk-min`, '0', 'min pages 0'], [`${prod('plat-album')} .bk-name`, '   ', 'a blank name']]) {
        await page.fill(`${prod('plat-print')} .bk-bleed`, '');
        await page.fill(sel, v);
        await page.click('#bk-save');
        await page.waitForSelector(`${sel}[aria-invalid="true"]`, { timeout: 3000 });
        ok(`${label}: marked invalid, still nothing sent`, puts(o).length === 0);
        await page.reload(); await open(page); await page.fill(`${opt('popt-album-s')} .bk-plat`, '1700');
      }
      await page.fill(`${prod('plat-album')} .bk-min`, '50');                // min 50 > max 40
      await page.click('#bk-save');
      await page.waitForSelector(`${prod('plat-album')} .bk-max[aria-invalid="true"]`, { timeout: 3000 });
      ok('min above max: the max cell is the one marked, nothing sent', puts(o).length === 0);
      await page.reload(); await open(page);
      await page.fill(`${prod('plat-album')} .bk-max`, '5');                 // only max edited, below the stored min 10
      await page.click('#bk-save');
      await page.waitForSelector(`${prod('plat-album')} .bk-max[aria-invalid="true"]`, { timeout: 3000 });
      ok('max edited alone below the min: also refused, nothing sent', puts(o).length === 0);
      return out;
    }, { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 伺服器拒絕一個：停在那裡、說是哪個商品、已存的不再送、沒存的仍標為已改',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      o.st.inject = (m, p) => (m === 'PUT' && p.endsWith('plat-print')) ? { status: 400, body: { error: '出血不合', code: 'invalid_bleed_mm' } } : null;
      await open(page);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1700');
      await page.fill(`${prod('plat-print')} .bk-bleed`, '3');
      await page.click('#bk-save');
      await waitText(page, '#bk-err', t => t.includes('無框畫'));
      ok('the error names the refused product', (await page.textContent('#bk-err')).includes('無框畫'));
      ok('the album (first in order) was saved', o.st.platform.find(x => x.id === 'plat-album').options.find(x => x.id === 'popt-album-s').platform_price === 1700);
      ok('the print was not changed', o.st.platform.find(x => x.id === 'plat-print').bleed_mm == null);
      ok('the save button now counts only the 1 still-unsaved product', !(await page.$eval('#bk-save', b => b.disabled)) && (await page.textContent('#bk-save')).includes('1'));
      const before = puts(o).length;
      o.st.inject = null;
      await page.click('#bk-save');
      await waitText(page, '#op-ok', t => t.includes('已儲存'));
      ok('retrying sends only the print — the album is not sent again', puts(o).length === before + 1 && puts(o).at(-1).path.endsWith('plat-print'), JSON.stringify(puts(o).map(c => c.path)));
      ok('and the print is stored now', o.st.platform.find(x => x.id === 'plat-print').bleed_mm === 3);
      return out;
    }, { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 價格低於成本即時出現警示；沒存的修改離開前要確認',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      const dialogs = []; let answer = false;
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await open(page);
      ok('no below-cost chip to begin with', (await page.$(`${opt('popt-album-s')} [data-warn="below-cost"]`)) === null);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1000');
      ok('price under cost (1400) shows the chip at once (positive)', (await page.$(`${opt('popt-album-s')} [data-warn="below-cost"]`)) !== null);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1400');
      ok('equal to cost: chip gone', (await page.$(`${opt('popt-album-s')} [data-warn="below-cost"]`)) === null);
      await page.fill(`${opt('popt-album-s')} .bk-plat`, '1450');
      await page.click('#bk-cancel');
      ok('closing with unsaved edits asked first', dialogs.length === 1);
      ok('declining keeps the table open with the edit', (await page.$('#op-bulk .bk-prod')) !== null && (await page.inputValue(`${opt('popt-album-s')} .bk-plat`)) === '1450');
      answer = true;
      await page.click('#bk-cancel');
      ok('accepting closes the table', (await page.$('#op-bulk .bk-prod')) === null && dialogs.length === 2);
      ok('and nothing was ever sent', puts(o).length === 0);
      await open(page);
      ok('reopened, the discarded edit is gone', (await page.inputValue(`${opt('popt-album-s')} .bk-plat`)) === '1500');
      await page.click('#bk-cancel');
      ok('closing a clean table does not ask', dialogs.length === 2 && (await page.$('#op-bulk .bk-prod')) === null);
      return out;
    }, { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: fx(), products: [] });
  await suite('operator 批次編輯 — 手機：格子至少 44px 高、整頁沒有橫向捲動（表格自己捲）',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = mk(out);
      await open(page);
      const hs = await page.$$eval('#op-bulk input, #op-bulk button', els => els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height));
      ok('at least 10 controls measured (an empty scan must not pass)', hs.length >= 10, String(hs.length));
      ok('every input/button is ≥ 44px tall', hs.every(h => h >= 43.5), JSON.stringify(hs.filter(h => h < 43.5)));
      ok('the page itself does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      return out;
    }, { before: o.attach, initScript: OP_SEED, contextOptions: MOBILE });
}

}
