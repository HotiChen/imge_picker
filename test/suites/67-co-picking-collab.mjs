// Browser suites: co-picking, the JOIN and COLLABORATOR side of the guest pick page (docs/co-picking.md, batch 3):
// 我有邀請碼 (code + name, normalised to 8 ASCII digits), collaborator mode (banner, no submit / owner panel, picks and
// pins), `not_yours` put back with ONE toast, expired (我要繼續, the cooldown, the 30 s poll) and removed. js/co-picking-collab.js.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const FUTURE = ms => new Date(Date.now() + ms).toISOString();
const H = 3600000, D = 24 * H;
const XSS = '<img src=x onerror="window.__xss=1">';
const url = `${base}/index.html?t=TOK`;
const K0 = '20260819/p0.jpg', K1 = '20260819/p1.jpg', K2 = '20260819/p2.jpg';
const initKey = (key, poll) => `
  ${key ? `localStorage.setItem('pick_key:TOK', ${JSON.stringify(key)});` : ''}
  ${poll ? `window.CO_PICKING_POLL_MS = ${Number(poll)};` : ''}
`;
const world = (o = {}) => pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', ...o });
const BOB = (o = {}) => ({ name: 'Bob', key: 'BOB-KEY', expires_at: FUTURE(7 * D), ...o });
const sel = (rating, by, note = '') => ({ rating, note, marks: null, updated_by: by, updated_at: '2026-01-01T00:00:00Z' });
const reqs = (m, method, re) => m.requests.filter(r => r.method === method && re.test(r.path));
const invite = (m, code, extra = {}) => m.state.invites.push({ id: 'inv-' + code, code, window_days: 7, invited_by: 'picker-0',
  created_at: new Date().toISOString(), expires_at: FUTURE(H), used_at: null, used_by: null, ...extra });
const toasts = page => page.$$eval('#toastContainer .toast .toast-message', els => els.map(e => e.textContent));
const hearts = page => page.$$eval('.photo-card', cs => cs.map(c => !!c.querySelector('.pick-heart-btn.on')));
const heartBtns = page => page.$$eval('.photo-card button.pick-heart-btn', b => b.length);
const bannerText = page => page.evaluate(() => (document.getElementById('coCollabBanner') || {}).textContent || '');
const fillJoin = async (page, code, name) => {
  await page.fill('#coJoinCode', code);
  await page.fill('#coJoinName', name);
  await page.click('#coJoinGo');
};

// ── 1. a viewer sees 我有邀請碼; join normalises the code, stores the key, lands in collaborator mode ──
{
  const m = world();
  invite(m, '12345678');
  await suite('co-picking join — 我有邀請碼: "1234-5678" -> 8 digits sent, key stored, page becomes collaborator mode without a reload; name stays text',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { window.__marker = 1; });
      await page.waitForSelector('#coJoinOpen', { timeout: 3000 });
      ok('a viewer sees 我有邀請碼', /我有邀請碼/.test(await page.textContent('#coJoinOpen')));
      ok('a viewer has no hearts and no submit', (await heartBtns(page)) === 0);
      ok('and no owner panel', (await page.$('#coPickEntry')) === null);
      await page.click('#coJoinOpen');
      await page.waitForSelector('#coJoinSheet:not([hidden])', { timeout: 3000 });
      await fillJoin(page, '1234-5678', XSS);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      await page.waitForFunction(() => /你是協作者/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 5000 });
      const post = reqs(m, 'POST', /\/api\/pick\/join$/);
      ok('one POST /api/pick/join with exactly the 8 digits and the name as typed',
        post.length === 1 && post[0].body.code === '12345678' && post[0].body.name === XSS, JSON.stringify(post.map(r => r.body)));
      ok('no picker key was needed to join', post[0]?.key === '' && post[0]?.t === 'TOK');
      ok('the key is stored like claim does (pick_key:TOK)', (await page.evaluate(() => localStorage.getItem('pick_key:TOK'))) === 'KEY-collab-1');
      ok('the state was re-read with the new key', reqs(m, 'GET', /\/api\/pick\/state$/).some(r => r.key === 'KEY-collab-1'));
      ok('the sheet is gone and the page was not reloaded', (await page.evaluate(() => window.__marker)) === 1 && (await page.$('#coJoinSheet:not([hidden])')) === null);
      const t = await bannerText(page);
      ok('the banner says 你是協作者，到期 <Taipei time>', /^你是協作者，到期 \d+\/\d+ \d\d:\d\d/.test(t.trim()), t);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card button.pick-heart-btn').length > 0, null, { timeout: 3000 });
      ok('hearts are there now', (await heartBtns(page)) === 3);
      ok('the join button is gone', (await page.$('#coJoinOpen')) === null);
      ok('no injected element from the name', (await page.evaluate(() => window.__xss)) === undefined && (await page.$('img[src="x"]')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('') });
}

