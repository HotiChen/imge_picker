// Browser suites: the project page header (title, one meta line and 「⋯」; 「設定」 is its first menu item and opens the 專案設定 modal, whose 一般設定 block is the old edit form). The form is a focus-trapped
// modal with 專案名稱 / 拍攝日期 / 攝影類別 and the read-only folder line; one 儲存 sends the same PATCH requests the old
// inline rows did (only for what changed, with the same error messages). 「⋯」 opens a menu of the remaining actions,
// each running exactly the old action (confirm dialogs kept). (File name 99a sorts after 99-; a 100- would sort first.)
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openSettings } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-ed`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-ed', title: '編輯專案', ownerName: '你好', folders: ['20261019 編輯專案/毛片/'],
  bucketFolders: ['20261019 編輯專案/', '20261019 編輯專案/毛片/'], ...o });
const patches = m => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
const posts = (m, what) => m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/' + what));
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
const waitHead = page => page.waitForSelector('#pd-more-btn', { timeout: 5000 });
const active = page => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
const inModal = page => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#pd-edit-modal'));
const menuItems = page => page.$$eval('#pd-more-menu [role="menuitem"], #pd-more-menu [role="separator"]', els => els.map(e => e.getAttribute('role') === 'separator' ? '—' : (e.querySelector('.pd-more-label') || e).textContent.trim()));
const CLIP = `(() => { window.__clip = []; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__clip.push(t); return Promise.resolve(); } }, configurable: true }); } catch (e) {} })();`;
const initAdmin = `(${ADMIN.toString()})();${CLIP}`;

// ═════ header ═════
{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project page header — title, one meta line (日期 · 類別 · 挑選人) and ⋯ (更多); the old inline rows are gone', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    ok('title', (await page.textContent('#pd-title')).trim() === '編輯專案');
    ok('meta line 「2026-10-19 · 婚紗 · 挑選人：你好」', (await page.textContent('#pd-meta')).trim() === '2026-10-19 · 婚紗 · 挑選人：你好', await page.textContent('#pd-meta'));
    ok('no ✎ 編輯 button in the header: 設定 is the first menu item (2026-10-20)', await page.$$eval('#pd-head button:not(.pd-more-item)', bs => bs.length === 1 && bs[0].id === 'pd-more-btn') &&
      (await page.textContent('#pd-settings-btn')).trim() === '設定');
    ok('⋯ button, aria-label 更多, says it opens a menu, closed', await page.$eval('#pd-more-btn', b => b.textContent.trim() === '⋯' && b.getAttribute('aria-label') === '更多' &&
      b.getAttribute('aria-haspopup') === 'menu' && b.getAttribute('aria-expanded') === 'false'));
    ok('the menu is closed (not displayed)', !(await shown(page, '#pd-more-menu')));
    ok('the old inline controls are not on the page (rename form, 拍攝日期 / 攝影類別 rows, the button row)',
      (await page.$$('#pd-rename-btn, #pd-rename-form, #pd-shoot-row, #pd-type-row, #pd-shoot-save, #pd-type-save, .pd-actions')).length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ ownerName: undefined });
  await suite('project page header — no date, no type, nobody yet: the meta line is just 「挑選人：尚無人認領」', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    ok('meta', (await page.textContent('#pd-meta')).trim() === '挑選人：尚無人認領', await page.textContent('#pd-meta'));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

// ═════ 編輯 modal ═════
{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project page edit — the modal: prefilled, folder line read-only, focus trapped, Esc / 取消 close without sending', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.waitForSelector('#pd-edit-modal', { state: 'visible', timeout: 3000 });
    ok('a modal dialog with a name', await page.$eval('#pd-edit-modal [role="dialog"]', d => d.getAttribute('aria-modal') === 'true' && !!d.getAttribute('aria-labelledby')).catch(() => false));
    ok('focus starts in 專案名稱', (await active(page)) === 'pd-rename-input');
    ok('prefilled: name, date, type', (await page.inputValue('#pd-rename-input')) === '編輯專案' && (await page.inputValue('#pd-shoot-input')) === '2026-10-19' && (await page.inputValue('#pd-type-select')) === '婚紗');
    ok('the folder line 「資料夾：20261019 編輯專案/（不能改）」 is text, not a field', (await page.textContent('#pd-edit-folder')).trim() === '資料夾：20261019 編輯專案/（不能改）' &&
      (await page.$$('#pd-edit-folder input, #pd-edit-folder select')).length === 0, await page.textContent('#pd-edit-folder').catch(() => 'absent'));
    let inside = true;
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); inside = inside && await inModal(page); }
    ok('Tab x12 never leaves the modal', inside);
    await page.focus('#pd-rename-input');
    await page.keyboard.press('Shift+Tab');
    ok('Shift+Tab from the first field wraps to the last control inside', await inModal(page), await active(page));
    await page.fill('#pd-rename-input', '半途');
    await page.keyboard.press('Escape');
    ok('Esc closes it, nothing sent, focus back on ⋯', !(await shown(page, '#pd-edit-modal')) && patches(m).length === 0 && (await active(page)) === 'pd-more-btn');
    await openSettings(page);
    ok('reopening shows the stored name again', (await page.inputValue('#pd-rename-input')) === '編輯專案');
    await page.click('#pd-edit-cancel');
    ok('取消 closes it too, nothing sent', !(await shown(page, '#pd-edit-modal')) && patches(m).length === 0);
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project page edit — 儲存 sends one PATCH per changed field (title, shoot_date, project_type), updates the header and the list, closes', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-rename-input', '  新名字 <b>x</b>  ');
    await page.fill('#pd-shoot-input', '2026-10-21');
    await page.selectOption('#pd-type-select', '其他');
    await page.fill('#pd-type-other', '寵物');
    await page.click('#pd-edit-save');
    await page.waitForSelector('#pd-edit-modal', { state: 'hidden', timeout: 4000 }).catch(() => {});
    ok('three PATCHes in order, with the old bodies', JSON.stringify(patches(m)) === JSON.stringify([{ title: '新名字 <b>x</b>' }, { shoot_date: '2026-10-21' }, { project_type: '寵物' }]), JSON.stringify(patches(m)));
    ok('the modal closed', !(await shown(page, '#pd-edit-modal')));
    ok('header title is the new one, as text', (await page.textContent('#pd-title')) === '新名字 <b>x</b>' && (await page.$('#pd-title b')) === null);
    ok('meta line updated', (await page.textContent('#pd-meta')).trim() === '2026-10-21 · 寵物 · 挑選人：你好', await page.textContent('#pd-meta'));
    ok('the list row has the new title too', await page.$eval('[data-project-row="proj-ed"]', r => r.textContent.includes('新名字 <b>x</b>')).catch(() => false));
    await openSettings(page);
    await page.fill('#pd-rename-input', '只改名');
    await page.click('#pd-edit-save');
    await page.waitForSelector('#pd-edit-modal', { state: 'hidden', timeout: 4000 }).catch(() => {});
    ok('changing only the name sends only {title}', JSON.stringify(patches(m).slice(3)) === JSON.stringify([{ title: '只改名' }]), JSON.stringify(patches(m)));
    await openSettings(page);
    await page.fill('#pd-shoot-input', '');
    await page.selectOption('#pd-type-select', '');
    await page.click('#pd-edit-save');
    await page.waitForSelector('#pd-edit-modal', { state: 'hidden', timeout: 4000 }).catch(() => {});
    ok('emptying the date and 未分類 clear them (null)', JSON.stringify(patches(m).slice(4)) === JSON.stringify([{ shoot_date: null }, { project_type: null }]), JSON.stringify(patches(m)));
    ok('meta line is just the picker now', (await page.textContent('#pd-meta')).trim() === '挑選人：你好', await page.textContent('#pd-meta'));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx();
  await suite('project page edit — client-side checks: blank name / empty 其他 are refused with the old messages, nothing sent', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-rename-input', '   ');
    await page.click('#pd-edit-save');
    ok('專案名稱不能空白, modal stays', (await page.textContent('#pd-rename-err')).trim() === '專案名稱不能空白' && await shown(page, '#pd-edit-modal') && patches(m).length === 0);
    await page.fill('#pd-rename-input', '好名字');
    await page.selectOption('#pd-type-select', '其他');
    await page.fill('#pd-type-other', '');
    await page.click('#pd-edit-save');
    ok('請輸入類別名稱, nothing sent', (await page.textContent('#pd-type-err')).trim() === '請輸入類別名稱' && patches(m).length === 0, await page.textContent('#pd-type-err'));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ patchStatus: 400, patchBody: { error: 'Invalid body', code: 'invalid_body' } });
  await suite('project page edit — the Worker refuses the name: 「專案名稱格式不正確（1–200 字）」, modal stays, title unchanged', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-rename-input', '新的');
    await page.click('#pd-edit-save');
    await page.waitForFunction(() => document.getElementById('pd-rename-err').textContent !== '', null, { timeout: 4000 }).catch(() => {});
    ok('message', (await page.textContent('#pd-rename-err')).trim() === '專案名稱格式不正確（1–200 字）', await page.textContent('#pd-rename-err'));
    ok('modal open, title unchanged, 儲存 usable again', await shown(page, '#pd-edit-modal') && (await page.textContent('#pd-title')) === '編輯專案' && !(await page.$eval('#pd-edit-save', b => b.disabled)));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ shootDateColumn: false });
  await suite('project page edit — 拍攝日期 before its migration: the old Chinese message under the date, modal stays', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-shoot-input', '2026-10-05');
    await page.click('#pd-edit-save');
    await page.waitForFunction(() => document.getElementById('pd-shoot-err').textContent !== '', null, { timeout: 4000 }).catch(() => {});
    ok('message', (await page.textContent('#pd-shoot-err')).trim() === '拍攝日期尚未啟用，請先執行 migration（2026-10-07-project-shoot-date.sql）', await page.textContent('#pd-shoot-err'));
    ok('modal stays, the header shows no date', await shown(page, '#pd-edit-modal') && !(await page.textContent('#pd-meta')).includes('2026-10-05'));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

// ═════ ⋯ menu ═════
{
  const m = fx({ phase: 'submitted' });
  await suite('project page more — the menu: items in order, danger ones after a separator, keyboard (arrows, Esc), outside click closes', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await page.click('#pd-more-btn');
    ok('opens: shown, aria-expanded=true', await shown(page, '#pd-more-menu') && (await page.getAttribute('#pd-more-btn', 'aria-expanded')) === 'true');
    ok('items, always the same nine: 設定, 看全部毛片, 複製交件通知文案, 開放修改, 取消交件, —, 重設主人, 封存, 刪除 (the ones that do not apply are grayed, see 99k)', JSON.stringify(await menuItems(page)) === JSON.stringify(['設定', '看全部毛片', '複製交件通知文案', '開放修改', '取消交件', '—', '重設主人', '封存', '刪除']), JSON.stringify(await menuItems(page)));
    ok('focus is on the first item (設定)', (await active(page)) === 'pd-settings-btn');
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown → 看全部毛片', (await active(page)) === 'pd-view-all-btn');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    ok('ArrowUp wraps to the last item (刪除)', (await active(page)) === 'pd-delete-btn');
    const col = await page.$$eval('#pd-reset-seat-btn, #pd-archive-btn, #pd-delete-btn', els => els.map(e => getComputedStyle(e).color));
    ok('the three danger items are in the danger colour', col.length === 3 && col.every(c => c === 'rgb(192, 57, 43)'), JSON.stringify(col));
    const hs = await page.$$eval('#pd-more-menu [role="menuitem"]', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    ok('every item >= 44px tall', hs.every(h => h >= 44), JSON.stringify(hs));
    await page.keyboard.press('Escape');
    ok('Esc closes, focus back on ⋯', !(await shown(page, '#pd-more-menu')) && (await active(page)) === 'pd-more-btn' && (await page.getAttribute('#pd-more-btn', 'aria-expanded')) === 'false');
    await page.click('#pd-more-btn');
    await page.mouse.click(5, 300);
    ok('a click outside closes it', !(await shown(page, '#pd-more-menu')));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['20261019 編輯專案/精修/'] });
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: [], count: 0, pick_limit: null, extra_price: null, created_at: '2026-09-10T00:00:00Z', notified: 1 });
  await suite('project page more — delivered: 複製交件通知文案 and 取消交件 are there; with a submission 刪除 is grayed', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await page.click('#pd-more-btn');
    ok('items', JSON.stringify(await menuItems(page)) === JSON.stringify(['設定', '看全部毛片', '複製交件通知文案', '開放修改', '取消交件', '—', '重設主人', '封存', '刪除']), JSON.stringify(await menuItems(page)));
    await page.click('#pd-copy-notice-btn');
    await page.waitForFunction(() => document.getElementById('pd-copy-notice-status')?.textContent === '已複製', null, { timeout: 3000 }).catch(() => {});
    ok('複製交件通知文案 copies the notice and says 已複製 where it can be seen', (await page.evaluate(() => window.__clip.length)) === 1 &&
      /的成品已經完成/.test(await page.evaluate(() => window.__clip[0])) && await shown(page, '#pd-copy-notice-status'));
    ok('the menu closed after the item ran', !(await shown(page, '#pd-more-menu')));
    let said = '';
    page.once('dialog', d => { said = d.message(); d.dismiss(); });
    await page.click('#pd-more-btn');
    await page.click('#pd-undeliver-btn');
    await page.waitForTimeout(300);
    ok('取消交件 keeps its confirm; dismissing sends nothing', /取消交件/.test(said) && posts(m, 'undeliver').length === 0, said);
    page.once('dialog', d => d.accept());
    await page.click('#pd-more-btn');
    await page.click('#pd-undeliver-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'retouching', null, { timeout: 4000 }).catch(() => {});
    ok('accepting undelivers (one POST, card back to 精修中)', posts(m, 'undeliver').length === 1 && (await page.textContent('#pd-status-label')).trim() === '精修中');
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ phase: 'submitted' });
  await suite('project page more — 重設主人 (confirm) and 開放修改 run the old actions', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    let said = '';
    page.once('dialog', d => { said = d.message(); d.accept(); });
    await page.click('#pd-more-btn');
    await page.click('#pd-reset-seat-btn');
    await page.waitForFunction(() => document.getElementById('pd-meta')?.textContent.includes('尚無人認領'), null, { timeout: 4000 }).catch(() => {});
    ok('重設主人 asked first, then POSTed reset-seat', /重設選片人/.test(said) && posts(m, 'reset-seat').length === 1, said);
    let saidReopen = '';
    page.once('dialog', d => { saidReopen = d.message(); d.accept(); });
    await page.click('#pd-more-btn');
    await page.click('#pd-reopen-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'picking', null, { timeout: 4000 }).catch(() => {});
    ok('開放修改 asked first, then POSTed reopen and the card is 客人選片中', /開放修改/.test(saidReopen) && posts(m, 'reopen').length === 1 && (await page.textContent('#pd-status-label')).trim() === '客人選片中');
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ phase: 'submitted', archivedAt: '2026-09-01T00:00:00.000Z' });
  await suite('project page more — archived: no 封存 in the menu; 取消封存 is in the status card', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await page.click('#pd-more-btn');
    const items = await menuItems(page);
    ok('no 封存 / 取消封存 in the menu', !items.includes('封存') && !items.includes('取消封存'), JSON.stringify(items));
    ok('取消封存 is in the card', !!(await page.$('#pd-status #pd-unarchive-btn')));
    return out;
  }, { before: m.attach, initScript: initAdmin });
}

{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project page header — phone 390px: header fits, ⋯ >= 44px, the modal fits, no sideways scroll', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    const hs = await page.$$eval('#pd-more-btn', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    ok('⋯ >= 44px', hs.length === 1 && hs.every(h => h >= 44), JSON.stringify(hs));
    await openSettings(page);
    const g = await page.evaluate(() => { const b = document.querySelector('#pd-edit-modal [role="dialog"]').getBoundingClientRect();
      return { l: b.left, r: b.right, vw: innerWidth, sw: document.documentElement.scrollWidth,
        hs: [...document.querySelectorAll('#pd-edit-modal button, #pd-edit-modal input:not([type="checkbox"]), #pd-edit-modal select, #pd-edit-modal .pd-switch')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)) }; });
    ok('the dialog is inside the screen', g.l >= 0 && g.r <= g.vw, JSON.stringify(g));
    ok('no horizontal scroll', g.sw <= g.vw, JSON.stringify(g));
    ok('modal controls >= 44px', g.hs.length >= 5 && g.hs.every(h => h >= 44), JSON.stringify(g.hs));
    await page.keyboard.press('Escape');
    await page.click('#pd-more-btn');
    const mg = await page.evaluate(() => { const b = document.getElementById('pd-more-menu').getBoundingClientRect(); return { l: b.left, r: b.right, vw: innerWidth, sw: document.documentElement.scrollWidth }; });
    ok('the menu is inside the screen', mg.l >= 0 && mg.r <= mg.vw && mg.sw <= mg.vw, JSON.stringify(mg));
    return out;
  }, { before: m.attach, initScript: initAdmin, contextOptions: MOBILE });
}

}
