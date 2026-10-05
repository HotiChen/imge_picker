// Browser suites: project folder naming, create-project form, admin project list / detail,
// selection export CSV.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PF_NAMES, PF_ROOT, pfLists } from '../lib/project-helpers.mjs';

export default async function register() {
const pfPosts = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects');

{
  const FORBID = ['/', '\\', '?', '#', '%', '*', ':', '|', '"', '<', '>'];
  const cleanCases = [
    ['王小明', '王小明'], ['Wei & Lin 婚紗', 'Wei & Lin 婚紗'], ['建青 紅葉', '建青 紅葉'], ['a - b_c.d (1)', 'a - b_c.d (1)'],
    ['  a   b  ', 'a b'], ['a\tb\nc', 'a b c'], ['a　b c', 'a b c'],
    ['A\u0000B', 'AB'], ['A\u001fB', 'AB'], ['A\u007fB', 'AB'], ['A\u009fB', 'AB'],
    ['A\u200bB', 'AB'], ['A\u202eB', 'AB'], ['A\ufeffB', 'AB'], ['A\u2028B', 'A B'], ['A😀B', 'A😀B'],
    ['/\\?#%*:|"<>', ''], ['   ', ''], ['', ''], [' / ', ''],
    ...FORBID.map(c => [`A${c}B`, 'AB']),
    ...FORBID.map(c => [`A ${c} B`, 'A B']),
  ];
  const dateCases = [['2026-10-04', '20261004'], ['2026-01-01', '20260101'], ['2028-02-29', '20280229'], ['2099-12-31', '20991231'],
    ['2027-02-29', null], ['2026-13-01', null], ['2026-00-10', null], ['2026-04-31', null], ['2026-1-4', null], ['26-10-04', null],
    ['', null], [null, null], ['2026/10/04', null], ['2026-10-04x', null], ['0026-10-04', null], ['2026-10-4', null]];
  const R = PF_ROOT;
  const nextCases = [
    [[], '精修'], [['毛片'], '精修'], [['精修'], '精修二'], [['精修', '精修二'], '精修三'], [['精修二'], '精修三'],
    [PF_NAMES.slice(0, 9), '精修十'], [PF_NAMES.slice(0, 10), '精修11'], [PF_NAMES.slice(0, 11), '精修12'], [['精修11'], '精修12'],
    [['精修', '精修三'], '精修四'], [['精修final'], '精修'], [['精修', '精修final'], '精修二'], [['精修九', '精修十', '精修11'], '精修12'],
    [['精修十一'], '精修12'], [['精修2', '精修二'], '精修三'], [['毛片', '精修', '雜'], '精修二'],
  ];
  await suite('資料夾命名 — ProjectFolders：常數、名稱清理、日期、資料夾與 title、長度、精修版本號、專案 root',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const loaded = await page.evaluate(() => typeof window.ProjectFolders === 'object' && !!window.ProjectFolders);
      ok('window.ProjectFolders is loaded by admin.html', loaded);
      if (!loaded) return out;
      const k = await page.evaluate(() => { const P = window.ProjectFolders;
        return { proof: P.PROOF_NAME, fin: P.FINAL_NAME, nameMax: P.NAME_MAX, rootMax: P.ROOT_MAX, fileRoom: P.FILE_ROOM, keyMax: P.KEY_MAX, titleMax: P.TITLE_MAX }; });
      ok('the two folder names live in one place: 毛片 / 精修', k.proof === '毛片' && k.fin === '精修', JSON.stringify(k));
      ok('limits: key max mirrors worker PICK_PHOTO_KEY_MAX (256), title max 200', k.keyMax === 256 && k.titleMax === 200, JSON.stringify(k));
      ok('root max = key max − room for a file name − room for 精修NN (so no path the Worker would refuse)',
        k.rootMax > 0 && k.rootMax + k.fileRoom + 16 <= k.keyMax && k.rootMax <= k.titleMax && k.nameMax === k.rootMax - 9, JSON.stringify(k));

      const cleaned = await page.evaluate(cs => cs.map(([i]) => window.ProjectFolders.cleanName(i)), cleanCases);
      const badClean = cleanCases.map(([i, want], n) => [i, want, cleaned[n]]).filter(([, want, got]) => want !== got);
      ok(`cleanName: ${cleanCases.length} cases (every forbidden character, controls, zero-width, spaces, emoji)`, badClean.length === 0, JSON.stringify(badClean.slice(0, 5)));
      const odd = await page.evaluate(() => [window.ProjectFolders.cleanName(null), window.ProjectFolders.cleanName(undefined), window.ProjectFolders.cleanName(123)]);
      ok('cleanName of null / undefined / a number does not throw', JSON.stringify(odd) === '["","","123"]', JSON.stringify(odd));

      const dates = await page.evaluate(cs => cs.map(([i]) => window.ProjectFolders.compactDate(i)), dateCases);
      const badDate = dateCases.map(([i, want], n) => [i, want, dates[n]]).filter(([, want, got]) => want !== got);
      ok(`compactDate: ${dateCases.length} cases (leap days, impossible dates, wrong shapes)`, badDate.length === 0, JSON.stringify(badDate));

      const p = await page.evaluate(() => { const P = window.ProjectFolders; return {
        plain: P.plan('2026-10-04', '王小明'), dirty: P.plan('2026-10-04', ' a/b : c '), emptyName: P.plan('2026-10-04', '  '),
        onlyBad: P.plan('2026-10-04', '///'), noDate: P.plan('', '王'), badDate: P.plan('2026-02-30', '王'),
      }; });
      ok('plan: root, title and the 毛片 folder come from date + name',
        p.plain.ok === true && p.plain.root === PF_ROOT && p.plain.title === PF_ROOT && p.plain.proofFolder === `${PF_ROOT}/毛片/` && p.plain.truncated === false, JSON.stringify(p.plain));
      ok('plan: a dirty name is cleaned first (one space between the parts)', p.dirty.ok && p.dirty.root === '20261004 ab c', JSON.stringify(p.dirty));
      ok('plan: an empty name, or one that cleans to nothing, is refused', p.emptyName.ok === false && p.emptyName.reason === 'name' && p.onlyBad.ok === false && p.onlyBad.reason === 'name', JSON.stringify([p.emptyName, p.onlyBad]));
      ok('plan: a missing or impossible date is refused', p.noDate.ok === false && p.noDate.reason === 'date' && p.badDate.ok === false && p.badDate.reason === 'date', JSON.stringify([p.noDate, p.badDate]));

      const len = await page.evaluate(() => { const P = window.ProjectFolders; const cp = s => [...s].length;
        const lone = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
        const mk = n => P.plan('2026-10-04', n);
        const long = mk('字'.repeat(300)), ascii = mk('x'.repeat(500)), emoji = mk('😀'.repeat(300));
        const exact = mk('y'.repeat(P.NAME_MAX)), over = mk('y'.repeat(P.NAME_MAX + 1)), sp = mk('x'.repeat(P.NAME_MAX - 1) + ' y');
        return { long: [cp(long.root), cp(long.title), cp(long.proofFolder), long.truncated], ascii: [cp(ascii.root), ascii.truncated],
          emoji: [cp(emoji.root), lone(emoji.root), emoji.truncated], exact: [cp(exact.root), exact.truncated], over: [cp(over.root), over.truncated],
          sp: [sp.root.endsWith(' '), sp.truncated], max: P.ROOT_MAX, file: P.FILE_ROOM }; });
      ok('a 300-character name is cut: root ≤ ROOT_MAX, title ≤ 200, the folder key leaves room for a file name',
        len.long[0] === len.max && len.long[1] <= 200 && len.long[2] + len.file <= 256 && len.long[3] === true, JSON.stringify(len));
      ok('ASCII too', len.ascii[0] === len.max && len.ascii[1] === true, JSON.stringify(len.ascii));
      ok('cutting never splits an emoji (code points, not UTF-16 units)', len.emoji[0] === len.max && len.emoji[1] === false && len.emoji[2] === true, JSON.stringify(len.emoji));
      ok('boundary: exactly NAME_MAX characters is kept whole, one more is cut', len.exact[0] === len.max && len.exact[1] === false && len.over[0] === len.max && len.over[1] === true, JSON.stringify([len.exact, len.over]));
      ok('a cut that lands after a space does not leave a trailing space', len.sp[0] === false && len.sp[1] === true, JSON.stringify(len.sp));

      const dir = await page.evaluate(() => { const P = window.ProjectFolders; const o = [];
        for (const n of [1, 2, 3, 9, 10, 11, 12, 100]) o.push(P.finalDirName(n));
        const trip = []; for (let n = 1; n <= 120; n++) if (P.parseFinalVersion(P.finalDirName(n)) !== n) trip.push(n);
        const parse = ['精修十一', '精修二十', '精修二十三', '精修九十九', '精修一', '精修2', '精修final', '精修0', '精修 二', '毛片', '', '精修二二', '精修十十', '精修百'].map(x => P.parseFinalVersion(x));
        return { o, trip, parse }; });
      ok('finalDirName: 精修, 精修二 … 精修十, then Arabic: 精修11 / 精修12 / 精修100',
        JSON.stringify(dir.o) === JSON.stringify(['精修', '精修二', '精修三', '精修九', '精修十', '精修11', '精修12', '精修100']), JSON.stringify(dir.o));
      ok('parseFinalVersion round-trips finalDirName for 1…120', dir.trip.length === 0, JSON.stringify(dir.trip));
      ok('parseFinalVersion reads hand-made names (精修十一 = 11, 精修二十三 = 23) and refuses the rest',
        JSON.stringify(dir.parse) === JSON.stringify([11, 20, 23, 99, 1, 2, null, null, null, null, null, null, null, null]), JSON.stringify(dir.parse));

      const nx = await page.evaluate(({ R, cs }) => cs.map(([names]) => {
        const P = window.ProjectFolders; const listed = names.map(n => `${R}/${n}/`);
        return [P.nextFinalFolder(R, listed), P.latestFinalFolder(R, listed)];
      }), { R, cs: nextCases });
      const badNext = nextCases.map(([names, want], n) => [names.join(','), `${R}/${want}/`, nx[n][0]]).filter(([, w, g]) => w !== g);
      ok(`nextFinalFolder: ${nextCases.length} cases (never reuses a number, gaps go on from the biggest, unparseable names ignored)`, badNext.length === 0, JSON.stringify(badNext));
      const latest = await page.evaluate(({ R }) => { const P = window.ProjectFolders; const l = ns => P.latestFinalFolder(R, ns.map(n => `${R}/${n}/`));
        return [l([]), l(['毛片']), l(['精修']), l(['精修', '精修二']), l(['精修二', '精修']), l(['精修', '精修十', '精修九']), l(['精修11', '精修十'])]; }, { R });
      ok('latestFinalFolder: null when there is none, else the biggest version',
        JSON.stringify(latest) === JSON.stringify([null, null, `${R}/精修/`, `${R}/精修二/`, `${R}/精修二/`, `${R}/精修十/`, `${R}/精修11/`]), JSON.stringify(latest));
      const kids = await page.evaluate(({ R }) => { const P = window.ProjectFolders;
        const listed = [`${R}/毛片/`, `${R}/精修二/sub/`, `other/精修五/`, `${R}/精修/`, `${R}精修九/`, `${R}/精修三`];
        return [P.nextFinalFolder(R, listed), P.latestFinalFolder(R, listed)]; }, { R });
      ok('only direct children of this root count (not a deeper folder, another root, or a name that merely shares the prefix)',
        kids[0] === `${R}/精修二/` && kids[1] === `${R}/精修/`, JSON.stringify(kids));

      const roots = await page.evaluate(() => { const P = window.ProjectFolders; const r = f => P.rootOfProject({ folders: f });
        return [r(['20261004 王小明/毛片/']), r(['shoot/毛片/']), r(['2026/', '20260901/婚禮/毛片/']), r(['20260819/']), r(['20260819/Anita/']), r([]), P.rootOfProject({}), P.rootOfProject(null), r(['a/毛片/sub/']), r(['a//b//毛片//'])]; });
      ok('rootOfProject: the parent of a …/毛片/ folder, proof-shaped',
        roots[0].root === PF_ROOT && roots[0].proofShaped === true && roots[0].proofFolder === `${PF_ROOT}/毛片/` &&
        roots[1].root === 'shoot' && roots[1].proofShaped === true, JSON.stringify(roots.slice(0, 2)));
      ok('rootOfProject: the first folder with two levels is used (the old rule), here the second',
        roots[2].root === '20260901/婚禮' && roots[2].proofShaped === true, JSON.stringify(roots[2]));
      ok('rootOfProject: an old-style project (not …/毛片/) still gets a root, but is not proof-shaped',
        roots[4].root === '20260819' && roots[4].proofShaped === false && roots[4].proofFolder === '20260819/Anita/' &&
        roots[8].root === 'a/毛片' && roots[8].proofShaped === false, JSON.stringify([roots[4], roots[8]]));
      ok('rootOfProject: a single level, nothing, or a missing project gives null', roots[3] === null && roots[5] === null && roots[6] === null && roots[7] === null, JSON.stringify([roots[3], roots[5], roots[6], roots[7]]));
      ok('rootOfProject: empty segments are ignored', roots[9] && roots[9].root === 'a/b' && roots[9].proofShaped === true, JSON.stringify(roots[9]));

      const hrefs = await page.evaluate(() => { const P = window.ProjectFolders; return [P.uploadHref('p1', 'x/毛片/', true), P.uploadHref('p1', 'x/精修/', false), P.uploadHref('p&x=1 #2', null, false), P.uploadHref('p1', 'a b/c/', true)]; });
      ok('uploadHref: folder, project, then lock — ids and folders encoded, no folder → only project',
        hrefs[0] === `upload.html?folder=${encodeURIComponent('x/毛片/')}&project=p1&lock=1` &&
        hrefs[1] === `upload.html?folder=${encodeURIComponent('x/精修/')}&project=p1` &&
        hrefs[2] === `upload.html?project=${encodeURIComponent('p&x=1 #2')}` &&
        hrefs[3] === `upload.html?folder=${encodeURIComponent('a b/c/')}&project=p1&lock=1`, JSON.stringify(hrefs));
      return out;
    },
    { initScript: ADMIN });
}

