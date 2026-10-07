// Browser suites: photographer review view (index.html?project=): selection tables, review chrome,
// list / grid, copy link.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN, ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Admin → photos — admin.html's project detail links to index.html?project=,
// index.html shows just that project's picks, and same-tab Back returns to
// the same detail (task: 專案選片).
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Grace' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/zero.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：「目前選取」標題與每張照片都連到 index.html?project=（同分頁的純 <a>）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      // The table lives inside the 目前選取 section (a title row that opens and closes it), so its
      // rows are attached; the title row carries the count and the 看照片 link.
      await page.waitForSelector('#project-detail-body table tbody tr', { state: 'attached' });

      const r = await page.evaluate(() => {
        const summary = document.querySelector('#pd-sec-selections .pd-sec-head');
        const seeLink = summary && summary.querySelector('a.pd-link');
        const rowLinks = [...document.querySelectorAll('#project-detail-body table tbody tr a')];
        return {
          summaryText: summary && summary.textContent,
          seeHref: seeLink && seeLink.getAttribute('href'),
          seeTarget: seeLink && seeLink.getAttribute('target'),
          rowHrefs: rowLinks.map(a => a.getAttribute('href')),
          rowCount: rowLinks.length,
        };
      });
      ok('the title row shows the count (目前選取 … 2 張)', /目前選取/.test(r.summaryText || '') && /2 張/.test(r.summaryText || ''), r.summaryText);
      ok('看照片 → links to index.html?project=<id>', r.seeHref === 'index.html?project=proj-1', r.seeHref);
      ok('it is a plain same-tab link (no target=_blank)', !r.seeTarget, String(r.seeTarget));
      ok('exactly the 2 rating>0 rows are links (not the zero-rated one)', r.rowCount === 2, String(r.rowCount));
      ok('one row links to its own photo key, encoded',
        r.rowHrefs.includes('index.html?project=proj-1&photo=20260819%2Fa.jpg'), JSON.stringify(r.rowHrefs));
      ok('the other, in a different folder, does too',
        r.rowHrefs.includes('index.html?project=proj-1&photo=20260901%2Fb.jpg'), JSON.stringify(r.rowHrefs));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Norah', projectId: 'proj-collapse' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：目前選取表格預設收合（選片中），點標題列展開後仍看得到表格',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-sec-selections-btn', { timeout: 5000 });

      const openBefore = await page.$eval('#pd-sec-selections-btn', b => b.getAttribute('aria-expanded'));
      ok('collapsed by default', openBefore === 'false', String(openBefore));
      // actionability-grade isVisible(): the table is in the DOM but really not shown
      ok('and the table is not actually visible either',
        (await page.locator('#pd-selections-details table').isVisible()) === false);

      await page.click('#pd-sec-selections-btn');
      const after = await page.evaluate(() => ({
        open: document.getElementById('pd-sec-selections-btn').getAttribute('aria-expanded') === 'true',
        rowCount: document.querySelectorAll('#pd-selections-details table tbody tr').length,
      }));
      ok('expanding opens it', after.open === true);
      const rowVisible = await page.locator('#pd-selections-details table tbody tr').first().isVisible();
      ok('the table is still there, with its row', after.rowCount === 1 && rowVisible === true, String(after.rowCount));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry', projectId: 'proj-42' });
  await suite('admin — 專案選片：開啟詳細頁會把 id 寫進網址的 #project=',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible' });
      const hash = await page.evaluate(() => location.hash);
      ok('opening the detail sets #project=<id>', hash === '#project=proj-42', hash);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry', projectId: 'proj-42' });
  await suite('admin — 專案選片：admin.html#project=<id> 開啟時自動重開該專案（模擬從 index.html 上一頁回來）',
    `${base}/admin.html#project=proj-42`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#project-detail-panel', { state: 'visible', timeout: 5000 });
      const text = await page.evaluate(() => document.getElementById('project-detail-body').textContent);
      ok('the right project’s detail opened without clicking anything', text.includes('Henry'), text);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Ivy', projectId: 'proj-7' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/zero.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式（?project=）：只顯示已選相片，橫跨資料夾，並顯示 banner',
    `${base}/index.html?project=proj-7`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        cardCount: document.querySelectorAll('.photo-card').length,
        ids: [...document.querySelectorAll('.photo-card')].map(c => c.dataset.photoId),
        bannerHidden: document.getElementById('projectViewBanner').hidden,
        bannerText: document.getElementById('pvBannerText').textContent,
        backHref: document.getElementById('pvBackLink').getAttribute('href'),
      }));
      ok('only the 2 rating>0 selections are shown, not the zero-rated one', r.cardCount === 2, String(r.cardCount));
      ok('one is from each folder', r.ids.includes('20260819/a.jpg') && r.ids.includes('20260901/b.jpg'), JSON.stringify(r.ids));
      ok('the banner is shown', r.bannerHidden === false);
      ok('names the owner and the count', r.bannerText.includes('Ivy') && r.bannerText.includes('2'), r.bannerText);
      ok('links back to the same project on admin.html', r.backHref === 'admin.html#project=proj-7', r.backHref);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Jack', projectId: 'proj-8' });
  m.state.selections.set('20260819/pick-me.jpg', { rating: 4, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式：?photo= 直接開啟該張的預覽',
    `${base}/index.html?project=proj-8&photo=${encodeURIComponent('20260819/pick-me.jpg')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'),
        null, { timeout: 5000 });
      const name = await page.evaluate(() => document.getElementById('modalPhotoName').textContent);
      ok('the preview modal opens directly on that photo', name === 'pick-me.jpg', name);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('index.html — 專案選片：沒有 ?project= 時，攝影師模式完全不受影響',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    const active = await page.evaluate(() => !!(window.ProjectViewController && ProjectViewController.active));
    ok('ProjectViewController is not active', active === false);
    const bannerHidden = await page.evaluate(() => document.getElementById('projectViewBanner').hidden);
    ok('its banner stays hidden', bannerHidden === true);

    // task: 專案選片 sidebar trim only ever runs for ProjectViewController —
    // the plain studio sidebar keeps LOAD + RATING untouched.
    const sidebar = await page.evaluate(() => ({
      driveUrl: !!document.getElementById('driveUrl'),
      loadBtn: !!document.getElementById('loadPhotosBtn'),
      starFilter: !!document.querySelector('.star-filter'),
    }));
    ok('the studio sidebar still has LOAD', sidebar.driveUrl && sidebar.loadBtn, JSON.stringify(sidebar));
    ok('and RATING', sidebar.starFilter === true);

    await page.fill('#driveUrl', '20260819/');
    await page.click('#loadPhotosBtn');
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    const cards = await page.evaluate(() => document.querySelectorAll('.photo-card').length);
    ok('the ordinary path box + LOAD flow is untouched', cards === 3, String(cards));
    return out;
  },
  { initScript: ADMIN, before: pickFakeWorker().attach });

{
  const XSS_OWNER = '"><img src=x onerror="window.__xssPV=1">';
  const m = pickFakeWorker({ ownerName: XSS_OWNER, projectId: 'proj-9' });
  m.state.selections.set('20260819/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式：banner 裡的認領人姓名沒有變成元素',
    `${base}/index.html?project=proj-9`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        fired: !!window.__xssPV,
        injected: document.querySelectorAll('img[src="x"]').length,
        shown: document.getElementById('pvBannerText').textContent,
      }));
      ok('沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false);
      ok('姓名仍照原樣顯示在文字裡', r.shown.includes(XSS_OWNER), r.shown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Kelly' });
  m.state.project.phase = 'submitted';
  await suite('admin — 專案選片：開始精修後，列表徽章也一起更新（不是只有詳細頁）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-start-retouch-btn', { timeout: 5000 });
      await page.click('#pd-start-retouch-btn');
      await page.waitForFunction(
        () => document.querySelector('.pd-head .badge')?.textContent === '精修中',
        null, { timeout: 5000 });
      // the list is hidden while the detail is open (admin detail view) but is still kept
      // current; it is refreshed in the same step as the detail, so wait for it, not a fixed beat
      await page.waitForFunction(() => document.querySelector('[data-project-row]')?.textContent.includes('精修中'), null, { timeout: 5000 }).catch(() => {});
      const listText = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
      ok('the list row picks up 精修中 too, not just the detail panel', listText.includes('精修中'), listText);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Leo' });
  m.state.submissions.push({
    id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
    photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
    created_at: '2026-09-27T14:52:00.000Z',
  });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('admin — 專案選片：時間顯示轉為 Asia/Taipei（9/27 22:52，不是原始 ISO）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission');
      const r = await page.evaluate(() => ({
        submission: document.querySelector('.pd-submission').textContent,
        selectionRow: document.querySelector('#project-detail-body table tbody tr').textContent,
      }));
      ok('the submission time is shown in Taipei time, not raw ISO',
        r.submission.includes('9/27 22:52') && !r.submission.includes('2026-09-27T'), r.submission);
      ok('the selection’s updated time is too', r.selectionRow.includes('9/27 22:52'), r.selectionRow);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Mona' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：選取表格的「星等」欄改成 ♥',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      // collapsed by default (task: 專案選片 — admin collapse); attached
      // is enough here, the assertions below don't need it visible.
      await page.waitForSelector('#project-detail-body table tbody tr', { state: 'attached' });
      const r = await page.evaluate(() => ({
        headers: [...document.querySelectorAll('#project-detail-body table thead th')].map(th => th.textContent),
        cell: document.querySelectorAll('#project-detail-body table tbody tr td')[1]?.textContent,
      }));
      ok('the header is ♥, not 星等', r.headers.includes('♥') && !r.headers.includes('星等'), JSON.stringify(r.headers));
      ok('the cell shows ♥', r.cell === '♥', r.cell);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// index.html?project= — sidebar trim, read-only cards, downloads and the
// grid/list toggle (task: 專案選片, second pass).
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Oscar', projectId: 'proj-trim' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：側邊欄移除來源輸入/星級/FLAGS/標註過濾/排序/DATA（只剩 01 / SOURCE 標題）',
    `${base}/index.html?project=proj-trim`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        driveUrl: !!document.getElementById('driveUrl'),
        loadBtn: !!document.getElementById('loadPhotosBtn'),
        starFilter: !!document.querySelector('.star-filter'),
        filterSelectedBtn: !!document.getElementById('filterSelectedBtn'),
        flagsGrid: !!document.querySelector('.flags-grid'),
        toggleGroup: !!document.querySelector('.toggle-group'),
        sortSelect: !!document.getElementById('sortBy'),
        backupBtn: !!document.getElementById('backupDataBtn'),
        resetCurrentBtn: !!document.getElementById('resetCurrentDataBtn'),
        resetAllBtn: !!document.getElementById('resetAllDataBtn'),
        sourceTitle: [...document.querySelectorAll('aside.sidebar .side-title')].some(e => e.textContent.trim() === '01 / SOURCE'),
        bulkStars: !!document.getElementById('bulkStars'),
        clearRatingBtn: !!document.querySelector('#bulkActionBar button[onclick="app.setBulkRating(0)"]'),
      }));
      ok('SOURCE input removed', r.driveUrl === false);
      ok('LOAD button removed', r.loadBtn === false);
      ok('RATING star filter removed', r.starFilter === false);
      ok('只看選取 removed', r.filterSelectedBtn === false);
      ok('FLAGS section removed', r.flagsGrid === false);
      ok('ANNOTATION filter removed', r.toggleGroup === false);
      ok('positive: 01 / SOURCE title is still there', r.sourceTitle === true);
      ok('sort select removed (the sidebar keeps only 01 / SOURCE)', r.sortSelect === false);
      ok('匯出備份 JSON removed', r.backupBtn === false);
      ok('重設此資料夾 removed (dangerous here)', r.resetCurrentBtn === false);
      ok('清除所有快取 removed', r.resetAllBtn === false);
      ok('bulk-star buttons removed (would write ratings)', r.bulkStars === false);
      ok('清空評分 removed too', r.clearRatingBtn === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// index.html?project= — chrome trim (task: 只留 01 / SOURCE，頂部不要 預約拍攝 /
// 上傳 / 相本書). Removed from the DOM, never hidden (.btn{display:inline-flex}
// beats [hidden]); every other mode keeps all of it.
// ═══════════════════════════════════════════════════════════════════════════

const RV_GONE_IDS = ['clearFiltersBtn', 'filterSelectedBtn', 'selectedCountBadge', 'starsAll', 'stars0', 'stars1', 'stars2',
  'stars3', 'stars4', 'stars5', 'sortBy', 'backupDataBtn', 'resetCurrentDataBtn', 'resetAllDataBtn', 'syncSidebarSection',
  'pickFilterBar', 'flagCountPick', 'flagCountReview', 'flagCountReject',
  'studioBookingLink', 'uploadPageBtn', 'openBookEditorBtn'];
const RV_GONE_SEL = ['.star-filter', '.star-filter-btn', '.toggle-group', '.toggle-btn', '.flags-grid',
  'aside.sidebar select', 'aside.sidebar button', 'a[href*="upload.html"]', 'a[href*="book_editor"]'];
// the words Tim named, searched in the text of the part of the page they lived in
const RV_GONE_SIDEBAR_TEXT = ['02 / RATING', '03 / FLAGS', '04 / ANNOTATION', '05 / DATA', '排序', '清除', '匯出備份 JSON', '清除所有快取', '重設此資料夾'];
const RV_GONE_HEADER_TEXT = ['預約拍攝', '上傳', '相本書'];
// everything the trim must measure, in one evaluate
const RV_CHROME = ({ ids, sels }) => {
  const vis = el => {
    if (!el) return false;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const sb = document.querySelector('aside.sidebar');
  const hdr = document.querySelector('header.header');
  const hr = document.querySelector('.header-right');
  const txt = el => (el ? el.textContent : '');
  const byId = id => document.getElementById(id);
  return {
    pv: !!(window.ProjectViewController && ProjectViewController.active) && document.body.classList.contains('pv-active'),
    cards: document.querySelectorAll('.photo-card, .pv-list-row').length,
    goneIds: ids.filter(id => byId(id)),
    goneSels: sels.filter(s => document.querySelector(s)),
    titles: sb ? [...sb.querySelectorAll('.side-title')].map(e => e.textContent.trim()) : null,
    sections: sb ? sb.querySelectorAll(':scope > .sidebar-section').length : -1,
    sbChildren: sb ? sb.children.length : -1,
    sbText: txt(sb),
    hdrText: txt(hdr),
    hrVisible: hr ? [...hr.children].filter(vis).map(e => e.id || e.className) : null,
    kept: {
      sortPill: vis(byId('headerSortBtn')), sortPillText: txt(byId('headerSortBtn')),
      viewBtn: vis(byId('headerViewBtn')), viewBtnText: txt(byId('headerViewBtn')),
      avatar: vis(byId('userAvatarStudio')), avatarText: txt(byId('userAvatarStudio')),
      logout: vis(byId('studio-logout')), logoutText: txt(byId('studio-logout')),
      back: vis(byId('pvBackLink')), backText: txt(byId('pvBackLink')),
      copy: vis(byId('pvCopyLinkBtn')), copyText: txt(byId('pvCopyLinkBtn')),
      count: vis(byId('pvBannerText')), countText: txt(byId('pvBannerText')),
      preview: vis(byId('previewPane')),
      sidebarVisible: vis(sb),
      sidebarToggle: !!byId('sidebarToggle'),
    },
    docW: document.documentElement.scrollWidth, winW: window.innerWidth,
  };
};
const rvArgs = { ids: RV_GONE_IDS, sels: RV_GONE_SEL };
// SHOTS_DIR=<dir> saves a screenshot per suite (visual review only; not part of the checks)
async function rvShot(page, name) {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` });
}
function rvFixture(projectId) {
  const m = pickFakeWorker({ ownerName: 'Zed', projectId });
  for (const k of ['a', 'b', 'c']) {
    m.state.selections.set(`20260819/${k}.jpg`, { rating: 5, note: k === 'a' ? '請保留' : '', marks: null, updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  }
  return m;
}
// console.error is part of the contract here (page errors are caught by suite()). The
// browser's own "Failed to load resource" lines are network noise from the fake worker.
function rvWatchConsole(m, errs) {
  return async page => {
    await m.attach(page);
    page.on('console', msg => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errs.push(msg.text()); });
  };
}
async function rvAssertChrome(page, ok) {
  await page.waitForSelector('.photo-card', { timeout: 5000 });
  await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('#studio-logout', { timeout: 5000 });
  const r = await page.evaluate(RV_CHROME, rvArgs);
  ok('positive: review mode really started (pv-active) and the grid has its 3 picks', r.pv && r.cards === 3, JSON.stringify({ pv: r.pv, cards: r.cards }));
  ok('positive: the sidebar is rendered and holds the 01 / SOURCE title', !!r.titles && r.titles.includes('01 / SOURCE'), JSON.stringify(r.titles));
  ok('the sidebar holds only that one section and title (no RATING / FLAGS / ANNOTATION / DATA, no leftover heading)',
    r.sections === 1 && r.sbChildren === 1 && r.titles.length === 1 && r.titles[0] === '01 / SOURCE', JSON.stringify({ s: r.sections, c: r.sbChildren, t: r.titles }));
  ok('none of the removed controls exist in the DOM (ids)', r.goneIds.length === 0, r.goneIds.join());
  ok('none of the removed controls exist in the DOM (classes / tags)', r.goneSels.length === 0, r.goneSels.join());
  ok('the sidebar text has none of 02 / RATING, 04 / ANNOTATION, 排序, 05 / DATA, 清除, 匯出備份 JSON, 清除所有快取',
    RV_GONE_SIDEBAR_TEXT.every(t => !r.sbText.includes(t)), RV_GONE_SIDEBAR_TEXT.filter(t => r.sbText.includes(t)).join());
  ok('the top bar has no 預約拍攝 / 上傳 / 相本書 text', RV_GONE_HEADER_TEXT.every(t => !r.hdrText.includes(t)),
    RV_GONE_HEADER_TEXT.filter(t => r.hdrText.includes(t)).join());
  ok('the right side of the top bar shows only the avatar and 登出 (no empty group or placeholder left)',
    JSON.stringify(r.hrVisible) === JSON.stringify(['userAvatarStudio', 'studio-logout']), JSON.stringify(r.hrVisible));
  ok('kept: 返回專案 / 複製選片連結 / 張數列 are visible', r.kept.back && r.kept.copy && r.kept.count
    && r.kept.backText.includes('返回專案') && r.kept.copyText === '複製選片連結' && r.kept.countText.includes('Zed') && r.kept.countText.includes('3 張'), JSON.stringify(r.kept));
  ok('kept: avatar and 登出 are visible', r.kept.avatar && r.kept.avatarText === 'HC' && r.kept.logout && r.kept.logoutText === '登出', JSON.stringify(r.kept));
  ok('no horizontal page scroll', r.docW <= r.winW, `${r.docW}/${r.winW}`);
  return r;
}
async function rvInteract(page, ok, errs) {
  // use only what review mode keeps: open / next / close a photo, grid ↔ list, copy link
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => document.querySelector('.photo-card').click());
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
  const n1 = await page.evaluate(() => document.getElementById('modalPhotoName').textContent);
  await page.evaluate(() => document.getElementById('nextPhotoBtn').click());
  await page.waitForTimeout(150);
  const n2 = await page.evaluate(() => document.getElementById('modalPhotoName').textContent);
  ok('positive: the preview opens and next moves to another photo', !!n1 && !!n2 && n1 !== n2, `${n1} -> ${n2}`);
  await page.evaluate(() => document.getElementById('closeModal').click());
  await page.waitForSelector('#photoModal', { state: 'hidden', timeout: 5000 });
  // the same toggle a click on the header's 網格 button runs (driven from the page so a
  // phone, which may hide the header centre, is covered the same way)
  await page.evaluate(() => document.getElementById('headerViewBtn').click());
  const list = await page.evaluate(() => ({ rows: document.querySelectorAll('.pv-list-row').length, label: document.getElementById('headerViewBtn').textContent }));
  ok('positive: the 列表 toggle renders 3 rows', list.rows === 3 && list.label === '列表', JSON.stringify(list));
  await page.evaluate(() => document.getElementById('headerViewBtn').click());
  const grid = await page.evaluate(() => document.querySelectorAll('.photo-card').length);
  ok('and back to the grid with 3 cards', grid === 3, String(grid));
  await page.evaluate(() => document.getElementById('headerSortBtn').click());
  await page.evaluate(() => document.getElementById('pvCopyLinkBtn').click());
  await page.waitForTimeout(250);
  const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
  ok('positive: 複製選片連結 answered (toast shown)', toastShown === '已複製選片連結', toastShown);
  // app code that used to read the removed nodes must be a no-op, not a TypeError
  const probe = await page.evaluate(() => {
    try { app.updateStats(); app.applyFilters(); app.renderPhotoGrid(); return 'ok'; } catch (e) { return String(e); }
  });
  ok('updateStats / applyFilters / renderPhotoGrid run without the removed nodes', probe === 'ok', probe);
  ok('zero console.error during load, open / next / close, grid ↔ list and copy link', errs.length === 0, errs.join(' | '));
}

