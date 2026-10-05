// Browser suites: guest 確認完成 / 需要修改 flow, error mapping and stale-page handling.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { LUM, doneOpts, donePosts, modalShown } from '../lib/delivery-helpers.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const AS_OWNER = () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY');
const CONFIRMED_UP = () => document.getElementById('deliveryDone')?.dataset.state === 'confirmed' || !!document.getElementById('completionPage');
const stateGets = m => m.requests.filter(r => r.method === 'GET' && r.path === '/api/pick/state').length;
// EDITED with the 完成頁 (suite 33): a confirmed delivery no longer shows the 驗收頁's status block but the
// light completion page, so for that state this reads the page's 已確認完成（date） line as the same
// "state confirmed, ✓ status, no buttons" (the 完成頁 itself is asserted in 33-completion-page.mjs).
const doneBlock = page => page.evaluate(() => {
  const el = document.getElementById('deliveryDone');
  if (!el) {
    const cp = document.getElementById('completionPage');
    if (!cp) return null;
    return { state: 'confirmed', status: `✓ ${document.getElementById('cpConfirmed').textContent}`, msg: null, msgEl: false,
      buttons: [...document.querySelectorAll('#doneConfirmBtn, #doneReviseBtn')].map(b => b.textContent) };
  }
  return { state: el.dataset.state, status: document.getElementById('deliveryDoneStatus')?.textContent ?? null,
    msg: document.getElementById('deliveryDoneMsg')?.textContent ?? null,
    msgEl: !!document.getElementById('deliveryDoneMsg'),
    buttons: [...el.querySelectorAll('button')].map(b => b.textContent) };
});

