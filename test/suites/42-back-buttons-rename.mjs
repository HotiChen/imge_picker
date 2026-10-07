// Browser suites: (A) admin project rename (改名 in the detail header) and (B) the back-control convention:
// page-level back = first control at the top-left, text link (no pill), label "← 返回<目的地>"
// (never "回", never ‹), >= 44px tall on a phone (>= 36px on desktop); folder-level up = "← 上一層".
// The fake (pick-fake.mjs) mirrors the Worker PATCH contract for `title`: string, trimmed, 1-200 chars,
// blank/invalid -> 400 invalid_body (whole body refused), echoes the stored title, works on archived projects.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN, ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const ADMIN_URL = `${base}/admin.html`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-bk', title: '舊名字專案', folders: ['shoot/毛片/'], ...o });
const waitDetail = page => page.waitForSelector('#pd-rename-btn', { timeout: 5000 });
const waitList = page => page.waitForSelector('[data-project-row]', { timeout: 5000 });
const patches = m => m.requests.filter(r => r.method === 'PATCH');
const headTitle = page => page.$eval('#project-detail-body .pd-head h3', e => e.textContent);
const rowTitle = page => page.$eval('[data-project-row="proj-bk"] span', e => e.textContent);
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');

// ═════════════════════ A. rename ═════════════════════
{
  const m = fx();
  await suite('改名 — 編輯框預填目前名稱、Esc 取消不送出；空白被擋（不送出）；提示說資料夾名稱不變',
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      ok('baseline: header shows the current title (positive control)', (await headTitle(page)) === '舊名字專案', await headTitle(page));
      ok('the edit form is closed to begin with (really not displayed)', !(await shown(page, '#pd-rename-form')) && await shown(page, '#pd-rename-btn'));
      ok('改名 button text', (await page.textContent('#pd-rename-btn')).trim() === '改名');
      await page.click('#pd-rename-btn');
      ok('the form opens, the title + 改名 button are replaced', await shown(page, '#pd-rename-form') && !(await shown(page, '#pd-rename-btn')) && !(await shown(page, '#pd-title')));
      ok('input prefilled with the current title, maxlength 200', (await page.inputValue('#pd-rename-input')) === '舊名字專案' && (await page.getAttribute('#pd-rename-input', 'maxlength')) === '200');
      ok('the hint 「只改專案名稱，資料夾名稱不變」 is visible', (await page.textContent('.pd-rename-hint')).trim() === '只改專案名稱，資料夾名稱不變' && await shown(page, '.pd-rename-hint'));
      ok('buttons 儲存 / 取消', (await page.textContent('#pd-rename-save')).trim() === '儲存' && (await page.textContent('#pd-rename-cancel')).trim() === '取消');
      await page.fill('#pd-rename-input', '半途而廢');
      await page.press('#pd-rename-input', 'Escape');
      ok('Esc closes the form; title unchanged; nothing sent', await shown(page, '#pd-rename-btn') && !(await shown(page, '#pd-rename-form')) && (await headTitle(page)) === '舊名字專案' && patches(m).length === 0);
      await page.click('#pd-rename-btn');
      ok('reopening prefills the stored title again, not the abandoned text', (await page.inputValue('#pd-rename-input')) === '舊名字專案');
      await page.fill('#pd-rename-input', '   ');
      await page.click('#pd-rename-save');
      ok('blank: 專案名稱不能空白, form stays open, nothing sent', (await page.textContent('#pd-rename-err')).trim() === '專案名稱不能空白' && await shown(page, '#pd-rename-form') && patches(m).length === 0, await page.textContent('#pd-rename-err'));
      await page.click('#pd-rename-cancel');
      ok('取消 closes it too', !(await shown(page, '#pd-rename-form')) && patches(m).length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx();
  await suite('改名 — Enter 儲存：送出去頭尾去空白的 title；標題、列表那一列、搜尋都立刻換成新名稱（不重新整理）',
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      ok('baseline: the (hidden) list row carries the old title', (await rowTitle(page)) === '舊名字專案', await rowTitle(page));
      await page.click('#pd-rename-btn');
      await page.fill('#pd-rename-input', '  新名字 <b>x</b>  ');
      await page.press('#pd-rename-input', 'Enter');
      await page.waitForFunction(() => document.querySelector('#project-detail-body .pd-head h3')?.textContent === '新名字 <b>x</b>', null, { timeout: 4000 }).catch(() => {});
      ok('exactly one PATCH with {title} trimmed', patches(m).length === 1 && JSON.stringify(patches(m)[0].body) === JSON.stringify({ title: '新名字 <b>x</b>' }) && /\/api\/admin\/projects\/proj-bk$/.test(patches(m)[0].path), JSON.stringify(patches(m).map(p => p.body)));
      ok('header title is the new title, as TEXT (no <b> element made)', (await headTitle(page)) === '新名字 <b>x</b>' && (await page.$('#project-detail-body .pd-head h3 b')) === null);
      ok('the form closed, 改名 is back', !(await shown(page, '#pd-rename-form')) && await shown(page, '#pd-rename-btn'));
      ok('the list row already shows the new title (no reload), as text', (await rowTitle(page)) === '新名字 <b>x</b>' && (await page.$('[data-project-row="proj-bk"] b')) === null, await rowTitle(page));
      ok('detail view undisturbed: hash still #project=proj-bk, panel shown', (await page.evaluate(() => location.hash)).includes('project=proj-bk') && await shown(page, '#project-detail-panel'));
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('back to the list: row shows the new title', await shown(page, '[data-project-row="proj-bk"]') && (await rowTitle(page)) === '新名字 <b>x</b>');
      await page.fill('#pl-q', '新名字');
      await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length === 1, null, { timeout: 3000 }).catch(() => {});
      ok('searching the NEW title finds the project', (await page.$$('[data-project-row]')).length === 1);
      await page.fill('#pl-q', '舊名字');
      await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length === 0, null, { timeout: 3000 }).catch(() => {});
      ok('searching the OLD title finds nothing now', (await page.$$('[data-project-row]')).length === 0 && /沒有符合/.test(await page.textContent('#proj-recent-list')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx({ patchStatus: 400, patchBody: { error: 'Invalid body', code: 'invalid_body' } });
  await suite('改名 — 伺服器回 invalid_body：顯示「專案名稱格式不正確（1–200 字）」，標題不變、表單留著',
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      await page.click('#pd-rename-btn');
      await page.fill('#pd-rename-input', '新的');
      await page.click('#pd-rename-save');
      await page.waitForFunction(() => document.getElementById('pd-rename-err').textContent !== '', null, { timeout: 4000 }).catch(() => {});
      ok('message', (await page.textContent('#pd-rename-err')).trim() === '專案名稱格式不正確（1–200 字）', await page.textContent('#pd-rename-err'));
      ok('a PATCH went out; title unchanged; form still open; save re-enabled', patches(m).length === 1 && (await headTitle(page)) === '舊名字專案' && await shown(page, '#pd-rename-form') && !(await page.$eval('#pd-rename-save', e => e.disabled)));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx({ patchStatus: 500 });
  await suite('改名 — 伺服器 500 / 斷線：顯示「儲存失敗，請再試一次」，標題不變',
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      await page.click('#pd-rename-btn');
      await page.fill('#pd-rename-input', '新的');
      await page.click('#pd-rename-save');
      await page.waitForFunction(() => document.getElementById('pd-rename-err').textContent !== '', null, { timeout: 4000 }).catch(() => {});
      ok('500 -> message', (await page.textContent('#pd-rename-err')).trim() === '儲存失敗，請再試一次', await page.textContent('#pd-rename-err'));
      ok('title unchanged', (await headTitle(page)) === '舊名字專案' && (await rowTitle(page)) === '舊名字專案');
      await page.route('**/api/admin/projects/proj-bk', r => r.request().method() === 'PATCH' ? r.abort() : r.fallback());
      await page.click('#pd-rename-save');
      await page.waitForFunction(() => document.getElementById('pd-rename-err').textContent === '儲存失敗，請再試一次', null, { timeout: 4000 }).catch(() => {});
      ok('network failure -> same message', (await page.textContent('#pd-rename-err')).trim() === '儲存失敗，請再試一次');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx({ archivedAt: '2026-09-01T00:00:00.000Z' });
  await suite('改名 — 已封存的專案也能改名（長標題 200 字可以，輸入框最多 200 字）',
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      ok('baseline: the project really is archived (badge shown)', (await page.textContent('#project-detail-body .pd-head')).includes('已封存'));
      await page.click('#pd-rename-btn');
      await page.fill('#pd-rename-input', 'あ'.repeat(250));
      ok('the field stops at 200 characters', (await page.inputValue('#pd-rename-input')).length === 200);
      await page.press('#pd-rename-input', 'Enter');
      await page.waitForFunction(() => document.querySelector('#project-detail-body .pd-head h3')?.textContent.length === 200, null, { timeout: 4000 }).catch(() => {});
      ok('renamed (200 chars) while archived', (await headTitle(page)) === 'あ'.repeat(200) && patches(m).length === 1, String((await headTitle(page)).length));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ═════════════════════ B. back controls ═════════════════════
// Reads one back control: label, min-height, shape, and whether it is the first interactive thing in its container.
const READ = ({ sel, container }) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  const box = container ? document.querySelector(container) : null;
  const first = box ? box.querySelector('a[href], button, input, select, textarea') : null;
  const sibs = box ? [...box.querySelectorAll('a[href], button, input, select, textarea')].filter(x => x !== el && x.getClientRects().length) : [];
  return {
    text: el.textContent.trim(), h: Math.round(r.height), minH: parseFloat(cs.minHeight) || 0, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth,
    shown: el.getClientRects().length > 0, first: first === el, leftMost: sibs.every(x => r.left <= x.getBoundingClientRect().left + 0.5),
    outline: !!document.querySelector(sel) && (() => { el.focus(); return true; })(),
    sw: document.documentElement.scrollWidth, vw: innerWidth,
  };
};
const read = (page, sel, container) => page.evaluate(READ, { sel, container });
const labelOk = (t, kind) => kind === 'up' ? /^← 上一層$/.test(t) : /^← 返回\S/.test(t);
const noBadGlyphs = t => !t.includes('‹') && !/(^|←\s*)回(?!復)/.test(t);
const SEEN = [];   // every back control found, across suites (the floor)
function check(ok, name, r, { kind = 'page', phone = false, container = true, textLink = false } = {}) {
  ok(`${name}: found and on screen (positive control)`, !!r && r.shown, JSON.stringify(r));
  if (!r) return;
  SEEN.push(name);
  ok(`${name}: label "${r.text}" starts with ${kind === 'up' ? '← 上一層' : '← 返回'}`, labelOk(r.text, kind), r.text);
  ok(`${name}: no ‹ and no bare 「回」`, noBadGlyphs(r.text), r.text);
  if (kind === 'page') ok(`${name}: min-height >= ${phone ? 44 : 36}px (computed ${r.minH}, box ${r.h})`, r.minH >= (phone ? 44 : 36) && r.h >= (phone ? 44 : 36), JSON.stringify(r));
  if (container) ok(`${name}: first control and left-most in its container`, r.first && r.leftMost, JSON.stringify(r));
  if (textLink) ok(`${name}: a text link, not a pill (no border, radius < 20px)`, r.border === '0px' && parseFloat(r.radius) < 20, `${r.border} ${r.radius}`);
  ok(`${name}: no horizontal overflow on the page`, r.sw <= r.vw, `${r.sw} > ${r.vw}`);
}

for (const [label, ctxOpts, phone] of [['桌面', undefined, false], ['手機 390px', MOBILE, true]]) {
  const m = fx();
  await suite(`back-btn — admin 詳情「← 返回專案列表」(${label})`,
    `${ADMIN_URL}#project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await waitDetail(page);
      const r = await read(page, '#pd-back-btn', '#project-detail-panel');
      check(ok, 'admin #pd-back-btn', r, { phone, textLink: true });
      ok('text is exactly 「← 返回專案列表」, a <button type=button>, class back-btn', r.text === '← 返回專案列表' && await page.$eval('#pd-back-btn', b => b.tagName === 'BUTTON' && b.type === 'button' && b.classList.contains('back-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: ctxOpts });

  await suite(`back-btn — upload.html 左上角（有 ?project= / 沒有）(${label})`,
    `${base}/upload.html?project=abc-123`,
    async page => {
      const { out, ok } = lines();
      const r = await read(page, '.header .btn-back', 'header.header');
      check(ok, 'upload ?project', r, { phone, textLink: true });
      ok('upload ?project: 「← 返回專案」 -> admin.html#project=abc-123, exactly one in the header',
        r.text === '← 返回專案' && (await page.$$eval('.btn-back', a => a.length === 1 && a[0].getAttribute('href') === 'admin.html#project=abc-123')));
      ok('it sits before the logo', await page.evaluate(() => { const b = document.querySelector('.header .btn-back'), l = document.querySelector('.header-logo'); return !!(b.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && b.getBoundingClientRect().right <= l.getBoundingClientRect().left + 1; }));
      await page.goto(`${base}/upload.html`, { waitUntil: 'load' });
      const r2 = await read(page, '.header .btn-back', 'header.header');
      check(ok, 'upload (no project)', r2, { phone, textLink: true });
      ok('upload (no project): 「← 返回後台」 -> dashboard.html', r2.text === '← 返回後台' && (await page.$eval('.btn-back', a => a.getAttribute('href'))) === 'dashboard.html');
      ok('the header does not overflow: logo name right edge inside the viewport', await page.evaluate(() => { const l = document.querySelector('.header-logo').getBoundingClientRect(); return l.right <= innerWidth; }));
      return out;
    },
    { contextOptions: ctxOpts });

  const m2 = fx({ ownerName: 'Tina' });
  await suite(`back-btn — 照片檢視（index.html?project=）「← 返回專案」(${label})`,
    `${base}/index.html?project=proj-bk`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      const r = await read(page, '#pvBackLink', '#projectViewBanner');
      check(ok, 'review #pvBackLink', r, { phone });
      ok('review #pvBackLink: exactly 「← 返回專案」, still an <a href=admin.html#project=proj-bk>', r.text === '← 返回專案' && await page.$eval('#pvBackLink', a => a.tagName === 'A' && a.getAttribute('href') === 'admin.html#project=proj-bk'));
      return out;
    },
    { before: m2.attach, initScript: ADMIN, contextOptions: ctxOpts });

  await suite(`back-btn — 編輯器 top bar「← 返回選圖」與 libBackBtn「← 上一層」(${label})`,
    `${base}/book_editor/index.html`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('.top-bar-left a', { timeout: 5000 });
      const r = await read(page, '.top-bar-left > a[href="../index.html"]', '.top-bar-left');
      check(ok, 'editor top-bar back', r, { phone, textLink: true });
      ok('editor top-bar back: exactly 「← 返回選圖」', r.text === '← 返回選圖');
      await page.evaluate(() => { document.getElementById('libNavRow').style.display = 'flex'; });
      const u = await read(page, '#libBackBtn', '#libNavRow');
      check(ok, 'editor #libBackBtn (folder-level)', u, { kind: 'up', container: true });
      return out;
    },
    { contextOptions: ctxOpts });
}

{
  const m = fx();
  await suite('back-btn — app.js 麵包屑「← 上一層」（資料夾層級）與 revision-history「← 返回」',
    `${base}/index.html`,
    async page => {
      const { out, ok } = lines();
      // js/app.js: the template the breadcrumb is drawn from (the live bar needs a folder drive; read the source for the label)
      const app = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
      const m1 = app.match(/<button class="btn btn-text breadcrumb-back"[^>]*>([^<]*)</);
      ok('app.js breadcrumb-back found (positive control)', !!m1);
      ok('app.js breadcrumb-back label is 「← 上一層」 (folder level, not 返回)', !!m1 && m1[1] === '← 上一層', m1 && m1[1]);
      const rh = readFileSync(new URL('../../js/revision-history.js', import.meta.url), 'utf8');
      const m2 = rh.match(/el\('button', '([^']*)', '([^']*)'\);\s*back\.id = 'rhBack'/);
      ok('revision-history rhBack found (positive control)', !!m2);
      ok('rhBack label is 「← 返回」 (no ‹)', !!m2 && m2[2] === '← 返回' && noBadGlyphs(m2[2]), m2 && m2[2]);
      ok('rhBack carries back-btn', !!m2 && m2[1].split(' ').includes('back-btn'), m2 && m2[1]);
      // computed size of that class combination under the real stylesheets, at phone width
      await page.setViewportSize({ width: 390, height: 844 });
      const h = await page.evaluate(() => {
        const b = document.createElement('button'); b.className = 'rh-btn back-btn'; b.textContent = '← 返回'; document.body.appendChild(b);
        const cs = getComputedStyle(b), r = b.getBoundingClientRect(); const o = { minH: parseFloat(cs.minHeight), h: r.height, border: cs.borderTopWidth }; b.remove(); return o;
      });
      ok('rh-btn back-btn: >= 44px tall at 390px, no border', h.minH >= 44 && h.h >= 44 && h.border === '0px', JSON.stringify(h));
      const ob = await page.evaluate(() => { const b = document.getElementById('pickOverBackBtn'); return b ? { text: b.textContent.trim(), first: b.parentElement.firstElementChild === b } : null; });
      ok('pickOverBackBtn keeps 「返回修改」 and is left-most in its action row', !!ob && ob.text === '返回修改' && ob.first, JSON.stringify(ob));
      const obh = await page.evaluate(() => { const b = document.getElementById('pickOverBackBtn'); b.closest('.modal').style.display = 'block'; return parseFloat(getComputedStyle(b).minHeight); });
      ok('pickOverBackBtn min-height >= 44px on the phone', obh >= 44, String(obh));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });

  await suite('back-btn — 總數下限：每個頁面層級的返回都被找到過',
    `${base}/upload.html`,
    async page => {
      const { out, ok } = lines();
      ok(`at least 6 distinct back controls were checked in this file (saw ${new Set(SEEN).size}: ${[...new Set(SEEN)].join(', ')})`, new Set(SEEN).size >= 6, JSON.stringify(SEEN));
      return out;
    });
}
}
