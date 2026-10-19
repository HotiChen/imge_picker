// Browser suite: 看 on one finals version shows THAT version (Tim's bug: every 精修 row's 看 showed the delivered one).
// The review view (index.html?project=<id>&mode=finals&folder=<folder>) takes a folder only when it is one of the
// project's own finals candidates (the chosen finals snapshot, or a folder beside the proof folders); anything else
// falls back to the default 精修 tab and is never listed. A note under the banner says whether the version on screen
// is the one the client sees now. The project page's 看 links carry each row's own folder.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const ADMIN_SRC = `(${ADMIN.toString()})();`;
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const V1 = ['shoot/精修/a1.jpg'];
const V2 = ['shoot/精修二/b1.jpg', 'shoot/精修二/b2.jpg'];
const V3 = ['shoot/精修三/c1.jpg', 'shoot/精修三/c2.jpg', 'shoot/精修三/c3.jpg'];
const PROOFS = ['shoot/毛片/p1.jpg', 'shoot/毛片/p2.jpg', 'shoot/毛片/p3.jpg', 'shoot/毛片/p4.jpg'];
const FOREIGN = ['other/secret1.jpg', 'other/secret2.jpg', 'other/secret3.jpg', 'other/secret4.jpg', 'other/secret5.jpg'];
const FILES = [...PROOFS, ...V1, ...V2, ...V3, ...FOREIGN];
const DELIVERED_V3 = { phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修三/'] };
const world = (o = {}) => pickFakeWorker({ projectId: 'proj-v', ownerName: 'Vera', folders: ['shoot/毛片/'], pickFiles: FILES, ...o });
const view = folder => `${base}/index.html?project=proj-v&mode=finals${folder === undefined ? '' : `&folder=${encodeURIComponent(folder)}`}`;
const ids = page => page.evaluate(() => [...document.querySelectorAll('.photo-card')].map(c => c.dataset.photoId).sort());
const waitCards = (page, n) => page.waitForFunction(k => document.querySelectorAll('.photo-card').length === k, n, { timeout: 5000 });
const note = page => page.evaluate(() => {
  const e = document.getElementById('pvVersionNote');
  if (!e) return null;
  const cs = getComputedStyle(e);
  return { text: e.textContent.trim(), state: e.dataset.state, shown: !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0,
    tags: e.querySelectorAll('*').length };
});
const listed = m => m.requests.filter(r => r.search.includes('list=')).map(r => new URL('http://x/' + r.search).searchParams.get('list'));
const writes = m => m.requests.filter(r => r.method !== 'GET' && r.path !== '/api/auth/studio-token');

{
  const m = world(DELIVERED_V3);
  await suite('99c version view — 看 精修 while 精修三 is delivered: exactly 精修\'s photo, and a visible note 這是 精修（舊版），客人現在看的是 精修三', view('shoot/精修/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 1);
    ok('the grid is 精修\'s one photo, not 精修三\'s', JSON.stringify(await ids(page)) === JSON.stringify(V1), JSON.stringify(await ids(page)));
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('the note names both versions', n && n.text === '這是 精修（舊版），客人現在看的是 精修三', JSON.stringify(n));
    ok('the note is visible and marked old', n && n.shown && n.state === 'old', JSON.stringify(n));
    ok('the banner count is of this version', /精修 · 1 張/.test(await page.$eval('#pvBannerText', e => e.textContent)), await page.$eval('#pvBannerText', e => e.textContent));
    ok('never listed 精修三 or anything outside the project', !listed(m).some(p => p.startsWith('shoot/精修三') || p.startsWith('other')), JSON.stringify(listed(m)));
    ok('nothing written', writes(m).length === 0, JSON.stringify(writes(m).map(r => r.method + r.path)));
    ok('the address keeps mode=finals and the folder', await page.evaluate(() => { const q = new URL(location.href).searchParams; return q.get('mode') === 'finals' && q.get('folder') === 'shoot/精修/'; }));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const m = world(DELIVERED_V3);
  await suite('99c version view — 看 the delivered 精修三: its 3 photos, the note says 客人目前看的版本', view('shoot/精修三/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 3);
    ok('the grid is 精修三', JSON.stringify(await ids(page)) === JSON.stringify(V3), JSON.stringify(await ids(page)));
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('note: 客人目前看的版本, visible, marked current', n && n.text === '客人目前看的版本' && n.shown && n.state === 'current', JSON.stringify(n));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const m = world({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修/'] });
  await suite('99c version view — 看 精修二 while 精修 is delivered (a round\'s new version, not handed over yet): 新版 wording, not 舊版', view('shoot/精修二/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 2);
    ok('the grid is 精修二', JSON.stringify(await ids(page)) === JSON.stringify(V2), JSON.stringify(await ids(page)));
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('note: 這是 精修二（新版，還沒交給客人），客人現在看的是 精修', n && n.text === '這是 精修二（新版，還沒交給客人），客人現在看的是 精修' && n.shown && n.state === 'newer', JSON.stringify(n));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const m = world({ phase: 'retouching' });
  await suite('99c version view — nothing delivered yet: 看 精修二 lists it, note 這一版尚未交給客人', view('shoot/精修二/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 2);
    ok('the grid is 精修二', JSON.stringify(await ids(page)) === JSON.stringify(V2), JSON.stringify(await ids(page)));
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('note: 這一版尚未交給客人, visible', n && n.text === '這一版尚未交給客人' && n.shown && n.state === 'undelivered', JSON.stringify(n));
    ok('no chooser (the folder was named)', await page.evaluate(() => !document.getElementById('pvFinalPick')));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  // 取消交件 keeps final_folders: the snapshot is not the delivered flag (CLAUDE.md invariants)
  const m = world({ phase: 'retouching', deliveredAt: null, finalFolders: ['shoot/精修三/'] });
  await suite('99c version view — after 取消交件 (final_folders kept, delivered_at cleared): 精修三 is NOT what the client sees', view('shoot/精修三/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 3);
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('note: 這一版尚未交給客人 (not 客人目前看的版本)', n && n.text === '這一版尚未交給客人' && n.state === 'undelivered', JSON.stringify(n));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

for (const [label, bad] of [['a folder outside the project', 'other/'], ['the proof folder', 'shoot/毛片/'], ['the project root (would list every version)', 'shoot/'], ['a path climbing out', 'shoot/精修/../../other/'], ['a near-miss name', 'shoot/精修三x/']]) {
  // a photo right under the root: on screen only if the root itself were taken as the version
  const m = world({ ...DELIVERED_V3, pickFiles: [...FILES, 'shoot/root.jpg'] });
  await suite(`99c version view — folder= ${label} is refused: the default 精修 tab (the delivered 精修三), it is never listed, no note`, view(bad), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 3);
    await page.waitForTimeout(150);
    ok('the grid is the delivered 精修三 (today\'s behaviour)', JSON.stringify(await ids(page)) === JSON.stringify(V3), JSON.stringify(await ids(page)));
    // the root shoot/ is listed once by the candidate lookup itself (the folders beside the proofs); never more,
    // and nothing under a refused folder is walked (no proof folder, nothing outside the project)
    const l = listed(m);
    ok(`the refused folder ${bad} was never listed as the version`, (bad === 'shoot/' ? l.filter(p => p === bad).length === 1 : !l.includes(bad))
      && !l.some(p => p.startsWith('other') || p.startsWith('shoot/毛片')), JSON.stringify(l));
    ok('control: the delivered folder was listed', listed(m).includes('shoot/精修三/'), JSON.stringify(listed(m)));
    ok('no version note', (await note(page)) === null, JSON.stringify(await note(page)));
    ok('the refused folder is dropped from the address', await page.evaluate(() => !new URL(location.href).searchParams.has('folder')));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const odd = 'shoot/<img src=x onerror="window.__pwned=1">/';
  const m = world({ phase: 'retouching', deliveredAt: '2026-10-01T00:00:00.000Z', finalFolders: ['shoot/精修/'], pickFiles: [...FILES, odd + 'z1.jpg'] });
  await suite('99c version view — a folder name with markup is shown as text only', view(odd), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 1);
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    const n = await note(page);
    ok('the name is literal text in the note', n && n.text.includes('<img src=x onerror="window.__pwned=1">') && n.text.includes('客人現在看的是 精修'), JSON.stringify(n));
    ok('no element was made from it', n && n.tags === 0 && (await page.evaluate(() => !window.__pwned)), JSON.stringify(n));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const m = world(DELIVERED_V3);
  await suite('99c version view — leaving the 精修 tab hides the note; coming back shows the same version again', view('shoot/精修/'), async page => {
    const out = [], ok = okFn(out);
    await waitCards(page, 1);
    await page.waitForSelector('#pvVersionNote', { timeout: 3000 });
    await page.click('[data-pv-mode="all"]');
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 4, null, { timeout: 5000 });
    ok('on 全部毛片 there is no version note', (await note(page)) === null, JSON.stringify(await note(page)));
    ok('and the address has no folder', await page.evaluate(() => !new URL(location.href).searchParams.has('folder')));
    await page.click('[data-pv-mode="finals"]');
    await waitCards(page, 1);
    ok('back on 精修: still 精修\'s photo', JSON.stringify(await ids(page)) === JSON.stringify(V1), JSON.stringify(await ids(page)));
    const n = await note(page);
    ok('and the note is back', n && n.state === 'old' && n.shown, JSON.stringify(n));
    return out;
  }, { before: m.attach, initScript: ADMIN_SRC });
}

{
  const m = world({ ...DELIVERED_V3, revisions: [] });
  await suite('99c project page — every 精修 row\'s 看 carries its own folder', `${base}/admin.html#project=proj-v`, async page => {
    const out = [], ok = okFn(out);
    await page.waitForSelector('#pd-photos[data-target="ready"]', { state: 'attached', timeout: 5000 });
    const r = await page.evaluate(() => [...document.querySelectorAll('#pd-photos [data-version]')].map(x => ({ v: x.dataset.version, href: x.querySelector('[data-view]')?.getAttribute('href') || null })));
    const fin = r.filter(x => x.v !== 'proofs');
    ok('floor: three finals rows', JSON.stringify(fin.map(x => x.v)) === JSON.stringify(['shoot/精修/', 'shoot/精修二/', 'shoot/精修三/']), JSON.stringify(r));
    ok('each 看 names project, mode=finals and that row\'s folder', fin.every(x => { const q = new URL(x.href, base).searchParams; return q.get('project') === 'proj-v' && q.get('mode') === 'finals' && q.get('folder') === x.v; }), JSON.stringify(fin));
    ok('the 毛片 row\'s 看 has no folder', (() => { const p = r.find(x => x.v === 'proofs'); return p && !new URL(p.href, base).searchParams.has('folder'); })(), JSON.stringify(r));
    return out;
  }, { before: m.attach, initScript: ADMIN });
}

}