// ── owner: block, buttons, confirm modal, confirmed state — desktop and phone
for (const [label, co] of [['1280px', { viewport: { width: 1280, height: 900 } }], ['390px', MOBILE]]) {
  const m = pickFakeWorker(doneOpts());
  await suite(`guest 確認完成 ${label} — owner: block + two buttons, confirm modal, then ✓ 已確認完成 with no buttons`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const narrow = label === '390px';
      await page.waitForSelector('#deliveryDone .btn', { timeout: 5000 });
      ok('fixture: delivered, not confirmed, owner seat', m.state.project.delivered_at !== null && m.state.project.client_confirmed_at === null);
      const b0 = await doneBlock(page);
      ok('the block shows in the open state with 確認完成 and 需要修改', b0.state === 'open' && JSON.stringify(b0.buttons) === '["確認完成","需要修改"]', JSON.stringify(b0));
      ok('the status line tells what the buttons are for', /確認完成/.test(b0.status) && /需要修改/.test(b0.status), b0.status);
      ok('block sits right under the delivery bar, in the page (not hidden, inside the viewport width)',
        await page.evaluate(() => {
          const bar = document.getElementById('deliveryBar'), el = document.getElementById('deliveryDone');
          const r = el.getBoundingClientRect();
          return bar.nextElementSibling === el && r.height > 20 && r.left >= 0 && r.right <= innerWidth + 0.5;
        }));
      const geo = await page.evaluate(() => [...document.querySelectorAll('#deliveryDone button')].map(b => {
        const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, d: getComputedStyle(b).display };
      }));
      ok('both buttons are rendered, tappable size', geo.length === 2 && geo.every(g => g.d !== 'none' && g.w > 60 && g.h >= (narrow ? 44 : 38)), JSON.stringify(geo));
      ok('the page is still the dark client theme: dark body, dark block, light text',
        await page.evaluate(`(() => { const L = ${LUM}; const cs = s => getComputedStyle(document.querySelector(s));
          return L(cs('body').backgroundColor) < 0.2 && L(cs('#deliveryDone').backgroundColor) < 0.25 && L(cs('#deliveryDoneStatus').color) > 0.6; })()`));
      ok('the confirm modal is closed to begin with', !(await modalShown(page, 'doneConfirmModal')));
      if (narrow) ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

      await page.click('#doneConfirmBtn');
      ok('确認 modal opens', await modalShown(page, 'doneConfirmModal'));
      const mt = await page.textContent('#doneConfirmModal');
      ok('it says the photographer is notified and later changes go through the photographer', /攝影師會收到通知/.test(mt) && /聯絡攝影師/.test(mt), mt);
      if (narrow) {
        const r = await page.$eval('#doneConfirmModal .modal-content', e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: innerWidth, h: innerHeight }; });
        ok('on a phone the modal is fully inside the viewport', r.t >= 0 && r.b <= r.h && r.l >= 0 && r.r <= r.w, JSON.stringify(r));
      }
      await page.click('#doneConfirmCancel');
      ok('取消 closes it and sends nothing', !(await modalShown(page, 'doneConfirmModal')) && donePosts(m, 'confirm').length === 0);

      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
      const posts = donePosts(m, 'confirm');
      ok('exactly one POST /api/pick/confirm, with this link\'s token and seat key, body {}',
        posts.length === 1 && posts[0].t === 'TOK' && posts[0].key === 'ZOE-KEY' && JSON.stringify(posts[0].body) === '{}', JSON.stringify(posts));
      const b1 = await doneBlock(page);
      ok('the status reads ✓ 已確認完成（date）', /^✓ 已確認完成（\d{4}\/\d{1,2}\/\d{1,2}）$/.test(b1.status), b1.status);
      ok('no button is left in the block, and the button ids are gone from the DOM', b1.buttons.length === 0 &&
        (await page.$('#doneConfirmBtn')) === null && (await page.$('#doneReviseBtn')) === null);
      ok('the modals are removed from the DOM, not just closed', (await page.$('#doneConfirmModal')) === null && (await page.$('#doneReviseModal')) === null);
      ok('the Worker recorded it as the guest\'s', m.state.project.client_confirmed_by === 'guest');
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#deliveryDone, #completionPage', { timeout: 5000 });
      const b2 = await doneBlock(page);
      ok('after a reload the confirmed state comes from the Worker: ✓ and still no buttons', b2.state === 'confirmed' && b2.buttons.length === 0 && /^✓ 已確認完成/.test(b2.status), JSON.stringify(b2));
      if (process.env.SHOTS_DONE) await page.screenshot({ path: `${process.env.SHOTS_DONE}/guest-confirmed-${label}.png` });
      return out;
    },
    { before: m.attach, initScript: AS_OWNER, contextOptions: co });
}

