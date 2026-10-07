// Browser suites: guest page UI at 390 / 1280 px (owner, viewer, delivered) and the photographer
// own index.html.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { mockWorker } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Guest pick page UI round (docs/backlog.md "Guest pick page UI") — guest
// links only: folder + filter and nothing else; a sticky #guestBar instead of
// the drawer on a phone; one submit button (the bottom one); no 預約拍攝; a
// person icon instead of HC. The photographer's own page keeps every tool.
// (suite() already fails any suite on a pageerror, so a missing element that
// app.js does not tolerate shows up here.)
// ═══════════════════════════════════════════════════════════════════════════

const GUI_PHOTOS = {
  'A/': Array.from({ length: 30 }, (_, i) => ({ id: `A/a${String(i).padStart(2, '0')}.jpg`, name: `a${String(i).padStart(2, '0')}.jpg`, size: 9e6, rating: 0 })),
  'B/': Array.from({ length: 2 }, (_, i) => ({ id: `B/b${i}.jpg`, name: `b${i}.jpg`, size: 9e6, rating: 0 })),
};
const guiIds = page => page.$$eval('.photo-card', cs => cs.map(c => c.dataset.photoId));
const guiVisible = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}, sel);
const GUI_STUDIO = { name: '海邊影像工作', booking_url: 'https://booking.example.com/x', has_logo: true };
const GUI_TITLE = '<b>阿明</b> 婚禮 & 家人';
const GUI_GONE = ['#sidebarToggle', '#sidebarBackdrop', 'aside.sidebar', '.sidebar', '.flags-grid', '[data-annotated]',
  '#sortBy', '#syncSidebarSection', '.star-filter', '#clearFiltersBtn', '#filterSelectedBtn', '#submitJobBtn',
  '#studioBookingLink', '.logo-label', '#buildVersion', '#headerSortBtn', '#backupDataBtn', '#resetAllDataBtn', '#expiryBadge'];

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS,
    pickLimit: 5, title: GUI_TITLE, studio: GUI_STUDIO });
  m.state.selections.set('A/a01.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest UI 390px — owner: no ☰/drawer/photographer tools; sticky #guestBar with title, folder select and filter; one submit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作', null, { timeout: 5000 });

      const present = await page.evaluate(sels => sels.filter(s => document.querySelector(s)), GUI_GONE);
      ok('☰, backdrop, .sidebar, FLAGS, ANNOTATION, 排序, DATA, star filter, header submit, 預約 — all null in the DOM', present.length === 0, JSON.stringify(present));
      ok('no 02/03/04/05 titles anywhere in the page text',
        !(await page.evaluate(() => /RATING|FLAGS|ANNOTATION|05 \/ DATA|SOURCE/.test(document.body.innerText))));

      // ── #guestBar
      ok('#guestBar is displayed (computed)', await guiVisible(page, '#guestBar'));
      const g = await page.evaluate(() => {
        const r = e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
        const bar = document.getElementById('guestBar');
        const card = document.querySelector('.photo-card');
        const first = document.querySelector('.content').firstElementChild;
        return {
          bar: r(bar), header: r(document.querySelector('.header')), card: r(card), vw: innerWidth,
          title: document.getElementById('guestBarTitle').textContent,
          titleHasEl: !!document.getElementById('guestBarTitle').querySelector('b'),
          titleFirst: bar.firstElementChild.id, firstInContent: first.id,
          sel: r(document.getElementById('guestFolderSelect')),
          filters: [...bar.querySelectorAll('[data-pick-filter]')].map(b => ({ k: b.dataset.pickFilter, ...r(b) })),
          opts: [...document.getElementById('guestFolderSelect').options].map(o => o.value),
          selVal: document.getElementById('guestFolderSelect').value,
          scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth,
        };
      });
      ok('inside the viewport horizontally', g.bar.l >= 0 && g.bar.r <= g.vw, JSON.stringify(g.bar));
      ok('right under the header (top == header bottom)', Math.abs(g.bar.t - g.header.b) <= 1.5, `${g.bar.t} vs ${g.header.b}`);
      ok('above the grid content', g.bar.b <= g.card.t + 0.5, `${g.bar.b} vs ${g.card.t}`);
      ok('it is the first thing in the content column', g.firstInContent === 'guestBar');
      ok('project title is the first line, as plain text (never innerHTML)', g.titleFirst === 'guestBarTitle' && g.title === GUI_TITLE && !g.titleHasEl, g.title);
      ok('folder selector lists the permitted folders and shows the current one', JSON.stringify(g.opts) === '["A/","B/"]' && g.selVal === 'A/', JSON.stringify(g.opts) + g.selVal);
      ok('three filter buttons in the bar: 全部, 已選, 未選', JSON.stringify(g.filters.map(f => f.k)) === '["all","selected","unselected"]', JSON.stringify(g.filters));
      ok('the filter bar lives in the guest bar, not a sidebar', await page.evaluate(() => !!document.querySelector('#guestBar #pickFilterBar')));
      ok('targets >= 44px: select and every filter button', g.sel.h >= 44 && g.filters.every(f => f.h >= 44 && f.w >= 44), JSON.stringify([g.sel.h, g.filters.map(f => [f.w, f.h])]));
      ok('no horizontal page scroll', g.scrollW <= g.vw && g.bodyScrollW <= g.vw, `${g.scrollW}/${g.bodyScrollW}/${g.vw}`);
      ok('the bar is not more than a third of the screen', g.bar.h <= 844 / 3, String(g.bar.h));

      // ── sticky: scroll the grid, the bar stays under the header
      await page.evaluate(() => { document.querySelector('.content').scrollTop = 600; });
      await page.waitForTimeout(100);
      const stuck = await page.evaluate(() => ({
        top: document.getElementById('guestBar').getBoundingClientRect().top,
        hb: document.querySelector('.header').getBoundingClientRect().bottom,
        st: document.querySelector('.content').scrollTop,
      }));
      ok('after scrolling the grid the bar is still right under the header', stuck.st > 100 && Math.abs(stuck.top - stuck.hb) <= 1.5, JSON.stringify(stuck));
      await page.evaluate(() => { document.querySelector('.content').scrollTop = 0; });

      // ── bottom bar: visible, not overlapped, nothing else on top of it
      const bb = await page.evaluate(() => {
        const bar = document.getElementById('mobileActionBar');
        const b = bar.getBoundingClientRect();
        const hit = (x, y) => document.elementFromPoint(x, y);
        const btn = document.getElementById('pickSubmitBtn').getBoundingClientRect();
        return {
          disp: getComputedStyle(bar).display, t: b.top, b: b.bottom, vh: innerHeight,
          hitCounter: !!hit(b.left + 20, (b.top + b.bottom) / 2)?.closest('#mobileActionBar'),
          hitBtn: hit((btn.left + btn.right) / 2, (btn.top + btn.bottom) / 2)?.closest('#pickSubmitBtn') !== null,
          btnH: btn.height,
          guestBottom: document.getElementById('guestBar').getBoundingClientRect().bottom,
          counter: document.getElementById('pickCounter')?.textContent,
        };
      });
      ok('bottom bar is displayed and sits inside the viewport', bb.disp !== 'none' && bb.b <= bb.vh + 0.5 && bb.t > 0, JSON.stringify(bb));
      ok('nothing overlaps it: hit-testing its counter and its button lands on the bar', bb.hitCounter && bb.hitBtn);
      ok('the guest bar ends above the bottom bar', bb.guestBottom < bb.t);
      ok('bottom bar shows 已選 N / limit 張 and the submit is >= 44 tall', bb.counter === '已選 1 / 5 張' && bb.btnH >= 44, JSON.stringify(bb));

      // ── exactly one submit-style button
      const submits = await page.evaluate(() => [...document.querySelectorAll('button, a')]
        .filter(e => /完成挑圖|完成提交/.test(e.textContent)).map(e => e.id));
      ok('exactly one 完成挑圖/完成提交 element, and it is #pickSubmitBtn', JSON.stringify(submits) === '["pickSubmitBtn"]', JSON.stringify(submits));
      ok('no 預約拍攝 text anywhere', !(await page.evaluate(() => document.body.innerText.includes('預約拍攝'))));

      // ── avatar
      const av = await page.evaluate(() => {
        const a = document.getElementById('userAvatarStudio');
        return { text: a.textContent.trim(), svg: !!a.querySelector('svg'), label: a.getAttribute('aria-label'), tag: a.tagName,
          pe: getComputedStyle(a).pointerEvents, hasHC: document.body.innerText.includes('HC') };
      });
      ok('avatar is an SVG person icon labelled 訪客, not 「HC」, not interactive',
        av.svg && av.text === '' && av.label === '訪客' && av.tag === 'DIV' && av.pe === 'none' && !av.hasHC, JSON.stringify(av));

      // ── brand: studio name fully visible
      const br = await page.evaluate(() => {
        const n = document.querySelector('.logo-name');
        const b = n.getBoundingClientRect();
        return { text: n.textContent, sw: n.scrollWidth, cw: n.clientWidth, r: b.right, vw: innerWidth,
          img: !!document.querySelector('.logo-mark-img'), av: document.querySelector('.header-right').getBoundingClientRect().left };
      });
      ok('studio name is fully visible (scrollWidth <= clientWidth) with its logo', br.text === '海邊影像工作' && br.sw <= br.cw && br.cw > 60 && br.img, JSON.stringify(br));
      ok('and does not run under the right-hand header group (the avatar is hidden on a guest page)', br.r <= br.av, JSON.stringify(br));

      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pick-390.png` });
      // ── folder selector switches the grid
      await page.selectOption('#guestFolderSelect', 'B/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('selecting B/ shows B’s photos', JSON.stringify(await guiIds(page)) === '["B/b0.jpg","B/b1.jpg"]', JSON.stringify(await guiIds(page)));
      ok('and the select shows B/', (await page.$eval('#guestFolderSelect', s => s.value)) === 'B/');
      await page.selectOption('#guestFolderSelect', 'A/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('A/'), null, { timeout: 5000 });

      // ── filter 已選 + live count
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('已選 shows only the ♥ photo', JSON.stringify(await guiIds(page)) === '["A/a01.jpg"]', JSON.stringify(await guiIds(page)));
      ok('the count in the button reads 1', (await page.textContent('#pickFilterSelectedCount')) === '1');
      await page.click('#guestBar [data-pick-filter="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 30, null, { timeout: 3000 });
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickFilterSelectedCount').textContent === '2', null, { timeout: 3000 });
      ok('♥ on a photo raises the live count to 2', true);
      ok('and the bottom counter follows', (await page.textContent('#pickCounter')) === '已選 2 / 5 張');
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickFilterSelectedCount').textContent === '1' && document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('un-♥ inside 已選 drops the card and the count to 1', true);
      await page.click('#guestBar [data-pick-filter="unselected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 29, null, { timeout: 3000 });
      ok('未選 hides the picked photo (29 of 30 left)', true);
      await page.click('#guestBar [data-pick-filter="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 30, null, { timeout: 3000 });

      // ── preview modal covers both bars
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const cover = await page.evaluate(() => {
        const inModal = (x, y) => !!document.elementFromPoint(x, y)?.closest('#photoModal');
        const g = document.getElementById('guestBar').getBoundingClientRect();
        const b = document.getElementById('mobileActionBar').getBoundingClientRect();
        // the orange toggle is gone for guests (it covered the ♥); the labelled 備註・標示 replaces it
        const gone = !document.getElementById('mobileToolsToggle');
        const t = document.getElementById('pickPanelBtn').getBoundingClientRect();
        return { gone, guest: inModal(g.left + g.width / 2, g.top + 10), bottom: inModal(b.left + 30, (b.top + b.bottom) / 2),
          toggle: { t: t.top, b: t.bottom, l: t.left, r: t.right, disp: getComputedStyle(document.getElementById('pickPanelBtn')).display },
          guestB: g.bottom };
      });
      ok('the preview modal is on top of the guest bar', cover.guest, JSON.stringify(cover));
      ok('and on top of the bottom bar', cover.bottom, JSON.stringify(cover));
      ok('the orange toggle is gone for a guest; 備註・標示 is shown instead', cover.gone && cover.toggle.disp !== 'none', JSON.stringify(cover));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('photoModal').classList.contains('active'), null, { timeout: 3000 });

      // ── submit works from the bottom bar
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      ok('the bottom 完成提交 opens the submit form', true);
      await page.click('#pickSubmitCancelBtn');

      // ── crossing 1024px swaps to the sidebar layout and back, filter keeps working
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction(() => !document.getElementById('guestBar') && !!document.querySelector('aside.sidebar'), null, { timeout: 3000 });
      ok('widening to 1280 removes #guestBar and brings the sidebar back with the filter inside',
        await page.evaluate(() => !!document.querySelector('aside.sidebar #pickFilterBar') && !!document.querySelector('aside.sidebar #folderTree .tree-row')));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !!document.getElementById('guestBar') && !document.querySelector('aside.sidebar'), null, { timeout: 3000 });
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('back at 390 the bar returns and its filter still works (listeners survived the move)', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS,
    pickLimit: 5, title: GUI_TITLE, studio: GUI_STUDIO });
  await suite('guest UI 1280px — owner: sidebar holds only 資料夾 + filter; bottom pill shows 已選 N / limit 張 + 完成提交; submit works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作', null, { timeout: 5000 });
      const gone = ['#sidebarToggle', '#sidebarBackdrop', '#guestBar', '.flags-grid', '[data-annotated]', '#sortBy', '#syncSidebarSection',
        '.star-filter', '#clearFiltersBtn', '#submitJobBtn', '#studioBookingLink', '.logo-label', '#buildVersion', '#headerSortBtn', '#headerViewBtn', '#expiryBadge'];
      const present = await page.evaluate(sels => sels.filter(s => document.querySelector(s)), gone);
      ok('photographer-only elements are null in the DOM', present.length === 0, JSON.stringify(present));
      const sb = await page.evaluate(() => {
        const s = document.querySelector('aside.sidebar');
        return {
          text: s.innerText,
          sections: [...s.querySelectorAll(':scope > .sidebar-section')].map(x => x.id || (x.querySelector('#folderTreeContainer') ? 'folders' : '?')),
          filterIn: !!s.querySelector('#pickFilterBar'), rows: s.querySelectorAll('#folderTree .tree-row').length,
          titles: s.querySelectorAll('.side-title').length,
        };
      });
      ok('the sidebar has exactly two sections: folders + filter', JSON.stringify(sb.sections) === '["folders","pickFilterSection"]', JSON.stringify(sb.sections));
      ok('and says 資料夾, no RATING/FLAGS/ANNOTATION/DATA/SOURCE',
        sb.text.includes('資料夾') && !/RATING|FLAGS|ANNOTATION|DATA|SOURCE|排序/.test(sb.text) && sb.titles === 0, sb.text);
      ok('the filter is in the sidebar, folder rows are listed', sb.filterIn && sb.rows === 2, JSON.stringify(sb));
      ok('desktop brand: the studio name is fully visible too',
        await page.evaluate(() => { const n = document.querySelector('.logo-name'); return n.textContent === '海邊影像工作' && n.scrollWidth <= n.clientWidth; }));
      ok('project title in the header breadcrumbs (plain text)',
        (await page.textContent('#headerBreadcrumbs')) === GUI_TITLE && (await page.$('#headerBreadcrumbs b')) === null);
      const bar = await page.evaluate(() => {
        const b = document.getElementById('mobileActionBar').getBoundingClientRect();
        const btn = document.getElementById('pickSubmitBtn');
        const c = document.getElementById('pickCounter').getBoundingClientRect();
        const bb = btn.getBoundingClientRect();
        return { disp: getComputedStyle(document.getElementById('mobileActionBar')).display, t: b.top, b: b.bottom, l: b.left, r: b.right, vw: innerWidth, vh: innerHeight,
          btnShown: getComputedStyle(btn).display !== 'none' && btn.getClientRects().length > 0, btn: [bb.left, bb.right, bb.top], counter: [c.left, c.right, c.bottom],
          text: document.getElementById('pickCounter').textContent,
          hit: document.elementFromPoint((bb.left + bb.right) / 2, (bb.top + bb.bottom) / 2)?.closest('#pickSubmitBtn') !== null };
      });
      ok('bottom pill is shown with 已選 N / limit 張 next to a visible 完成提交, inside the viewport',
        bar.disp === 'flex' && bar.btnShown && bar.text === '已選 0 / 5 張' && bar.b <= bar.vh && bar.r <= bar.vw && bar.counter[2] <= bar.btn[2] + 1, JSON.stringify(bar)); // stacked pill: counter above the button (see 54-desktop-pick-bar)
      ok('the button is really clickable there (hit-test)', bar.hit);
      const submits = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter(e => /完成挑圖|完成提交/.test(e.textContent)).map(e => e.id));
      ok('exactly one submit element: #pickSubmitBtn', JSON.stringify(submits) === '["pickSubmitBtn"]', JSON.stringify(submits));
      ok('avatar is the person icon', await page.evaluate(() => {
        const a = document.getElementById('userAvatarStudio');
        return !!a.querySelector('svg') && a.getAttribute('aria-label') === '訪客' && a.textContent.trim() === '';
      }));
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pick-1280.png` });
      await page.click('#folderTree .tree-row[data-folder="B/"]');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('a sidebar folder row still switches the grid', true);
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      ok('完成提交 opens the submit form on desktop', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', photosByFolder: GUI_PHOTOS, folders: ['A/'],
    studio: { name: '海邊影像工作室海邊影像工作室海邊影像工作室海邊影像工作室', has_logo: false } });
  await suite('guest UI 390px — a very long studio name is ellipsized inside the header, never pushing the avatar out',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent.length > 20, null, { timeout: 5000 });
      const r = await page.evaluate(() => {
        const n = document.querySelector('.logo-name').getBoundingClientRect();
        const hl = document.querySelector('.header-left').getBoundingClientRect();
        const av = document.querySelector('.header-right').getBoundingClientRect();
        return { nr: n.right, hl: hl.right, al: av.left, ar: av.right, vw: innerWidth, sw: document.documentElement.scrollWidth };
      });
      return [r.nr <= r.hl + 0.5 && r.hl <= r.al + 0.5 && r.ar <= r.vw && r.sw <= r.vw ? 'ok    long name stays inside the header, header-right group on screen (the avatar itself is hidden)' : 'FAIL  ' + JSON.stringify(r)];
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS, title: 'V 專案' });
  await suite('guest UI 390px — viewer: folder selector and filter, no submit, no ♥ to click',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('#guestBar shows with the title', await guiVisible(page, '#guestBar') && (await page.textContent('#guestBarTitle')) === 'V 專案');
      ok('a folder selector', (await page.$$eval('#guestFolderSelect option', os => os.length)) === 2);
      ok('the filter is there too (a viewer can filter today)', (await page.$$eval('#guestBar [data-pick-filter]', bs => bs.length)) === 3);
      ok('no submit button is displayed and no header 完成挑圖', !(await guiVisible(page, '#pickSubmitBtn')) && (await page.$('#submitJobBtn')) === null);
      ok('no clickable ♥', (await page.$$('.photo-card button.pick-heart-btn')).length === 0);
      await page.selectOption('#guestFolderSelect', 'B/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('the selector switches the grid for a viewer', true);
      ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE });
}

