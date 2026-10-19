// Browser suites: retouch pins on the 驗收頁 in the standard preview — the same 標示修改 / 完成 / note editor /
// 備註・標示 list as the 毛片 page, stored as revision drafts (PUT /api/pick/revision-pins, never the selections),
// placed correctly under zoom, read-only while a sent round is open; none for a viewer or before the migration
// (docs/delivery.md, "The 驗收頁 is the 毛片 page"; docs/revision-pins.md).
import { suite } from '../lib/harness.mjs';
import { MOBILE, realTouch } from '../lib/env.mjs';
import { ALB_DESK } from '../lib/album-world.mjs';
import { donePosts } from '../lib/delivery-helpers.mjs';
import { RS_OWNER, rsUrl, rsKey, rsPin, rsWorld, rsLine, rsOpen, rsHas, rsSleep, rsUntil, rsPuts, rsPoint, rsMarks } from '../lib/review-stage.mjs';

export default async function register() {
  const sx = (name, url, run, opts) => suite(name, url, async page => {
    const out = [], ok = rsLine(out);
    try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
    return out;
  }, opts);
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
  const selPuts = w => w.m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
  const clickAt = async (page, fx, fy) => { const p = await rsPoint(page, fx, fy); await page.mouse.click(p.x, p.y); return p; };

  // ═════ 1. place, note, delete, autosave, zoom, badge, reload
  {
    const w = rsWorld();
    await sx('驗收頁 pins (1280px) — 標示修改 in the standard preview: taps place pins at the fraction (also zoomed), notes autosave as drafts, badge, reload',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        ok('positive: 標示修改 is there without any ♥, and the 備註・標示 panel button', (await page.textContent('#pickPinBtn')) === '標示修改' && await rsHas(page, '#pickPanelBtn'));
        ok('the pin list says there are none yet', (await page.textContent('#pickPinsSection')).includes('尚無標示'));
        await page.click('#pickPinBtn');
        ok('pin mode: 完成 replaces 標示修改, the hint says 0/10', await rsHas(page, '#pickPinDoneBtn') && !(await rsHas(page, '#pickPinBtn')) &&
          (await page.textContent('#pickPinHint')).includes('已標 0/10'));
        await clickAt(page, 0.25, 0.4);
        let marks = await rsMarks(page);
        ok('a click places ① at that fraction of the photo', marks.length === 1 && near(marks[0].x, 0.25) && near(marks[0].y, 0.4), JSON.stringify(marks));
        ok('the note editor opens on it, focused', await page.evaluate(() => document.activeElement && document.activeElement.id === 'pickPinEditorInput'));
        await page.keyboard.type('去掉路人');
        await page.keyboard.press('Enter');
        ok('Enter closes the editor; the list row has the note', !(await rsHas(page, '#pickPinEditor')) &&
          (await page.$$eval('#pickPinList .pick-pin-note', els => els.map(e => e.value))).join() === '去掉路人');
        ok('nothing sent yet (debounced)', rsPuts(w).length === 0);
        ok('one autosave lands as a revision draft', await rsUntil(() => w.drafts().has(rsKey(1))) && w.drafts().get(rsKey(1))[0].note === '去掉路人', JSON.stringify([...w.drafts()]));
        const put = rsPuts(w).pop();
        ok('PUT /api/pick/revision-pins with the full list, credentials in headers only', put.body.items[0].photo_key === rsKey(1) && put.body.items[0].marks.length === 1 &&
          put.headers.token === 'TOK' && put.headers.key === 'ZOE-KEY' && !put.url.includes('?'), JSON.stringify(put));
        ok('the selections are never written (no PUT /api/pick/selections)', selPuts(w).length === 0, String(selPuts(w).length));
        // zoomed: the pin still lands on the photo point under the pointer
        await page.click('#zoomInBtn'); await page.click('#zoomInBtn'); await page.click('#zoomInBtn');
        const z = await page.evaluate(() => annotationManager.zoom);
        ok('fixture: zoomed in', z > 1.5, String(z));
        await clickAt(page, 0.5, 0.5);
        marks = await rsMarks(page);
        ok('zoomed: ② lands at (0.5, 0.5) of the photo', marks.length === 2 && near(marks[1].x, 0.5) && near(marks[1].y, 0.5), JSON.stringify(marks));
        await page.keyboard.press('Enter');
        await page.click('#zoomResetBtn');
        ok('the list has 2 rows numbered 1, 2', (await page.$$eval('#pickPinList .pick-pin-num', els => els.map(e => e.textContent))).join() === '1,2');
        await page.click('#pickPinList .pick-pin-item:nth-child(2) .pick-pin-del');
        ok('× removes ②', (await rsMarks(page)).length === 1 && (await page.$$('#pickPinList .pick-pin-item')).length === 1);
        await page.click('#pickPinDoneBtn');
        ok('完成 leaves pin mode', await rsHas(page, '#pickPinBtn') && !(await rsHas(page, '#pickPinHint')) && await page.evaluate(() => annotationManager.pinMode === false));
        await clickAt(page, 0.8, 0.8);
        ok('outside pin mode a click adds nothing', (await rsMarks(page)).length === 1);
        const before = rsPuts(w).length;
        await page.keyboard.press('Escape');
        await rsSleep(250);
        ok('closing the preview sends the pending edit at once (not after the 600 ms debounce)', rsPuts(w).length === before + 1, `${before} -> ${rsPuts(w).length}`);
        ok('closing saves what is left (one pin on photo 1)', await rsUntil(() => w.drafts().has(rsKey(1)) && w.drafts().get(rsKey(1)).length === 1));
        const badges = await page.$$eval('.photo-card .pv-pin-badge', els => els.map(e => [e.closest('.photo-card').dataset.photoId, e.textContent.replace(/\D/g, '')]));
        ok('the card of photo 1 wears a pin badge with its count; no other card does', JSON.stringify(badges) === JSON.stringify([[rsKey(1), '1']]), JSON.stringify(badges));
        await page.reload({ waitUntil: 'load' });
        await rsOpen(page, 1);
        marks = await rsMarks(page);
        ok('after a reload the draft is back on the canvas, with its note', marks.length === 1 && marks[0].note === '去掉路人', JSON.stringify(marks));
        await page.click('#nextPhotoBtn');
        await page.waitForFunction(() => document.getElementById('photoCounter').textContent === '2 / 8');
        ok('photo 2 has none and still offers 標示修改', (await rsMarks(page)).length === 0 && await rsHas(page, '#pickPinBtn'));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  // ═════ 2. a phone: a real finger tap places a pin; a swipe in pin mode does not flip
  {
    const w = rsWorld();
    await sx('驗收頁 pins (390px) — a real tap places a pin; pin mode keeps the photo (no swipe); the controls are ≥44px',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        const t = await realTouch(page);
        const h = await page.$eval('#pickPinBtn', b => b.getBoundingClientRect().height);
        ok('標示修改 is at least 44px tall', h >= 44, String(h));
        await page.locator('#pickPinBtn').tap();
        const p = await rsPoint(page, 0.5, 0.5);
        await t.tap(p.x, p.y);
        await rsSleep(120);
        const marks = await rsMarks(page);
        ok('a finger tap placed ① at the middle of the photo', marks.length === 1 && near(marks[0].x, 0.5) && near(marks[0].y, 0.5), JSON.stringify(marks));
        await page.locator('#pickPinEditorOk').tap();
        await t.drag(300, 400, 80, 400);
        await rsSleep(200);
        ok('in pin mode a swipe does not change the photo', (await page.textContent('#photoCounter')) === '1 / 8');
        await page.locator('#pickPinDoneBtn').tap();
        await t.drag(300, 400, 80, 400);
        ok('positive: out of pin mode the same swipe goes to photo 2', await rsUntil(async () => (await page.textContent('#photoCounter')) === '2 / 8'));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: MOBILE });
  }

  // ═════ 2b. a save that does not go through says so inside the preview (the strip is under it)
  {
    const w = rsWorld();
    await sx('驗收頁 pins — autosave: offline / 5xx says 尚未儲存 in the preview and retries; a 4xx shows its message and stops',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        await page.click('#pickPinBtn');
        w.ctl.failNext.push({ on: 'put', net: true }, { on: 'put', status: 503, body: { error: 'x' } });
        await clickAt(page, 0.3, 0.3);
        await page.keyboard.press('Enter');
        ok('the preview says it is not saved yet', await rsUntil(async () => ((await page.textContent('#rpStatus').catch(() => '')) || '').includes('尚未儲存，連線後會自動送出')));
        ok('it is inside the photo area, marked offline (it will be resent)', await rsHas(page, '.canvas-container #rpStatus[data-kind="offline"]'));
        ok('it retries by itself and the draft lands', await rsUntil(() => w.drafts().has(rsKey(1)), 8000), String(rsPuts(w).length));
        ok('the line goes once saved', await rsUntil(async () => !(await rsHas(page, '#rpStatus'))));
        const n = rsPuts(w).length;
        w.ctl.failNext.push({ on: 'put', status: 400, body: { code: 'invalid_marks' } });
        await clickAt(page, 0.6, 0.6);
        await page.keyboard.press('Enter');
        ok('a 4xx: its message is shown, marked as an error', await rsUntil(async () => ((await page.textContent('#rpStatus').catch(() => '')) || '').includes('標示內容不正確')) &&
          await rsHas(page, '#rpStatus[data-kind="error"]'));
        await rsSleep(1500);
        ok('and it is not retried by itself', rsPuts(w).length === n + 1, String(rsPuts(w).length - n));
      },
      { before: w.before, initScript: `window.REVISION_PINS_RETRY_MS = 400;${RS_OWNER}`, contextOptions: ALB_DESK });
  }

  // ═════ 3. a sent round is open: its pins read-only, nothing editable
  {
    const R = '00000000-0000-4000-8000-0000000000b1';
    const w = rsWorld({ rounds: [{ id: R, kind: 'pins', created_at: '2026-09-23T04:00:00.000Z', open: true, note: null, photos: [{ key: rsKey(1), pins: [rsPin(0.4, 0.4, '送出的標示')] }] }] });
    // the round's pins answer late (1.5 s): the preview is already open when they arrive and must show them then
    const before = async page => {
      await w.before(page);
      await page.route(`**/api/pick/rounds/${R}`, async route => { await rsSleep(1500); return route.fallback(); });
    };
    await sx('驗收頁 pins — a round already sent: its pins on the canvas (also when they arrive after the preview opened), read-only; no 標示修改, no PUT',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        ok('fixture: the preview opened before the round\'s pins arrived', (await rsMarks(page)).length === 0);
        ok('the sent pin of photo 1 is painted on the canvas once they arrive', await rsUntil(async () => (await rsMarks(page)).length === 1));
        ok('no 標示修改 (a sent round is frozen)', !(await rsHas(page, '#pickPinBtn')) && !(await rsHas(page, '#pickPinDoneBtn')));
        const list = await page.$$eval('#pickPinList .pick-pin-note', els => els.map(e => ({ v: e.value, ro: e.readOnly })));
        ok('the list shows its note, read-only, with no ×', list.length === 1 && list[0].v === '送出的標示' && list[0].ro && !(await rsHas(page, '#pickPinList .pick-pin-del')), JSON.stringify(list));
        await clickAt(page, 0.8, 0.8);
        await rsSleep(800);
        ok('a click adds nothing and saves nothing', (await rsMarks(page)).length === 1 && rsPuts(w).length === 0);
      },
      { before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }

  // ═════ 4. what must not exist
  {
    const w = rsWorld({ drafts: [{ photo_key: rsKey(1), marks: [rsPin(0.5, 0.5, 'a')] }] });
    await sx('驗收頁 pins — a viewer: no tools row, no pins, no badge, no call to the draft routes',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        await rsSleep(400);
        ok('positive: the preview is open', await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')));
        ok('no tools row, no 標示修改, no pin list', !(await rsHas(page, '#pickModalTools')) && !(await rsHas(page, '#pickPinBtn')) && !(await rsHas(page, '#pickPinsSection')));
        ok('no pins on the canvas, no badge on the cards', (await rsMarks(page)).length === 0 && !(await rsHas(page, '.pv-pin-badge')));
        ok('the draft / round routes were never called', w.calls.length === 0, JSON.stringify(w.calls.map(c => c.path)));
      },
      { before: w.before, initScript: '', contextOptions: ALB_DESK });
  }
  {
    const w = rsWorld({ migrated: false });
    await sx('驗收頁 pins — migration not run: no pin tools; the old 需要修改 text request still works',
      rsUrl,
      async (page, ok) => {
        await rsOpen(page, 1);
        ok('no tools row, no 標示修改', !(await rsHas(page, '#pickModalTools')) && !(await rsHas(page, '#pickPinBtn')));
        await page.keyboard.press('Escape');
        ok('positive: 需要修改 is offered', await rsHas(page, '#doneReviseBtn'));
        await page.click('#doneReviseBtn');
        await page.fill('#doneReviseText', '請把 1 調亮');
        await page.click('#doneReviseSubmit');
        ok('the text request goes to the old route', await rsUntil(() => donePosts(w.m, 'revision').length === 1) && donePosts(w.m, 'revision')[0].body.message === '請把 1 調亮');
        ok('the new routes were never called', w.calls.length === 0, JSON.stringify(w.calls.map(c => c.path)));
      },
      { before: w.before, initScript: RS_OWNER, contextOptions: ALB_DESK });
  }
}
