// Browser suite: the photographer's review view (index.html?project=<id>) gets a third tab, 精修: the files
// under the project's chosen finals folders (final_folders), listed with the studio credential, read-only
// apart from the delete button (which every other review-view tab keeps off).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const ADMIN_SRC = `(${ADMIN.toString()})();`;
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const PROOFS = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg'];
const FINALS = ['shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg'];
const ids = page => page.evaluate(() => [...document.querySelectorAll('.photo-card')].map(c => c.dataset.photoId));

const world = (extra = {}) => {
  const m = pickFakeWorker({ projectId: 'proj-f', ownerName: 'Grace', folders: ['shoot/毛片/'],
    pickFiles: [...PROOFS, ...FINALS], ...extra });
  const dels = [];
  const files = new Set([...PROOFS, ...FINALS]);
  const attach = async page => {
    await m.attach(page);
    // registered after the fake's own handler, so it answers the delete routes first
    await page.route(u => /\/api\/admin\/photo(\/lock)?$/.test(new URL(u).pathname), async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const key = u.searchParams.get('key');
      const send = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', headers: cors, body: JSON.stringify(b) });
      if (u.pathname.endsWith('/lock')) return send({ key, deletable: true, code: null, error: null });
      dels.push({ key, auth: h['authorization'] });
      files.delete(key);
      return send({ ok: true, key, deleted: [key] });
    });
  };
  return { m, attach, dels, files };
};

{
  const w = world({ finalFolders: ['shoot/精修/'] });
  await suite('84 精修分頁 — 三個分頁，點 精修 列出精修資料夾（含子資料夾），沒有毛片，網址 ?mode=finals，只讀取不寫入',
    `${base}/index.html?project=proj-f`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pvModeToggle [data-pv-mode]', { timeout: 5000 });
      const t = await page.$$eval('#pvModeToggle [data-pv-mode]', bs => bs.map(b => [b.dataset.pvMode, b.textContent]));
      ok('toggle: 客人選的 / 全部毛片 / 精修', JSON.stringify(t) === JSON.stringify([['picks', '客人選的'], ['all', '全部毛片'], ['finals', '精修']]), JSON.stringify(t));
      await page.click('[data-pv-mode="finals"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 3, null, { timeout: 5000 });
      const got = (await ids(page)).sort();
      ok('floor: exactly the 3 finals (the subfolder one too), no proof', JSON.stringify(got) === JSON.stringify([...FINALS].sort()), JSON.stringify(got));
      const banner = await page.$eval('#pvBannerText', e => e.textContent);
      ok('banner says 精修 · 3 張', /精修/.test(banner) && /3 張/.test(banner), banner);
      ok('address carries ?mode=finals', await page.evaluate(() => new URL(location.href).searchParams.get('mode') === 'finals'));
      ok('精修 is pressed, the others not', await page.$$eval('#pvModeToggle [data-pv-mode]', bs => bs.map(b => b.getAttribute('aria-pressed')).join()) === 'false,false,true');
      const lists = w.m.requests.filter(r => r.search.includes('list='));
      ok('every listing was of the finals folder and carried the studio token', lists.length >= 2 && lists.every(r => /%E7%B2%BE%E4%BF%AE|精修/.test(decodeURIComponent(r.search)) && r.auth === 'Bearer adm'), JSON.stringify(lists.map(r => [r.search, r.auth])));
      const writes = w.m.requests.filter(r => r.method !== 'GET' && r.path !== '/api/auth/studio-token');
      ok('nothing was written', writes.length === 0, JSON.stringify(writes.map(r => r.method + r.path)));
      await page.click('[data-pv-mode="picks"]');
      await page.waitForFunction(() => !document.querySelector('.photo-card[data-photo-id*="精修"]'), null, { timeout: 5000 });
      ok('back on 客人選的 the finals are gone from the grid', !(await ids(page)).some(i => i.includes('精修')));
      return out;
    },
    { before: w.attach, initScript: ADMIN_SRC });
}

{
  const w = world({ finalFolders: ['shoot/精修/'] });
  await suite('84 精修分頁 — ?mode=finals 直接進精修；預覽有刪除鈕，確認後送 DELETE 並從格子消失（毛片分頁仍沒有刪除鈕）',
    `${base}/index.html?project=proj-f&mode=finals`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 3, null, { timeout: 5000 });
      page.on('dialog', d => d.accept());
      await page.evaluate(() => app.openModal(0));
      await page.waitForSelector('#photoModal.active', { timeout: 3000 });
      ok('the delete button is in the preview', await page.evaluate(() => !!document.getElementById('modalDeleteBtn')));
      await page.click('#modalDeleteBtn');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 5000 });
      ok('one DELETE, for that exact key, with the studio token', w.dels.length === 1 && w.dels[0].key === 'shoot/精修/f1.jpg' && w.dels[0].auth === 'Bearer adm', JSON.stringify(w.dels));
      const bannerAfter = await page.$eval('#pvBannerText', e => e.textContent);
      ok('the banner count followed (精修 · 2 張)', /精修/.test(bannerAfter) && /2 張/.test(bannerAfter), bannerAfter);
      ok('and the tab list the zip is built from dropped it too', await page.evaluate(() => ProjectViewController.currentPhotos().length === 2));
      ok('the grid shrank to the other two finals', JSON.stringify((await ids(page)).sort()) === JSON.stringify(['shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg']));
      await page.keyboard.press('Escape');
      await page.click('[data-pv-mode="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length >= 2, null, { timeout: 5000 });
      await page.evaluate(() => app.openModal(0));
      await page.waitForSelector('#photoModal.active', { timeout: 3000 });
      ok('on 全部毛片 the preview has no delete button', await page.evaluate(() => !document.getElementById('modalDeleteBtn') && app._canDeletePhotos() === false));
      return out;
    },
    { before: w.attach, initScript: ADMIN_SRC });
}

{
  const w = world();
  await suite('84 精修分頁 — 專案還沒選精修資料夾：不列任何東西，說明要到專案頁選資料夾',
    `${base}/index.html?project=proj-f&mode=finals`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForFunction(() => /還沒選精修資料夾/.test(document.querySelector('#emptyState h2')?.textContent || ''), null, { timeout: 5000 });
      ok('no photo card at all', (await ids(page)).length === 0);
      ok('the hint names where to choose them', /交件區/.test(await page.$eval('#emptyState p', e => e.textContent)));
      ok('no listing was requested', w.m.requests.filter(r => r.search.includes('list=')).length === 0);
      return out;
    },
    { before: w.attach, initScript: ADMIN_SRC });
}

}
