// Browser suites: admin delivered-state badges, revision requests, mark complete, download switch.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { ADMIN_BUCKET, ADM_REVS, admDelivered, adminDropDefaultFinal, adminPickFinals, chipTexts } from '../lib/delivery-helpers.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const admConfirmPosts = m => m.requests.filter(r => r.method === 'POST' && /\/api\/admin\/projects\/[^/]+\/confirm$/.test(r.path));
const admDetailGets = m => m.requests.filter(r => r.method === 'GET' && /^\/api\/admin\/projects\/[^/]+$/.test(r.path)).length;
const admListBadges = page => page.$$eval('#proj-recent-list [data-project-row] .badge', els =>
  els.map(e => ({ t: e.textContent.trim(), c: e.dataset.confirmBadge || null, d: e.hasAttribute('data-delivered-badge') })));
const admRevItems = page => page.$$eval('#pd-revisions .pd-rev', els => els.map(e => ({
  msg: e.querySelector('.pd-rev-msg')?.textContent, meta: e.querySelector('.pd-rev-meta')?.textContent,
  resolved: e.classList.contains('resolved'), tag: e.querySelector('.pd-rev-done')?.textContent ?? null,
  color: getComputedStyle(e.querySelector('.pd-rev-msg')).color, bg: getComputedStyle(e).backgroundColor, dashed: getComputedStyle(e).borderStyle === 'dashed' })));

