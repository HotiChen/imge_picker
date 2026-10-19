// Browser suite: 「改交這一版」 on the project page's 照片 rows. While a project is delivered, every 精修 version row that
// is NOT the delivered one offers it; after a confirm that says what happens (the client sees that version, a
// confirmation is cleared, open requests are closed: docs/delivery.md, a repeat deliver), it sends the same deliver
// request 交付精修二 sends, with that one folder, and the page redraws. Not offered before the first delivery or
// after 取消交件 (the normal 交件 flow stays), nor on the delivered row.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-r`;
const FILES = ['shoot/毛片/p1.jpg', 'shoot/精修/a1.jpg', 'shoot/精修二/b1.jpg', 'shoot/精修三/c1.jpg'];
const DELIVERED_V3 = { phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修三/'] };
const world = (o = {}) => pickFakeWorker({ projectId: 'proj-r', title: '回版專案', ownerName: 'Rae', folders: ['shoot/毛片/'], pickFiles: FILES, ...o });
const waitRows = page => page.waitForSelector('#pd-photos[data-target="ready"]', { state: 'attached', timeout: 5000 });
const ROWS = () => [...document.querySelectorAll('#pd-photos [data-version]')].map(r => {
  const b = r.querySelector('[data-revert-version]');
  return { v: r.dataset.version, current: !!r.querySelector('[data-current-version]'),
    revert: b ? { text: b.textContent.trim(), folder: b.dataset.folder, tag: b.tagName, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) } : null };
});
const rows = page => page.evaluate(ROWS);
const delivers = m => m.requests.filter(r => r.method === 'POST' && /\/deliver$/.test(r.path));
const confirmed = '2026-10-02T00:00:00.000Z';
const openRound = { id: 'r-open', message: '再亮一點', picker_id: 'picker-0', created_at: '2026-10-03T04:00:00.000Z', resolved_at: null };

