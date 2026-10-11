// Browser suites: co-picking UI, (A) the preview pane and the enlarged modal say WHO hearted the shown photo
// (主人 Lia / 協作者 Mia / 先前的選片人), (B) on a phone the active collaborator's info is a compact chip in the
// header row of the studio name instead of its own banner row (js/co-picking-collab.js, css/co-picking-collab.css).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const FUTURE = ms => new Date(Date.now() + ms).toISOString();
const H = 3600000, D = 24 * H;
const XSS = '<img src=x onerror="window.__xss=1">';
const url = `${base}/index.html?t=TOK`;
const K0 = '20260819/p0.jpg', K1 = '20260819/p1.jpg', K2 = '20260819/p2.jpg';
const initKey = key => `${key ? `localStorage.setItem('pick_key:TOK', ${JSON.stringify(key)});` : ''}`;
const sel = (rating, by, note = '') => ({ rating, note, marks: null, updated_by: by, updated_at: '2026-01-01T00:00:00Z' });
const world = (o = {}) => {
  const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', ...o });
  m.state.pickers.set('old-1', { id: 'old-1', name: '舊人', key: 'OLD-KEY' });   // a picker who is neither owner nor collaborator
  return m;
};
const Mia = (o = {}) => ({ name: 'Mia', key: 'MIA-KEY', expires_at: FUTURE(7 * D), ...o });
const seed = m => {
  m.state.selections.set(K0, sel(1, 'picker-0'));
  m.state.selections.set(K1, sel(1, 'collab-1'));
  m.state.selections.set(K2, sel(1, 'old-1'));
};
const card = (page, key) => page.locator(`.photo-card[data-photo-id="${key}"]`);
const showInPreview = async (page, key) => {
  await card(page, key).hover({ position: { x: 30, y: 30 } });
  await page.waitForFunction(k => { const c = document.querySelector(`.photo-card[data-photo-id="${k}"]`); return c && c.classList.contains('current') || !!document.querySelector('#previewContent[style*="flex"]'); }, key, { timeout: 3000 });
  await page.waitForTimeout(250);
};
const txt = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e && !e.hidden && getComputedStyle(e).display !== 'none' ? e.textContent : null; }, sel);

// ── A1. preview pane: owner view, one line per hearted photo, role and name ──
for (const [who, opts, key] of [['the owner', {}, 'LIA-KEY'], ['a collaborator', { collaborators: [Mia()] }, 'MIA-KEY']]) {
  const m = world(opts);
  seed(m);
  m.state.pickers.get('collab-1') || m.state.pickers.set('collab-1', { id: 'collab-1', name: 'Mia', key: 'MIA-KEY' });
  if (!opts.collaborators) { m.state.collaborators.set('collab-1', { picker_id: 'collab-1', invited_by: 'picker-0', joined_at: new Date().toISOString(), expires_at: FUTURE(7 * D), revoked_at: null, last_seen_at: null, renewal_requested_at: null }); }
  await suite(`co-picking who-picked — preview pane says who hearted the shown photo (${who} view)`, url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await showInPreview(page, K0);
      ok('owner heart: 主人 Lia 選的', (await txt(page, '#previewPickedBy')) === '主人 Lia 選的', await txt(page, '#previewPickedBy'));
      await showInPreview(page, K1);
      ok('collaborator heart: 協作者 Mia 選的', (await txt(page, '#previewPickedBy')) === '協作者 Mia 選的', await txt(page, '#previewPickedBy'));
      ok('collaborator line is the blue of .pv-by-collaborator', (await page.evaluate(() => getComputedStyle(document.querySelector('#previewPickedBy')).color)) === 'rgb(90, 160, 230)');
      await showInPreview(page, K2);
      ok('older picker: 先前的選片人 選的, no name', (await txt(page, '#previewPickedBy')) === '先前的選片人 選的', await txt(page, '#previewPickedBy'));
      const one = await page.evaluate(() => { const e = document.querySelector('#previewPickedBy'); const s = getComputedStyle(e); return { ws: s.whiteSpace, ov: s.overflow, to: s.textOverflow, fs: parseFloat(s.fontSize) }; });
      ok('one line with ellipsis, small', one.ws === 'nowrap' && one.ov === 'hidden' && one.to === 'ellipsis' && one.fs <= 13, JSON.stringify(one));
      // the enlarged modal: next to the heart, follows the arrows
      await page.locator('#previewDetailBtn').click();
      await page.waitForSelector('#modalPhotoRating .pick-heart-btn', { timeout: 3000 });
      ok('modal: same line next to the heart', (await txt(page, '#modalPhotoRating .pick-by')) === '先前的選片人 選的', await txt(page, '#modalPhotoRating .pick-by'));
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const t1 = await txt(page, '#modalPhotoRating .pick-by');
      ok('modal: an arrow changes the line with the photo', t1 === '協作者 Mia 選的', t1);
      ok('the preview line follows too', (await txt(page, '#previewPickedBy')) === '協作者 Mia 選的', await txt(page, '#previewPickedBy'));
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      ok('modal: two arrows back -> 主人 Lia 選的', (await txt(page, '#modalPhotoRating .pick-by')) === '主人 Lia 選的', await txt(page, '#modalPhotoRating .pick-by'));
      return out;
    },
    { before: m.attach, initScript: initKey(key) });
}

