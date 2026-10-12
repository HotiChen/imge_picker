// Browser suites: admin.html 選片專案 list screen on a phone (390px) — the create form is behind a
// 「＋ 新增專案」 button (opens / closes, clean on re-open) and every list row shows exactly ONE status badge
// (confirmed > open revision > delivered > phase), the category in the meta line, 複製連結 / 開啟 in one row.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const ADMIN_URL = `${base}/admin.html`;
const iso = '2026-09-01T00:00:00.000Z';
// main = proj-A (picking, 婚紗, with a live link). Expected single badge per row, written out by hand.
const EXTRA = [
  { id: 'proj-B', title: 'Submitted Co', phase: 'submitted', owner_name: 'Amy', project_type: '婚禮', submission_count: 1, token: 'TB' },
  { id: 'proj-C', title: '精修中專案', phase: 'retouching', project_type: '親子', token: 'TC' },
  { id: 'proj-D', title: 'Delivered Co', phase: 'retouching', delivered_at: iso, token: 'TD', modified_after_submit: true, unnotified_submissions: 2 },
  { id: 'proj-E', title: 'Confirmed Co', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'guest', open_revision_count: 1, token: 'TE' },
  { id: 'proj-F', title: 'Revising Co with a rather long title that has to wrap on a phone screen', phase: 'retouching', delivered_at: iso, open_revision_count: 2, token: 'TF' },
  { id: 'proj-G', title: 'Marked Done', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'photographer', token: 'TG' },
];
const WANT = {
  'proj-A': ['選片中', 'phase'], 'proj-B': ['已送出', 'phase'], 'proj-C': ['精修中', 'phase'],
  'proj-D': ['已交件', 'delivered'], 'proj-E': ['客戶已確認', 'confirm'],
  'proj-F': ['待修改 2', 'confirm'], 'proj-G': ['已標記完成', 'confirm'],
};
const fx = () => pickFakeWorker({ projectId: 'proj-A', title: '王小明 婚紗', phase: 'picking', projectType: '婚紗', folders: ['shoot/毛片/'], extraProjects: EXTRA });
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
const formFields = ['#proj-title', '#proj-date', '#proj-type', '#proj-pick-limit', '#proj-extra-price', '#proj-extra-max', '#proj-create-btn'];
const listGets = m => m.requests.filter(r => r.method === 'GET' && r.path === '/api/admin/projects').length;
const posts = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects');

