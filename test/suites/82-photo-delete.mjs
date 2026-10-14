// Browser suites: the photographer deletes ONE uploaded photo from the file view's preview (index.html?folder=…):
// the button exists only there, the lock hint, the confirm, the exact request, every refusal, phone size.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { photoDeleteFake, PHOTO_LOCKS } from '../lib/photo-delete-fake.mjs';

export default async function register() {

const WORKER = 'https://imagepicker.hotichen.workers.dev';
const FILES = ['shoot/a.jpg', 'shoot/b.jpg', 'shoot/c.jpg'];
const URL_ = `${base}/index.html?folder=${encodeURIComponent('shoot/')}`;

// a photographer page (token 'adm') with a fake Worker; `run(page, m, o)` gets helpers
function deleteSuite(name, fakeOpts, run, extra = {}) {
  const m = photoDeleteFake({ files: FILES, ...fakeOpts });
  return suite(`photo delete — ${name}`, URL_, async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    const dialogs = [];
    let answer = true;
    page.on('dialog', d => { dialogs.push(d.message()); return answer ? d.accept() : d.dismiss(); });
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    const o = {
      dialogs, setAnswer: v => { answer = v; },
      open: async i => {
        await page.evaluate(i2 => app.openModal(i2), i);
        await page.waitForSelector('#photoModal.active', { timeout: 3000 });
      },
      shown: () => page.evaluate(() => document.getElementById('modalPhotoName').textContent),
      msg: () => page.evaluate(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden ? e.textContent : ''; }),
      btn: () => page.evaluate(() => { const b = document.getElementById('modalDeleteBtn'); return b ? { disabled: b.disabled } : null; }),
      names: () => page.$$eval('.photo-card', cs => cs.map(c => c.dataset.photoId)),
      settleLock: () => page.waitForTimeout(500),
      click: () => page.evaluate(() => document.getElementById('modalDeleteBtn').click()),
      toasts: () => page.$$eval('.toast-message', es => es.map(e => e.textContent)),
    };
    await run(page, m, ok, o);
    return out;
  }, { before: m.attach, initScript: ADMIN_PLAIN, ...extra });
}