// ── A2. no heart -> no line; a state reload changes the line; own heart is attributed at once; a viewer never sees one ──
{
  const m = world({ collaborators: [Mia()] });
  m.state.selections.set(K0, sel(1, 'collab-1'));
  await suite('co-picking who-picked — nothing without a heart; a reload of the state moves the line; my own heart is attributed at once', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await showInPreview(page, K1);
      ok('a photo with no heart: no line', (await txt(page, '#previewPickedBy')) === null);
      await showInPreview(page, K0);
      ok('hearted by Mia: line shown', (await txt(page, '#previewPickedBy')) === '協作者 Mia 選的');
      // the owner (this page) edits the row on the server side, then the state is re-read
      m.state.selections.set(K0, sel(1, 'picker-0'));
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(200);
      ok('after the reload the line says 主人 Lia', (await txt(page, '#previewPickedBy')) === '主人 Lia 選的', await txt(page, '#previewPickedBy'));
      m.state.selections.delete(K0);
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(200);
      ok('heart gone on the server: line gone', (await txt(page, '#previewPickedBy')) === null);
      // the enlarged modal is open while the state is re-read
      m.state.selections.set(K0, sel(1, 'collab-1'));
      await page.evaluate(() => PickController.reloadState());
      await showInPreview(page, K0);
      await page.locator('#previewDetailBtn').click();
      await page.waitForSelector('#modalPhotoRating .pick-by', { timeout: 3000 });
      ok('modal open: shows 協作者 Mia', (await txt(page, '#modalPhotoRating .pick-by')) === '協作者 Mia 選的', await txt(page, '#modalPhotoRating .pick-by'));
      m.state.selections.set(K0, sel(1, 'picker-0'));
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(250);
      ok('modal open, state re-read: the line moves to 主人 Lia', (await txt(page, '#modalPhotoRating .pick-by')) === '主人 Lia 選的', await txt(page, '#modalPhotoRating .pick-by'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      m.state.selections.delete(K0);
      await page.evaluate(() => PickController.reloadState());
      await page.waitForTimeout(200);
      // my own heart
      await showInPreview(page, K1);
      await page.locator('#previewStars .pick-heart-btn').click();
      await page.waitForTimeout(150);
      ok('hearting it myself: 主人 Lia 選的 at once', (await txt(page, '#previewPickedBy')) === '主人 Lia 選的', await txt(page, '#previewPickedBy'));
      await page.locator('#previewStars .pick-heart-btn').click();
      await page.waitForTimeout(150);
      ok('un-hearting removes the line', (await txt(page, '#previewPickedBy')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}
{
  const m = world({ collaborators: [Mia()] });
  seed(m);
  await suite('co-picking who-picked — a viewer (no key) never sees who picked', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await showInPreview(page, K0);
      ok('the preview pane is up', await page.evaluate(() => getComputedStyle(document.getElementById('previewContent')).display !== 'none'));
      ok('no who-picked line', (await txt(page, '#previewPickedBy')) === null);
      await page.locator('#previewDetailBtn').click();
      await page.waitForTimeout(300);
      ok('none in the modal either', (await page.$('.pick-by')) === null || (await txt(page, '.pick-by')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('') });
}

// ── A3. names are text ──
{
  const m = world({ collaborators: [Mia({ name: XSS })] });
  m.state.selections.set(K0, sel(1, 'collab-1'));
  await suite('co-picking who-picked — a collaborator named <img onerror> stays text in the preview and the modal', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await showInPreview(page, K0);
      ok('the preview line holds the literal text', (await txt(page, '#previewPickedBy')) === `協作者 ${XSS} 選的`, await txt(page, '#previewPickedBy'));
      await page.locator('#previewDetailBtn').click();
      await page.waitForTimeout(300);
      ok('and so does the modal', (await txt(page, '#modalPhotoRating .pick-by')) === `協作者 ${XSS} 選的`);
      ok('nothing ran, no element came out of the name', (await page.evaluate(() => window.__xss)) === undefined && (await page.$('.pick-by img')) === null && (await page.$('img[src="x"]')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('LIA-KEY') });
}

// ── B. phone: the active collaborator's info is a chip in the studio-name row, not its own row ──
const firstCardTop = page => page.evaluate(() => document.querySelector('.photo-card').getBoundingClientRect().top);
const PHONE = { contextOptions: MOBILE };
for (const [label, expires, re] of [['with an end', FUTURE(7 * D), /^協作者 · 到期 \d+\/\d+$/], ['no end', null, /^協作者 · 到期不限$/]]) {
  const m = world({ collaborators: [Mia({ expires_at: expires })] });
  await suite(`co-picking compact (390px) — active collaborator ${label}: chip in the studio-name row, no banner row`, url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#coCollabChip', { timeout: 3000 });
      const chipText = await txt(page, '#coCollabChip');
      ok('the chip says 協作者 · 到期 …', re.test((chipText || '').trim()), chipText);
      const g = await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height, cy: (b.top + b.bottom) / 2 }; };
        const banner = document.getElementById('coCollabBanner');
        return { chip: r('#coCollabChip'), name: r('.logo-name'), header: r('.header'), banner: banner ? getComputedStyle(banner).display : 'absent',
          vw: innerWidth, sw: document.documentElement.scrollWidth, card: document.querySelector('.photo-card').getBoundingClientRect().top,
          title: document.getElementById('coCollabChip').title };
      });
      ok('chip and studio name are in the same header row (centres within 4px)', g.chip && g.name && Math.abs(g.chip.cy - g.name.cy) <= 4 && g.chip.b <= g.header.b + 1 && g.chip.t >= g.header.t - 1, JSON.stringify(g));
      ok('the chip sits to the right of the name, inside the screen', g.chip.l >= g.name.r - 1 && g.chip.r <= g.vw, JSON.stringify(g));
      ok('no separate banner row', g.banner === 'absent' || g.banner === 'none', g.banner);
      ok('the full sentence is still the chip title (screen reader / long press)', /^你是協作者，到期 /.test(g.title), g.title);
      ok('no horizontal scroll at 390px', g.sw <= g.vw, `${g.sw} vs ${g.vw}`);
      out.push(`info  first .photo-card top = ${Math.round(g.card)}px`);
      return out;
    },
    { before: m.attach, initScript: initKey('MIA-KEY'), ...PHONE });
}
{
  const m = world({ collaborators: [Mia({ name: '很長很長很長很長很長的協作者名字', expires_at: FUTURE(7 * D) })] });
  await suite('co-picking compact (390px) — a long studio name and the chip share the row; neither overflows the screen', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabChip', { timeout: 5000 });
      await page.evaluate(() => { document.querySelector('.logo-name').textContent = '一個非常非常非常非常非常長的攝影工作室名稱'; });
      const g = await page.evaluate(() => {
        const c = document.getElementById('coCollabChip').getBoundingClientRect(), n = document.querySelector('.logo-name').getBoundingClientRect();
        return { cr: c.right, nr: n.right, cl: c.left, vw: innerWidth, sw: document.documentElement.scrollWidth, cw: c.width, ccy: (c.top + c.bottom) / 2, ncy: (n.top + n.bottom) / 2 };
      });
      ok('chip stays on screen and on the name row', g.cr <= g.vw && Math.abs(g.ccy - g.ncy) <= 4 && g.sw <= g.vw, JSON.stringify(g));
      ok('the chip keeps a usable width (>= 70px)', g.cw >= 70, JSON.stringify(g));
      return out;
    },
    { before: m.attach, initScript: initKey('MIA-KEY'), ...PHONE });
}
for (const [label, opts, mode, wantText] of [
  ['expired', { collaborators: [Mia({ expires_at: FUTURE(-H) })] }, 'expired', /我要繼續/],
  ['removed', { collaborators: [Mia({ revoked_at: FUTURE(-H) })] }, 'removed', /目前只能瀏覽/],
]) {
  const m = world(opts);
  await suite(`co-picking compact (390px) — ${label}: the actionable banner stays, there is no chip`, url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector(`#coCollabBanner[data-mode="${mode}"]`, { timeout: 5000 });
      const t = await txt(page, '#coCollabBanner');
      ok('the banner is visible with its text', t && wantText.test(t), t);
      ok('no chip in the header', (await txt(page, '#coCollabChip')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('MIA-KEY'), ...PHONE });
}
{
  const m = world();
  await suite('co-picking compact (390px) — a viewer still gets the 我有邀請碼 banner row, no chip', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coJoinOpen', { timeout: 5000 });
      ok('join banner visible', (await txt(page, '#coCollabBanner')) !== null);
      ok('no chip', (await txt(page, '#coCollabChip')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey(''), ...PHONE });
}
{
  const m = world({ collaborators: [Mia()] });
  await suite('co-picking compact (1500px desktop) — the collaborator banner is unchanged and the chip is not shown', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabBanner', { timeout: 5000 });
      const t = await txt(page, '#coCollabBanner');
      ok('desktop still has the banner row', /^你是協作者，到期 \d+\/\d+ \d\d:\d\d/.test((t || '').trim()), t);
      ok('the chip is not displayed on desktop', (await txt(page, '#coCollabChip')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('MIA-KEY') });
}
{
  // the chip follows the state: turning into expired (a state re-read) swaps chip for banner without a reload
  const m = world({ collaborators: [Mia({ expires_at: FUTURE(7 * D) })] });
  await suite('co-picking compact (390px) — when the period ends the chip goes and the 我要繼續 banner appears', url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coCollabChip', { timeout: 5000 });
      m.state.collaborators.get('collab-1').expires_at = FUTURE(-H);
      await page.evaluate(() => PickController.reloadState());
      await page.waitForSelector('#coRenewBtn', { timeout: 3000 });
      ok('the renew button is visible', (await txt(page, '#coRenewBtn')) !== null);
      ok('the chip is gone', (await txt(page, '#coCollabChip')) === null);
      return out;
    },
    { before: m.attach, initScript: initKey('MIA-KEY'), ...PHONE });
}
}
