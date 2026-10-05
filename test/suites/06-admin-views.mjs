// Browser suites: revoke-all, admin tabs and hash routing, asset versions, sign-out, multi-folder
// client view, bucket folder picker.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { base, stats, suite } from '../lib/harness.mjs';
import { ROOT } from '../lib/env.mjs';
import { ADMIN, adminMock, clientMock, shareMock } from '../lib/auth-mocks.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';

export default async function register() {

const revokeCalls = m => m.seen.filter(r =>
  r.method === 'POST' && r.path === '/api/shares/minted/revoke-all');

{
  const m = adminMock();
  await suite('revoke all — the control is on the settings page, reads the live tokens, and warns before firing',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(400);

      const listed = m.seen.filter(r => r.method === 'GET' && r.path === '/api/shares/minted');
      ok('the live minted tokens were fetched', listed.length >= 1,
        JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('with the real credential in a header', listed[0]?.auth === 'Bearer adm', JSON.stringify(listed[0]));

      const summary = await page.evaluate(() => document.getElementById('minted-summary')?.textContent || '');
      ok('the panel counts what is live, split by whose it is',
        /3/.test(summary) && /攝影師 2/.test(summary) && /客戶 1/.test(summary), summary);
      const panel = await page.evaluate(() => document.getElementById('minted-panel')?.textContent || '');
      ok('and says album links already sent to clients survive this',
        panel.includes('分享連結') && panel.includes('不會'), panel);
      // revoking without rotating is undone by the next page load that still
      // has the old password, so the order matters and the page has to say so
      ok('and that the password itself has to be changed first',
        panel.includes('PHOTOGRAPHER_TOKEN') && panel.includes('先改密碼'), panel);

      await page.click('#revoke-all-btn');
      await page.waitForTimeout(400);
      ok('clicking it asks for confirmation first', dialogs.length === 1, JSON.stringify(dialogs));
      ok('the confirmation spells out what survives',
        (dialogs[0] || '').includes('分享連結'), dialogs[0]);
      ok('and warns that the password has to go first',
        (dialogs[0] || '').includes('先換掉攝影師密碼'), dialogs[0]);
      ok('and dismissing it fires nothing at the Worker', revokeCalls(m).length === 0,
        JSON.stringify(revokeCalls(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // deliberately not the number of rows the listing returned, so "已撤銷 3"
  // cannot be read off the summary that is already on the page
  const m = adminMock({ revoked: 7 });
  await suite('revoke all — confirming it kills the minted tokens and says how many',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => d.accept());

      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(400);
      await page.click('#revoke-all-btn');
      await page.waitForTimeout(600);

      const posts = revokeCalls(m);
      ok('exactly one revoke-all reached the Worker', posts.length === 1, JSON.stringify(m.seen));
      ok('and it carried the real credential, not a minted token',
        posts[0]?.auth === 'Bearer adm', JSON.stringify(posts[0]));
      const result = await page.evaluate(() => document.getElementById('revoke-result')?.textContent || '');
      ok('the count the Worker returned is reported back, not the one already on screen',
        result.includes('7'), result);
      ok('and the photographer is told it is done', /已撤銷|已登出/.test(result), result);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// admin.html is two screens chosen by the hash (#projects | #project=<id> |
// #clients; anything else = projects). 登入中的裝置 lives on settings.html.
// ═══════════════════════════════════════════════════════════════════════════

const VIEW_STATE = () => {
  const disp = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'ABSENT'; };
  return {
    projects: disp('#view-projects'), clients: disp('#view-clients'),
    create: disp('#project-create-panel'), table: disp('#clients-table'),
    sub: document.querySelector('header .subtitle')?.textContent.trim(),
    title: document.title,
    active: [...document.querySelectorAll('.side-nav-item.active')].map(e => e.textContent.trim()),
    clientsHref: document.querySelector('.side-nav-item[data-nav="clients"]')?.getAttribute('href'),
    // The rendered box, not just the style: a display:none ancestor has no size.
    createBox: !!document.querySelector('#project-create-panel')?.getClientRects().length,
    tableBox: !!document.querySelector('#clients-table')?.getClientRects().length,
  };
};

for (const [hash, want] of [
  ['', 'projects'], ['#projects', 'projects'], ['#nonsense', 'projects'], ['#clients', 'clients'],
]) {
  const m = adminMock();
  await suite(`admin 分頁 — ${hash || '(no hash)'} shows only the ${want} block, with its own subtitle/title/menu highlight`,
    `${base}/admin.html${hash}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      const v = await page.evaluate(VIEW_STATE);
      const label = want === 'projects' ? '選片專案' : '客戶';
      const other = want === 'projects' ? 'clients' : 'projects';
      ok(`the ${want} section is displayed`, v[want] === 'block', JSON.stringify(v));
      ok(`the ${other} section is display:none (computed)`, v[other] === 'none', JSON.stringify(v));
      if (want === 'projects') {
        ok('the create form has a rendered box', v.createBox, JSON.stringify(v));
        ok('the clients table has no box', !v.tableBox, JSON.stringify(v));
      } else {
        ok('the clients table has a rendered box', v.tableBox, JSON.stringify(v));
        ok('the project form has no box', !v.createBox, JSON.stringify(v));
      }
      ok('subtitle', v.sub === label, v.sub);
      ok('<title>', v.title.includes(label) && !v.title.includes('客戶管理'), v.title);
      ok('exactly the matching menu item is highlighted', JSON.stringify(v.active) === JSON.stringify([label]), JSON.stringify(v.active));
      ok('the side menu 客戶 link is admin.html#clients', v.clientsHref === 'admin.html#clients', v.clientsHref);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('admin 分頁 — hashchange switches views without a reload, and data loads only when shown',
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__noReload = true; });
      ok('the clients list was NOT fetched while it was hidden',
        !m.seen.some(r => r.path === '/api/admin/clients' && r.method === 'GET' && r.auth === 'Bearer adm'),
        JSON.stringify(m.seen.map(r => r.path)));
      await page.click('.side-nav-item[data-nav="clients"]');
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '客戶', null, { timeout: 3000 });
      let v = await page.evaluate(VIEW_STATE);
      ok('clicking 客戶 in the menu shows clients only', v.clients === 'block' && v.projects === 'none', JSON.stringify(v));
      ok('and highlights 客戶 only', JSON.stringify(v.active) === '["客戶"]', JSON.stringify(v.active));
      ok('and retitles', v.title.includes('客戶') && !v.title.includes('選片專案'), v.title);
      ok('without reloading the page', await page.evaluate(() => window.__noReload === true));
      ok('the clients list is fetched once shown', m.seen.some(r => r.path === '/api/admin/clients' && r.auth === 'Bearer adm'));
      await page.click('.side-nav-item[data-nav="projects"]');
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '選片專案', null, { timeout: 3000 });
      v = await page.evaluate(VIEW_STATE);
      ok('clicking 選片專案 comes back to projects only', v.projects === 'block' && v.clients === 'none' && JSON.stringify(v.active) === '["選片專案"]', JSON.stringify(v));
      await page.evaluate(() => { location.hash = '#clients'; });
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '客戶', null, { timeout: 3000 });
      ok('a plain location.hash change switches too', (await page.evaluate(VIEW_STATE)).clients === 'block');
      ok('still the same document', await page.evaluate(() => window.__noReload === true));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('admin 分頁 — #project=<id> opens that detail inside the projects view, 選片專案 highlighted',
    `${base}/admin.html#project=proj-9`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(500);
      const v = await page.evaluate(VIEW_STATE);
      ok('projects view shown, clients hidden', v.projects === 'block' && v.clients === 'none', JSON.stringify(v));
      ok('選片專案 is the highlighted item', JSON.stringify(v.active) === '["選片專案"]', JSON.stringify(v.active));
      ok('subtitle 選片專案', v.sub === '選片專案', v.sub);
      ok('that project was requested', m.seen.some(r => r.path === '/api/admin/projects/proj-9'), JSON.stringify(m.seen.map(r => r.path)));
      const detail = await page.evaluate(() => {
        const p = document.getElementById('project-detail-panel');
        return { disp: getComputedStyle(p).display, inProjects: !!p.closest('#view-projects') };
      });
      ok('the detail panel is displayed, inside the projects section', detail.disp === 'block' && detail.inProjects, JSON.stringify(detail));
      await page.click('.side-nav-item[data-nav="projects"]');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('project-detail-panel')).display === 'none', null, { timeout: 3000 });
      ok('clicking 選片專案 in the menu closes the detail back to the list', true);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('登入中的裝置 — is gone from admin.html (both views)',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      for (const h of ['#projects', '#clients']) {
        await page.evaluate(x => { location.hash = x; }, h);
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => ({
          btn: !!document.getElementById('revoke-all-btn'), panel: !!document.getElementById('minted-panel'),
          text: document.body.textContent.includes('登入中的裝置'),
        }));
        ok(`${h}: no revoke button / panel / heading`, !r.btn && !r.panel && !r.text, JSON.stringify(r));
      }
      ok('and admin.html never asked for the minted list', !m.seen.some(r => r.path.startsWith('/api/shares/minted')), JSON.stringify(m.seen.map(r => r.path)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('登入中的裝置 — settings.html shows it as its own section, visible',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        disp: getComputedStyle(document.getElementById('revoke-all-btn')).display,
        box: document.getElementById('revoke-all-btn').getClientRects().length,
        heading: [...document.querySelectorAll('main h2')].map(h => h.textContent.trim()),
        inPanel: !!document.getElementById('revoke-all-btn').closest('#minted-panel'),
        summary: document.getElementById('minted-summary').textContent,
      }));
      ok('button visible', r.disp !== 'none' && r.box > 0, JSON.stringify(r));
      ok('own section heading 登入中的裝置', r.heading.includes('登入中的裝置') && r.inPanel, JSON.stringify(r.heading));
      ok('summary loaded from the Worker', /攝影師 2/.test(r.summary) && /客戶 1/.test(r.summary), r.summary);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
let failed = 0;   // the asset-versions block below counts into this; folded into the run total after it

// A changed script served under an unchanged ?v= leaves returning browsers on
// the old code, which has bitten this project before. The number itself is not
// pinned here — what is checked is that nothing was left behind when it moved.
{
  console.log('\n# asset versions — every local asset on a page moves together');
  const PAGES = ['index.html', 'upload.html', 'tutorial.html', 'admin.html', 'client-login.html',
                 'home.html', 'dashboard.html', 'settings.html', 'orders.html', 'operator.html',
                 'book_editor/index.html', 'book_editor/view.html', 'r2_designer/index.html'];
  const lines = [];
  const seenVersions = new Set();
  for (const rel of PAGES) {
    const html = await readFile(join(ROOT, rel), 'utf8');
    const local = [...html.matchAll(/(?:src|href)="((?!https?:|\/\/|data:)[^"]*\.(?:js|css)[^"]*)"/g)]
      .map(m => m[1]);
    const missing = local.filter(u => !/[?&]v=/.test(u));
    const versions = [...new Set(local.map(u => (/[?&]v=([^&"]+)/.exec(u) || [])[1]).filter(Boolean))];
    versions.forEach(v => seenVersions.add(v));
    const good = local.length > 0 && missing.length === 0 && versions.length === 1;
    lines.push(`${good ? 'ok  ' : 'FAIL'}  ${rel} — ${versions.join(',') || '(none)'}` +
      (good ? '' : `   [unversioned ${JSON.stringify(missing)}]`));
  }
  lines.push(seenVersions.size === 1
    ? `ok    every page is on the same version (${[...seenVersions][0]})`
    : `FAIL  pages disagree on the version   [${[...seenVersions].join(', ')}]`);
  for (const l of lines) { if (l.startsWith('FAIL')) failed++; console.log('  ' + l); }
}
stats.failed += failed;

await suite('studio token — the book list thumbnails carry it too',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      // a saved book with a cover photo is what puts an <img> in this modal
      bookEditor._getBooksList = () => ([{
        id: 'b-cover', name: 'T', status: 'draft', pages: 4,
        coverPhotoId: '20260819/p0.jpg', clientFolder: '20260819/',
        updatedAt: '2026-09-22',
      }]);
      await window.StudioToken.ensure();
      bookEditor._renderBooksModalList();
      await new Promise(r => setTimeout(r, 200));
      const img = document.querySelector('#booksModalList img');
      return { src: img ? img.src : null, token: CONFIG.SHARE_TOKEN || '' };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('the cover thumbnail is rendered at all', !!r.src, String(r.src));
    ok('a studio token is in hand', r.token.length > 0, String(r.token.length));
    // the one the six other builders were routed through; this one was missed
    ok('and the thumbnail carries it, like every other <img> on the page',
      !!r.src && r.src.includes(`t=${encodeURIComponent(r.token)}`), String(r.src));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: shareMock().attach,
  });

await suite('a client is not shown the photographer\u2019s pages at all',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!document.getElementById('client-bar'), null, { timeout: 5000 });
    const r = await page.evaluate(() => {
      // Three ways this assertion has already passed for the wrong reason:
      // `!== 'shown'` passed when the id was missing, a computed display check
      // passed because the harness hides these anyway, and a `hidden`
      // attribute check passed while .btn's display:inline-flex kept them on
      // screen. Gone from the DOM is the only state none of those reach.
      const vis = id => document.getElementById(id) ? 'shown' : 'gone';
      return {
        upload: vis('uploadPageBtn'),
        book: vis('openBookEditorBtn'),
        // the red "no permission" labels are redundant once the buttons are gone
        bar: document.getElementById('client-bar').textContent,
      };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // clicking these asked a client for the photographer's password
    // 'gone' would pass a looser check while meaning the id was wrong
    ok('the upload button is not in the page for a client', r.upload === 'gone', r.upload);
    ok('nor is the album editor', r.book === 'gone', r.book);
    ok('and the bar does not explain a button that is gone',
      !r.bar.includes('\u7121\u6b0a\u9650'), r.bar.trim().slice(0, 60));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('client_session', JSON.stringify({
        token: 'CS', user: { name: 'A', email: 'a@b.c', folder_path: '20260819/' },
        permissions: { can_book: 0, can_upload: 0 },
      }));
    },
    before: shareMock().attach,
  });

await suite('the photographer still gets those buttons',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    const r = await page.evaluate(() => ({
      upload: !!document.getElementById('uploadPageBtn'),
      book: !!document.getElementById('openBookEditorBtn'),
      clientBar: !!document.getElementById('client-bar'),
    }));
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // without this, a typo in either id would remove nothing and the client
    // suite would still read 'gone'
    ok('the upload button is there for the photographer', r.upload === true, String(r.upload));
    ok('and so is the album editor', r.book === true, String(r.book));
    ok('and no client bar is shown', r.clientBar === false, String(r.clientBar));
    return out;
  },
  {
    initScript: () => sessionStorage.setItem('studio_token', 'adm'),
    before: shareMock().attach,
  });

await suite('a share link cannot be issued for folders nobody opened',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      bookEditor.book.clientFolders = [];
      let minted = false;
      bookEditor._mintShareToken = async () => { minted = true; return 'TOK'; };
      let told = '';
      const origToast = window.toast;
      window.toast = { error: m => { told = String(m); }, success: () => {}, info: () => {} };
      try { await bookEditor.saveToCloud(); } catch (e) { told = told || String(e.message || e); }
      window.toast = origToast;
      return { minted, told };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // a link with an empty snapshot opens the album and not one photo, and
    // neither side is told why
    ok('no token is minted for an empty folder set', r.minted === false, String(r.minted));
    ok('and the photographer is told to pick folders first',
      /\u8cc7\u6599\u593e/.test(r.told), JSON.stringify(r.told));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: shareMock().attach,
  });

await suite('the photographer can sign out of this browser',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!document.getElementById('studio-logout'),
      null, { timeout: 5000 }).catch(() => {});
    const present = await page.evaluate(() => !!document.getElementById('studio-logout'));
    const inTopBar = await page.evaluate(() =>
      !!document.querySelector('.header-right #studio-logout'));

    // the handler reloads; location.reload cannot be stubbed, so follow it
    // through and assert on the page that comes back
    // click without awaiting the evaluate: the navigation tears the context
    // down before it can resolve, which is a throw, not a failure
    page.evaluate(() => document.getElementById('studio-logout')?.click()).catch(() => {});
    await page.waitForFunction(() => !sessionStorage.getItem('studio_token'),
      null, { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('load');
    const after = await page.evaluate(() => ({
      cleared: !sessionStorage.getItem('studio_token'),
      token: (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || '',
      logoutGone: !document.getElementById('studio-logout'),
    }));

    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('there is a sign-out control', present === true, String(present));
    // it first landed in .header-actions, the download row above the grid,
    // where it was present, passing, and invisible to the person using it
    ok('and it sits in the top bar, not among the download buttons',
      inTopBar === true, String(inTopBar));
    ok('it forgets the stored credential', after.cleared === true, String(after.cleared));
    ok('the reloaded page holds no token', after.token === '', String(after.token.length));
    ok('and does not offer sign-out to someone already signed out',
      after.logoutGone === true, String(after.logoutGone));
    return out;
  },
  {
    // addInitScript runs on EVERY navigation, so seeding unconditionally would
    // put the token back after the reload and quietly un-test the logout
    initScript: () => {
      try {
        if (!localStorage.getItem('__seeded_studio')) {
          localStorage.setItem('__seeded_studio', '1');
          sessionStorage.setItem('studio_token', 'adm');
        }
      } catch (e) { /* private mode */ }
    },
    before: shareMock().attach,
  });

// A token opening several folders that shows only the first is worse than one
// that shows none: the client has no way to know the rest exist. The switcher
// now lives in the left 資料夾 panel, not a bottom-bar chip row, and the old
// path box + LOAD button are gone outright.
await suite('multi-folder — a client sees every folder their token opens, in the left panel',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(
      () => document.querySelectorAll('#folderTree .tree-row').length > 0,
      null, { timeout: 6000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      inputGone: document.getElementById('driveUrl') === null,
      loadBtnGone: document.getElementById('loadPhotosBtn') === null,
      bottomChips: document.querySelectorAll('#client-scope [data-folder]').length,
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      landed: (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_FOLDER) || '',
      cards: document.querySelectorAll('.photo-card').length,
    }));
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('the old path input is gone from the DOM entirely', r.inputGone === true);
    ok('and so is the LOAD button', r.loadBtnGone === true);
    ok('no bottom-bar chips are left behind', r.bottomChips === 0, String(r.bottomChips));
    ok('both folders are listed in the left panel, not just the first',
      JSON.stringify(r.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r.rows));
    ok('the first is where the page lands', r.landed === '20260819/', JSON.stringify(r.landed));
    ok('and it is the one highlighted',
      JSON.stringify(r.activeRows) === JSON.stringify(['20260819/']), JSON.stringify(r.activeRows));
    ok('its (distinct) photos actually loaded', r.cards === 3, String(r.cards));

    // switching must actually reload that folder, not just relabel a row
    await page.click('#folderTree .tree-row[data-folder="20260901/"]');
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
      null, { timeout: 5000 });
    const after = await page.evaluate(() => ({
      folder: (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_FOLDER) || '',
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      cardName: document.querySelector('.photo-card .photo-name')?.textContent,
    }));
    ok('picking the second one switches to it and loads its own photos',
      after.folder === '20260901/' && after.cardName === 'r0.jpg', JSON.stringify(after));
    ok('and the highlight follows, off the first',
      JSON.stringify(after.activeRows) === JSON.stringify(['20260901/']), JSON.stringify(after.activeRows));
    ok('the list is repainted, not appended to — still exactly the two folders',
      JSON.stringify(after.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(after.rows));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('client_session', JSON.stringify({
        token: 'sess', user: { name: 'A', email: 'a@b.c' },
        permissions: { can_book: 0, can_upload: 0 },
      }));
    },
    before: clientMock({
      folders: ['20260819/', '20260901/'],
      photosByFolder: {
        '20260819/': PHOTOS(3),
        '20260901/': [{ id: '20260901/r0.jpg', name: 'r0.jpg', size: 9e6, rating: 0 }],
      },
    }).attach,
  });

// docs/backlog.md "Guest page hides subfolders" — the same panel/pattern as
// js/pick.js's own renderFolderPanel, for a signed-in client's token.
await suite('multi-folder — subfolders: a client’s photo-less folder opens its first subfolder automatically, nested in the left panel',
  `${base}/index.html`,
  async page => {
    await page.waitForSelector('.photo-card', { timeout: 6000 });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    const r1 = await page.evaluate(() => ({
      cardNames: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
    }));
    ok('A/ itself has no photos, so the client lands on its first subfolder (A/a/) automatically',
      JSON.stringify(r1.cardNames) === JSON.stringify(['p0.jpg', 'p1.jpg']), JSON.stringify(r1.cardNames));
    ok('the panel lists the folder and every subfolder, nested under it',
      JSON.stringify(r1.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/']), JSON.stringify(r1.rows));
    ok('the subfolder actually opened is the one highlighted',
      JSON.stringify(r1.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r1.activeRows));

    await page.click('#folderTree .tree-row[data-folder="A/b/"]');
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
      null, { timeout: 5000 });
    const r2 = await page.evaluate(() => ({
      cardName: document.querySelector('.photo-card .photo-name')?.textContent,
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
    }));
    ok('clicking the nested subfolder loads its own (different) photos',
      r2.cardName === 'q0.jpg', String(r2.cardName));
    ok('and moves the highlight to it', JSON.stringify(r2.activeRows) === JSON.stringify(['A/b/']), JSON.stringify(r2.activeRows));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('client_session', JSON.stringify({
        token: 'sess', user: { name: 'A', email: 'a@b.c' },
        permissions: { can_book: 0, can_upload: 0 },
      }));
    },
    before: clientMock({
      folders: ['A/'],
      clientFiles: ['A/a/p0.jpg', 'A/a/p1.jpg', 'A/b/q0.jpg'],
    }).attach,
  });

{
  const m = adminMock({ clients: [
    { id: 1, name: 'A', email: 'a@b.c', approved: 1, can_book: 1, can_upload: 0,
      folder_path: '["20260819/"]', folders: ['20260819/'] },
    { id: 2, name: 'B', email: 'b@b.c', approved: 1, can_book: 0, can_upload: 0,
      folder_path: '["oops', folders: null },
  ] });
  await suite('admin — folders are picked from the bucket, not typed',
    `${base}/admin.html#clients`,
    async page => {
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 2,
        null, { timeout: 6000 }).catch(() => {});
      const before = await page.evaluate(() => ({
        chips: [...document.querySelectorAll('tr[data-id="1"] [data-folder-chip]')]
          .map(el => el.dataset.folderChip),
        addBtn: !!document.querySelector('tr[data-id="1"] [data-add-folder]'),
        // folders:null is a broken account only the photographer can repair
        brokenFlagged: !!document.querySelector('tr[data-id="2"] [data-folders-broken]'),
        brokenShowsRaw: (document.querySelector('tr[data-id="2"]')?.textContent || '')
          .includes('["oops'),
      }));
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      ok('the current folders show as a list', JSON.stringify(before.chips) === '["20260819/"]',
        JSON.stringify(before.chips));
      ok('there is a way to add one', before.addBtn === true, String(before.addBtn));
      ok('an unparseable column is flagged, not shown as empty',
        before.brokenFlagged === true, String(before.brokenFlagged));
      ok('and the raw text is there to repair it from',
        before.brokenShowsRaw === true, String(before.brokenShowsRaw));

      // pick a second folder through the browser modal
      const picked = await page.evaluate(async () => {
        document.querySelector('tr[data-id="1"] [data-add-folder]')?.click();
        await new Promise(r => setTimeout(r, 400));
        const opt = [...document.querySelectorAll('[data-pick-folder]')]
          .find(el => el.dataset.pickFolder === '20260901/');
        if (!opt) return { opened: false };
        opt.click();
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-confirm-folders]')?.click();
        await new Promise(r => setTimeout(r, 400));
        return { opened: true };
      });
      ok('the modal lists what is in the bucket', picked.opened === true, String(picked.opened));

      const puts = m.seen.filter(r => r.method === 'PUT' && /permissions$/.test(r.path));
      const last = puts.length ? JSON.parse(puts[puts.length - 1].body || '{}') : null;
      ok('saving sends the set, not a typed string',
        !!last && JSON.stringify(last.folders) === '["20260819/","20260901/"]',
        JSON.stringify(last));
      ok('and does not also send folder_path, which would win a tie the wrong way',
        !!last && last.folder_path === undefined, JSON.stringify(last && last.folder_path));
      return out;
    },
    { initScript: () => sessionStorage.setItem('studio_token', 'adm'), before: m.attach });
}
}