// ── 2. input normalisation, and errors in plain Chinese that never say which part was wrong ──
{
  const m = world();
  invite(m, '12345678');
  await suite('co-picking join — spaces, dashes and full-width digits are stripped to 8 ASCII digits BEFORE sending; fewer than 8 sends nothing',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coJoinOpen', { timeout: 5000 });
      await page.click('#coJoinOpen');
      const tries = [['8765 4321', '87654321'], ['8765-4321', '87654321'], ['  87654321  ', '87654321'], ['８７６５　４３２１', '87654321']];
      for (const [raw, want] of tries) {
        const before = reqs(m, 'POST', /\/join$/).length;
        await fillJoin(page, raw, 'Bob');
        await page.waitForFunction(() => /邀請碼/.test(document.getElementById('coJoinErr').textContent), null, { timeout: 3000 });
        const sent = reqs(m, 'POST', /\/join$/);
        ok(`"${raw}" is sent as ${want}`, sent.length === before + 1 && sent[sent.length - 1].body.code === want, JSON.stringify(sent.map(r => r.body.code)));
        await page.fill('#coJoinCode', '');
        await page.evaluate(() => { document.getElementById('coJoinErr').textContent = ''; });
      }
      const n = reqs(m, 'POST', /\/join$/).length;
      await fillJoin(page, '1234567', 'Bob');
      await page.waitForTimeout(200);
      ok('7 digits: nothing is sent, a hint is shown', reqs(m, 'POST', /\/join$/).length === n && /8 位/.test(await page.textContent('#coJoinErr')), await page.textContent('#coJoinErr'));
      await fillJoin(page, '12345678', '   ');
      await page.waitForTimeout(200);
      ok('an empty name: nothing is sent, 請輸入姓名', reqs(m, 'POST', /\/join$/).length === n && /請輸入姓名/.test(await page.textContent('#coJoinErr')), await page.textContent('#coJoinErr'));
      return out;
    },
    { before: m.attach, initScript: initKey('') });
}

{
  const m = world();
  await suite('co-picking join — invalid_code is ONE message; the 6th wrong code is 嘗試次數過多，請稍後再試; the sheet stays open and retryable',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coJoinOpen', { timeout: 5000 });
      await page.click('#coJoinOpen');
      const texts = [];
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => { document.getElementById('coJoinErr').textContent = ''; });
        await fillJoin(page, '0000000' + i, 'Bob');
        await page.waitForFunction(() => document.getElementById('coJoinErr').textContent !== '', null, { timeout: 3000 });
        texts.push(await page.textContent('#coJoinErr'));
      }
      ok('5 wrong codes: the same single sentence each time', new Set(texts).size === 1 && /邀請碼不正確或已失效/.test(texts[0]), JSON.stringify(texts));
      ok('and it does not say whether the name was fine', !/姓名|名字/.test(texts[0]));
      await page.evaluate(() => { document.getElementById('coJoinErr').textContent = ''; });
      await fillJoin(page, '00000009', 'Bob');
      await page.waitForFunction(() => document.getElementById('coJoinErr').textContent !== '', null, { timeout: 3000 });
      ok('the 6th: 嘗試次數過多，請稍後再試', (await page.textContent('#coJoinErr')) === '嘗試次數過多，請稍後再試', await page.textContent('#coJoinErr'));
      ok('the button is usable again (not stuck disabled)', await page.$eval('#coJoinGo', b => !b.disabled));
      ok('still no key stored', (await page.evaluate(() => localStorage.getItem('pick_key:TOK'))) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('') });
}