// ── 建專案表單：專案名稱 + 拍攝日期，沒有「選擇資料夾」──
{
  const m = pickFakeWorker({ pickFiles: [] });
  await suite('建立專案 — 表單：專案名稱＋拍攝日期（預設今天），沒有選擇資料夾；預覽、送出的 folders 與 title',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      const f = await page.evaluate(() => {
        const panel = document.getElementById('project-create-panel');
        const lab = id => document.querySelector(`label[for="${id}"]`)?.textContent.trim() || null;
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const d = document.getElementById('proj-date');
        return { shown: !!panel && getComputedStyle(panel).display !== 'none', nameLabel: lab('proj-title'), dateLabel: lab('proj-date'),
          dateType: d && d.type, date: d && d.value, today,
          chooser: !!document.getElementById('proj-pick-folders-btn') || !!document.getElementById('proj-folders-cell') || !!panel.querySelector('.folder-chip'),
          text: panel ? panel.textContent : '', disabled: document.getElementById('proj-create-btn')?.disabled };
      });
      ok('the create panel is on screen (positive)', f.shown === true, JSON.stringify(f));
      ok('the fields are 專案名稱 and 拍攝日期', f.nameLabel === '專案名稱' && f.dateLabel === '拍攝日期', JSON.stringify(f));
      ok('拍攝日期 is a date input that starts on today (Taipei)', f.dateType === 'date' && f.date === f.today, JSON.stringify(f));
      ok('no folder chooser: no 選擇資料夾 button, no chips', f.chooser === false && !f.text.includes('選擇資料夾'), JSON.stringify(f));
      ok('with no name yet 建立 is disabled', f.disabled === true, JSON.stringify(f));

      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      const pv = () => page.$eval('#proj-folder-preview', e => e.textContent);
      ok('the preview names the folder that will be used', (await pv()).includes(`${PF_ROOT}/`), await pv());
      ok('and where 毛片 and 精修 will go', /毛片/.test(await pv()) && /精修/.test(await pv()), await pv());
      ok('建立 is enabled once name and date are valid', (await page.$eval('#proj-create-btn', b => b.disabled)) === false);
      await page.fill('#proj-pick-limit', '40');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const req = pfPosts(m)[0];
      ok('POST folders is exactly [<root>/毛片/]', req && JSON.stringify(req.body.folders) === JSON.stringify([`${PF_ROOT}/毛片/`]), JSON.stringify(req));
      ok('POST title is YYYYMMDD 專案名稱', req && req.body.title === PF_ROOT, JSON.stringify(req));
      ok('the plan fields still go with it', req && req.body.pick_limit === 40 && 'extra_price' in req.body, JSON.stringify(req));
      await page.waitForFunction(() => document.getElementById('proj-title').value === '', null, { timeout: 5000 });   // cleared once the list has reloaded
      const after = await page.evaluate(() => ({ name: document.getElementById('proj-title').value, date: document.getElementById('proj-date').value,
        today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        disabled: document.getElementById('proj-create-btn').disabled }));
      ok('afterwards the form is cleared: empty name, date back to today, 建立 disabled again', after.name === '' && after.date === after.today && after.disabled === true, JSON.stringify(after));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ pickFiles: [] });
  await suite('建立專案 — 名稱清理：禁用字元、空名稱、日期不合法、過長都不會送出 Worker 會拒絕的路徑',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.fill('#proj-date', '2026-10-04');
      const state = async () => page.evaluate(() => ({ preview: document.getElementById('proj-folder-preview').textContent,
        disabled: document.getElementById('proj-create-btn').disabled, err: document.getElementById('proj-create-err').textContent }));
      await page.fill('#proj-title', 'A/B:C*D?E');
      let s = await state();
      ok('禁用字元 are removed in the preview and 建立 stays enabled (positive)', s.preview.includes('20261004 ABCDE/') && s.disabled === false, JSON.stringify(s));
      for (const [label, name] of [['only spaces', '    '], ['only forbidden characters', '/ \\ ? # % * : | " < >'], ['empty', '']]) {
        await page.fill('#proj-title', name);
        s = await state();
        ok(`${label}: nothing to create — disabled, the preview asks for a name`, s.disabled === true && /專案名稱/.test(s.preview) && !s.preview.includes('20261004'), JSON.stringify(s));
      }
      // the click handler refuses too, should the button ever be enabled
      await page.evaluate(() => { const b = document.getElementById('proj-create-btn'); b.disabled = false; b.click(); });
      await page.waitForTimeout(300);
      ok('a forced click with an empty name sends nothing and says why', pfPosts(m).length === 0 && /專案名稱/.test((await state()).err), JSON.stringify(await state()));
      await page.fill('#proj-title', '王小明');
      await page.fill('#proj-date', '');
      s = await state();
      ok('no date: disabled, the preview asks for a date', s.disabled === true && /拍攝日期/.test(s.preview), JSON.stringify(s));
      await page.evaluate(() => { const b = document.getElementById('proj-create-btn'); b.disabled = false; b.click(); });
      await page.waitForTimeout(300);
      ok('a forced click with no date sends nothing', pfPosts(m).length === 0 && /拍攝日期/.test((await state()).err), JSON.stringify(await state()));
      await page.fill('#proj-date', '2026-10-04');
      ok('a valid date brings 建立 back', (await state()).disabled === false);

      await page.fill('#proj-title', '字'.repeat(400));
      s = await state();
      ok('a 400-character name is cut and the preview says so', s.disabled === false && /過長|截|太長/.test(s.preview), JSON.stringify(s));
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const b = pfPosts(m)[0].body;
      const cp = x => [...x].length;
      ok('the POST stays inside what the Worker accepts: title ≤ 200, the folder (with 精修NN and a file name) ≤ 256',
        cp(b.title) <= 200 && cp(b.folders[0]) + 64 <= 256 && b.title.startsWith('20261004 字') && b.folders[0] === `${b.title}/毛片/`, JSON.stringify([cp(b.title), cp(b.folders[0])]));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 撞名提示（非阻擋）──
for (const [label, opts, want] of [
  ['已有 2 張照片', { pickFiles: [`${PF_ROOT}/毛片/a.jpg`, `${PF_ROOT}/毛片/b.jpg`, `${PF_ROOT}/精修/c.jpg`] }, { state: 'existing', text: '這個資料夾已有 2 張照片，會沿用' }],
  ['沒有檔案', { pickFiles: [`${PF_ROOT}/精修/c.jpg`, 'other/毛片/z.jpg'] }, { state: 'empty', text: '上傳第一張' }],
  ['只有子資料夾（整個資料夾上傳進來的）', { pickFiles: [`${PF_ROOT}/毛片/Card1/a.jpg`, `${PF_ROOT}/毛片/Card2/a.jpg`] }, { state: 'existing', text: '這個資料夾已有 2 個子資料夾' }],
  ['列表失敗（500）', { pickFiles: [], listFail: 500 }, { state: 'unknown', text: '無法確認' }],
  ['列表失敗（連線中斷）', { pickFiles: [], listFail: 'net' }, { state: 'unknown', text: '無法確認' }],
]) {
  const m = pickFakeWorker(opts);
  await suite(`建立專案 — 撞名提示（不阻擋）：${label}`,
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.waitForSelector(`#proj-folder-note[data-state="${want.state}"]`, { timeout: 4000 }).catch(() => {});
      const note = await page.$eval('#proj-folder-note', e => ({ state: e.dataset.state || null, text: e.textContent, shown: getComputedStyle(e).display !== 'none' }));
      ok(`the note is in state "${want.state}" and says: …${want.text}…`, note.state === want.state && note.text.includes(want.text) && note.shown, JSON.stringify(note));
      const asked = pfLists(m).filter(c => c.prefix === `${PF_ROOT}/毛片/`);
      ok('it asked the Worker to list exactly <root>/毛片/ with the admin token', asked.length >= 1 && asked.every(c => c.auth === 'Bearer adm'), JSON.stringify(pfLists(m)));
      ok('建立 is enabled whatever the answer', (await page.$eval('#proj-create-btn', b => b.disabled)) === false);
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      ok('and creates as usual, with the same folder (the existing photos are reused, not an error)',
        pfPosts(m).length === 1 && JSON.stringify(pfPosts(m)[0].body.folders) === JSON.stringify([`${PF_ROOT}/毛片/`]), JSON.stringify(pfPosts(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

for (const [tag, ctx] of [['390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ['1280', { viewport: { width: 1280, height: 900 } }]]) {
  const m = pickFakeWorker({ pickFiles: [`${PF_ROOT}/毛片/a.jpg`, `${PF_ROOT}/毛片/b.jpg`] });
  await suite(`建立專案 — 版面 [${tag}]：名稱、日期、預覽與撞名提示都在畫面內，沒有橫向捲動`,
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.waitForSelector('#proj-folder-note[data-state="existing"]', { timeout: 4000 });
      const s = await page.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, name: r('proj-title'), date: r('proj-date'), prev: r('proj-folder-preview'), note: r('proj-folder-note'),
          btn: r('proj-create-btn') }; });
      ok('no horizontal scroll', s.sw <= s.iw, JSON.stringify(s));
      ok('every part of the form is inside the screen and has a size', ['name', 'date', 'prev', 'note', 'btn'].every(k => s[k].left >= 0 && s[k].right <= s.iw && s[k].width > 60 && s[k].height > 10), JSON.stringify(s));
      ok('the hint sits below the preview, above the create button', s.prev.bottom <= s.note.top + 1 && s.note.bottom <= s.btn.top + 40, JSON.stringify(s));
      if (process.env.SHOTS_A) await page.screenshot({ path: `${process.env.SHOTS_A}/create-form-${tag}.png`, fullPage: true });
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

{
  const m = pickFakeWorker({ pickFiles: [`${PF_ROOT}/毛片/a.jpg`], listDelay: { [`${PF_ROOT}/毛片/`]: 1200 } });
  await suite('建立專案 — 撞名提示：改名後舊提示馬上清掉、晚到的舊結果不會蓋掉新的；檢查還沒回來也照常能建立',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.waitForTimeout(600);   // past the debounce: the slow listing for 王小明 is now in flight
      ok('the listing for 王小明 was asked for', pfLists(m).some(c => c.prefix === `${PF_ROOT}/毛片/`), JSON.stringify(pfLists(m)));
      await page.fill('#proj-title', '李大華');
      await page.waitForSelector('#proj-folder-note[data-state="empty"]', { timeout: 4000 });
      await page.waitForTimeout(1300);   // the slow answer for 王小明 has arrived by now
      const note = await page.$eval('#proj-folder-note', e => ({ state: e.dataset.state, text: e.textContent }));
      ok('the note still belongs to 李大華 (no photos), not the late answer for 王小明', note.state === 'empty' && !/已有/.test(note.text), JSON.stringify(note));
      // clearing on change: back to 王小明 (whose listing is slow again)
      await page.fill('#proj-title', '王小明');
      const cleared = await page.$eval('#proj-folder-note', e => ({ state: e.dataset.state || null, text: e.textContent.trim() }));
      ok('the moment the name changes the old note is gone', cleared.state !== 'empty' && cleared.state !== 'existing', JSON.stringify(cleared));
      // not blocking: create while the check for this name is still in flight
      const t0 = Date.now();
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      ok('建立 does not wait for the check', Date.now() - t0 < 1100 && pfPosts(m).length === 1, `${Date.now() - t0}ms`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // GET /api/admin/projects replaces the per-browser localStorage cache —
  // this project is never seeded into this browser at all, only served by
  // the fake Worker's list route, which is the point.
  const XSS_TITLE = '"><img src=x onerror="window.__xssTitle=1">';
  const XSS_OWNER = '"><img src=x onerror="window.__xssOwner=1">';
  const m = pickFakeWorker({ title: XSS_TITLE, ownerName: XSS_OWNER });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z' },
  );
  m.state.project.phase = 'submitted';
  m.state.project.modified_after_submit = 1;
  await suite('admin — project list: read from GET /api/admin/projects, not a localStorage cache; phase/owner/modified/submission badges, a copy-link, and escaping',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });

      ok('no localStorage cache is written or read',
        await page.evaluate(() => localStorage.getItem('admin_recent_projects') === null));

      const r = await page.evaluate(() => {
        const row = document.querySelector('[data-project-row]');
        return {
          text: row.textContent,
          injected: document.querySelectorAll('img[src="x"]').length,
          hasCopyBtn: !!row.querySelector('[data-copy-link]'),
        };
      });
      ok('惡意標題／認領人姓名沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('title shown as text, unescaped payload intact', r.text.includes(XSS_TITLE), r.text);
      ok('owner shown as text, unescaped payload intact', r.text.includes(XSS_OWNER), r.text);
      ok('the phase badge is shown', r.text.includes('已送出'), r.text);
      ok('the modified-since-submit badge is shown', r.text.includes('已修改'), r.text);
      ok('the submission count is shown', r.text.includes('1'), r.text);
      ok('a copy-link button is offered when the project has a live token', r.hasCopyBtn === true);

      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible', timeout: 5000 });
      ok('clicking it opens the existing detail view',
        await page.evaluate(() => document.getElementById('project-detail-panel').style.display !== 'none'));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // No live pick link (revoked/expired/never minted): no copy-link button.
  const m = pickFakeWorker({ listToken: null });
  await suite('admin — project list: no copy-link button when the project has no live token',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      const hasCopyBtn = await page.evaluate(() => !!document.querySelector('[data-copy-link]'));
      ok('no copy-link button is rendered', hasCopyBtn === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Grace' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/p1.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p2.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z' },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: 'a@b.com',
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z' },
  );
  m.state.project.phase = 'submitted'; // a real submit is what moves the phase; seeding submissions directly does not
  await suite('admin — project detail: owner, phase, submissions newest-first with a diff, current selections, actions',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      // opened straight from the real GET /api/admin/projects list — no
      // localStorage cache and no reload needed for it to show up
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible' });
      await page.waitForSelector('#pd-submissions .pd-submission');

      const r = await page.evaluate(() => ({
        owner: document.querySelector('.pd-owner').textContent,
        phaseBadge: document.querySelector('.pd-head .badge').textContent,
        submissionBlocks: [...document.querySelectorAll('.pd-submission')].map(b => b.textContent),
        selectionRows: document.querySelectorAll('#project-detail-body table tbody tr').length,
      }));
      ok('shows the current owner', r.owner.includes('Grace'), r.owner);
      ok('shows the phase', r.phaseBadge === '已送出', r.phaseBadge);
      // times render in Asia/Taipei (task: 時間格式), not the raw UTC ISO —
      // 2026-01-0{1,2}T00:00:00Z is 08:00 Taipei the same calendar day
      ok('submissions are newest first', /1\/2 08:00/.test(r.submissionBlocks[0]) && /1\/1 08:00/.test(r.submissionBlocks[1]),
        JSON.stringify(r.submissionBlocks));
      ok('the newest submission’s diff names what changed since the previous one',
        r.submissionBlocks[0].includes('新增') && r.submissionBlocks[0].includes('p0.jpg') &&
        r.submissionBlocks[0].includes('移除') && r.submissionBlocks[0].includes('p2.jpg'),
        r.submissionBlocks[0]);
      ok('current selections only lists rating > 0 (one row, not the zero-rated one)',
        r.selectionRows === 1, String(r.selectionRows));

      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('admin — escHtml(0): a project with zero submissions shows 送出 0 次, not blank',
  `${base}/admin.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('[data-project-row]', { timeout: 5000 });
    const text = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
    ok('shows 送出 0 次, the digit is there', /送出\s*0\s*次/.test(text), text);
    return out;
  },
  { before: pickFakeWorker().attach, initScript: ADMIN });

{
  const m = pickFakeWorker({ ownerName: 'Nora', ownerKey: 'NORA-KEY' });
  await suite('admin — 重設主人 warns that the new owner inherits and can change or delete every pick',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-reset-seat-btn');
      await page.waitForTimeout(200);
      ok('warns that the new owner takes over every current pick and can change or delete it',
        dialogMsg.includes('新的主人會接手目前所有選片，並可修改或刪除'), dialogMsg);
      ok('dismissing it does not reset the seat',
        !m.requests.some(r => r.method === 'POST' && r.path.endsWith('/reset-seat')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Oscar', ownerKey: 'OSCAR-KEY' });
  await suite('admin — project detail: pick links with status, 撤銷, and 產生新連結 with copy',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('[data-token-row]', { timeout: 5000 });

      const before = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        status: document.querySelector('[data-token-row] .badge')?.textContent,
        revokeBtn: !!document.querySelector('[data-revoke-token]'),
      }));
      ok('the live link is listed with its status', before.rows === 1 && before.status === '有效', JSON.stringify(before));
      ok('a live link offers 撤銷', before.revokeBtn);

      page.once('dialog', d => d.accept());
      await page.click('[data-revoke-token]');
      await page.waitForFunction(() =>
        document.querySelector('[data-token-row] .badge')?.textContent === '已撤銷', null, { timeout: 5000 });
      const afterRevoke = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        revokeBtn: !!document.querySelector('[data-revoke-token]'),
      }));
      ok('撤銷 flips it to 已撤銷 and drops its own 撤銷/複製連結 buttons',
        afterRevoke.rows === 1 && afterRevoke.revokeBtn === false, JSON.stringify(afterRevoke));
      ok('the real revoke endpoint was called',
        m.requests.some(r => r.method === 'POST' && /\/api\/shares\/.+\/revoke$/.test(r.path)));

      await page.click('#pd-new-link-btn');
      await page.waitForFunction(() => document.querySelectorAll('[data-token-row]').length === 2, null, { timeout: 5000 });
      const afterMint = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        liveCount: [...document.querySelectorAll('[data-token-row] .badge')].filter(b => b.textContent === '有效').length,
      }));
      ok('產生新連結 adds a fresh live one, the old one stays revoked',
        afterMint.rows === 2 && afterMint.liveCount === 1, JSON.stringify(afterMint));
      ok('the mint endpoint was posted to',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/links')));
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('the new link is copied to the clipboard', /index\.html\?t=PICK-TOKEN-2/.test(clip), clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Paula' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg', '20260819/p1.jpg'], count: 2, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z', notified: 0 },
  );
  await suite('admin — badge "N 次送出未寄信" in the list and detail, and a per-submission 未寄信 marker',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      const listText = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
      ok('the list shows 1 次送出未寄信', listText.includes('1 次送出未寄信'), listText);

      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        headText: document.querySelector('.pd-head').textContent,
        blocks: [...document.querySelectorAll('.pd-submission')].map(b => b.textContent),
      }));
      ok('the detail head shows the same badge', r.headText.includes('1 次送出未寄信'), r.headText);
      ok('the newest (unmailed) submission carries its own 未寄信 marker', r.blocks[0].includes('未寄信'), r.blocks[0]);
      ok('the older, already-mailed one does not', !r.blocks[1].includes('未寄信'), r.blocks[1]);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── 下載需求表 CSV（檔名, 備註, 標示）— js/selection-export.js 的純函式 ──
await suite('selection-export — 純函式：CSV 內容逐字、BOM、跳脫、公式注入、pins 串接',
  'about:blank',
  async () => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    let SE;
    try { SE = createRequire(import.meta.url)('../../js/selection-export.js'); } catch (e) { ok('module loads in node', false, e.message); return out; }
    const csv = SE.selectionsToCsv;
    const BOM = String.fromCharCode(0xFEFF);
    const row = (key, note, marks) => ({ photo_key: key, rating: 5, note, marks });

    ok('starts with a UTF-8 BOM (exactly one)', csv([]).startsWith(BOM) && !csv([]).startsWith(BOM + BOM));
    ok('header only, CRLF-terminated, for an empty selection', csv([]) === BOM + '檔名,備註,標示\r\n', JSON.stringify(csv([])));
    ok('a plain row, verbatim',
      csv([row('20260819/p0.jpg', '請修膚色', [{ x: 0.1, y: 0.2, note: '去痘痘' }])]) ===
      BOM + '檔名,備註,標示\r\n20260819/p0.jpg,請修膚色,①去痘痘\r\n');
    ok('pins join as "①文字 ②文字" in order',
      csv([row('a.jpg', '', [{ x: 0, y: 0, note: '眼袋' }, { x: 1, y: 1, note: '髮絲' }, { x: .5, y: .5, note: '背景' }])]) ===
      BOM + '檔名,備註,標示\r\na.jpg,,①眼袋 ②髮絲 ③背景\r\n');
    ok('a pin without text still numbers its position', csv([row('a.jpg', '', [{ x: 0, y: 0, note: '' }, { x: 1, y: 1, note: '腰' }])]) ===
      BOM + '檔名,備註,標示\r\na.jpg,,① ②腰\r\n');
    ok('no marks / null marks / missing note → empty cells (no "undefined"/"null")',
      csv([row('a.jpg', null, null), { photo_key: 'b.jpg', marks: [] }]) === BOM + '檔名,備註,標示\r\na.jpg,,\r\nb.jpg,,\r\n',
      JSON.stringify(csv([row('a.jpg', null, null), { photo_key: 'b.jpg', marks: [] }])));
    const many = Array.from({ length: 21 }, (_, i) => ({ x: 0, y: 0, note: 'n' + (i + 1) }));
    ok('pin 10 is ⑩, pin 20 is ⑳ and pin 21 falls back to (21)',
      SE.pinsText(many).includes('⑩n10 ⑪n11') && SE.pinsText(many).endsWith('⑳n20 (21)n21'), SE.pinsText(many));

    // escaping
    ok('comma → quoted', csv([row('a.jpg', '紅色, 藍色', null)]).includes('\r\na.jpg,"紅色, 藍色",\r\n'));
    ok('double quote → doubled and quoted', csv([row('a.jpg', '他說"好"', null)]).includes('\r\na.jpg,"他說""好""",\r\n'));
    ok('newline inside a cell → quoted, newline kept', csv([row('a.jpg', '第一行\n第二行', null)]).includes('a.jpg,"第一行\n第二行",\r\n'));
    ok('CR inside a cell → quoted', csv([row('a.jpg', 'x\ry', null)]).includes('"x\ry"'));
    ok('a note with nothing special is NOT quoted', csv([row('a.jpg', '普通', null)]).includes('\r\na.jpg,普通,\r\n'));
    ok('pins cell with a comma/quote is escaped too',
      csv([row('a.jpg', '', [{ x: 0, y: 0, note: 'a,"b"' }])]).includes('a.jpg,,"①a,""b"""\r\n'));
    ok('file name with a comma is quoted', csv([row('a,b.jpg', '', null)]).includes('\r\n"a,b.jpg",,\r\n'));

    // formula injection
    for (const lead of ['=', '+', '-', '@']) {
      const t = csv([row('a.jpg', `${lead}SUM(A1)`, null)]);
      ok(`a note starting with ${lead} gets a leading ' (neutralised)`, t.includes(`\r\na.jpg,'${lead}SUM(A1),\r\n`), JSON.stringify(t));
    }
    ok('tab / CR lead (Excel also treats them as formula starters)',
      csv([row('a.jpg', '\t=1+1', null)]).includes(`'\t=1+1`) && csv([row('a.jpg', '\r=1', null)]).includes(`"'\r=1"`));
    ok('injection check happens before quoting: =a,b → "\'=a,b"', csv([row('a.jpg', '=a,b', null)]).includes(`a.jpg,"'=a,b",`));
    ok('a file name starting with = is neutralised too', csv([row('=cmd|x.jpg', '', null)]).includes(`\r\n'=cmd|x.jpg,,\r\n`));
    ok('a safe cell with "=" in the middle is untouched', csv([row('a.jpg', 'a=b', null)]).includes('\r\na.jpg,a=b,\r\n'));
    ok('a negative-number-looking note is still prefixed (conservative)', csv([row('a.jpg', '-1', null)]).includes(`a.jpg,'-1,`));
    ok('csvCell handles non-strings', SE.csvCell(5) === '5' && SE.csvCell(null) === '' && SE.csvCell(undefined) === '');
    return out;
  });

{
  const m = pickFakeWorker({ ownerName: 'Henry', title: 'CSV 專案' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '請修膚色, 要自然', marks: [{ x: .1, y: .2, note: '去痘痘' }, { x: .5, y: .5, note: '眼袋 "輕微"' }], updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/b.jpg', { rating: 3, note: '=HYPERLINK("http://x")', marks: null, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/c.jpg', { rating: 0, note: '沒選的不要出現', marks: [{ x: 0, y: 0, note: '不要' }], updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 下載需求表(CSV)：只含已選照片、UTF-8 BOM、備註與標示逐字、不問「開始精修」；.txt 下載不變',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-download-csv-btn', { timeout: 5000 });
      ok('the CSV button sits in the same action row as 下載選片',
        await page.evaluate(() => document.getElementById('pd-download-csv-btn').parentElement === document.getElementById('pd-download-btn').parentElement));
      ok('it is labelled with CSV', /CSV/.test(await page.textContent('#pd-download-csv-btn')), await page.textContent('#pd-download-csv-btn'));
      await page.evaluate(() => {
        window.__lastDownloadName = null;
        const orig = document.body.appendChild.bind(document.body);
        document.body.appendChild = (el) => { if (el.tagName === 'A' && el.download) window.__lastDownloadName = el.download; return orig(el); };
      });
      let dialogs = 0;
      const onDialog = d => { dialogs++; d.dismiss(); };
      page.on('dialog', onDialog);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pd-download-csv-btn')]);
      const name = await page.evaluate(() => window.__lastDownloadName);
      ok('the file is named <title>-selected.csv', name === 'CSV 專案-selected.csv', name);
      const buf = readFileSync(await download.path());
      ok('the bytes start with EF BB BF (BOM) exactly once', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF && !(buf[3] === 0xEF && buf[4] === 0xBB), [...buf.slice(0, 6)].join(','));
      const expected = String.fromCharCode(0xFEFF) + '檔名,備註,標示\r\n' +
        '20260819/a.jpg,"請修膚色, 要自然","①去痘痘 ②眼袋 ""輕微"""\r\n' +
        `20260819/b.jpg,"'=HYPERLINK(""http://x"")",\r\n`;
      ok('the content matches verbatim (only ♥ photos; a pin note, a comma, quotes, a formula neutralised)',
        buf.toString('utf8') === expected, JSON.stringify(buf.toString('utf8')));
      ok('the unselected photo is absent', !buf.toString('utf8').includes('c.jpg'));
      await page.waitForTimeout(300);
      ok('no start-retouch confirm and no start-retouch request', dialogs === 0 && !m.requests.some(r => r.path.endsWith('/start-retouch')),
        `${dialogs} dialogs`);

      // the existing .txt export is untouched
      page.off('dialog', onDialog);
      page.once('dialog', d => d.dismiss());
      const [txt] = await Promise.all([page.waitForEvent('download'), page.click('#pd-download-btn')]);
      ok('下載選片 still offers the .txt with just the keys',
        (await page.evaluate(() => window.__lastDownloadName)).endsWith('.txt') &&
        readFileSync(await txt.path(), 'utf8') === '20260819/a.jpg\n20260819/b.jpg\n');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 下載選片 asks whether to start retouching too',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-download-btn');

      // Playwright/headless Chromium does not reliably report a blob: URL
      // download's real filename through suggestedFilename() (reproduced in
      // isolation: it comes back as the literal string "download" even for a
      // plain ASCII name), so the anchor's own `download` attribute — what
      // the app actually set — is captured directly instead.
      await page.evaluate(() => {
        window.__lastDownloadName = null;
        const orig = document.body.appendChild.bind(document.body);
        document.body.appendChild = (el) => {
          if (el.tagName === 'A' && el.download) window.__lastDownloadName = el.download;
          return orig(el);
        };
      });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.accept(); });
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#pd-download-btn'),
      ]);
      ok('asks about starting retouching', dialogMsg.includes('要同時標記為開始精修嗎'), dialogMsg);
      const namedFile = await page.evaluate(() => window.__lastDownloadName);
      ok('offers a .txt file', (namedFile || '').endsWith('.txt'), namedFile);
      const path = await download.path();
      const content = readFileSync(path, 'utf8');
      ok('the file lists the selected key(s)', content.includes('20260819/p0.jpg'), content);

      await page.waitForTimeout(300);
      const startReq = m.requests.find(r => r.method === 'POST' && r.path.endsWith('/start-retouch'));
      ok('accepting the dialog also starts retouching', !!startReq, JSON.stringify(m.requests));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const XSS_NAME = '"><img src=x onerror="window.__xss=1">';
  const m = pickFakeWorker({ ownerName: XSS_NAME });
  m.state.pickers.get('picker-0').relationship = XSS_NAME;
  m.state.pickers.get('picker-0').email = XSS_NAME;
  m.state.selections.set('20260819/p0.jpg', { rating: 3, note: XSS_NAME, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: XSS_NAME, email: XSS_NAME,
    photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 惡意姓名／關係／Email／備註 escaping（專案詳細頁）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      // The table lives inside a collapsed <details> by default (task: 專案選片
      // — admin collapse), so it's attached but not visible until expanded.
      await page.waitForSelector('#project-detail-body table', { state: 'attached' });
      await new Promise(r => setTimeout(r, 300));

      const r = await page.evaluate(payload => ({
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        ownerShown: document.querySelector('.pd-owner').textContent.includes(payload),
        pickersShown: document.getElementById('pd-pickers').textContent.includes(payload),
        submissionsShown: document.getElementById('pd-submissions').textContent.includes(payload),
        selectionsShown: document.querySelector('#project-detail-body table').textContent.includes(payload),
      }), XSS_NAME);
      ok('惡意字串沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false, String(r.fired));
      ok('owner 仍照原樣顯示', r.ownerShown);
      ok('pickers 清單仍照原樣顯示', r.pickersShown);
      ok('送出紀錄仍照原樣顯示', r.submissionsShown);
      ok('目前選取（備註）仍照原樣顯示', r.selectionsShown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