{
  const m = world({ ...DELIVERED_V3, revisions: [openRound] });
  await suite('99d revert version — delivered 精修三: 改交這一版 on 精修 and 精修二 only, each naming its own folder', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    const r = await rows(page);
    // the open round adds the empty 精修四 row to upload into: nothing to hand over there
    ok('floor: rows 毛片, 精修, 精修二, 精修三, then the empty 精修四', JSON.stringify(r.map(x => x.v)) === JSON.stringify(['proofs', 'shoot/精修/', 'shoot/精修二/', 'shoot/精修三/', 'shoot/精修四/']), JSON.stringify(r));
    ok('the empty 精修四 row has no 改交這一版', r[4] && r[4].revert === null, JSON.stringify(r[4]));
    ok('精修三 is current and has no 改交這一版', r[3].current && r[3].revert === null, JSON.stringify(r[3]));
    ok('精修 and 精修二 each have a 改交這一版 button for their own folder', [1, 2].every(i => r[i].revert && r[i].revert.text === '改交這一版' && r[i].revert.tag === 'BUTTON' && r[i].revert.folder === r[i].v), JSON.stringify(r));
    ok('the 毛片 row has none', r[0].revert === null);
    ok('desktop: the button is a >= 44px target', [1, 2].every(i => r[i].revert && r[i].revert.h >= 44 && r[i].revert.w >= 44), JSON.stringify(r.map(x => x.revert)));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = world({ ...DELIVERED_V3, confirmedAt: confirmed });
  await suite('99d revert version — cancel the confirm: the dialog says what happens, nothing is sent', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    const msgs = [];
    page.on('dialog', d => { msgs.push({ type: d.type(), text: d.message() }); d.dismiss(); });
    await page.click('#pd-photos [data-version="shoot/精修/"] [data-revert-version]');
    await page.waitForTimeout(300);
    ok('one confirm dialog', msgs.length === 1 && msgs[0].type === 'confirm', JSON.stringify(msgs));
    const t = msgs[0] ? msgs[0].text : '';
    ok('it names the version the client will see and the one they see now', t.includes('客人將改看「精修」') && t.includes('不再看到「精修三」'), t);
    ok('it says the confirmation is cleared and open requests are closed', t.includes('已確認完成的狀態會取消') && t.includes('待處理的修改要求會一併結案'), t);
    ok('no deliver was sent', delivers(m).length === 0, JSON.stringify(delivers(m)));
    const r = await rows(page);
    ok('nothing changed on the page: 精修三 still current', r[3].current && !r[1].current, JSON.stringify(r));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = world({ ...DELIVERED_V3, confirmedAt: confirmed });
  await suite('99d revert version — confirm: exactly one deliver POST with final_folders [精修] only; the rows redraw (精修 current, 精修三 offers 改交這一版)', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    page.on('dialog', d => d.type() === 'confirm' ? d.accept() : d.dismiss());
    await page.click('#pd-photos [data-version="shoot/精修/"] [data-revert-version]');
    await page.waitForFunction(() => !!document.querySelector('#pd-photos [data-version="shoot/精修/"] [data-current-version]'), null, { timeout: 5000 });
    const d = delivers(m);
    ok('exactly one deliver request', d.length === 1, JSON.stringify(d.map(x => x.path)));
    ok('to this project, with the admin credential', d[0] && d[0].path === '/api/admin/projects/proj-r/deliver' && d[0].auth === 'Bearer adm', JSON.stringify(d[0] && [d[0].path, d[0].auth]));
    ok('body is exactly { final_folders: ["shoot/精修/"] }', d[0] && JSON.stringify(d[0].body) === JSON.stringify({ final_folders: ['shoot/精修/'] }), JSON.stringify(d[0] && d[0].body));
    ok('no other write', m.requests.filter(r => r.method !== 'GET' && r.method !== 'OPTIONS' && r.path !== '/api/auth/studio-token').length === 1);
    ok('the fake (as the Worker) cleared the confirmation', m.state.project.client_confirmed_at === null, JSON.stringify(m.state.project.client_confirmed_at));
    ok('the status card is back to 客人確認中 (not 已完成)', await page.$eval('#pd-status', e => e.dataset.stage) === 'awaiting');
    const r = await rows(page);
    ok('精修 is now current, without the button', r[1].current && r[1].revert === null, JSON.stringify(r[1]));
    ok('精修三 is no longer current and now offers 改交這一版', !r[3].current && r[3].revert && r[3].revert.folder === 'shoot/精修三/', JSON.stringify(r[3]));
    ok('精修二 still offers it', r[2].revert && r[2].revert.folder === 'shoot/精修二/', JSON.stringify(r[2]));
    ok('the delivered folder line shows 精修', await page.evaluate(() => (document.getElementById('pd-delivered-folders')?.textContent || '').includes('精修') && !(document.getElementById('pd-delivered-folders')?.textContent || '').includes('精修三')));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = world({ ...DELIVERED_V3, revisions: [openRound] });
  await suite('99d revert version — during an open round: 改交這一版 on 精修二 sends one deliver of 精修二; the round is closed', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    ok('control: the status card shows the open round', await page.$eval('#pd-status', e => e.dataset.stage) === 'revising');
    page.on('dialog', d => d.type() === 'confirm' ? d.accept() : d.dismiss());
    await page.click('#pd-photos [data-version="shoot/精修二/"] [data-revert-version]');
    await page.waitForFunction(() => !!document.querySelector('#pd-photos [data-version="shoot/精修二/"] [data-current-version]'), null, { timeout: 5000 });
    const d = delivers(m);
    ok('one deliver with final_folders [精修二]', d.length === 1 && JSON.stringify(d[0].body) === JSON.stringify({ final_folders: ['shoot/精修二/'] }), JSON.stringify(d.map(x => x.body)));
    ok('the round is resolved (the Worker resolves open requests on every deliver)', m.state.revisions.every(x => x.resolved_at), JSON.stringify(m.state.revisions));
    ok('the status card left 客人要求修改', await page.$eval('#pd-status', e => e.dataset.stage) === 'awaiting');
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = world({ ...DELIVERED_V3, confirmedAt: confirmed });
  await suite('99d revert version — a refused deliver shows the error and re-enables the button; the rows stay', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    // the project went back to picking elsewhere (another tab reopened it): the Worker answers 409 not_retouching
    m.state.project.phase = 'picking';
    page.on('dialog', d => d.type() === 'confirm' ? d.accept() : d.dismiss());
    await page.click('#pd-photos [data-version="shoot/精修/"] [data-revert-version]');
    await page.waitForFunction(() => (document.getElementById('pd-deliver-err')?.textContent || '').trim().length > 0, null, { timeout: 5000 });
    ok('one deliver was tried', delivers(m).length === 1);
    ok('the button is usable again', await page.$eval('#pd-photos [data-version="shoot/精修/"] [data-revert-version]', b => !b.disabled));
    ok('精修三 is still current', (await rows(page))[3].current);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

for (const [label, o] of [
  ['精修中, never delivered', { phase: 'retouching' }],
  ['after 取消交件 (final_folders kept, delivered_at cleared)', { phase: 'retouching', deliveredAt: null, finalFolders: ['shoot/精修三/'] }],
  ['選片中', { phase: 'picking' }],
]) {
  const m = world(o);
  await suite(`99d revert version — ${label}: no 改交這一版 anywhere (the normal 交件 flow stays)`, URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    const r = await rows(page);
    ok('floor: the three 精修 rows are there', r.filter(x => x.v.startsWith('shoot/精修')).length === 3, JSON.stringify(r));
    ok('no row offers 改交這一版', r.every(x => x.revert === null), JSON.stringify(r));
    ok('no row is marked current', r.every(x => !x.current), JSON.stringify(r));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = world(DELIVERED_V3);
  await suite('99d revert version — phone 390px: 改交這一版 is >= 44px and the rows do not scroll sideways', URL_, async page => {
    const out = [], ok = okFn(out);
    await waitRows(page);
    const r = await rows(page);
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth }));
    const bs = r.filter(x => x.revert).map(x => x.revert);
    ok('floor: two buttons', bs.length === 2, JSON.stringify(r));
    ok('each >= 44 x 44', bs.every(b => b.h >= 44 && b.w >= 44), JSON.stringify(bs));
    ok('no horizontal scroll', sw.sw <= sw.vw, JSON.stringify(sw));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