// ── list badge: 客戶已確認 / 已標記完成 / 待修改 N, in addition to 已交件
{
  const m = pickFakeWorker(admDelivered());
  const put = (revs, confirmed, by) => {
    m.state.revisions = revs.map((r, i) => ({ id: `r${i}`, picker_id: 'picker-0', resolved_at: null, created_at: '2026-09-21T00:00:00.000Z', ...r }));
    m.state.project.client_confirmed_at = confirmed || null;
    m.state.project.client_confirmed_by = confirmed ? by : null;
  };
  await suite('admin 列表 — delivered project badges: 已交件 stays; plus 客戶已確認 / 已標記完成 / 待修改 N; nothing for an undelivered one',
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const reload = async () => { await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#proj-recent-list [data-project-row]', { timeout: 5000 }); return admListBadges(page); };
      await page.waitForSelector('#proj-recent-list [data-project-row]', { timeout: 5000 });
      let b = await admListBadges(page);
      ok('delivered, nothing asked, not confirmed: the 已交件 badge and no confirmation badge', b.some(x => x.d && x.t === '已交件') && !b.some(x => x.c), JSON.stringify(b));
      put([{ message: 'a' }, { message: 'b' }, { message: 'c', resolved_at: '2026-09-22T00:00:00.000Z' }]);
      ok('fixture: the list row says 2 open (the resolved one does not count)', m.state.revisions.filter(r => !r.resolved_at).length === 2);
      b = await reload();
      ok('2 open requests: 待修改 2 (data-confirm-badge=revising), 已交件 still there', b.some(x => x.c === 'revising' && x.t === '待修改 2') && b.some(x => x.d && x.t === '已交件'), JSON.stringify(b));
      put([{ message: 'a' }], '2026-09-23T00:00:00.000Z', 'guest');
      b = await reload();
      ok('confirmed by the guest: 客戶已確認 — and it wins over an open request; no 待修改', b.some(x => x.c === 'confirmed' && x.t === '客戶已確認') && !b.some(x => x.c === 'revising') && b.some(x => x.d), JSON.stringify(b));
      put([], '2026-09-23T00:00:00.000Z', 'photographer');
      b = await reload();
      ok('confirmed by the photographer: 已標記完成 (told apart from the guest\'s), not 客戶已確認', b.some(x => x.c === 'photographer' && x.t === '已標記完成') && !b.some(x => x.t === '客戶已確認') && b.some(x => x.d), JSON.stringify(b));
      put([{ message: 'a' }, { message: 'b' }]);
      m.state.project.delivered_at = null;
      b = await reload();
      ok('not delivered (取消交件 keeps the requests open): no 已交件 and no confirmation badge at all', !b.some(x => x.d) && !b.some(x => x.c) && !b.some(x => /待修改/.test(x.t)), JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── detail: the 交件 block shows the state, the requests, 標記完成 (and it updates in place)
{
  const o = admDelivered({ revisions: ADM_REVS() });
  const m = pickFakeWorker(o);
  await suite('admin 交件 — 要求修改清單、尚未確認、標記完成（先確認對話框；成功後就地更新狀態、徽章、清單）',
    `${base}/admin.html#project=proj-cf`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-revisions .pd-rev', { timeout: 5000 });
      ok('fixture: delivered, not confirmed, 2 open + 1 resolved', m.state.project.delivered_at !== null && m.state.project.client_confirmed_at === null && m.state.revisions.length === 3);
      ok('the confirmation status says 尚未確認', /尚未確認/.test(await page.textContent('#pd-confirm-status')), await page.textContent('#pd-confirm-status'));
      const items = await admRevItems(page);
      ok('the list is newest first: 最新, 第二點, 最舊', JSON.stringify(items.map(i => i.msg)) === JSON.stringify(['最新：背景路人', '第二點 f1.jpg 偏黃', '最舊：已處理的要求']), JSON.stringify(items.map(i => i.msg)));
      ok('each item names the picker and the time (Taipei)', items.every(i => /Zoe/.test(i.meta)) && /9\/22 12:00/.test(items[0].meta), JSON.stringify(items.map(i => i.meta)));
      ok('only the resolved one is marked 已處理 and quieter (dashed, softer text)', JSON.stringify(items.map(i => i.resolved)) === '[false,false,true]' && items[2].tag === '已處理' && items[2].dashed && !items[0].dashed && items[2].color !== items[0].color && items[0].tag === null, JSON.stringify(items));
      ok('with open requests a line explains the flow (上傳新版 → 更換精修資料夾 → 自動結案)',
        /請上傳新版精修資料夾後按「更換精修資料夾」，會自動結案目前的要求/.test(await page.textContent('#pd-revision-hint')), await page.textContent('#pd-revision-hint').catch(() => 'absent'));
      ok('the head and the list carry 待修改 2', (await page.$eval('.pd-head [data-confirm-badge]', e => e.textContent.trim())) === '待修改 2' &&
        (await admListBadges(page)).some(x => x.c === 'revising' && x.t === '待修改 2'), JSON.stringify(await admListBadges(page)));
      ok('the button is 標記完成', (await page.textContent('#pd-mark-done-btn')).trim() === '標記完成');
      ok('existing buttons are still there (更換精修資料夾, 取消交件)', !!(await page.$('#pd-replace-final-btn')) && !!(await page.$('#pd-undeliver-btn')));

      let dialogText = '';
      page.once('dialog', d => { dialogText = d.message(); d.dismiss(); });
      await page.click('#pd-mark-done-btn');
      await page.waitForTimeout(300);
      ok('it asks first: 這是代客戶確認，客戶頁面會顯示已確認完成', /這是代客戶確認/.test(dialogText) && /客戶頁面會顯示已確認完成/.test(dialogText), dialogText);
      ok('dismissing sends nothing', admConfirmPosts(m).length === 0 && m.state.project.client_confirmed_at === null);

      const gets0 = admDetailGets(m);
      page.once('dialog', d => d.accept());
      await page.click('#pd-mark-done-btn');
      await page.waitForFunction(() => document.getElementById('pd-mark-done-btn') === null, null, { timeout: 5000 });
      ok('one POST to /confirm for this project, no body needed', admConfirmPosts(m).length === 1 && admConfirmPosts(m)[0].path === '/api/admin/projects/proj-cf/confirm');
      ok('recorded as the photographer\'s', m.state.project.client_confirmed_by === 'photographer');
      const st = await page.textContent('#pd-confirm-status');
      ok('the status is now 已標記完成（攝影師代為確認）with the time', /已標記完成/.test(st) && /攝影師代為確認/.test(st) && /\d+\/\d+ \d{2}:\d{2}/.test(st), st);
      ok('the button and the explaining line are gone', (await page.$('#pd-mark-done-btn')) === null && (await page.$('#pd-revision-hint')) === null);
      const after = await admRevItems(page);
      ok('the Worker resolved the requests: every item is now 已處理', after.length === 3 && after.every(i => i.resolved && i.tag === '已處理'), JSON.stringify(after));
      ok('the head badge turned into 已標記完成, and 已交件 is still there', (await page.$eval('.pd-head [data-confirm-badge]', e => e.textContent.trim() + '|' + e.dataset.confirmBadge)) === '已標記完成|photographer' &&
        (await page.$('.pd-head [data-delivered-badge]')) !== null);
      await page.waitForFunction(() => document.querySelector('#proj-recent-list [data-confirm-badge="photographer"]'), null, { timeout: 5000 });
      ok('the list row followed (已標記完成)', (await admListBadges(page)).some(x => x.c === 'photographer' && x.t === '已標記完成') && !(await admListBadges(page)).some(x => x.c === 'revising'));
      ok('updated in place: the detail was not fetched again', admDetailGets(m) === gets0, `${gets0} -> ${admDetailGets(m)}`);
      ok('更換精修資料夾 and 取消交件 are still offered', !!(await page.$('#pd-replace-final-btn')) && !!(await page.$('#pd-undeliver-btn')));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#pd-confirm-status', { timeout: 5000 });
      ok('after a reload the Worker still says it (no button, same status)', (await page.$('#pd-mark-done-btn')) === null && /已標記完成/.test(await page.textContent('#pd-confirm-status')));
      if (process.env.SHOTS_DONE) await page.screenshot({ path: `${process.env.SHOTS_DONE}/admin-detail-marked.png`, fullPage: true });
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── detail: confirmed by the guest, and the states with no 標記完成
for (const [name, o, re, wantBtn, wantReqs] of [
  ['confirmed by the guest', admDelivered({ confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'guest', revisions: ADM_REVS().map(r => ({ ...r, resolved_at: '2026-09-23T03:30:00.000Z' })) }), /客戶已確認完成.*9\/23 11:30/, false, true],
  ['delivered, no request, not confirmed', admDelivered(), /尚未確認/, true, false],
  ['retouching, not delivered (the chooser only)', admDelivered({ deliveredAt: null, finalFolders: null, revisions: ADM_REVS() }), null, false, false],
  ['picking, not delivered', admDelivered({ phase: 'submitted', deliveredAt: null, finalFolders: null }), null, false, false],
]) {
  const m = pickFakeWorker(o);
  await suite(`admin 交件 — ${name}`,
    `${base}/admin.html#project=proj-cf`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.pd-head', { timeout: 5000 });
      await page.waitForSelector('#pd-plan #pd-plan-save', { timeout: 5000 });
      if (re) {
        ok('the status line', re.test(await page.textContent('#pd-confirm-status')), await page.textContent('#pd-confirm-status'));
        ok('the guest\'s confirmation is told apart from the photographer\'s', name.includes('guest') ? !/攝影師代為確認/.test(await page.textContent('#pd-confirm-status')) : true);
      } else {
        ok('no confirmation UI at all in the DOM (status, list, hint, button)', (await page.$$('#pd-confirm-status, #pd-revisions, #pd-revision-hint, #pd-mark-done-btn, [data-confirm-badge]')).length === 0);
      }
      ok(`標記完成 button ${wantBtn ? 'is' : 'is not'} there`, ((await page.$('#pd-mark-done-btn')) !== null) === wantBtn);
      ok(`the request list ${wantReqs ? 'is' : 'is not'} shown`, ((await page.$('#pd-revisions .pd-rev')) !== null) === wantReqs);
      if (name.includes('delivered, no request')) ok('with nothing asked there is no explaining line and no empty list box', (await page.$('#pd-revision-hint')) === null && (await page.$('#pd-revisions')) === null);
      if (name.includes('guest')) {
        const it = await admRevItems(page);
        ok('all three items are 已處理, no explaining line', it.length === 3 && it.every(i => i.resolved) && (await page.$('#pd-revision-hint')) === null);
      }
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── the guest's text and name are never parsed as HTML
{
  const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b><script>window.__pwned=2</script>';
  const m = pickFakeWorker(admDelivered({ ownerName: '<i>Zoe</i><img src=y onerror="window.__pwned=3">', revisions: [{ message: evil, picker_id: 'picker-0' }] }));
  await suite('admin 交件 — a revision text / picker name with markup is plain text (no element, nothing runs)',
    `${base}/admin.html#project=proj-cf`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-revisions .pd-rev', { timeout: 5000 });
      const r = await page.evaluate(() => ({ msg: document.querySelector('#pd-revisions .pd-rev-msg').textContent, meta: document.querySelector('#pd-revisions .pd-rev-meta').textContent,
        kids: document.querySelectorAll('#pd-revisions img, #pd-revisions b, #pd-revisions i, #pd-revisions script').length, pwned: window.__pwned ?? null }));
      ok('the text is literal', r.msg === evil, r.msg);
      ok('the picker name is literal', r.meta.includes('<i>Zoe</i>'), r.meta);
      ok('no img/b/i/script element exists in the list, and nothing ran', r.kids === 0 && r.pwned === null, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── errors of 標記完成
for (const [name, setup, re, stillThere] of [
  ['409 not_delivered (undelivered in another tab)', (m, o) => { m.state.project.delivered_at = null; }, /尚未交件/, true],
  ['404 (the project is gone)', (m, o) => { m.state.project.id = 'someone-else'; }, /找不到專案/, true],
  ['500 confirm_unavailable (migration not run)', (m, o) => { o.confirmUnavailable = true; }, /資料庫尚未升級.*migration/, true],
]) {
  const o = admDelivered({ revisions: ADM_REVS() });
  const m = pickFakeWorker(o);
  await suite(`admin 標記完成 — ${name}: a clear message, nothing changes on the page`,
    `${base}/admin.html#project=proj-cf`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-mark-done-btn', { timeout: 5000 });
      setup(m, o);
      page.once('dialog', d => d.accept());
      await page.click('#pd-mark-done-btn');
      await page.waitForFunction(() => document.getElementById('pd-confirm-err')?.textContent.trim() !== '', null, { timeout: 5000 });
      const t = await page.textContent('#pd-confirm-err');
      ok(`message: "${t}"`, re.test(t), t);
      ok('the request was made (so the error came from the Worker)', admConfirmPosts(m).length === 1);
      ok('the status is unchanged (尚未確認), the list of requests is intact', /尚未確認/.test(await page.textContent('#pd-confirm-status')) && (await admRevItems(page)).length === 3);
      ok('the button is usable again', stillThere && !(await page.$eval('#pd-mark-done-btn', b => b.disabled)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 更換精修資料夾 closes the requests (the Worker does it; the page shows it)
{
  const m = pickFakeWorker(admDelivered({ revisions: ADM_REVS(), confirmedAt: null }));
  await suite('admin 交件 — 更換精修資料夾 (a repeat deliver) resolves the open requests: all 已處理, the 待修改 badge and the explaining line go',
    `${base}/admin.html#project=proj-cf`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-revisions .pd-rev', { timeout: 5000 });
      ok('before: 2 open, the line and the badge are there', (await admRevItems(page)).filter(i => !i.resolved).length === 2 && !!(await page.$('#pd-revision-hint')) &&
        (await admListBadges(page)).some(x => x.c === 'revising'));
      await page.click('#pd-replace-final-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修二/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      // the picker pre-ticked the old finals: drop them from the draft, keep 精修二
      await page.evaluate(() => { document.querySelector('#pd-final-chips [data-remove-final="shoot/精修/"]')?.click(); });
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => document.querySelector('#pd-delivered-folders [data-final-chip]')?.dataset.finalChip === 'shoot/精修二/', null, { timeout: 5000 });
      const after = await admRevItems(page);
      ok('every request is now 已處理', after.length === 3 && after.every(i => i.resolved), JSON.stringify(after));
      ok('the explaining line and the 待修改 badge are gone (the head and the list)',
        (await page.$('#pd-revision-hint')) === null && (await page.$('.pd-head [data-confirm-badge="revising"]')) === null &&
        !(await admListBadges(page)).some(x => x.c === 'revising'), JSON.stringify(await admListBadges(page)));
      ok('a new version is not confirmed: 尚未確認 and 標記完成 is offered again', /尚未確認/.test(await page.textContent('#pd-confirm-status')) && !!(await page.$('#pd-mark-done-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── upload.html：← 返回選圖 / ← 返回專案 ──
await suite('upload — ?project=<id>：返回鍵改成「← 返回專案」連到 admin.html#project=<id>',
  `${base}/upload.html?project=abc-123&folder=${encodeURIComponent('shoot/精修/')}`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    const r = await page.evaluate(() => {
      const a = document.querySelector('.header .btn-back');
      return a ? { text: a.textContent.trim(), href: a.getAttribute('href'), n: document.querySelectorAll('.btn-back').length, inHeader: !!a.closest('header.header') } : null;
    });
    ok('exactly one back link, inside the header', !!r && r.n === 1 && r.inHeader, JSON.stringify(r));
    ok('text is ← 返回專案', r && r.text === '← 返回專案', JSON.stringify(r));
    ok('href is admin.html#project=abc-123', r && r.href === 'admin.html#project=abc-123', JSON.stringify(r));
    ok('the ?folder= pre-fill still works alongside',
      (await page.evaluate(() => document.body.textContent)).includes('shoot/精修/'));
    return out;
  });

await suite('upload — ?project= 的 id 有特殊字元：href 正確編碼（不能多帶參數或換掉 hash）',
  `${base}/upload.html?project=${encodeURIComponent('a b&c#d')}`,
  async page => {
    const href = await page.$eval('.btn-back', a => a.getAttribute('href'));
    return [href === 'admin.html#project=' + encodeURIComponent('a b&c#d') ? 'ok    id encoded with encodeURIComponent' : `FAIL  ${href}`];
  });

await suite('upload — 沒有 ?project=（或空值）：返回鍵維持「← 返回選圖」→ index.html（舊行為不變）',
  `${base}/upload.html`,
  async page => {
    const read = () => page.$eval('.btn-back', a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    const a = await read();
    ok('no param: ← 返回選圖 → index.html', a.text === '← 返回選圖' && a.href === 'index.html', JSON.stringify(a));
    await page.goto(`${base}/upload.html?folder=${encodeURIComponent('x/')}`, { waitUntil: 'load' });
    const b = await read();
    ok('only ?folder=: unchanged', b.text === '← 返回選圖' && b.href === 'index.html', JSON.stringify(b));
    await page.goto(`${base}/upload.html?project=`, { waitUntil: 'load' });
    const c = await read();
    ok('empty ?project=: unchanged', c.text === '← 返回選圖' && c.href === 'index.html', JSON.stringify(c));
    return out;
  });

{
  const m = pickFakeWorker({ projectId: 'proj-codes', phase: 'retouching', folders: ['shoot/毛片/'],
    bucketFolders: ADMIN_BUCKET.concat(Array.from({ length: 21 }, (_, i) => `many/f${i}/`), ['many/']) });
  await suite('admin 交件 — Worker 的錯誤碼各有中文：not_retouching / too_many_final_folders / invalid_final_folders / final_overlaps_proofs（指名資料夾）',
    `${base}/admin.html#project=proj-codes`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 5000 });
      await adminDropDefaultFinal(page, ok, 'shoot/精修二/');   // start from the empty draft this test was written for
      const err = () => page.$eval('#pd-deliver-err', e => e.textContent);
      const tryDeliver = async (enterPath, folders) => {
        await page.click('#pd-final-pick-btn');
        await adminPickFinals(page, enterPath, folders);
        await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
        await page.click('#pd-deliver-btn');
        await page.waitForFunction(() => document.getElementById('pd-deliver-err').textContent !== '', null, { timeout: 3000 });
      };

      await tryDeliver(['shoot/'], ['shoot/毛片/sub/']);
      ok('final_overlaps_proofs names the folder', /shoot\/毛片\/sub\//.test(await err()) && /毛片資料夾/.test(await err()), await err());
      ok('the chosen folder stays so it can be fixed, and the button is usable again',
        (await chipTexts(page, '#pd-final-chips [data-final-chip]')).length === 1 && !(await page.$eval('#pd-deliver-btn', b => b.disabled)));
      ok('nothing became delivered', m.state.project.delivered_at === null && (await page.$('[data-delivered-status]')) === null);

      // another folder replaces the clash and the message clears
      await page.click('#pd-final-pick-btn');
      await page.click('#folder-picker [data-browse="shoot/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="shoot/精修/"]', { timeout: 3000 });
      await page.evaluate(() => {
        document.querySelector('#folder-picker [data-pick-folder="shoot/毛片/sub/"]')?.click();
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');

      // invalid_final_folders
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker [data-pick-folder]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        document.querySelector('#folder-picker [data-pick-folder="_hidden/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /不正確/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('invalid_final_folders gets its own sentence', /精修資料夾不正確/.test(await err()), await err());

      // too_many_final_folders: 21 folders
      await page.$$eval('[data-remove-final]', bs => bs.forEach(b => b.click()));
      await page.click('#pd-final-pick-btn');
      await page.click('#folder-picker [data-browse="many/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="many/f0/"]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder^="many/f"]')) b.click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      ok('21 chips chosen', (await chipTexts(page, '#pd-final-chips [data-final-chip]')).length === 21);
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /最多/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('too_many_final_folders says the max (20)', /最多 20 個/.test(await err()), await err());

      // not_retouching: the project was reopened meanwhile
      m.state.project.phase = 'picking';
      await page.$$eval('[data-remove-final]', bs => bs.forEach(b => b.click()));
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker [data-pick-folder]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        document.querySelector('#folder-picker [data-pick-folder="many/f0/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /開始精修/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('not_retouching tells the photographer to press 開始精修', /尚未開始精修/.test(await err()), await err());
      ok('none of the four was delivered', m.state.project.delivered_at === null);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw', title: '開關', phase: 'picking' });
  await suite('admin — 「允許客人下載毛片原檔」開關：狀態來自專案、開關送 PATCH、重新開啟仍是新狀態',
    `${base}/admin.html#project=proj-sw`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      const patches = () => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
      ok('the switch is present in 選片中 (any phase) and off by default',
        (await page.$eval('#pd-allow-proof-dl', i => i.checked)) === false);
      ok('the block explains what it does', /毛片的原始檔/.test(await page.$eval('#pd-proofdl', e => e.textContent)));
      ok('no 交件 block while still picking', (await page.$('#pd-delivery #pd-final-pick-btn')) === null);
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => !document.getElementById('pd-allow-proof-dl').disabled, null, { timeout: 3000 });
      ok('turning on sends PATCH {allow_proof_download:true}', JSON.stringify(patches()) === '[{"allow_proof_download":true}]', JSON.stringify(patches()));
      ok('the switch stays on', await page.$eval('#pd-allow-proof-dl', i => i.checked));
      ok('and the server has it', m.state.project.allow_proof_download === true);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      ok('reopening the detail shows it on (state comes from the project)', await page.$eval('#pd-allow-proof-dl', i => i.checked));
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => !document.getElementById('pd-allow-proof-dl').disabled, null, { timeout: 3000 });
      ok('turning off sends {allow_proof_download:false}', JSON.stringify(patches()[1]) === '{"allow_proof_download":false}', JSON.stringify(patches()));
      ok('and it is off on the server', m.state.project.allow_proof_download === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw-err', phase: 'retouching', patchStatus: 500, patchBody: { error: 'no such column: allow_proof_download' } });
  await suite('admin — 開關失敗（例如 migration 還沒跑）：顯示錯誤並把開關放回原位',
    `${base}/admin.html#project=proj-sw-err`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => document.getElementById('pd-proofdl-err').textContent !== '', null, { timeout: 3000 });
      ok('the server message is shown', /allow_proof_download/.test(await page.textContent('#pd-proofdl-err')));
      ok('the switch is back off (nothing was saved)', (await page.$eval('#pd-allow-proof-dl', i => i.checked)) === false);
      ok('and usable again', !(await page.$eval('#pd-allow-proof-dl', i => i.disabled)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw-on', phase: 'retouching', allowProofDownload: true });
  await suite('admin — 專案本來就開著開關時，畫面一打開就是開的',
    `${base}/admin.html#project=proj-sw-on`,
    async page => {
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      return [(await page.$eval('#pd-allow-proof-dl', i => i.checked)) ? 'ok    switch reads allow_proof_download from the project' : 'FAIL  switch not checked'];
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-legacy', phase: 'retouching', deliveredAt: '2026-09-01T00:00:00.000Z' });
  await suite('admin — 舊資料（有交付時間、沒有精修資料夾）：仍顯示已交件，並能用「更換精修資料夾」補上',
    `${base}/admin.html#project=proj-legacy`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-delivered-status]', { timeout: 5000 });
      ok('a legacy stamp is shown as 已交件 with a note instead of folders',
        /舊資料/.test(await page.textContent('#pd-delivered-folders')) && !!(await page.$('#pd-replace-final-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
