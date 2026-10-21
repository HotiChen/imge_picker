// Browser suites: three small fixes (Tim 2026-10-21).
//  1. (regression guard; the change itself is commit 5d33e6f) the guest submit form field reads 「與被攝者的關係」 (was 與新人的關係: it asks who the guest is to the people photographed).
//  2. 「改交這一版」 is not offered on an archived project (the button is removed from the DOM, not hidden).
//  3. 「開放修改」 in the ⋯ menu asks first (a confirm that says what happens); cancel sends nothing, confirm sends the reopen.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

// ── 1. 與被攝者的關係 ──
{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('小修 1 — the submit form field is 「與被攝者的關係」, 「與新人的關係」 is gone from the form',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      const label = await page.$eval('label[for="pickSubmitRelationship"]', l => l.textContent.replace(/\s+/g, ' ').trim());
      ok('positive: the label reads 與被攝者的關係 (* required kept)', label === '與被攝者的關係 *', label);
      const modal = await page.$eval('#pickSubmitModal', e => e.textContent);
      ok('the old wording 與新人的關係 appears nowhere in the open form', !modal.includes('與新人的關係'), modal.slice(0, 200));
      ok('the select is still the same field with its options', await page.$$eval('#pickSubmitRelationship option', os => os.length > 3));
      return out;
    }, { before: m.attach, initScript: "localStorage.setItem('pick_key:TOK', 'CAROL-KEY');" });
}