{
  const m = world();
  invite(m, '12345678');
  await suite('co-picking join — owner_missing / retouching / invalid_name / the server being down each get a plain sentence',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const err = async () => {
        await page.waitForFunction(() => document.getElementById('coJoinErr').textContent !== '', null, { timeout: 3000 });
        const t = await page.textContent('#coJoinErr');
        await page.evaluate(() => { document.getElementById('coJoinErr').textContent = ''; });
        return t;
      };
      await page.waitForSelector('#coJoinOpen', { timeout: 5000 });
      await page.click('#coJoinOpen');
      // maxlength only limits typing: a pasted or scripted 51-character name still reaches the server's rule
      await page.fill('#coJoinCode', '12345678');
      await page.evaluate(() => { document.getElementById('coJoinName').value = 'x'.repeat(51); });
      await page.click('#coJoinGo');
      ok('a 51-character name: invalid_name -> 請輸入 1–50 字的名字', /1–50 字/.test(await err()));
      const owner = m.state.project.owner_picker_id;
      m.state.project.owner_picker_id = null;
      await fillJoin(page, '12345678', 'Bob');
      ok('no owner: owner_missing sentence', /沒有挑選人/.test(await err()));
      m.state.project.owner_picker_id = owner;
      m.state.project.phase = 'retouching';
      await fillJoin(page, '12345678', 'Bob');
      ok('retouching: 攝影師已開始修圖', /已開始修圖/.test(await err()));
      return out;
    },
    { before: m.attach, initScript: initKey('') });
}

// ── 3. who sees the join button ──
{
  const cases = [
    ['the owner', { initKey: 'LIA-KEY' }],
    ['an active collaborator', { collaborators: [BOB()], initKey: 'BOB-KEY' }],
    ['an expired collaborator', { collaborators: [BOB({ expires_at: FUTURE(-H) })], initKey: 'BOB-KEY' }],
    ['a removed collaborator', { collaborators: [BOB({ revoked_at: FUTURE(-H) })], initKey: 'BOB-KEY' }],
    ['a viewer once the photographer is retouching', { phase: 'retouching', initKey: '' }],
  ];
  for (const [who, o] of cases) {
    const m = world({ collaborators: o.collaborators, phase: o.phase });
    await suite(`co-picking join — ${who} is not offered 我有邀請碼`,
      url,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('.photo-card', { timeout: 5000 });
        await page.waitForTimeout(400);
        ok('no join button in the DOM', (await page.$('#coJoinOpen')) === null && (await page.$('#coJoinSheet:not([hidden])')) === null);
        return out;
      },
      { before: m.attach, initScript: initKey(o.initKey) });
  }
}