{
  const m = rvFixture('proj-chrome'); const errs = [];
  await suite('review chrome (desktop 1280) — sidebar keeps only 01 / SOURCE; no 預約拍攝 / 上傳 / 相本書; everything else stays; zero errors',
    `${base}/index.html?project=proj-chrome`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const r = await rvAssertChrome(page, ok);
      ok('kept: 排序 · 評分 ↓ and 網格 are visible in the top bar', r.kept.sortPill && r.kept.sortPillText === '排序 · 評分 ↓' && r.kept.viewBtn && r.kept.viewBtnText === '網格', JSON.stringify(r.kept));
      ok('kept: the right PREVIEW column is still there', r.kept.preview === true);
      ok('the sidebar column is still shown on a desktop', r.kept.sidebarVisible === true);
      await rvShot(page, 'after-review-1280');
      await rvInteract(page, ok, errs);
      return out;
    },
    { before: rvWatchConsole(m, errs), initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = rvFixture('proj-chrome-m'); const errs = [];
  await suite('review chrome (phone 390) — same trim; the ☰ drawer would only hold the SOURCE title, so no empty drawer; zero errors',
    `${base}/index.html?project=proj-chrome-m`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const r = await rvAssertChrome(page, ok);
      ok('no ☰ button (its drawer would hold nothing but a title), no backdrop', r.kept.sidebarToggle === false
        && await page.evaluate(() => !document.getElementById('sidebarBackdrop')), JSON.stringify(r.kept));
      ok('the sidebar is not on screen (drawer closed, off-canvas)', await page.evaluate(() => document.querySelector('aside.sidebar').getBoundingClientRect().right <= 0));
      ok('the grid is readable: first card sits inside the 390px viewport', await page.evaluate(() => {
        const b = document.querySelector('.photo-card').getBoundingClientRect(); return b.left >= 0 && b.right <= 390 && b.width > 60;
      }));
      await rvShot(page, 'after-review-390');
      await rvInteract(page, ok, errs);
      return out;
    },
    { before: rvWatchConsole(m, errs), initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = pickFakeWorker(); const errs = [];
  await suite('review chrome — the ordinary photographer index.html (no ?project=) keeps every sidebar section and top-bar link',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
      await page.waitForSelector('#studio-logout', { timeout: 5000 });
      const r = await page.evaluate(RV_CHROME, rvArgs);
      ok('positive: this is not review mode', r.pv === false);
      ok('every sidebar title is there (SOURCE, 選單 = the phone menu, RATING, FLAGS, ANNOTATION, 排序, DATA)', JSON.stringify(r.titles) === JSON.stringify(['01 / SOURCE', '選單', '02 / RATING', '03 / FLAGS', '04 / ANNOTATION', '排序', '05 / DATA']), JSON.stringify(r.titles));
      // every id review mode removes is still in the DOM, except #pickFilterBar (guest-only: pick.js fills it)
      const missing = await page.evaluate(ids => ids.filter(id => !document.getElementById(id)), RV_GONE_IDS);
      ok('every removed control is still in the DOM in the ordinary mode', missing.length === 0, missing.join());
      ok('and the selectors', await page.evaluate(s => s.every(q => !!document.querySelector(q)), ['.star-filter', '.toggle-group', '.flags-grid', 'aside.sidebar select', 'a[href*="upload.html"]']));
      ok('排序 select, 匯出備份 JSON, 清除所有快取 are displayed',
        await page.evaluate(() => ['sortBy', 'backupDataBtn', 'resetAllDataBtn'].every(id => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; })));
      ok('上傳 and 相本書 are displayed in the top bar', await page.evaluate(() => ['uploadPageBtn', 'openBookEditorBtn'].every(id => {
        const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0 && !!e.closest('.header-right'); })));
      ok('the top bar text names 上傳 and 相本書', r.hdrText.includes('上傳') && r.hdrText.includes('相本書'));
      ok('排序 · 評分 ↓, 網格, avatar and 登出 are displayed too', r.kept.sortPill && r.kept.viewBtn && r.kept.avatar && r.kept.logout, JSON.stringify(r.kept));
      ok('the ☰ toggle is still in the DOM', r.kept.sidebarToggle === true);
      ok('zero console.error', errs.length === 0, errs.join(' | '));
      await rvShot(page, 'normal-1280');
      return out;
    },
    { before: rvWatchConsole(m, errs), initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = pickFakeWorker(); const errs = [];
  await suite('review chrome — the guest page (?t=) is untouched: its own trim and dark theme, no review trim leaked in',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pickClaimOverlay:not([hidden])', { timeout: 5000 });
      await page.fill('#pickNameInput', 'Alice');
      await page.click('#pickClaimBtn');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        pv: document.body.classList.contains('pv-active') || !!(window.ProjectViewController && ProjectViewController.active),
        filterBar: !!document.querySelector('aside.sidebar #pickFilterBar') && getComputedStyle(document.getElementById('pickFilterBar')).display !== 'none',
        titles: [...document.querySelectorAll('aside.sidebar .side-title')].length,
        sections: document.querySelectorAll('aside.sidebar > .sidebar-section').length,
        gone: ['uploadPageBtn', 'openBookEditorBtn', 'headerSortBtn', 'sortBy', 'backupDataBtn', 'resetAllDataBtn'].filter(id => document.getElementById(id)),
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      const [rr, gg, bb] = r.bg.match(/\d+/g).map(Number);
      ok('positive: the guest page loaded its grid and filter bar', r.filterBar === true);
      ok('not in review mode', r.pv === false);
      ok('the guest sidebar is still just the folder section and the filter section, no titles', r.titles === 0 && r.sections === 2, JSON.stringify(r));
      ok('its own removals still hold', r.gone.length === 0, r.gone.join());
      ok('still dark', rr < 60 && gg < 60 && bb < 60, r.bg);
      ok('zero console.error', errs.length === 0, errs.join(' | '));
      return out;
    },
    { before: rvWatchConsole(m, errs), contextOptions: { viewport: { width: 1280, height: 800 } } });
}

{
  const m = pickFakeWorker({ ownerName: 'Petra', projectId: 'proj-ro' });
  m.state.selections.set('20260819/noted.jpg', { rating: 5, note: '請保留這張', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  m.state.selections.set('20260819/plain.jpg', { rating: 4, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：卡片只有唯讀 ♥ 與 💬，沒有星級/勾選框，沒有控制項能寫入評分',
    `${base}/index.html?project=proj-ro`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        readonlyHearts: document.querySelectorAll('.photo-card span.pick-heart-btn.on').length,
        noteBadges: document.querySelectorAll('.photo-card .pv-note-badge').length,
      }));
      ok('no star rating control on any card', r.stars === 0, String(r.stars));
      ok('no select checkbox either', r.selectBtns === 0, String(r.selectBtns));
      ok('no clickable heart — every ♥ is read-only', r.clickableHearts === 0, String(r.clickableHearts));
      ok('every card shows the read-only ♥', r.readonlyHearts === 2, String(r.readonlyHearts));
      ok('exactly the noted photo gets the 💬 marker', r.noteBadges === 1, String(r.noteBadges));

      // No control may write a rating — try the one shortcut that still
      // reaches setBulkRating() even with the bulk-star buttons gone.
      await page.click('#selectAllBtn');
      await page.keyboard.press('5');
      await page.waitForTimeout(200);
      const ratingsAfter = await page.evaluate(() => {
        const byId = {};
        app.photos.forEach(p => { byId[p.id] = p.rating; });
        return byId;
      });
      ok('ratings are unchanged after the bulk-rating keyboard shortcut',
        ratingsAfter['20260819/noted.jpg'] === 5 && ratingsAfter['20260819/plain.jpg'] === 4,
        JSON.stringify(ratingsAfter));
      const stored = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}'); }
        catch (e) { return {}; }
      });
      ok('nothing was persisted to localStorage either', !stored['20260819/plain.jpg'], JSON.stringify(stored));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const XSS_NOTE = '<img src=x onerror="window.__xssNote=1">';
  const m = pickFakeWorker({ ownerName: 'Quincy', projectId: 'proj-note' });
  m.state.selections.set('20260819/n.jpg', { rating: 5, note: XSS_NOTE, updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('index.html — 專案選片：preview 與 modal 顯示備註文字（escaped），沒有星星可點',
    `${base}/index.html?project=proj-note`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.hover('.photo-card');
      await page.waitForTimeout(250); // updatePreviewPane's own hover debounce
      const r = await page.evaluate(() => ({
        noteHidden: document.getElementById('pvPreviewNoteSection').hidden,
        noteText: document.getElementById('pvPreviewNote').textContent,
        injected: document.querySelectorAll('#pvPreviewNote img').length,
        fired: !!window.__xssNote,
        heartReadOnly: document.querySelectorAll('#previewStars span.pick-heart-btn.on').length,
        heartClickable: document.querySelectorAll('#previewStars button.pick-heart-btn').length,
        hintHidden: document.getElementById('previewStarsHint').hidden,
      }));
      ok('the note section is shown', r.noteHidden === false);
      ok('the note text is there as text, not injected as an element',
        r.noteText.includes(XSS_NOTE) && r.injected === 0, r.noteText);
      ok('onerror never fired', r.fired === false);
      ok('the preview heart is read-only (a span), not a button',
        r.heartReadOnly === 1 && r.heartClickable === 0, JSON.stringify(r));
      ok('the "按 1–5" hint is hidden — nothing here is keyed by number', r.hintHidden === true);

      await page.click('.photo-card');
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      const modal = await page.evaluate(() => ({
        noteValue: document.getElementById('photoNote').value,
        readOnly: document.getElementById('photoNote').readOnly,
        mprHeart: document.querySelectorAll('#modalPhotoRating span.pick-heart-btn.on').length,
      }));
      ok('the modal note textarea shows the same text (via .value, never innerHTML)',
        modal.noteValue === XSS_NOTE, modal.noteValue);
      ok('and is read-only', modal.readOnly === true);
      ok('the modal footer shows the read-only heart too', modal.mprHeart === 1, String(modal.mprHeart));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Rex', projectId: 'proj-dl' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：打包全部下載／下載選取 只打包這個專案跨資料夾的選片',
    `${base}/index.html?project=proj-dl`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => {
        window.__zipFiles = [];
        window.JSZip = function () {
          this.file = (name) => window.__zipFiles.push(name);
          this.generateAsync = async () => new Blob(['z']);
        };
      });

      await page.click('#downloadAllBtn');
      await page.waitForTimeout(400);
      const filesAll = await page.evaluate(() => window.__zipFiles.slice());
      ok('打包全部下載 packages exactly the project’s 2 picks, from both folders',
        filesAll.length === 2 && filesAll.includes('a.jpg') && filesAll.includes('b.jpg'), JSON.stringify(filesAll));

      await page.evaluate(() => { window.__zipFiles.length = 0; });
      // 下載選取's buttons are hidden in this view (suite 31 checks that), so call the hook they
      // are wired to — it still exists and still does what 打包全部下載 does
      await page.evaluate(() => app.downloadSelected());
      await page.waitForTimeout(400);
      const filesSel = await page.evaluate(() => window.__zipFiles.slice());
      ok('下載選取 downloads the same set (documented behaviour: 下載選取 = 全部選片)',
        filesSel.length === 2 && filesSel.includes('a.jpg') && filesSel.includes('b.jpg'), JSON.stringify(filesSel));

      const fetched = m.requests.filter(r => r.method === 'GET').map(r => r.path);
      ok('both photos were actually fetched from their own folder, proving this is not driveManager.photos (which stays empty here)',
        fetched.includes('/20260819/a.jpg') && fetched.includes('/20260901/b.jpg'), JSON.stringify(fetched));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Sara', projectId: 'proj-list' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '備註A', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('index.html — 專案選片：格狀/列表切換，列表顯示縮圖/檔名/備註/更新時間，並記住選擇',
    `${base}/index.html?project=proj-list`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const before = await page.evaluate(() => document.getElementById('headerViewBtn').textContent.trim());
      ok('starts in grid mode (網格)', before === '網格', before);

      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const r = await page.evaluate(() => {
        const row = document.querySelector('.pv-list-row');
        return {
          btnText: document.getElementById('headerViewBtn').textContent.trim(),
          gridHasListClass: document.getElementById('photoGrid').classList.contains('pv-list'),
          cardCount: document.querySelectorAll('.photo-card').length,
          rowCount: document.querySelectorAll('.pv-list-row').length,
          thumb: !!row.querySelector('.pv-list-thumb'),
          name: row.querySelector('.pv-list-name')?.textContent,
          note: row.querySelector('.pv-list-note')?.textContent,
          time: row.querySelector('.pv-list-time')?.textContent,
        };
      });
      ok('the header button now reads 列表', r.btnText === '列表', r.btnText);
      ok('the grid container gets the list layout class', r.gridHasListClass === true);
      ok('grid cards are gone', r.cardCount === 0, String(r.cardCount));
      ok('exactly one row', r.rowCount === 1, String(r.rowCount));
      ok('the row has a thumbnail', r.thumb === true);
      ok('and the filename', r.name === 'a.jpg', r.name);
      ok('and the note', r.note === '備註A', r.note);
      ok('and the updated time, in Taipei format, like admin.html', r.time === '9/27 22:52', r.time);

      await page.click('.pv-list-row');
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      ok('clicking a row opens the preview', true);
      await page.click('#closeModal');

      await page.reload();
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const afterReload = await page.evaluate(() => document.getElementById('headerViewBtn').textContent.trim());
      ok('the choice is remembered across reload (localStorage)', afterReload === '列表', afterReload);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Tina', projectId: 'proj-btn' });
  await suite('index.html — 專案選片：「← 返回專案」是明顯的按鈕（仍是可 middle-click 的 <a>）',
    `${base}/index.html?project=proj-btn`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      const r = await page.evaluate(() => {
        const el = document.getElementById('pvBackLink');
        return { tag: el.tagName, cls: el.className, href: el.getAttribute('href') };
      });
      ok('it is a real <a>', r.tag === 'A', r.tag);
      ok('styled with the existing .btn look, left of the banner text', r.cls.includes('btn') && r.cls.includes('btn-outline'), r.cls);
      ok('href still resolves — middle-click / back-nav semantics stay intact',
        r.href === 'admin.html#project=proj-btn', r.href);
      return out;
    },
    { before: m.attach, initScript: ADMIN });

  await suite('index.html — 專案選片：手機版「← 返回專案」至少 44px 高',
    `${base}/index.html?project=proj-btn`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      const box = await page.locator('#pvBackLink').boundingBox();
      ok('at least 44px tall on a phone-width viewport', !!box && box.height >= 44, JSON.stringify(box));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Uma', projectId: 'proj-copylink', listToken: 'PICK-LIVE-1' });
  await suite('index.html — 專案選片：複製選片連結 複製最新的有效挑選連結（不是資料夾）',
    `${base}/index.html?project=proj-copylink`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('copies index.html?t=<newest live token>', /index\.html\?t=PICK-LIVE-1$/.test(clip), clip);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('confirms with a success toast', toastShown === '已複製選片連結', toastShown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // A revoked-only link is not "有效" either — this must actually check
  // status, not just whether any token row exists at all.
  const m = pickFakeWorker({ ownerName: 'Wade', projectId: 'proj-revoked' });
  m.state.tokens[0].revoked_at = '2026-01-01T00:00:00.000Z';
  await suite('index.html — 專案選片：只剩已撤銷的連結時，也算沒有有效連結',
    `${base}/index.html?project=proj-revoked`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('shows 沒有有效連結，請到專案頁產生', toastShown === '沒有有效連結，請到專案頁產生', toastShown);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('the revoked token was not copied', clip === 'sentinel', clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', projectId: 'proj-nolink', listToken: null });
  await suite('index.html — 專案選片：沒有有效連結時提示「沒有有效連結，請到專案頁產生」，不複製任何東西',
    `${base}/index.html?project=proj-nolink`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('shows 沒有有效連結，請到專案頁產生', toastShown === '沒有有效連結，請到專案頁產生', toastShown);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('nothing was copied — clipboard stays untouched', clip === 'sentinel', clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
