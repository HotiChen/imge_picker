// Browser suite: the project page's 「進度」 with the activity log (docs/delivery.md, "Activity log"). admin.html
// fetches GET /api/admin/projects/:id/events next to the detail and merges the logged events (交件, 改交, 取消交件,
// 開放修改, 開始精修, 確認完成) with the steps it derives from the project's columns and the revision rounds, by time,
// without showing one thing twice. No events, or a failed fetch: 進度 is exactly what it was without the log.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-log`;
const FILES = ['shoot/毛片/p1.jpg', 'shoot/精修/a1.jpg', 'shoot/精修二/b1.jpg', 'shoot/精修三/c1.jpg'];
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-log', title: '紀錄專案', ownerName: 'Lin', folders: ['shoot/毛片/'], pickFiles: FILES, ...o });
const sub = at => ({ id: 's-' + at, picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['shoot/毛片/p1.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: at, notified: 1 });
const STEPS = () => [...document.querySelectorAll('#pd-progress [data-step]')].map(li => ({
  step: li.dataset.step, state: li.dataset.state, kind: li.dataset.kind || null, mark: li.querySelector('.pd-step-mark')?.textContent.trim() ?? null,
  label: li.querySelector('.pd-step-label')?.textContent.trim() ?? null, date: li.querySelector('.pd-step-date')?.textContent.trim() ?? '' }));
const steps = page => page.evaluate(STEPS);
const eventsFetched = m => m.requests.filter(r => r.method === 'GET' && r.path === '/api/admin/projects/proj-log/events');
// the log arrives after the detail: wait until 進度 has drawn with it (a logged row, or the fetch answered)
const waitLog = (page, sel = '#pd-steps [data-kind]') => page.waitForSelector(sel, { state: 'attached', timeout: 5000 });
const TIME = /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/;

// the 99 suite's own fixture: delivered 9/20 with two rounds (one open), two submissions — and no log
const DELIVERED = { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] };
const openRound = { id: 'r-open', message: '第二輪：再亮', picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z', resolved_at: null };
const oldRound = { id: 'r-old', message: '第一輪：背景', picker_id: 'picker-0', created_at: '2026-09-21T03:00:00.000Z', resolved_at: '2026-09-21T09:00:00.000Z' };
const TODAY = {
  steps: '["picked","retouch","delivered","round-1","round-2","confirmed"]',
  labels: JSON.stringify(['客人送出選片', '開始精修', '交件', '客人要求修改（第 1 輪）', '客人要求修改（第 2 輪）', '客人確認']),
  marks: '✓✓✓✓●○',
  dates: JSON.stringify(['9/12', '', '9/20', '9/21', '9/22', '']),
};
for (const [label, o] of [['the log is empty', {}], ['the log fetch fails (500: table missing / DB error)', { eventsStatus: 500 }]]) {
  const m = fx({ ...DELIVERED, revisions: [oldRound, openRound], ...o });
  m.state.submissions.push(sub('2026-09-10T02:00:00.000Z'), sub('2026-09-12T02:00:00.000Z'));
  await suite(`99f project log — ${label}: 進度 is exactly what it is without the log`, URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-progress [data-step]', { timeout: 5000 });
    await page.waitForTimeout(300);   // the events answer has come back by now and 進度 has drawn again
    ok('the page asked for the log (control)', eventsFetched(m).length >= 1, JSON.stringify(m.requests.map(r => r.path)));
    ok('the log request carries the admin credential', eventsFetched(m).every(r => r.auth === 'Bearer adm'), JSON.stringify(eventsFetched(m).map(r => r.auth)));
    const s = await steps(page);
    ok('steps as today', JSON.stringify(s.map(x => x.step)) === TODAY.steps, JSON.stringify(s));
    ok('labels as today', JSON.stringify(s.map(x => x.label)) === TODAY.labels, JSON.stringify(s.map(x => x.label)));
    ok('marks as today', s.map(x => x.mark).join('') === TODAY.marks, s.map(x => x.mark).join(''));
    ok('dates as today (days, no times)', JSON.stringify(s.map(x => x.date)) === TODAY.dates, JSON.stringify(s.map(x => x.date)));
    ok('no logged row', s.every(x => !x.kind));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// 交件 精修 → 改交 精修三 → a pins round (1 photo, resolved by the next deliver) → 改交 back to 精修 (「改交這一版」)
const T = {
  retouch: '2026-10-18T09:00:00.000Z', first: '2026-10-18T17:20:00.000Z', v3: '2026-10-19T03:00:00.000Z',
  round: '2026-10-19T16:49:00.000Z', back: '2026-10-19T18:10:00.000Z',
};
const REVERT_EVENTS = [
  { at: T.retouch, kind: 'retouch' },
  { at: T.first, kind: 'deliver', data: { final_folders: ['shoot/精修/'] } },
  { at: T.v3, kind: 'deliver', data: { final_folders: ['shoot/精修三/'], repeat: true, previous: ['shoot/精修/'] } },
  { at: T.back, kind: 'deliver', data: { final_folders: ['shoot/精修/'], repeat: true, previous: ['shoot/精修三/'] } },
];
const pinsRound = { id: 'r-pins', message: '請看標示', picker_id: 'picker-0', created_at: T.round, resolved_at: T.back,
  kind: 'pins', marks: { 'shoot/精修三/c1.jpg': [{ x: 0.5, y: 0.5, note: '亮一點' }] }, finals: ['shoot/精修三/'], message_auto: true };
{
  const m = fx({ phase: 'retouching', deliveredAt: T.first, finalFolders: ['shoot/精修/'], revisions: [pinsRound], events: REVERT_EVENTS });
  m.state.submissions.push(sub('2026-10-18T02:00:00.000Z'));
  await suite('99f project log — 改交 back to an older version leaves its trace: every 交件 / 改交 in time order with the round between, each once', URL_, async page => {
    const out = [], ok = line(out);
    await waitLog(page);
    const s = await steps(page);
    ok('floor: 7 rows', s.length === 7, JSON.stringify(s));
    ok('labels in time order', JSON.stringify(s.map(x => x.label)) === JSON.stringify([
      '客人送出選片', '開始精修', '交件（精修）', '改交精修三（原本是精修）', '客人要求修改（第 1 輪，1 張）', '改交精修（原本是精修三）', '客人確認',
    ]), JSON.stringify(s.map(x => x.label)));
    ok('the 交件 step took the first deliver event (no separate 交件 line)', s.filter(x => x.label.startsWith('交件')).length === 1 && s[2].step === 'delivered', JSON.stringify(s));
    ok('開始精修 is dated by the log', s[1].step === 'retouch' && TIME.test(s[1].date), JSON.stringify(s[1]));
    ok('the two 改交 are logged rows', s[3].kind === 'deliver' && s[5].kind === 'deliver', JSON.stringify(s));
    ok('every done row has a date with a time', s.slice(0, 6).every(x => TIME.test(x.date)), JSON.stringify(s.map(x => x.date)));
    ok('✓ ×6 then ● 客人確認', s.map(x => x.mark).join('') === '✓✓✓✓✓✓●' && s[6].state === 'current' && s[6].date === '', s.map(x => x.mark).join(''));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'retouching', deliveredAt: T.first, finalFolders: ['shoot/精修/'], confirmedAt: T.back, confirmedBy: 'guest',
    events: [...REVERT_EVENTS.slice(0, 2), { at: T.back, kind: 'confirm', actor: 'client' }] });
  m.state.submissions.push(sub('2026-10-18T02:00:00.000Z'));
  await suite('99f project log — the confirmation the 客人確認 step already shows is not a second line', URL_, async page => {
    const out = [], ok = line(out);
    await waitLog(page, '#pd-steps [data-step="delivered"]');
    await page.waitForFunction(() => document.querySelector('#pd-steps [data-step="delivered"] .pd-step-label')?.textContent === '交件（精修）', null, { timeout: 5000 });
    const s = await steps(page);
    ok('floor: the log was merged (交件 shows its folder)', s.some(x => x.label === '交件（精修）'), JSON.stringify(s));
    ok('one confirmation row: the 客人確認 step, dated', s.filter(x => /確認/.test(x.label)).length === 1 && s.at(-1).step === 'confirmed' && TIME.test(s.at(-1).date), JSON.stringify(s));
    ok('no 客人確認完成 line', !s.some(x => x.label === '客人確認完成'));
    ok('all ✓', s.every(x => x.state === 'done'), JSON.stringify(s));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  // delivered, taken down, reopened: now picking again with nothing delivered
  const m = fx({ phase: 'picking', finalFolders: ['shoot/精修/'], events: [
    { at: '2026-10-10T01:00:00.000Z', kind: 'retouch' },
    { at: '2026-10-11T01:00:00.000Z', kind: 'deliver', data: { final_folders: ['shoot/精修/'] } },
    { at: '2026-10-12T01:00:00.000Z', kind: 'undeliver', data: { final_folders: ['shoot/精修/'] } },
    { at: '2026-10-13T01:00:00.000Z', kind: 'reopen', data: { from_phase: 'retouching', was_delivered: false } },
    { at: '2026-10-14T01:00:00.000Z', kind: 'confirm', actor: 'photographer' },
    { at: '2026-10-15T01:00:00.000Z', kind: 'something-new' },
  ] });
  await suite('99f project log — 取消交件 and 開放修改 are history; the steps ahead stay below them; an unknown kind is skipped', URL_, async page => {
    const out = [], ok = line(out);
    await waitLog(page);
    const s = await steps(page);
    const logged = s.filter(x => x.kind);
    ok('logged rows in order', JSON.stringify(logged.map(x => x.label)) === JSON.stringify(['開始精修', '交件（精修）', '取消交件', '開放修改', '已標記完成（代客人）']), JSON.stringify(s));
    ok('the unknown kind is not drawn', !s.some(x => x.kind === 'something-new') && s.length === logged.length + 4, JSON.stringify(s));
    ok('the four steps ahead come after the history, ● on 送出選片', JSON.stringify(s.slice(logged.length).map(x => x.step)) === '["picked","retouch","delivered","confirmed"]'
      && s[logged.length].state === 'current' && s.slice(logged.length + 1).every(x => x.state === 'next'), JSON.stringify(s));
    ok('history rows are ✓ with a time', logged.every(x => x.state === 'done' && x.mark === '✓' && TIME.test(x.date)), JSON.stringify(logged));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  // 精修三 delivered (no log before it); 改交這一版 on 精修 → the fake logs it as worker.js does, the page redraws
  const m = fx({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修三/'] });
  await suite('99f project log — pressing 改交這一版 adds 「改交精修（原本是精修三）」 to 進度 right away', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-photos[data-target="ready"]', { state: 'attached', timeout: 5000 });
    await page.waitForTimeout(200);
    const before = await steps(page);
    ok('control: no logged row before', before.length >= 4 && before.every(x => !x.kind), JSON.stringify(before));
    page.on('dialog', d => d.type() === 'confirm' ? d.accept() : d.dismiss());
    await page.click('#pd-photos [data-version="shoot/精修/"] [data-revert-version]');
    await page.waitForFunction(() => [...document.querySelectorAll('#pd-steps [data-kind="deliver"] .pd-step-label')].some(e => e.textContent === '改交精修（原本是精修三）'), null, { timeout: 5000 });
    const s = await steps(page);
    ok('one 改交 row, dated with a time', s.filter(x => x.kind === 'deliver').length === 1 && TIME.test(s.find(x => x.kind === 'deliver').date), JSON.stringify(s));
    ok('the 交件 step is still there once (the first delivery, before the log)', s.filter(x => x.step === 'delivered').length === 1 && s.find(x => x.step === 'delivered').label === '交件', JSON.stringify(s));
    ok('the fake logged exactly one event (control)', m.state.events.length === 1 && m.state.events[0].data.repeat === true, JSON.stringify(m.state.events));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const evil = 'shoot/<img src=x onerror=window.__pwned=1>/';
  const m = fx({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: [evil], events: [
    { at: '2026-10-01T00:00:00.000Z', kind: 'deliver', data: { final_folders: [evil] } },
    { at: '2026-10-02T00:00:00.000Z', kind: 'deliver', data: { final_folders: ['shoot/精修/'], repeat: true, previous: [evil] } },
  ] });
  await suite('99f project log — folder names in the log are text, never markup', URL_, async page => {
    const out = [], ok = line(out);
    await waitLog(page);
    const s = await steps(page);
    ok('floor: the 改交 row is there', s.some(x => x.kind === 'deliver'), JSON.stringify(s));
    ok('the name shows as text', s.some(x => x.label === '改交精修（原本是<img src=x onerror=window.__pwned=1>）'), JSON.stringify(s.map(x => x.label)));
    ok('no element was made from it', await page.evaluate(() => !document.querySelector('#pd-steps img') && !window.__pwned));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const long = 'shoot/2026-10-19 王先生林小姐婚紗精修第三版最終確認版本/';
  const m = fx({ phase: 'retouching', deliveredAt: T.first, finalFolders: ['shoot/精修/'], revisions: [pinsRound], events: [
    ...REVERT_EVENTS.slice(0, 2),
    { at: T.v3, kind: 'deliver', data: { final_folders: [long], repeat: true, previous: ['shoot/精修/'] } },
    { at: T.back, kind: 'deliver', data: { final_folders: ['shoot/精修/'], repeat: true, previous: [long] } },
  ] });
  m.state.submissions.push(sub('2026-10-18T02:00:00.000Z'));
  await suite('99f project log — phone 390px: no sideways scroll, long lines wrap, every time stays whole on its row', URL_, async page => {
    const out = [], ok = line(out);
    await waitLog(page);
    const g = await page.evaluate(() => {
      const lis = [...document.querySelectorAll('#pd-steps li')];
      const card = document.getElementById('pd-progress').getBoundingClientRect();
      return {
        sw: document.documentElement.scrollWidth, vw: innerWidth, n: lis.length,
        inside: lis.every(li => { const r = li.getBoundingClientRect(); return r.left >= card.left - 1 && r.right <= card.right + 1; }),
        labels: lis.map(li => { const l = li.querySelector('.pd-step-label'); return l.scrollWidth <= l.clientWidth + 1; }),
        dates: lis.map(li => { const d = li.querySelector('.pd-step-date'); return d.textContent === '' || d.getBoundingClientRect().height < 24; }),
        font: lis.map(li => parseFloat(getComputedStyle(li.querySelector('.pd-step-label')).fontSize)),
      };
    });
    ok('floor: 7 rows scanned', g.n === 7, JSON.stringify(g));
    ok('no sideways scroll', g.sw <= g.vw, JSON.stringify([g.sw, g.vw]));
    ok('every row inside the 進度 card', g.inside);
    ok('no label is cut off', g.labels.every(Boolean), JSON.stringify(g.labels));
    ok('every time is one line', g.dates.every(Boolean), JSON.stringify(g.dates));
    ok('text >= 13px', g.font.every(f => f >= 13), JSON.stringify(g.font));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