// ── 1. where the button is NOT ──────────────────────────────────────────────────────────────
{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/'], pickLimit: 5, title: 'T',
    photosByFolder: { 'A/': [0, 1, 2].map(i => ({ id: `A/a${i}.jpg`, name: `a${i}.jpg`, size: 9e6, rating: 0 })) } });
  await suite('photo delete — a guest link has no button, even in a browser that holds the photographer login',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      // the guest page normally has no photographer credential at all; force one in, so the guard under test is the
      // page mode and not a missing login
      await page.evaluate(() => { CONFIG.PHOTOGRAPHER_TOKEN = 'adm'; });
      ok('the photographer credential IS in this page on a guest link',
        await page.evaluate(() => !!CONFIG.PHOTOGRAPHER_TOKEN && PickController.active));
      await page.evaluate(() => app.openModal(0));
      await page.waitForSelector('#photoModal.active', { timeout: 3000 });
      await page.waitForTimeout(500);
      ok('the preview is open on the guest page', await page.evaluate(() => /a0/.test(document.getElementById('modalPhotoName').textContent)));
      ok('no 刪除 button in the DOM', await page.evaluate(() => !document.getElementById('modalDeleteBtn') && !document.querySelector('.modal-delete-btn')));
      ok('no message element either', await page.evaluate(() => !document.getElementById('modalDeleteMsg')));
      ok('the page text has no 刪除 control in the modal', await page.evaluate(() => !/刪除/.test(document.getElementById('photoModal').textContent)));
      ok('no lock / delete request reached the Worker',
        !m.requests.some(r => /\/api\/admin\/photo/.test(r.path)), JSON.stringify(m.requests.map(r => r.path)));
      ok('the app refuses to delete here', await page.evaluate(() => app._canDeletePhotos() === false));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

await deleteSuite('a page without the photographer credential (read-only studio token) has no button', {}, async (page, m, ok, o) => {
  await o.open(0);
  await page.waitForSelector('#modalDeleteBtn', { timeout: 2000 });
  ok('control: with the credential the button exists', true);
  await page.evaluate(() => { CONFIG.PHOTOGRAPHER_TOKEN = ''; CONFIG.SHARE_TOKEN = 'STUDIO-1'; });
  await o.open(1);
  ok('credential gone, read-only studio token left: button removed from the DOM',
    await page.evaluate(() => !document.getElementById('modalDeleteBtn') && !document.getElementById('modalDeleteMsg')));
  ok('and the app says no', await page.evaluate(() => app._canDeletePhotos() === false));
  await page.evaluate(() => { CONFIG.PHOTOGRAPHER_TOKEN = 'adm'; });
  ok('the project review view (ProjectViewController.active) says no even with the credential',
    await page.evaluate(() => { window.ProjectViewController = { active: true }; const r = app._canDeletePhotos(); delete window.ProjectViewController; return r === false; }));
  ok('and a normal photographer page says yes', await page.evaluate(() => app._canDeletePhotos() === true));
});

// ── 2. the happy path ─────────────────────────────────────────────────────────────────────────
await deleteSuite('success: confirm, exact request, grid and counters shrink, preview moves on, 已刪除', {}, async (page, m, ok, o) => {
  ok('start: 3 cards, counter 3', (await o.names()).length === 3 && await page.textContent('#starsAll') === '3');
  await o.open(1);
  await page.waitForSelector('#modalDeleteBtn', { timeout: 2000 });
  await o.settleLock();
  ok('the lock hint was asked for this key', m.locksSeen().length === 1 && m.locksSeen()[0].key === 'shoot/b.jpg', JSON.stringify(m.locksSeen()));
  ok('lock check carries the real credential', m.locksSeen()[0]?.auth === 'Bearer adm');
  ok('button enabled, no message', (await o.btn())?.disabled === false && (await o.msg()) === '');
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  ok('confirm text is exact', o.dialogs[0] === '刪除「b.jpg」？縮圖會一併刪除，無法復原。', JSON.stringify(o.dialogs));
  ok('exactly one DELETE, to the exact URL, with Bearer', m.deletes().length === 1
    && m.deletes()[0].rawUrl === `${WORKER}/api/admin/photo?key=shoot%2Fb.jpg` && m.deletes()[0].auth === 'Bearer adm', JSON.stringify(m.deletes()));
  ok('the grid lost that card only', JSON.stringify(await o.names()) === JSON.stringify(['shoot/a.jpg', 'shoot/c.jpg']));
  ok('the 總數 counter says 2', await page.textContent('#starsAll') === '2');
  ok('in-memory lists agree (app.photos, filteredPhotos, driveManager.photos)',
    await page.evaluate(() => [app.photos, app.filteredPhotos, driveManager.photos].every(l => l.length === 2 && !l.some(p => p.id === 'shoot/b.jpg'))));
  ok('the preview moved to the next photo (c.jpg), counter 2 / 2', await o.shown() === 'c.jpg' && await page.textContent('#photoCounter') === '2 / 2');
  ok('modal is still open', await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')));
  ok('a short 已刪除 notice', (await o.toasts()).includes('已刪除'), JSON.stringify(await o.toasts()));
  ok('the new current photo has its own button, enabled', (await o.btn())?.disabled === false);
  // the last photos: preview closes when nothing is left
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
  ok('deleting the LAST in the list moves back to the previous (a.jpg)', await o.shown() === 'a.jpg' && await page.textContent('#photoCounter') === '1 / 1');
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 0, null, { timeout: 3000 });
  ok('the last photo gone: modal closed', await page.evaluate(() => !document.getElementById('photoModal').classList.contains('active')));
  ok('counter 0 and the empty state shows', await page.textContent('#starsAll') === '0'
    && await page.evaluate(() => getComputedStyle(document.getElementById('emptyState')).display !== 'none'));
  ok('3 DELETEs in all', m.deletes().length === 3);
});

await deleteSuite('selection and local extras of the deleted photo are dropped', {}, async (page, m, ok, o) => {
  await page.evaluate(() => {
    app.selectedPhotoIds.add('shoot/b.jpg'); app.selectedPhotoIds.add('shoot/a.jpg'); app.updateBulkUI();
    driveManager.saveNote('shoot/b.jpg', 'keep?');
  });
  await o.open(1);
  await o.settleLock();
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  ok('selection no longer holds the deleted key, still holds the other',
    await page.evaluate(() => !app.selectedPhotoIds.has('shoot/b.jpg') && app.selectedPhotoIds.has('shoot/a.jpg')));
  ok('the 已選 counter follows', await page.textContent('#selectedCount') === '1');
  ok('its local note is gone', await page.evaluate(() => !('shoot/b.jpg' in JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTES) || '{}'))));
});

