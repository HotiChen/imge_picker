// Browser suites: the project page's STATUS CARD (Tim 2026-10-19 mockup). One status label, one 下一步 line and at
// most ONE primary (accent) button for the stage, derived from fields the page already has (phase, delivered_at, the
// open revision round and its number, client_confirmed_at, archived_at). The old header badge row
// (精修中 + 已交件 + 待修改 N at once) is gone from the detail page; the project LIST keeps its badges.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-st`;
const NO_FINALS = ['shoot/', 'shoot/毛片/'];
const ONE_FINAL = ['shoot/', 'shoot/毛片/', 'shoot/精修/'];
const TWO_FINALS = ['shoot/', 'shoot/毛片/', 'shoot/精修/', 'shoot/精修二/'];
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] };
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-st', title: '狀態卡專案', ownerName: '你好', folders: ['shoot/毛片/'], bucketFolders: NO_FINALS, ...o });
const openRound = (o = {}) => ({ id: 'r-open', kind: 'pins', picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z', resolved_at: null,
  finals: ['shoot/精修/'], message_auto: false, message: '再亮一點', marks: { 'shoot/精修/f1.jpg': [{ x: 0.5, y: 0.5, note: '痘痘' }] }, ...o });
const oldRound = { id: 'r-old', message: '第一輪：背景路人', picker_id: 'picker-0', created_at: '2026-09-21T03:00:00.000Z', resolved_at: '2026-09-21T09:00:00.000Z' };
const deliverBodies = m => m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/deliver')).map(r => r.body);

// what the card shows: the label, the 下一步 line, every visible [data-primary] and every visible control painted
// in the accent colour (there must be one at most), plus whether any of the old header badges are still drawn
const CARD = () => {
  const c = document.getElementById('pd-status');
  if (!c) return null;
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const ACCENT = 'rgb(245, 161, 59)';
  const prim = [...c.querySelectorAll('[data-primary]')].filter(vis);
  return {
    stage: c.dataset.stage || null, shown: vis(c),
    label: document.getElementById('pd-status-label')?.textContent.trim() ?? null,
    next: document.getElementById('pd-status-next')?.textContent.trim() ?? null,
    primaries: prim.map(e => ({ id: e.id, text: e.textContent.trim(), tag: e.tagName, href: e.getAttribute('href'), disabled: !!e.disabled,
      h: Math.round(e.getBoundingClientRect().height) })),
    // (the numbered pins on a round's thumbnails are accent dots, not buttons of the card's own)
    accents: [...c.querySelectorAll('button:not(.pin-layer-pin), a')].filter(e => vis(e) && getComputedStyle(e).backgroundColor === ACCENT).map(e => e.id),
    oldBadges: document.querySelectorAll('#project-detail-body [data-phase-badge], #project-detail-body [data-delivered-badge], #project-detail-body [data-confirm-badge]').length,
  };
};
const card = page => page.evaluate(CARD);
const waitCard = page => page.waitForSelector('#pd-status-label', { timeout: 5000 });
const waitTarget = page => page.waitForSelector('#pd-status[data-target="ready"], #pd-status[data-target="failed"]', { state: 'attached', timeout: 5000 });
const linkParts = href => { const u = new URL(href, base); return { file: u.pathname.split('/').pop(), folder: u.searchParams.get('folder'), lock: u.searchParams.get('lock'), project: u.searchParams.get('project') }; };

