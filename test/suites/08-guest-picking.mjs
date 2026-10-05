// Browser suites: guest picking (seat, hearts, autosave, submit, filters, caps) and the 入口
// redirects.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, CLIENT, clientMock } from '../lib/auth-mocks.mjs';
import { PHOTOS, mockWorker } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

await suite('guest picking — a free seat blocks on a name, then loads an editable grid',
  `${base}/index.html?t=TOK`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    await page.waitForSelector('#pickClaimOverlay:not([hidden])', { timeout: 5000 });
    ok('the claim overlay is shown while the seat is free', true);
    ok('the submit button stays hidden until claimed',
      await page.evaluate(() => document.getElementById('submitJobBtn') === null &&
        !document.getElementById('pickSubmitBtn').getClientRects().length));

    await page.fill('#pickNameInput', 'Alice');
    await page.click('#pickClaimBtn');
    await page.waitForSelector('#pickClaimOverlay', { state: 'hidden', timeout: 5000 });
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    // the `hidden` IDL property passing is not enough on its own — this
    // codebase has a real case of a same-specificity CSS rule beating
    // [hidden] { display: none }, so the actual computed style is what
    // has to be checked (see .btn / display:inline-flex, and this overlay
    // hit the identical bug during development)
    ok('and it is actually invisible, not just carrying the attribute',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickClaimOverlay')).display === 'none'));
    // and provably not intercepting clicks either, by actually using a
    // control underneath it
    await page.locator('.photo-card').first().locator('.pick-heart-btn').click({ timeout: 3000 });

    const storedKey = await page.evaluate(() => localStorage.getItem('pick_key:TOK'));
    ok('the picker key is stored in localStorage, keyed by the link', storedKey === 'KEY-picker-1', String(storedKey));

    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll('.photo-card').length,
      stars: document.querySelectorAll('.photo-card .star-rating').length,
      selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
      hearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
      submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length &&
        document.getElementById('submitJobBtn') === null,
    }));
    ok('the grid loaded', r.cards === 3, String(r.cards));
    ok('no star rating control exists — the guest heart replaces it', r.stars === 0, String(r.stars));
    ok('no select checkbox exists either — the guest heart replaces it too', r.selectBtns === 0, String(r.selectBtns));
    ok('the owner gets one clickable ♥ toggle on every card', r.hearts === 3, String(r.hearts));
    ok('the bottom 完成提交 (#pickSubmitBtn) is shown once this browser owns the seat, no header 完成挑圖', r.submitShown === true);
    return out;
  },
  { before: pickFakeWorker().attach });

