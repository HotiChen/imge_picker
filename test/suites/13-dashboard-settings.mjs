// Browser suites: home login, dashboard, studio settings, logo upload, default plan, branding on
// the pick page.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, adminMock } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, SEED_TOKEN_ALWAYS, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

await suite('入口 — 未登入時看到品牌、三張特色卡與手機示意圖，並提供攝影師登入',
  `${base}/home.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    ok('the pitch line is on the page', (await page.textContent('body')).includes('讓客人在手機上輕鬆選片，你專心修圖'));
    const cardTitles = await page.$$eval('.feature-card h3', els => els.map(e => e.textContent));
    ok('three feature cards, in order', JSON.stringify(cardTitles) ===
      JSON.stringify(['傳連結，手機就能選', '送出即通知，加選自動算', '開始精修，選片就鎖定']), JSON.stringify(cardTitles));
    const pitch = await page.textContent('.pitch');
    ok('the sub-line adds to the headline instead of repeating it', !pitch.includes('讓客人在手機上輕鬆選片'), pitch);
    ok('the secondary button is not underlined',
      (await page.$eval('.btn-ghost', e => getComputedStyle(e).textDecorationLine)) === 'none');
    ok('the mock tiles are not all the same colour',
      new Set(await page.$$eval('.phone-tile', els => els.map(e => getComputedStyle(e).backgroundColor))).size >= 4);
    ok('a phone mock is built from CSS/markup, not an <img>',
      (await page.$('.phone-mock')) !== null && (await page.$('.phone-mock img')) === null);
    ok('no external script tags', (await page.$$eval('script[src]', els =>
      els.every(e => !/^https?:|^\/\//.test(e.getAttribute('src'))))));

    // Bright design (Tim-approved, /tmp/claude-0/light-design.html): cream
    // ground, dark-ink text. Pin the exact approved tokens rather than just
    // computing a contrast ratio, so a palette drift is caught even if it
    // still happens to clear 4.5:1.
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('page ground is the approved cream, not the old dark theme',
      bodyBg === 'rgb(255, 248, 238)', bodyBg);
    const pitchColor = await page.$eval('.pitch', e => getComputedStyle(e).color);
    ok('body text is the approved dark ink (#5b4f42), readable on cream',
      pitchColor === 'rgb(91, 79, 66)', pitchColor);
    const btnColor = await page.$eval('#heroLoginBtn', e => getComputedStyle(e).color);
    ok('primary button text is the approved dark ink (#231b12), readable on the accent',
      btnColor === 'rgb(35, 27, 18)', btnColor);

    const clientLink = await page.$eval('a[href="client-login.html"]', e => e.textContent.trim()).catch(() => null);
    ok('a 客戶登入 link to client-login.html is in the header', clientLink === '客戶登入', String(clientLink));

    await page.click('#heroLoginBtn');
    await page.waitForSelector('#loginOverlay.open', { timeout: 3000 });
    ok('login overlay opens', true);
    return out;
  });

{
  const m = dashSettingsMock({ token: 'right-pw' });
  await suite('入口 — 攝影師登入：密碼錯誤顯示提示，正確密碼存 studio_token 並跳轉到 dashboard.html',
    `${base}/home.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      await page.click('#photographerLoginBtn');
      await page.fill('#loginTokenInput', 'wrong-pw');
      await page.click('#loginSubmitBtn');
      await page.waitForTimeout(300);
      const err1 = await page.textContent('#loginErr');
      ok('wrong password shows 密碼錯誤', err1.trim() === '密碼錯誤', err1);
      ok('nothing was stored on the wrong attempt',
        await page.evaluate(() => sessionStorage.getItem('studio_token')) === null);

      await page.fill('#loginTokenInput', 'right-pw');
      await page.click('#loginSubmitBtn');
      await page.waitForURL('**/dashboard.html', { timeout: 3000 });
      const stored = await page.evaluate(() => sessionStorage.getItem('studio_token'));
      ok('the real token landed in sessionStorage.studio_token, nowhere else', stored === 'right-pw', stored);
      return out;
    },
    { before: m.attach });
}