await deleteSuite('200 with failed thumbnails is still a success, mentioned softly', {}, async (page, m, ok, o) => {
  m.st.failedThumbs = ['_thumbs/1200/shoot/b.jpg.thumb'];
  await o.open(1);
  await o.settleLock();
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('.toast-message'), null, { timeout: 3000 });
  const t = await o.toasts();
  ok('photo removed and a soft notice that mentions the leftover thumbnails', t.some(x => /已刪除/.test(x) && /縮圖/.test(x)), JSON.stringify(t));
});

// ── 3. refusals ───────────────────────────────────────────────────────────────────────────────
const REASONS = {
  photo_locked_delivered: /已交件.*(鎖定|無法刪除)/,
  photo_locked_archived: /封存/,
  photo_in_pick_folder: /客人選片的資料夾.*客人可能已選取/,
  photo_in_round: /客人.*(修改紀錄|選片).*用到這張/,
  photo_in_order: /訂單/,
  photo_in_album: /相本/,
};
await deleteSuite('each 409 code: the lock hint disables the button with its own sentence',
  { locks: { 'shoot/a.jpg': 'photo_locked_delivered', 'shoot/b.jpg': 'photo_locked_archived', 'shoot/c.jpg': 'photo_in_pick_folder' } },
  async (page, m, ok, o) => {
    const seen = new Set();
    for (const [i, code] of [[0, 'photo_locked_delivered'], [1, 'photo_locked_archived'], [2, 'photo_in_pick_folder']]) {
      await o.open(i);
      await o.settleLock();
      const t = await o.msg();
      seen.add(t);
      ok(`${code}: reason shown`, REASONS[code].test(t), t);
      ok(`${code}: button present but disabled`, (await o.btn())?.disabled === true);
    }
    ok('the three sentences differ', seen.size === 3);
    ok('a disabled button sends nothing', m.deletes().length === 0);
    await page.evaluate(() => document.getElementById('modalDeleteBtn').click());
    await page.waitForTimeout(200);
    ok('even a forced click on the disabled button sends nothing', m.deletes().length === 0 && o.dialogs.length === 0);
  });
await deleteSuite('the other 409 codes at lock time', { locks: { 'shoot/a.jpg': 'photo_in_round', 'shoot/b.jpg': 'photo_in_order', 'shoot/c.jpg': 'photo_in_album' } },
  async (page, m, ok, o) => {
    for (const [i, code] of [[0, 'photo_in_round'], [1, 'photo_in_order'], [2, 'photo_in_album']]) {
      await o.open(i);
      await o.settleLock();
      const t = await o.msg();
      ok(`${code}: reason shown and button disabled`, REASONS[code].test(t) && (await o.btn())?.disabled === true, t);
    }
  });

for (const code of Object.keys(PHOTO_LOCKS)) {
  await deleteSuite(`409 ${code} from the DELETE itself (lock hint unavailable): reason in the modal, photo kept`,
    { locks: { 'shoot/b.jpg': code } }, async (page, m, ok, o) => {
      m.st.lockMode = 'error';
      await o.open(1);
      await o.settleLock();
      ok('the failing lock hint left the button enabled', (await o.btn())?.disabled === false);
      await o.click();
      await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
      const t = await o.msg();
      ok('reason shown', REASONS[code].test(t), t);
      ok('one DELETE was sent', m.deletes().length === 1);
      ok('photo kept in grid and lists', (await o.names()).length === 3 && await page.evaluate(() => app.photos.length === 3 && driveManager.photos.length === 3));
      ok('still showing b.jpg, button enabled again', await o.shown() === 'b.jpg' && (await o.btn())?.disabled === false);
      ok('no 已刪除 notice', !(await o.toasts()).includes('已刪除'));
    });
}

await deleteSuite('an unknown 409 code shows the Worker error text as text', {}, async (page, m, ok, o) => {
  m.st.locks['shoot/b.jpg'] = 'photo_in_something_new';
  PHOTO_LOCKS.photo_in_something_new = '<b id="boom">新的原因</b>';
  try {
    m.st.lockMode = 'error';
    await o.open(1);
    await o.settleLock();
    await o.click();
    await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
    ok('the text is the Worker error, literally', await o.msg() === '<b id="boom">新的原因</b>', await o.msg());
    ok('and no element was created from it', await page.evaluate(() => !document.getElementById('boom')));
  } finally { delete PHOTO_LOCKS.photo_in_something_new; }
});