{
  const m = pickFakeWorker({ ownerName: 'Rhea', ownerKey: 'RHEA-KEY' });
  await suite('guest picking — the modal also gets one ♥ toggle instead of the star rating, and stays in sync with the grid',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.click('.photo-card');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const before = await page.evaluate(() => ({
        stars: document.querySelectorAll('#modalPhotoRating .star-rating').length,
        hearts: document.querySelectorAll('#modalPhotoRating .pick-heart-btn').length,
      }));
      ok('no star rating in the modal', before.stars === 0, String(before.stars));
      ok('one ♥ toggle in the modal instead', before.hearts === 1, String(before.hearts));

      await page.click('#modalPhotoRating .pick-heart-btn');
      await page.waitForTimeout(1000);
      const put = m.requests.filter(r => r.method === 'PUT').pop();
      ok('picking from the modal autosaves the real key',
        put && JSON.stringify(put.body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 1, note: '' }], delete: [] }),
        JSON.stringify(put));

      await page.click('#closeModal');
      const gridOn = await page.locator('.photo-card').first().locator('.pick-heart-btn.on').count();
      ok('closing the modal shows the grid card already carrying the same ♥ state', gridOn === 1, String(gridOn));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RHEA-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Bob' });
  await suite('guest picking — someone else’s seat is view-only: no rating or selecting controls, banner names them',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      ok('no claim overlay — the seat is already taken',
        await page.evaluate(() => document.getElementById('pickClaimOverlay').hidden === true));
      ok('and it is actually invisible, not just carrying the attribute',
        await page.evaluate(() => getComputedStyle(document.getElementById('pickClaimOverlay')).display === 'none'));
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const r = await page.evaluate(() => ({
        bannerHidden: document.getElementById('pickBanner').hidden,
        bannerText: document.getElementById('pickBannerLines').textContent,
        hintHidden: document.getElementById('pickBannerHint').hidden,
        hintText: document.getElementById('pickBannerHintText').textContent,
        cards: document.querySelectorAll('.photo-card').length,
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        readonlyHearts: document.querySelectorAll('.photo-card span.pick-heart-btn').length,
        submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length,
      }));
      ok('the banner names the current owner', !r.bannerHidden && r.bannerText.includes('此相簿由 Bob 選片中'), r.bannerText);
      ok('and offers the "is this you" hint', !r.hintHidden && r.hintText === '你是 Bob 嗎？', r.hintText);
      ok('no login option — only 請攝影師重設 is offered',
        !(await page.evaluate(() => !!document.getElementById('pickBannerLoginBtn'))) &&
        r.hintText === '你是 Bob 嗎？' &&
        (await page.evaluate(() => document.getElementById('pickBannerHint').textContent)).includes('請攝影師重設'));
      ok('browsing still works — the grid loads', r.cards === 3, String(r.cards));
      ok('but no star rating control exists in the DOM (removed, not hidden)', r.stars === 0, String(r.stars));
      ok('and no select control either', r.selectBtns === 0, String(r.selectBtns));
      ok('no clickable ♥ toggle — a viewer cannot pick', r.clickableHearts === 0, String(r.clickableHearts));
      ok('the ♥ state is shown read-only instead', r.readonlyHearts === 3, String(r.readonlyHearts));
      ok('no submit button is visible for a viewer', r.submitShown === false);
      return out;
    },
    { before: m.attach });
}

{
  const m = pickFakeWorker({ ownerName: 'Alice', ownerKey: 'ALICE-KEY', pickLimit: 1, extraPrice: 50 });
  await suite('guest picking — ratings autosave debounced and batched, and the counter turns orange over the limit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const card = i => page.locator('.photo-card').nth(i);
      await card(0).locator('.pick-heart-btn').click();
      // still inside the debounce window — nothing sent yet
      await page.waitForTimeout(200);
      ok('a ♥ toggle is debounced, not sent immediately',
        !m.requests.some(r => r.method === 'PUT'), JSON.stringify(m.requests.filter(r => r.method === 'PUT')));

      await page.waitForTimeout(900);
      const put1 = m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
      ok('the batched PUT lands after the debounce window carrying the picker key, rating 1',
        put1.length === 1 && put1[0].key === 'ALICE-KEY' &&
        JSON.stringify(put1[0].body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 1, note: '' }], delete: [] }),
        JSON.stringify(put1));
      ok('the card now shows the heart on',
        await card(0).locator('.pick-heart-btn.on').count() === 1);

      const counter1 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter shows the plan’s limit', counter1 === '已選 1 / 1 張', counter1);
      ok('no over-limit message yet',
        await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over') && !/超出|加挑費/.test(document.body.innerText)));

      await card(1).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const counter2 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter now reads 2', counter2 === '已選 2 / 1 張', counter2);
      const warn = await page.evaluate(() => ({
        over: document.getElementById('pickCounter').classList.contains('over'),
        text: document.body.innerText,
      }));
      ok('over the limit only the counter changes (colour) — no message, and nothing is blocked',
        warn.over && !/超出|多 1 張|加挑費/.test(warn.text), warn.text.slice(0, 200));

      const badge1 = await page.evaluate(() => document.getElementById('pickFilterSelectedCount').textContent);
      ok('the ♥ 已選 filter badge tracks the same count', badge1 === '2', badge1);

      // clicking an already-on heart turns it back off — rating 0, not 1
      await card(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const put2 = m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
      ok('un-picking sends rating 0',
        JSON.stringify(put2[put2.length - 1].body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 0, note: '' }], delete: [] }),
        JSON.stringify(put2[put2.length - 1]));
      ok('the heart is off again', await card(0).locator('.pick-heart-btn.on').count() === 0);
      const counter3 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter drops back to 1', counter3 === '已選 1 / 1 張', counter3);
      return out;
    },
    {
      before: m.attach,
      initScript: () => localStorage.setItem('pick_key:TOK', 'ALICE-KEY'),
    });
}