// ── 1. create form behind the 新增 button ──
{
  const m = fx();
  await suite('admin 專案列表（手機）— 列表畫面沒有建立表單；＋新增專案 開啟、取消 / Esc 關閉、建立成功後關閉並重新整理列表、再開是乾淨的',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('[data-project-row]', { state: 'visible', timeout: 5000 });
      for (const f of formFields) ok(`closed: ${f} is not in the visible layout`, !(await shown(page, f)));
      ok('closed: the create panel is not shown', !(await shown(page, '#project-create-panel')));
      ok('positive control: the 新增專案 button is visible', await shown(page, '#proj-new-btn'));
      const bb = await page.$eval('#proj-new-btn', e => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, top: r.top, txt: e.textContent.trim() }; });
      ok('新增專案 button >= 44px tall, labelled ＋ 新增專案', bb.h >= 44 && bb.txt.includes('新增專案'), JSON.stringify(bb));
      const firstRowTop = await page.$eval('[data-project-row]', e => e.getBoundingClientRect().top);
      ok('the first list row starts within the first screen (form no longer pushes it down; the 進行中/已完成 tabs add ~54px)', firstRowTop < 500, String(firstRowTop));

      await page.tap('#proj-new-btn');
      for (const f of formFields) ok(`open: ${f} is visible`, await shown(page, f));
      ok('open: 取消 button visible and >= 44px', await page.$eval('#proj-create-cancel', e => e.getClientRects().length > 0 && e.getBoundingClientRect().height >= 44).catch(() => false));
      ok('open: the title field has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'proj-title'));

      // 取消 closes and creates nothing
      await page.fill('#proj-title', '會被取消的專案');
      await page.tap('#proj-create-cancel');
      ok('取消 closes the form', !(await shown(page, '#project-create-panel')) && !(await shown(page, '#proj-title')));
      ok('取消 creates nothing (no POST)', posts(m).length === 0, String(posts(m).length));

      // re-open: clean
      await page.tap('#proj-new-btn');
      ok('re-open starts with an empty title (clean form)', (await page.inputValue('#proj-title')) === '');
      // Esc closes
      await page.fill('#proj-title', 'x');
      await page.keyboard.press('Escape');
      ok('Esc closes the form', !(await shown(page, '#project-create-panel')));
      ok('Esc creates nothing', posts(m).length === 0);

      // a failed validation keeps it open with the error; then a clean re-open drops the error
      await page.tap('#proj-new-btn');
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.fill('#proj-pick-limit', '-3');
      await page.evaluate(() => document.getElementById('proj-create-btn').click());
      await page.waitForFunction(() => document.getElementById('proj-create-err').textContent.length > 0, null, { timeout: 3000 });
      ok('an invalid pick limit shows the error and the form stays open', (await shown(page, '#proj-title')) && posts(m).length === 0);
      await page.tap('#proj-create-cancel');
      await page.tap('#proj-new-btn');
      ok('re-open clears the old error and field values', (await page.textContent('#proj-create-err')) === '' && (await page.inputValue('#proj-pick-limit')) === '');

      // successful create
      const before = listGets(m);
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.fill('#proj-pick-limit', '30');
      await page.evaluate(() => document.getElementById('proj-create-btn').click());
      await page.waitForFunction(() => document.getElementById('project-create-panel').hidden, null, { timeout: 4000 });
      ok('a successful create closes the form', !(await shown(page, '#project-create-panel')));
      ok('exactly one POST, with the typed title and limit', posts(m).length === 1 && posts(m)[0].body && posts(m)[0].body.title === '20261004 王小明' && posts(m)[0].body.pick_limit === 30, JSON.stringify(posts(m).map(p => p.body)));
      await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length > 0);
      ok('the list was refreshed after the create', listGets(m) > before, `${before} -> ${listGets(m)}`);
      ok('the list is still shown (rows visible)', await shown(page, '[data-project-row]'));
      ok('after the create the 連結已建立 box (outside the closed form) shows the link', (await shown(page, '#proj-create-result')) && /t=PICK-TOKEN/.test(await page.inputValue('#proj-link-output')));
      await page.tap('#proj-new-btn');
      ok('re-open after a create is clean (title empty, link box gone)', (await page.inputValue('#proj-title')) === '' && !(await shown(page, '#proj-create-result')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// ── 2. one badge per row, order, meta, size ──
{
  const m = fx();
  await suite('admin 專案列表（手機）— 每列只有一個狀態徽章（已確認 > 待修改 > 已交件 > 階段）、類別在 meta 行、複製連結 在右側 >= 44px、列高與不橫向溢出',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('[data-project-row]', { state: 'visible', timeout: 5000 });
      await page.waitForFunction(n => document.querySelectorAll('[data-project-row]').length === n, 5, { timeout: 4000 });   // 進行中 tab: A B C D F (E and G are 已完成)
      const scan = () => page.$$eval('[data-project-row]', els => els.map(r => {
        const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
        const rr = r.getBoundingClientRect();
        const title = r.querySelector('.proj-row-title');
        const btns = [...r.querySelectorAll('[data-copy-link], [data-open-project]')];
        const bs = btns.map(b => b.getBoundingClientRect());
        const badges = [...r.querySelectorAll('.badge')].filter(vis);
        const tr = title ? title.getBoundingClientRect() : null;
        return {
          id: r.dataset.projectRow, h: rr.height, right: rr.right, left: rr.left,
          badges: badges.map(b => b.textContent.trim()), allBadges: r.querySelectorAll('.badge').length,
          badgeInTitle: badges.length === 1 && !!title && title.contains(badges[0]),
          badgeBottom: badges[0] ? badges[0].getBoundingClientRect().bottom : null, titleBottom: tr ? tr.bottom : null,
          meta: (r.querySelector('[data-row-meta]') || {}).textContent || '', tag: (r.querySelector('[data-row-meta] [data-project-type-tag]') || {}).textContent || null,
          btnH: bs.map(b => b.height), btnW: bs.map(b => b.width), btnN: btns.length,
          openShown: !!r.querySelector('[data-open-project]') && vis(r.querySelector('[data-open-project]')),
          copyBox: (() => { const c = r.querySelector('[data-copy-link]'); const b = c ? c.getBoundingClientRect() : null; const mr = r.querySelector('.proj-recent-main').getBoundingClientRect(); return b ? { l: b.left, r: b.right, t: b.top, b: b.bottom, mainR: mr.right, mainT: mr.top, mainB: mr.bottom } : null; })(),
          btnTop: bs.map(b => Math.round(b.top)), metaBottom: r.querySelector('[data-row-meta]').getBoundingClientRect().bottom, btnMinTop: Math.min(...bs.map(b => b.top)),
          data: { phase: r.dataset.phase, delivered: r.dataset.delivered, confirm: r.dataset.confirm, flags: r.dataset.flags },
        };
      }));
      // the confirmed rows live on the 已完成 tab: scan both tabs, same checks for all 7 rows
      const activeRows = await scan();
      await page.tap('[data-pl-tab="done"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length === 2, null, { timeout: 4000 });
      const rows = activeRows.concat(await scan());
      ok('scanned all 7 rows (floor)', rows.length === 7, String(rows.length));
      for (const r of rows) {
        const [label] = WANT[r.id] || [];
        ok(`${r.id}: exactly one badge element in the DOM and one visible`, r.allBadges === 1 && r.badges.length === 1, JSON.stringify(r.badges) + '/' + r.allBadges);
        ok(`${r.id}: the badge reads 「${label}」`, r.badges[0] === label, r.badges[0]);
        ok(`${r.id}: the badge sits on the title line (inside .proj-row-title)`, r.badgeInTitle);
        ok(`${r.id}: row <= ${r.id === 'proj-F' ? 150 : 96}px tall at 390px (long title wraps)`, r.h <= (r.id === 'proj-F' ? 150 : 96), String(r.h));
        ok(`${r.id}: row stays inside the 390px screen`, r.left >= 0 && r.right <= 390, `${r.left}..${r.right}`);
        ok(`${r.id}: 複製連結 is >= 44px tall and wide`, !!r.copyBox && r.btnH[0] >= 44 && r.btnW[0] >= 44, JSON.stringify(r.btnH));
        ok(`${r.id}: 複製連結 sits to the right of the title block, on its own row line (not under the meta)`, !!r.copyBox && r.copyBox.l >= r.copyBox.mainR - 1 && r.copyBox.t < r.copyBox.mainB && r.btnMinTop < r.metaBottom, JSON.stringify(r.copyBox));
        ok(`${r.id}: 開啟 is not shown on a phone (the whole row opens the project)`, r.openShown === false, String(r.openShown));
        ok(`${r.id}: exactly the two buttons are still in the DOM (only 開啟 is hidden)`, r.btnN === 2, String(r.btnN));
      }
      const by = Object.fromEntries(rows.map(r => [r.id, r]));
      ok('the long-title row wraps without extra badge or overflow (<= 150px)', by['proj-F'].h <= 150, String(by['proj-F'].h));
      ok('priority: confirmed beats an open revision (proj-E has both)', by['proj-E'].badges[0] === '客戶已確認' && by['proj-E'].data.confirm === 'confirmed');
      ok('priority: photographer-marked done shows 已標記完成', by['proj-G'].badges[0] === '已標記完成');
      ok('priority: open revision beats delivered', by['proj-F'].badges[0].startsWith('待修改') && by['proj-F'].data.delivered === '1');
      ok('priority: delivered beats phase (retouching) for proj-D', by['proj-D'].badges[0] === '已交件' && by['proj-D'].data.phase === 'retouching');
      ok('data-* keep the full state: D carries delivered=1 and flags modified + unnotified', by['proj-D'].data.delivered === '1' && by['proj-D'].data.flags === 'modified unnotified', JSON.stringify(by['proj-D'].data));
      ok('modified / unnotified are NOT extra badges (still one)', by['proj-D'].badges.length === 1 && by['proj-D'].meta.includes('已修改') && by['proj-D'].meta.includes('2 次送出未寄信'), by['proj-D'].meta);
      ok('category is in the meta line: 婚紗 · … · 送出 0 次', by['proj-A'].tag === '婚紗' && /^婚紗 · .*送出 0 次/.test(by['proj-A'].meta), by['proj-A'].meta);
      ok('category is not a badge', rows.every(r => !r.badges.includes(r.tag)));
      ok('a row without a category has no tag (positive controls above)', by['proj-D'].tag === null);
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, lw: document.getElementById('proj-recent-list').scrollWidth, lc: document.getElementById('proj-recent-list').clientWidth }));
      ok('no horizontal overflow at 390px', overflow.sw <= overflow.cw && overflow.lw <= overflow.lc, JSON.stringify(overflow));

      // the controls above the list: two lines (search + 顯示已封存; 狀態 / 類別 / 排序), not one line each
      await page.tap('[data-pl-tab="active"]');
      const ctl = await page.evaluate(() => {
        const ids = ['pl-q', 'proj-show-archived-toggle', 'pl-status', 'pl-type', 'pl-sort'];
        const box = id => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { id, shown: e.getClientRects().length > 0, t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) }; };
        const f = document.getElementById('pl-filter').getBoundingClientRect();
        const tabs = document.getElementById('pl-tabs').getBoundingClientRect();
        const first = document.querySelector('[data-project-row]').getBoundingClientRect();
        return { boxes: ids.map(box), filterH: Math.round(f.height), tabsBottom: Math.round(tabs.bottom), filterTop: Math.round(f.top), firstTop: Math.round(first.top), archivedInFilter: document.getElementById('pl-filter').contains(document.getElementById('proj-show-archived-toggle')) };
      });
      ok('all five controls are shown (floor)', ctl.boxes.length === 5 && ctl.boxes.every(b => b.shown), JSON.stringify(ctl.boxes));
      const tops = [...new Set(ctl.boxes.map(b => b.t))].sort((a, b) => a - b);
      const lines2 = tops.filter((t, i) => i === 0 || t - tops[i - 1] > 20);   // a line starts where the top jumps by more than a few px of centring
      ok('the controls fill at most two lines', lines2.length <= 2, JSON.stringify(ctl.boxes.map(b => [b.id, b.t])));
      ok('顯示已封存 is in the same line as the search box', ctl.boxes[1].t === ctl.boxes[0].t || Math.abs(ctl.boxes[1].t - ctl.boxes[0].t) < 12, JSON.stringify(ctl.boxes.slice(0, 2)));
      ok('the three selects share one line', ctl.boxes[2].t === ctl.boxes[3].t && ctl.boxes[3].t === ctl.boxes[4].t, JSON.stringify(ctl.boxes.slice(2)));
      ok('nothing leaves the 390px screen', ctl.boxes.every(b => b.l >= 0 && b.r <= 390), JSON.stringify(ctl.boxes));
      ok('the controls take at most 100px of height in all', ctl.firstTop - ctl.tabsBottom <= 150 && ctl.filterH <= 100, JSON.stringify(ctl));
      await page.tap('[data-pl-tab="done"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length === 2, null, { timeout: 4000 });
      // the status filter still reads the same states
      // (the old 已確認 status is now the 已完成 tab, which is still up)
      const ids = await page.$$eval('[data-project-row]', els => els.map(e => e.dataset.projectRow));
      ok('the 已完成 tab lists E and G', JSON.stringify(ids) === '["proj-E","proj-G"]', JSON.stringify(ids));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}
}
