// Browser suites: 「轉出精挑相片 XMP」 in admin.html's project detail (js/xmp-export.js, docs/xmp-export.md).
// The dialog next to 下載需求表 (CSV): three Lightroom settings, a live count, collision / zero-pick messages, the
// zip (.xmp files + README.txt) built in the browser with the same cdnjs JSZip as the guest downloads.
// The cdnjs JSZip is out of reach here, so the request is answered with the real library from the Playwright
// tools (same 3.10.1); the zip the photographer would get is read back with the same library in node.
// Settings are remembered in localStorage (xmp_export_settings_v1) and the dialog works without storage.
// Nothing is written to the Worker (asserted). Node tests of the pure part: test/unit/xmp-export.test.mjs.
// Chromium only; real Lightroom has NOT been tried.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

const require = createRequire(import.meta.url);
const JSZipNode = require('jszip');
const JSZIP_SRC = readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8');
const BOM = String.fromCharCode(0xFEFF);

export default async function register() {
const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const sel = (rating, note = '', marks = null) => ({ rating, note, marks, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
const PINS = [{ x: 0.1, y: 0.2, note: '去痘痘' }, { x: 0.5, y: 0.5, note: '' }];
const withZip = m => async page => {
  await m.attach(page);
  await page.route('**/cdnjs.cloudflare.com/ajax/libs/jszip/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: JSZIP_SRC }));
};
const TITLE = '海邊/婚禮:精選*';
function fixture(extra = {}) {
  const m = pickFakeWorker({ ownerName: 'Rex', title: extra.title ?? TITLE });
  const picks = extra.picks || {
    '20260819/IMG_001.CR3': sel(5, '請修膚色 SECRET', PINS),
    '20260819/IMG_002.CR3': sel(3),
    '20260819/IMG_003.CR3': sel(0, '沒選', PINS),
  };
  for (const [k, v] of Object.entries(picks)) m.state.selections.set(k, v);
  return m;
}
const openDetail = async page => {
  // desktop: the 開啟 button; phone: the whole row is the target (the button is hidden); after a reload the hash may already show the detail
  await page.waitForSelector('[data-open-project], #pd-xmp-btn', { state: 'attached', timeout: 5000 });
  if (!(await page.$('#pd-xmp-btn'))) {
    if (await page.$eval('[data-open-project]', b => b.offsetParent !== null)) await page.click('[data-open-project]');
    else await page.click('[data-project-row]');
  }
  await page.waitForSelector('#pd-xmp-btn', { timeout: 5000 });
};
const openDialog = async page => { await page.click('#pd-xmp-btn'); await page.waitForSelector('#pd-xmp-dialog [role="dialog"], #pd-xmp-dialog [aria-modal="true"]', { timeout: 3000 }); };
const countText = page => page.textContent('#xmp-count');
const dlNames = () => {
  window.__dlNames = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlNames.push(this.download); return click.call(this); };
};
const lastName = page => page.evaluate(() => window.__dlNames[window.__dlNames.length - 1] ?? null);
const readZip = async dl => { const z = await JSZipNode.loadAsync(readFileSync(await dl.path())); const o = {}; for (const n of Object.keys(z.files)) o[n] = await z.files[n].async('string'); return o; };
const attrs = t => { const m = t.match(/<rdf:Description ([^>]*?)\/>/); return m ? [...m[1].matchAll(/\s((?:xmp|xmpDM):\w+)="([^"]*)"/g)].map(a => `${a[1]}=${a[2]}`) : null; };
const nonGet = m => m.requests.filter(r => r.method !== 'GET' && r.method !== 'OPTIONS');
const setSel = async (page, id, v) => { await page.selectOption(`#${id}`, v); };

{
  const m = fixture();
  await suite('xmp export — the button sits with the CSV one, the dialog opens with the defaults and a live count', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    ok('the button says 轉出精挑相片 XMP', (await page.textContent('#pd-xmp-btn')).trim() === '轉出精挑相片 XMP');
    ok('it is in the same row as the CSV button', await page.evaluate(() => document.getElementById('pd-xmp-btn').parentElement === document.getElementById('pd-download-csv-btn').parentElement));
    ok('no dialog before the click', (await page.$('#pd-xmp-dialog')) === null);
    await openDialog(page);
    ok('the dialog is a modal dialog with a title', await page.$eval('#pd-xmp-dialog [role="dialog"]', d => d.getAttribute('aria-modal') === 'true' && document.getElementById(d.getAttribute('aria-labelledby')).textContent.includes('XMP')));
    const v = await page.evaluate(() => ['xmp-rating', 'xmp-label', 'xmp-label-pins', 'xmp-flag'].map(id => document.getElementById(id).value));
    ok('defaults: rating follows the client, Green, pins Red, flag off', JSON.stringify(v) === '["follow","Green","Red","off"]', JSON.stringify(v));
    ok('the live count: 2 picked, 1 with pins (the 0-star photo is not counted)', (await countText(page)) === '將轉出 2 個 XMP（其中 1 張有修改標示）', await countText(page));
    ok('the Lightroom caveat is on screen: overwrite warning, menu, pick flag unverified',
      await page.$eval('.xmp-caveat', e => /不要解壓縮到已經有 \.xmp/.test(e.textContent) && /從檔案讀取中繼資料/.test(e.textContent) && /Pick.*還沒用真正的 Lightroom 驗證/.test(e.textContent)));
    ok('the download button is enabled', await page.$eval('#xmp-download', b => !b.disabled && b.textContent === '下載 zip'));
    await setSel(page, 'xmp-rating', 'off'); await setSel(page, 'xmp-label', 'off'); await setSel(page, 'xmp-flag', 'off');
    ok('everything off: the count says nothing to export and download is disabled', /沒有東西可以轉出/.test(await countText(page)) && await page.$eval('#xmp-download', b => b.disabled));
    ok('label off disables the pin colour select', await page.$eval('#xmp-label-pins', s => s.disabled));
    await setSel(page, 'xmp-flag', 'pick');
    ok('turning only the flag on brings the count back', (await countText(page)) === '將轉出 2 個 XMP（其中 1 張有修改標示）' && await page.$eval('#xmp-download', b => !b.disabled), await countText(page));
    ok('opening the dialog and changing settings wrote nothing to the Worker', nonGet(m).length === 0, JSON.stringify(nonGet(m)));
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture();
  await suite('xmp export — the zip: <title>-xmp.zip with one .xmp per picked photo + README.txt, contents follow the settings', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await page.evaluate(dlNames);
    await openDialog(page);
    let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    ok('the file is named <sanitised title>-xmp.zip', (await lastName(page)) === '海邊_婚禮_精選_-xmp.zip', await lastName(page));
    let z = await readZip(dl);
    ok('exactly IMG_001.xmp, IMG_002.xmp and README.txt (not the unpicked IMG_003)', JSON.stringify(Object.keys(z).sort()) === '["IMG_001.xmp","IMG_002.xmp","README.txt"]', JSON.stringify(Object.keys(z)));
    ok('defaults: 5 stars + Red (pins) for the pinned one', JSON.stringify(attrs(z['IMG_001.xmp'])) === '["xmp:Rating=5","xmp:Label=Red"]', JSON.stringify(attrs(z['IMG_001.xmp'])));
    ok('defaults: 3 stars + Green for the plain one', JSON.stringify(attrs(z['IMG_002.xmp'])) === '["xmp:Rating=3","xmp:Label=Green"]', JSON.stringify(attrs(z['IMG_002.xmp'])));
    ok('the packet starts with the BOM inside begin="" and ends with the end packet', z['IMG_001.xmp'].startsWith(`<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>`) && z['IMG_001.xmp'].trimEnd().endsWith('<?xpacket end="w"?>'));
    ok('no guest text anywhere in the zip', !Object.values(z).some(t => /SECRET|請修膚色|去痘痘/.test(t)));
    ok('the README warns about overwriting and names the Lightroom menu', /不要解壓縮到已經有 \.xmp 的資料夾/.test(z['README.txt']) && /從檔案讀取中繼資料/.test(z['README.txt']) && /尚未用真正的 Lightroom 驗證/.test(z['README.txt']));

    await setSel(page, 'xmp-rating', '2'); await setSel(page, 'xmp-label', 'Blue'); await setSel(page, 'xmp-label-pins', 'same'); await setSel(page, 'xmp-flag', 'pick');
    [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    z = await readZip(dl);
    ok('fixed 2 stars, Blue for both, flag Pick', ['IMG_001.xmp', 'IMG_002.xmp'].every(n => JSON.stringify(attrs(z[n])) === '["xmp:Rating=2","xmp:Label=Blue","xmpDM:pick=1"]'), JSON.stringify(attrs(z['IMG_001.xmp'])));
    await setSel(page, 'xmp-rating', 'off'); await setSel(page, 'xmp-label', 'off');
    [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    z = await readZip(dl);
    ok('only the flag on: just xmpDM:pick', JSON.stringify(attrs(z['IMG_002.xmp'])) === '["xmpDM:pick=1"]', JSON.stringify(attrs(z['IMG_002.xmp'])));
    ok('nothing was written to the Worker', nonGet(m).length === 0, JSON.stringify(nonGet(m)));
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture();
  await suite('xmp export — settings are remembered in localStorage (xmp_export_settings_v1), also after a reload; junk storage falls back to the defaults', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await openDialog(page);
    await setSel(page, 'xmp-rating', '4'); await setSel(page, 'xmp-label', 'Purple'); await setSel(page, 'xmp-label-pins', 'Yellow'); await setSel(page, 'xmp-flag', 'pick');
    const stored = await page.evaluate(() => localStorage.getItem('xmp_export_settings_v1'));
    ok('stored under xmp_export_settings_v1', JSON.stringify(JSON.parse(stored)) === '{"rating":4,"label":"Purple","labelPins":"Yellow","flag":"pick"}', stored);
    await page.click('#xmp-close');
    await openDialog(page);
    const v = await page.evaluate(() => ['xmp-rating', 'xmp-label', 'xmp-label-pins', 'xmp-flag'].map(id => document.getElementById(id).value));
    ok('reopened: the same values', JSON.stringify(v) === '["4","Purple","Yellow","pick"]', JSON.stringify(v));
    await page.reload();
    await openDetail(page);
    await openDialog(page);
    const v2 = await page.evaluate(() => ['xmp-rating', 'xmp-label', 'xmp-label-pins', 'xmp-flag'].map(id => document.getElementById(id).value));
    ok('after a reload: still the same', JSON.stringify(v2) === '["4","Purple","Yellow","pick"]', JSON.stringify(v2));
    await page.click('#xmp-close');
    await page.evaluate(() => localStorage.setItem('xmp_export_settings_v1', '{not json'));
    await openDialog(page);
    const v3 = await page.evaluate(() => ['xmp-rating', 'xmp-label', 'xmp-label-pins', 'xmp-flag'].map(id => document.getElementById(id).value));
    ok('junk in storage: the defaults', JSON.stringify(v3) === '["follow","Green","Red","off"]', JSON.stringify(v3));
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture();
  await suite('xmp export — with localStorage throwing the dialog still opens on the defaults, changes work and the zip downloads', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await page.evaluate(dlNames);
    ok('storage really throws for this feature\'s key', await page.evaluate(() => { try { localStorage.getItem('xmp_export_settings_v1'); return false; } catch (e) { return true; } }));
    await openDialog(page);
    const v = await page.evaluate(() => ['xmp-rating', 'xmp-label', 'xmp-label-pins', 'xmp-flag'].map(id => document.getElementById(id).value));
    ok('defaults shown', JSON.stringify(v) === '["follow","Green","Red","off"]', JSON.stringify(v));
    await setSel(page, 'xmp-flag', 'pick');
    ok('a change still updates the count and keeps the download enabled', (await countText(page)).startsWith('將轉出 2 個 XMP') && await page.$eval('#xmp-download', b => !b.disabled));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    const z = await readZip(dl);
    ok('the zip has the flag', JSON.stringify(attrs(z['IMG_002.xmp'])) === '["xmp:Rating=3","xmp:Label=Green","xmpDM:pick=1"]', JSON.stringify(attrs(z['IMG_002.xmp'])));
    return out;
  }, { before: withZip(m), initScript: () => {
    sessionStorage.setItem('studio_token', 'adm');
    // the rest of admin.html does not survive a storage that throws on every key (not this feature's concern), so the
    // throwing is scoped to this feature's own key: its read, write and remove all throw
    const real = { g: Storage.prototype.getItem, s: Storage.prototype.setItem, r: Storage.prototype.removeItem };
    const boom = () => { throw new Error('SecurityError: storage denied'); };
    const guard = (orig) => function (k, ...a) { if (String(k).startsWith('xmp_')) boom(); return orig.call(this, k, ...a); };
    Storage.prototype.getItem = guard(real.g); Storage.prototype.setItem = guard(real.s); Storage.prototype.removeItem = guard(real.r);
  } });
}

{
  const m = fixture({ picks: {
    '20260819/IMG_001.CR3': sel(4), '20260901/IMG_001.CR3': sel(5, '', PINS), '20260901/img_001.jpg': sel(2), '20260901/IMG_009.CR3': sel(1),
  } });
  await suite('xmp export — two picked photos with the same file name: the first is kept, the dialog names the rest, the zip does not overwrite', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await openDialog(page);
    ok('the count only counts the files that will be written', (await countText(page)) === '將轉出 2 個 XMP（其中 0 張有修改標示）', await countText(page));
    const w = await page.textContent('#xmp-warn');
    ok('the warning says 2 are left out and names them', /有 2 張和別張照片檔名相同/.test(w) && w.includes('20260901/IMG_001.CR3') && w.includes('20260901/img_001.jpg'), w);
    ok('it does not name the kept one or the unique one', !w.includes('20260819/IMG_001.CR3') && !w.includes('IMG_009'), w);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    const z = await readZip(dl);
    ok('the zip holds IMG_001.xmp (from the first, 4 stars), IMG_009.xmp, README', JSON.stringify(Object.keys(z).sort()) === '["IMG_001.xmp","IMG_009.xmp","README.txt"]' && attrs(z['IMG_001.xmp'])[0] === 'xmp:Rating=4', JSON.stringify(Object.keys(z)));
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture({ picks: { '20260819/IMG_003.CR3': sel(0, '', PINS) } });
  await suite('xmp export — nothing picked: the dialog explains and offers no empty zip', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    ok('the button is still there', await page.$eval('#pd-xmp-btn', b => b.offsetParent !== null));
    await openDialog(page);
    ok('it says the client has picked nothing', /還沒有挑任何照片/.test(await countText(page)), await countText(page));
    ok('the download button is disabled', await page.$eval('#xmp-download', b => b.disabled));
    let downloaded = false; page.on('download', () => { downloaded = true; });
    await page.click('#xmp-download', { force: true, timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
    ok('no download happened', !downloaded);
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture();
  await suite('xmp export — Esc and 關閉 and a click outside close it; focus returns to the button; a second open leaves one dialog', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await openDialog(page);
    ok('focus moved into the dialog', await page.evaluate(() => !!document.activeElement.closest('#pd-xmp-dialog')));
    await page.keyboard.press('Escape');
    ok('Esc closed it', (await page.$('#pd-xmp-dialog')) === null);
    ok('focus is back on the opener', await page.evaluate(() => document.activeElement.id === 'pd-xmp-btn'));
    await openDialog(page);
    await page.click('#xmp-close');
    ok('關閉 closed it and focus is back', (await page.$('#pd-xmp-dialog')) === null && await page.evaluate(() => document.activeElement.id === 'pd-xmp-btn'));
    await openDialog(page);
    await page.mouse.click(5, 5);
    ok('a click on the backdrop closed it', (await page.$('#pd-xmp-dialog')) === null);
    await page.evaluate(() => document.getElementById('pd-xmp-btn').click());
    await page.evaluate(() => document.getElementById('pd-xmp-btn').click());
    ok('opening twice leaves exactly one dialog', (await page.$$('#pd-xmp-dialog')).length === 1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    ok('and one Esc is enough (no stray listener)', (await page.$('#pd-xmp-dialog')) === null);
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture({ picks: {
    '20260819/x" onerror="window.__pwn=1"<img src=x>.CR3': sel(5, '<b>n</b>', [{ x: 0, y: 0, note: '<img src=x onerror=window.__pwn=2>' }]),
    '20260819/IMG_2.CR3': sel(1),
  } });
  await suite('xmp export — hostile file names and notes never become markup; the zip file name is clean', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await page.evaluate(dlNames);
    await openDialog(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xmp-download')]);
    const z = await readZip(dl);
    const names = Object.keys(z).sort();
    ok('names carry no quotes, brackets or slashes', names.length === 3 && names.every(n => !/["<>\\/|?*:]/.test(n)), JSON.stringify(names));
    ok('every .xmp is a well-formed packet with only xmp attributes', names.filter(n => n.endsWith('.xmp')).every(n => /^<\?xpacket begin="/.test(z[n]) && !/onerror|<img|<b>/.test(z[n])));
    ok('no script ran', await page.evaluate(() => window.__pwn === undefined));
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}

{
  const m = fixture({ picks: {
    '20260819/IMG_001.CR3': sel(5, '', PINS), '20260819/IMG_002.CR3': sel(3), '20260901/IMG_001.CR3': sel(2),
  } });
  await suite('xmp export — 390px phone: the dialog fits, every control is at least 44px, nothing scrolls sideways', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await openDialog(page);
    const r = await page.evaluate(() => {
      const box = document.querySelector('#pd-xmp-dialog .picker-box').getBoundingClientRect();
      const ctl = [...document.querySelectorAll('#pd-xmp-dialog select, #pd-xmp-dialog button')].filter(e => e.offsetParent !== null);
      return {
        n: ctl.length, small: ctl.filter(e => e.getBoundingClientRect().height < 43.5).map(e => `${e.id}:${Math.round(e.getBoundingClientRect().height)}`),
        selects: ctl.filter(e => e.tagName === 'SELECT').length, buttons: ctl.filter(e => e.tagName === 'BUTTON').length,
        left: box.left, right: box.right, vw: innerWidth, sw: document.documentElement.scrollWidth,
        fonts: ctl.filter(e => e.tagName === 'SELECT' && parseFloat(getComputedStyle(e).fontSize) < 16).length,
      };
    });
    ok('scanned 4 selects and 2 buttons (a floor, so an empty scan cannot pass)', r.selects === 4 && r.buttons === 2 && r.n === 6, JSON.stringify(r));
    ok('every control is >= 44px tall', r.small.length === 0, JSON.stringify(r.small));
    ok('selects use 16px text (iOS does not zoom)', r.fonts === 0);
    ok('the box sits inside the 390px viewport', r.left >= 0 && r.right <= r.vw, JSON.stringify(r));
    ok('no horizontal page scroll', r.sw <= r.vw, JSON.stringify(r));
    ok('the download button can be reached (scrolls into view inside the box)', await page.$eval('#xmp-download', b => { b.scrollIntoView(); const q = b.getBoundingClientRect(); return q.top >= 0 && q.bottom <= innerHeight; }));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#xmp-download')]);
    ok('and a tap downloads the zip', Object.keys(await readZip(dl)).includes('README.txt'));
    return out;
  }, { before: withZip(m), initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = fixture();
  await suite('xmp export — the existing 下載需求表 (CSV) button still downloads the CSV, and the XMP button did not change it', `${base}/admin.html`, async page => {
    const { out, ok } = line();
    await openDetail(page);
    await page.evaluate(dlNames);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pd-download-csv-btn')]);
    const buf = readFileSync(await dl.path());
    ok('CSV named <title>-selected.csv with a BOM and the two picked rows', (await lastName(page)) === '海邊_婚禮_精選_-selected.csv' && buf[0] === 0xEF && buf.toString('utf8').includes('IMG_001.CR3') && !buf.toString('utf8').includes('IMG_003'), await lastName(page));
    ok('no dialog was opened by it', (await page.$('#pd-xmp-dialog')) === null);
    return out;
  }, { before: withZip(m), initScript: ADMIN });
}
}