// ── 2. 改交這一版 hidden on an archived project ──
const URL_R = `${base}/admin.html#project=proj-r`;
const FILES = ['shoot/毛片/p1.jpg', 'shoot/精修/a1.jpg', 'shoot/精修二/b1.jpg', 'shoot/精修三/c1.jpg'];
const world = (o = {}) => pickFakeWorker({ projectId: 'proj-r', title: '回版專案', ownerName: 'Rae', folders: ['shoot/毛片/'], pickFiles: FILES, ...o });
const DELIVERED_V3 = { phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修三/'] };
const waitRows = page => page.waitForSelector('#pd-photos[data-target="ready"]', { state: 'attached', timeout: 5000 });
const rowsInfo = page => page.evaluate(() => [...document.querySelectorAll('#pd-photos [data-version]')].map(r => ({ v: r.dataset.version, revert: !!r.querySelector('[data-revert-version]'), view: !!r.querySelector('[data-view]') })));

for (const [label, archivedAt, expectRevert] of [
  ['archived', '2026-10-05T00:00:00.000Z', false],
  ['not archived (control: unchanged)', null, true],
]) {
  const m = world({ ...DELIVERED_V3, archivedAt });
  await suite(`小修 2 — delivered 精修三, ${label}: ${expectRevert ? '精修 and 精修二 still offer 改交這一版' : 'no 改交這一版 button in the DOM'}`, URL_R, async page => {
    const out = [], ok = line(out);
    await waitRows(page);
    const r = await rowsInfo(page);
    ok('floor: rows 毛片, 精修, 精修二, 精修三, each with its 看', JSON.stringify(r.map(x => x.v)) === JSON.stringify(['proofs', 'shoot/精修/', 'shoot/精修二/', 'shoot/精修三/']) && r.every(x => x.view), JSON.stringify(r));
    ok('精修三 is still marked 客人目前看的版本', await page.$$eval('#pd-photos [data-current-version]', e => e.length === 1));
    if (expectRevert) {
      ok('positive: 精修 and 精修二 offer 改交這一版', r[1].revert && r[2].revert && !r[3].revert, JSON.stringify(r));
      ok('the button is really displayed', await page.$$eval('#pd-photos [data-revert-version]', bs => bs.length === 2 && bs.every(b => b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none')));
    } else {
      ok('no row has a 改交這一版 element (removed from the DOM)', r.every(x => !x.revert), JSON.stringify(r));
      ok('no element anywhere on the page says 改交這一版', !(await page.evaluate(() => document.body.innerText.includes('改交這一版') || !!document.querySelector('[data-revert-version]'))));
    }
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

// ── 3. 開放修改 asks first ──
const URL_E = `${base}/admin.html#project=proj-ed`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-ed', title: '編輯專案', ownerName: '你好', folders: ['20261019 編輯專案/毛片/'],
  bucketFolders: ['20261019 編輯專案/', '20261019 編輯專案/毛片/'], ...o });
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const reopens = m => m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/reopen'));
const stageOf = page => page.evaluate(() => document.getElementById('pd-status')?.dataset.stage);

{
  const m = fx({ phase: 'submitted' });
  await suite('小修 3 — 開放修改: the confirm appears and sends nothing; 取消 changes nothing; 確定 sends one reopen', URL_E, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage, null, { timeout: 5000 });
    await waitReady(page);
    const before = await stageOf(page);
    ok('floor: the card is 選片完成・待精修 (submitted)', before === 'submitted', before);
    const dialogs = [];
    let answer = 'dismiss';
    page.on('dialog', async d => { dialogs.push({ type: d.type(), text: d.message(), reqsAtOpen: reopens(m).length }); await (answer === 'accept' ? d.accept() : d.dismiss()); });
    await page.click('#pd-more-btn');
    await page.click('#pd-reopen-btn');
    await page.waitForTimeout(400);
    ok('a confirm dialog appeared, before any request', dialogs.length === 1 && dialogs[0].type === 'confirm' && dialogs[0].reqsAtOpen === 0, JSON.stringify(dialogs));
    const t = dialogs[0] ? dialogs[0].text : '';
    ok('the text says the client can change their picks again and the submissions are kept', t.includes('重新修改選片') && t.includes('送出紀錄會保留'), t);
    ok('not delivered here: the text does not talk about 精修成品', !t.includes('精修成品'), t);
    ok('取消: no reopen request, the card stays', reopens(m).length === 0 && (await stageOf(page)) === before, `${reopens(m).length} ${await stageOf(page)}`);
    answer = 'accept';
    await page.click('#pd-more-btn');
    await page.click('#pd-reopen-btn');
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage === 'picking', null, { timeout: 4000 }).catch(() => {});
    ok('確定: exactly one reopen POST and the card is 客人選片中', reopens(m).length === 1 && (await stageOf(page)) === 'picking' && dialogs.length === 2, `${reopens(m).length} ${await stageOf(page)} ${dialogs.length}`);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['20261019 編輯專案/精修/'], confirmedAt: '2026-10-02T00:00:00.000Z' });
  await suite('小修 3 — 開放修改 on a delivered, confirmed project: the confirm says the finals come down and the confirmation is cleared', URL_E, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage, null, { timeout: 5000 });
    await waitReady(page);
    ok('floor: delivered and confirmed (已完成)', (await stageOf(page)) === 'done', await stageOf(page));
    const msgs = [];
    page.on('dialog', d => { msgs.push(d.message()); d.dismiss(); });
    await page.click('#pd-more-btn');
    await page.click('#pd-reopen-btn');
    await page.waitForTimeout(400);
    const t = msgs[0] || '';
    ok('one confirm; it says the 精修成品 no longer shows and the 確認 is cleared', msgs.length === 1 && t.includes('精修成品') && t.includes('確認'), t);
    ok('取消: nothing sent, still 已完成', reopens(m).length === 0 && (await stageOf(page)) === 'done');
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

{
  const m = fx({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['20261019 編輯專案/精修/'] });
  await suite('小修 3 — 開放修改 on a delivered but NOT confirmed project: the confirm mentions the finals, not a 確認 to clear', URL_E, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('pd-status')?.dataset.stage, null, { timeout: 5000 });
    await waitReady(page);
    ok('floor: delivered, not confirmed (客人確認中)', (await stageOf(page)) === 'awaiting', await stageOf(page));
    const msgs = [];
    page.on('dialog', d => { msgs.push(d.message()); d.dismiss(); });
    await page.click('#pd-more-btn');
    await page.click('#pd-reopen-btn');
    await page.waitForTimeout(400);
    const t = msgs[0] || '';
    ok('one confirm; it says the 精修成品 no longer shows and does not claim a 確認 is cleared', msgs.length === 1 && t.includes('精修成品') && !t.includes('客人的確認'), t);
    ok('取消: nothing sent', reopens(m).length === 0);
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

}
