// Browser suites: the client session token: sign-in mint, unapproved / dead sessions, renewal and
// retry.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, CLIENT, CLIENT_FOLDER, clientMock, studioMock } from '../lib/auth-mocks.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// SESSION TOKEN — the client's half of index.html.
//
// index.html is dual-mode. The photographer's half mints a studio token above;
// this is the other one. A client signs in with a D1 account and holds neither
// an admin token nor a share link, so before this every tile and every listing
// 401'd — which is the photo-picking flow, the thing the product exists for.
//
// Two of these assertions exist because the Worker's rules cannot be inferred
// from its responses. The bucket root is a 401 by design, so the tree has to be
// seeded from the folder the mint names; and that folder has to be listed
// exactly as the mint spells it, because the admin-typed `20260819` is not the
// prefix `20260819/` and would also have reached `20260819-other/`.
// ═══════════════════════════════════════════════════════════════════════════

// The folder_path inside the session is the one the client logged in with —
// snapshotted then, typed by an admin, and here deliberately BOTH stale and
// missing its trailing slash. Listing it would reach the wrong wedding, and
// `2026/去年` without the slash would also reach `2026/去年二訪/`. Only the
// Worker's answer is current, so every assertion below that says "the mint's
// folder" dies if the page falls back to this one.
const CLIENT_FOLDER_TYPED = '2026/去年';

// The row a client sits on before the photographer assigns them anything.
// '' is the default on a fresh user record, and the old client bar rendered it
// as 所有資料夾 — telling someone with no folder that they had the bucket.
const CLIENT_NO_FOLDER = () => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  sessionStorage.setItem('client_session', JSON.stringify({
    token: 'sess',
    user: { id: 8, email: 'n@example.com', name: '林先生', folder_path: '' },
    permissions: { can_book: false, can_upload: false },
  }));
};

const sessionMints = m => m.seen.filter(r => r.path === '/api/auth/session-token');
const clientLists = m => m.seen.filter(r => r.list !== null);
const barText = page => page.evaluate(() => document.getElementById('client-bar')?.textContent || '');

