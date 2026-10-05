// Browser suites: pick counter, over-limit submit, desktop preview keys, archive / delete a
// project.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { mockWorker } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { pickHeart, pickSubmits } from '../lib/project-helpers.mjs';

export default async function register() {

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 40, extraPrice: 500 });
  await suite(`pick counter — one counter only, bottom-left, 已選 N / limit 張 (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0);
      await page.waitForTimeout(300);
      // the old header counter is gone from the DOM (not hidden)
      ok('#pickCounterMain and #pickCounterWarn no longer exist',
        await page.evaluate(() => !document.getElementById('pickCounterMain') && !document.getElementById('pickCounterWarn')));
      ok('nothing inside the header renders a count',
        await page.evaluate(() => !document.querySelector('header.header #pickCounter') && !/已選\s*\d/.test(document.querySelector('header.header').textContent)));
      // exactly one element anywhere shows the pick count
      const found = await page.evaluate(() => [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0 && /已選\s*\d+\s*(\/|張)/.test(e.textContent) && e.getBoundingClientRect().width > 0)
        .map(e => ({ id: e.id, text: e.textContent.trim(), x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top })));
      ok('exactly one visible pick counter', found.length === 1, JSON.stringify(found));
      ok('its text is 已選 1 / 40 張', found[0] && found[0].text === '已選 1 / 40 張', JSON.stringify(found));
      const vp = page.viewportSize();
      ok('and it sits bottom-left', found[0] && found[0].x < vp.width / 3 && found[0].y > vp.height * 0.8, JSON.stringify(found[0]));
      ok('the photo position counter of the preview is untouched',
        await page.evaluate(() => !!document.getElementById('photoCounter')));
      ok('the counter is inside the bottom bar', await page.evaluate(() => !!document.querySelector('#mobileActionBar #pickCounter')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY' });
  await suite('pick counter — no limit reads 已選 N 張',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const t0 = await page.textContent('#pickCounter');
      ok('0 picks, no limit', t0 === '已選 0 張', t0);
      await pickHeart(page, 0); await pickHeart(page, 1);
      const t2 = await page.textContent('#pickCounter');
      ok('2 picks, no limit', t2 === '已選 2 張', t2);
      ok('never in over state without a limit', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 2, extraPrice: 500 });
  await suite(`pick counter — turns orange only above the limit, and nothing else is said while picking (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const color = () => page.evaluate(() => getComputedStyle(document.getElementById('pickCounter')).color);
      const bodyText = () => page.evaluate(() => document.body.innerText);
      const normal = await color();
      await pickHeart(page, 0); await pickHeart(page, 1);
      const atLimit = await color();
      ok('at exactly the limit (2 / 2) the colour is unchanged', atLimit === normal, `${atLimit} vs ${normal}`);
      ok('at the limit the text is 已選 2 / 2 張', (await page.textContent('#pickCounter')) === '已選 2 / 2 張');
      await pickHeart(page, 2);
      const over = await color();
      ok('above the limit (3 / 2) the colour differs', over !== normal, `${over} vs ${normal}`);
      const accent = await page.evaluate(() => {
        const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--warning');
        document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
      });
      ok('and it is the warning/accent token', over === accent, `${over} vs ${accent}`);
      ok('the text still reads 已選 3 / 2 張', (await page.textContent('#pickCounter')) === '已選 3 / 2 張');
      const txt = await bodyText();
      ok('no over-limit message anywhere while picking',
        !/超出|多 \d+ 張|加挑費|已超出可挑張數/.test(txt), txt.slice(0, 200));
      ok('no toast/banner element about the limit',
        await page.evaluate(() => !document.querySelector('.toast') || !/超|加挑|方案/.test(document.querySelector('.toast').textContent)));
      ok('the over-limit modal is not open', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      await pickHeart(page, 2);
      await page.waitForTimeout(200);
      ok('back to the limit → normal colour again', (await color()) === normal);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1, extraPrice: 500 });
  await suite('over-limit submit — modal with exact texts and price math, 返回修改 sends nothing, 確認送出 goes on to the form',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.waitForTimeout(300);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('the title is 已超出可挑張數', (await page.textContent('#pickOverTitle')) === '已超出可挑張數');
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('line 1 is exact', lines[0] === '方案 1 張，目前已選 3 張，超出 2 張', JSON.stringify(lines));
      ok('line 2 has price math with thousands separators',
        lines[1] === '加挑每張 NT$500，加價 NT$500 × 2 = NT$1,000', JSON.stringify(lines));
      ok('exactly two lines', lines.length === 2, JSON.stringify(lines));
      ok('the submit form is not open yet', await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      await page.waitForTimeout(600); // slideUp animation
      const box = await page.evaluate(() => { const r = document.querySelector('#pickOverModal .modal-content').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, vw: innerWidth, vh: innerHeight }; });
      ok('centred', Math.abs(box.cx - box.vw / 2) < 4 && Math.abs(box.cy - box.vh / 2) < 4, JSON.stringify(box));
      const btnTexts = await page.$$eval('#pickOverModal .pick-submit-actions button', bs => bs.map(b => b.textContent.trim()));
      ok('buttons 返回修改 / 確認送出', JSON.stringify(btnTexts) === JSON.stringify(['返回修改', '確認送出']), JSON.stringify(btnTexts));

      await page.click('#pickOverBackBtn');
      await page.waitForTimeout(300);
      ok('返回修改 closes the modal', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('返回修改 does not open the form either', await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      ok('and sends no submit request', pickSubmits(m).length === 0, JSON.stringify(pickSubmits(m)));

      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      await page.click('#pickOverConfirmBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 3000 });
      ok('確認送出 closes the warning and opens the ordinary form', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('still nothing sent before the form is confirmed', pickSubmits(m).length === 0);
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(400);
      ok('the form then submits once', pickSubmits(m).length === 1, String(pickSubmits(m).length));
      ok('with the relationship', pickSubmits(m)[0] && pickSubmits(m)[0].body.relationship === '朋友');
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1 });
  await suite('over-limit submit — no extra_price means no price line',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('only the count line', lines.length === 1 && lines[0] === '方案 1 張，目前已選 2 張，超出 1 張', JSON.stringify(lines));
      ok('no NT$ anywhere in the modal', await page.evaluate(() => !document.getElementById('pickOverModal').textContent.includes('NT$')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

for (const [label, opts] of [['at exactly the limit', { pickLimit: 2, extraPrice: 500, n: 2 }], ['no limit at all', { n: 2 }], ['under the limit', { pickLimit: 3, extraPrice: 500, n: 1 }]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: opts.pickLimit, extraPrice: opts.extraPrice });
  await suite(`over-limit submit — not over (${label}) opens the ordinary form, no warning modal`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      for (let i = 0; i < opts.n; i++) await pickHeart(page, i);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 3000 });
      ok('the form opens directly', true);
      ok('the warning modal never opened', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1, extraPrice: 1500 });
  await suite('over-limit submit — phone width (390px): modal fits, buttons >= 44px, no horizontal scroll, bottom bar submit works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.click('#mobileActionBar .btn-success'); // the phone's bottom-bar submit
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      // measure once the modal's slide-in has finished: mid-animation the
      // buttons are a hair under 44px (43.99997) and the check flakes
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
      const r = await page.evaluate(() => {
        const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        return { vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, modal: box('#pickOverModal .modal-content'), back: box('#pickOverBackBtn'), conf: box('#pickOverConfirmBtn'),
          price: document.querySelector('.pick-over-price').textContent };
      });
      ok('price with 1,500 separators', r.price === '加挑每張 NT$1,500，加價 NT$1,500 × 2 = NT$3,000', r.price);
      ok('modal inside the viewport', r.modal.l >= 0 && r.modal.r <= r.vw && r.modal.t >= 0 && r.modal.b <= r.vh, JSON.stringify(r.modal));
      ok('buttons >= 44px tall', r.back.h >= 44 && r.conf.h >= 44, `${r.back.h} ${r.conf.h}`);
      ok('buttons inside the modal', r.back.l >= r.modal.l && r.conf.r <= r.modal.r, JSON.stringify(r));
      ok('no horizontal scroll', r.sw <= r.vw, `${r.sw} > ${r.vw}`);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY' });
  await suite('pick counter — a viewer without the seat gets no counter and no bottom bar',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('bar hidden (computed display none)', await page.evaluate(() => getComputedStyle(document.getElementById('mobileActionBar')).display === 'none'));
      ok('no counter shows a count', await page.evaluate(() => !/已選\s*\d/.test(document.getElementById('mobileActionBar').innerText)));
      return out;
    },
    { before: m.attach });
}

await suite('desktop preview — arrow keys and mouse click still navigate/open exactly as before',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      app.renderPhotoGrid();
    });
    await page.click('.photo-card:nth-child(2)');
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    ok('mouse click opens the modal on the clicked photo',
      (await page.textContent('#photoCounter')) === '2 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
    ok('ArrowRight still navigates to the next photo',
      (await page.textContent('#photoCounter')) === '3 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(50);
    ok('ArrowLeft still navigates back',
      (await page.textContent('#photoCounter')) === '2 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    ok('Escape still closes it', !(await page.evaluate(() =>
      document.getElementById('photoModal').classList.contains('active'))));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3) });

