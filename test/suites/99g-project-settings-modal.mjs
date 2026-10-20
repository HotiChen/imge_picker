// Browser suites: the project page's 設定 (2026-10-20). The header shows only ⋯; its menu starts with 「設定」, which opens
// the 「專案設定」 modal: 一般設定 (專案名稱 / 拍攝日期 / 攝影類別, its own 儲存) and 專案設定 (#pd-proofdl 毛片下載 + #pd-plan 方案)
// and a 關閉 button. The page has no 設定 collapsible section any more. (99a covers the general form's validation.)
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openSettings } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-me`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-me', title: '設定專案', ownerName: '你好', folders: ['20261020 設定專案/毛片/'],
  bucketFolders: ['20261020 設定專案/', '20261020 設定專案/毛片/'], ...o });
const patches = m => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
const waitHead = page => page.waitForSelector('#pd-more-btn', { timeout: 5000 });
const active = page => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
const labels = page => page.$$eval('#pd-more-menu [role="menuitem"], #pd-more-menu [role="separator"]', els => els.map(e => e.getAttribute('role') === 'separator' ? '—' : e.textContent.trim()));
const inModal = page => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#pd-edit-modal'));

{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project settings — header has only ⋯; no 設定 section and no ✎ 編輯 on the page; menu starts with 設定 (>= 44px)', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    ok('the header has exactly one button besides menu items: ⋯', await page.$$eval('#pd-head button:not(.pd-more-item)', bs => bs.length === 1 && bs[0].id === 'pd-more-btn'));
    ok('no #pd-edit-btn, no #pd-sec-settings anywhere (positive: the other sections are there)',
      (await page.$$('#pd-edit-btn, #pd-sec-settings, #pd-sec-settings-btn')).length === 0 && (await page.$$('#pd-sec-selections, #pd-sec-orders, #pd-sec-people')).length === 3);
    await page.click('#pd-more-btn');
    await page.waitForSelector('#pd-more-menu', { state: 'visible' });
    const l = await labels(page);
    ok('order: 設定, 看全部毛片, 開放修改, separator, danger items', JSON.stringify(l.slice(0, 4)) === JSON.stringify(['設定', '看全部毛片', '開放修改', '—']) && l.length === 7, JSON.stringify(l));
    ok('the first item holds focus', (await active(page)) === 'pd-settings-btn', await active(page));
    const hs = await page.$$eval('#pd-more-menu [role="menuitem"]', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    ok('items >= 44px (and there are some)', hs.length === 6 && hs.every(h => h >= 44), JSON.stringify(hs));
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown -> 看全部毛片', (await active(page)) === 'pd-view-all-btn', await active(page));
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    ok('ArrowUp from the first wraps to the last item', (await active(page)) === 'pd-delete-btn', await active(page));
    await page.keyboard.press('Escape');
    ok('Esc closes the menu, focus on ⋯', !(await shown(page, '#pd-more-menu')) && (await active(page)) === 'pd-more-btn');
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗', pickLimit: 40 });
  await suite('project settings — 設定 opens the modal: two blocks, the old edit form and the 毛片下載 / 方案 controls; menu closes; 關閉 / Esc / backdrop close it, focus back on ⋯', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    ok('closed to begin with (really not displayed)', !(await shown(page, '#pd-edit-modal')) && !(await shown(page, '#pd-plan')));
    await page.click('#pd-more-btn');
    await page.click('#pd-settings-btn');
    await page.waitForSelector('#pd-edit-modal', { state: 'visible', timeout: 3000 });
    ok('the menu closed', !(await shown(page, '#pd-more-menu')));
    ok('a modal dialog titled 專案設定', await page.$eval('#pd-edit-modal [role="dialog"]', d => d.getAttribute('aria-modal') === 'true' && document.getElementById(d.getAttribute('aria-labelledby')).textContent.trim() === '專案設定'));
    ok('two blocks: 一般設定, 專案設定', JSON.stringify(await page.$$eval('#pd-edit-modal .pd-set-sec > h5', hs => hs.map(h => h.textContent.trim()))) === '["一般設定","專案設定"]');
    ok('一般設定 holds the form (name, date, type, 儲存) and the read-only folder line', await page.$eval('.pd-set-sec:nth-of-type(1)', s => !!s.querySelector('#pd-rename-input') && !!s.querySelector('#pd-shoot-input') &&
      !!s.querySelector('#pd-type-select') && !!s.querySelector('#pd-edit-save') && !!s.querySelector('#pd-edit-folder')).catch(() => false));
    ok('專案設定 holds #pd-proofdl (the switch) and #pd-plan (the plan fields), both on screen', await page.evaluate(() => {
      const s = document.querySelectorAll('#pd-edit-modal .pd-set-sec')[1];
      return !!s && s.contains(document.getElementById('pd-proofdl')) && s.contains(document.getElementById('pd-plan')) && !!document.getElementById('pd-allow-proof-dl') &&
        !!document.getElementById('pd-plan-save') && document.getElementById('pd-plan-limit').getClientRects().length > 0; }));
    ok('the plan shows the project value', (await page.inputValue('#pd-plan-limit')) === '40');
    ok('a 關閉 button at the bottom', (await page.textContent('#pd-edit-cancel')).trim() === '關閉' && await page.evaluate(() => {
      const b = document.getElementById('pd-edit-cancel').getBoundingClientRect(), p = document.getElementById('pd-plan-save').getBoundingClientRect(); return b.top > p.bottom; }));
    ok('focus starts in 專案名稱', (await active(page)) === 'pd-rename-input', await active(page));
    let inside = true;
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); inside = inside && await inModal(page); }
    ok('Tab x16 never leaves the modal', inside);
    await page.fill('#pd-plan-limit', '99');
    await page.fill('#pd-rename-input', '半途');
    await page.click('#pd-edit-cancel');
    ok('關閉 closes it; focus back on ⋯', !(await shown(page, '#pd-edit-modal')) && (await active(page)) === 'pd-more-btn', await active(page));
    await openSettings(page);
    ok('reopening shows what is saved, not what was typed and abandoned (plan and name)', (await page.inputValue('#pd-plan-limit')) === '40' && (await page.inputValue('#pd-rename-input')) === '設定專案');
    await page.keyboard.press('Escape');
    ok('Esc closes it; focus on ⋯', !(await shown(page, '#pd-edit-modal')) && (await active(page)) === 'pd-more-btn', await active(page));
    await openSettings(page);
    await page.mouse.click(4, 4);
    ok('a click on the backdrop closes it; focus on ⋯', !(await shown(page, '#pd-edit-modal')) && (await active(page)) === 'pd-more-btn', await active(page));
    ok('nothing was sent by closing', patches(m).length === 0);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ shootDate: '2026-10-19', projectType: '婚紗' });
  await suite('project settings — 一般設定 儲存: one PATCH per changed field, title and meta line update at once, modal closes, focus on ⋯', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-rename-input', '新設定名');
    await page.fill('#pd-shoot-input', '2026-10-21');
    await page.click('#pd-edit-save');
    await page.waitForSelector('#pd-edit-modal', { state: 'hidden', timeout: 4000 }).catch(() => {});
    ok('PATCH title then shoot_date', JSON.stringify(patches(m)) === JSON.stringify([{ title: '新設定名' }, { shoot_date: '2026-10-21' }]), JSON.stringify(patches(m)));
    ok('header title and meta line follow', (await page.textContent('#pd-title')) === '新設定名' && (await page.textContent('#pd-meta')).trim() === '2026-10-21 · 婚紗 · 挑選人：你好', await page.textContent('#pd-meta'));
    ok('modal closed, focus on ⋯', !(await shown(page, '#pd-edit-modal')) && (await active(page)) === 'pd-more-btn', await active(page));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ pickLimit: 40, extraMax: 10 });
  await suite('project settings — 毛片下載 switch and 方案 save work inside the modal; a refresh after saving the plan keeps the modal open and what is typed in 一般設定', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.fill('#pd-rename-input', '還沒存的名字');
    await page.check('#pd-allow-proof-dl');
    await page.waitForFunction(() => !document.getElementById('pd-allow-proof-dl').disabled, null, { timeout: 3000 });
    ok('the switch sent allow_proof_download: true', JSON.stringify(patches(m)) === JSON.stringify([{ allow_proof_download: true }]), JSON.stringify(patches(m)));
    ok('the modal is still open', await shown(page, '#pd-edit-modal'));
    await page.fill('#pd-plan-limit', '35');
    await page.click('#pd-plan-save');
    await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
    ok('the plan PATCH was sent', patches(m).length === 2 && patches(m)[1].pick_limit === 35, JSON.stringify(patches(m)));
    await page.waitForFunction(() => /45 張（35 \+ 加選 10）/.test(document.getElementById('pd-plan-result')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
    ok('the page was re-read (the plan line shows 45 張（35 + 加選 10）) and the modal is still open', /45 張（35 \+ 加選 10）/.test(await page.textContent('#pd-plan-result')) && await shown(page, '#pd-edit-modal'), await page.textContent('#pd-plan-result'));
    ok('the unsaved name typed in 一般設定 survived the refresh', (await page.inputValue('#pd-rename-input')) === '還沒存的名字', await page.inputValue('#pd-rename-input'));
    ok('only one #pd-edit-modal exists (no copy left behind)', (await page.$$('#pd-edit-modal')).length === 1);
    await page.click('#pd-edit-save');
    await page.waitForSelector('#pd-edit-modal', { state: 'hidden', timeout: 4000 }).catch(() => {});
    ok('儲存 on the carried-over modal still works (one handler: one PATCH)', patches(m).length === 3 && patches(m)[2].title === '還沒存的名字', JSON.stringify(patches(m)));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx();
  await suite('project settings — going back to the list closes the modal; the project opens fresh next time', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForSelector('#project-detail-panel', { state: 'hidden', timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { location.hash = '#project=proj-me'; });
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    ok('the reopened page does not show a modal', !(await shown(page, '#pd-edit-modal')));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ shootDate: '2026-10-19', projectType: '親子', pickLimit: 40 });
  await suite('project settings — phone 390px: the modal fits, scrolls inside when taller than the screen, no sideways scroll, controls >= 44px', URL_, async page => {
    const out = [], ok = line(out);
    await waitHead(page);
    await openSettings(page);
    const g = await page.evaluate(() => {
      const d = document.querySelector('#pd-edit-modal [role="dialog"]'), b = d.getBoundingClientRect();
      return { l: b.left, r: b.right, vw: innerWidth, sw: document.documentElement.scrollWidth, dsw: d.scrollWidth, dcw: d.clientWidth,
        tall: d.scrollHeight > d.clientHeight, oy: getComputedStyle(d).overflowY, bottom: b.bottom, vh: innerHeight,
        hs: [...document.querySelectorAll('#pd-edit-modal button, #pd-edit-modal input:not([type="checkbox"]), #pd-edit-modal select, #pd-edit-modal .pd-switch')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)) };
    });
    ok('the dialog is inside the screen, no sideways scroll (page or dialog)', g.l >= 0 && g.r <= g.vw && g.sw <= g.vw && g.dsw <= g.dcw, JSON.stringify(g));
    ok('taller than the screen → it scrolls inside, and stays within the viewport', g.tall && g.oy === 'auto' && g.bottom <= g.vh, JSON.stringify(g));
    ok('controls >= 44px (and there are plenty)', g.hs.length >= 9 && g.hs.every(h => h >= 44), JSON.stringify(g.hs));
    await page.evaluate(() => { const d = document.querySelector('#pd-edit-modal [role="dialog"]'); d.scrollTop = d.scrollHeight; });
    ok('scrolled to the end, 關閉 is reachable on screen', await page.evaluate(() => { const b = document.getElementById('pd-edit-cancel').getBoundingClientRect(); return b.bottom <= innerHeight + 1 && b.top >= 0; }));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