// ── 4. collaborator mode ──
{
  const m = world({ collaborators: [BOB({ expires_at: null })] });
  m.state.selections.set(K0, sel(1, 'picker-0', '主人的備註'));
  await suite('co-picking collaborator — banner (到期 不限), no submit, no owner panel, hearts work and the owner\'s note is visible (390px)',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card button.pick-heart-btn', { timeout: 5000 });
      // 390px: the one-line chip in the header row replaces the banner row (suite 71 covers the chip); the sentence stays in its title
      await page.waitForSelector('#coCollabChip', { timeout: 3000 });
      const chip = await page.evaluate(() => { const c = document.getElementById('coCollabChip'); const b = document.getElementById('coCollabBanner');
        return { text: c.textContent.trim(), title: c.title, bannerShown: !!b && getComputedStyle(b).display !== 'none' }; });
      ok('chip: 協作者 · 到期不限, its title keeps 你是協作者，到期 不限', chip.text === '協作者 · 到期不限' && chip.title === '你是協作者，到期 不限', JSON.stringify(chip));
      ok('the banner row takes no space on a phone', chip.bannerShown === false, JSON.stringify(chip));
      ok('no 完成提交 button in the DOM', (await page.$('#pickSubmitBtn')) === null);
      ok('no owner panel / entry / invite UI', (await page.$('#coPickEntry')) === null && (await page.$('#coPanel')) === null && (await page.$('#coPickBar')) === null);
      ok('no "你是 Lia 嗎" reset hint, no 我有邀請碼', (await page.$('#coJoinOpen')) === null && !/你是 Lia/.test(await page.evaluate(() => document.body.innerText)));
      ok('the counter shows the owner\'s heart too (已選 1 張)', /已選 1/.test(await page.textContent('#pickCounter')), await page.textContent('#pickCounter'));
      ok('the owner\'s note reaches the page', await page.evaluate(() => PickController.selections.get('20260819/p0.jpg').note === '主人的備註'));
      await page.locator('.photo-card').nth(1).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1200);
      const put = reqs(m, 'PUT', /selections$/);
      ok('a heart is saved with the collaborator\'s key', put.length === 1 && put[0].key === 'BOB-KEY' && put[0].body.upsert[0].photo_key === K1, JSON.stringify(put));
      ok('the server wrote it as Bob\'s', m.state.selections.get(K1)?.updated_by === 'collab-1');
      ok('the heart stays on, no toast', (await hearts(page)).join() === 'true,true,false' && (await toasts(page)).length === 0, JSON.stringify(await toasts(page)));
      const lay = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
      ok('390px: no horizontal scroll', lay.sw <= lay.w, JSON.stringify(lay));
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY'), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(2 * H) })] });
  m.state.selections.set(K0, sel(1, 'collab-1'));
  await suite('co-picking collaborator — the pin tools are there on a ♥ photo (pins work like the owner\'s)',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().click({ position: { x: 20, y: 40 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForSelector('#pickModalTools', { timeout: 3000 });
      ok('the tools row exists', true);
      ok('and has the pin button for a ♥ photo', (await page.locator('#pickModalTools .pick-tools-left button').count()) > 0);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world();
  m.state.selections.set(K0, sel(1, 'picker-0'));
  await suite('co-picking owner — an owner save has no `rejected`: no toast, nothing reverted; owner sees submit',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card button.pick-heart-btn', { timeout: 5000 });
      await page.locator('.photo-card').nth(1).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1200);
      ok('the owner\'s heart stays, no toast', (await hearts(page)).join() === 'true,true,false' && (await toasts(page)).length === 0);
      ok('owner: submit button present, no collaborator banner', (await page.$('#pickSubmitBtn')) !== null && (await page.$('#coCollabBanner')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}

// ── 5. not_yours ──
{
  const m = world({ collaborators: [BOB()] });
  m.state.selections.set(K0, sel(1, 'picker-0', 'keep'));
  m.state.selections.set(K1, sel(1, 'picker-0'));
  m.state.selections.set(K2, sel(1, 'collab-1'));
  await suite('co-picking collaborator — un-hearting two of the OWNER\'s photos and one of their own in one save: the owner\'s two come back, ONE toast, their own goes',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card button.pick-heart-btn', { timeout: 5000 });
      ok('start: all three hearted', (await hearts(page)).join() === 'true,true,true', (await hearts(page)).join());
      for (const i of [0, 1, 2]) await page.locator('.photo-card').nth(i).locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.pick-heart-btn.on').length === 2, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      ok('one PUT', reqs(m, 'PUT', /selections$/).length === 1, String(reqs(m, 'PUT', /selections$/).length));
      ok('the owner\'s two are ON again on screen, their own is off', (await hearts(page)).join() === 'true,true,false', (await hearts(page)).join());
      ok('the page state agrees (no optimistic leftovers)', await page.evaluate(() => {
        const s = PickController.selections;
        return s.get('20260819/p0.jpg')?.rating === 1 && s.get('20260819/p1.jpg')?.rating === 1 && !(s.get('20260819/p2.jpg')?.rating > 0);
      }));
      ok('the counter is 已選 2 張', /已選 2/.test(await page.textContent('#pickCounter')), await page.textContent('#pickCounter'));
      const t = (await toasts(page)).filter(x => /這張是別人選的/.test(x));
      ok('exactly ONE toast, 這張是別人選的，只有主人可以改', t.length === 1 && t[0] === '這張是別人選的，只有主人可以改' && (await toasts(page)).length === 1, JSON.stringify(await toasts(page)));
      ok('the server kept the owner\'s rows untouched', m.state.selections.get(K0).updated_by === 'picker-0' && m.state.selections.get(K0).note === 'keep' && m.state.selections.has(K1) && !m.state.selections.has(K2));
      // a second save with a new rejection toasts again (per save, not once per page)
      await page.waitForTimeout(3600);
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1300);
      ok('another rejected save -> another toast', (await toasts(page)).filter(x => /這張是別人選的/.test(x)).length === 1 && reqs(m, 'PUT', /selections$/).length === 2);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

// ── 6. expired / removed ──
{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-H) })] });
  await suite('co-picking expired — read-only like a viewer, 協作已到期 + 我要繼續; click asks the owner, then 已通知主人，等待核准, and a reload shows the same',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#coCollabBanner', { timeout: 3000 });
      ok('banner says 協作已到期', /協作已到期/.test(await bannerText(page)), await bannerText(page));
      ok('read-only: no hearts', (await heartBtns(page)) === 0);
      ok('not offered a join', (await page.$('#coJoinOpen')) === null);
      ok('button 我要繼續', /我要繼續/.test(await page.textContent('#coRenewBtn')));
      await page.click('#coRenewBtn');
      await page.waitForFunction(() => /已通知主人，等待核准/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 3000 });
      const post = reqs(m, 'POST', /\/renewal$/);
      ok('one POST /api/pick/renewal with the key', post.length === 1 && post[0].key === 'BOB-KEY');
      ok('the button is gone', (await page.$('#coRenewBtn')) === null);
      await page.reload();
      await page.waitForFunction(() => /已通知主人，等待核准/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 5000 });
      ok('after a reload the waiting message is still there, still no button', (await page.$('#coRenewBtn')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const declinedAt = new Date(Date.now() - H).toISOString();
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-D), renewal_requested_at: 'declined:' + declinedAt })] });
  await suite('co-picking expired — the owner declined less than a day ago: 主人暫未同意，<time> 之後可再申請, no button',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      const t = await bannerText(page);
      const want = await page.evaluate(d => Util.fmtDate(new Date(Date.parse(d) + 86400000).toISOString(), 'mdhm'), declinedAt);
      ok('message with the cooldown end in Taipei time', t.includes(`主人暫未同意，${want} 之後可再申請`), `${t} / ${want}`);
      ok('no 我要繼續 button', (await page.$('#coRenewBtn')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-2 * D), renewal_requested_at: 'declined:' + new Date(Date.now() - 25 * H).toISOString() })] });
  await suite('co-picking expired — a decline older than 24 h is over: the button is back',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewBtn', { timeout: 5000 });
      ok('button shown, no 暫未同意 text', !/暫未同意/.test(await bannerText(page)));
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-D) })] });
  await suite('co-picking expired — the owner declines between load and click: 409 renewal_declined shows the same cooldown message',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewBtn', { timeout: 5000 });
      m.state.collaborators.get('collab-1').renewal_requested_at = 'declined:' + new Date(Date.now() - H).toISOString();
      await page.click('#coRenewBtn');
      await page.waitForFunction(() => /主人暫未同意/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 3000 });
      ok('cooldown message with a time', /主人暫未同意，\d+\/\d+ \d\d:\d\d 之後可再申請/.test(await bannerText(page)), await bannerText(page));
      ok('no button', (await page.$('#coRenewBtn')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-H), renewal_requested_at: new Date().toISOString() })] });
  await suite('co-picking expired — waiting for approval: the page polls state (every 30 s, here 300 ms) and the approval appears WITHOUT a reload',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      await page.evaluate(() => { window.__marker = 7; });
      ok('waiting message, no hearts', /等待核准/.test(await bannerText(page)) && (await heartBtns(page)) === 0);
      await page.waitForTimeout(1000);
      const polls = reqs(m, 'GET', /\/state$/).length;
      ok('it kept polling state meanwhile', polls >= 3, String(polls));
      m.state.collaborators.get('collab-1').expires_at = FUTURE(7 * D);   // the owner approved
      m.state.collaborators.get('collab-1').renewal_requested_at = null;
      await page.waitForFunction(() => /你是協作者/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 4000 });
      await page.waitForFunction(() => document.querySelectorAll('.photo-card button.pick-heart-btn').length > 0, null, { timeout: 3000 });
      ok('collaborator mode appeared on its own, same page (no reload)', (await page.evaluate(() => window.__marker)) === 7);
      const after = reqs(m, 'GET', /\/state$/).length;
      await page.waitForTimeout(1000);
      ok('and polling stopped', reqs(m, 'GET', /\/state$/).length === after, `${after} -> ${reqs(m, 'GET', /\/state$/).length}`);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY', 300) });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-H) })] });
  await suite('co-picking expired — NOT waiting for approval (no request yet): no polling at all',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewBtn', { timeout: 5000 });
      const n = reqs(m, 'GET', /\/state$/).length;
      await page.waitForTimeout(1200);
      ok('state is not re-read', reqs(m, 'GET', /\/state$/).length === n, `${n} -> ${reqs(m, 'GET', /\/state$/).length}`);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY', 300) });
}