await deleteSuite('404: said so, photo stays listed until a reload', {}, async (page, m, ok, o) => {
  m.st.files = m.st.files.filter(f => f !== 'shoot/b.jpg'); // gone behind the page's back
  await o.open(1);
  await o.settleLock();
  await o.click();
  await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
  ok('message says it was not found', /找不到|已經被刪除/.test(await o.msg()), await o.msg());
  ok('grid untouched', (await o.names()).length === 3);
});

await deleteSuite('500 photo_lock_unavailable and photo_delete_failed: reason, nothing removed', {}, async (page, m, ok, o) => {
  await o.open(1);
  await o.settleLock();
  m.st.deleteMode = 'unavailable';
  await o.click();
  await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
  ok('unavailable: says it cannot be decided and nothing was deleted', /無法確認|沒有刪除/.test(await o.msg()), await o.msg());
  ok('kept, enabled', (await o.names()).length === 3 && (await o.btn())?.disabled === false);
  m.st.deleteMode = 'failed';
  await o.click();
  await page.waitForFunction(() => /沒有完成/.test(document.getElementById('modalDeleteMsg').textContent), null, { timeout: 3000 });
  ok('failed: says the delete did not finish, try again', /沒有完成/.test(await o.msg()), await o.msg());
  ok('still all 3 photos', (await o.names()).length === 3 && m.deletes().length === 2);
  m.st.deleteMode = 'normal';
  await o.click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  ok('a retry succeeds and clears the old message', (await o.msg()) === '' && m.deletes().length === 3);
});

await deleteSuite('network error: nothing deleted, said so, button usable again', {}, async (page, m, ok, o) => {
  await o.open(1);
  await o.settleLock();
  m.st.deleteMode = 'abort';
  await o.click();
  await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
  ok('message about the connection', /連不上|再試/.test(await o.msg()), await o.msg());
  ok('kept, enabled', (await o.names()).length === 3 && (await o.btn())?.disabled === false);
});

await deleteSuite('401: asks to log in again, photo kept', {}, async (page, m, ok, o) => {
  await o.open(1);
  await o.settleLock();
  m.st.deleteMode = 'unauthorized';
  await o.click();
  await page.waitForFunction(() => { const e = document.getElementById('modalDeleteMsg'); return e && !e.hidden; }, null, { timeout: 3000 });
  ok('message tells the session is no longer valid', /登入/.test(await o.msg()), await o.msg());
  ok('kept', (await o.names()).length === 3);
});

// ── 4. behaviour of the button ────────────────────────────────────────────────────────────────
await deleteSuite('in flight: disabled, a double click sends ONE request and asks once', { }, async (page, m, ok, o) => {
  m.st.delay = 500;
  await o.open(1);
  await o.settleLock();
  await page.evaluate(() => { const b = document.getElementById('modalDeleteBtn'); b.click(); b.click(); });
  await page.waitForTimeout(150);
  ok('while the request is out the button is disabled', (await o.btn())?.disabled === true);
  // a second route in is the controller itself
  await page.evaluate(() => app.deleteCurrentPhoto());
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  ok('exactly one DELETE', m.deletes().length === 1, String(m.deletes().length));
  ok('exactly one confirm', o.dialogs.length === 1, String(o.dialogs.length));
});