for (const [label, co, proofs] of [['390px', MOBILE, false], ['390px + proofs switch', MOBILE, true], ['1280px', { viewport: { width: 1280, height: 900 } }, false]]) {
  const FILES = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg', 'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg'];
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: FILES, allowProofDownload: proofs, title: 'D 專案' });
  // REWRITTEN with the finals gallery (docs/delivery.md "web album"): the finals view no longer has
  // the #guestBar folder <select> or the sidebar tree — its folders are chips under the hero; the
  // proofs view (下載毛片原檔) is untouched and keeps asserting the old selector / tree.
  await suite(`guest UI delivered ${label} — folder chips only: no filter, no ♥, no submit, no counter`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const narrow = label.startsWith('390');
      const tiles = () => page.$$eval('.fg-tile', ts => ts.map(t => t.dataset.photoId));
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      ok('the finals view has no #guestBar / folder <select> and no sidebar on screen: its folders are chips',
        !(await guiVisible(page, '#guestBar')) && !(await guiVisible(page, '#guestFolderSelect')) && !(await guiVisible(page, 'aside.sidebar')) && (await page.$$('#fgChips .fg-chip')).length > 0);
      const chips = await page.$$eval('#fgChips .fg-chip', cs => cs.map(c => [c.dataset.folder, c.getAttribute('aria-pressed')]));
      ok('the chips are the finals folder (pressed) and its subfolder', JSON.stringify(chips) === '[["shoot/精修/","true"],["shoot/精修/sub/","false"]]', JSON.stringify(chips));
      ok('the finals folder shows its own photos', JSON.stringify(await tiles()) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]', JSON.stringify(await tiles()));
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/sub/"]');
      await page.waitForFunction(() => document.querySelector('.fg-tile')?.dataset.photoId.includes('sub/'), null, { timeout: 5000 });
      ok('pressing the subfolder chip switches the gallery', JSON.stringify(await tiles()) === '["shoot/精修/sub/f3.jpg"]', JSON.stringify(await tiles()));
      ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/"]');
      await page.waitForFunction(() => document.querySelectorAll('.fg-tile').length === 2, null, { timeout: 5000 });
      if (process.env.SHOTS && label === '390px') await page.screenshot({ path: `${process.env.SHOTS}/delivered-390.png` });
      ok('the filter bar and its section are removed from the DOM (not hidden)',
        (await page.$('#pickFilterBar')) === null && (await page.$('[data-pick-filter]')) === null && (await page.$('#pickFilterSection')) === null);
      ok('no ♥, no submit (either), no counter, no bottom bar',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null && (await page.$('#pickSubmitBtn')) === null &&
        (await page.$('#pickCounter')) === null && (await page.$('#mobileActionBar')) === null);
      if (proofs) {
        ok('下載毛片原檔 entry still there', (await page.textContent('#deliveryProofsBtn')) === '下載毛片原檔');
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
        ok('it switches to the proofs (old card list); still no filter', (await page.$('#pickFilterBar')) === null && JSON.stringify(await guiIds(page)) === '["shoot/毛片/a.jpg","shoot/毛片/b.jpg"]');
        ok('the gallery is gone from the DOM in the proofs list', (await page.$('#finalsGallery')) === null && (await page.$('.fg-tile')) === null);
        if (narrow) ok('the folder <select> is back for the proofs list and lists the proofs folder', await page.$$eval('#guestFolderSelect option', os => os.map(o => o.value).includes('shoot/毛片/')));
        else ok('the sidebar tree is back for the proofs list', await page.evaluate(() => !!document.querySelector('aside.sidebar #folderTree .tree-row') && !document.querySelector('aside.sidebar .pick-filter-bar') && !document.getElementById('pickFilterSection')));
        ok('← 回精修成品 comes back', (await page.textContent('#deliveryProofsBtn')) === '← 回精修成品');
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.querySelector('.fg-tile')?.dataset.photoId.includes('精修'), null, { timeout: 5000 });
        ok('the finals gallery is back', (await tiles()).every(k => k.includes('精修')) && (await page.$('.photo-card')) === null);
      }
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