{
  const m = world({ collaborators: [BOB({ revoked_at: FUTURE(-H) })] });
  await suite('co-picking removed — plain read-only message, no button, no hearts; the stored key is kept (the server keeps answering "removed")',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      ok('message 你已不是協作者', /你已不是協作者/.test(await bannerText(page)), await bannerText(page));
      ok('no buttons inside it', (await page.$$('#coCollabBanner button')).length === 0);
      ok('no hearts', (await heartBtns(page)) === 0);
      ok('key kept', (await page.evaluate(() => localStorage.getItem('pick_key:TOK'))) === 'BOB-KEY');
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB()] });
  await suite('co-picking — a save answered 403 collaborator_expired: the heart is put back and the page drops to read-only with the expired banner',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card button.pick-heart-btn', { timeout: 5000 });
      m.state.collaborators.get('collab-1').expires_at = FUTURE(-1000);
      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => /協作已到期/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 5000 });
      ok('banner 協作已到期 with 我要繼續', (await page.$('#coRenewBtn')) !== null);
      ok('no hearts left on screen (read-only), nothing optimistic remains', (await heartBtns(page)) === 0 && !(await page.evaluate(() => PickController.selections.size)));
      ok('the PUT was tried exactly once (no retry loop)', reqs(m, 'PUT', /selections$/).length === 1);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB()] });
  await suite('co-picking — a save answered 403 collaborator_removed: read-only with the removed message',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card button.pick-heart-btn', { timeout: 5000 });
      m.state.collaborators.get('collab-1').revoked_at = new Date().toISOString();
      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => /你已不是協作者/.test((document.getElementById('coCollabBanner') || {}).textContent || ''), null, { timeout: 5000 });
      ok('no button, no hearts', (await page.$('#coRenewBtn')) === null && (await heartBtns(page)) === 0);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

