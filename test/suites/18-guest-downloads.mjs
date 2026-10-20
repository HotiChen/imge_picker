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
      // a proof original is the owner's: one keyed fetch that saves the bytes (no one-byte probe + plain link, which could not carry the key)
      ok('one real download request, no one-byte Range probe (the owner\'s key travels in a header: a fetch)',
        !m.requests.some(r => r.path.endsWith('a.jpg') && r.range === 'bytes=0-0') &&
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
  await suite('guest viewer, switch ON — a viewer gets NO proof download button (proof originals are the owner\'s)',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      // positive controls first: the viewer's page is really up (2 proofs, the modal open), then the three download
      // entries are absent from the DOM (pick.js removes them for a link that may not download), none shown
      const s = await page.evaluate(() => ({ cards: document.querySelectorAll('.photo-card').length, modal: !!document.querySelector('#photoModal.active'),
        anyDownload: !!document.querySelector('#modalDownloadBtn, #previewDownloadBtn, [data-download]') }));
      return [s.cards === 2 && s.modal && !s.anyDownload ? 'ok    the viewer sees the proofs (modal open) and no download button or link exists' : `FAIL  ${JSON.stringify(s)}`];
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
  // REWRITTEN with the finals gallery, and again 2026-10-19: the 驗收頁 is the 毛片 page (docs/delivery.md) —
  // the standard cards (each with its 下載), the standard preview (zoom included) with its 下載, the folder tree /
  // <select>. What is kept as it was: finals only, nothing of the proofs read, no picking UI at all, the download
  // URL and its saved file name.
  await suite(`guest delivered — ${who.label} sees the 精修成品: finals only, no picking UI, 下載 on the card and in the preview`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
      const cards = await guestCards(page);
      ok('the finals are listed (f1, f2)', JSON.stringify(cards) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]', JSON.stringify(cards));
      ok('no web-album gallery and no preview is open', (await page.$('#finalsGallery')) === null && (await page.$('#photoModal.active')) === null);
      ok('the claim overlay never appears, even with a free seat', (await page.$eval('#pickClaimOverlay', e => e.hidden)) === true);
      ok('the title says 精修成品', (await page.textContent('#deliveryTitle')).startsWith('精修成品') &&
        (await page.$eval('#deliveryBar', e => e.hidden)) === false);
      ok('only the finals folder was listed; the proofs never were', listed(m).length > 0 && listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      const imgs = await page.$$eval('.photo-card img', is => is.map(i => i.src));
      ok('card thumbnails are ?w=400 through the token', imgs.length === 2 && imgs.every(s => s.includes('?w=400') && s.includes('t=TOK') && s.includes('%E7%B2%BE%E4%BF%AE')), JSON.stringify(imgs));
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
      ok('no way to reach the proofs: no 回到毛片 entry while the switch is off', (await page.$('#deliveryProofsBtn')) === null);
      ok('each card has its 下載 (the finals are the deliverable)', JSON.stringify(await page.$$eval('.photo-card [data-download]', as => as.map(a => [decodeURI(a.href), a.textContent]))) ===
        JSON.stringify([[DL('shoot/精修/f1.jpg'), '下載'], [DL('shoot/精修/f2.jpg'), '下載']]));

      await page.click('#photoGrid .photo-card .photo-image');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      ok('the preview has no ♥ and no note box', (await page.$('#photoModal .pick-heart-btn')) === null && await page.$eval('#noteInputGroup', e => e.hidden));
      ok('the preview 下載 has the photo’s URL and the label 下載',
        (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f1.jpg') && (await page.textContent('#modalDownloadBtn')) === '下載');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.getElementById('photoCounter').textContent === '2 / 2', null, { timeout: 3000 });
      ok('next photo works and the download link follows', (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#modalDownloadBtn')]);
      ok('downloading a final saves f2.jpg', dl.suggestedFilename() === 'f2.jpg', dl.suggestedFilename());
      await page.keyboard.press('Escape');

      // a subfolder opens like a proof subfolder does (the sidebar tree on this 1280px page)
      await page.click('aside.sidebar #folderTree .tree-row[data-folder="shoot/精修/sub/"]');
      await page.waitForFunction(() => document.querySelector('#photoGrid .photo-card')?.dataset.photoId.includes('sub/'), null, { timeout: 5000 });
      await page.click('aside.sidebar #folderTree .tree-row[data-folder="shoot/精修/"]');
      await page.waitForFunction(() => document.querySelectorAll('#photoGrid .photo-card').length === 2, null, { timeout: 5000 });
      ok('the finals folder comes back (2 photos)', true);
      ok('and no picking write was ever sent', !m.requests.some(r => r.path === '/api/pick/selections'));
      return out;
    },
    { before: m.attach, initScript: who.init || undefined });

}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest delivered + switch ON — a secondary 回到毛片 lists the proofs, download-only (owner); ← 回精修成品 comes back',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // REWRITTEN 2026-10-19: the finals are the standard cards again (the 驗收頁 is the 毛片 page), like the proofs list
      const finals = () => guestCards(page);
      await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
      ok('the page still opens on the finals', (await finals()).length === 2 && (await finals()).every(k => k.startsWith('shoot/精修/')));
      ok('the proofs were not listed yet', listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      ok('the entry is 回到毛片', (await page.textContent('#deliveryProofsBtn')) === '回到毛片' && !(await page.$eval('#deliveryProofsBtn', e => e.hidden)));
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
      ok('the title says it is the proofs: exactly 毛片 · <project title>', (await page.textContent('#deliveryTitle')) === '毛片 · T 專案', await page.textContent('#deliveryTitle'));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.photo-card [data-download]')]);
      ok('downloading a proof original works (switch on)', dl.suggestedFilename() === 'a.jpg');
      ok('the card click did not also open the preview', (await page.$('#photoModal.active')) === null);
      ok('the button now leads back', (await page.textContent('#deliveryProofsBtn')) === '← 回精修成品');
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('精修'), null, { timeout: 5000 });
      ok('back on the finals (their 下載 links, no 下載原檔)', JSON.stringify(await finals()) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]' &&
        (await page.$$eval('.photo-card [data-download]', as => as.every(a => a.textContent === '下載'))));
      ok('and the folder tree follows the view: finals folders only', (await page.$$eval('aside.sidebar #folderTree .tree-row', rs => rs.length > 0 && rs.every(r => r.dataset.folder.includes('精修')))));

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
  // REWRITTEN 2026-10-19: the finals are the standard cards and preview again (the 驗收頁 is the 毛片 page): the card
  // 下載 and the preview 下載 are checked, and the swipe of the standard preview; the proofs list check is kept.
  await suite('guest delivered on a phone — no sideways scroll, 44px download targets, everything inside 390px',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#photoGrid .photo-card', { timeout: 5000 });
      const geo = await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right }; };
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, proofs: r('#deliveryProofsBtn'), bar: r('#deliveryBar'), cardDl: r('.photo-card [data-download]') };
      });
      ok('the page does not scroll sideways', geo.sw <= geo.iw, JSON.stringify(geo));
      ok('回到毛片 is >= 44 tall and inside the phone', !!geo.proofs && geo.proofs.h >= 44 && geo.proofs.r <= geo.iw + 1, JSON.stringify(geo.proofs));
      ok('the card 下載 is >= 44 tall and inside the phone', !!geo.cardDl && geo.cardDl.h >= 44 && geo.cardDl.r <= geo.iw + 1 && geo.cardDl.l >= 0, JSON.stringify(geo.cardDl));
      await page.click('#photoGrid .photo-card .photo-image');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(() => annotationManager.imageElement && annotationManager.fitW > 0, null, { timeout: 5000 });
      const lb = await page.evaluate(() => {
        const e = document.getElementById('modalDownloadBtn');
        const b = e.getBoundingClientRect();
        return { h: b.height, l: b.left, r: b.right, vis: getComputedStyle(e).display !== 'none', iw: innerWidth };
      });
      ok('the preview 下載 is visible, >= 44 tall and inside the phone', lb.vis && lb.h >= 44 && lb.r <= lb.iw + 1 && lb.l >= 0, JSON.stringify(lb));
      const before = await page.textContent('#photoCounter');
      await swipeTouch(page, '#photoCanvas', 300, 400, 60, 410);
      await page.waitForFunction(b => document.getElementById('photoCounter').textContent !== b, before, { timeout: 3000 });
      ok('swiping moves to the next final and the link follows', (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      ok('still no sideways scroll with the preview open', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.keyboard.press('Escape');
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
      await page.waitForSelector('#pd-more-btn', { timeout: 5000 });   // the detail is drawn (重設主人 is in the ⋯ menu since 2026-10-19)
      ok('no 標記已交件 button while still picking',
        (await page.$('#pd-deliver-btn')) === null && (await page.$('#pd-undeliver-btn:not([aria-disabled="true"])')) === null);

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