{
  const m = pickFakeWorker({ ownerName: 'Amy', ownerKey: 'AMY-KEY' });
  await suite('admin — 封存: confirm text, then 已封存 badge, 取消封存, and 產生新連結 hidden',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-archive-btn');
      await page.waitForTimeout(200);
      ok('confirm warns links go dead immediately, data is kept',
        dialogMsg.includes('封存後連結會立即失效，資料會保留'), dialogMsg);
      ok('dismissing the confirm does not call archive',
        !m.requests.some(r => r.method === 'POST' && r.path.endsWith('/archive')));

      page.once('dialog', d => d.accept());
      await page.click('#pd-archive-btn');
      await page.waitForSelector('#pd-unarchive-btn', { timeout: 5000 });
      const after = await page.evaluate(() => ({
        badge: document.querySelector('.pd-head')?.textContent.includes('已封存'),
        newLinkBtn: !!document.getElementById('pd-new-link-btn'),
        unarchiveBtn: !!document.getElementById('pd-unarchive-btn'),
      }));
      ok('shows 已封存 badge after archiving', after.badge);
      ok('產生新連結 is hidden once archived', after.newLinkBtn === false);
      ok('取消封存 replaces the 封存 button', after.unarchiveBtn);
      ok('the archive endpoint was actually called',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/archive')));
      ok('the live pick link is revoked in the same batch as the archive',
        (await page.textContent('[data-token-row] .badge')) === '已撤銷',
        await page.textContent('[data-token-row] .badge'));

      await page.click('#pd-unarchive-btn');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      const restored = await page.evaluate(() => ({
        badge: document.querySelector('.pd-head')?.textContent.includes('已封存'),
        newLinkBtn: !!document.getElementById('pd-new-link-btn'),
      }));
      ok('取消封存 drops the 已封存 badge', restored.badge === false);
      ok('產生新連結 comes back', restored.newLinkBtn);
      ok('the unarchive endpoint was actually called',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/unarchive')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Ben', ownerKey: 'BEN-KEY' });
  await suite('admin — 封存 on an archived project: POST links 409s, and archived shows in the toggled list',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      page.once('dialog', d => d.accept());
      await page.click('#pd-archive-btn');
      await page.waitForSelector('#pd-unarchive-btn', { timeout: 5000 });

      const listEmpty = await page.evaluate(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'));
      ok('the default project list no longer shows the archived project', listEmpty);

      await page.click('#proj-show-archived-toggle');
      await page.waitForFunction(() =>
        document.querySelectorAll('[data-project-row]').length === 1, null, { timeout: 5000 });
      const shown = await page.evaluate(() => ({
        badge: document.querySelector('[data-project-row]')?.textContent.includes('已封存'),
      }));
      ok('顯示已封存 toggle brings the archived project back with its badge', shown.badge);

      await page.uncheck('#proj-show-archived-toggle');
      await page.waitForFunction(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('unchecking it hides the archived project again', true);

      // The button is hidden once archived, but the endpoint itself must
      // still refuse a mint the way the real Worker does (docs/guest-picking.md).
      const linkAttempt = await page.evaluate(async id => {
        const r = await fetch(`https://imagepicker.hotichen.workers.dev/api/admin/projects/${id}/links`, {
          method: 'POST', headers: { 'Authorization': 'Bearer adm' },
        });
        return { status: r.status, body: await r.json() };
      }, m.state.project.id);
      ok('POST .../links on an archived project is refused with 409 code:archived',
        linkAttempt.status === 409 && linkAttempt.body.code === 'archived', JSON.stringify(linkAttempt));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Cara', ownerKey: 'CARA-KEY' });
  await suite('admin — 封存／刪除: 刪除 only offered with 0 submissions, confirms, and clears the panel',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });
      ok('刪除 is offered when the project has 0 submissions', !!(await page.$('#pd-delete-btn')));

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-delete-btn');
      await page.waitForTimeout(200);
      ok('confirm says it cannot be undone', dialogMsg.includes('確定刪除？此動作無法復原'), dialogMsg);
      ok('dismissing the confirm does not call DELETE',
        !m.requests.some(r => r.method === 'DELETE'));

      page.once('dialog', d => d.accept());
      await page.click('#pd-delete-btn');
      await page.waitForSelector('#project-detail-panel', { state: 'hidden', timeout: 5000 });
      ok('the panel is hidden after a successful delete', true);
      ok('the DELETE endpoint was actually called',
        m.requests.some(r => r.method === 'DELETE' && /\/api\/admin\/projects\/[^/]+$/.test(r.path)));
      await page.waitForFunction(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('the project list refreshes to empty', true);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Dan', ownerKey: 'DAN-KEY' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
  );
  await suite('admin — 封存／刪除: 刪除 is hidden with submissions, and 409 has_submissions shows the fallback message',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission', { timeout: 5000 });
      ok('刪除 is not offered once the project has a submission', !(await page.$('#pd-delete-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });

  // Exercise the 409 fallback message directly against the real endpoint
  // shape (a submission landing between the button render and the click).
  const m2 = pickFakeWorker({ ownerName: 'Eli', ownerKey: 'ELI-KEY' });
  await suite('admin — 刪除 409 has_submissions shows 請改用封存',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-delete-btn', { timeout: 5000 });
      // race a submission in right before the delete lands, like the real
      // Worker's own gate re-check
      m2.state.submissions.push({
        id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
        photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
        created_at: '2026-01-01T00:00:00Z', notified: 1,
      });
      page.once('dialog', d => d.accept());
      await page.click('#pd-delete-btn');
      await page.waitForSelector('#pd-action-err:not(:empty)', { timeout: 5000 });
      const errText = await page.textContent('#pd-action-err');
      ok('shows the 已有送出紀錄，無法刪除，請改用封存 fallback', errText.includes('已有送出紀錄，無法刪除，請改用封存'), errText);
      ok('the panel stays open (delete did not go through)',
        await page.evaluate(() => getComputedStyle(document.getElementById('project-detail-panel')).display !== 'none'));
      return out;
    },
    { before: m2.attach, initScript: ADMIN });
}
}
