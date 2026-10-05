// Browser suites: the studio token: minted by the main picker and the editor, carried by every
// tile, renewed and retried.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, studioMock } from '../lib/auth-mocks.mjs';

export default async function register() {

const CONFIG_WORKER = 'https://imagepicker.hotichen.workers.dev/';
const mints = m => m.seen.filter(r => r.path === '/api/auth/studio-token');
const tileReqs = m => m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));

{
  const m = studioMock();
  await suite('studio token — the main picker mints one and every tile carries it',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const mint = mints(m)[0];
      ok('a studio token was minted', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting used the real credential in a header', mint?.auth === 'Bearer adm', JSON.stringify(mint));
      ok('and POSTed, with nothing in the query string',
        mint?.method === 'POST' && mint?.t === null, JSON.stringify(mint));

      const list = m.seen.find(r => r.list !== null);
      ok('the folder listing reached the Worker', !!list, JSON.stringify(m.seen.map(r => r.path + '?' + r.list)));
      ok('and it is a fetch, so it carries the real credential as a header',
        list?.auth === 'Bearer adm', JSON.stringify(list));

      const tiles = tileReqs(m);
      ok('every tile the browser asked for carried the studio token',
        tiles.length >= 3 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      ok('and asked for a thumbnail, not the original',
        tiles.length >= 3 && tiles.every(r => r.w === '400'), JSON.stringify(tiles.map(r => r.w)));

      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('the rendered <img> src carries it too',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));

      // the sidebar tree is a second listing call, on a different code path
      await page.evaluate(() => app._fetchNodeChildren(
        { path: '20260819/tree/', isLoaded: false, isLoading: false, children: [] }));
      await page.waitForTimeout(300);
      const tree = m.seen.find(r => r.list === '20260819/tree/');
      ok('the sidebar folder tree is authenticated too', tree?.auth === 'Bearer adm', JSON.stringify(tree));

      // the ZIP download is a fetch, so it sends the header and has no reason
      // to put a token in the URL — and it wants the original, not a thumbnail
      await page.evaluate(() => {
        window.JSZip = function () { this.file = () => {}; this.generateAsync = async () => new Blob(['z']); };
        return driveManager.downloadPhotos([{ id: '20260819/p9.jpg', name: 'p9.jpg' }], 'x.zip');
      });
      await page.waitForTimeout(400);
      const dl = m.seen.find(r => r.path === '/20260819/p9.jpg');
      ok('the ZIP download sends the real credential as a header',
        dl?.auth === 'Bearer adm', JSON.stringify(dl));
      ok('and asks for the original with no token in the URL',
        dl?.t === null && dl?.w === null, JSON.stringify(dl));

      // a second folder must not cost another credential — the Worker reuses
      // one server-side, but a mint per listing is still a round trip per click
      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(500);
      ok('browsing to another folder reuses the token it already has',
        mints(m).length === 1, `${mints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock();
  await suite('studio token — the editor canvas, strip and preview all carry it',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(async () => {
        bookEditor.currentBookId = 'test';
        await bookEditor._loadFromCloud();
        bookEditor.renderAll();
      });
      await page.waitForTimeout(500);

      const mint = mints(m)[0];
      ok('a studio token was minted', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('with the real credential', mint?.auth === 'Bearer x', JSON.stringify(mint));

      const book = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book itself is still fetched with the real credential, not the studio token',
        book?.auth === 'Bearer x' && book?.t === null && book?.share === null, JSON.stringify(book));

      const canvas = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('every canvas <img> carries ?t=',
        canvas.length === 2 && canvas.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(canvas));

      await page.evaluate(() => {
        bookEditor.libraryPhotos = [{ id: '20260819/p0.jpg', name: 'p0.jpg', rating: 0 },
                                    { id: '20260819/p1.jpg', name: 'p1.jpg', rating: 0 }];
        bookEditor.renderPhotoStrip();
        bookEditor._showPreviewAt(0);
      });
      await page.waitForTimeout(400);

      const strip = await page.$$eval('.strip-photo img', els => els.map(e => e.getAttribute('src')));
      ok('the library strip carries it',
        strip.length === 2 && strip.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(strip));

      const prev = await page.evaluate(() => ({
        img: document.getElementById('photoPreviewImg').getAttribute('src'),
        dl: document.getElementById('photoPreviewDownload')?.getAttribute('href'),
      }));
      ok('the preview modal carries it', /[?&]t=STUDIO-1(&|$)/.test(prev.img || ''), prev.img);
      // an <a download> navigates; it cannot send a header either
      ok('the original-download link carries it', /[?&]t=STUDIO-1(&|$)/.test(prev.dl || ''), prev.dl);
      ok('and the download link is still the original, not a thumbnail',
        /\/20260819\/p0\.jpg\?t=/.test(prev.dl || ''), prev.dl);

      await page.evaluate(() => bookEditor.openBgPicker('library'));
      await page.waitForTimeout(400);
      const bg = await page.$$eval('.bg-picker-photo img', els => els.map(e => e.getAttribute('src')));
      ok('the background picker carries it',
        bg.length === 2 && bg.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(bg));

      const tiles = tileReqs(m);
      ok('every photo request that reached the Worker was authorised',
        tiles.length >= 2 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'x');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

{
  const m = studioMock();
  await suite('studio token — previewing an album needs no blob-URL workaround',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('a studio token was minted with the real credential',
        mints(m)[0]?.auth === 'Bearer adm', JSON.stringify(mints(m)[0]));
      const book = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book GET still uses the header credential, which the Worker demands',
        book?.auth === 'Bearer adm' && book?.t === null && book?.share === null, JSON.stringify(book));

      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('the canvas images are real Worker URLs, not blob: swaps',
        srcs.length === 2 && srcs.every(s => s.startsWith(CONFIG_WORKER)), JSON.stringify(srcs));
      ok('and they carry ?t=',
        srcs.length === 2 && srcs.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(srcs));

      const tiles = tileReqs(m);
      // the band-aid fired one naked <img> request that 401'd before the
      // authenticated fetch went out; nothing may 401 first any more
      ok('no photo was ever asked for without a credential',
        tiles.length >= 2 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      ok('and each photo was asked for exactly once',
        tiles.length === new Set(tiles.map(r => r.path + r.w)).size,
        JSON.stringify(tiles.map(r => r.path)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock();
  await suite('studio token — a client link neither mints one nor loses its own',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(500);

      ok('the client never asks the Worker to mint anything',
        mints(m).length === 0, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      const tiles = tileReqs(m);
      ok('and its own token is what reached the Worker',
        tiles.length >= 2 && tiles.every(r => r.t === 'SHARE-TOK'), JSON.stringify(tiles));
      return out;
    },
    { before: m.attach });
}

{
  // 12 hours outlives a working session but not a tab left open overnight
  const m = studioMock({ ttlHours: 0.05 });
  await suite('studio token — one near its deadline is replaced before it is used',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('the first load minted one', mints(m).length === 1, `${mints(m).length} mints`);

      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(600);
      ok('the next listing replaced it rather than reusing a dying one',
        mints(m).length === 2, `${mints(m).length} mints`);

      const late = tileReqs(m).filter(r => r.t !== 'STUDIO-1');
      ok('and the tiles drawn after it carry the new token',
        late.length >= 3 && late.every(r => r.t === 'STUDIO-2'), JSON.stringify(late.slice(0, 4)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('as do the rendered elements',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // the known trap: a mistyped PHOTOGRAPHER_TOKEN gets the user in anyway, and
  // then everything 401s. That must stay one refused mint, not a flood.
  const m = studioMock({ mintStatus: 401 });
  await suite('studio token — a refused credential does not become a mint storm',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForTimeout(700);
      for (const f of ['20260819/a/', '20260819/b/', '20260819/c/']) {
        await page.evaluate(p => app.handleLoadPhotos(p), f);
      }
      await page.waitForTimeout(700);
      ok('the Worker was asked to mint exactly once', mints(m).length === 1, `${mints(m).length} mints`);
      ok('the page still listed folders instead of giving up',
        m.seen.filter(r => r.list !== null).length >= 4,
        JSON.stringify(m.seen.filter(r => r.list !== null).map(r => r.list)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // a tab left open overnight: the tiles are the first thing to notice
  const m = studioMock({ failPhotos: 'first' });
  await suite('studio token — a tile that 401s re-mints once and retries',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(900);

      ok('the dead token was replaced', mints(m).length === 2, `${mints(m).length} mints`);
      ok('every tile that 401d was asked for again',
        tileReqs(m).filter(r => r.t === 'STUDIO-2').length >= 3,
        JSON.stringify(tileReqs(m).map(r => r.path + ':' + r.t)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the elements now point at the new token',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('the tiles actually loaded in the end',
        loaded.length >= 3 && loaded.every(w => w > 0), JSON.stringify(loaded.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock({ failPhotos: 'all' });
  await suite('studio token — tiles that keep failing retry once, then stop',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1500);

      ok('the whole page cost one extra mint, not one per tile',
        mints(m).length === 2, `${mints(m).length} mints`);
      const counts = {};
      for (const r of tileReqs(m)) counts[r.path] = (counts[r.path] || 0) + 1;
      const paths = Object.keys(counts);
      ok('and no tile was asked for more than twice',
        paths.length >= 3 && paths.every(p => counts[p] <= 2), JSON.stringify(counts));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // The replacement mint itself fails, transiently — a 500, not a refusal, so
  // nothing may write it off as a wrong credential. The token on the page is
  // now known-dead and stays known-dead, and tiles keep arriving one at a
  // time: lazily loaded rows scrolling into view, a modal opening. Each one
  // reports the same corpse. That must buy one replacement attempt in total,
  // not one per tile — the case where two tiles failing at the same instant
  // share a single request says nothing, because they share it by accident.
  const m = studioMock({ failPhotos: 'all', mintFailAfter: 1 });
  await suite('studio token — a failed replacement is not retried by the next tile',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(900);
      const afterFirstRound = mints(m).length;
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
        late.length === 3 && late.every(r => r.t === 'STUDIO-1'), JSON.stringify(late));
      ok('and not one of them bought another mint',
        mints(m).length === afterFirstRound, `${mints(m).length} mints, was ${afterFirstRound}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