{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('guest picking — submit shows the server’s real errors, then a real success, then the submitted phase',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      const nameVal = await page.inputValue('#pickSubmitName');
      ok('the name is prefilled from the claimed seat', nameVal === 'Carol', nameVal);

      // relationship left unset — the server, not a made-up client message,
      // is what says so
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const err1 = await page.textContent('#pickSubmitErr');
      ok('a missing relationship is refused with the server’s own message',
        err1 === '請選擇與新人的關係', err1);

      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.fill('#pickSubmitEmail', 'not-an-email');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const err2 = await page.textContent('#pickSubmitErr');
      ok('a malformed email is refused with the server’s own message',
        err2 === 'Email 格式不正確', err2);

      await page.fill('#pickSubmitEmail', '');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active'));
      ok('a valid submit closes the modal', closed);

      // the last one — the two refused attempts before it posted too
      const submitReqs = m.requests.filter(r => r.method === 'POST' && r.path === '/api/pick/submit');
      const submitReq = submitReqs[submitReqs.length - 1];
      ok('and the successful attempt actually posted relationship + no email',
        submitReq && submitReq.body.relationship === '朋友' && !submitReq.body.email,
        JSON.stringify(submitReq));

      const banner = await page.evaluate(() => document.getElementById('pickBannerLines').textContent);
      ok('the phase banner now says 已送出', banner.includes('已送出'), banner);

      // saving again while submitted must not block, and must raise the
      // "modified since submit" notice (docs/guest-picking.md)
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const banner2 = await page.evaluate(() => document.getElementById('pickBannerLines').textContent);
      ok('a save after submit shows 已修改，請重新送出', banner2.includes('已修改，請重新送出'), banner2);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAROL-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Dora', ownerKey: 'DORA-KEY' });
  await suite('guest picking — retouching starting mid-session locks the owner out and removes the controls',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('editable at first', await page.evaluate(() =>
        document.querySelectorAll('.photo-card button.pick-heart-btn').length === 3));

      // the photographer starts retouching in another tab while this one is
      // mid-session; the next save is refused with 409 retouching
      m.state.project.phase = 'retouching';
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);

      const r = await page.evaluate(() => ({
        banner: document.getElementById('pickBannerLines').textContent,
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length,
      }));
      ok('shows the LINE-contact notice', r.banner.includes('攝影師已安排精修，如需修改請透過 LINE 聯絡攝影師'), r.banner);
      ok('no star rating control (never existed in pick mode)', r.stars === 0, String(r.stars));
      ok('no select control either', r.selectBtns === 0, String(r.selectBtns));
      ok('every clickable ♥ toggle is gone from the DOM', r.clickableHearts === 0, String(r.clickableHearts));

      // submitJob() itself must also refuse, not just the autosave path
      await page.evaluate(() => window.app.submitJob());
      await page.waitForTimeout(200);
      ok('and the submit modal does not open',
        await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'DORA-KEY') });
}