await deleteSuite('flipping to another photo while the request is out keeps that photo on screen', {}, async (page, m, ok, o) => {
  m.st.delay = 500;
  await o.open(0);
  await o.settleLock();
  await o.click();
  await page.waitForTimeout(100);
  await page.evaluate(() => app.navigatePhoto(1));
  ok('mid-flight the preview is on b.jpg', await o.shown() === 'b.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  await page.waitForTimeout(200);
  ok('after the delete it is still b.jpg (not skipped to c.jpg), counter 1 / 2', await o.shown() === 'b.jpg' && await page.textContent('#photoCounter') === '1 / 2', await o.shown());
  ok('the button on b.jpg is usable again', (await o.btn())?.disabled === false);
});

await deleteSuite('closing the preview while the request is out leaves it closed, and no note is written for the deleted key', {}, async (page, m, ok, o) => {
  m.st.delay = 400;
  await page.evaluate(() => driveManager.saveNote('shoot/b.jpg', 'old note'));
  await o.open(1);
  await o.settleLock();
  await o.click();
  await page.waitForTimeout(100);
  await page.evaluate(() => app.closeModal());
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  await page.waitForTimeout(300);
  ok('the preview stayed closed', await page.evaluate(() => !document.getElementById('photoModal').classList.contains('active')));
  ok('the grid shrank and the counter follows', await page.textContent('#starsAll') === '2');
  ok('the deleted key has no note left (nothing re-saved it)', await page.evaluate(() =>
    !('shoot/b.jpg' in JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTES) || '{}'))));
  ok('no delete button left behind in the closed modal', await page.evaluate(() => !document.getElementById('modalDeleteBtn')));
});

await deleteSuite('cancel in the confirm sends nothing', {}, async (page, m, ok, o) => {
  o.setAnswer(false);
  await o.open(1);
  await o.settleLock();
  await o.click();
  await page.waitForTimeout(300);
  ok('the confirm was asked', o.dialogs.length === 1);
  ok('no DELETE', m.deletes().length === 0);
  ok('photo still there, button enabled', (await o.names()).length === 3 && (await o.btn())?.disabled === false);
});

await deleteSuite('a failing lock hint (dropped / 503 / 500) leaves the preview usable and the delete works',
  {}, async (page, m, ok, o) => {
    for (const mode of ['abort', 'error', 'unavailable']) {
      m.st.lockMode = mode;
      await o.open(0);
      await o.settleLock();
      ok(`${mode}: button enabled, no message, preview shows a.jpg`, (await o.btn())?.disabled === false && (await o.msg()) === '' && await o.shown() === 'a.jpg');
      await o.open(2);
      await o.settleLock();
      ok(`${mode}: navigation still works`, await o.shown() === 'c.jpg');
    }
    m.st.lockMode = 'abort';
    await o.open(1);
    await o.settleLock();
    await o.click();
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
    ok('and the DELETE is the judge: it went through', m.deletes().length === 1);
  });

await deleteSuite('flipping fast does not fire a lock request per photo, and a late answer does not stick to another photo',
  { locks: { 'shoot/a.jpg': 'photo_in_album' } }, async (page, m, ok, o) => {
    await page.evaluate(() => { app.openModal(0); app.openModal(1); app.openModal(2); });
    await o.settleLock();
    ok('one lock request, for the photo that settled', m.locksSeen().length === 1 && m.locksSeen()[0].key === 'shoot/c.jpg', JSON.stringify(m.locksSeen().map(c => c.key)));
    ok('the locked photo\'s reason is not shown on c.jpg', (await o.msg()) === '' && (await o.btn())?.disabled === false);
  });

// ── 5. the exact key on the wire ──────────────────────────────────────────────────────────────
{
  const keys = ['shoot/a+b.jpg', 'shoot/a #c.jpg', 'shoot/a&b=c.jpg', 'shoot/100%.jpg', 'shoot/what?.jpg', 'shoot/中文 照片+#&%?.jpg'];
  await deleteSuite('encoded key: + # & % ? space 中文 reach the Worker as the exact key', { files: [...FILES, ...keys] }, async (page, m, ok, o) => {
    for (const key of keys) {
      const name = key.split('/').pop();
      const idx = await page.evaluate(k => app.filteredPhotos.findIndex(p => p.id === k), key);
      ok(`${name}: it is in the grid`, idx >= 0);
      await o.open(idx);
      await o.settleLock();
      const lock = m.locksSeen().at(-1);
      ok(`${name}: lock URL is encoded`, lock.rawUrl === `${WORKER}/api/admin/photo/lock?key=${encodeURIComponent(key)}` && lock.key === key, lock.rawUrl);
      await o.click();
      await page.waitForFunction(k => !app.photos.some(p => p.id === k), key, { timeout: 3000 });
      const d = m.deletes().at(-1);
      ok(`${name}: DELETE URL is exactly encodeURIComponent(key)`, d.rawUrl === `${WORKER}/api/admin/photo?key=${encodeURIComponent(key)}`, d.rawUrl);
      ok(`${name}: the Worker saw the exact key and deleted that file`, d.key === key && !m.st.files.includes(key), d.key);
      ok(`${name}: the confirm names the file`, o.dialogs.at(-1) === `刪除「${name}」？縮圖會一併刪除，無法復原。`, o.dialogs.at(-1));
    }
    ok('every file gone, nothing else touched', m.st.files.length === 3 && FILES.every(f => m.st.files.includes(f)));
  });
}

