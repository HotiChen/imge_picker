// Browser suites: guest download buttons, delivered finals gallery (old card layout), legacy
// delivered stamp.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, swipeTouch } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { DL, listed } from '../lib/delivery-helpers.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// ─── guest link ──────────────────────────────────────────────────────────────

const GUEST_FILES = [
  'shoot/毛片/a.jpg', 'shoot/毛片/b.jpg',
  'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg',
];
const guestCards = page => page.$$eval('.photo-card', cs => cs.map(c => c.dataset.photoId));

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES });
  await suite('guest picking, switch OFF — no download button anywhere (absent from the DOM, not merely hidden)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive: the proofs and the ♥ are there', (await guestCards(page)).length === 2 && !!(await page.$('.pick-heart-btn')));
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const gone = await page.evaluate(() => ({
        modalBtn: document.getElementById('modalDownloadBtn'),
        previewBtn: document.getElementById('previewDownloadBtn'),
        anyDl: document.querySelectorAll('[data-download], [download], a[href*="download=1"]').length,
        zip: ['downloadAllBtn', 'downloadSelectedHeaderBtn', 'bulkActionBar'].filter(id => document.getElementById(id)),
      }));
      ok('#modalDownloadBtn is not in the DOM', gone.modalBtn === null);
      ok('#previewDownloadBtn is not in the DOM', gone.previewBtn === null);
      ok('no download link or attribute exists at all', gone.anyDl === 0, String(gone.anyDl));
      ok('the zip downloads (which would fetch originals) are gone too', gone.zip.length === 0, JSON.stringify(gone.zip));
      ok('no delivery bar', (await page.$eval('#deliveryBar', e => e.hidden)) === true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest picking, switch ON — 下載原檔 in the preview with ?download=1&t=; a refusal says 原檔未開放下載',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the grid still has ♥ (picking as before)', !!(await page.$('.pick-heart-btn')));
      ok('grid cards carry no download link while picking', (await page.$('.photo-card [data-download]')) === null);
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const modal = await page.$eval('#modalDownloadBtn', e => ({ href: decodeURI(e.href), text: e.textContent, disp: getComputedStyle(e).display }));
      ok('the modal has the button, visible, labelled 下載原檔',
        modal.text === '下載原檔' && modal.disp !== 'none', JSON.stringify(modal));
      ok('with the exact download URL', modal.href === DL('shoot/毛片/a.jpg'), modal.href);
      const pv = await page.$eval('#previewDownloadBtn', e => ({ href: decodeURI(e.href), disp: getComputedStyle(e).display, text: e.textContent }));
      ok('the preview pane has it too', pv.href === DL('shoot/毛片/a.jpg') && pv.disp !== 'none' && pv.text === '下載原檔', JSON.stringify(pv));

      await page.click('#nextPhotoBtn');
      await page.waitForFunction(() => document.getElementById('modalDownloadBtn').href.endsWith('b.jpg?download=1&t=TOK'), null, { timeout: 3000 });
      ok('the link follows the photo when navigating', true);
      await page.click('#prevPhotoBtn');
      await page.waitForFunction(() => document.getElementById('modalDownloadBtn').href.includes('a.jpg'), null, { timeout: 3000 });

      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#modalDownloadBtn')]);
      ok('clicking saves the file under the Worker’s Content-Disposition name', dl.suggestedFilename() === 'a.jpg', dl.suggestedFilename());
      ok('a one-byte Range probe went first, then the real download request',
        m.requests.some(r => r.path.endsWith('a.jpg') && r.range === 'bytes=0-0') &&
        m.requests.filter(r => r.path.endsWith('a.jpg') && r.search.includes('download=1') && !r.range).length >= 1);

      // the photographer turns the switch off while this page is open
      m.state.project.allow_proof_download = false;
      let saved = false;
      page.once('download', () => { saved = true; });
      await page.click('#modalDownloadBtn');
      await page.waitForSelector('.toast.error .toast-message', { timeout: 3000 });
      ok('a 403 original_not_allowed shows 原檔未開放下載', (await page.textContent('.toast.error .toast-message')) === '原檔未開放下載');
      await page.waitForTimeout(300);
      ok('and nothing was downloaded or navigated to', !saved && page.url().startsWith(`${base}/index.html`));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest viewer, switch ON — a viewer gets the same download button in the preview',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const href = await page.$eval('#modalDownloadBtn', e => decodeURI(e.href));
      return [href === DL('shoot/毛片/a.jpg') ? 'ok    viewer sees the button with the right URL' : `FAIL  ${href}`];
    },
    { before: m.attach });
}