{
  const m = clientMock();
  await suite('session token — a signed-in client mints one and lists only their own folder',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const mint = sessionMints(m);
      ok('a session token was minted', mint.length === 1,
        JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting sent the D1 session in a header', mint[0]?.auth === 'Bearer sess', JSON.stringify(mint[0]));
      ok('and POSTed it, with nothing in the query string',
        mint[0]?.method === 'POST' && mint[0]?.t === null && mint[0]?.share === null, JSON.stringify(mint[0]));

      const lists = clientLists(m);
      ok('the bucket root was never listed', lists.length > 0 && lists.every(r => r.list !== ''),
        JSON.stringify(lists.map(r => r.list)));
      ok('the prefix listed is the one the mint spelled, not the folder_path an admin typed',
        lists.length > 0 && lists.every(r => r.list === CLIENT_FOLDER),
        JSON.stringify(lists.map(r => r.list)) + ` typed=${CLIENT_FOLDER_TYPED}`);
      ok('the listing carried the minted token as a header, never in the URL',
        lists.every(r => r.share === 'SESSION-1' && r.t === null), JSON.stringify(lists));
      ok('and the D1 session never left the page except to the mint',
        m.seen.filter(r => r.path !== '/api/auth/session-token').every(r => r.auth === null),
        JSON.stringify(m.seen.filter(r => r.auth !== null).map(r => r.path)));

      const tiles = m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));
      ok('every tile the browser asked for carried the minted token in the URL',
        tiles.length >= 3 && tiles.every(r => r.t === 'SESSION-1'), JSON.stringify(tiles));
      ok('and asked for a thumbnail, not the original',
        tiles.length >= 3 && tiles.every(r => r.w === '400'), JSON.stringify(tiles.map(r => r.w)));

      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('the rendered <img> src carries it too',
        srcs.length >= 3 && srcs.every(s => /[?&]t=SESSION-1(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('and the tiles actually loaded', loaded.length >= 3 && loaded.every(w => w > 0),
        JSON.stringify(loaded.slice(0, 3)));

      const rootPath = await page.evaluate(() => app.folderTreeRoot && app.folderTreeRoot.path);
      ok('the folder tree is seeded at that folder rather than the bucket root',
        rootPath === CLIENT_FOLDER, String(rootPath));

      // the sidebar tree is a second listing call, on a different code path
      await page.evaluate(() => app._fetchNodeChildren(
        { path: '20260819/tree/', isLoaded: false, isLoading: false, children: [] }));
      await page.waitForTimeout(300);
      const tree = m.seen.find(r => r.list === '20260819/tree/');
      ok('the sidebar folder tree sends the minted token as a header too',
        tree?.share === 'SESSION-1' && tree?.t === null, JSON.stringify(tree));

      const bar = await barText(page);
      ok('the client bar names the folder they actually have', bar.includes(CLIENT_FOLDER), bar);
      ok('and no longer claims they have every folder', !bar.includes('所有資料夾'), bar);

      // The path box is gone outright now — the left 資料夾 panel is the
      // single source of truth for which folder the client is in.
      ok('the old path box is gone from the DOM',
        await page.evaluate(() => document.getElementById('driveUrl') === null));
      const activeFolder = await page.evaluate(() =>
        document.querySelector('#folderTree .tree-row.tree-active')?.dataset.folder);
      ok('the left panel shows the same folder, not the stale one in the session',
        activeFolder === CLIENT_FOLDER, String(activeFolder));

      // a second folder must not cost another credential
      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(500);
      ok('browsing to another folder reuses the token it already has',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // 403 is terminal. A spinner or an empty grid would read as a bug; this is
  // an account state only the photographer can change.
  const m = clientMock({ mintStatus: 403, mintError: '帳號待審核，請聯繫攝影師' });
  await suite('session token — an unapproved account is told why, and nothing is retried',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('待審核'),
        null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('the mint was attempted once and the 403 was not retried',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      ok('no listing was attempted at all', clientLists(m).length === 0,
        JSON.stringify(clientLists(m).map(r => r.list)));
      const bar = await barText(page);
      ok("the Worker's own wording is what the client reads",
        bar.includes('帳號待審核，請聯繫攝影師'), bar);
      ok('and the folder they used to have is not still offered to them',
        !bar.includes(CLIENT_FOLDER_TYPED), bar);
      ok('no spinner is left turning',
        await page.evaluate(() => !document.getElementById('loadingModal')?.classList.contains('active')));
      ok('and they were not bounced to the login page', page.url().includes('index.html'), page.url());
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The bug this replaces: an unset folder_path was rendered as 所有資料夾,
  // telling a client they had the whole bucket.
  const m = clientMock({ mintStatus: 403, mintError: '尚未設定資料夾，請聯繫攝影師' });
  await suite('session token — a client with no folder is told so, not shown the whole bucket',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('尚未設定資料夾'),
        null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('no listing was attempted', clientLists(m).length === 0,
        JSON.stringify(clientLists(m).map(r => r.list)));
      ok('the mint was not retried', sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      const body = await page.evaluate(() => document.body.textContent || '');
      ok('nowhere on the page is 所有資料夾 still claimed', !body.includes('所有資料夾'),
        body.slice(0, 200));
      const empty = await page.evaluate(() => document.getElementById('emptyState')?.textContent || '');
      ok('the empty state says what to do about it instead of how to type a path',
        empty.includes('尚未設定資料夾，請聯繫攝影師'), empty);
      return out;
    },
    { before: m.attach, initScript: CLIENT_NO_FOLDER });
}

{
  // 401 is a dead or unknown session — nothing on this page can fix it.
  const m = clientMock({ mintStatus: 401 });
  await suite('session token — a dead session sends the client back to log in',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // the login form itself, so the assertions below run on the new document
      await page.waitForSelector('#login-btn', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      ok('the browser was sent to the client login page',
        page.url().includes('client-login.html'), page.url());
      // same origin, so the storage the login page reads is the storage we set
      const left = await page.evaluate(() => sessionStorage.getItem('client_session'));
      ok('and the dead session was cleared, so the login page does not bounce them straight back',
        left === null, String(left));
      ok('nothing was listed on a session the Worker had already refused',
        clientLists(m).length === 0, JSON.stringify(clientLists(m).map(r => r.list)));
      ok('and the mint was asked once, not once per attempt',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // An hour is short enough that a tab left open over lunch outlives it.
  const m = clientMock({ failPhotos: 'first' });
  await suite('session token — a tile that 401s re-mints once and retries',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1200);

      ok('the dead token was replaced', sessionMints(m).length === 2, `${sessionMints(m).length} mints`);
      const tiles = m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));
      ok('every tile that 401d was asked for again with the new one',
        tiles.filter(r => r.t === 'SESSION-2').length >= 3,
        JSON.stringify(tiles.map(r => r.path + ':' + r.t)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the elements now point at the new token',
        srcs.length >= 3 && srcs.every(s => /[?&]t=SESSION-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('the tiles actually loaded in the end', loaded.length >= 3 && loaded.every(w => w > 0),
        JSON.stringify(loaded.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // An hour does not survive a long lunch, and a token with three minutes on it
  // must not be handed to a grid that is about to start loading.
  const m = clientMock({ ttlMinutes: 3 });
  await suite('session token — one near its deadline is replaced before it is used',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);
      const first = clientLists(m).find(r => r.list === CLIENT_FOLDER);

      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(700);
      const second = clientLists(m).find(r => r.list === '20260819/sub/');
      ok('both folders were listed', !!first?.share && !!second?.share,
        JSON.stringify(clientLists(m)));
      ok('a token this close to its deadline is not handed to the next listing',
        first?.share !== second?.share, `${first?.share} then ${second?.share}`);
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the tiles drawn after it carry the newer one',
        srcs.length >= 3 && srcs.every(s => s.includes(`t=${second?.share}`)),
        JSON.stringify(srcs.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // Two tokens on the page at once is the failure this rules out: a client's
  // mint must not also be handed to a photographer's Authorization header, and
  // an admin session must not mint a client token off a stale client_session.
  // studioMock, not clientMock: a clientMock has no /api/auth/studio-token, so
  // the photographer's own mint would 401, CONFIG.SHARE_TOKEN would stay empty,
  // and "sends one credential, not two" would hold for the wrong reason.
  const m = studioMock();
  await suite('session token — an admin on the same browser sends one credential, not two',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('the photographer really does hold a URL token by now',
        await page.evaluate(() => CONFIG.SHARE_TOKEN) === 'STUDIO-1',
        String(await page.evaluate(() => CONFIG.SHARE_TOKEN)));
      ok('no session token was minted for them',
        sessionMints(m).length === 0, JSON.stringify(sessionMints(m)));
      const lists = clientLists(m);
      ok('and their listing carries the real credential and only that',
        lists.length > 0 && lists.every(r => r.auth === 'Bearer adm' && r.share === null),
        JSON.stringify(lists));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // Three mutations survived the first sweep here, all the same shape: the
  // "don't ask again" guard only fires on a SECOND call, and every suite above
  // calls ensure() once. client-auth-check.js and app.js both await it in the
  // same tick, so they share one in-flight request — which made "exactly one
  // mint" true whether the guard existed or not.
  //
  // A guard like this has two ways to be wrong, so both are pinned: asking
  // again when it must not, and refusing to ask when it must. A flat latch
  // passes the first and fails the second.
  const m = clientMock({
    mintStatus: 403, mintError: '帳號待審核，請聯繫攝影師',
    sessions: ['sess', 'sess2'], refuse: ['sess'],
  });
  await suite('session token — a refused session is not asked about twice, but a new one is',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      // the first call has to get all the way to the refusal, or the guard
      // under test is never armed and everything below proves nothing
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('待審核'),
        null, { timeout: 5000 });
      const first = sessionMints(m);
      ok('the first trade reached the Worker and came back 403',
        first.length === 1 && first[0].auth === 'Bearer sess', JSON.stringify(first));

      // two more calls, each awaited on its own, so nothing can be folded into
      // the first request the way the page's own two callers were
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.scope());
      await page.waitForTimeout(300);
      ok('asking again on the same session never reaches the Worker',
        sessionMints(m).length === 1, JSON.stringify(sessionMints(m).map(r => r.auth)));

      // …and the refusal must not outlive the session it was about. Signing in
      // again hands the page a different credential; a latched guard would go
      // on refusing it for as long as the tab stayed open.
      await page.evaluate(() => {
        const s = JSON.parse(sessionStorage.getItem('client_session'));
        s.token = 'sess2';
        sessionStorage.setItem('client_session', JSON.stringify(s));
      });
      const token = await page.evaluate(() => window.SessionToken.ensure());
      await page.waitForTimeout(300);
      const second = sessionMints(m);
      ok('a different session is traded, not refused on the strength of the old one',
        second.length === 2 && second[1].auth === 'Bearer sess2', JSON.stringify(second.map(r => r.auth)));
      ok('and the token it returns is the one the Worker just minted',
        token === 'SESSION-1', String(token));
      const scope = await page.evaluate(() => window.SessionToken.scope());
      ok('with the folder that came with it', scope === CLIENT_FOLDER, String(scope));
      ok('and the 403 it was carrying is cleared',
        await page.evaluate(() => window.SessionToken.error) === '', 
        String(await page.evaluate(() => window.SessionToken.error)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The same guard on the 401 path. A 401 on the FIRST mint sends the page to
  // the login form, and the navigation is what hid this — nothing gets to call
  // ensure() a second time. So the session dies later instead: the page is
  // already up with a working token when the Worker stops recognising it, so
  // applyScope has had its one run and there is no redirect to fight.
  const m = clientMock({ refuseAfter: 1 });
  await suite('session token — a dead session is not re-offered to the Worker either',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('the page came up on a token that worked', sessionMints(m).length === 1,
        JSON.stringify(sessionMints(m)));

      // the session dies; the token on the page ages out and is asked to renew
      const dead = await page.evaluate(async () => {
        window.SessionToken.expiresAt = 0;
        return window.SessionToken.ensure();
      });
      await page.waitForTimeout(300);
      ok('the renewal reached the Worker and came back 401',
        sessionMints(m).length === 2 && dead === '', `${sessionMints(m).length} mints, got ${JSON.stringify(dead)}`);
      ok('and the module knows the session, not the token, is what died',
        await page.evaluate(() => window.SessionToken.expired) === true);

      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.scope());
      await page.waitForTimeout(300);
      ok('and asking again never reaches it',
        sessionMints(m).length === 2, JSON.stringify(sessionMints(m).map(r => r.auth)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The replacement mint itself fails, transiently — a 500, not a refusal, so
  // nothing may write it off as a dead session. Tiles keep arriving one at a
  // time and each reports the same corpse. That must buy one replacement
  // attempt in total, not one per tile: two tiles failing at the same instant
  // share a request by accident, which says nothing.
  const m = clientMock({ failPhotos: 'all', mintFailAfter: 1 });
  await suite('session token — a failed replacement is not retried by the next tile',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1000);
      const afterFirstRound = sessionMints(m).length;
      ok('the first round of dead tiles tried to replace the token once',
        afterFirstRound === 2, `${afterFirstRound} mints`);

      // one new tile at a time, each well after the previous attempt settled
      for (const id of ['20260819/q0.jpg', '20260819/q1.jpg', '20260819/q2.jpg']) {
        await page.evaluate(photoId => {
          app.filteredPhotos = [{ id: photoId, name: photoId, rating: 0, annotations: [] }];
          app.renderPhotoGrid();
        }, id);
        await page.waitForTimeout(450);
      }
      const late = m.seen.filter(r => /^\/20260819\/q\d\.jpg$/.test(r.path));
      ok('the new tiles really did reach the Worker and really did fail',
        late.length === 3 && late.every(r => r.t === 'SESSION-1'), JSON.stringify(late));
      ok('and not one of them bought another mint',
        sessionMints(m).length === afterFirstRound,
        `${sessionMints(m).length} mints, was ${afterFirstRound}`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // A client following a link to a subfolder of their own album. The seed must
  // not then drag them back to the root: two listings for one page load is a
  // wasted round trip and a tree that jumps under them.
  const m = clientMock();
  await suite('session token — a client opening a subfolder link is not yanked back to their root',
    `${base}/index.html?folder=${encodeURIComponent('20260819/sub/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(700);
      const lists = clientLists(m);
      ok('the subfolder they asked for was listed, on their minted token',
        lists.some(r => r.list === '20260819/sub/' && r.share === 'SESSION-1'), JSON.stringify(lists));
      ok('and it was the only listing — the seed did not fire on top of it',
        lists.length === 1, JSON.stringify(lists.map(r => r.list)));
      const rootPath = await page.evaluate(() => app.folderTreeRoot && app.folderTreeRoot.path);
      ok('the tree is rooted where the link pointed', rootPath === '20260819/sub/', String(rootPath));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}
}