// ── one state per fixture: label, 下一步, the one primary ──
for (const [name, o, want] of [
  ['客人選片中：沒有主按鈕', { phase: 'picking' },
    { stage: 'picking', label: '客人選片中', next: '下一步：等客人送出選片', primary: null }],
  ['選片完成・待精修：主按鈕「開始精修」', { phase: 'submitted' },
    { stage: 'submitted', label: '選片完成・待精修', next: '下一步：開始精修（開始後客人不能再改選片）', primary: { id: 'pd-start-retouch-btn', text: '開始精修' } }],
  ['精修中、還沒有任何精修資料夾：主按鈕「＋上傳精修」（交件在但不是主按鈕、不能按）', { phase: 'retouching' },
    { stage: 'retouching', label: '精修中', next: '下一步：上傳精修後交件', primary: { id: 'pd-upload-final-btn', text: '＋上傳精修', folder: 'shoot/精修/' }, deliverOff: true }],
  ['精修中、已有精修資料夾：主按鈕「交件」', { phase: 'retouching', bucketFolders: TWO_FINALS },
    { stage: 'retouching', label: '精修中', next: '下一步：上傳精修後交件', primary: { id: 'pd-deliver-btn', text: '交件' } }],
  ['客人確認中：沒有主按鈕，標記完成／更換精修資料夾是次要', { ...DELIVERED, bucketFolders: ONE_FINAL },
    { stage: 'awaiting', label: '客人確認中', next: '下一步：等客人確認或提出修改', primary: null, delivered: true }],
  ['客人要求修改（第 1 輪）、新版還沒上傳：主按鈕「＋上傳精修二」', { ...DELIVERED, bucketFolders: ONE_FINAL, revisions: [openRound()] },
    { stage: 'revising', label: '客人要求修改（第 1 輪）', next: '下一步：上傳精修二後交付', primary: { id: 'pd-round-upload-btn', text: '＋上傳精修二', folder: 'shoot/精修二/' }, delivered: true, rounds: 1 }],
  ['客人要求修改（第 2 輪）、精修二已上傳：主按鈕「交付精修二」', { ...DELIVERED, bucketFolders: TWO_FINALS, revisions: [oldRound, openRound()] },
    { stage: 'revising', label: '客人要求修改（第 2 輪）', next: '下一步：交付精修二給客人', primary: { id: 'pd-round-deliver-btn', text: '交付精修二' }, delivered: true, rounds: 2 }],
  ['已完成（客人確認）', { ...DELIVERED, bucketFolders: ONE_FINAL, confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'guest' },
    { stage: 'done', label: '已完成', next: '客人已確認（2026-09-23）', primary: null, delivered: true }],
  ['已完成（攝影師代為標記）', { ...DELIVERED, bucketFolders: ONE_FINAL, confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'photographer' },
    { stage: 'done', label: '已完成', next: '你已代客人標記完成（2026-09-23）', primary: null, delivered: true }],
  ['已封存：主按鈕「取消封存」在卡片裡', { phase: 'submitted', archivedAt: '2026-09-01T00:00:00.000Z' },
    { stage: 'archived', label: '已封存', next: '連結已失效，資料都保留', primary: { id: 'pd-unarchive-btn', text: '取消封存' } }],
  ['已封存、精修中而且有精修資料夾：交件不搶主按鈕，主按鈕還是「取消封存」', { phase: 'retouching', bucketFolders: TWO_FINALS, archivedAt: '2026-09-01T00:00:00.000Z' },
    { stage: 'archived', label: '已封存', next: '連結已失效，資料都保留', primary: { id: 'pd-unarchive-btn', text: '取消封存' } }],
]) {
  const m = fx(o);
  await suite(`project page status — ${name}`, URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    if (o.phase === 'retouching') await waitTarget(page);
    const c = await card(page);
    ok('the card is on screen', !!c && c.shown, JSON.stringify(c));
    if (!c) return out;
    ok(`stage ${want.stage}`, c.stage === want.stage, c.stage);
    ok(`ONE label: 「${want.label}」`, c.label === want.label, c.label);
    ok(`下一步 line: 「${want.next}」`, c.next === want.next, c.next);
    ok('none of the old header badges (phase / 已交件 / 待修改) is drawn on the detail page', c.oldBadges === 0, String(c.oldBadges));
    if (!want.primary) {
      ok('no primary button and nothing in the accent colour', c.primaries.length === 0 && c.accents.length === 0, JSON.stringify(c));
    } else {
      ok(`exactly one primary: #${want.primary.id} 「${want.primary.text}」`, c.primaries.length === 1 && c.primaries[0].id === want.primary.id && c.primaries[0].text === want.primary.text, JSON.stringify(c.primaries));
      ok('it is the only control in the accent colour', JSON.stringify(c.accents) === JSON.stringify([want.primary.id]), JSON.stringify(c.accents));
      ok('it can be pressed', c.primaries[0] && !c.primaries[0].disabled, JSON.stringify(c.primaries));
      if (want.primary.folder) {
        const p = linkParts(c.primaries[0].href || '');
        ok(`it is the locked upload link for ${want.primary.folder} of this project`,
          p.file === 'upload.html' && p.folder === want.primary.folder && p.lock === '1' && p.project === 'proj-st', JSON.stringify(p));
      }
    }
    if (want.deliverOff) ok('交件 is there, disabled, and not the primary', await page.$eval('#pd-status #pd-deliver-btn', b => b.disabled && !b.hasAttribute('data-primary')).catch(() => false));
    if (want.delivered) {
      ok('the card says when it was delivered (已交件 + the delivered folder)', await page.$eval('#pd-status [data-delivered-status]', e => e.textContent === '已交件').catch(() => false) &&
        (await page.$$eval('#pd-status #pd-delivered-folders [data-final-chip]', els => els.map(e => e.dataset.finalChip))).join() === 'shoot/精修/');
      ok('更換精修資料夾 stays reachable in the card (secondary)', await page.$eval('#pd-status #pd-replace-final-btn', b => b.getClientRects().length > 0 && !b.hasAttribute('data-primary')).catch(() => false));
    }
    if (want.rounds) {
      ok(`the rounds are listed in the card (${want.rounds})`, (await page.$$('#pd-status #pd-revisions .pd-rev')).length === want.rounds);
      ok('標記完成 is in the card (secondary)', await page.$eval('#pd-status #pd-mark-done-btn', b => b.getClientRects().length > 0 && !b.hasAttribute('data-primary')).catch(() => false));
    }
    const order = await page.evaluate(() => {
      const ids = ['pd-head', 'pd-status', 'pd-photos', 'pd-progress'];
      const els = ids.map(i => document.getElementById(i));
      const firstSec = document.querySelector('#project-detail-body .pd-sec');
      return { all: els.every(Boolean), inOrder: els.every((e, k) => k === 0 || (els[k - 1] && (els[k - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING))),
        secAfter: !!firstSec && !!els[3] && !!(els[3].compareDocumentPosition(firstSec) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    ok('top to bottom: header, status card, 照片, 進度, then the collapsible sections', order.all && order.inOrder && order.secAfter, JSON.stringify(order));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── the primaries do what the old buttons did ──
{
  const m = fx({ phase: 'submitted' });
  await suite('project page status — 開始精修 (primary) starts retouching; the card turns into 精修中', URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    await page.click('#pd-status [data-primary]');
    await page.waitForFunction(() => document.getElementById('pd-status-label')?.textContent.trim() === '精修中', null, { timeout: 5000 }).catch(() => {});
    ok('one start-retouch POST', m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/start-retouch')).length === 1);
    ok('the card now says 精修中', (await card(page)).label === '精修中', (await card(page)).label);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: TWO_FINALS, revisions: [oldRound, openRound()] });
  await suite('project page status — 交付精修二 asks first, then repeat-delivers 精修二 (the round is resolved by the Worker)', URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    await waitTarget(page);
    let said = '';
    page.once('dialog', d => { said = d.message(); d.dismiss(); });
    await page.click('#pd-round-deliver-btn');
    await page.waitForTimeout(300);
    ok('a confirm says what happens (精修二 to the client, the request is closed)', /精修二/.test(said) && /結案/.test(said), said);
    ok('dismissing it sends nothing', deliverBodies(m).length === 0);
    page.once('dialog', d => d.accept());
    await page.click('#pd-round-deliver-btn');
    await page.waitForSelector('#dn-close-btn', { timeout: 5000 });
    ok('one deliver POST with final_folders = [精修二]', JSON.stringify(deliverBodies(m)) === '[{"final_folders":["shoot/精修二/"]}]', JSON.stringify(deliverBodies(m)));
    await page.click('#dn-close-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'awaiting', null, { timeout: 5000 }).catch(() => {});
    const c = await card(page);
    ok('the round is closed: the card is back to 客人確認中, no primary', c.stage === 'awaiting' && c.label === '客人確認中' && c.primaries.length === 0, JSON.stringify(c));
    ok('the Worker side: delivered folder is 精修二, nothing open', JSON.stringify(m.state.project.final_folders) === '["shoot/精修二/"]' && m.state.revisions.every(r => r.resolved_at), JSON.stringify(m.state.project.final_folders));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'submitted', archivedAt: '2026-09-01T00:00:00.000Z' });
  await suite('project page status — 取消封存 in the card unarchives and the card goes back to the stage', URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    await page.click('#pd-status #pd-unarchive-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'submitted', null, { timeout: 5000 }).catch(() => {});
    ok('unarchive POSTed', m.requests.some(r => r.method === 'POST' && r.path.endsWith('/unarchive')));
    ok('the card is 選片完成・待精修 again', (await card(page)).label === '選片完成・待精修', (await card(page)).label);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL });
  await suite('project page status — 標記完成 in the card updates the card in place to 已完成', URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    page.once('dialog', d => d.accept());
    await page.click('#pd-status #pd-mark-done-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'done', null, { timeout: 5000 }).catch(() => {});
    const c = await card(page);
    ok('label 已完成, the line says the photographer marked it', c.label === '已完成' && /^你已代客人標記完成（\d{4}-\d{2}-\d{2}）$/.test(c.next), JSON.stringify(c));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── phone: 390px, the busiest state ──
{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL, revisions: [oldRound, openRound()] });
  await suite('project page status — phone 390px: no sideways scroll, the primary is >= 44px tall', URL_, async page => {
    const out = [], ok = line(out);
    await waitCard(page);
    await waitTarget(page);
    const c = await card(page);
    ok('control: the primary is there', c.primaries.length === 1, JSON.stringify(c.primaries));
    ok('primary >= 44px tall', c.primaries[0] && c.primaries[0].h >= 44, JSON.stringify(c.primaries));
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok('no horizontal scroll', sw[0] <= sw[1], JSON.stringify(sw));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