// ── 7. the join sheet at 390px ──
{
  const m = world();
  await suite('co-picking join — the sheet fits a 390px phone: no horizontal scroll, touch-sized controls, 16px inputs (no iOS zoom), closes with ×',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coJoinOpen', { timeout: 5000 });
      const entry = await page.$eval('#coJoinOpen', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height, vw: innerWidth }; });
      ok('the entry is inside the screen and touch-sized', entry.l >= 0 && entry.r <= entry.vw && entry.h >= 40, JSON.stringify(entry));
      await page.click('#coJoinOpen');
      await page.waitForSelector('#coJoinSheet:not([hidden])');
      const lay = await page.evaluate(() => {
        const q = id => document.getElementById(id).getBoundingClientRect();
        const fs = id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
        return { sw: document.documentElement.scrollWidth, w: innerWidth, sheet: q('coJoinSheet'), go: q('coJoinGo').height, code: q('coJoinCode').height,
          fsCode: fs('coJoinCode'), fsName: fs('coJoinName'), mode: document.getElementById('coJoinCode').inputMode };
      });
      ok('no horizontal scroll, the sheet sits inside the screen', lay.sw <= 390 && lay.sheet.left >= 0 && lay.sheet.right <= 390, JSON.stringify(lay));
      ok('buttons and inputs ≥ 40px', lay.go >= 40 && lay.code >= 40);
      ok('inputs are 16px (iOS does not zoom) and the code asks for a numeric keypad', lay.fsCode >= 16 && lay.fsName >= 16 && lay.mode === 'numeric', JSON.stringify(lay));
      await page.click('#coJoinSheet .co-close');
      ok('× closes it', (await page.$('#coJoinSheet:not([hidden])')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey(''), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [BOB({ expires_at: FUTURE(-H) })], decorateState: r => { r.can_request_renewal = false; } });
  await suite('co-picking expired — the state says no renewal is possible (none asked, no cooldown): text only, no button',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      ok('banner says 協作已到期, no 我要繼續', /協作已到期/.test(await bannerText(page)) && (await page.$('#coRenewBtn')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

{
  const m = world({ collaborators: [BOB()], decorateState: r => { r.can_edit = false; } });
  await suite('co-picking collaborator — role collaborator but can_edit false: treated as read-only (no interactive hearts)',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('no interactive hearts', (await heartBtns(page)) === 0);
      return out;
    },
    { before: m.attach, initScript: initKey('BOB-KEY') });
}

}
