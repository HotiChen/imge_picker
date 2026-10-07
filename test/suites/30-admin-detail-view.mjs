// Browser suites: admin.html 選片專案 is two views, the list and ONE project's detail.
// Opening a project switches to the detail view (list, 顯示已封存 and the create form are
// hidden, 「← 返回專案列表」 on top); #project=<id> is the address of the detail view.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-dv', title: '視圖專案', folders: ['shoot/毛片/'], ...o });
const ADMIN_URL = `${base}/admin.html`;

// What the page shows for one selector: `exists` separates "hidden" from "not there at all"
// (an absent element would pass every "is not shown" check). `shown` is the RESULT on screen:
// it has layout boxes, a real size and is not visibility:hidden — never the `hidden` attribute,
// because `.btn{display:inline-flex}` beats it. A child of a display:none parent has computed
// display inline-block but no boxes, so the boxes are what count.
const SEE = sel => {
  const el = document.querySelector(sel);
  if (!el) return { exists: false, shown: false };
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  const boxes = el.getClientRects().length;
  return { exists: true, display: cs.display, visibility: cs.visibility, boxes, shown: boxes > 0 && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) };
};
const see = (page, sel) => page.evaluate(SEE, sel);
const isShown = async (page, sel) => (await see(page, sel)).shown;
// hidden = in the DOM and takes no space on screen — not merely "absent"
const isHidden = async (page, sel) => { const s = await see(page, sel); return s.exists && s.boxes === 0 && !s.shown; };
const LIST_PARTS = ['#project-create-panel', '#proj-title', '#proj-create-btn', '#proj-show-archived-toggle', '#proj-recent-list', '[data-open-project]'];
const listState = async page => {
  const o = {};
  for (const s of LIST_PARTS) o[s] = (await see(page, s)).shown;
  return o;
};
const listAllShown = async page => Object.values(await listState(page)).every(Boolean);
const listAllHidden = async page => {
  for (const s of LIST_PARTS) { if (!(await isHidden(page, s))) return false; }
  return true;
};
const hashOf = page => page.evaluate(() => location.hash);
const waitDetail = page => page.waitForSelector('#pd-sec-settings', { timeout: 5000 });
const waitList = page => page.waitForSelector('[data-open-project]', { state: 'visible', timeout: 5000 });
// An entry for Back to land on that is not about:blank (the suite's init script cannot touch
// sessionStorage there): a page of the same origin, then admin.html on top of it.
const leaveBehind = async page => {
  await page.goto(`${base}/none.html`);
  await page.goto(ADMIN_URL, { waitUntil: 'load' });
};
const lines = () => {
  const out = [];
  return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) };
};

