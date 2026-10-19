// Browser suites: the project page's status card COLLAPSES when the stage is 已完成 (client confirmed): only a
// header button (label + 客人已確認 line + chevron) shows; the delivered line / 更換精修資料夾 / 完成 line / round
// history stay mounted but hidden until the photographer taps it. Every other stage stays fully open (it carries the
// next-step buttons). The open state is a page variable per project id.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-sc`;
const ONE_FINAL = ['shoot/', 'shoot/毛片/', 'shoot/精修/'];
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], bucketFolders: ONE_FINAL };
const DONE = { ...DELIVERED, confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'guest' };
const oldRound = { id: 'r-old', message: '第一輪：背景路人', picker_id: 'picker-0', created_at: '2026-09-21T03:00:00.000Z', resolved_at: '2026-09-21T09:00:00.000Z' };
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-sc', title: '收合專案', ownerName: '你好', folders: ['shoot/毛片/'], ...o });
const wait = page => page.waitForSelector('#pd-status-label', { timeout: 5000 });

// what is really painted: display none / zero rects both count as not visible
const SEE = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; })()`;
const state = page => page.evaluate(`(() => {
  const see = s => ${SEE('__S__').replace('"__S__"', 's')};
  const t = document.getElementById('pd-status-toggle');
  const b = document.getElementById('pd-status-body');
  return {
    toggle: !!t, expanded: t ? t.getAttribute('aria-expanded') : null, controls: t ? t.getAttribute('aria-controls') : null,
    toggleH: t ? Math.round(t.getBoundingClientRect().height) : 0, tag: t ? t.tagName : null,
    toggleText: t ? t.textContent : '', labelInToggle: !!(t && t.querySelector('#pd-status-label')), nextInToggle: !!(t && t.querySelector('#pd-status-next')),
    bodyHidden: b ? b.hidden : null, bodyDisplay: b ? getComputedStyle(b).display : null,
    labelSeen: see('#pd-status-label'), nextSeen: see('#pd-status-next'),
    delivered: !!document.querySelector('#pd-status [data-delivered-status]'), deliveredSeen: see('#pd-status [data-delivered-status]'),
    replaceSeen: see('#pd-status #pd-replace-final-btn'), replaceMounted: !!document.querySelector('#pd-status #pd-replace-final-btn'),
    confirmSeen: see('#pd-status #pd-confirm-status'), confirmMounted: !!document.getElementById('pd-confirm-status'),
    revsMounted: document.querySelectorAll('#pd-status #pd-revisions .pd-rev').length, revsSeen: see('#pd-status #pd-revisions .pd-rev'),
    xScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);

// ── 已完成: collapsed by default ──
{
  const m = fx({ ...DONE, revisions: [oldRound] });
  await suite('status collapse — 已完成 starts as one header line; the content is mounted but not painted', URL_, async page => {
    const out = [], ok = line(out);
    await wait(page); await page.waitForSelector('#pd-status-toggle', { timeout: 5000 }).catch(() => {});
    const s = await state(page);
    ok('the header is a real <button> with aria-controls #pd-status-body, collapsed', s.tag === 'BUTTON' && s.controls === 'pd-status-body' && s.expanded === 'false', JSON.stringify(s));
    ok('the button is >= 44px tall', s.toggleH >= 44, String(s.toggleH));
    ok('it holds 「已完成」 and the 客人已確認（日期） line, and both are painted', s.labelInToggle && s.nextInToggle && s.labelSeen && s.nextSeen &&
      s.toggleText.includes('已完成') && s.toggleText.includes('客人已確認（2026-09-23）'), s.toggleText);
    ok('the body is hidden AND computed display is none', s.bodyHidden === true && s.bodyDisplay === 'none', JSON.stringify([s.bodyHidden, s.bodyDisplay]));
    ok('the delivered line, 更換精修資料夾, the 完成 line and the round list are mounted (positive) but not painted',
      s.delivered && s.replaceMounted && s.confirmMounted && s.revsMounted === 1 && !s.deliveredSeen && !s.replaceSeen && !s.confirmSeen && !s.revsSeen, JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── tap opens, tap again closes ──
{
  const m = fx({ ...DONE, revisions: [oldRound] });
  await suite('status collapse — tap opens the card, tap again collapses it', URL_, async page => {
    const out = [], ok = line(out);
    await wait(page); await page.waitForSelector('#pd-status-toggle', { timeout: 5000 });
    await page.click('#pd-status-toggle');
    let s = await state(page);
    ok('after the tap: aria-expanded true, body not hidden', s.expanded === 'true' && s.bodyHidden === false && s.bodyDisplay !== 'none', JSON.stringify(s));
    ok('after the tap the delivered line, 更換精修資料夾, the 完成 line and the rounds are painted', s.deliveredSeen && s.replaceSeen && s.confirmSeen && s.revsSeen, JSON.stringify(s));
    ok('the header line is still there', s.labelSeen && s.nextSeen && s.toggle);
    await page.click('#pd-status-toggle');
    s = await state(page);
    ok('tap again: collapsed and nothing of the body painted', s.expanded === 'false' && s.bodyDisplay === 'none' && !s.deliveredSeen && !s.replaceSeen && !s.revsSeen, JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── a re-render (refresh) keeps the open state; another project starts collapsed again ──
{
  const m = fx({ ...DONE });
  await suite('status collapse — a re-render does not flip an expanded card back; a new project id resets it', URL_, async page => {
    const out = [], ok = line(out);
    await wait(page); await page.waitForSelector('#pd-status-toggle', { timeout: 5000 });
    await page.click('#pd-status-toggle');
    // the page re-renders the whole detail on a hashchange to the same project
    await page.evaluate(() => window.dispatchEvent(new Event('hashchange')));
    await page.waitForTimeout(600);
    let s = await state(page);
    ok('still expanded and painted after the re-render', s.toggle && s.expanded === 'true' && s.deliveredSeen, JSON.stringify(s));
    // another (also confirmed) project: the open state is reset, it starts collapsed
    m.state.project.id = 'proj-sc2';
    await page.evaluate(() => { location.hash = '#project=proj-sc2'; });
    await page.waitForFunction(() => document.getElementById('pd-status-toggle')?.getAttribute('aria-expanded') === 'false', null, { timeout: 5000 }).catch(() => {});
    s = await state(page);
    ok('project proj-sc2 starts collapsed (reset on a new project id)', s.toggle && s.expanded === 'false' && s.bodyDisplay === 'none' && !s.deliveredSeen, JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── not 已完成: no toggle, everything open ──
for (const [name, o] of [
  ['客人確認中', DELIVERED],
  ['精修中', { phase: 'retouching', bucketFolders: ['shoot/', 'shoot/毛片/', 'shoot/精修/'] }],
  ['選片完成・待精修', { phase: 'submitted' }],
]) {
  const m = fx(o);
  await suite(`status collapse — ${name} has no toggle and the card stays fully open`, URL_, async page => {
    const out = [], ok = line(out);
    await wait(page);
    await page.waitForTimeout(300);
    const s = await state(page);
    ok('no toggle button, the label is a plain painted line', !s.toggle && s.labelSeen && s.nextSeen && !s.labelInToggle, JSON.stringify(s));
    ok('the body is not hidden', s.bodyHidden === false && s.bodyDisplay !== 'none', JSON.stringify(s));
    if (o.deliveredAt) ok('the delivered line and 更換精修資料夾 are painted (positive)', s.deliveredSeen && s.replaceSeen, JSON.stringify(s));
    if (o.phase === 'submitted') ok('the next-step button 開始精修 is painted', await page.evaluate(SEE('#pd-start-retouch-btn')));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── 390px: no sideways scroll, both states ──
{
  const m = fx({ ...DONE, revisions: [oldRound] });
  await suite('status collapse — 390px: no sideways scroll collapsed or expanded; the button is tappable', URL_, async page => {
    const out = [], ok = line(out);
    await wait(page); await page.waitForSelector('#pd-status-toggle', { timeout: 5000 });
    let s = await state(page);
    ok('collapsed: no horizontal scroll, button >= 44px', !s.xScroll && s.toggleH >= 44, JSON.stringify(s));
    await page.tap('#pd-status-toggle');
    s = await state(page);
    ok('expanded: no horizontal scroll and the body is painted', !s.xScroll && s.deliveredSeen && s.expanded === 'true', JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
