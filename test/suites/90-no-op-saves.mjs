// Browser suites: flipping through the lightbox with the arrows must not save anything that did not change (Tim
// 2026-10-18: every arrow press re-saved the photo it left as "rating 0, no note", which deleted a collaborator's ♥ the
// owner's page did not know about, or re-stamped it as the owner's). A real change is still saved.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const OWNER = "localStorage.setItem('pick_key:TOK', 'CAROL-KEY');";
const DESK = { viewport: { width: 1280, height: 900 } };
const FILES = ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg', '20260819/d.jpg'];
const world = o => pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY', folders: ['20260819/'], pickFiles: FILES, ...o });
const puts = m => m.requests.filter(r => r.method === 'PUT' && r.path.endsWith('/api/pick/selections'));
const items = m => puts(m).flatMap(r => (r.body && Array.isArray(r.body.upsert) ? r.body.upsert : []));
const openFirst = async page => {
  await page.waitForSelector('.photo-card', { timeout: 5000 });
  await page.click('.photo-card', { position: { x: 5, y: 5 } });
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
};
const settle = page => page.waitForTimeout(1800);   // past the 800ms autosave debounce

{
  const m = world({});
  await suite('lightbox arrows with nothing changed — nothing is saved (not even a closing of the lightbox)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await openFirst(page);
      const seen = [];
      for (const id of ['#nextPhotoBtn', '#nextPhotoBtn', '#prevPhotoBtn']) { await page.click(id); await page.waitForTimeout(250); seen.push(await page.textContent('#photoCounter')); }
      ok('control: the lightbox really moved with the arrows (2 / 4, 3 / 4, 2 / 4)', JSON.stringify(seen) === JSON.stringify(['2 / 4', '3 / 4', '2 / 4']), JSON.stringify(seen));
      await page.click('#closeModal');
      await settle(page);
            ok('no save request was sent at all', puts(m).length === 0, JSON.stringify(items(m)));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('lightbox — a ♥ made while looking is saved, and only that one (the photos flipped past are not)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await openFirst(page);
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#photoModal .pick-heart-btn');              // the heart of the photo in the lightbox (the second one)
      await page.waitForFunction(() => document.querySelectorAll('#photoModal .pick-heart-btn.on').length >= 1, null, { timeout: 3000 });
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#nextPhotoBtn'); await settle(page);
      const keys = items(m).map(i => `${i.photo_key}:${i.rating}`);
      ok('exactly one item went out: the photo that was hearted', JSON.stringify(keys) === JSON.stringify(['20260819/b.jpg:1']), JSON.stringify(keys));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('lightbox — a note typed on a photo is saved when moving on, once, and flipping back and forth afterwards saves nothing more',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await openFirst(page);
      await page.fill('#photoNote', '這裡要亮一點');
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#prevPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#prevPhotoBtn'); await settle(page);
      const got = items(m).map(i => `${i.photo_key}|${i.rating}|${i.note}`);
      ok('the note was saved with the photo, and the flips back and forth added no more', got.length >= 1 && got.every(g => g === '20260819/a.jpg|0|這裡要亮一點'), JSON.stringify(got));
      const before = puts(m).length;
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#prevPhotoBtn'); await settle(page);
      ok('after that, two more flips with nothing changed send nothing', puts(m).length === before, `${before} -> ${puts(m).length}`);
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('each guard on its own: saving a note that did not change calls nothing, and queueing an unchanged photo queues nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await openFirst(page);
      const r = await page.evaluate(() => {
        const out = {};
        PickController.queueUpsert('20260819/c.jpg', 0, '');       // an untouched photo, queued as itself
        out.pendingAfterUnchanged = PickController.hasPending();
        const calls = [];
        const real = driveManager.saveNote.bind(driveManager);
        driveManager.saveNote = (id, note) => { calls.push([id, note]); return real(id, note); };
        app.saveCurrentNote();                                     // the box holds what the photo has: nothing to save
        out.callsUnchanged = calls.length;
        out.pendingAfterNoteCheck = PickController.hasPending();
        document.getElementById('photoNote').value = '換了';
        app.saveCurrentNote();                                     // now it differs: saved
        out.callsChanged = calls.length;
        driveManager.saveNote = real;
        out.pendingAfterChange = PickController.hasPending();
        return out;
      });
      ok('queueing an unchanged photo queues nothing', r.pendingAfterUnchanged === false, JSON.stringify(r));
      ok('saving a note that did not change calls nothing and queues nothing', r.callsUnchanged === 0 && r.pendingAfterNoteCheck === false, JSON.stringify(r));
      ok('a note that did change is saved and queued', r.callsChanged === 1 && r.pendingAfterChange === true, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  // the page does not know a collaborator hearted B after it loaded: the server has it, the owner's page says 0
  const m = world({});
  await suite('the owner flips past a photo a collaborator hearted after the page loaded — the owner\'s page sends no un-heart for it',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await openFirst(page);
      // the collaborator's ♥ on b reaches the server after this page loaded: the owner's page does not know it
      m.state.selections.set('20260819/b.jpg', { rating: 1, note: '', updated_by: 'picker-of-a-collaborator', updated_at: '2026-10-18T00:00:00.000Z' });
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);   // now on b (the owner's page thinks it is not picked)
      await page.click('#nextPhotoBtn'); await page.waitForTimeout(250);
      await page.click('#nextPhotoBtn'); await settle(page);
      const deletes = items(m).filter(i => i.rating === 0 && i.note === '');
      ok('nothing that reads as "not picked, no note" (the delete) was sent for any photo flipped past', deletes.length === 0 && puts(m).length === 0, JSON.stringify(items(m)));
      const b = m.state.selections.get('20260819/b.jpg');
      ok('the collaborator\'s ♥ is still on the server, still theirs', !!b && b.rating === 1 && b.updated_by === 'picker-of-a-collaborator', JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

}