// A bare index.html with no recognised mode param and no session now leaves
// for home.html (see the "studio entrance" suites below) instead of showing
// the choice overlay, so this "untouched" check needs a URL that still
// selects a mode without any auth — ?folder= is exactly that (the old magic
// link), and per spec it "behaves exactly as today".
await suite('guest picking — the studio/client choice overlay and other modes are untouched with ?folder= and no session',
  `${base}/index.html?folder=20260819/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('PickController exists but is inactive', await page.evaluate(() =>
      !!window.PickController && window.PickController.active === false));
    ok('the pick counter never appears in a mode that never turns it on (not in the DOM, bottom bar keeps its own 已選取)',
      await page.evaluate(() => document.getElementById('pickCounter') === null && !document.body.classList.contains('pick-active') &&
        !!document.getElementById('mobileSelectedCount')));
    ok('the ♥ filter bar stays hidden too — no pick mode to unhide it',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickFilterBar')).display === 'none'));
    ok('the star filter and 只看選取 are untouched, still in the DOM',
      await page.evaluate(() => !!document.querySelector('.star-filter') && !!document.getElementById('filterSelectedBtn')));
    ok('the studio/client choice overlay still appears',
      await page.waitForSelector('#auth-overlay', { timeout: 5000 }).then(() => true, () => false));
    ok('and it was not redirected to home.html', !/home\.html/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1) });

// ═══════════════════════════════════════════════════════════════════════════
// index.html entrance — imhoti.tw/studio/ serves index.html, and a bare visit
// (no ?t=/?project=/?folder=/?id= and no studio_token/client_session) should
// land on home.html instead of the studio/client choice overlay.
// ═══════════════════════════════════════════════════════════════════════════

await suite('入口 — 沒有模式參數也沒有登入狀態的 index.html 導向 home.html',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html$/.test(page.url()), page.url());
    ok('the choice overlay was never shown',
      await page.evaluate(() => document.getElementById('auth-overlay') === null));
    return out;
  },
  { before: mockWorker(1) });

await suite('入口 — index.html?t=<pick token> 不會被導向 home.html',
  `${base}/index.html?t=PICK-TOKEN`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('PickController took the page — active is true',
      await page.evaluate(() => !!window.PickController && window.PickController.active === true));
    ok('stayed on index.html, not redirected to home.html',
      /\/index\.html\?t=PICK-TOKEN$/.test(page.url()), page.url());
    return out;
  },
  { before: pickFakeWorker({ ownerName: 'Ivy' }).attach });

await suite('入口 — sessionStorage 已有 studio_token 的 index.html 不會被導向 home.html',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('stayed on index.html — the studio token bypasses the redirect',
      /\/index\.html$/.test(page.url()), page.url());
    ok('the choice overlay was never shown',
      await page.evaluate(() => document.getElementById('auth-overlay') === null));
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

// imhoti.tw/studio/ itself (the directory URL, what Tim types) with a
// photographer signed in goes to the dashboard. index.html by name — the side
// menu's 選圖 and upload's 回選圖 — still opens the workspace (suite above).
await suite('入口 — 已登入攝影師開 /studio/ 導向 dashboard.html',
  `${base}/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/dashboard.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to dashboard.html', /\/dashboard\.html$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

await suite('入口 — 已登入攝影師開 /studio/?project=<id> 留在原頁',
  `${base}/?project=P1`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('a mode param keeps the page', /\/\?project=P1$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

await suite('入口 — 沒登入開 /studio/ 仍導向 home.html',
  `${base}/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /\/home\.html$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1) });

{
  const m = clientMock();
  await suite('入口 — 已登入的客戶（client_session）的 index.html 不會被導向 home.html',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#client-bar', { timeout: 5000 }).then(() => true, () => false);
      ok('the client bar rendered instead of a redirect', await page.evaluate(() => !!document.getElementById('client-bar')));
      ok('stayed on index.html', /\/index\.html$/.test(page.url()), page.url());
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  const XSS_NAME = '"><img src=x onerror="window.__xss=1">';
  const m = pickFakeWorker({ ownerName: XSS_NAME });
  await suite('guest picking — 惡意姓名 escaping（seat-holder banner）',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 300));
      const r = await page.evaluate(payload => ({
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        bannerText: document.getElementById('pickBannerLines').textContent,
        hintText: document.getElementById('pickBannerHintText').textContent,
      }), XSS_NAME);
      ok('惡意姓名沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false, String(r.fired));
      ok('banner 仍照原樣顯示姓名', r.bannerText.includes(XSS_NAME), JSON.stringify(r.bannerText));
      ok('hint 仍照原樣顯示姓名', r.hintText.includes(XSS_NAME), JSON.stringify(r.hintText));
      return out;
    },
    { before: m.attach });
}

{
  // Distinct photos per folder, so 'which folder is on screen' is provable
  // from the grid itself, not just from which sidebar row is marked active.
  const m = pickFakeWorker({
    ownerName: 'Fiona', ownerKey: 'FIONA-KEY',
    folders: ['20260819/', '20260901/'],
    photosByFolder: {
      '20260819/': PHOTOS(3),
      '20260901/': [{ id: '20260901/q0.jpg', name: 'q0.jpg', size: 9e6, rating: 0 }],
    },
  });
  await suite('guest picking — multi-folder: the left 資料夾 panel lists every folder, switches between them, and the old path box/LOAD are gone',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('the old path input is gone from the DOM entirely',
        await page.evaluate(() => document.getElementById('driveUrl') === null));
      ok('and so is the LOAD button',
        await page.evaluate(() => document.getElementById('loadPhotosBtn') === null));

      const r1 = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        cards: document.querySelectorAll('.photo-card').length,
        panelShown: getComputedStyle(document.getElementById('folderTreeContainer')).display !== 'none',
      }));
      ok('the panel is shown', r1.panelShown === true);
      ok('both permitted folders are listed, in the token’s order',
        JSON.stringify(r1.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r1.rows));
      ok('the first folder loaded automatically', r1.cards === 3, String(r1.cards));
      ok('and it is the one highlighted',
        JSON.stringify(r1.activeRows) === JSON.stringify(['20260819/']), JSON.stringify(r1.activeRows));

      await page.click('#folderTree .tree-row[data-folder="20260901/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
        null, { timeout: 5000 });
      const r2 = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        cardName: document.querySelector('.photo-card .photo-name')?.textContent,
      }));
      ok('clicking the other folder actually loads its (different) photos',
        r2.cardName === 'q0.jpg', String(r2.cardName));
      ok('and moves the highlight to it, off the first',
        JSON.stringify(r2.activeRows) === JSON.stringify(['20260901/']), JSON.stringify(r2.activeRows));
      ok('the list is repainted, not appended to — still exactly the two folders',
        JSON.stringify(r2.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r2.rows));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'FIONA-KEY') });
}

{
  // docs/backlog.md "Guest page hides subfolders": project folder A/ has no
  // photos of its own, only in A/a/, A/b/ and A/c/ — real nested prefixes,
  // delimiter-listed by the fake exactly like worker.js's own R2 call.
  const m = pickFakeWorker({
    ownerName: 'Nina', ownerKey: 'NINA-KEY',
    folders: ['A/'],
    pickFiles: ['A/a/p0.jpg', 'A/a/p1.jpg', 'A/b/p0.jpg', 'A/c/p0.jpg'],
  });
  await suite('guest picking — subfolders: a photo-less project folder opens its first subfolder automatically, with every subfolder nested and clickable in the panel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const r1 = await page.evaluate(() => ({
        cardNames: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        labels: [...document.querySelectorAll('#folderTree .tree-row .tree-label')].map(el => el.textContent),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      }));
      ok('A/ itself has no photos, so opening it lands on its first subfolder (A/a/) automatically',
        JSON.stringify(r1.cardNames) === JSON.stringify(['p0.jpg', 'p1.jpg']), JSON.stringify(r1.cardNames));
      ok('the panel lists the project folder and every one of its subfolders, nested under it',
        JSON.stringify(r1.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/', 'A/c/']), JSON.stringify(r1.rows));
      ok('labels are the last path segment, not the full path',
        JSON.stringify(r1.labels) === JSON.stringify(['A', 'a', 'b', 'c']), JSON.stringify(r1.labels));
      ok('the subfolder actually opened (A/a/) is the one highlighted, not the empty parent',
        JSON.stringify(r1.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r1.activeRows));

      // a subfolder is reachable and clickable, not just listed
      await page.click('#folderTree .tree-row[data-folder="A/b/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
        null, { timeout: 5000 });
      const r2 = await page.evaluate(() => ({
        cardName: document.querySelector('.photo-card .photo-name')?.textContent,
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      }));
      ok('clicking a nested subfolder actually loads its own (different) photos',
        r2.cardName === 'p0.jpg', String(r2.cardName));
      ok('and moves the highlight to it', JSON.stringify(r2.activeRows) === JSON.stringify(['A/b/']), JSON.stringify(r2.activeRows));
      ok('the tree still shows every subfolder, not just the one now open',
        JSON.stringify(r2.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/', 'A/c/']), JSON.stringify(r2.rows));

      // re-opening the empty parent itself re-runs the same auto-navigate,
      // rather than showing an empty grid (rule 3's fallback never has to
      // fire here, but re-clicking the empty parent must not get stuck)
      await page.click('#folderTree .tree-row[data-folder="A/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2,
        null, { timeout: 5000 });
      const r3 = await page.evaluate(() => ({
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      }));
      ok('clicking the empty parent again re-lands on its first subfolder',
        JSON.stringify(r3.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r3.activeRows));

      // Rule 3's backstop (docs/backlog.md): rule 2's auto-navigate means the
      // page itself never actually sits in a photo-less-but-has-subfolders
      // folder, so drive applyServerSelections directly into that state, the
      // way a future caller other than handleLoadPhotos might, and check it
      // still renders the folder-card grid rather than wiping it to empty.
      const r4 = await page.evaluate(() => {
        app.currentFolders = [{ id: 'A/x/', name: 'x' }];
        app.photos = [];
        PickController.applyServerSelections();
        return {
          folderCards: document.querySelectorAll('.folder-card').length,
          photoCards: document.querySelectorAll('.photo-card').length,
        };
      });
      ok('applyServerSelections renders folder cards, not an empty photo grid, for a photo-less-with-subfolders state',
        r4.folderCards === 1 && r4.photoCards === 0, JSON.stringify(r4));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'NINA-KEY') });
}

{
  // ♥ 已選 (docs/backlog.md rule 4) must still reach a subfolder the guest
  // is not currently viewing, exactly as it already does across sibling
  // project folders (see the 已選-across-folders suite above).
  const m = pickFakeWorker({
    ownerName: 'Omar', ownerKey: 'OMAR-KEY',
    folders: ['A/'],
    pickFiles: ['A/a/p0.jpg', 'A/b/p0.jpg'],
  });
  m.state.selections.set('A/b/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — subfolders: ♥ 已選 still reaches a pick made in a sibling subfolder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const landed = await page.evaluate(() =>
        [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('landed on A/a/ (its own pick is unrated)', JSON.stringify(landed) === JSON.stringify(['p0.jpg']), JSON.stringify(landed));

      await page.click('#pickFilterBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 5000 });
      const sel = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('.photo-card')].map(el => el.dataset.photoId),
      }));
      ok('the pick made in A/b/ shows up under 已選 while viewing A/a/',
        JSON.stringify(sel.ids) === JSON.stringify(['A/b/p0.jpg']), JSON.stringify(sel.ids));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OMAR-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Gary', ownerKey: 'GARY-KEY' });
  await suite('guest picking — the annotation toolbox is removed from the DOM (no server storage for it); notes and the photo canvas stay',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });

      const r = await page.evaluate(() => ({
        toolButtons: document.querySelectorAll('.tool-btn').length,
        colorPicker: document.querySelector('.color-picker'),
        brushSlider: document.getElementById('brushSize'),
        clearAllBtn: document.getElementById('clearAnnotationBtn'),
        noteBox: document.getElementById('noteInputGroup'),
        canvas: document.getElementById('photoCanvas'),
      }));
      ok('no tool buttons (select/pan/circle/eraser/undo/redo/delete) remain',
        r.toolButtons === 0, String(r.toolButtons));
      ok('the colour picker is gone', r.colorPicker === null);
      ok('the brush-size slider is gone', r.brushSlider === null);
      ok('the 清除全部 button is gone', r.clearAllBtn === null);
      ok('the note box stays — notes are stored server-side (selections.note)',
        r.noteBox !== null);
      ok('the photo canvas itself stays — it is still the photo viewer',
        r.canvas !== null);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'GARY-KEY') });
}

{
  // Distinct photos per folder again, so the cross-folder ♥ 已選 view is
  // provably pulling from both, not just repainting the current one.
  const m = pickFakeWorker({
    ownerName: 'Iris', ownerKey: 'IRIS-KEY',
    folders: ['20260819/', '20260901/'],
    photosByFolder: {
      '20260819/': PHOTOS(3),
      '20260901/': [{ id: '20260901/q0.jpg', name: 'q0.jpg', size: 9e6, rating: 0 }],
    },
  });
  m.state.selections.set('20260819/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  m.state.selections.set('20260901/q0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — the 全部/♥已選/未選 filter bar replaces the star filter; 已選 reaches across every folder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('the star filter is gone from the DOM entirely',
        await page.evaluate(() => document.querySelector('.star-filter') === null));
      ok('so is 只看選取',
        await page.evaluate(() => document.getElementById('filterSelectedBtn') === null));
      const barShown = await page.evaluate(() =>
        getComputedStyle(document.getElementById('pickFilterBar')).display !== 'none');
      ok('the ♥ filter bar is shown instead', barShown);

      const all1 = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('全部 (default) shows the current folder’s own 3 photos',
        JSON.stringify(all1) === JSON.stringify(['p0.jpg', 'p1.jpg', 'p2.jpg']), JSON.stringify(all1));
      ok('the picked one already shows its heart on',
        await page.locator('.photo-card').first().locator('.pick-heart-btn.on').count() === 1);

      await page.click('#pickFilterBar [data-pick-filter="unselected"]');
      const unsel = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('未選 drops the already-picked one, current folder only',
        JSON.stringify(unsel) === JSON.stringify(['p1.jpg', 'p2.jpg']), JSON.stringify(unsel));

      await page.click('#pickFilterBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 5000 });
      const sel = await page.evaluate(() => ({
        names: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
        // the thumbnail for the OTHER folder's photo, loaded the same way the
        // grid loads any thumbnail — with the pick token on the URL
        otherSrc: document.querySelector('.photo-card[data-photo-id="20260901/q0.jpg"] img')?.getAttribute('src'),
      }));
      ok('♥ 已選 lists the pick from both folders, one page, sorted by key',
        JSON.stringify(sel.names) === JSON.stringify(['p0.jpg', 'q0.jpg']), JSON.stringify(sel.names));
      ok('the other folder’s thumbnail is fetched straight from its key + the pick token',
        !!sel.otherSrc && sel.otherSrc.includes('20260901/q0.jpg') && sel.otherSrc.includes('t=TOK'), sel.otherSrc);

      // un-picking from inside the cross-folder view removes it from the list
      // right there, and still autosaves the real key
      await page.locator('.photo-card[data-photo-id="20260901/q0.jpg"] .pick-heart-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 5000 });
      await page.waitForTimeout(1000);
      const lastPut = m.requests.filter(r => r.method === 'PUT').pop();
      ok('the real full-path key was sent, rating 0',
        lastPut && JSON.stringify(lastPut.body) === JSON.stringify({ upsert: [{ photo_key: '20260901/q0.jpg', rating: 0, note: '' }], delete: [] }),
        JSON.stringify(lastPut));

      await page.click('#pickFilterBar [data-pick-filter="all"]');
      const backToAll = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('全部 goes back to the current folder', JSON.stringify(backToAll) === JSON.stringify(['p0.jpg', 'p1.jpg', 'p2.jpg']), JSON.stringify(backToAll));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'IRIS-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Kelly', ownerKey: 'KELLY-KEY' });
  for (let i = 0; i < 500; i++) m.state.selections.set(`20260819/extra${i}.jpg`, { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — 409 selection_cap reverts the ♥ toggle and warns with the plan’s wording',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows 最多可選 500 張', msg === '最多可選 500 張', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.photo-card').length &&
        !document.querySelector('.photo-card').querySelector('.pick-heart-btn.on'), null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off — nothing was actually saved', revertedOk);
      const put = m.requests.filter(r => r.method === 'PUT').pop();
      ok('the refused save did carry the attempted upsert',
        put && put.body.upsert[0].rating === 1, JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'KELLY-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Quinn', ownerKey: 'QUINN-KEY' });
  // exactly PICK_MAX_ROWS existing rows, rating 0 (un-starred, so they cost
  // nothing against the star cap) and none of them the folder’s own 3 photos
  // — so the very first ♥ click adds a brand-new row and tips the row cap.
  for (let i = 0; i < 1000; i++) m.state.selections.set(`20260819/row${i}.jpg`, { rating: 0, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — 409 row_cap reverts the ♥ toggle too, with the server’s own wording',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows the server’s row-cap wording, not a made-up one',
        msg === '最多只能保留 1000 筆', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.photo-card').length &&
        !document.querySelector('.photo-card').querySelector('.pick-heart-btn.on'), null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off here too', revertedOk);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'QUINN-KEY') });
}

{
  // A key this odd never comes from a real folder listing, but the client
  // has to survive the server refusing it anyway rather than crash or lie
  // about what got saved (docs/guest-picking.md rule 7).
  const BAD_PHOTO = { id: '20260819/bad\u0000name.jpg', name: 'bad\u0000name.jpg', size: 1, rating: 0 };
  const m = pickFakeWorker({ ownerName: 'Leo', ownerKey: 'LEO-KEY', photos: [BAD_PHOTO] });
  await suite('guest picking — 400 invalid_photo_key reverts the ♥ toggle too, without crashing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows the server’s own message, not "undefined"',
        msg === '照片名稱不正確', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.pick-heart-btn.on').length === 0, null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off', revertedOk);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LEO-KEY') });
}

{
  // A viewer's own /api/pick/state response carries no `note` field at all
  // (docs/guest-picking.md) — the client must not crash or print "undefined".
  const m = pickFakeWorker({ ownerName: 'Mona' });
  m.state.selections.set('20260819/p0.jpg', { rating: 4, note: '放大這張', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — a viewer’s state has no note field; nothing crashes or shows "undefined"',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const text = await page.evaluate(() => document.body.textContent);
      ok('no stray "undefined" anywhere on the page', !/undefined/.test(text), text.slice(0, 200));
      ok('the viewer still sees the ♥ state (read-only)',
        await page.locator('.photo-card').first().locator('span.pick-heart-btn.on').count() === 1);
      return out;
    },
    { before: m.attach });
}

// A studio session (photographer, via studio_token) must be completely
// unaffected: the same path box + LOAD that guests and clients lose here is
// still how a photographer opens an arbitrary folder in the bucket.
await suite('photographer mode — the path box, LOAD button and folder tree are untouched',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!document.getElementById('studio-logout'),
      null, { timeout: 5000 }).catch(() => {});

    const r = await page.evaluate(() => ({
      inputPresent: !!document.getElementById('driveUrl'),
      loadBtnPresent: !!document.getElementById('loadPhotosBtn'),
      loadBtnShown: (() => {
        const el = document.getElementById('loadPhotosBtn');
        return !!el && getComputedStyle(el).display !== 'none';
      })(),
    }));
    ok('the path input is still there', r.inputPresent === true);
    ok('the LOAD button is still there', r.loadBtnPresent === true);
    ok('and actually shown, not just present', r.loadBtnShown === true);

    await page.fill('#driveUrl', '20260819/');
    await page.click('#loadPhotosBtn');
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    const cards = await page.evaluate(() => document.querySelectorAll('.photo-card').length);
    ok('typing a path and clicking LOAD still loads photos, exactly as before',
      cards === 3, String(cards));

    const controls = await page.evaluate(() => ({
      stars: document.querySelectorAll('.photo-card .star-rating').length,
      selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
      hearts: document.querySelectorAll('.photo-card .pick-heart-btn').length,
    }));
    ok('the star rating and select checkbox are exactly what a photographer still gets',
      controls.stars === 3 && controls.selectBtns === 3, JSON.stringify(controls));
    ok('the guest-only ♥ toggle never appears here', controls.hearts === 0, String(controls.hearts));
    return out;
  },
  {
    initScript: () => {
      try {
        if (!localStorage.getItem('__seeded_studio2')) {
          localStorage.setItem('__seeded_studio2', '1');
          sessionStorage.setItem('studio_token', 'adm');
        }
      } catch (e) { /* private mode */ }
    },
    before: pickFakeWorker().attach,
  });
}