// ── 6. a file name is text ────────────────────────────────────────────────────────────────────
{
  const evil = 'shoot/<img src=x onerror="window.__xss=1">.jpg';
  await deleteSuite('XSS: a file name with markup is shown and confirmed as text', { files: [evil] }, async (page, m, ok, o) => {
    await o.open(0);
    await o.settleLock();
    ok('name in the modal is text', await o.shown() === '<img src=x onerror="window.__xss=1">.jpg'
      && await page.evaluate(() => !document.querySelector('#modalPhotoName img')));
    await o.click();
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 0, null, { timeout: 3000 });
    ok('the confirm shows the markup as plain characters', o.dialogs[0] === '刪除「<img src=x onerror="window.__xss=1">.jpg」？縮圖會一併刪除，無法復原。', o.dialogs[0]);
    ok('nothing executed, no img in the toast or the modal',
      await page.evaluate(() => window.__xss === undefined && !document.querySelector('.toast img, #photoModal #modalDeleteMsg img')));
    ok('delete went through for that exact key', m.deletes()[0]?.key === evil);
  });
}

// ── 7. an email-login session is a bearer token like any other ───────────────────────────────
{
  const m = photoDeleteFake({ files: FILES, token: 'sess-9' });
  await suite('photo delete — an email-login session sends its own token', URL_, async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    page.on('dialog', d => d.accept());
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    await page.evaluate(() => app.openModal(0));
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('modalDeleteBtn').click());
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
    ok('lock and DELETE carried Bearer sess-9', m.st.calls.length === 2 && m.st.calls.every(c => c.auth === 'Bearer sess-9'), JSON.stringify(m.st.calls));
    return out;
  }, { before: m.attach, initScript: () => {
    sessionStorage.setItem('studio_token', 'sess-9');
    sessionStorage.setItem('studio_session', JSON.stringify({ t: 'sess-9', must: false }));
  } });
}

// ── 8. phone ──────────────────────────────────────────────────────────────────────────────────
await deleteSuite('phone 390px: a real >=44px button, clear of prev/next/close, nothing overflows', {}, async (page, m, ok, o) => {
  await o.open(1);
  await o.settleLock();
  await page.waitForFunction(() => document.getElementById('photoModal').querySelector('.modal-content').getAnimations().length === 0, null, { timeout: 3000 });
  const g = await page.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const b = document.getElementById('modalDeleteBtn');
    const hit = document.elementFromPoint(r(b).l + r(b).w / 2, r(b).t + r(b).h / 2);
    return {
      del: r(b), cs: getComputedStyle(b).display, prev: r(document.getElementById('prevPhotoBtn')), next: r(document.getElementById('nextPhotoBtn')),
      close: r(document.getElementById('closeModal')), bar: r(document.querySelector('.modal-photo-info')),
      hitIsBtn: b.contains(hit), vw: innerWidth, sw: document.documentElement.scrollWidth,
    };
  });
  const apart = (a, b) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;
  ok('computed display is not none', g.cs !== 'none', g.cs);
  ok('touch target >= 44 x 44', g.del.w >= 44 && g.del.h >= 44, JSON.stringify(g.del));
  ok('fully inside the screen', g.del.l >= 0 && g.del.r <= g.vw && g.del.b <= 844, JSON.stringify(g.del));
  ok('does not overlap the previous arrow', apart(g.del, g.prev), JSON.stringify([g.del, g.prev]));
  ok('does not overlap the next arrow', apart(g.del, g.next));
  ok('does not overlap the close X', apart(g.del, g.close));
  ok('inside the bottom info bar, below the arrows', g.del.t >= g.bar.t - 1 && g.del.t > g.prev.b);
  ok('it is the element a finger would hit', g.hitIsBtn);
  ok('no horizontal page scroll', g.sw <= g.vw, `${g.sw} > ${g.vw}`);
  await page.locator('#modalDeleteBtn').tap();
  await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
  ok('a real tap deletes (one DELETE)', m.deletes().length === 1);
}, { contextOptions: MOBILE });

}