// delivered gallery — owner, viewer with a taken seat, viewer with a free seat
for (const who of [
  { label: 'the owner', o: { ownerName: 'Zoe', ownerKey: 'ZOE-KEY' }, init: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') },
  { label: 'a viewer (seat taken)', o: { ownerName: 'Zoe', ownerKey: 'ZOE-KEY' }, init: null },
  { label: 'a viewer (seat never claimed)', o: {}, init: null },
]) {
  const m = pickFakeWorker({ ...who.o, phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES });
  // REWRITTEN with the finals gallery: cards -> justified tiles (.fg-tile), the per-card 下載 link and the
  // old preview modal (zoom included) -> the lightbox, the folder panel -> chips. What is kept as it was:
  // finals only, nothing of the proofs read, no picking UI at all, the download URL and its saved file name.
  await suite(`guest delivered — ${who.label} sees the 精修成品 gallery: finals only, no picking UI, 下載 in the lightbox`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      const tiles = await page.$$eval('.fg-tile', ts => ts.map(c => c.dataset.photoId));
      ok('the finals are listed (f1, f2)', JSON.stringify(tiles) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]', JSON.stringify(tiles));
      ok('no old card and no photo preview modal is open', (await page.$('.photo-card')) === null && (await page.$('#photoModal.active')) === null);
      ok('the claim overlay never appears, even with a free seat', (await page.$eval('#pickClaimOverlay', e => e.hidden)) === true);
      ok('the title says 精修成品', (await page.textContent('#deliveryTitle')).startsWith('精修成品') &&
        (await page.$eval('#deliveryBar', e => e.hidden)) === false);
      ok('only the finals folder was listed; the proofs never were', listed(m).length > 0 && listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      const imgs = await page.$$eval('.fg-tile img', is => is.map(i => i.src));
      ok('tile thumbnails are ?w=400 through the token', imgs.length === 2 && imgs.every(s => s.includes('?w=400') && s.includes('t=TOK') && s.includes('%E7%B2%BE%E4%BF%AE')), JSON.stringify(imgs));
      ok('the cover is a bucket, never the original', /\?w=(400|1200|1600)&t=TOK$/.test(await page.$eval('#fgCover', i => i.src)));
      ok('no request touched a proof photo', !m.requests.some(r => decodeURIComponent(r.path).includes('毛片')));
      ok('no ♥, no submit, no counter, no filter bar, no picking banner',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null &&
        (await page.$('#pickSubmitBtn')) === null &&
        (await page.$('#pickCounter')) === null && (await page.$('#pickBanner')) === null &&
        (await page.$('#pickFilterBar')) === null && (await page.$('.guest-bar #pickFilterBar')) === null);
      ok('delivered: no pick counter of any kind (bar removed, no 已選 N text visible, no pick-active body class)',
        (await page.$('#mobileActionBar')) === null &&
        !(await page.evaluate(() => /已選\s*\d/.test(document.body.innerText) || document.body.classList.contains('pick-active'))));
      ok('no over-limit modal element is open', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('no way to reach the proofs: no 下載毛片原檔 entry while the switch is off', (await page.$('#deliveryProofsBtn')) === null);
      ok('no download link sits on a tile (and no card has one): the original is one press away, in the lightbox', (await page.$('.fg-tile [data-download], .fg-tile a')) === null && (await page.$('.photo-card [data-download]')) === null);
      const chips = await page.$$eval('#fgChips .fg-chip', cs => cs.map(c => c.dataset.folder));
      ok('the subfolder is a chip next to the finals folder', JSON.stringify(chips) === '["shoot/精修/","shoot/精修/sub/"]', JSON.stringify(chips));

      await page.click('.fg-tile');
      await page.waitForSelector('#fgLightbox', { timeout: 5000 });
      ok('the lightbox has no ♥ / note box / pin tools', (await page.$('#fgLightbox .pick-heart-btn')) === null && (await page.$('#fgLightbox #noteInputGroup')) === null && (await page.$('#pickModalTools')) === null);
      ok('the lightbox 下載 has the photo’s URL and the label 下載',
        (await page.$eval('#fgLbDownload', e => decodeURI(e.href))) === DL('shoot/精修/f1.jpg') && (await page.textContent('#fgLbDownload')) === '下載');
      ok('the lightbox image is the ?w= bucket, not the original', /\?w=\d+/.test(await page.$eval('#fgLbImg', i => i.src)));
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.getElementById('fgLbCount').textContent === '2 / 2', null, { timeout: 3000 });
      ok('next photo works and the download link follows', (await page.$eval('#fgLbDownload', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#fgLbDownload')]);
      ok('downloading a final saves f2.jpg', dl.suggestedFilename() === 'f2.jpg', dl.suggestedFilename());
      await page.keyboard.press('Escape');

      // a subfolder opens like a proof subfolder does
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/sub/"]');
      await page.waitForFunction(() => document.querySelector('.fg-tile')?.dataset.photoId.includes('sub/'), null, { timeout: 5000 });
      await page.click('#fgChips .fg-chip[data-folder="shoot/精修/"]');
      await page.waitForFunction(() => document.querySelectorAll('.fg-tile').length === 2, null, { timeout: 5000 });
      ok('the finals folder chip comes back to the finals gallery (2 photos)', true);
      ok('and no picking write was ever sent', !m.requests.some(r => r.path === '/api/pick/selections'));
      return out;
    },
    { before: m.attach, initScript: who.init || undefined });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest delivered + switch ON — a secondary 下載毛片原檔 lists the proofs, download-only; 回精修成品 comes back',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // REWRITTEN: the finals are the gallery now (.fg-tile); the proofs list below is still the old cards
      const finals = () => page.$$eval('.fg-tile', ts => ts.map(c => c.dataset.photoId));
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      ok('the gallery still opens on the finals', (await finals()).length === 2 && (await finals()).every(k => k.startsWith('shoot/精修/')));
      ok('the proofs were not listed yet', listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      ok('the entry is 下載毛片原檔', (await page.textContent('#deliveryProofsBtn')) === '下載毛片原檔' && !(await page.$eval('#deliveryProofsBtn', e => e.hidden)));
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
      ok('the proofs are listed (a, b)', JSON.stringify(await guestCards(page)) === '["shoot/毛片/a.jpg","shoot/毛片/b.jpg"]', JSON.stringify(await guestCards(page)));
      ok('the proof folder was listed now', listed(m).includes('shoot/毛片/'));
      ok('download-only: no ♥, no submit, no note box',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null &&
        (await page.$('#pickSubmitBtn')) === null && (await page.$('#pickFilterBar')) === null);
      ok('each proof has a 下載原檔 link',
        JSON.stringify(await page.$$eval('.photo-card [data-download]', as => as.map(a => [decodeURI(a.href), a.textContent]))) ===
        JSON.stringify([[DL('shoot/毛片/a.jpg'), '下載原檔'], [DL('shoot/毛片/b.jpg'), '下載原檔']]));
      ok('the title says it is the proofs', /毛片原檔/.test(await page.textContent('#deliveryTitle')));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.photo-card [data-download]')]);
      ok('downloading a proof original works (switch on)', dl.suggestedFilename() === 'a.jpg');
      ok('the card click did not also open the preview', (await page.$('#photoModal.active')) === null);
      ok('the button now leads back', (await page.textContent('#deliveryProofsBtn')) === '← 回精修成品');
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.fg-tile')?.dataset.photoId.includes('精修'), null, { timeout: 5000 });
      ok('back on the finals (the gallery, no cards)', JSON.stringify(await finals()) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]' && (await page.$('.photo-card')) === null);
      ok('and the chips follow the view: finals folders only', (await page.$$eval('#fgChips .fg-chip', cs => cs.every(c => c.dataset.folder.includes('精修')))));

      // switch turned off while open: the proof download is refused politely
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
      m.state.project.allow_proof_download = false;
      let saved = false;
      page.once('download', () => { saved = true; });
      await page.click('.photo-card [data-download]');
      await page.waitForSelector('.toast.error .toast-message', { timeout: 3000 });
      ok('a refused proof download says 原檔未開放下載', (await page.textContent('.toast.error .toast-message')) === '原檔未開放下載');
      await page.waitForTimeout(200);
      ok('and saved nothing', !saved);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES, allowProofDownload: true });
  // REWRITTEN: the finals are the gallery; its download lives in the lightbox (swipe replaces the old preview
  // swipe). The proofs list still has per-card 下載原檔 links, so the 44px check on those is kept too.
  await suite('guest delivered gallery on a phone — no sideways scroll, 44px download targets, everything inside 390px',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      const geo = await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right }; };
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, proofs: r('#deliveryProofsBtn'), bar: r('#deliveryBar'), share: r('#fgShare') };
      });
      ok('the page does not scroll sideways', geo.sw <= geo.iw, JSON.stringify(geo));
      ok('下載毛片原檔 is >= 44 tall and inside the phone', !!geo.proofs && geo.proofs.h >= 44 && geo.proofs.r <= geo.iw + 1, JSON.stringify(geo.proofs));
      await page.click('.fg-tile');
      await page.waitForSelector('#fgLightbox', { timeout: 5000 });
      const lb = await page.evaluate(() => {
        const e = document.getElementById('fgLbDownload');
        const b = e.getBoundingClientRect();
        return { h: b.height, l: b.left, r: b.right, vis: getComputedStyle(e).display !== 'none', iw: innerWidth };
      });
      ok('the lightbox 下載 is visible, >= 44 tall and inside the phone', lb.vis && lb.h >= 44 && lb.r <= lb.iw + 1 && lb.l >= 0, JSON.stringify(lb));
      const before = await page.textContent('#fgLbCount');
      await swipeTouch(page, '#fgLbStage', 300, 400, 60, 410);
      await page.waitForFunction(b => document.getElementById('fgLbCount').textContent !== b, before, { timeout: 3000 });
      ok('swiping moves to the next final and the link follows', (await page.$eval('#fgLbDownload', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      ok('still no sideways scroll with the lightbox open', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.click('#fgLbClose');
      await page.click('#deliveryProofsBtn');
      await page.waitForSelector('.photo-card [data-download]', { timeout: 5000 });
      const card = await page.evaluate(() => { const b = document.querySelector('.photo-card [data-download]').getBoundingClientRect(); return { h: b.height, l: b.left, r: b.right, iw: innerWidth }; });
      ok('the proofs list: the card 下載原檔 is >= 44 tall and inside the phone', card.h >= 44 && card.r <= card.iw + 1 && card.l >= 0, JSON.stringify(card));
      ok('...and the proofs list does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'],
    deliveredAt: '2026-09-01T00:00:00.000Z', pickFiles: GUEST_FILES });
  await suite('guest — a legacy delivered stamp without finals stays the (read-only) picking view, no gallery',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the proofs are shown with the read-only ♥', (await guestCards(page)).every(k => k.includes('毛片')) && !!(await page.$('.pick-heart-btn')));
      ok('no delivery bar, no download link', (await page.$eval('#deliveryBar', e => e.hidden)) === true && (await page.$('[data-download]')) === null);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ projectId: 'proj-not-ready', title: '選片中專案' });
  await suite('admin — 選片中／已送出的專案不顯示交件按鈕；直接呼叫 API 會拿到 409 not_retouching 並顯示友善訊息',
    `${base}/admin.html#project=proj-not-ready`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });
      ok('no 標記已交件 button while still picking',
        (await page.$('#pd-deliver-btn')) === null && (await page.$('#pd-undeliver-btn')) === null);

      // The friendly 409 message is exercised directly against the endpoint —
      // the button itself is gated off in this phase, by design.
      const res = await page.evaluate(async id => {
        const r = await fetch(`https://imagepicker.hotichen.workers.dev/api/admin/projects/${id}/deliver`,
          { method: 'POST', headers: { 'Authorization': 'Bearer adm' } });
        return { status: r.status, body: await r.json() };
      }, m.state.project.id);
      ok('409 not_retouching from the fake, mirroring the real Worker',
        res.status === 409 && res.body.code === 'not_retouching', JSON.stringify(res));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
