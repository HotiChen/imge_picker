// Browser suites: share tokens on the client album, and issuing / revoking share links in the
// editor.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { shareMock } from '../lib/auth-mocks.mjs';

export default async function register() {

const authorised = (r, tok) => !!r && (r.share === tok || r.t === tok);

{
  const m = shareMock();
  await suite('share token — the client album carries it on every request',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const bookReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('book GET is authorised', authorised(bookReq, 'SHARE-TOK'), JSON.stringify(bookReq));
      ok('status GET is authorised',
        authorised(m.seen.find(r => r.path.endsWith('/status')), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.path.endsWith('/status'))));

      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('every canvas <img> carries ?t= (an element cannot send a header)',
        srcs.length === 2 && srcs.every(s => /[?&]t=SHARE-TOK(&|$)/.test(s)), JSON.stringify(srcs));
      ok('and the photo request really reached the Worker with it',
        m.seen.some(r => r.path === '/20260819/p0.jpg' && r.t === 'SHARE-TOK'),
        JSON.stringify(m.seen.filter(r => r.path.includes('p0.jpg'))));

      await page.evaluate(() => { Viewer.pickerSlotIdx = 0; return Viewer._openPhotoPicker(); });
      await page.waitForTimeout(300);
      const listReq = m.seen.find(r => r.list !== null);
      ok('?list= is authorised', authorised(listReq, 'SHARE-TOK'), JSON.stringify(listReq));
      const tiles = await page.$$eval('.viewer-picker-photo img', els => els.map(e => e.getAttribute('src')));
      ok('picker tiles carry ?t= too',
        tiles.length === 3 && tiles.every(s => /[?&]t=SHARE-TOK(&|$)/.test(s)), JSON.stringify(tiles));

      await page.evaluate(() => { Viewer.changedPages.add(0); return Viewer.saveChanges(); });
      ok('PATCH is authorised',
        authorised(m.seen.find(r => r.method === 'PATCH'), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.method === 'PATCH')));

      await page.evaluate(() => Viewer.approve());
      ok('approve is authorised',
        authorised(m.seen.find(r => r.path.endsWith('/approve')), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.path.endsWith('/approve'))));

      ok('the URL is left alone, so the LINE message still works',
        /[?&]t=SHARE-TOK(&|$)/.test(await page.evaluate(() => location.search)),
        await page.evaluate(() => location.search));

      // the token is in the URL, so the URL must not ride along to anyone
      ok('the page refuses to put its own URL in a Referer',
        (await page.getAttribute('meta[name="referrer"]', 'content')) === 'no-referrer',
        String(await page.getAttribute('meta[name="referrer"]', 'content')));
      return out;
    },
    { before: async page => { page.on('dialog', d => d.accept()); await m.attach(page); } });
}

{
  const m = shareMock();
  await suite('share token — reopening the same LINE link keeps working',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(200);

      const gets = m.seen.filter(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book was fetched on both visits', gets.length === 2, String(gets.length));
      ok('both carried the same token — nothing was consumed',
        gets.length === 2 && gets.every(r => authorised(r, 'SHARE-TOK')), JSON.stringify(gets));
      ok('the second visit rendered the album, not the error screen',
        (await page.textContent('#bookTitle')) === 'T', await page.textContent('#bookTitle'));
      return out;
    },
    { before: m.attach });
}

{
  const m = shareMock();
  await suite('share token — the photographer previews with their own token',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(600);

      const bookReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('book GET falls back to the bearer token', bookReq?.auth === 'Bearer adm', JSON.stringify(bookReq));
      ok('and sends no share token', !bookReq?.share && !bookReq?.t, JSON.stringify(bookReq));
      ok('the album rendered', (await page.textContent('#bookTitle')) === 'T',
        await page.textContent('#bookTitle'));
      ok('minting the studio token used the bearer token',
        m.seen.find(r => r.path === '/api/auth/studio-token')?.auth === 'Bearer adm',
        JSON.stringify(m.seen.find(r => r.path === '/api/auth/studio-token')));
      const photoReqs = m.seen.filter(r => r.path === '/20260819/p0.jpg');
      ok('the photo was fetched with it, and never without a credential first',
        photoReqs.length === 1 && photoReqs[0].t === 'STUDIO-TOK', JSON.stringify(photoReqs));
      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.src));
      ok('and the <img> loads it itself — no blob swap, no wasted 401',
        srcs.length === 2 && srcs.every(s => /[?&]t=STUDIO-TOK(&|$)/.test(s)), JSON.stringify(srcs));
      return out;
    },
    { before: m.attach, initScript: () => sessionStorage.setItem('studio_token', 'adm') });
}

