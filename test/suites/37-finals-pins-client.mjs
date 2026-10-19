// Browser suites: pins on the delivered finals, client side (docs/revision-pins.md §6.1, §13.1):
// pins placed in the standard preview (the 驗收頁 is the 毛片 page, docs/delivery.md; the pin UI itself
// is suite 92) with autosaved drafts, the round dialog, every error code in plain Chinese, the read-only
// history 「上一輪的修改資訊」, and everything that must NOT exist (viewers, the migration not run, the
// 完成頁). The fake Worker mirrors the real routes (test/lib/revision-pins-fake.mjs).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, albKeys } from '../lib/album-world.mjs';
import { donePosts } from '../lib/delivery-helpers.mjs';
import { pinsWorld } from '../lib/revision-pins-fake.mjs';
import { rsOpen, rsPoint, rsMarks } from '../lib/review-stage.mjs';

export default async function register() {

const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
// suite() that keeps the lines written before a thrown error (a throw would otherwise hide them)
const sx = (name, url, run, opts) => suite(name, url, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; };
const K = i => albKeys(8)[i - 1];                       // shoot/精修/IMG_000i.jpg  (1 = landscape, 2 = portrait, ...)
const pin = (x, y, note = '') => ({ x, y, note });
const world = (o = {}) => pinsWorld({ n: 8, ...o, fake: { title: '婚禮精修', ...(o.fake || {}) } });
const pageUrl = `${base}/index.html?t=TOK`;
// a spy on URL.createObjectURL / revokeObjectURL and on fetch's keepalive flag
const SPIES = `(() => {
  window.__blobs = { made: [], revoked: [] };
  const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = o => { const u = mk(o); window.__blobs.made.push(u); return u; };
  URL.revokeObjectURL = u => { window.__blobs.revoked.push(u); return rv(u); };
  window.__fetches = [];
  const f = window.fetch.bind(window);
  window.fetch = (u, init) => { window.__fetches.push({ url: String(u), method: (init && init.method) || 'GET', keepalive: !!(init && init.keepalive), body: init && init.body ? String(init.body) : null, headers: init && init.headers ? Object.assign({}, init.headers) : {} }); return f(u, init); };
})();`;

// the standard preview (test/lib/review-stage.mjs): open photo i, tap a fraction of it, the pins it holds
const openLb = (page, i) => rsOpen(page, i);
const tapAt = async (page, fx, fy) => { const p = await rsPoint(page, fx, fy); await page.mouse.click(p.x, p.y); return p; };
const pinsOnScreen = rsMarks;
const pinOn = page => page.click('#pickPinBtn');
const closeLb = page => page.keyboard.press('Escape');
const doneStatus = page => page.evaluate(() => document.getElementById('deliveryDoneStatus')?.textContent ?? null);
const roundCalls = w => w.calls.filter(c => c.method === 'POST' && c.path === '/api/pick/revision-round');
const putCalls = w => w.calls.filter(c => c.method === 'PUT' && c.path === '/api/pick/revision-pins');
const keyLeak = async (page, w) => {
  const dom = await page.evaluate(() => [...document.querySelectorAll('*')].some(e => [...e.attributes].some(a => a.value.includes('ZOE-KEY'))));
  const urls = [...w.calls.map(c => c.url), ...w.m.requests.map(r => r.path + r.search)];
  return { dom, url: urls.some(u => u.includes('ZOE-KEY')) };
};
const modalActive = (page, id) => page.evaluate(i => { const e = document.getElementById(i); return !!e && e.classList.contains('active') && getComputedStyle(e).display !== 'none'; }, id);

// ═════ 1. pins in the preview: the black bars, deleting a photo's last pin, the key, reload
// (placing, notes, the debounce, zoom and the phone tap / swipe are suite 92)
{
  const w = world();
  await sx('finals pins — owner: a tap beside the photo places nothing; removing the last pin saves marks: []; the key stays out of URLs and the DOM; a reload brings the drafts back',
    pageUrl,
    async (page, ok) => {
      await openLb(page, 1);
      ok('positive: 標示修改 is in the preview (the seat holder, migration run)', (await page.textContent('#pickPinBtn')) === '標示修改');
      await pinOn(page);
      await tapAt(page, 0.25, 0.4);
      await page.keyboard.type('去掉路人');
      await page.keyboard.press('Enter');
      ok('the draft lands with its note', await until(() => w.drafts().has(K(1)) && w.drafts().get(K(1))[0].note === '去掉路人'));
      // the portrait photo: black bars left and right of it
      await page.click('#nextPhotoBtn');
      await page.waitForFunction(k => annotationManager.currentPhoto.id === k && annotationManager.fitW > 0 && !annotationManager.canvas.parentElement.classList.contains('photo-loading'), K(2));
      const bar = await page.evaluate(() => { const a = annotationManager, r = a.canvas.getBoundingClientRect(); return { x: r.left + a.offsetX - 40, y: r.top + a.offsetY + a.fitH / 2, off: a.offsetX }; });
      ok('fixture: the portrait photo leaves real black bars beside it', bar.off > 80, JSON.stringify(bar));
      ok('as on the 毛片 page, flipping to another photo leaves pin mode', (await page.$('#pickPinBtn')) !== null && !(await page.evaluate(() => annotationManager.pinMode)));
      await pinOn(page);
      const before = putCalls(w).length;
      await page.mouse.click(bar.x, bar.y);
      await sleep(800);
      ok('a tap in the black bar places nothing and saves nothing', (await pinsOnScreen(page)).length === 0 && putCalls(w).length === before, JSON.stringify(await pinsOnScreen(page)));
      await tapAt(page, 0.5, 0.5);
      await page.keyboard.press('Enter');
      ok('positive: a tap on the photo does place a pin', (await pinsOnScreen(page)).length === 1);
      await page.click('#pickPinList .pick-pin-del');
      ok('× removes it', (await pinsOnScreen(page)).length === 0);
      ok('the delete is saved as marks: [] for that photo', await until(() => putCalls(w).some(c => c.body.items.some(i => i.photo_key === K(2) && i.marks.length === 0))));
      ok('the server holds only photo 1\'s draft', w.drafts().size === 1 && w.drafts().has(K(1)));
      await closeLb(page);
      const leak = await keyLeak(page, w);
      ok('the picker key is in no URL and no DOM attribute', !leak.dom && !leak.url, JSON.stringify(leak));
      await page.reload({ waitUntil: 'load' });
      await openLb(page, 1);
      const pins = await pinsOnScreen(page);
      ok('after a reload the drafts come back from the state: the pin with its note', pins.length === 1 && pins[0].note === '去掉路人', JSON.stringify(pins));
      ok('PinLayer helpers: cleanPinMarks is PinLayer.clean; fractions outside the photo are null; notes lose control characters',
        await page.evaluate(() => window.cleanPinMarks === PinLayer.clean && PinLayer.toFraction({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }, 101, 10) === null &&
          JSON.stringify(PinLayer.toFraction({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }, 25, 25)) === '{"x":0.25,"y":0.5}' && PinLayer.sanitize('a\u0000b\u2028c') === 'abc' &&
          PinLayer.clean([{ x: 2, y: 0 }, { x: 0.1, y: 0.2, note: 5 }]).length === 1));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 3. the submit button, the dialog, the round, and what the page shows afterwards
const SEED = () => [{ photo_key: K(1), marks: [pin(0.2, 0.3, '臉修瘦一點'), pin(0.6, 0.5, '')] }, { photo_key: K(3), marks: [pin(0.4, 0.4, 'x')] }];
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — 送出修改 N 張: count, dialog (thumbnails, empty-note warning), flush first, expect, then 已送出 and a read-only lightbox',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      ok('positive: the owner has 確認完成 and 送出修改 2 張 (enabled); the old 需要修改 button is gone', (await page.textContent('#doneRoundBtn')).replace(/\s/g, '') === '送出修改2張' &&
        !(await page.$eval('#doneRoundBtn', b => b.disabled)) && (await page.$('#doneConfirmBtn')) !== null && (await page.$('#doneReviseBtn')) === null && (await page.$('#doneReviseModal')) === null);
      // an edit made just before the press must be flushed first: the PUT is slow, so a submit that did not
      // wait for it would reach the Worker before the draft did (draft_changed)
      w.ctl.delay.put = 700;
      await openLb(page, 4);
      await pinOn(page);
      await tapAt(page, 0.5, 0.5);
      await page.keyboard.type('背景');
      await page.keyboard.press('Enter');
      await closeLb(page);
      await sleep(50);
      ok('the button already counts the fresh pin (3 photos)', (await page.textContent('#doneRoundBtn')).replace(/\s/g, '') === '送出修改3張', await page.textContent('#doneRoundBtn'));
      await page.click('#doneRoundBtn');
      ok('the dialog opens: 送出 3 張照片的修改？', await modalActive(page, 'doneRoundModal') && (await page.textContent('#doneRoundModalTitle')) === '送出 3 張照片的修改？');
      const items = await page.$$eval('#doneRoundList .done-round-item', els => els.map(e => ({ text: e.textContent, src: e.querySelector('img') ? e.querySelector('img').src : null })));
      ok('one row per photo with its pin count and a 400 thumbnail', items.length === 3 && items[0].text.includes('IMG_0001.jpg') && items[0].text.includes('2 個標示') && items[1].text.includes('1 個標示') &&
        items.every(i => /\?w=400/.test(i.src || '')), JSON.stringify(items));
      ok('the empty-note warning counts the pins without a note (1: photo 1\'s ②)', (await page.textContent('#doneRoundWarn')).includes('有 1 個標示沒有寫說明，攝影師只看得到位置'));
      ok('it says the round can not be changed afterwards', (await page.textContent('#doneRoundModal')).includes('送出後這一輪就不能再改'));
      await page.fill('#doneRoundNote', '整體亮一點');
      await page.click('#doneRoundSubmit');
      ok('after sending: the dialog closes and the status line says 已送出修改（3 張），攝影師處理中',
        await until(async () => !(await modalActive(page, 'doneRoundModal')) && (await doneStatus(page)) === '已送出修改（3 張），攝影師處理中'), String(await doneStatus(page)));
      const posts = roundCalls(w);
      ok('exactly one POST', posts.length === 1, String(posts.length));
      ok('the pending edit was flushed BEFORE the submit', putCalls(w).length >= 1 && w.calls.indexOf(putCalls(w).pop()) < w.calls.indexOf(posts[0]));
      ok('expect lists each photo with its pin count, sorted; note travels', posts[0].body.note === '整體亮一點' && JSON.stringify(posts[0].body.expect) === JSON.stringify([{ k: K(1), n: 2 }, { k: K(3), n: 1 }, { k: K(4), n: 1 }]) && Object.keys(posts[0].body).length === 2, JSON.stringify(posts[0].body));
      ok('headers only, no key in the URL', posts[0].headers.key === 'ZOE-KEY' && posts[0].headers.token === 'TOK' && !posts[0].url.includes('?'));
      ok('the server holds a frozen round with 3 photos and no draft', w.rounds.length === 1 && w.rounds[0].photos.length === 3 && w.drafts().size === 0);
      ok('the submit button is gone, 確認完成 stays', (await page.$('#doneRoundBtn')) === null && (await page.$('#doneConfirmBtn')) !== null);
      await openLb(page, 1);
      await until(async () => (await pinsOnScreen(page)).length === 2);
      ok('the preview shows the submitted pins of photo 1, read-only: no 標示修改', (await pinsOnScreen(page)).length === 2 && (await page.$('#pickPinBtn')) === null, JSON.stringify(await pinsOnScreen(page)));
      await tapAt(page, 0.8, 0.8);
      await sleep(900);
      ok('tapping the photo changes nothing (no pin, no PUT after the submit)', (await pinsOnScreen(page)).length === 2 && putCalls(w).every(c => w.calls.indexOf(c) < w.calls.indexOf(posts[0])));
      const notes = await page.$$eval('#pickPinList .pick-pin-note', els => els.map(e => ({ v: e.value, ro: e.readOnly })));
      ok('the notes are listed read-only (no ×)', notes.length === 2 && notes.every(n => n.ro) && notes[0].v === '臉修瘦一點' && (await page.$$('#pickPinList .pick-pin-del')).length === 0, JSON.stringify(notes));
      const leak = await keyLeak(page, w);
      ok('the picker key is in no URL and no DOM attribute', !leak.dom && !leak.url, JSON.stringify(leak));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('finals pins — 送出修改 0 張 is disabled with the hint; the note is optional (none sent)',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      ok('0 photos: the button is there and disabled', (await page.textContent('#doneRoundBtn')).replace(/\s/g, '') === '送出修改0張' && await page.$eval('#doneRoundBtn', b => b.disabled));
      ok('the hint points at the photos', (await page.textContent('#doneRoundHint')).includes('點照片進入標示修改'));
      await openLb(page, 1);
      await pinOn(page);
      await tapAt(page, 0.5, 0.5);
      await page.keyboard.type('痘痘');
      await page.keyboard.press('Enter');
      await closeLb(page);
      ok('with one photo marked: enabled, the hint is gone from the DOM', await until(async () => !(await page.$eval('#doneRoundBtn', b => b.disabled)) && (await page.$('#doneRoundHint')) === null));
      await page.click('#doneRoundBtn');
      ok('every pin has a note: no warning', (await page.$('#doneRoundWarn')) === null || (await page.textContent('#doneRoundWarn')) === '');
      await page.click('#doneRoundSubmit');
      ok('submitted', await until(async () => roundCalls(w).length === 1 && (await doneStatus(page)) === '已送出修改（1 張），攝影師處理中'));
      ok('no note was sent (the Worker fills its fixed text; the page never shows it)', !('note' in roundCalls(w)[0].body) || roundCalls(w)[0].body.note === undefined, JSON.stringify(roundCalls(w)[0].body));
      ok('the status shows no message text (message_auto is not the guest\'s words)', (await page.$('#deliveryDoneMsg')) === null);
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 4. draft_changed: refetch, show the new list, send again
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — draft_changed (another tab edited): the dialog refreshes to the server\'s drafts and the next press succeeds',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      w.ctl.beforeRound = () => w.setDrafts([...SEED(), { photo_key: K(4), marks: [pin(0.5, 0.5, '另一個分頁')] }]);
      await page.click('#doneRoundBtn');
      await page.click('#doneRoundSubmit');
      ok('the first press is refused: the dialog stays open with a plain message', await until(async () => (await page.textContent('#doneRoundErr')).includes('標示在別處被修改過')) && await modalActive(page, 'doneRoundModal'), await page.textContent('#doneRoundErr'));
      ok('the list now shows 3 photos (the server\'s drafts) and the title says 3', (await page.$$('#doneRoundList .done-round-item')).length === 3 && (await page.textContent('#doneRoundModalTitle')) === '送出 3 張照片的修改？');
      ok('the submit button works again', !(await page.$eval('#doneRoundSubmit', b => b.disabled)));
      await page.click('#doneRoundSubmit');
      ok('the second press goes through with the new expect', await until(() => roundCalls(w).length === 2 && w.rounds.length === 1) &&
        JSON.stringify(roundCalls(w)[1].body.expect.map(e => e.k)) === JSON.stringify([K(1), K(3), K(4)]), JSON.stringify(roundCalls(w).map(c => c.body)));
      ok('the page shows the round as sent', await until(async () => (await doneStatus(page)) === '已送出修改（3 張），攝影師處理中'));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 5. every error code of §13.1, in plain Chinese
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — the submit answers every §13.1 error in plain Traditional Chinese; the dialog stays usable',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      await page.click('#doneRoundBtn');
      const cases = [
        [{ status: 409, body: { code: 'revision_cap', max: 50 } }, '修改次數已達上限（50 次）'],
        [{ status: 409, body: { code: 'marks_cap', max: 300 } }, '標示總數已達上限（300 個）'],
        [{ status: 400, body: { code: 'invalid_message', max: 1000 } }, '總說明請輸入 1–1000 字'],
        [{ status: 400, body: { code: 'invalid_body' } }, '資料格式不正確'],
        [{ status: 500, body: { code: 'revision_pins_unavailable' } }, '標示修改功能暫時無法使用'],
        [{ status: 413, body: { code: 'too_large' } }, '內容太長'],
        [{ status: 403, body: { code: 'not_owner' } }, '只有選片人可以操作'],
        [{ status: 401, body: { error: 'Unauthorized' } }, '連結已失效'],
        [{ status: 429, body: { error: 'slow' } }, '操作太頻繁'],
        [{ status: 503, body: { error: 'x' } }, '暫時無法處理'],
        [{ net: true }, '無法連線'],
      ];
      for (const [inj, text] of cases) {
        w.ctl.failNext.push({ on: 'round', ...inj });
        const before = roundCalls(w).length;
        await page.click('#doneRoundSubmit');
        const shown = await until(async () => roundCalls(w).length > before && (await page.textContent('#doneRoundErr')).includes(text)) ||
          (inj.net && await until(async () => (await page.textContent('#doneRoundErr')).includes(text)));
        ok(`${inj.net ? 'network down' : `${inj.status} ${inj.body.code || ''}`} -> 「${text}」, dialog still open and re-usable`,
          shown && await modalActive(page, 'doneRoundModal') && !(await page.$eval('#doneRoundSubmit', b => b.disabled)), await page.textContent('#doneRoundErr'));
      }
      ok('none of those created a round, and the page still offers the submit', w.rounds.length === 0 && (await page.$('#doneRoundBtn')) !== null);
      // no_pins: the drafts are gone on the server -> the page refetches and has nothing to send
      w.ctl.failNext.push({ on: 'round', status: 409, body: { code: 'no_pins' }, effect: () => w.setDrafts([]) });
      await page.click('#doneRoundSubmit');
      ok('no_pins: plain message and the dialog list is refreshed to the server (empty -> the dialog closes)',
        await until(async () => !(await modalActive(page, 'doneRoundModal'))) && (await page.$eval('#doneRoundBtn', b => b.disabled)), '');
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — revision_open (another tab sent first): the page shows the round as sent',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      await page.click('#doneRoundBtn');
      w.ctl.failNext.push({ on: 'round', status: 409, body: { code: 'revision_open' }, effect: () => w.submitDirect([K(1), K(3)]) });
      await page.click('#doneRoundSubmit');
      ok('the state is re-read: 已送出修改（2 張），攝影師處理中, the dialog is closed, no submit button',
        await until(async () => (await doneStatus(page)) === '已送出修改（2 張），攝影師處理中' && !(await modalActive(page, 'doneRoundModal')) && (await page.$('#doneRoundBtn')) === null), String(await doneStatus(page)));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — already_confirmed (confirmed meanwhile): the 完成頁 replaces the page, with none of the pin UI',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      await page.click('#doneRoundBtn');
      w.ctl.failNext.push({ on: 'round', status: 409, body: { code: 'already_confirmed' }, effect: () => { w.m.state.project.client_confirmed_at = new Date().toISOString(); } });
      await page.click('#doneRoundSubmit');
      ok('the completion page is up', await until(async () => (await page.$('#completionPage')) !== null));
      ok('no submit button, no dialogs, no status block in the DOM', (await page.$('#doneRoundBtn')) === null && (await page.$('#doneRoundModal')) === null && (await page.$('#deliveryDone')) === null);
      await page.waitForSelector('#completionPage .fg-tile');
      await page.click('#completionPage .fg-tile');
      await page.waitForSelector('#fgLbImg.on');
      ok('the 完成頁 has none of the pin UI: the store is off, its lightbox has buttons but no 標示修改, no badge', await page.evaluate(() => RevisionPins.enabled === false &&
        document.querySelectorAll('#fgLightbox button').length > 0 && [...document.querySelectorAll('#fgLightbox button')].every(b => !b.textContent.includes('標示')) &&
        !document.querySelector('.pv-pin-badge') && !document.getElementById('pickModalTools')));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — not_delivered (the photographer changed the delivery): 重新整理 offered',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      await page.click('#doneRoundBtn');
      w.ctl.failNext.push({ on: 'round', status: 409, body: { code: 'not_delivered' } });
      await page.click('#doneRoundSubmit');
      ok('plain message and a 重新載入 button', await until(async () => (await page.textContent('#doneRoundErr')).includes('攝影師已更新或收回成品，請重新整理頁面')) && (await page.$('#doneRoundErr .done-reload')) !== null);
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 6. autosave failures
{
  const w = world();
  await sx('finals pins — autosave: a dropped connection / 5xx keeps the draft and retries; a 4xx shows its message and stops',
    pageUrl,
    async (page, ok) => {
      // (the line inside the preview is suite 92; this is the page-level status under it, and the PUT count)
      const pageSave = () => page.evaluate(() => (document.getElementById('deliveryDone')?.textContent || ''));
      await openLb(page, 1);
      await pinOn(page);
      w.ctl.failNext.push({ on: 'put', net: true }, { on: 'put', status: 503, body: { error: 'x' } });
      await tapAt(page, 0.3, 0.3);
      await page.keyboard.press('Enter');
      ok('offline: the page-level status says it is not saved yet, and will be', await until(async () => (await pageSave()).includes('尚未儲存，連線後會自動送出')), await pageSave());
      ok('it retries by itself and the draft lands (3 PUTs: net, 503, ok)', await until(() => w.drafts().has(K(1)) && putCalls(w).length >= 3, 8000), String(putCalls(w).length));
      ok('the status clears once saved', await until(async () => !(await pageSave()).includes('尚未儲存')));
      const n = putCalls(w).length;
      w.ctl.failNext.push({ on: 'put', status: 400, body: { code: 'invalid_marks' } });
      await tapAt(page, 0.6, 0.6);
      await page.keyboard.press('Enter');
      ok('a 4xx: its message is shown', await until(async () => (await pageSave()).includes('標示內容不正確')), await pageSave());
      await sleep(1500);
      ok('and it is NOT retried by itself', putCalls(w).length === n + 1, String(putCalls(w).length - n));
    },
    { before: w.before, initScript: `window.REVISION_PINS_RETRY_MS = 400;${OWNER}`, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('finals pins — leaving the page (pagehide) sends the pending draft with keepalive',
    pageUrl,
    async (page, ok) => {
      await openLb(page, 1);
      await pinOn(page);
      await tapAt(page, 0.3, 0.3);
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const ka = await page.evaluate(() => window.__fetches.filter(f => f.method === 'PUT'));
      ok('a PUT with keepalive:true went out at once, carrying the pin', ka.length >= 1 && ka[0].keepalive === true && JSON.parse(ka[0].body).items[0].photo_key === K(1) && JSON.parse(ka[0].body).items[0].marks.length === 1, JSON.stringify(ka));
      ok('its headers carry the credentials; the URL does not', ka[0].headers['X-Share-Token'] === 'TOK' && ka[0].headers['X-Picker-Key'] === 'ZOE-KEY' && !ka[0].url.includes('?') && !ka[0].url.includes('ZOE-KEY'), JSON.stringify(ka[0]));
    },
    { before: w.before, initScript: SPIES + OWNER, contextOptions: ALB_DESK });
}

// ═════ 7. the confirm dialog warns about unsent drafts
{
  const w = world({ drafts: SEED() });
  await sx('finals pins — 確認完成 warns that unsent pins will not reach the photographer',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneConfirmBtn', { timeout: 6000 });
      await page.click('#doneConfirmBtn');
      ok('the dialog says: you still have 2 photos with pins not sent, and that confirming drops them', (await page.textContent('#doneConfirmUnsent')) === '你還有 2 張照片的標示沒有送出。現在確認完成，這些標示會被丟掉，攝影師看不到。');
      ok('the usual confirm text is still there', (await page.textContent('#doneConfirmModal')).includes('確認後攝影師會收到通知'));
      const g = await page.evaluate(() => { const s = document.getElementById('doneConfirmSubmit'), b = document.getElementById('doneConfirmBack');
        return { sub: s.textContent, subCls: s.className, back: b && b.textContent, backCls: b && b.className, sameRow: !!b && s.parentElement === b.parentElement, backAfter: !!b && s.nextElementSibling === b }; });
      ok('going back to send is the main (green) button; confirming anyway is the quiet outline one, worded 仍要確認完成',
        g.back === '回去送出修改（2 張）' && /btn-success/.test(g.backCls) && g.sub === '仍要確認完成' && /btn-outline/.test(g.subCls) && !/btn-success/.test(g.subCls) && g.sameRow && g.backAfter, JSON.stringify(g));
      // 回去送出修改: the confirm dialog closes, the round dialog opens with the drafts, nothing was confirmed
      await page.click('#doneConfirmBack');
      ok('the round dialog is open and the confirm dialog is closed', await modalActive(page, 'doneRoundModal') && !(await modalActive(page, 'doneConfirmModal')));
      ok('nothing was confirmed', donePosts(w.m, 'confirm').length === 0 && (await page.$('#completionPage')) === null);
      await page.click('#doneRoundCancel');
      await page.click('#doneConfirmBtn');
      ok('reopening the dialog shows the warning again (not a stale state)', await modalActive(page, 'doneConfirmModal') && (await page.$('#doneConfirmUnsent')) !== null && (await page.$$('#doneConfirmBack')).length === 1);
      await page.click('#doneConfirmSubmit');
      ok('confirming works as before: completion page', await until(async () => (await page.$('#completionPage')) !== null) && donePosts(w.m, 'confirm').length === 1);
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
  const w2 = world();
  await sx('finals pins — 確認完成 without drafts has no such warning (element not in the DOM)',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneConfirmBtn', { timeout: 6000 });
      await page.click('#doneConfirmBtn');
      ok('positive: the dialog is open', await modalActive(page, 'doneConfirmModal'));
      ok('no unsent-pins line, no 回去送出修改 button', (await page.$('#doneConfirmUnsent')) === null && (await page.$('#doneConfirmBack')) === null);
      const s = await page.evaluate(() => { const b = document.getElementById('doneConfirmSubmit'); return { t: b.textContent, c: b.className }; });
      ok('the plain 確認完成 stays the green main button', s.t === '確認完成' && /btn-success/.test(s.c), JSON.stringify(s));
    },
    { before: w2.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 8. what must not exist: the migration not run, viewers, the 完成頁
{
  const w = world({ migrated: false, drafts: SEED() });
  await sx('finals pins — migration not run (revision_drafts: null): no pin UI at all, the old 需要修改 text flow still works',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneReviseBtn', { timeout: 6000 });
      ok('positive: 確認完成 and 需要修改 are there', (await page.$('#doneConfirmBtn')) !== null && (await page.$('#doneReviseBtn')) !== null);
      ok('no submit-pins button, hint, history button or round dialog in the DOM', (await page.$('#doneRoundBtn')) === null && (await page.$('#doneRoundHint')) === null && (await page.$('#doneHistoryBtn')) === null && (await page.$('#doneRoundModal')) === null);
      await openLb(page, 1);
      ok('positive: the preview is open; it has no tools row, no pins, and no card has a badge', await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')) &&
        (await page.$('#pickModalTools')) === null && (await pinsOnScreen(page)).length === 0 && (await page.$('.pv-pin-badge')) === null);
      await closeLb(page);
      await page.click('#doneReviseBtn');
      await page.fill('#doneReviseText', '請把 f1 調亮');
      await page.click('#doneReviseSubmit');
      ok('the text request goes to the old route', await until(() => donePosts(w.m, 'revision').length === 1) && donePosts(w.m, 'revision')[0].body.message === '請把 f1 調亮');
      ok('the new routes were never called', w.calls.length === 0, JSON.stringify(w.calls.map(c => c.path)));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
for (const [who, init] of [['owner', OWNER], ['viewer (no seat key)', '']]) {
  const w = world({ drafts: SEED(), selection: { created_at: '2026-09-20T00:00:00.000Z', photos: [{ key: K(1), pins: [pin(0.5, 0.5, 'a')] }] } });
  await sx(`finals pins — ${who}: ${who === 'owner' ? 'the pin UI and the history button exist' : 'no pin UI, no history, no calls to the new routes'}`,
    pageUrl,
    async (page, ok) => {
      await openLb(page, 1);
      await sleep(300);
      const has = await page.evaluate(() => ({ toggle: !!document.getElementById('pickPinBtn'), tools: !!document.getElementById('pickModalTools'), pins: annotationManager.marks.length,
        badge: !!document.querySelector('.pv-pin-badge'),
        round: !!document.getElementById('doneRoundBtn'), revise: !!document.getElementById('doneReviseBtn'), confirm: !!document.getElementById('doneConfirmBtn'),
        status: document.getElementById('deliveryDoneStatus')?.textContent ?? null }));
      if (who === 'owner') {
        await closeLb(page);
        await page.waitForSelector('#doneHistoryBtn', { timeout: 6000 });
        ok('positive: 標示修改, the draft pins and the badge, submit button, 確認完成 and the history button', has.toggle && has.tools && has.pins === 2 && has.badge && has.round && has.confirm && (await page.$('#doneHistoryBtn')) !== null, JSON.stringify(has));
      } else {
        await sleep(600);
        ok('no 標示修改, no tools row, no pins, no badge, no buttons; only the status line', !has.toggle && !has.tools && has.pins === 0 && !has.badge && !has.round && !has.revise && !has.confirm && has.status === '尚待選片人確認完成', JSON.stringify(has));
        ok('no history button and no draft / round route was ever called', (await page.$('#doneHistoryBtn')) === null && w.calls.length === 0, JSON.stringify(w.calls.map(c => c.path)));
        ok('no round dialog in the DOM', (await page.$('#doneRoundModal')) === null);
      }
    },
    { before: w.before, initScript: init, contextOptions: ALB_DESK });
}
{
  const w = world({ fake: { confirmedAt: '2026-09-21T03:00:00.000Z' }, drafts: SEED(), rounds: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'pins', created_at: '2026-09-22T04:00:00.000Z', photos: [{ key: K(1), pins: [pin(0.5, 0.5, 'a')] }] }] });
  await sx('finals pins — the confirmed 完成頁: no pin toggle, no layer, no badge, no history button, no calls',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#completionPage .fg-tile', { timeout: 6000 });
      ok('positive: the completion page is up with its tiles', (await page.$$('#completionPage .fg-tile')).length === 8);
      await page.click('#completionPage .fg-tile');
      await page.waitForSelector('#fgLbImg.on');
      await sleep(500);
      ok('no pin UI: the store is off, its lightbox has buttons but no 標示修改, no badge, no history entry', await page.evaluate(() => RevisionPins.enabled === false &&
        document.querySelectorAll('#fgLightbox button').length > 0 && [...document.querySelectorAll('#fgLightbox button')].every(b => !b.textContent.includes('標示')) &&
        !document.querySelector('.pv-pin-badge') && !document.getElementById('pickModalTools')) && (await page.$('#doneHistoryBtn')) === null && (await page.$('#revHistory')) === null);
      ok('the new routes were never called', w.calls.length === 0, JSON.stringify(w.calls.map(c => c.path)));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ═════ 9. history: 上一輪的修改資訊
const BAD = '<img src=x onerror=window.__pwned=1> \u202Eevil';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const histWorld = (extra = {}) => world({
  selection: { created_at: '2026-09-20T01:00:00.000Z', photos: [
    { key: K(1), pins: [pin(0.3, 0.3, '毛片標示')] }, { key: K(2), pins: [] }, { key: K(3), pins: [] }, { key: K(4), pins: [] }] },
  rounds: [
    { id: R1, kind: 'pins', created_at: '2026-09-22T04:00:00.000Z', note: BAD, photos: [
      { key: K(1), pins: [pin(0.2, 0.3, BAD), pin(0.7, 0.6, '去掉路人')] }, { key: K(2), pins: [pin(0.5, 0.5, 'b')] }] },
  ],
  missingThumbs: new Set([`${R1}:1`]),
  ...extra,
});
{
  const w = histWorld();
  await sx('finals pins — history 上一輪的修改資訊: newest round, thumbnails through fetch+blob with headers, read-only pins, hostile text inert, revoke on close',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneHistoryBtn', { timeout: 6000 });
      ok('the button says 上一輪的修改資訊', (await page.textContent('#doneHistoryBtn')).trim() === '上一輪的修改資訊');
      await page.click('#doneHistoryBtn');
      await page.waitForSelector('#revHistory .rh-photo', { timeout: 6000 });
      ok('a dialog opens on the newest round: 第 1 輪修改 · 2026/9/22', (await page.getAttribute('#revHistory', 'role')) === 'dialog' && (await page.textContent('#revHistoryTitle')) === '第 1 輪修改 · 2026/9/22', await page.textContent('#revHistoryTitle'));
      ok('the guest\'s note is text, not markup (no <img> was created, nothing ran)', (await page.textContent('#revHistoryNote')) === BAD && (await page.$('#revHistory img[onerror]')) === null && !(await page.evaluate(() => window.__pwned)));
      const bidi = await page.$eval('#revHistoryNote', e => ({ dir: e.getAttribute('dir'), ub: getComputedStyle(e).unicodeBidi }));
      ok('and isolated: dir=auto, unicode-bidi: isolate', bidi.dir === 'auto' && bidi.ub === 'isolate', JSON.stringify(bidi));
      await page.waitForFunction(() => document.querySelectorAll('#revHistory .rh-photo img').length >= 1, null, { timeout: 6000 });
      const photos = await page.$$eval('#revHistory .rh-photo', els => els.map(e => ({ i: e.dataset.i, pins: e.querySelector('.rh-pins') ? e.querySelector('.rh-pins').textContent : '', name: e.querySelector('.rh-name').textContent })));
      ok('two photos, with their pin counts and file names', photos.length === 2 && photos[0].name === 'IMG_0001.jpg' && photos[0].pins === '2' && photos[1].pins === '1', JSON.stringify(photos));
      ok('the thumbnail is a blob: URL (fetched with headers, not an <img src> to the Worker)', await page.$$eval('#revHistory .rh-photo img', els => els.length >= 1 && els.every(i => i.src.startsWith('blob:'))));
      const thumbReqs = w.calls.filter(c => c.path === `/api/pick/rounds/${R1}/photo`);
      ok('requested as ?i=&w=400 only, with token and key in headers', thumbReqs.length >= 1 && thumbReqs.every(c => c.search.includes('w=400') && !c.search.includes('1200') && /^\?i=\d+&w=400$/.test(c.search) && c.headers.token === 'TOK' && c.headers.key === 'ZOE-KEY'), JSON.stringify(thumbReqs.map(c => c.search)));
      ok('the missing thumbnail shows 照片已不在雲端', await until(async () => (await page.$$eval('#revHistory .rh-gone', els => els.map(e => e.textContent))).includes('照片已不在雲端')));
      await page.click('#revHistory .rh-photo[data-i="0"]');
      await page.waitForSelector('#rhBig', { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('rhBig').naturalWidth > 0);
      ok('one photo opens large (w=1200) with its pins read-only on it', await until(async () => (await page.$$('#revHistoryView .pin-layer-pin')).length === 2) &&
        w.calls.some(c => c.path === `/api/pick/rounds/${R1}/photo` && c.search === '?i=0&w=1200') &&
        (await page.getAttribute('#revHistoryView .pin-layer', 'data-readonly')) === 'true');
      const box = await page.$eval('#rhBig', e => { const r = PinLayer.contentRect(e); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const pinPos = await page.$$eval('#revHistoryView .pin-layer-pin', els => els.map(e => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }));
      ok('pin ① sits at 20% / 30% of the photo; ② at 70% / 60%', Math.abs(pinPos[0][0] - (box.l + 0.2 * box.w)) < 2 && Math.abs(pinPos[0][1] - (box.t + 0.3 * box.h)) < 2 && Math.abs(pinPos[1][0] - (box.l + 0.7 * box.w)) < 2, JSON.stringify([box, pinPos]));
      await page.mouse.click(box.l + box.w * 0.9, box.t + box.h * 0.9);
      await sleep(900);
      ok('tapping the photo adds nothing and saves nothing', (await page.$$('#revHistoryView .pin-layer-pin')).length === 2 && putCalls(w).length === 0);
      const notes = await page.$$eval('#revHistoryView .rh-pinnote', els => els.map(e => ({ t: e.textContent, dir: e.getAttribute('dir'), ub: getComputedStyle(e).unicodeBidi })));
      ok('the pin notes are text with dir=auto + unicode-bidi: isolate; hostile note inert', notes.length === 2 && notes[0].t === BAD && notes[0].dir === 'auto' && notes[0].ub === 'isolate' && notes[1].t === '去掉路人' && (await page.$('#revHistoryView img[onerror]')) === null);
      await page.keyboard.press('Escape');
      ok('Escape leaves the large view first, not the dialog', await until(async () => (await page.$('#revHistoryView')) === null) && (await page.$('#revHistory')) !== null);
      ok('the earlier rounds are listed (the picking round)', (await page.$$eval('#revHistory .rh-earlier', els => els.map(e => e.textContent))).some(t => t.includes('選片時的標示')));
      await page.click('#revHistory .rh-earlier');
      await page.waitForSelector('#revHistoryMore', { timeout: 5000 });
      ok('opening it: title 選片時的標示 · 2026/9/20; pinned photo first; the rest folded under 其他已選 3 張',
        await until(async () => (await page.textContent('#revHistoryTitle')) === '選片時的標示 · 2026/9/20') && (await page.$$('#revHistory .rh-photo')).length === 1 && (await page.textContent('#revHistoryMore')).includes('其他已選 3 張'), `${await page.textContent('#revHistoryTitle')}|${(await page.$$('#revHistory .rh-photo')).length}`);
      await page.click('#revHistoryMore');
      ok('expanding shows the other 3', await until(async () => (await page.$$('#revHistory .rh-photo')).length === 4));
      await page.waitForFunction(() => document.querySelectorAll('#revHistory .rh-photo img').length >= 4, null, { timeout: 6000 });
      const before = await page.evaluate(() => ({ made: window.__blobs.made.length, revoked: window.__blobs.revoked.length }));
      ok('fixture: blob URLs were made', before.made > 0, JSON.stringify(before));
      await page.click('#revHistoryClose');
      ok('closing removes the dialog from the DOM and unlocks the page', (await page.$('#revHistory')) === null && !(await page.evaluate(() => document.documentElement.classList.contains('rh-open'))));
      const after = await page.evaluate(() => ({ made: [...new Set(window.__blobs.made)], revoked: [...new Set(window.__blobs.revoked)] }));
      ok('every blob URL that was made is revoked', after.made.length > 0 && after.made.every(u => after.revoked.includes(u)), JSON.stringify({ made: after.made.length, revoked: after.revoked.length }));
      ok('focus is back on the history button', await page.evaluate(() => document.activeElement && document.activeElement.id === 'doneHistoryBtn'));
      const leak = await keyLeak(page, w);
      ok('the picker key is in no URL and no DOM attribute', !leak.dom && !leak.url, JSON.stringify(leak));
    },
    { before: w.before, initScript: SPIES + OWNER, contextOptions: ALB_DESK });
}
{
  const w = histWorld({ rounds: undefined });
  w.ctl.failNext.push({ on: 'rounds', status: 503, body: { error: 'x' } });
  await sx('finals pins — history: a failed list read still offers the button; the panel says 暫時無法載入 with a retry',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneHistoryBtn', { timeout: 6000 });
      await page.click('#doneHistoryBtn');
      ok('the panel shows 暫時無法載入 and a retry button', await until(async () => (await page.$('#revHistoryRetry')) !== null && (await page.textContent('#revHistory')).includes('暫時無法載入')));
      await page.click('#revHistoryRetry');
      ok('retrying loads the newest round (the picking round: title 選片時的標示)', await until(async () => (await page.textContent('#revHistoryTitle')).startsWith('選片時的標示')) && (await page.$('#revHistoryRetry')) === null);
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world();
  await sx('finals pins — history: no rounds at all -> no history button (positive: the pin UI is up)',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneRoundBtn', { timeout: 6000 });
      await until(() => w.calls.some(c => c.path === '/api/pick/rounds'));
      await sleep(300);
      ok('the list was read and was empty', w.calls.filter(c => c.path === '/api/pick/rounds').length >= 1);
      ok('no history button in the DOM', (await page.$('#doneHistoryBtn')) === null);
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = histWorld();
  await sx('finals pins — history on a phone: the panel fits 390px, no sideways scroll',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneHistoryBtn', { timeout: 6000 });
      await page.click('#doneHistoryBtn');
      await page.waitForSelector('#revHistory .rh-photo');
      const m = await page.evaluate(() => { const p = document.getElementById('revHistory').getBoundingClientRect(); return { pw: p.width, sw: document.getElementById('revHistory').scrollWidth, cw: document.getElementById('revHistory').clientWidth, vw: window.innerWidth }; });
      ok('the dialog is as wide as the screen and does not scroll sideways', m.pw <= m.vw + 1 && m.sw <= m.cw + 1, JSON.stringify(m));
    },
    { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ═════ 10. an open round is shown as sent: the status, and the history's default is that round
{
  const w = world({ rounds: [{ id: R2, kind: 'pins', created_at: '2026-09-23T04:00:00.000Z', open: true, note: null, photos: [{ key: K(1), pins: [pin(0.4, 0.4, '送出的標示')] }] }] });
  await sx('finals pins — a round already open at load: 已送出修改（1 張），攝影師處理中; no submit button; its pins read-only in the preview; history opens on it',
    pageUrl,
    async (page, ok) => {
      await page.waitForSelector('#doneConfirmBtn', { timeout: 6000 });
      ok('status says it was sent; 確認完成 still there; no submit button or 需要修改', (await doneStatus(page)) === '已送出修改（1 張），攝影師處理中' && (await page.$('#doneRoundBtn')) === null && (await page.$('#doneReviseBtn')) === null);
      await openLb(page, 1);
      ok('photo 1 shows the sent pin, read-only, with its note listed', await until(async () => (await pinsOnScreen(page)).length === 1) && (await page.$('#pickPinBtn')) === null &&
        await until(async () => (await page.$$eval('#pickPinList .pick-pin-note', els => els.map(e => e.readOnly ? e.value : '!'))).join() === '送出的標示'));
      await page.click('#nextPhotoBtn');
      await page.waitForFunction(() => document.getElementById('photoCounter').textContent.startsWith('2 /'));
      ok('positive/negative: photo 2 has no pins and offers none', (await pinsOnScreen(page)).length === 0 && (await page.$('#pickPinBtn')) === null);
      await closeLb(page);
      await page.click('#doneHistoryBtn');
      ok('the history opens on that round', await until(async () => (await page.textContent('#revHistoryTitle')).startsWith('第 1 輪修改')));
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

}
