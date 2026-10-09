// Browser suites: admin 交件 (deliver, undeliver, reopen), + upload finals links, finals folder
// defaults, locked upload target.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { PIXEL } from '../lib/env.mjs';
import { ADMIN, adminMock } from '../lib/auth-mocks.mjs';
import { ADMIN_BUCKET, adminDropDefaultFinal, adminPickFinals, chipTexts } from '../lib/delivery-helpers.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PF_NAMES, PF_ROOT, pfLists } from '../lib/project-helpers.mjs';

export default async function register() {
const deliverBodies = m => m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/deliver')).map(r => r.body);
// ＋上傳精修 / ＋上傳毛片: the link's parts, and waiting until the Worker's listing has told what 精修 folders exist
// (until then the link names no folder at all: data-target="checking").
const pfLink = (page, sel) => page.$eval(sel, a => { const u = new URL(a.href);
  return { file: u.pathname.split('/').pop(), folder: u.searchParams.get('folder'), project: u.searchParams.get('project'),
    lock: u.searchParams.get('lock'), keys: [...u.searchParams.keys()], target: a.dataset.target || null }; });
const pfWaitFinalsLink = page => page.waitForSelector('#pd-upload-final-btn[data-target="ready"], #pd-upload-final-btn[data-target="failed"]', { timeout: 5000 });

{
  const m = pickFakeWorker({ projectId: 'proj-deliver', title: '待交件專案', phase: 'retouching', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — 精修中：選精修資料夾（附警語）→ 交件 → 已交件＋資料夾；更換（再交件）；取消交件（要確認）',
    `${base}/admin.html#project=proj-deliver`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      const txt = () => page.$eval('#pd-delivery', e => e.textContent);
      ok('the old 標記已交件 button is gone', !(await page.textContent('#project-detail-body')).includes('標記已交件'));
      ok('the block warns that finals must be a separate folder, not inside the proof folder',
        /獨立的資料夾/.test(await txt()) && /不能放在毛片/.test(await txt()), await txt());
      // the chooser starts on the newest 精修 folder there is (精修二 here); dropping it
      // gets back to the empty draft this test always started from
      await adminDropDefaultFinal(page, ok, 'shoot/精修二/');
      ok('交件 is disabled until a folder is chosen', await page.$eval('#pd-deliver-btn', b => b.disabled));
      ok('nothing is shown as delivered yet',
        (await page.$('[data-delivered-status]')) === null && (await page.$('#pd-undeliver-btn')) === null);

      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      ok('the chosen folder shows as a chip', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === '["shoot/精修/"]');
      ok('交件 is enabled now', !(await page.$eval('#pd-deliver-btn', b => b.disabled)));
      ok('nothing was sent yet', deliverBodies(m).length === 0);

      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      await page.click('#dn-close-btn');   // the 交件通知 dialog (item 2) opens after every successful 交件
      ok('the deliver call carried final_folders', JSON.stringify(deliverBodies(m)) === '[{"final_folders":["shoot/精修/"]}]', JSON.stringify(deliverBodies(m)));
      ok('the block says 已交件 and lists the final folder',
        (await page.$eval('[data-delivered-status]', e => e.textContent)) === '已交件' &&
        JSON.stringify(await chipTexts(page, '#pd-delivered-folders [data-final-chip]')) === '["shoot/精修/"]');
      ok('更換精修資料夾 and 取消交件 are offered; 交件 is gone',
        !!(await page.$('#pd-replace-final-btn')) && !!(await page.$('#pd-undeliver-btn')) && (await page.$('#pd-deliver-btn')) === null);
      ok('the detail header and the project list both show the 已交件 badge',
        (await page.$('.pd-head [data-delivered-badge]')) !== null &&
        await page.waitForSelector('#proj-recent-list [data-delivered-badge]', { state: 'attached', timeout: 3000 }).then(() => true, () => false));
      const firstStamp = m.state.project.delivered_at;

      // repeat deliver: the picker opens with the current finals ticked
      await page.click('#pd-replace-final-btn');
      await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
      await page.click('#folder-picker [data-browse="shoot/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="shoot/精修/"]', { timeout: 3000 });
      ok('the current finals are pre-ticked in the picker',
        await page.$eval('#folder-picker [data-pick-folder="shoot/精修/"]', b => b.checked));
      await page.evaluate(() => {
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修/"]').click();
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修二/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      ok('nothing is sent until 確定更換', deliverBodies(m).length === 1);
      ok('the button now reads 確定更換', (await page.textContent('#pd-deliver-btn')) === '確定更換');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => document.querySelector('#pd-delivered-folders [data-final-chip]')?.dataset.finalChip === 'shoot/精修二/', null, { timeout: 3000 });
      await page.click('#dn-close-btn');
      ok('the second deliver replaced the finals', JSON.stringify(deliverBodies(m)[1]) === '{"final_folders":["shoot/精修二/"]}', JSON.stringify(deliverBodies(m)));
      ok('and kept the first delivered_at', m.state.project.delivered_at === firstStamp);
      ok('the chooser is closed again (更換 offered)', !!(await page.$('#pd-replace-final-btn')));

      // cancelling the chooser sends nothing
      await page.click('#pd-replace-final-btn');
      await page.click('#folder-picker-close');
      await page.click('#pd-final-cancel-btn');
      await page.waitForSelector('#pd-replace-final-btn', { timeout: 3000 });
      ok('取消 leaves the delivery alone', deliverBodies(m).length === 2);

      // undeliver asks first
      let dialogText = '';
      page.once('dialog', d => { dialogText = d.message(); d.dismiss(); });
      await page.click('#pd-undeliver-btn');
      await page.waitForTimeout(300);
      ok('取消交件 shows a confirm dialog that says what happens', /取消交件/.test(dialogText) && /選片畫面/.test(dialogText), dialogText);
      ok('dismissing it keeps the delivery',
        m.state.project.delivered_at !== null && !m.requests.some(r => r.path.endsWith('/undeliver')));
      page.once('dialog', d => d.accept());
      await page.click('#pd-undeliver-btn');
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 3000 });
      ok('accepting it undelivers: the chooser is back, no 已交件',
        m.requests.some(r => r.path.endsWith('/undeliver')) && (await page.$('[data-delivered-status]')) === null &&
        (await page.$('.pd-head [data-delivered-badge]')) === null);
      ok('and the server keeps the folders (final_folders stays, delivered_at is null)',
        m.state.project.delivered_at === null && JSON.stringify(m.state.project.final_folders) === '["shoot/精修二/"]',
        JSON.stringify(m.state.project));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 交件區塊：＋上傳精修 連到 upload.html?folder=<shoot>/精修/&project=<id> ──
{
  const m = pickFakeWorker({ projectId: 'proj-up', title: '上傳精修專案', phase: 'retouching', folders: ['20260819/shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — ＋上傳精修：與「選擇精修資料夾」並排，連到 upload.html（精修資料夾在毛片旁邊、帶 project）',
    `${base}/admin.html#project=proj-up`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);   // the link names its folder once the Worker has said which 精修 folders exist
      const a = await page.$('#pd-delivery #pd-upload-final-btn');
      ok('the 上傳精修 link exists inside the delivery block', !!a);
      if (!a) return out;
      ok('it is an <a> in the same row as 選擇精修資料夾 (not elsewhere)',
        await page.evaluate(() => {
          const l = document.getElementById('pd-upload-final-btn');
          return l.tagName === 'A' && l.parentElement === document.getElementById('pd-final-pick-btn').parentElement;
        }));
      ok('its text says ＋上傳精修', (await a.textContent()).trim() === '＋上傳精修', await a.textContent());
      const u = await page.evaluate(() => {
        const l = document.getElementById('pd-upload-final-btn');
        const url = new URL(l.href);
        return { file: url.pathname.split('/').pop(), folder: url.searchParams.get('folder'), project: url.searchParams.get('project'),
          lock: url.searchParams.get('lock'), display: getComputedStyle(l).display, w: l.getBoundingClientRect().width };
      });
      ok('it goes to upload.html', u.file === 'upload.html', JSON.stringify(u));
      ok('folder is <shoot>/精修/ — the parent of the proof folder, side by side with 毛片', u.folder === '20260819/shoot/精修/', JSON.stringify(u));
      ok('and carries the project id', u.project === 'proj-up', JSON.stringify(u));
      ok('and locks the target there (the proofs are in …/毛片/)', u.lock === '1', JSON.stringify(u));
      ok('it is actually rendered (not hidden by CSS)', u.display !== 'none' && u.w > 20, JSON.stringify(u));
      const look = await page.evaluate(() => {
        const l = document.getElementById('pd-upload-final-btn'), b = document.getElementById('pd-final-pick-btn');
        const lr = l.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { deco: getComputedStyle(l).textDecorationLine, dh: Math.abs(lr.height - br.height), sameRow: Math.abs(lr.top - br.top) < 4 };
      });
      ok('looks like its sibling button: no underline, same height, same row', look.deco === 'none' && look.dh <= 2 && look.sameRow, JSON.stringify(look));
      // following it lands on upload.html with the back link pointing at the project
      await page.goto(await page.$eval('#pd-upload-final-btn', l => l.href), { waitUntil: 'load' });
      ok('upload.html then offers ← 返回專案 to this project',
        (await page.$eval('.btn-back', e => e.textContent.trim())) === '← 返回專案' &&
        (await page.$eval('.btn-back', e => e.getAttribute('href'))) === 'admin.html#project=proj-up');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // a project folder that is a single segment: no shoot to infer → only ?project=
  const m = pickFakeWorker({ projectId: 'proj-up-flat', phase: 'retouching', folders: ['20260819/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — ＋上傳精修：專案資料夾只有一層（推不出 shoot）→ 只帶 ?project=，不亂猜資料夾',
    `${base}/admin.html#project=proj-up-flat`,
    async page => {
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      const u = await page.evaluate(() => {
        const l = document.getElementById('pd-upload-final-btn');
        if (!l) return null;
        const url = new URL(l.href);
        return { file: url.pathname.split('/').pop(), folder: url.searchParams.get('folder'), project: url.searchParams.get('project') };
      });
      return [
        u ? 'ok    link exists' : 'FAIL  link missing',
        u && u.file === 'upload.html' && u.project === 'proj-up-flat' ? 'ok    goes to upload.html with the project' : `FAIL  ${JSON.stringify(u)}`,
        u && u.folder === null ? 'ok    no guessed folder param' : `FAIL  folder guessed: ${JSON.stringify(u)}`,
      ];
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // first proof folder too shallow, a later one is fine; ids needing encoding
  const m = pickFakeWorker({ projectId: 'p&x=1 #2', phase: 'retouching', folders: ['2026/', '20260901/婚禮/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — ＋上傳精修：用第一個推得出 shoot 的毛片資料夾；project id 有特殊字元時 URL 正確編碼',
    `${base}/admin.html#project=${encodeURIComponent('p&x=1 #2')}`,
    async page => {
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      const u = await page.evaluate(() => {
        const url = new URL(document.getElementById('pd-upload-final-btn').href);
        return { folder: url.searchParams.get('folder'), project: url.searchParams.get('project'), keys: [...url.searchParams.keys()] };
      });
      return [
        u.folder === '20260901/婚禮/精修/' ? 'ok    folder from the second proof folder' : `FAIL  ${JSON.stringify(u)}`,
        // the lock is the one new parameter: …/毛片/ makes the target a known folder
        u.project === 'p&x=1 #2' && JSON.stringify(u.keys) === '["folder","project","lock"]' ? 'ok    project id round-trips, no param injection (folder, project, lock)' : `FAIL  ${JSON.stringify(u)}`,
      ];
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-up-hidden', phase: 'picking', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — 不在精修中、也沒交件：整個交件區塊（含＋上傳精修）是空的、display:none',
    `${base}/admin.html#project=proj-up-hidden`,
    async page => {
      await page.waitForSelector('#pd-plan #pd-plan-save', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        link: !!document.getElementById('pd-upload-final-btn'),
        display: getComputedStyle(document.getElementById('pd-delivery')).display,
        html: document.getElementById('pd-delivery').innerHTML,
      }));
      return [r.link === false && r.display === 'none' && r.html === '' ? 'ok    block hidden and empty' : `FAIL  ${JSON.stringify(r)}`];
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 取消交件後保留 final_folders：交件狀態只看 delivered_at；預填上次的精修資料夾 ──
{
  const m = pickFakeWorker({ projectId: 'proj-prefill', phase: 'retouching', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET,
    finalFolders: ['shoot/精修/'] });   // delivered_at null, final_folders set — what the Worker now returns after 取消交件
  await suite('admin 交件 — 未交件但 final_folders 有值：不當作已交件、預填上次的精修資料夾（明確按交件才送出）',
    `${base}/admin.html#project=proj-prefill`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      ok('fixture mirrors the real response: delivered_at null, final_folders set',
        m.state.project.delivered_at === null && JSON.stringify(m.state.project.final_folders) === '["shoot/精修/"]');
      ok('NOT shown as delivered (no status, no replace/undeliver buttons, no header badge)',
        (await page.$('[data-delivered-status]')) === null && (await page.$('#pd-replace-final-btn')) === null &&
        (await page.$('#pd-undeliver-btn')) === null && (await page.$('.pd-head [data-delivered-badge]')) === null);
      await page.waitForSelector('#proj-recent-list [data-project-row]', { state: 'attached', timeout: 5000 });   // the list is hidden behind the open detail
      ok('the project list row is rendered and has no 已交件 badge',
        (await page.$('#proj-recent-list [data-project-row]')) !== null && (await page.$('#proj-recent-list [data-delivered-badge]')) === null);
      ok('the last finals are pre-filled as chips in the delivery block',
        JSON.stringify(await chipTexts(page, '#pd-delivery #pd-final-chips [data-final-chip]')) === '["shoot/精修/"]');
      ok('and the block says they are the 上次選的精修資料夾',
        /上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)), await page.$eval('#pd-delivery', e => e.textContent));
      ok('交件 is enabled and labelled 交件 (not 確定更換)',
        !(await page.$eval('#pd-deliver-btn', b => b.disabled)) && (await page.textContent('#pd-deliver-btn')) === '交件');
      ok('nothing was sent: prefill alone does not deliver', deliverBodies(m).length === 0 && m.state.project.delivered_at === null);

      // editable: drop the chip, pick another, deliver → only then a request goes out
      await page.click('#pd-final-chips [data-remove-final="shoot/精修/"]');
      ok('removing the prefilled chip empties the draft and disables 交件',
        (await page.$('#pd-final-chips [data-final-chip]')) === null && await page.$eval('#pd-deliver-btn', b => b.disabled));
      ok('the hint is gone once the draft no longer is the last selection',
        !/上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)));
      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修二/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      ok('still nothing sent', deliverBodies(m).length === 0);
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      ok('交件 sent exactly the edited folders', JSON.stringify(deliverBodies(m)) === '[{"final_folders":["shoot/精修二/"]}]', JSON.stringify(deliverBodies(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-prefill-send', phase: 'retouching', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — 取消交件後（真實流程）：交件→取消交件→預填上次資料夾→不改直接交件送出原資料夾',
    `${base}/admin.html#project=proj-prefill-send`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 5000 });
      await adminDropDefaultFinal(page, ok, 'shoot/精修二/');
      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      await page.click('#dn-close-btn');
      ok('delivered', m.state.project.delivered_at !== null);
      ok('while delivered the finals are listed as delivered chips (no prefill hint)',
        JSON.stringify(await chipTexts(page, '#pd-delivered-folders [data-final-chip]')) === '["shoot/精修/"]' &&
        !/上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)));
      // 更換精修資料夾 on a delivered project starts from the delivered finals —
      // it is NOT the "last selection" prefill, so no such hint there
      await page.click('#pd-replace-final-btn');
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      await page.click('#folder-picker-close');
      ok('更換 chooser holds the delivered finals but shows no 上次選的 hint',
        JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === '["shoot/精修/"]' &&
        !/上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)));
      await page.click('#pd-final-cancel-btn');
      await page.waitForSelector('#pd-undeliver-btn', { timeout: 3000 });
      page.once('dialog', d => d.accept());
      await page.click('#pd-undeliver-btn');
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 3000 });
      ok('after 取消交件 the Worker still has the finals but no delivered_at',
        m.state.project.delivered_at === null && JSON.stringify(m.state.project.final_folders) === '["shoot/精修/"]');
      ok('and the chooser comes back pre-filled with them, with the hint',
        JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === '["shoot/精修/"]' &&
        /上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)));
      ok('no 已交件 badge on the header or the list after cancelling',
        (await page.$('.pd-head [data-delivered-badge]')) === null && (await page.$('#proj-recent-list [data-delivered-badge]')) === null);
      const before = deliverBodies(m).length;
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      await page.click('#dn-close-btn');
      ok('pressing 交件 again re-delivers the same folders', deliverBodies(m).length === before + 1 &&
        JSON.stringify(deliverBodies(m)[before]) === '{"final_folders":["shoot/精修/"]}', JSON.stringify(deliverBodies(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-reopen-keep', phase: 'retouching', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — 開放修改（reopen）後（真實流程）：交件→開放修改→交件區塊收起→再開始精修→預填上次資料夾',
    `${base}/admin.html#project=proj-reopen-keep`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 5000 });
      await adminDropDefaultFinal(page, ok, 'shoot/精修二/');
      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      await page.click('#dn-close-btn');
      ok('delivered first (positive case)', m.state.project.delivered_at !== null && (await page.$('.pd-head [data-delivered-badge]')) !== null);
      await page.click('#pd-reopen-btn');
      // the detail re-rendered in picking (載入中… in between has no #pd-delivery)
      await page.waitForFunction(() => document.querySelector('.pd-head .badge')?.textContent === '選片中' &&
        !!document.getElementById('pd-delivery'), null, { timeout: 3000 });
      ok('reopen answered like the Worker: picking, no stamp, the finals kept',
        m.state.project.phase === 'picking' && m.state.project.delivered_at === null &&
        JSON.stringify(m.state.project.final_folders) === '["shoot/精修/"]', JSON.stringify(m.state.project));
      ok('picking: the delivery block is hidden and empty (the kept finals are not shown as delivered)',
        await page.$eval('#pd-delivery', e => getComputedStyle(e).display === 'none' && e.innerHTML === '') &&
        (await page.$('[data-delivered-status]')) === null);
      // the guest submits again (outside this page), then 開始精修
      m.state.project.phase = 'submitted';
      await page.click('#pd-start-retouch-btn');
      await page.waitForFunction(() => document.querySelector('.pd-head .badge')?.textContent === '精修中' &&
        !!document.querySelector('#pd-delivery #pd-final-pick-btn'), null, { timeout: 3000 });
      ok('retouching again: the chooser comes back pre-filled with the last finals, with the hint',
        JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === '["shoot/精修/"]' &&
        /上次選的精修資料夾/.test(await page.$eval('#pd-delivery', e => e.textContent)));
      ok('still not delivered (no status, 交件 not 確定更換)',
        (await page.$('[data-delivered-status]')) === null && (await page.textContent('#pd-deliver-btn')) === '交件');
      // nothing pre-filled → 交件 stays disabled; report the FAILs above, not a click timeout
      if (await page.$eval('#pd-deliver-btn', b => b.disabled)) { ok('交件 is enabled by the prefill', false, 'disabled'); return out; }
      const before = deliverBodies(m).length;
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      ok('交件 re-delivers the kept folders', deliverBodies(m).length === before + 1 &&
        JSON.stringify(deliverBodies(m)[before]) === '{"final_folders":["shoot/精修/"]}', JSON.stringify(deliverBodies(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 專案詳情：資料夾、＋上傳毛片、＋上傳精修（自動編號、鎖定）、預設選最新精修 ──
const pfNew = (extra = {}) => pickFakeWorker({ projectId: 'proj-new', title: PF_ROOT, phase: 'retouching', folders: [`${PF_ROOT}/毛片/`],
  pickFiles: [`${PF_ROOT}/毛片/IMG_1.jpg`], ...extra });
const pfFiles = names => [`${PF_ROOT}/毛片/IMG_1.jpg`, ...names.map(n => `${PF_ROOT}/${n}/a.jpg`)];

{
  const m = pfNew();
  await suite('資料夾流程 — 專案詳情：資料夾一行、＋上傳毛片（鎖定在毛片）、＋上傳精修（鎖定在精修）',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      const line = await page.$eval('#pd-folder-line', e => ({ text: e.textContent.trim(), shown: getComputedStyle(e).display !== 'none' })).catch(() => null);
      ok('the detail says 資料夾：<root>/', line && line.shown && line.text === `資料夾：${PF_ROOT}/`, JSON.stringify(line));
      const up = await page.$('.pd-actions #pd-upload-proofs-btn');
      ok('＋上傳毛片 is a link in the top action row', !!up);
      if (!up) return out;
      ok('its text says ＋上傳毛片', (await up.textContent()).trim() === '＋上傳毛片', await up.textContent());
      const a = await pfLink(page, '#pd-upload-proofs-btn');
      ok('it goes to upload.html on <root>/毛片/, for this project, locked',
        a.file === 'upload.html' && a.folder === `${PF_ROOT}/毛片/` && a.project === 'proj-new' && a.lock === '1' && JSON.stringify(a.keys) === '["folder","project","lock"]', JSON.stringify(a));
      const look = await page.evaluate(() => { const l = document.getElementById('pd-upload-proofs-btn'), r = l.getBoundingClientRect(), s = getComputedStyle(l);
        const sib = document.getElementById('pd-download-btn').getBoundingClientRect();
        return { deco: s.textDecorationLine, display: s.display, w: r.width, dh: Math.abs(r.height - sib.height), sameRow: Math.abs(r.top - sib.top) < 40 }; });
      ok('rendered like its sibling buttons: no underline, shown, same height', look.deco === 'none' && look.display !== 'none' && look.w > 20 && look.dh <= 2, JSON.stringify(look));
      const f = await pfLink(page, '#pd-upload-final-btn');
      ok('＋上傳精修 goes to <root>/精修/, for this project, locked',
        f.file === 'upload.html' && f.folder === `${PF_ROOT}/精修/` && f.project === 'proj-new' && f.lock === '1' && f.target === 'ready' &&
        JSON.stringify(f.keys) === '["folder","project","lock"]', JSON.stringify(f));
      ok('and says where it will upload', (await page.$eval('#pd-upload-final-hint', e => e.textContent)).includes(`${PF_ROOT}/精修/`));
      ok('it listed the project root (<root>/) with the admin token to see what exists',
        pfLists(m).some(c => c.prefix === `${PF_ROOT}/` && c.auth === 'Bearer adm'), JSON.stringify(pfLists(m)));
      if (process.env.SHOTS_A) await page.screenshot({ path: `${process.env.SHOTS_A}/project-detail-folders-1500.png`, fullPage: true });
      await page.goto(await page.$eval('#pd-upload-proofs-btn', l => l.href), { waitUntil: 'load' });
      ok('following ＋上傳毛片 lands on the upload page with the target locked on 毛片',
        (await page.$eval('#targetDisplay', e => e.textContent)) === `${PF_ROOT}/毛片/` && (await page.$eval('#targetBar', e => e.dataset.locked)) === '1');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

for (const [names, want] of [[[], '精修'], [['精修'], '精修二'], [['精修', '精修二'], '精修三'], [PF_NAMES.slice(0, 9), '精修十'],
  [PF_NAMES.slice(0, 10), '精修11'], [PF_NAMES.slice(0, 11), '精修12']]) {
  const m = pfNew({ pickFiles: pfFiles(names) });
  await suite(`資料夾流程 — ＋上傳精修的下一版：已有 [${names.join('、') || '無'}] → ${want}（不覆蓋前一版）`,
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      const f = await pfLink(page, '#pd-upload-final-btn');
      ok(`the target is <root>/${want}/, locked`, f.folder === `${PF_ROOT}/${want}/` && f.lock === '1' && f.target === 'ready', JSON.stringify(f));
      ok('it is not one of the versions that already exist', !names.map(n => `${PF_ROOT}/${n}/`).includes(f.folder), JSON.stringify(f));
      ok('the hint names the same folder', (await page.$eval('#pd-upload-final-hint', e => e.textContent)).includes(`${PF_ROOT}/${want}/`));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew({ pickFiles: pfFiles(['精修']), listDelay: { [`${PF_ROOT}/`]: 900 } });
  await suite('＋上傳精修 — 還沒確認既有版本時連結不帶資料夾（點太快也蓋不掉前一版）；確認後才換成下一版',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-upload-final-btn', { timeout: 5000 });
      const early = await pfLink(page, '#pd-upload-final-btn');
      ok('while checking: data-target=checking, no folder, no lock, still ?project=',
        early.target === 'checking' && early.folder === null && early.lock === null && early.project === 'proj-new' && early.file === 'upload.html', JSON.stringify(early));
      await pfWaitFinalsLink(page);
      const late = await pfLink(page, '#pd-upload-final-btn');
      ok('once the listing is back it points at the next version, locked', late.folder === `${PF_ROOT}/精修二/` && late.lock === '1' && late.target === 'ready', JSON.stringify(late));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

for (const fail of [500, 'net']) {
  const m = pfNew({ listFail: fail });
  await suite(`＋上傳精修 — 讀不到既有資料夾（${fail}）：連結不帶資料夾也不鎖定，旁邊說明原因；毛片連結、交件照常`,
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      const f = await pfLink(page, '#pd-upload-final-btn');
      ok('failed state: no folder, no lock, only ?project=', f.target === 'failed' && f.folder === null && f.lock === null && f.project === 'proj-new', JSON.stringify(f));
      const note = await page.$eval('#pd-upload-final-note', e => ({ text: e.textContent, shown: getComputedStyle(e).display !== 'none' })).catch(() => null);
      ok('a note says it could not read the folders and to choose one on the upload page', note && note.shown && /無法|讀不到/.test(note.text) && /自己選|上傳頁/.test(note.text), JSON.stringify(note));
      const p = await pfLink(page, '#pd-upload-proofs-btn');
      ok('＋上傳毛片 needs no listing and stays locked on 毛片', p.folder === `${PF_ROOT}/毛片/` && p.lock === '1', JSON.stringify(p));
      ok('nothing is preselected for 交件 and it is disabled', (await page.$('#pd-final-chips [data-final-chip]')) === null && await page.$eval('#pd-deliver-btn', b => b.disabled));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 交件資料夾選擇器：預設選最新的精修*（上次選的優先，不動已交件）──
{
  const m = pfNew({ pickFiles: pfFiles(['精修', '精修二']) });
  await suite('交件 — 預設選取最新的精修資料夾（精修二），可修改，按交件才送出',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 5000 }).catch(() => {});
      ok('the newest 精修 folder is preselected as the draft', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === JSON.stringify([`${PF_ROOT}/精修二/`]), JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')));
      ok('and the block says so (default, editable, nothing sent until 交件)', !!(await page.$('#pd-delivery [data-final-default-hint]')) && !(await page.$('#pd-delivery [data-final-last-hint]')));
      ok('交件 is enabled and nothing was sent yet', !(await page.$eval('#pd-deliver-btn', b => b.disabled)) && deliverBodies(m).length === 0);
      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      ok('交件 sent exactly that folder', JSON.stringify(deliverBodies(m)) === JSON.stringify([{ final_folders: [`${PF_ROOT}/精修二/`] }]), JSON.stringify(deliverBodies(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew();
  await suite('交件 — 還沒有任何精修資料夾：不預選、交件停用',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      await page.waitForTimeout(200);
      ok('no chip, no hint, 交件 disabled', (await page.$('#pd-final-chips [data-final-chip]')) === null && !(await page.$('#pd-delivery [data-final-default-hint]')) &&
        await page.$eval('#pd-deliver-btn', b => b.disabled));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew({ pickFiles: pfFiles(['精修', '精修二']), finalFolders: [`${PF_ROOT}/精修/`] });
  await suite('交件 — 有上次選的精修資料夾（取消交件後）：預填上次的，不被「最新」蓋掉',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 5000 });
      await pfWaitFinalsLink(page);
      await page.waitForTimeout(200);
      ok('the last choice is what is filled in (精修, not 精修二)', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === JSON.stringify([`${PF_ROOT}/精修/`]), JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')));
      ok('with the 上次選的 hint and no default hint', !!(await page.$('#pd-delivery [data-final-last-hint]')) && !(await page.$('#pd-delivery [data-final-default-hint]')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew({ pickFiles: pfFiles(['精修', '精修二']), finalFolders: [`${PF_ROOT}/精修/`], listDelay: { [`${PF_ROOT}/`]: 1500 } });
  await suite('交件 — 上次選的精修資料夾被你移除後，列表晚到也不會自己填回「最新」',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector(`#pd-final-chips [data-remove-final="${PF_ROOT}/精修/"]`, { timeout: 5000 });
      ok('(the listing is still out)', (await page.$eval('#pd-upload-final-btn', a => a.dataset.target)) === 'checking');
      await page.click(`#pd-final-chips [data-remove-final="${PF_ROOT}/精修/"]`);
      await pfWaitFinalsLink(page);
      await page.waitForTimeout(300);
      ok('the draft stays empty (nothing re-filled), 交件 stays disabled', (await page.$('#pd-final-chips [data-final-chip]')) === null &&
        await page.$eval('#pd-deliver-btn', b => b.disabled) && !(await page.$('#pd-delivery [data-final-default-hint]')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew({ pickFiles: pfFiles(['精修', '精修二']), finalFolders: [`${PF_ROOT}/精修/`], deliveredAt: '2026-10-02T00:00:00.000Z' });
  await suite('交件 — 已交件：交件資料夾不被「最新」改動；更換精修資料夾從目前交件的開始',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivered-folders [data-final-chip]', { timeout: 5000 });
      await page.waitForTimeout(500);
      ok('the delivered folders are the ones delivered', JSON.stringify(await chipTexts(page, '#pd-delivered-folders [data-final-chip]')) === JSON.stringify([`${PF_ROOT}/精修/`]));
      ok('no default hint on a delivered project', !(await page.$('#pd-delivery [data-final-default-hint]')));
      await page.click('#pd-replace-final-btn');
      await page.click('#folder-picker-close');
      ok('更換 starts from the delivered finals, not from the newest', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === JSON.stringify([`${PF_ROOT}/精修/`]) &&
        !(await page.$('#pd-delivery [data-final-default-hint]')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pfNew({ pickFiles: pfFiles(['精修', '精修二']), listDelay: { [`${PF_ROOT}/`]: 2500 } });
  await suite('交件 — 預設選取不會蓋掉你已經選好的：列表還沒回來就先手動選了精修，之後不被改成最新',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 5000 });
      ok('(the listing is still out: link is checking)', (await page.$eval('#pd-upload-final-btn', a => a.dataset.target)) === 'checking');
      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, [`${PF_ROOT}/`], [`${PF_ROOT}/精修/`]);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      await pfWaitFinalsLink(page);
      await page.waitForTimeout(300);
      ok('the chosen 精修 stays; the late default did not replace it', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === JSON.stringify([`${PF_ROOT}/精修/`]), JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')));
      ok('and no default hint', !(await page.$('#pd-delivery [data-final-default-hint]')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 舊專案：資料夾由快照決定，推導與連結都不變 ──
{
  const m = pickFakeWorker({ projectId: 'proj-old', title: '舊專案', phase: 'retouching', folders: ['20260819/Anita/'],
    pickFiles: ['20260819/Anita/a.jpg', '20260819/精修/x.jpg', '20260819/精修二/y.jpg'] });
  await suite('舊專案（資料夾不是 …/毛片/）— 連結照舊：＋上傳精修 = <上層>/精修/、不鎖定、不列資料夾、不預選；沒有＋上傳毛片',
    `${base}/admin.html#project=proj-old`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-upload-final-btn', { timeout: 5000 });
      const f = await pfLink(page, '#pd-upload-final-btn');
      ok('the link is final at once (no checking state) and is the old one: <parent>/精修/, ?project=, no lock',
        f.target === 'ready' && f.folder === '20260819/精修/' && f.project === 'proj-old' && f.lock === null && JSON.stringify(f.keys) === '["folder","project"]', JSON.stringify(f));
      await page.waitForTimeout(500);
      ok('no listing of the root was made for it', !pfLists(m).some(c => c.prefix === '20260819/'), JSON.stringify(pfLists(m)));
      ok('no 精修 folder is preselected, no ＋上傳毛片, no hint', (await page.$('#pd-final-chips [data-final-chip]')) === null && !(await page.$('#pd-upload-proofs-btn')) && !(await page.$('#pd-upload-final-hint')));
      ok('the folder line lists the snapshot folders', (await page.$eval('#pd-folder-line', e => e.textContent.trim())) === '資料夾：20260819/Anita/');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-old1', title: '舊專案單層', phase: 'picking', folders: ['20260819/'] });
  await suite('舊專案（單層資料夾）— 資料夾一行照實列出；沒有＋上傳毛片',
    `${base}/admin.html#project=proj-old1`,
    async page => {
      await page.waitForSelector('#pd-folder-line', { timeout: 5000 });
      return [
        (await page.$eval('#pd-folder-line', e => e.textContent.trim())) === '資料夾：20260819/' ? 'ok    folder line' : 'FAIL  folder line',
        !(await page.$('#pd-upload-proofs-btn')) ? 'ok    no ＋上傳毛片' : 'FAIL  ＋上傳毛片 offered for a single-level folder',
      ];
    },
    { before: m.attach, initScript: ADMIN });
}

// ── upload.html：?folder=…&lock=1 鎖定目標資料夾；沒有 lock 時行為不變 ──
{
  const PROOF = `${PF_ROOT}/毛片/`;
  const m = adminMock();
  await suite('upload — ?folder=…&lock=1：目標鎖定（目錄樹隱藏、不載入、不能換、不能新增），檔案傳進鎖定的資料夾',
    `${base}/upload.html?folder=${encodeURIComponent(PROOF)}&project=proj-new&lock=1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#targetDisplay', { timeout: 5000 });
      await page.waitForTimeout(400);
      const s = await page.evaluate(() => ({
        target: document.getElementById('targetDisplay').textContent, hint: document.getElementById('targetHint').textContent,
        locked: document.getElementById('targetBar').dataset.locked || null,
        sidebar: getComputedStyle(document.querySelector('.sidebar')).display, nodes: document.querySelectorAll('.sb-node').length,
        addRoot: !!document.querySelector('.sidebar').offsetParent,
        dropOff: document.getElementById('dropZone').classList.contains('no-target'),
        mainW: document.querySelector('.main').getBoundingClientRect().width, winW: innerWidth }));
      ok('the target is the project folder, shown as locked', s.target === PROOF && /鎖定/.test(s.hint) && s.locked === '1', JSON.stringify(s));
      ok('the folder tree is gone (display:none, no nodes, not even loaded)', s.sidebar === 'none' && s.nodes === 0 && s.addRoot === false && m.seen.filter(r => r.list !== null).length === 0, JSON.stringify([s, m.seen.map(r => r.list)]));
      ok('the drop zone is active and the page uses the full width', s.dropOff === false && s.mainW > s.winW - 40, JSON.stringify(s));
      const t = await page.evaluate(() => { selectFolder('other/'); addFolderToTree('x/y/'); return { target: targetFolder, shown: document.getElementById('targetDisplay').textContent }; });
      ok('selecting or adding another folder from script changes nothing', t.target === PROOF && t.shown === PROOF, JSON.stringify(t));
      await page.setInputFiles('#fileInput', { name: 'a.png', mimeType: 'image/png', buffer: PIXEL });
      await page.waitForSelector('.queue-item.done, .queue-item.error', { timeout: 8000 });
      const puts = m.seen.filter(r => r.method === 'PUT' && !decodeURIComponent(r.path.slice(1)).startsWith('_thumbs/')).map(r => decodeURIComponent(r.path.slice(1)));
      ok('the photo went to the locked folder', JSON.stringify(puts) === JSON.stringify([`${PROOF}a.png`]), JSON.stringify(puts));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

for (const [label, q, want] of [
  ['沒有 lock（只有 folder）', `folder=${encodeURIComponent('20260819/')}`, { locked: false, hint: '已選定', target: '20260819/' }],
  ['lock=1 但沒有 folder', 'lock=1', { locked: false, hint: '', target: '← 從左側點選資料夾' }],
  ['lock=0', `folder=${encodeURIComponent('20260819/')}&lock=0`, { locked: false, hint: '已選定', target: '20260819/' }],
  ['lock=true', `folder=${encodeURIComponent('20260819/')}&lock=true`, { locked: false, hint: '已選定', target: '20260819/' }],
]) {
  const m = adminMock();
  await suite(`upload — ${label}：不鎖定，目錄樹照常，可以換資料夾`,
    `${base}/upload.html?${q}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.sb-node', { timeout: 5000 });
      const s = await page.evaluate(() => ({ target: document.getElementById('targetDisplay').textContent, hint: document.getElementById('targetHint').textContent,
        locked: document.getElementById('targetBar').dataset.locked || null, sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
        nodes: document.querySelectorAll('.sb-node').length }));
      ok('not locked: tree shown and loaded', s.locked === null && s.sidebar !== 'none' && s.nodes > 0, JSON.stringify(s));
      ok(`target / hint as before (${want.target} / ${want.hint || 'empty'})`, s.target === want.target && s.hint === want.hint, JSON.stringify(s));
      await page.click('.sb-node[data-path="20260901/"] .sb-name');
      const after = await page.evaluate(() => ({ target: targetFolder, hint: document.getElementById('targetHint').textContent }));
      ok('clicking another folder in the tree still changes the target', after.target === '20260901/' && after.hint === '已選定', JSON.stringify(after));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

for (const [tag, ctx] of [['390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ['1280', { viewport: { width: 1280, height: 900 } }]]) {
  const m = adminMock();
  await suite(`upload — 鎖定目標的版面 [${tag}]：沒有橫向捲動，目標列與拖放區都看得到`,
    `${base}/upload.html?folder=${encodeURIComponent(`${PF_ROOT}/精修二/`)}&project=proj-new&lock=1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#targetDisplay', { timeout: 5000 });
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, bar: r('targetBar'), drop: r('dropZone'), side: getComputedStyle(document.querySelector('.sidebar')).display }; });
      ok('no horizontal scroll', s.sw <= s.iw, JSON.stringify(s));
      ok('the target bar and the drop zone fit inside the screen', s.bar.left >= 0 && s.bar.right <= s.iw && s.drop.left >= 0 && s.drop.right <= s.iw && s.bar.width > 150, JSON.stringify(s));
      ok('the tree is hidden', s.side === 'none', JSON.stringify(s));
      if (process.env.SHOTS_A) await page.screenshot({ path: `${process.env.SHOTS_A}/upload-locked-${tag}.png`, fullPage: true });
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}
}