{
  const m = shareMock();
  await suite('share token — a link with no credential says so instead of going blank',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForTimeout(700);
      ok('a visible error is on screen', await page.isVisible('#pageArea .state-msg.error'),
        await page.textContent('#pageArea'));
      const msg = (await page.textContent('#pageArea')).trim();
      ok('it names the missing token rather than a generic failure', /權杖/.test(msg), JSON.stringify(msg));
      ok('the header does not still say 載入中', (await page.textContent('#bookTitle')) !== '載入中...',
        await page.textContent('#bookTitle'));
      ok('nothing was asked of the Worker', m.seen.length === 0, JSON.stringify(m.seen));
      return out;
    },
    { before: m.attach });
}

const SHARE_ROWS = [
  { token: 'LIVE1', label: '王先生 婚紗', created_at: '2026-03-05T12:00:00.000Z',
    expires_at: '2027-06-03T12:00:00.000Z', revoked_at: null, last_seen_at: '2026-09-18T12:00:00.000Z' },
  { token: 'REV1', label: '寄錯群組', created_at: '2026-02-01T12:00:00.000Z',
    expires_at: '2027-05-02T12:00:00.000Z', revoked_at: '2026-02-02T12:00:00.000Z', last_seen_at: null },
  { token: 'EXP1', label: '去年試拍', created_at: '2025-01-01T12:00:00.000Z',
    expires_at: '2025-04-01T12:00:00.000Z', revoked_at: null, last_seen_at: '2025-02-01T12:00:00.000Z' },
];

const OPEN_SHARE_MODAL = async () => {
  bookEditor.libFolderStack = ['20260819/'];
  bookEditor.currentBookId = 'test';
  bookEditor.book.cloudId = 'test';
  await bookEditor.openShareModal();
  await new Promise(r => setTimeout(r, 400));
};