// ── the screenshots of the other states (only when asked for)
if (process.env.SHOTS_DONE) {
  for (const [label, co] of [['1280px', { viewport: { width: 1280, height: 900 } }], ['390px', MOBILE]]) {
    const m = pickFakeWorker(doneOpts());
    await suite(`guest 確認完成 ${label} — screenshots`,
      `${base}/index.html?t=TOK`,
      async page => {
        const dir = process.env.SHOTS_DONE;
        await page.waitForSelector('#deliveryDone .btn', { timeout: 5000 });
        await page.screenshot({ path: `${dir}/guest-initial-${label}.png` });
        await page.click('#doneConfirmBtn');
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/guest-confirm-modal-${label}.png` });
        await page.click('#doneConfirmCancel');
        await page.click('#doneReviseBtn');
        await page.fill('#doneReviseText', 'f1.jpg 膚色偏黃，想再自然一點\n第二張的背景請把路人修掉');
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/guest-revise-modal-${label}.png` });
        await page.click('#doneReviseSubmit');
        await page.waitForFunction(() => document.getElementById('deliveryDone')?.dataset.state === 'revising');
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${dir}/guest-revising-${label}.png` });
        return [];
      },
      { before: m.attach, initScript: AS_OWNER, contextOptions: co });
  }
}

// ── viewer: status text only, never buttons, never the guest's words
for (const [name, extra, expectState, statusRe] of [
  ['open', {}, 'open', /尚待選片人確認完成/],
  ['revising', { revisions: [{ message: '小明的修改要求 SECRET-TEXT', picker_id: 'picker-0' }] }, 'revising', /^攝影師修改中$/],
  ['confirmed', { confirmedAt: '2026-09-21T03:00:00.000Z' }, 'confirmed', /^✓ 已確認完成（2026\/9\/21）$/],
]) {
  const m = pickFakeWorker(doneOpts(extra));
  await suite(`guest 確認完成 — viewer (${name}): status text, no buttons, no modal, no guest message`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#deliveryDone, #completionPage', { timeout: 5000 });
      await page.waitForSelector('.fg-tile', { timeout: 5000 });   // the finals gallery (was .photo-card)
      const b = await doneBlock(page);
      ok(`block in state ${expectState} with the status text`, b.state === expectState && statusRe.test(b.status), JSON.stringify(b));
      ok('a viewer has no button at all, and no modal in the DOM', b.buttons.length === 0 && (await page.$('#doneConfirmBtn')) === null &&
        (await page.$('#doneReviseBtn')) === null && (await page.$('#doneConfirmModal')) === null && (await page.$('#doneReviseModal')) === null);
      ok('no message element is reserved, and the guest\'s text is nowhere on the page',
        b.msgEl === false && !(await page.evaluate(() => document.body.innerText.includes('SECRET-TEXT'))));
      ok('the fixture is a viewer (no seat key)', m.requests.some(r => r.path === '/api/pick/state' && r.key === ''));
      return out;
    },
    { before: m.attach });
}

// ── defence in depth: even if a Worker sent a viewer the text, the page does not show it
{
  const m = pickFakeWorker(doneOpts({ leakViewerMessage: true, revisions: [{ message: '洩漏的訊息 LEAK-TEXT', picker_id: 'picker-0' }] }));
  await suite('guest 確認完成 — viewer: a (misbehaving) state that carries revision_message is still not shown',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#deliveryDone', { timeout: 5000 });
      ok('fixture: the state a viewer gets does carry the text', await page.evaluate(async () =>
        (await (await fetch(`${CONFIG.WORKER_URL}/api/pick/state`, { headers: { 'X-Share-Token': 'TOK' } })).json()).revision_message === '洩漏的訊息 LEAK-TEXT'));
      const b = await doneBlock(page);
      ok('the viewer still sees 攝影師修改中 only, with no message block and no text on the page',
        b.status === '攝影師修改中' && b.msgEl === false && !(await page.evaluate(() => document.body.innerText.includes('LEAK-TEXT'))), JSON.stringify(b));
      return out;
    },
    { before: m.attach });
}

// ── the contract the viewer relies on: owner gets the text, a viewer never does
{
  const m = pickFakeWorker(doneOpts({ revisions: [{ message: '請把 f1.jpg 修亮一點 OWNER-TEXT', picker_id: 'picker-0' }] }));
  await suite('guest 確認完成 — owner sees their own revision text; the same state read by a viewer has none',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#deliveryDone', { timeout: 5000 });
      const b = await doneBlock(page);
      ok('owner: 已通知攝影師，修改中 and the text', b.state === 'revising' && b.status === '已通知攝影師，修改中' && b.msg === '請把 f1.jpg 修亮一點 OWNER-TEXT', JSON.stringify(b));
      ok('owner still has both buttons (算了這樣就好 / ask again)', JSON.stringify(b.buttons) === '["確認完成","需要修改"]');
      const asViewer = await page.evaluate(async () => {
        const r = await fetch(`${CONFIG.WORKER_URL}/api/pick/state`, { headers: { 'X-Share-Token': 'TOK' } });
        const d = await r.json();
        return { open: d.revision_open, msg: d.revision_message, confirmed: d.confirmed_at };
      });
      ok('the fake answers a viewer revision_open true, revision_message null (the Worker\'s contract)', asViewer.open === true && asViewer.msg === null && asViewer.confirmed === null, JSON.stringify(asViewer));
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── not delivered: the block and its modals do not exist at all
for (const [name, o] of [
  ['picking (submitted)', { phase: 'submitted', deliveredAt: null, finalFolders: null }],
  ['undelivered, finals kept (delivered_at null, final_folders set)', { deliveredAt: null, finalFolders: ['shoot/精修/'], confirmedAt: '2026-09-21T03:00:00.000Z' }],
]) {
  const m = pickFakeWorker(doneOpts(o));
  await suite(`guest 確認完成 — ${name}: no block, no modals, no confirm UI in the DOM`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('fixture: the guard under test runs (Worker answers mode picking)', await page.evaluate(async () => {
        const d = await (await fetch(`${CONFIG.WORKER_URL}/api/pick/state`, { headers: { 'X-Share-Token': 'TOK', 'X-Picker-Key': 'ZOE-KEY' } })).json();
        return d.mode === 'picking' && d.confirmed_at === null && d.revision_open === false && d.revision_message === null;
      }));
      if (name.startsWith('undelivered')) ok('fixture: the project row still carries final_folders and a confirmation stamp', m.state.project.final_folders !== null && m.state.project.client_confirmed_at !== null);
      ok('picking page is really up (hearts, filter)', (await page.$$('.pick-heart-btn')).length > 0 && (await page.$('#pickFilterBar')) !== null);
      ok('#deliveryDone is not in the DOM', (await page.$('#deliveryDone')) === null);
      ok('no confirm/revise button or modal is in the DOM', (await page.$$('#doneConfirmBtn, #doneReviseBtn, #doneConfirmModal, #doneReviseModal, .delivery-done')).length === 0);
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── 需要修改: textarea rules, the body, 修改中, then 確認完成 after asking
for (const [label, co] of [['1280px', { viewport: { width: 1280, height: 900 } }], ['390px', MOBILE]]) {
  const m = pickFakeWorker(doneOpts());
  await suite(`guest 需要修改 ${label} — textarea limits, request body, 修改中 state, then 確認完成 resolves it`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const narrow = label === '390px';
      await page.waitForSelector('#doneReviseBtn', { timeout: 5000 });
      await page.click('#doneReviseBtn');
      ok('the revise modal opens', await modalShown(page, 'doneReviseModal'));
      const ta = await page.$eval('#doneReviseText', e => ({ max: e.getAttribute('maxlength'), fs: getComputedStyle(e).fontSize, focused: false }));
      ta.focused = await page.waitForFunction(() => document.activeElement?.id === 'doneReviseText', null, { timeout: 2000 }).then(() => true, () => false);
      ok('textarea: maxlength 1000, font-size 16px (no iOS zoom)', ta.max === '1000' && ta.fs === '16px', JSON.stringify(ta));
      ok('textarea is focused on open', ta.focused);
      ok('the counter starts at 0 / 1000, 送出 is disabled', (await page.textContent('#doneReviseCount')) === '0 / 1000' && await page.$eval('#doneReviseSubmit', b => b.disabled));
      await page.fill('#doneReviseText', '   \n  ');
      ok('whitespace only: still disabled, and a forced click sends nothing',
        await page.$eval('#doneReviseSubmit', b => { b.click(); return b.disabled; }) && donePosts(m, 'revision').length === 0);
      const msg = 'f1.jpg 膚色偏黃\n第二行';
      await page.fill('#doneReviseText', msg);
      ok('typing enables 送出 and updates the counter', !(await page.$eval('#doneReviseSubmit', b => b.disabled)) &&
        (await page.textContent('#doneReviseCount')) === `${msg.length} / 1000`, await page.textContent('#doneReviseCount'));
      await page.fill('#doneReviseText', 'x'.repeat(1200));
      ok('1200 typed characters are cut at 1000 by the textarea', (await page.$eval('#doneReviseText', e => e.value.length)) === 1000 &&
        (await page.textContent('#doneReviseCount')) === '1000 / 1000');
      if (narrow) {
        // a soft keyboard leaves ~40% of the height: the modal must still fit and 送出 must be reachable
        await page.setViewportSize({ width: 390, height: 420 });
        await page.waitForTimeout(150);
        const g = await page.evaluate(() => {
          const c = document.querySelector('#doneReviseModal .modal-content'), r = c.getBoundingClientRect();
          const s = document.getElementById('doneReviseSubmit'); s.scrollIntoView({ block: 'nearest' });
          const sr = s.getBoundingClientRect();
          const hit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
          return { top: r.top, bottom: r.bottom, h: innerHeight, hit: hit === s || s.contains(hit), submitTop: sr.top, submitBottom: sr.bottom };
        });
        ok('short viewport (keyboard up): the modal stays inside it and 送出 is not covered by anything',
          g.top >= 0 && g.bottom <= g.h + 1 && g.hit && g.submitTop >= 0 && g.submitBottom <= g.h + 1, JSON.stringify(g));
        await page.setViewportSize({ width: 390, height: 844 });
      }
      await page.fill('#doneReviseText', msg);
      await page.click('#doneReviseSubmit');
      await page.waitForFunction(() => document.getElementById('deliveryDone')?.dataset.state === 'revising', null, { timeout: 5000 });
      const posts = donePosts(m, 'revision');
      ok('one POST /api/pick/revision with exactly {message}, this link\'s token and seat key',
        posts.length === 1 && JSON.stringify(posts[0].body) === JSON.stringify({ message: msg }) && posts[0].t === 'TOK' && posts[0].key === 'ZOE-KEY', JSON.stringify(posts));
      ok('the modal closed; the textarea is empty again', !(await modalShown(page, 'doneReviseModal')) && (await page.$eval('#doneReviseText', e => e.value)) === '');
      const b = await doneBlock(page);
      ok('state 修改中: 已通知攝影師，修改中 with the stored text', b.status === '已通知攝影師，修改中' && b.msg === msg, JSON.stringify(b));
      ok('the owner may still 確認完成 or ask again', JSON.stringify(b.buttons) === '["確認完成","需要修改"]');
      ok('the Worker has one open request', m.state.revisions.length === 1 && m.state.revisions[0].resolved_at === null);
      ok('the message block keeps the line break (pre-wrap) and wraps', await page.$eval('#deliveryDoneMsg', e => getComputedStyle(e).whiteSpace === 'pre-wrap'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#deliveryDone', { timeout: 5000 });
      const b2 = await doneBlock(page);
      ok('after a reload the 修改中 state and the text come back from the Worker', b2.state === 'revising' && b2.msg === msg, JSON.stringify(b2));

      // 算了，這樣就好
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
      const b3 = await doneBlock(page);
      ok('confirming after asking: ✓ 已確認完成, the request text is gone, no buttons', /^✓ 已確認完成/.test(b3.status) && b3.msgEl === false && b3.buttons.length === 0, JSON.stringify(b3));
      ok('the Worker resolved the request', m.state.revisions.every(r => r.resolved_at));
      return out;
    },
    { before: m.attach, initScript: AS_OWNER, contextOptions: co });
}

// ── the guest's text is shown as text only
{
  const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b> & <script>window.__pwned=2</script>';
  const m = pickFakeWorker(doneOpts({ revisions: [{ message: evil, picker_id: 'picker-0' }] }));
  await suite('guest 確認完成 — a revision text with markup is plain text (seeded by the Worker, and typed and echoed back)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#deliveryDoneMsg', { timeout: 5000 });
      const probe = () => page.evaluate(() => ({
        msg: document.getElementById('deliveryDoneMsg')?.textContent, kids: document.querySelectorAll('#deliveryDone img, #deliveryDone b, #deliveryDone script').length,
        pwned: window.__pwned ?? null,
      }));
      let r = await probe();
      ok('the seeded text is shown literally', r.msg === evil, r.msg);
      ok('no <img>/<b>/<script> element was parsed out of it, nothing ran', r.kids === 0 && r.pwned === null, JSON.stringify(r));
      // type another one: the echo from the Worker goes through the same path
      const typed = '<b>second</b><img src=y onerror="window.__pwned=3">';
      await page.click('#doneReviseBtn');
      await page.fill('#doneReviseText', typed);
      await page.click('#doneReviseSubmit');
      await page.waitForFunction(t => document.getElementById('deliveryDoneMsg')?.textContent === t, typed, { timeout: 5000 });
      r = await probe();
      ok('the echo of a typed text is literal too, nothing parsed or run', r.kids === 0 && r.pwned === null, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── errors: friendly text, modal stays open, button usable again
{
  const o = doneOpts();
  const m = pickFakeWorker(o);
  const cases = [
    ['confirm', { status: 403, body: { error: '只有挑選人可以確認完成' } }, /只有選片人/],
    ['confirm', { status: 401, body: { error: 'Unauthorized' } }, /連結已失效/],
    ['confirm', { status: 409, body: { error: '尚未交件', code: 'not_delivered' } }, /重新整理/, true],
    ['confirm', { status: 500, body: { error: '確認完成功能尚未啟用', code: 'confirm_unavailable' } }, /稍後再試/],
    ['confirm', { status: 400, body: { error: 'Invalid body', code: 'invalid_body' } }, /稍後再試/],
    ['confirm', 'net', /網路/],
    ['revision', { status: 409, body: { error: '尚未處理的修改需求已有 10 則，請等攝影師回覆', code: 'revision_open_cap', max: 10 } }, /已達上限.*聯絡攝影師/],
    ['revision', { status: 409, body: { error: '修改需求已達上限（50 則），請直接聯絡攝影師', code: 'revision_cap', max: 50 } }, /已達上限.*聯絡攝影師/],
    ['revision', { status: 400, body: { error: '請輸入 1–1000 字的修改說明', code: 'invalid_message', max: 1000 } }, /1–1000/],
    ['revision', { status: 413, body: { error: '資料太大', code: 'too_large', max: 16384 } }, /太長/],
    ['revision', { status: 403, body: { error: '只有挑選人可以要求修改' } }, /只有選片人/],
    ['revision', { status: 500, body: { error: '確認完成功能尚未啟用', code: 'confirm_unavailable' } }, /稍後再試/],
  ];
  await suite('guest 確認完成 — every error code maps to a friendly line; the modal stays open and 送出 works again',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      for (const [kind, inj, re, reload] of cases) {
        const rev = kind === 'revision';
        o.failNextPick = [inj];
        await page.click(rev ? '#doneReviseBtn' : '#doneConfirmBtn');
        if (rev) await page.fill('#doneReviseText', '請修一下');
        await page.click(rev ? '#doneReviseSubmit' : '#doneConfirmSubmit');
        const errSel = rev ? '#doneReviseErr' : '#doneConfirmErr';
        await page.waitForFunction(s => document.querySelector(s).textContent.trim() !== '', errSel, { timeout: 5000 });
        const t = await page.textContent(errSel);
        const tag = `${kind} ${inj === 'net' ? 'network failure' : (inj.body.code || inj.status)}`;
        ok(`${tag}: "${t.trim()}"`, re.test(t), t);
        ok(`${tag}: the modal stays open, 送出 is usable again, nothing changed on the page`,
          await modalShown(page, rev ? 'doneReviseModal' : 'doneConfirmModal') && !(await page.$eval(rev ? '#doneReviseSubmit' : '#doneConfirmSubmit', b => b.disabled)) &&
          (await doneBlock(page)).state === 'open');
        if (reload) ok(`${tag}: a 重新載入 button is offered`, (await page.$(`${errSel} .done-reload`)) !== null);
        if (rev) ok(`${tag}: the typed text is kept`, (await page.$eval('#doneReviseText', e => e.value)) === '請修一下');
        await page.click(rev ? '#doneReviseCancel' : '#doneConfirmCancel');
      }
      ok('after all that, nothing was ever recorded', m.state.revisions.length === 0 && m.state.project.client_confirmed_at === null);
      ok('and a success afterwards still goes through', await (async () => {
        await page.click('#doneConfirmBtn'); await page.click('#doneConfirmSubmit');
        await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
        return m.state.project.client_confirmed_at !== null;
      })());
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── already_confirmed (it happened in between), and a state read that fails
{
  const o = doneOpts();
  const m = pickFakeWorker(o);
  await suite('guest 確認完成 — 409 already_confirmed turns the page to ✓; a failing state re-read sends nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#doneReviseBtn', { timeout: 5000 });
      // the state re-read fails: nothing is sent
      await page.route('**/api/pick/state', r => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) }));
      await page.click('#doneReviseBtn');
      await page.fill('#doneReviseText', '請修一下');
      await page.click('#doneReviseSubmit');
      await page.waitForFunction(() => document.getElementById('doneReviseErr').textContent.trim() !== '', null, { timeout: 5000 });
      ok('a dead link on the re-read: 連結已失效, no request sent', /連結已失效/.test(await page.textContent('#doneReviseErr')) && donePosts(m, 'revision').length === 0);
      await page.unroute('**/api/pick/state');
      await page.click('#doneReviseCancel');

      // the photographer confirmed between the re-read and the POST
      o.failNextPick = [{ status: 409, body: { error: '已確認完成，無法再要求修改', code: 'already_confirmed' },
        effect: () => { m.state.project.client_confirmed_at = '2026-09-22T01:00:00.000Z'; m.state.project.client_confirmed_by = 'photographer'; } }];
      await page.click('#doneReviseBtn');
      await page.click('#doneReviseSubmit');
      await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
      const b = await doneBlock(page);
      ok('the page shows ✓ 已確認完成（2026/9/22）, no buttons, modals gone', b.status === '✓ 已確認完成（2026/9/22）' && b.buttons.length === 0 && (await page.$('#doneReviseModal')) === null, JSON.stringify(b));
      ok('a toast says so', await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('已確認完成'))));
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── a double click sends one request; the button is disabled while it is in flight
{
  const m = pickFakeWorker(doneOpts({ pickDelay: 700 }));
  await suite('guest 確認完成 — while the request is in flight 送出 is disabled; a double click sends once; 取消 does not close it',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      await page.click('#doneConfirmBtn');
      const r = await page.evaluate(() => {
        const b = document.getElementById('doneConfirmSubmit');
        b.click(); const afterFirst = b.disabled; b.click(); b.click();
        return { afterFirst };
      });
      ok('the button is disabled right after the first click', r.afterFirst === true);
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('doneConfirmCancel').click());
      ok('取消 while sending does not close the modal', await modalShown(page, 'doneConfirmModal'));
      await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
      ok('exactly one POST for three clicks', donePosts(m, 'confirm').length === 1, String(donePosts(m, 'confirm').length));
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── the page shows an old version: re-read first, say so, send nothing
for (const [name, mutate, seed] of [
  ['the finals folder changed', m => { m.state.project.final_folders = ['shoot/精修二/']; }, {}],
  ['delivered_at changed (undelivered and delivered again)', m => { m.state.project.delivered_at = '2026-09-25T00:00:00.000Z'; }, {}],
  ['the photographer replaced the finals and the open request was resolved', m => { m.state.revisions.forEach(r => { r.resolved_at = '2026-09-25T00:00:00.000Z'; }); },
    { revisions: [{ message: '舊版的要求', picker_id: 'picker-0' }] }],
]) {
  for (const kind of ['confirm', 'revision']) {
    const m = pickFakeWorker(doneOpts(seed));
    await suite(`guest 確認完成 — stale page (${name}), ${kind}: re-reads the state, shows 攝影師剛更新了照片 + 重新載入, sends nothing`,
      `${base}/index.html?t=TOK`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
        const before = stateGets(m);
        mutate(m);
        const rev = kind === 'revision';
        await page.click(rev ? '#doneReviseBtn' : '#doneConfirmBtn');
        if (rev) await page.fill('#doneReviseText', '請修一下');
        await page.click(rev ? '#doneReviseSubmit' : '#doneConfirmSubmit');
        await page.waitForSelector(`${rev ? '#doneReviseErr' : '#doneConfirmErr'} .done-reload`, { timeout: 5000 });
        const t = await page.textContent(rev ? '#doneReviseErr' : '#doneConfirmErr');
        ok('the page re-read /api/pick/state before sending', stateGets(m) === before + 1, `${before} -> ${stateGets(m)}`);
        ok('the line says 攝影師剛更新了照片，請重新整理後再確認', t.includes('攝影師剛更新了照片，請重新整理後再確認'), t);
        ok('nothing was sent', donePosts(m, 'confirm').length === 0 && donePosts(m, 'revision').length === 0);
        ok('the modal stays open (the guest decides) and the block is unchanged', await modalShown(page, rev ? 'doneReviseModal' : 'doneConfirmModal') && (await doneBlock(page)).state !== 'confirmed');
        if (name.startsWith('the finals') && !rev) {
          await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(`#doneConfirmErr .done-reload`)]);
          await page.waitForSelector('.fg-tile', { timeout: 5000 });   // the finals gallery (was .photo-card)
          const tileIds = () => page.$$eval('.fg-tile', ts => ts.map(t => t.dataset.photoId));
          ok('重新載入 reloads the page: the new finals folder is what is listed', (await tileIds()).every(id => id.startsWith('shoot/精修二/')) && (await tileIds()).length > 0, JSON.stringify(await tileIds()));
          ok('and the block is back in its open state', (await doneBlock(page)).state === 'open');
        }
        return out;
      },
      { before: m.attach, initScript: AS_OWNER });
  }
}