await suite('入口 — 已經登入過（sessionStorage 已有 studio_token）直接跳轉到 dashboard.html',
  `${base}/home.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/dashboard.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to dashboard.html', /dashboard\.html/.test(page.url()), page.url());
    return out;
  },
  { initScript: SEED_TOKEN_ALWAYS });

await suite('儀表板 — 沒有 studio_token 時，還沒發出任何請求就先跳轉回 home.html',
  `${base}/dashboard.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html/.test(page.url()), page.url());
    return out;
  });

{
  const m = dashSettingsMock({
    stats: {
      by_phase: { picking: 3, submitted: 2, retouching: 1 }, delivered: 5, archived: 1,
      per_month: [
        { month: '2026-08', created: 4, delivered: 2 },
        { month: '2026-09', created: 8, delivered: 4 },
      ],
      todo: { submitted_not_retouching: 2, unnotified_submissions: 1, modified_after_submit: 0 },
    },
    projects: [
      { id: 'p1', title: '海邊系列', phase: 'retouching', delivered_at: null },
      { id: 'p2', title: '婚紗', phase: 'retouching', delivered_at: '2026-09-20T00:00:00.000Z' },
    ],
  });
  await suite('儀表板 — 卡片、長條圖與待處理清單都照 /api/admin/stats 的資料畫',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      await page.waitForFunction(() => document.getElementById('stat-picking').textContent !== '–', null, { timeout: 5000 });
      const nums = await page.evaluate(() => ['stat-picking', 'stat-submitted', 'stat-retouching', 'stat-delivered']
        .map(id => document.getElementById(id).textContent));
      ok('選片中/已送出/精修中/已交件 counts', JSON.stringify(nums) === JSON.stringify(['3', '2', '1', '5']), JSON.stringify(nums));

      // per_month's max value (8, September's created) must be the tallest
      // bar (100%); everything else scales relative to it — a stats-mapping
      // mutant (e.g. always 100%, or delivered/created swapped) breaks this.
      const heights = await page.$$eval('#stat-chart .chart-col', cols => cols.map(c => ({
        created: c.querySelector('.chart-bar.created').style.height,
        delivered: c.querySelector('.chart-bar.delivered').style.height,
      })));
      ok('two months rendered', heights.length === 2, JSON.stringify(heights));
      ok('September (the max) created bar is 100%', heights[1]?.created === '100%', JSON.stringify(heights));
      ok('August created (4/8) is 50%', heights[0]?.created === '50%', JSON.stringify(heights));
      ok('August delivered (2/8) is 25%, not swapped with created', heights[0]?.delivered === '25%', JSON.stringify(heights));

      const todoText = await page.textContent('#todo-list');
      ok('待處理 shows all three non-zero counts',
        todoText.includes('2') && todoText.includes('已送出但尚未開始精修') &&
        todoText.includes('1') && todoText.includes('尚未寄信通知') &&
        !todoText.includes('個專案送出後又被修改'), todoText);
      const todoLinks = await page.$$eval('#todo-list a', els => els.map(e => e.getAttribute('href')));
      ok('待處理 items link into admin.html#projects', todoLinks.every(h => h === 'admin.html#projects'), JSON.stringify(todoLinks));

      const recentLinks = await page.$$eval('#recent-projects a', els => els.map(e => e.getAttribute('href')));
      ok('recent projects link to admin.html#project=<id>',
        JSON.stringify(recentLinks) === JSON.stringify(['admin.html#project=p1', 'admin.html#project=p2']), JSON.stringify(recentLinks));
      const deliveredBadges = await page.$$eval('.recent-row', rows => rows.map(r => r.textContent.includes('已交件')));
      ok('only the delivered project shows 已交件', JSON.stringify(deliveredBadges) === JSON.stringify([false, true]), JSON.stringify(deliveredBadges));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('儀表板 — 全部待處理歸零時顯示「目前沒有待處理事項」，側邊選單標出目前頁面並可登出',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#todo-list .todo-empty', { timeout: 5000 });
      ok('says nothing pending', (await page.textContent('#todo-list')).includes('目前沒有待處理事項'));

      const navHrefs = await page.$$eval('.side-nav-item[href]', els => els.map(e => e.getAttribute('href')));
      ok('side menu has every destination, 訂單 after 選片專案',
        JSON.stringify(navHrefs) === JSON.stringify(['dashboard.html', 'admin.html#projects', 'orders.html', 'admin.html#clients', 'index.html', 'upload.html', 'book_editor/', 'settings.html']),
        JSON.stringify(navHrefs));
      const active = await page.$eval('.side-nav-item.active', e => e.textContent);
      ok('儀表板 is marked active on this page', active === '儀表板', active);

      await page.click('.side-nav-logout');
      await page.waitForURL('**/home.html', { timeout: 3000 });
      ok('logout clears the token and leaves for home.html, which stays put (no token to bounce it back)',
        /home\.html$/.test(page.url()) &&
        (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null,
        page.url());
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

await suite('設定 — 沒有 studio_token 時跳轉回 home.html',
  `${base}/settings.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html/.test(page.url()), page.url());
    return out;
  });

{
  const m = dashSettingsMock({ settings: { studio_name: '某某影像', booking_url: 'https://example.com/book', default_pick_limit: 30, default_extra_price: 100 } });
  await suite('設定 — 讀出既有設定並帶入表單，儲存後顯示已儲存',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-studio-name').value !== '', null, { timeout: 5000 });
      const vals = await page.evaluate(() => ({
        name: document.getElementById('set-studio-name').value,
        url: document.getElementById('set-booking-url').value,
        limit: document.getElementById('set-default-pick-limit').value,
        price: document.getElementById('set-default-extra-price').value,
      }));
      ok('fields are prefilled from GET /api/admin/settings',
        vals.name === '某某影像' && vals.url === 'https://example.com/book' && vals.limit === '30' && vals.price === '100',
        JSON.stringify(vals));

      await page.fill('#set-studio-name', '新名字');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings');
      ok('PUT carried the edited name', put?.body?.studio_name === '新名字', JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('設定 — 預約網址不是 https:// 時擋在前端，不會打到 Worker',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#set-save-btn', { timeout: 5000 });
      await page.fill('#set-booking-url', 'http://not-secure.example.com');
      await page.click('#set-save-btn');
      await page.waitForTimeout(300);
      const err = await page.textContent('#set-err');
      ok('client shows the https-only message', err.includes('https://'), err);
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings');
      ok('no PUT was sent for an http:// url', put === undefined, JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  // A url that passes the client's startsWith check but the server still
  // rejects (whitespace, control chars, user:pass@, docs/dashboard-settings.md)
  // — the server's invalid_booking_url has to reach the screen, not just the
  // client-side guard's own wording.
  const m = dashSettingsMock({ settingsPutStatus: 400, settingsPutBody: { error: 'bad url', code: 'invalid_booking_url' } });
  await suite('設定 — 伺服器回報 invalid_booking_url 時顯示對應錯誤訊息',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#set-save-btn', { timeout: 5000 });
      await page.fill('#set-booking-url', 'https://ok-looking.example.com');
      await page.click('#set-save-btn');
      await page.waitForTimeout(300);
      const err = await page.textContent('#set-err');
      ok('shows the server-side https validation message', err.includes('https://'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('設定 — Logo 上傳：超過 200KB 或非允許格式在前端就擋下，成功後顯示預覽與移除鍵',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });

      // 200 KB + 1 byte — client-side rejected, no request to the Worker
      await page.setInputFiles('#logo-file-input', {
        name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(204801, 1),
      });
      await page.waitForTimeout(200);
      let err = await page.textContent('#logo-err');
      ok('oversized file rejected client-side', err.includes('200 KB'), err);
      ok('no logo PUT was sent for it', m.seen.find(r => r.path === '/api/admin/settings/logo') === undefined);

      await page.setInputFiles('#logo-file-input', {
        name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>'),
      });
      await page.waitForTimeout(200);
      err = await page.textContent('#logo-err');
      ok('unsupported type rejected client-side', err.includes('PNG'), err);

      ok('no remove button before any logo exists', await page.isHidden('#logo-remove-btn'));

      await page.setInputFiles('#logo-file-input', {
        name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]),
      });
      await page.waitForFunction(() => !document.getElementById('logo-remove-btn').style.display ||
        document.getElementById('logo-remove-btn').style.display !== 'none', null, { timeout: 3000 });
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings/logo');
      ok('the good file reached the Worker', !!put, JSON.stringify(m.seen));
      ok('and a preview <img> is shown', await page.$('#logo-preview-box img') !== null);

      await page.click('#logo-remove-btn');
      await page.waitForFunction(() => document.getElementById('logo-remove-btn').style.display === 'none', null, { timeout: 3000 });
      const del = m.seen.find(r => r.method === 'DELETE' && r.path === '/api/admin/settings/logo');
      ok('remove sent a DELETE', !!del, JSON.stringify(m.seen));
      ok('preview reverts to the empty state', (await page.textContent('#logo-preview-box')).includes('尚未上傳'));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ logoPutStatus: 413, logoPutBody: { error: 'too large', code: 'too_large' } });
  await suite('設定 — 伺服器回 413 時顯示檔案過大訊息（用來覆蓋前端漏放過去的情況）',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });
      await page.setInputFiles('#logo-file-input', { name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
      await page.waitForTimeout(300);
      const err = await page.textContent('#logo-err');
      ok('shows the 200 KB message from a server 413', err.includes('200 KB'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ logoPutStatus: 415, logoPutBody: { error: 'bad type', code: 'unsupported_type' } });
  await suite('設定 — 伺服器回 415 時顯示不支援格式訊息',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });
      await page.setInputFiles('#logo-file-input', { name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
      await page.waitForTimeout(300);
      const err = await page.textContent('#logo-err');
      ok('shows the unsupported-format message from a server 415', err.includes('PNG'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  // admin.html's project-create form prefills from the studio's saved
  // defaults, but only into a field the photographer has not already typed
  // into — the mutant this guards is "always overwrite".
  const m = adminMock({ clients: [] });
  m.attach = (orig => async page => {
    await orig(page);
    await page.route('**/imagepicker.hotichen.workers.dev/api/admin/settings', route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ studio_name: 'S', booking_url: null, default_pick_limit: 25, default_extra_price: 150, has_logo: false }) }));
  })(m.attach);
  await suite('設定 — 預設方案（張數/單價）帶入 admin.html 的新專案表單，且不覆蓋已輸入的值',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('proj-pick-limit').value !== '', null, { timeout: 5000 });
      const vals = await page.evaluate(() => ({
        limit: document.getElementById('proj-pick-limit').value,
        price: document.getElementById('proj-extra-price').value,
      }));
      ok('prefilled from the studio defaults', vals.limit === '25' && vals.price === '150', JSON.stringify(vals));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest pick page — studio branding (docs/dashboard-settings.md)
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({
    ownerName: 'Ann', ownerKey: 'ANN-KEY',
    studio: { name: '海邊影像工作室', booking_url: 'https://booking.example.com/x', has_logo: true },
  });
  await suite('選片頁 — 顯示工作室名稱與 Logo，沒有預約拍攝按鈕',
    `${base}/index.html?t=PICK-TOKEN`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.evaluate(() => localStorage.setItem('pick_key:PICK-TOKEN', 'ANN-KEY'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作室', null, { timeout: 5000 });
      ok('logo-name replaced with the studio name', true);
      const img = await page.$eval('.logo-mark-img', el => ({ src: el.src, alt: el.alt })).catch(() => null);
      ok('the text mark is replaced by an <img> for the logo', !!img && img.src.includes('/api/studio/logo'), JSON.stringify(img));
      ok('no 預約拍攝 button exists on the guest page at all (removed, not hidden), booking_url or not',
        (await page.$('#studioBookingLink')) === null && !(await page.evaluate(() => document.body.innerText.includes('預約拍攝'))));
      return out;
    },
    { before: m.attach });
}

{
  // The https guard is the one line worth mutation-testing here: anything
  // else (http://, //evil, javascript:, empty) must leave the link hidden
  // with its href untouched, never fall through to "set it anyway".
  const m = pickFakeWorker({
    ownerName: 'Ben', ownerKey: 'BEN-KEY',
    studio: { name: 'S', booking_url: 'http://not-secure.example.com', has_logo: false },
  });
  await suite('選片頁 — 非 https 的 booking_url 也沒有預約按鈕',
    `${base}/index.html?t=PICK-TOKEN`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.evaluate(() => localStorage.setItem('pick_key:PICK-TOKEN', 'BEN-KEY'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === 'S', null, { timeout: 5000 });
      ok('no 預約拍攝 button either for an http:// booking_url (element is null)', (await page.$('#studioBookingLink')) === null);
      ok('no logo <img> is added when has_logo is false', (await page.$('.logo-mark-img')) === null);
      return out;
    },
    { before: m.attach });
}
}