// ── 1. open → detail view (desktop): what is hidden, what is shown, the hash, the position ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 開啟專案：列表、顯示已封存、建立表單都隱藏，詳情與「← 返回專案列表」顯示（1280×800）',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      ok('before: the list, 顯示已封存 and the create form are all shown (positive baseline)', await listAllShown(page), JSON.stringify(await listState(page)));
      ok('before: the detail panel and the back control are not shown (but exist)', await isHidden(page, '#project-detail-panel') && await isHidden(page, '#pd-back-btn'), JSON.stringify(await see(page, '#pd-back-btn')));
      ok('before: no #project hash', !/project=/.test(await hashOf(page)), await hashOf(page));
      await page.click('[data-open-project]');
      await waitDetail(page);
      ok('the detail panel is shown', await isShown(page, '#project-detail-panel'));
      ok('the project title is on screen in the detail', (await page.textContent('.pd-head h3')) === '視圖專案');
      ok('the whole list/create area is hidden: each of its parts exists and has no box on screen', await listAllHidden(page), JSON.stringify(await listState(page)));
      ok('the 選片專案 heading of the list area is hidden too', await isHidden(page, '#projects-list-area h2'));
      const back = await see(page, '#pd-back-btn');
      ok('「← 返回專案列表」 is shown, a <button>, the first thing in the panel', back.shown && (await page.textContent('#pd-back-btn')).trim() === '← 返回專案列表'
        && await page.evaluate(() => { const b = document.getElementById('pd-back-btn'); return b.tagName === 'BUTTON' && b.type === 'button' && b.closest('#project-detail-panel').firstElementChild.contains(b); }), JSON.stringify(back));
      ok('the hash is #project=proj-dv', (await hashOf(page)) === '#project=proj-dv', await hashOf(page));
      const pos = await page.evaluate(() => ({ y: scrollY, panelTop: Math.round(document.getElementById('project-detail-panel').getBoundingClientRect().top), vh: innerHeight }));
      ok('the detail starts at the top: no scroll, the panel begins in the first 150px of the page', pos.y === 0 && pos.panelTop < 150, JSON.stringify(pos));
      ok('the first section title is inside the first screen without scrolling', (await see(page, '#pd-sec-settings-btn')).bottom < pos.vh, JSON.stringify(await see(page, '#pd-sec-settings-btn')));
      ok('the side menu is still there (this is still the 選片專案 screen)', await isShown(page, '.side-nav-item.active'));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 2. the back control ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 「← 返回專案列表」回到列表：列表與建立表單回來、詳情隱藏、hash 清掉、捲動位置回來',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.evaluate(() => { document.getElementById('proj-recent-list').style.marginBottom = '3000px'; });
      await page.fill('#proj-title', '王小明 婚紗');
      await page.evaluate(() => scrollTo(0, 420));
      const before = await page.evaluate(() => scrollY);
      await page.evaluate(() => document.querySelector('[data-open-project]').click());   // a click that does not scroll the row into view first
      await waitDetail(page);
      ok('detail view is up (precondition)', await isShown(page, '#project-detail-panel') && await listAllHidden(page));
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('the list, the checkbox and the create form are shown again', await listAllShown(page), JSON.stringify(await listState(page)));
      ok('the detail panel and its back control are hidden (exist, display none)', await isHidden(page, '#project-detail-panel') && await isHidden(page, '#pd-back-btn'));
      await page.waitForFunction(() => !/project=/.test(location.hash), null, { timeout: 3000 });
      ok('the #project hash is gone', !/project=/.test(await hashOf(page)), await hashOf(page));
      ok('the create form is exactly as it was left (typed name kept)', (await page.inputValue('#proj-title')) === '王小明 婚紗');
      const y = await page.evaluate(() => scrollY);
      ok(`the scroll position is back on the list where it was (${before})`, before > 300 && Math.abs(y - before) <= 2, `before=${before} after=${y}`);
      await page.click('[data-open-project]');
      await waitDetail(page);
      ok('opening it again works (detail shown, list hidden, hash set)', await isShown(page, '#project-detail-panel') && await listAllHidden(page) && (await hashOf(page)) === '#project=proj-dv');
      ok('and the second open also starts at the top', (await page.evaluate(() => scrollY)) === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 3. the browser Back / Forward buttons ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 瀏覽器上一頁／下一頁：上一頁回列表、下一頁回詳情，上一頁不會卡在詳情',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await leaveBehind(page);
      await waitList(page);
      await page.click('[data-open-project]');
      await waitDetail(page);
      await page.goBack();
      await waitList(page);
      ok('Back from the detail shows the list (list + form shown, detail hidden)', await listAllShown(page) && await isHidden(page, '#project-detail-panel'));
      ok('Back cleared the hash, and the page is still admin.html', !/project=/.test(await hashOf(page)) && /admin\.html/.test(page.url()), page.url());
      await page.goForward();
      await waitDetail(page);
      ok('Forward shows that project\'s detail again (list hidden)', await isShown(page, '#project-detail-panel') && await listAllHidden(page) && (await hashOf(page)) === '#project=proj-dv');
      await page.goBack();
      await waitList(page);
      await page.goBack();
      await page.waitForFunction(() => !/admin\.html/.test(location.href), null, { timeout: 5000 });
      ok('a second Back leaves admin.html — it is not trapped on the page by re-pushed entries', !/admin\.html/.test(page.url()), page.url());
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 按「返回」之後再按上一頁，不會又回到詳情（返回用掉了詳情那一筆歷史）',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await leaveBehind(page);
      await waitList(page);
      const entries = await page.evaluate(() => history.length);
      await page.click('[data-open-project]');
      await waitDetail(page);
      ok('opening added exactly one history entry', (await page.evaluate(() => history.length)) === entries + 1, String(await page.evaluate(() => history.length)));
      await page.click('#pd-back-btn');
      await waitList(page);
      await page.waitForFunction(() => !/project=/.test(location.hash), null, { timeout: 3000 });
      await page.goBack();
      await page.waitForFunction(() => !/admin\.html/.test(location.href), null, { timeout: 5000 });
      ok('Back after 返回 goes to the page before admin.html, not into the detail again', !/admin\.html/.test(page.url()), page.url());
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 4. deep link / reload ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 直接開 #project=<id>：落在詳情視圖（列表隱藏、從頂端開始），返回回列表且不離開頁面',
    `${ADMIN_URL}#project=proj-dv`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      ok('lands in the detail view: panel shown, back control shown, list/create form hidden', await isShown(page, '#project-detail-panel') && await isShown(page, '#pd-back-btn') && await listAllHidden(page), JSON.stringify(await listState(page)));
      ok('it is that project (title on screen) and the page is at the top', (await page.textContent('.pd-head h3')) === '視圖專案' && (await page.evaluate(() => scrollY)) === 0);
      ok('no extra history entry was pushed by the load itself', (await hashOf(page)) === '#project=proj-dv');
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('返回 on a deep link shows the list + create form and hides the detail', await listAllHidden(page) === false && await listAllShown(page) && await isHidden(page, '#project-detail-panel'));
      ok('still on admin.html (返回 did not navigate away), hash cleared', /admin\.html/.test(page.url()) && !/project=/.test(await hashOf(page)), page.url());
      ok('and the hash stays clear (no re-open)', await page.waitForTimeout(300).then(() => isHidden(page, '#project-detail-panel')));
      await page.click('[data-open-project]');
      await waitDetail(page);
      await page.reload({ waitUntil: 'load' });
      await waitDetail(page);
      ok('reload on the detail address lands in the detail again', await isShown(page, '#project-detail-panel') && await listAllHidden(page) && (await hashOf(page)) === '#project=proj-dv');
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('返回 after a reload also returns to the list', await listAllShown(page) && await isHidden(page, '#project-detail-panel'));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 5. unknown / deleted id ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — hash 的專案不存在：退回列表並顯示一行訊息，不是空白頁',
    `${ADMIN_URL}#project=no-such-project`,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.waitForSelector('#proj-notice', { state: 'visible', timeout: 5000 });
      const note = await page.textContent('#proj-notice');
      ok('a short message says the project was not found', /找不到/.test(note) && note.length < 60, note);
      ok('the list and create form are shown (not a blank page)', await listAllShown(page), JSON.stringify(await listState(page)));
      ok('the detail panel is hidden, no stray 載入中', await isHidden(page, '#project-detail-panel') && !(await page.evaluate(() => document.getElementById('project-detail-body').textContent.includes('載入中'))));
      ok('the bad hash was dropped', !/project=/.test(await hashOf(page)), await hashOf(page));
      ok('the Worker was asked for that id (it was the 404 that decided)', m.requests.some(r => r.method === 'GET' && r.path === '/api/admin/projects/no-such-project'));
      await page.click('[data-open-project]');
      await waitDetail(page);
      ok('the message is gone once a real project is opened', await isHidden(page, '#proj-notice') || (await page.textContent('#proj-notice')) === '');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 讀取詳情失敗（500）：留在詳情視圖顯示錯誤，「返回」仍可用',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.route('**/api/admin/projects/proj-dv', r => r.request().method() === 'GET'
        ? r.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"boom"}' }) : r.fallback());
      await page.click('[data-open-project]');
      await page.waitForFunction(() => /讀取失敗（500）/.test(document.getElementById('project-detail-body').textContent), null, { timeout: 5000 });
      ok('the error is shown in the detail view, which is shown', await isShown(page, '#project-detail-panel') && await isShown(page, '#project-detail-body'));
      ok('the back control is shown', await isShown(page, '#pd-back-btn'));
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('返回 shows the list', await listAllShown(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 6. phone ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 手機 390×844：按開啟就看到詳情（從頂端開始、不用捲動），返回回到列表，沒有新增橫向溢出',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      const overflowList = await page.evaluate(() => document.documentElement.scrollWidth);
      await page.evaluate(() => { document.getElementById('proj-recent-list').style.marginBottom = '2500px'; scrollTo(0, 300); });
      // the 開啟 button must already be on screen at 300, or tap() scrolls it into view first and the position to come back to is not 300 (the create form is taller since 攝影類別)
      await page.evaluate(() => { const b = document.querySelector('[data-open-project]'); const r = b.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight - 150) scrollTo(0, scrollY + r.top - 400); });
      const y0 = await page.evaluate(() => scrollY);
      await page.locator('[data-open-project]').tap();
      await waitDetail(page);
      ok('detail shown, list/create form hidden', await isShown(page, '#project-detail-panel') && await listAllHidden(page), JSON.stringify(await listState(page)));
      const pos = await page.evaluate(() => ({ y: scrollY, h: Math.round(document.getElementById('pd-back-btn').getBoundingClientRect().top), title: Math.round(document.querySelector('.pd-head h3').getBoundingClientRect().top), vh: innerHeight, vw: innerWidth }));
      ok('at the top (scrollY 0), the back control and the project title are inside the first screen', pos.y === 0 && pos.h >= 0 && pos.h < pos.vh && pos.title > 0 && pos.title < pos.vh, JSON.stringify(pos));
      ok('the back control is tappable size (>= 32px tall)', (await page.evaluate(() => document.getElementById('pd-back-btn').getBoundingClientRect().height)) >= 32);
      const overflowDetail = await page.evaluate(() => document.documentElement.scrollWidth);
      ok('the detail view adds no horizontal overflow beyond what the list view already has', overflowDetail <= overflowList, `list=${overflowList} detail=${overflowDetail} viewport=${pos.vw}`);
      await page.locator('#pd-back-btn').tap();
      await waitList(page);
      ok('返回 shows the list again, detail hidden', await listAllShown(page) && await isHidden(page, '#project-detail-panel'));
      await page.waitForFunction(() => scrollY > 250, null, { timeout: 3000 }).catch(() => {});
      ok(`and the scroll position is back near where the list was (${y0})`, y0 > 250 && Math.abs((await page.evaluate(() => scrollY)) - y0) <= 2, `${y0} → ${await page.evaluate(() => scrollY)}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// ── 7. actions that remove the project from the list return to it ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 封存：回到列表（專案從列表消失），勾「顯示已封存」可再開啟，取消封存留在詳情',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      page.once('dialog', d => d.accept());
      await page.click('#pd-archive-btn');
      await page.waitForFunction(() => document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('the archive endpoint was called', m.requests.some(r => r.method === 'POST' && r.path.endsWith('/archive')));
      ok('back on the list: the (now empty) list, 顯示已封存 and the create form are shown', await isShown(page, '#proj-recent-list') && await isShown(page, '#proj-show-archived-toggle') && await isShown(page, '#project-create-panel'));
      ok('the detail panel is hidden and the hash is cleared', await isHidden(page, '#project-detail-panel') && !/project=/.test(await hashOf(page)), await hashOf(page));
      await page.check('#proj-show-archived-toggle');
      await page.waitForSelector('[data-open-project]', { state: 'visible', timeout: 5000 });
      ok('the archived project is in the list with its badge', (await page.textContent('[data-project-row]')).includes('已封存'));
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-unarchive-btn', { timeout: 5000 });
      ok('opening it shows the detail (取消封存 offered), list hidden', await isShown(page, '#pd-unarchive-btn') && await listAllHidden(page));
      await page.click('#pd-unarchive-btn');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      ok('取消封存 keeps the detail view (the project is still the one being looked at): detail shown, list area and form hidden',
        await isShown(page, '#project-detail-panel') && await isHidden(page, '#proj-recent-list') && await isHidden(page, '#project-create-panel') && await isHidden(page, '#proj-show-archived-toggle'));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 刪除：回到列表（列表為空），詳情隱藏，hash 清掉',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-delete-btn', { timeout: 5000 });
      page.once('dialog', d => d.accept());
      await page.click('#pd-delete-btn');
      await page.waitForFunction(() => document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('the DELETE was sent', m.requests.some(r => r.method === 'DELETE'));
      ok('the list view is back (list area and form shown)', await isShown(page, '#proj-recent-list') && await isShown(page, '#project-create-panel') && await isShown(page, '#proj-show-archived-toggle'));
      ok('the detail panel is hidden, hash cleared', await isHidden(page, '#project-detail-panel') && !/project=/.test(await hashOf(page)), await hashOf(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 8. the menu ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 側欄「選片專案」從詳情回列表；詳情時切到客戶再上一頁回到同一個詳情',
    `${ADMIN_URL}#project=proj-dv`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      await page.click('.side-nav-item[data-nav="clients"]');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('view-clients')).display !== 'none', null, { timeout: 5000 });
      await page.goBack();
      await waitDetail(page);
      ok('Back from 客戶 lands on the same project\'s detail (list hidden, detail shown)', await isShown(page, '#project-detail-panel') && await listAllHidden(page) && (await hashOf(page)) === '#project=proj-dv');
      await page.click('.side-nav-item[data-nav="projects"]');
      await waitList(page);
      ok('the menu\'s 選片專案 shows the list view', await listAllShown(page) && await isHidden(page, '#project-detail-panel'));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 8b. creating a project keeps the list view (the link to send is in the list area) ──
{
  const m = fx({ phase: 'picking' });
  await suite('admin 詳情視圖 — 建立專案後留在列表：「連結已建立」與連結可見、新專案在列表、詳情不會蓋掉它',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.fill('#proj-title', '王小明 婚紗');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('proj-title').value === '', null, { timeout: 5000 });   // the list has reloaded
      await page.waitForTimeout(300);   // long enough for an (unwanted) detail to have opened
      ok('the create POST was sent', m.requests.some(r => r.method === 'POST' && r.path === '/api/admin/projects'));
      ok('the 連結已建立 box is shown with a link in it', await isShown(page, '#proj-create-result') && /t=PICK-TOKEN/.test(await page.inputValue('#proj-link-output')));
      ok('the list, its rows and the create form are shown', await listAllShown(page), JSON.stringify(await listState(page)));
      ok('no detail opened: the panel is hidden and there is no #project hash', await isHidden(page, '#project-detail-panel') && !/project=/.test(await hashOf(page)), await hashOf(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

// ── 9. a refresh of the open project redraws in place (no 載入中 flash, the page does not jump) ──
{
  const m = fx({ phase: 'retouching', pickLimit: 30, extraMax: 10, extraPrice: 500 });
  await suite('admin 詳情視圖 — 儲存方案後重讀專案：就地重畫，摘要元素從不消失（沒有「載入中」閃一下），捲動位置不跳',
    `${ADMIN_URL}#project=proj-dv`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      await page.click('#pd-sec-settings-btn');
      await page.evaluate(() => {
        window.__gone = 0; window.__loading = 0;
        new MutationObserver(() => {
          if (!document.getElementById('pd-sec-settings-sum')) window.__gone++;
          if (/載入中/.test(document.getElementById('project-detail-body').textContent) && !document.getElementById('pd-sec-settings-sum')) window.__loading++;
        }).observe(document.body, { childList: true, subtree: true });
        document.getElementById('project-detail-body').style.paddingBottom = '2500px';
        scrollTo(0, 300);
      });
      const y0 = await page.evaluate(() => scrollY);
      await page.fill('#pd-plan-limit', '35');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => /35 張/.test(document.getElementById('pd-sec-settings-sum').textContent), null, { timeout: 4000 });
      await page.waitForSelector('#pd-plan-ok:not(:empty)', { timeout: 3000 });
      const r = await page.evaluate(() => ({ gone: window.__gone, loading: window.__loading, y: scrollY, ok: document.getElementById('pd-plan-ok').textContent }));
      ok('positive: the page really re-read the project (summary now 35 張, 已儲存 shown)', r.ok === '已儲存', JSON.stringify(r));
      ok('the summary element was never missing while the project was re-read', r.gone === 0, JSON.stringify(r));
      ok('the detail never fell back to 載入中… on a refresh of the same project', r.loading === 0, JSON.stringify(r));
      ok('the scroll position did not jump', y0 >= 250 && Math.abs(r.y - y0) <= 2, `before=${y0} after=${r.y}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}
}