for (const [label, co] of [['1500px', undefined], ['390px', MOBILE]]) {
  await suite(`photographer's own index.html (no ?t=) ${label} — every tool, 完成挑圖 and ☰ are still there`,
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.sidebar', { state: 'attached', timeout: 5000 });
      const r = await page.evaluate(() => {
        const q = s => document.querySelector(s);
        return {
          rating: !!q('.star-filter') && !!q('#clearFiltersBtn') && !!q('#filterSelectedBtn'),
          flags: !!q('.flags-grid'), annot: !!q('[data-annotated]') && !!q('#sortBy'), data: !!q('#syncSidebarSection') && !!q('#backupDataBtn'),
          source: !!q('#driveUrl') && !!q('#loadPhotosBtn'), submit: !!q('#submitJobBtn'), toggle: !!q('#sidebarToggle'),
          toggleShown: getComputedStyle(q('#sidebarToggle')).display !== 'none', backdrop: !!q('#sidebarBackdrop'),
          guestBar: !!q('#guestBar'), filterBarHidden: q('#pickFilterBar').hidden === true,
          avatar: q('#userAvatarStudio').textContent.trim(), avatarSvg: !!q('#userAvatarStudio svg'),
          label: !!q('.logo-label'), booking: !!q('#studioBookingLink'), pill: !!q('#headerSortBtn'),
          pickActive: document.body.classList.contains('pick-active'),
          sections: document.querySelectorAll('.sidebar > .sidebar-section').length,
        };
      });
      ok('RATING / FLAGS / ANNOTATION+排序 / DATA / SOURCE all present', r.rating && r.flags && r.annot && r.data && r.source && r.sections === 6, JSON.stringify(r));   // 5 tools + the phone menu (選單, hidden above 768px)
      ok('header 完成挑圖 button present', r.submit);
      ok('☰ and backdrop present; ☰ shown only on a phone', r.toggle && r.backdrop && r.toggleShown === (label === '390px'), JSON.stringify(r));
      ok('no guest bar, ♥ filter still hidden, no pick-active', !r.guestBar && r.filterBarHidden && !r.pickActive);
      ok('avatar still says HC', r.avatar === 'HC' && !r.avatarSvg, r.avatar);
      ok('logo label, 預約 link and header pills are untouched', r.label && r.booking && r.pill);
      if (label === '390px') {
        const open = () => page.evaluate(() => document.querySelector('.sidebar').classList.contains('active') && document.getElementById('sidebarBackdrop').classList.contains('active'));
        // an empty photographer page on a phone opens the drawer by itself, once (js/app.js autoOpenSidebarOnPhone)
        ok('(empty page on a phone: the drawer is already open)', await open());
        await page.evaluate(() => document.getElementById('sidebarToggle').click());
        ok('☰ closes the drawer', !(await open()));
        await page.evaluate(() => document.getElementById('sidebarToggle').click());
        ok('☰ opens the drawer', await open());
      }
      return out;
    },
    { before: mockWorker(3), initScript: () => { sessionStorage.setItem('studio_token', 'x'); try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {} },
      contextOptions: co });
}
}
