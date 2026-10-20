// Browser suites (2026-10-20): (B) 送出紀錄 is part of 進度 — each submission is its own row that opens to its detail, there is no
// separate 送出紀錄 section; (C) a project that has no 毛片 yet is 準備中 (「下一步：上傳毛片，再把連結給客人」), not 客人選片中.
// The proofs are known from the listing of the project's root (a folder exists in R2 once something is in it).
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openSettings } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-hs`;
const WITH_PROOFS = ['shoot/', 'shoot/毛片/'];
const NO_PROOFS = ['shoot/'];
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-hs', title: '新專案', ownerName: 'Zoe', folders: ['shoot/毛片/'], bucketFolders: WITH_PROOFS, ...o });
const sub = (at, keys, extra = {}) => ({ id: 's-' + at, picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: keys, count: keys.length, pick_limit: null, extra_price: null, created_at: at, notified: 1, ...extra });
const card = page => page.evaluate(() => ({ stage: document.getElementById('pd-status').dataset.stage, label: document.getElementById('pd-status-label').textContent.trim(),
  next: document.getElementById('pd-status-next').textContent.trim() }));
const STEPS = () => [...document.querySelectorAll('#pd-progress [data-step]')].map(li => ({ step: li.dataset.step, state: li.dataset.state,
  label: li.querySelector('.pd-step-label')?.textContent.trim() ?? null, toggle: !!li.querySelector('.pd-step-toggle') }));
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').catch(() => false);
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });

// ═════ C: 準備中 ═════
{
  const m = fx({ phase: 'picking', bucketFolders: NO_PROOFS });
  await suite('new project — no 毛片 in the bucket yet: 準備中, next 上傳毛片 (no 客人選片中), 進度 starts at 上傳毛片', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const c = await card(page);
    ok('stage new, label 準備中, next 「下一步：上傳毛片，再把連結給客人」', c.stage === 'new' && c.label === '準備中' && c.next === '下一步：上傳毛片，再把連結給客人', JSON.stringify(c));
    ok('no text anywhere says 客人選片中 / 等客人送出選片', !/客人選片中|等客人送出選片/.test(await page.textContent('#pd-status')));
    const s = await page.evaluate(STEPS);
    ok('進度: 上傳毛片 is the current step, the rest are still ahead', JSON.stringify(s.map(x => x.step)) === '["proofs","picked","retouch","delivered","confirmed"]' &&
      s[0].state === 'current' && s[0].label === '上傳毛片' && s.slice(1).every(x => x.state === 'next'), JSON.stringify(s));
    ok('the 毛片 row still offers ＋上傳毛片', await shown(page, '#pd-upload-proofs-btn'));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking' });
  await suite('new project — positive control: the same project with 毛片 in the bucket is 客人選片中, no 上傳毛片 step', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const c = await card(page);
    ok('stage picking, 客人選片中, 等客人送出選片', c.stage === 'picking' && c.label === '客人選片中' && c.next === '下一步：等客人送出選片', JSON.stringify(c));
    const s = await page.evaluate(STEPS);
    ok('steps picked, retouch, delivered, confirmed; picked is current', JSON.stringify(s.map(x => x.step)) === '["picked","retouch","delivered","confirmed"]' && s[0].state === 'current', JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking', bucketFolders: NO_PROOFS, listDelay: { 'shoot/': 900 } });
  await suite('new project — while the listing is on its way the card says 載入中… (not 準備中, not an error), then 準備中', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-status-label', { timeout: 5000 });
    const early = await card(page);
    ok('before the listing is back: 載入中…, nothing claimed', early.label === '載入中…' && early.next === '' && early.stage === 'picking', JSON.stringify(early));
    await page.waitForFunction(() => document.getElementById('pd-status').dataset.stage === 'new', null, { timeout: 5000 });
    ok('then 準備中', (await card(page)).label === '準備中');
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking', bucketFolders: NO_PROOFS, pickLimit: 40, extraMax: 10 });
  await suite('new project — a refresh of the page (saving the plan re-reads everything) never flashes 載入中… or 客人選片中 on the card', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    await page.waitForFunction(() => document.getElementById('pd-status').dataset.stage === 'new', null, { timeout: 4000 });
    await page.evaluate(() => {
      window.__labels = [];
      new MutationObserver(() => { const l = document.getElementById('pd-status-label'); if (l) window.__labels.push(l.textContent.trim()); })
        .observe(document.getElementById('project-detail-body'), { childList: true, subtree: true, characterData: true });
    });
    await openSettings(page);
    await page.fill('#pd-plan-limit', '35');
    await page.click('#pd-plan-save');
    await page.waitForFunction(() => /45 張（35 \+ 加選 10）/.test(document.getElementById('pd-plan-result')?.textContent || ''), null, { timeout: 4000 });
    await page.waitForTimeout(300);
    const labels = await page.evaluate(() => window.__labels);
    ok('the page really redrew (positive: the observer saw the card more than once)', labels.length >= 1, JSON.stringify(labels));
    ok('every label seen during the refresh was 準備中', labels.every(l => l === '準備中'), JSON.stringify([...new Set(labels)]));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking', bucketFolders: NO_PROOFS, listFail: 500 });
  await suite('new project — the listing failed: never claims 準備中 (stays 客人選片中)', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const c = await card(page);
    ok('stage picking, 客人選片中', c.stage === 'picking' && c.label === '客人選片中', JSON.stringify(c));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking', bucketFolders: NO_PROOFS });
  m.state.submissions.push(sub('2026-10-10T02:00:00.000Z', ['shoot/毛片/a.jpg']));
  await suite('new project — a project that already has a submission is never 準備中, whatever the listing says', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const c = await card(page);
    ok('stage picking', c.stage === 'picking' && c.label === '客人選片中', JSON.stringify(c));
    const s = await page.evaluate(STEPS);
    ok('no 上傳毛片 step, the submission is on record', !s.some(x => x.step === 'proofs') && s[0].step === 'picked' && s[0].state === 'done', JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'submitted', bucketFolders: NO_PROOFS });
  await suite('new project — a phase past picking is never 準備中 (選片完成・待精修 with no 毛片 listed)', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const c = await card(page);
    ok('stage submitted', c.stage === 'submitted' && c.label === '選片完成・待精修', JSON.stringify(c));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking', folders: ['old-shoot/'], bucketFolders: [] });
  await suite('new project — an older folder layout (not <root>/毛片/) cannot be told: not 準備中', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-status-label', { timeout: 5000 });
    await page.waitForTimeout(400);
    const c = await card(page);
    ok('stage picking, 客人選片中', c.stage === 'picking' && c.label === '客人選片中', JSON.stringify(c));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ═════ B: 送出紀錄 in 進度 ═════
{
  const m = fx({ phase: 'submitted' });
  m.state.submissions.push(
    sub('2026-10-10T02:00:00.000Z', ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg'], { relationship: '新娘 <b>x</b>', notified: 0 }),
    sub('2026-10-12T02:00:00.000Z', ['shoot/毛片/a.jpg', 'shoot/毛片/c.jpg'], { email: 'z@example.com' }));
  await suite('submissions in 進度 — one row per submission, closed by default; no separate 送出紀錄 section; each opens to its detail', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    ok('no 送出紀錄 section on the page (positive: 目前選取 is there)', (await page.$$('#pd-sec-submissions, #pd-submissions')).length === 0 && (await page.$$('#pd-sec-selections')).length === 1);
    const s = await page.evaluate(STEPS);
    ok('rows: picked (客人送出選片), picked-2 (客人再次送出選片), both with a toggle, both done', JSON.stringify(s.slice(0, 2).map(x => [x.step, x.label, x.toggle, x.state])) ===
      JSON.stringify([['picked', '客人送出選片', true, 'done'], ['picked-2', '客人再次送出選片', true, 'done']]), JSON.stringify(s));
    ok('later rows (開始精修, 交件) have no toggle', s.slice(2).every(x => !x.toggle));
    ok('both toggles collapsed, details not displayed', await page.evaluate(() => ['picked', 'picked-2'].every(n => document.getElementById(`pd-sub-${n}-btn`).getAttribute('aria-expanded') === 'false' &&
      document.getElementById(`pd-sub-${n}`).getClientRects().length === 0)));
    await page.click('#pd-sub-picked-2-btn');
    ok('the second opens: its detail shows 2 張, the email, and what changed (新增 c.jpg, 移除 b.jpg); the first stays closed',
      await shown(page, '#pd-sub-picked-2') && !(await shown(page, '#pd-sub-picked')) && await page.$eval('#pd-sub-picked-2', e => /2 張/.test(e.textContent) && e.textContent.includes('z@example.com') &&
        /新增 1 張：shoot\/毛片\/c\.jpg/.test(e.textContent) && /移除 1 張：shoot\/毛片\/b\.jpg/.test(e.textContent)), await page.textContent('#pd-sub-picked-2'));
    ok('the toggle says it is open (aria-expanded true, 收起)', await page.$eval('#pd-sub-picked-2-btn', b => b.getAttribute('aria-expanded') === 'true' && b.textContent.includes('收起')));
    await page.click('#pd-sub-picked-btn');
    ok('the first opens: （第一次送出）, 未寄信 badge, the relationship as text (no <b> element)', await shown(page, '#pd-sub-picked') && await page.$eval('#pd-sub-picked', e => e.textContent.includes('（第一次送出）') &&
      !!e.querySelector('.badge-pending') && e.textContent.includes('新娘 <b>x</b>') && !e.querySelector('b:not(strong)')));
    await page.click('#pd-sub-picked-btn');
    ok('clicking again closes it', !(await shown(page, '#pd-sub-picked')) && (await shown(page, '#pd-sub-picked-2')));
    // a redraw of the page (saving the plan re-reads the project) keeps what is open
    await openSettings(page);
    await page.fill('#pd-plan-limit', '35');
    await page.click('#pd-plan-save');
    await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
    await page.click('#pd-edit-cancel');
    ok('after a refresh the second row is still open, the first still closed', await shown(page, '#pd-sub-picked-2') && !(await shown(page, '#pd-sub-picked')));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'picking' });
  await suite('submissions in 進度 — nobody submitted yet: no toggles and no detail blocks', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const s = await page.evaluate(STEPS);
    ok('four steps (positive) and none has a toggle', s.length === 4 && s.every(x => !x.toggle) && (await page.$$('.pd-step-toggle, #pd-steps .pd-submission')).length === 0, JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'submitted' });
  m.state.submissions.push(sub('2026-10-10T02:00:00.000Z', ['shoot/毛片/a.jpg']), sub('2026-10-12T02:00:00.000Z', ['shoot/毛片/a.jpg', 'shoot/毛片/' + 'long'.repeat(20) + '.jpg']));
  await suite('submissions in 進度 — phone 390px: toggles >= 44px, an opened detail with a long file name causes no sideways scroll', URL_, async page => {
    const out = [], ok = line(out);
    await waitReady(page);
    const hs = await page.$$eval('.pd-step-toggle', bs => bs.map(b => Math.round(b.getBoundingClientRect().height)));
    ok('two toggles, both >= 44px', hs.length === 2 && hs.every(h => h >= 44), JSON.stringify(hs));
    await page.click('#pd-sub-picked-2-btn');
    const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth, r: document.getElementById('pd-sub-picked-2').getBoundingClientRect().right }));
    ok('opened: detail inside the screen, no sideways scroll', g.sw <= g.vw && g.r <= g.vw, JSON.stringify(g));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
