// Browser suites: the project page's 「照片」 block (one row per version: 毛片, 精修, 精修二 …, the delivered one marked
// 「客人目前看的版本」, an empty next-version row while a round is open, the downloads under it) and the 「進度」 timeline
// (✓ done / ● current / ○ next, built only from data the page already has: a step without a known date shows no date).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-ph`;
const NO_FINALS = ['shoot/', 'shoot/毛片/'];
const ONE_FINAL = ['shoot/', 'shoot/毛片/', 'shoot/精修/'];
const TWO_FINALS = ['shoot/', 'shoot/毛片/', 'shoot/精修/', 'shoot/精修二/'];
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] };
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-ph', title: '照片專案', ownerName: 'Zoe', folders: ['shoot/毛片/'], bucketFolders: NO_FINALS, ...o });
const openRound = { id: 'r-open', message: '第二輪：再亮', picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z', resolved_at: null };
const oldRound = { id: 'r-old', message: '第一輪：背景', picker_id: 'picker-0', created_at: '2026-09-21T03:00:00.000Z', resolved_at: '2026-09-21T09:00:00.000Z' };
const sub = at => ({ id: 's-' + at, picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['shoot/毛片/a.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: at, notified: 1 });

const ROWS = () => [...document.querySelectorAll('#pd-photos [data-version]')].map(r => {
  const view = r.querySelector('[data-view]');
  const up = r.querySelector('[data-version-upload]');
  return { name: r.querySelector('.pd-ver-name')?.textContent.trim() ?? null, version: r.dataset.version,
    current: !!r.querySelector('[data-current-version]') && r.querySelector('[data-current-version]').textContent.trim() === '客人目前看的版本',
    view: view ? view.getAttribute('href') : null, viewText: view ? view.textContent.trim() : null,
    up: up ? up.getAttribute('href') : null, upText: up ? up.textContent.trim() : null, empty: r.hasAttribute('data-empty') };
});
const rows = page => page.evaluate(ROWS);
const waitRows = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const qp = href => { const u = new URL(href, base); return Object.fromEntries(u.searchParams); };
const STEPS = () => [...document.querySelectorAll('#pd-progress [data-step]')].map(li => ({
  step: li.dataset.step, state: li.dataset.state, mark: li.querySelector('.pd-step-mark')?.textContent.trim() ?? null,
  label: li.querySelector('.pd-step-label')?.textContent.trim() ?? null, date: li.querySelector('.pd-step-date')?.textContent.trim() ?? '' }));
const steps = page => page.evaluate(STEPS);

{
  const m = fx({ phase: 'picking' });
  await suite('project page photos — 選片中: one 毛片 row with 看 and the live ＋上傳毛片 link; 下載選片 / 下載需求表 under it', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rows(page);
    ok('one row: 毛片', JSON.stringify(r.map(x => x.name)) === '["毛片"]', JSON.stringify(r));
    ok('毛片 看 → the review view of every proof of this project', r[0] && r[0].viewText === '看' && qp(r[0].view).project === 'proj-ph' && qp(r[0].view).mode === 'all' && /^index\.html\?/.test(r[0].view), JSON.stringify(r[0]));
    ok('＋上傳毛片 sits in the 毛片 row and is the locked upload link',
      await page.$eval('#pd-photos [data-version="proofs"] #pd-upload-proofs-btn', a => a.tagName === 'A' && /folder=shoot%2F%E6%AF%9B%E7%89%87%2F/.test(a.href) && /lock=1/.test(a.href)).catch(() => false));
    ok('下載選片 and 下載需求表 (CSV) are in the 照片 block, under the rows',
      await page.evaluate(() => { const b = document.getElementById('pd-photos'), d = document.getElementById('pd-download-btn'), c = document.getElementById('pd-download-csv-btn'), last = [...b.querySelectorAll('[data-version]')].pop();
        return !!d && !!c && b.contains(d) && b.contains(c) && !!(last.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'retouching', bucketFolders: TWO_FINALS });
  await suite('project page photos — 精修中 with 精修 and 精修二 uploaded: one row each, 看 opens the 精修 tab, nobody marked current yet; ＋上傳毛片 is grayed out', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rows(page);
    ok('rows 毛片, 精修, 精修二 (oldest version first)', JSON.stringify(r.map(x => x.name)) === '["毛片","精修","精修二"]', JSON.stringify(r));
    ok('each 精修 row has 看 → the review view\'s 精修 tab', r.slice(1).every(x => x.viewText === '看' && qp(x.view).mode === 'finals' && qp(x.view).project === 'proj-ph'), JSON.stringify(r));
    ok('not delivered: no row says 客人目前看的版本', r.every(x => !x.current));
    ok('no empty next-version row (no round is open)', !r.some(x => x.empty));
    ok('＋上傳毛片 is the disabled button in the 毛片 row (suite 95 rule)',
      await page.$eval('#pd-photos [data-version="proofs"] #pd-upload-proofs-btn', b => b.tagName === 'BUTTON' && b.disabled).catch(() => false));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL, revisions: [openRound] });
  await suite('project page photos — round open, 精修二 not uploaded: 精修 is 客人目前看的版本, an empty 精修二 row offers ＋ 上傳 (locked)', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rows(page);
    ok('rows 毛片, 精修, 精修二 (the last one empty)', JSON.stringify(r.map(x => x.name)) === '["毛片","精修","精修二"]' && r[2] && r[2].empty && !r[1].empty, JSON.stringify(r));
    ok('精修 is the version the client sees now', r[1] && r[1].current && !r[0].current && !r[2].current, JSON.stringify(r));
    const q = r[2] && r[2].up ? qp(r[2].up) : {};
    ok('the empty row\'s ＋ 上傳 is the locked upload link for shoot/精修二/', r[2] && r[2].upText === '＋ 上傳' && q.folder === 'shoot/精修二/' && q.lock === '1' && q.project === 'proj-ph', JSON.stringify(r[2]));
    ok('the empty row has no 看 (nothing to look at yet)', r[2] && r[2].view === null);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: TWO_FINALS, revisions: [openRound] });
  await suite('project page photos — round open, 精修二 already uploaded: a normal 精修二 row, no empty row', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rows(page);
    ok('rows 毛片, 精修, 精修二, none empty', JSON.stringify(r.map(x => x.name)) === '["毛片","精修","精修二"]' && !r.some(x => x.empty), JSON.stringify(r));
    ok('精修 is current, 精修二 is not (not delivered yet)', r[1].current && !r[2].current, JSON.stringify(r));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: TWO_FINALS, listFail: 500 });
  await suite('project page photos — the folder listing fails: the delivered folder is still listed (from the project), marked current', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rows(page);
    ok('rows 毛片, 精修', JSON.stringify(r.map(x => x.name)) === '["毛片","精修"]', JSON.stringify(r));
    ok('精修 is current', r[1] && r[1].current, JSON.stringify(r));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL, revisions: [openRound] });
  await suite('project page photos — phone 390px: rows fit (no sideways scroll), 看 / ＋ 上傳 are >= 44px tall', URL_, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth,
      hs: [...document.querySelectorAll('#pd-photos [data-view], #pd-photos [data-version-upload], #pd-photos .btn')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)) }));
    ok('control: controls found', g.hs.length >= 4, JSON.stringify(g));
    ok('no horizontal scroll', g.sw <= g.vw, JSON.stringify(g));
    ok('every control >= 44px', g.hs.every(h => h >= 44), JSON.stringify(g.hs));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

// ── 進度 ──
{
  const m = fx({ phase: 'picking' });
  await suite('project page progress — 選片中: 送出選片 is current, the rest are next, no dates invented', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-progress [data-step]', { timeout: 5000 });
    const s = await steps(page);
    ok('steps 送出選片, 開始精修, 交件, 客人確認', JSON.stringify(s.map(x => x.step)) === '["picked","retouch","delivered","confirmed"]', JSON.stringify(s));
    ok('● on 送出選片, ○ on the rest', s[0].state === 'current' && s[0].mark === '●' && s.slice(1).every(x => x.state === 'next' && x.mark === '○'), JSON.stringify(s));
    ok('no step shows a date', s.every(x => x.date === ''), JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL, revisions: [oldRound, openRound] });
  m.state.submissions.push(sub('2026-09-10T02:00:00.000Z'), sub('2026-09-12T02:00:00.000Z'));
  await suite('project page progress — delivered with two rounds (one open): ✓ up to 第 1 輪, ● on 第 2 輪, ○ 客人確認; 開始精修 has no date', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-progress [data-step]', { timeout: 5000 });
    const s = await steps(page);
    ok('steps: picked, retouch, delivered, round-1, round-2, confirmed', JSON.stringify(s.map(x => x.step)) === '["picked","retouch","delivered","round-1","round-2","confirmed"]', JSON.stringify(s));
    ok('labels', JSON.stringify(s.map(x => x.label)) === JSON.stringify(['客人送出選片', '開始精修', '交件', '客人要求修改（第 1 輪）', '客人要求修改（第 2 輪）', '客人確認']), JSON.stringify(s.map(x => x.label)));
    ok('marks ✓ ✓ ✓ ✓ ● ○', s.map(x => x.mark).join('') === '✓✓✓✓●○', s.map(x => x.mark).join(''));
    ok('dates: the latest submission 9/12, none for 開始精修, 交件 9/20, rounds 9/21 and 9/22, none for 確認',
      JSON.stringify(s.map(x => x.date)) === JSON.stringify(['9/12', '', '9/20', '9/21', '9/22', '']), JSON.stringify(s.map(x => x.date)));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ ...DELIVERED, bucketFolders: ONE_FINAL, confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'guest' });
  await suite('project page progress — confirmed: every step ✓, 客人確認 dated', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-progress [data-step]', { timeout: 5000 });
    const s = await steps(page);
    ok('all ✓', s.length === 4 && s.every(x => x.state === 'done' && x.mark === '✓'), JSON.stringify(s));
    ok('客人確認 9/23', s[3].date === '9/23', JSON.stringify(s[3]));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

}