// ── confirmed by the photographer while the guest has the page open
{
  const m = pickFakeWorker(doneOpts());
  await suite('guest 確認完成 — the photographer marked it complete meanwhile: nothing is sent, the page turns to ✓',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      m.state.project.client_confirmed_at = '2026-09-22T01:00:00.000Z';
      m.state.project.client_confirmed_by = 'photographer';
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await page.waitForFunction(CONFIRMED_UP, null, { timeout: 5000 });
      const b = await doneBlock(page);
      ok('✓ 已確認完成（2026/9/22）, no buttons', b.status === '✓ 已確認完成（2026/9/22）' && b.buttons.length === 0, JSON.stringify(b));
      ok('no confirm POST was sent', donePosts(m, 'confirm').length === 0);
      return out;
    },
    { before: m.attach, initScript: AS_OWNER });
}

// ── the fake mirrors the Worker: what the guest page can rely on
{
  const m = pickFakeWorker(doneOpts({ phase: 'submitted', deliveredAt: null, finalFolders: null, confirmedAt: '2026-09-21T03:00:00.000Z',
    revisions: [{ message: 'x', picker_id: 'picker-0' }] }));
  await suite('fake worker — outside the delivered mode the state is always confirmed_at null / revision_open false / revision_message null',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const d = await page.evaluate(async () => (await fetch(`${CONFIG.WORKER_URL}/api/pick/state`, { headers: { 'X-Share-Token': 'TOK', 'X-Picker-Key': 'ZOE-KEY' } })).json());
      return [d.mode === 'picking' && d.confirmed_at === null && d.revision_open === false && d.revision_message === null
        ? 'ok    null / false / null' : `FAIL  ${JSON.stringify(d)}`];
    },
    { before: m.attach, initScript: AS_OWNER });
}
}