{
  const m = shareMock({ shares: SHARE_ROWS });
  await suite('分享連結 — 發出一條帶 token 的連結',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(OPEN_SHARE_MODAL);

      await page.fill('#shareLabelInput', '王先生 婚紗');
      await page.click('#shareConfirmBtn');
      await page.waitForTimeout(700);

      const mint = m.seen.find(r => r.method === 'POST' && r.path === '/api/books/test/share');
      ok('a token was minted for this book', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting used the photographer token', mint?.auth === 'Bearer x', JSON.stringify(mint));
      ok('the label the photographer typed was sent',
        JSON.parse(mint?.body || '{}').label === '王先生 婚紗', String(mint?.body));

      const url = await page.inputValue('#shareUrl');
      ok('the client link carries the minted token',
        /\/view\.html\?id=test&t=MINT-TOKEN$/.test(url), JSON.stringify(url));
      ok('and the copy step is showing', await page.isVisible('#shareUrlStep'));
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
  const m = shareMock({ shares: SHARE_ROWS });
  await suite('分享連結 — 已發出的連結清單與撤銷',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(OPEN_SHARE_MODAL);

      const listReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test/shares');
      ok('the list was fetched with the photographer token', listReq?.auth === 'Bearer x',
        JSON.stringify(listReq));

      const rows = await page.$$eval('.share-link-row', els => els.map(e => ({
        token: e.dataset.token,
        cls: e.className,
        text: e.textContent.replace(/\s+/g, ' ').trim(),
        opacity: parseFloat(getComputedStyle(e).opacity),
        strike: getComputedStyle(e.querySelector('.share-link-label')).textDecorationLine,
        hasRevoke: !!e.querySelector('.share-revoke-btn'),
      })));
      ok('one row per issued link', rows.length === 3, JSON.stringify(rows.map(r => r.token)));

      const by = t => rows.find(r => r.token === t);
      ok('the label is what identifies a link', by('LIVE1')?.text.includes('王先生 婚紗'),
        JSON.stringify(by('LIVE1')?.text));
      ok('the issue date is shown', /2026\/3\/5/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('the expiry is shown', /2027\/6\/3/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('last opened is shown', /2026\/9\/18/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('a link nobody opened says so', /尚未開啟/.test(by('REV1')?.text || ''), by('REV1')?.text);

      ok('the revoked link is marked revoked', /\brevoked\b/.test(by('REV1')?.cls || ''), by('REV1')?.cls);
      ok('the expired link is marked expired', /\bexpired\b/.test(by('EXP1')?.cls || ''), by('EXP1')?.cls);
      ok('the live link is marked live', /\blive\b/.test(by('LIVE1')?.cls || ''), by('LIVE1')?.cls);
      ok('a dead link is visibly dimmer than a live one',
        by('REV1')?.opacity < by('LIVE1')?.opacity && by('EXP1')?.opacity < by('LIVE1')?.opacity,
        `live ${by('LIVE1')?.opacity} revoked ${by('REV1')?.opacity} expired ${by('EXP1')?.opacity}`);
      ok('a dead link is struck through, a live one is not',
        by('REV1')?.strike.includes('line-through') && by('EXP1')?.strike.includes('line-through')
        && !by('LIVE1')?.strike.includes('line-through'),
        `live ${by('LIVE1')?.strike} revoked ${by('REV1')?.strike}`);
      ok('only a live link offers revoke',
        by('LIVE1')?.hasRevoke === true && by('REV1')?.hasRevoke === false,
        JSON.stringify(rows.map(r => [r.token, r.hasRevoke])));

      // revoking is not undoable, so it must ask first
      await page.click('.share-link-row[data-token="LIVE1"] .share-revoke-btn');
      await page.waitForTimeout(250);
      ok('it asks before revoking', await page.isVisible('#confirmModal.active'));
      ok('the question names the link being killed',
        /王先生 婚紗/.test(await page.textContent('#confirmMessage')),
        await page.textContent('#confirmMessage'));
      await page.click('#confirmCancelBtn');
      await page.waitForTimeout(250);
      ok('saying no revokes nothing',
        !m.seen.some(r => r.path.includes('/revoke')), JSON.stringify(m.seen.map(r => r.path)));

      m.state.shares = SHARE_ROWS.map(r =>
        r.token === 'LIVE1' ? { ...r, revoked_at: '2026-09-21T12:00:00.000Z' } : r);
      await page.click('.share-link-row[data-token="LIVE1"] .share-revoke-btn');
      await page.waitForTimeout(250);
      await page.click('#confirmOkBtn');
      await page.waitForTimeout(600);

      const rev = m.seen.find(r => r.path === '/api/shares/LIVE1/revoke');
      ok('confirming posts to the revoke endpoint', !!rev, JSON.stringify(m.seen.map(r => r.path)));
      ok('with the photographer token', rev?.auth === 'Bearer x', JSON.stringify(rev));
      ok('and the row goes dead in front of them',
        /\brevoked\b/.test(await page.getAttribute('.share-link-row[data-token="LIVE1"]', 'class') || ''),
        await page.getAttribute('.share-link-row[data-token="LIVE1"]', 'class'));
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
  const m = shareMock();
  await suite('編輯器是攝影師的頁面 — 讀取相本時要帶 admin token',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(async () => {
        bookEditor.currentBookId = 'test';
        await bookEditor._loadFromCloud();
        bookEditor.book.cloudId = 'test';
        await bookEditor.checkCloudStatus();
      });
      const get = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the cloud load is authenticated', get?.auth === 'Bearer x', JSON.stringify(get));
      const st = m.seen.find(r => r.path === '/api/books/test/status');
      ok('so is the approval check', st?.auth === 'Bearer x', JSON.stringify(st));

      // the share modal's folder picker is built from this listing, so an
      // unauthenticated one means the photographer cannot choose what to open
      await page.evaluate(() => bookEditor._fetchFolderDirect('20260819/'));
      const ls = m.seen.find(r => r.list !== null);
      ok('and so is the photo library listing', ls?.auth === 'Bearer x', JSON.stringify(ls));
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
}
