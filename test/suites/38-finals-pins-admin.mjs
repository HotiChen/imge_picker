// Browser suites: pins on the delivered finals, PHOTOGRAPHER side (docs/revision-pins.md §4.6, §6.2, §13.1):
// admin.html's round list (kind, photo count, the client's note or the "no note" line, open / handled),
// the read-only pin overlay on thumbnails and in the 1200 modal, 下載此輪需求表 (CSV), and the review view
// (index.html?project=) showing the same rounds. The fake Worker mirrors GET /api/admin/projects/:id with
// the new revision_requests fields (test/lib/pick-fake.mjs) and the SVG photos of test/lib/album-world.mjs.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { albumWorld, albKeys } from '../lib/album-world.mjs';
import { RP_AUTO_MESSAGE } from '../lib/revision-pins-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, url, run, opts) => suite(name, url, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const K = i => albKeys(8)[i - 1];                       // shoot/精修/IMG_000i.jpg
const pin = (x, y, note = '') => ({ x, y, note });
const AUTO_LINE = '客人未留言，請見照片標示';
const ADMIN_URL = `${base}/admin.html#project=proj-1`;
const REVIEW_URL = `${base}/index.html?project=proj-1`;
const EVIL = '<img src=x onerror="window.__pwned=1"><b>x</b>‮evil';

// the rows of GET /api/admin/projects/:id → revision_requests (oldest first here; the fake serves newest first)
const textRound = (o = {}) => ({ id: 'r-text', kind: 'text', message: '舊式：背景路人', picker_id: 'picker-0', created_at: '2026-09-20T02:00:00.000Z', resolved_at: '2026-09-21T01:00:00.000Z', ...o });
const pinsRound = (o = {}) => ({
  id: 'r-pins', kind: 'pins', picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z', resolved_at: null,
  finals: ['shoot/精修/'], message_auto: false, message: '整體再亮一點',
  marks: { [K(1)]: [pin(0.25, 0.4, '痘痘'), pin(0.7, 0.6, '')], [K(2)]: [pin(0.5, 0.5, '=HYPERLINK("x")')] }, ...o });
const autoRound = (o = {}) => pinsRound({ id: 'r-auto', created_at: '2026-09-23T04:00:00.000Z', message_auto: true, message: RP_AUTO_MESSAGE,
  marks: { [K(3)]: [pin(0.1, 0.9, '衣角')] }, ...o });
const world = (revisions, o = {}) => albumWorld({ n: 8, ...o, fake: { title: '婚禮精修', revisions, ...(o.fake || {}) } });
// the world's setup plus a record of the Authorization header and URL of every image request, and blob spies
const spied = w => {
  const reqs = [];
  return {
    reqs,
    before: async page => {
      page.on('request', r => { const u = new URL(r.url()); if (r.method() === 'GET' && u.pathname.includes('IMG_')) reqs.push({ path: decodeURIComponent(u.pathname), w: u.searchParams.get('w'), search: u.search, auth: r.headers().authorization || null }); });
      await w.before(page);
    },
  };
};
const BLOB_SPY = `(() => {
  window.__blobs = { made: [], revoked: [] };
  const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = o => { const u = mk(o); window.__blobs.made.push(u); return u; };
  URL.revokeObjectURL = u => { window.__blobs.revoked.push(u); return rv(u); };
})();`;
const initAdmin = `(${ADMIN.toString()})();${BLOB_SPY}`;

const cards = page => page.$$eval('#pd-revisions .pd-rev', els => els.map(e => ({
  meta: e.querySelector('.pd-rev-meta')?.textContent ?? '', msg: e.querySelector('.pd-rev-msg')?.textContent ?? '',
  resolved: e.classList.contains('resolved'), done: e.querySelector('.pd-rev-done')?.textContent ?? null,
  photos: e.querySelectorAll('.rrv-photos').length, rows: e.querySelectorAll('.rrv-photo').length,
  auto: !!e.querySelector('.rrv-auto'), csv: !!e.querySelector('.rrv-csv'), id: e.dataset.roundId || null })));
const waitCards = page => page.waitForSelector('#pd-revisions .pd-rev', { timeout: 6000 });
const openPhotos = async (page, id) => {
  await page.evaluate(i => { const d = document.querySelector(`#pd-revisions .pd-rev[data-round-id="${i}"] .rrv-photos`); d.open = true; d.dispatchEvent(new Event('toggle')); }, id);
};
const imgsLoaded = (page, sel, n) => page.waitForFunction(([s, c]) => { const l = [...document.querySelectorAll(s)]; return l.length >= c && l.every(i => i.complete && i.naturalWidth > 0); }, [sel, n], { timeout: 6000 });
// pins on screen inside a root: {n, cx, cy, label}
const pinsIn = (page, sel) => page.$$eval(`${sel} .pin-layer-pin`, els => els.map(e => { const b = e.getBoundingClientRect(); return { n: e.textContent, cx: b.left + b.width / 2, cy: b.top + b.height / 2, label: e.getAttribute('aria-label') }; }));

// ═════ 1. the round list in admin.html
{
  const w = world([textRound(), pinsRound(), autoRound({ resolved_at: '2026-09-24T01:00:00.000Z' })]);
  await sx('finals pins admin — round list: kind, photo count, time, note / no-note line, open or handled; the text round is unchanged',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      const c = await cards(page);
      ok('three rounds, newest first (auto, pins, text)', c.length === 3 && c[0].id === 'r-auto' && c[1].id === 'r-pins' && c[2].id === 'r-text', JSON.stringify(c.map(x => x.id)));
      ok('the auto round: kind 標示, 1 張, the "no note" line (not the Worker\'s fixed string), handled',
        /標示/.test(c[0].meta) && /1 張/.test(c[0].meta) && c[0].msg === AUTO_LINE && !c[0].msg.includes(RP_AUTO_MESSAGE) && c[0].auto && c[0].resolved && c[0].done === '已處理', JSON.stringify(c[0]));
      ok('the pins round: kind 標示, 2 張, time (Taipei), the client\'s own note, open (no 已處理, no .resolved)',
        /標示/.test(c[1].meta) && /2 張/.test(c[1].meta) && /9\/22 12:00/.test(c[1].meta) && /Zoe/.test(c[1].meta) && c[1].msg === '整體再亮一點' && !c[1].auto && !c[1].resolved && c[1].done === null, JSON.stringify(c[1]));
      ok('the open round says 未處理 in its meta, the handled one does not', /未處理/.test(c[1].meta) && !/未處理/.test(c[0].meta) && !/未處理/.test(c[2].meta), JSON.stringify(c.map(x => x.meta)));
      ok('the text round: kind 文字, its message as before, no photo block, no CSV button, handled',
        /文字/.test(c[2].meta) && c[2].msg === '舊式：背景路人' && c[2].photos === 0 && !c[2].csv && c[2].resolved && c[2].done === '已處理', JSON.stringify(c[2]));
      ok('positive: both pins rounds have a photo block and a CSV button', c[0].photos === 1 && c[1].photos === 1 && c[0].csv && c[1].csv);
      ok('rounds are numbered oldest = 1: 第 3 輪 / 第 2 輪 / 第 1 輪', /第 3 輪/.test(c[0].meta) && /第 2 輪/.test(c[1].meta) && /第 1 輪/.test(c[2].meta), JSON.stringify(c.map(x => x.meta)));
      ok('the 請上傳新版精修資料夾 hint stays while a round is open', /請上傳新版精修資料夾後按「更換精修資料夾」/.test(await page.textContent('#pd-revision-hint')));
      ok('the status colours still work: the handled card is dashed, the open one is not',
        await page.$eval('#pd-revisions .pd-rev.resolved', e => getComputedStyle(e).borderStyle === 'dashed') && await page.$eval('#pd-revisions .pd-rev:not(.resolved)', e => getComputedStyle(e).borderStyle !== 'dashed'));
    },
    { before: w.before, initScript: initAdmin, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

// ═════ 2. old shape (no kind at all) and a text-only history: nothing new appears
{
  const w = world([{ id: 'old', message: '最舊的要求', picker_id: 'picker-0', created_at: '2026-09-20T02:00:00.000Z' }]);
  // an old Worker answers none of the new fields: strip them from the fake's row (JSON drops undefined)
  for (const r of w.m.state.revisions) { r.kind = undefined; r.marks = undefined; r.finals = undefined; r.message_auto = undefined; r.photo_count = undefined; }
  await sx('finals pins admin — a request row from before the feature (no kind) is shown as text, with no photo block',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      const served = await page.evaluate(async () => (await (await fetch('https://imagepicker.hotichen.workers.dev/api/admin/projects/proj-1', { headers: { Authorization: 'Bearer adm' } })).json()).revision_requests[0]);
      ok('precondition: the Worker answer carries none of kind / marks / finals / message_auto / photo_count', !('kind' in served) && !('marks' in served) && !('message_auto' in served) && !('photo_count' in served), JSON.stringify(served));
      const c = await cards(page);
      ok('one item, its message, kind 文字, no photo block, no CSV', c.length === 1 && c[0].msg === '最舊的要求' && /文字/.test(c[0].meta) && c[0].photos === 0 && !c[0].csv, JSON.stringify(c));
      ok('no layer and no modal element', (await page.$$('#pd-revisions .pin-layer, #rrvModal')).length === 0);
    },
    { before: w.before, initScript: initAdmin });
}

// ═════ 3. guest strings are text; bidi characters are isolated
{
  const w = world([pinsRound({ message: EVIL, marks: { [K(1)]: [pin(0.3, 0.3, EVIL)] } })]);
  await sx('finals pins admin — the client\'s note, pin notes and name are plain text with dir=auto and unicode-bidi isolate',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      await openPhotos(page, 'r-pins');
      await page.waitForSelector('#pd-revisions .rrv-pins li', { timeout: 4000 });
      const r = await page.evaluate(() => {
        const msg = document.querySelector('#pd-revisions .pd-rev-msg');
        const note = document.querySelector('#pd-revisions .rrv-pins li .rrv-text');
        const name = document.querySelector('#pd-revisions .pd-rev-meta [dir]');
        return { msg: msg.textContent, msgDir: msg.getAttribute('dir'), msgBidi: getComputedStyle(msg).unicodeBidi,
          note: note && note.textContent, noteDir: note && note.getAttribute('dir'), noteBidi: note && getComputedStyle(note).unicodeBidi,
          nameDir: name && name.getAttribute('dir'), nameBidi: name && getComputedStyle(name).unicodeBidi,
          kids: document.querySelectorAll('#pd-revisions img[src="x"], #pd-revisions b').length, pwned: window.__pwned ?? null };
      });
      ok('the note is literal text (markup and the RLO character kept as characters)', r.msg === EVIL && r.note === EVIL, JSON.stringify(r));
      ok('note and pin note carry dir=auto and unicode-bidi: isolate', r.msgDir === 'auto' && r.noteDir === 'auto' && /isolate/.test(r.msgBidi) && /isolate/.test(r.noteBidi), JSON.stringify(r));
      ok('the picker name is isolated too', r.nameDir === 'auto' && /isolate/.test(r.nameBidi), JSON.stringify(r));
      ok('no element came out of the strings, nothing ran', r.kids === 0 && r.pwned === null, JSON.stringify(r));
    },
    { before: w.before, initScript: initAdmin });
}

// ═════ 4. thumbnails with the read-only overlay; the modal
{
  const w = world([pinsRound()]);
  const sp = spied(w);
  await sx('finals pins admin — a round\'s photos: thumbnails read with the admin credential, read-only pins on the right spots, notes ①②, a 1200 modal',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      ok('an open round\'s photo block is unfolded (a <details>), so the photographer sees where to retouch at once', await page.$eval('#pd-revisions .rrv-photos', d => d.tagName === 'DETAILS' && d.open === true));
      await imgsLoaded(page, '#pd-revisions .rrv-thumb img', 2);
      ok('every thumbnail was read with Authorization: Bearer <admin> and ?w=400, never with a token in the URL',
        sp.reqs.filter(r => r.w === '400').length === 2 && sp.reqs.every(r => r.auth === 'Bearer adm' && !/[?&]t=/.test(r.search)), JSON.stringify(sp.reqs));
      ok('the two photos are the round\'s own, in key order', JSON.stringify(sp.reqs.map(r => r.path.split('/').pop()).sort()) === JSON.stringify(['IMG_0001.jpg', 'IMG_0002.jpg']), JSON.stringify(sp.reqs));
      const rows = await page.$$eval('#pd-revisions .rrv-photo', els => els.map(e => ({ name: e.querySelector('.rrv-name').textContent, notes: [...e.querySelectorAll('.rrv-pins li')].map(li => li.textContent), pins: e.querySelectorAll('.pin-layer-pin').length })));
      ok('row 1: file name, 2 pins, notes ①痘痘 and ②(empty note still numbered)', rows[0].name === 'IMG_0001.jpg' && rows[0].pins === 2 && /^①.*痘痘/.test(rows[0].notes[0]) && /^②/.test(rows[0].notes[1]), JSON.stringify(rows[0]));
      ok('row 2: one pin whose note keeps its leading = as text', rows[1].pins === 1 && rows[1].notes[0].includes('=HYPERLINK("x")'), JSON.stringify(rows[1]));
      ok('the overlay is read-only', await page.$$eval('#pd-revisions .pin-layer', ls => ls.length === 2 && ls.every(l => l.dataset.readonly === 'true' && !l.classList.contains('pin-layer--edit'))));
      const geo = await page.evaluate(() => {
        const img = document.querySelector('#pd-revisions .rrv-photo img'); const r = PinLayer.contentRect(img);
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      const pins = await pinsIn(page, '#pd-revisions .rrv-photo:first-child');
      ok('pin ① sits at 25% / 40% of the PHOTO (within 2px), pin ② at 70% / 60%',
        pins.length === 2 && Math.abs(pins[0].cx - (geo.left + 0.25 * geo.width)) < 2 && Math.abs(pins[0].cy - (geo.top + 0.4 * geo.height)) < 2
        && Math.abs(pins[1].cx - (geo.left + 0.7 * geo.width)) < 2 && Math.abs(pins[1].cy - (geo.top + 0.6 * geo.height)) < 2, JSON.stringify([pins, geo]));
      // click the thumbnail → modal with the 1200 image
      await page.click('#pd-revisions .rrv-photo:first-child .rrv-thumb');
      await page.waitForSelector('#rrvModal', { timeout: 3000 });
      await page.waitForFunction(() => { const i = document.getElementById('rrvModalImg'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      ok('the modal asked for ?w=1200 with the admin credential', sp.reqs.some(r => r.w === '1200' && r.auth === 'Bearer adm' && r.path.endsWith('IMG_0001.jpg')), JSON.stringify(sp.reqs));
      const mp = await pinsIn(page, '#rrvModal');
      ok('the modal draws both pins (read-only) and lists the notes', mp.length === 2 && (await page.$$eval('#rrvModal .rrv-pins li', l => l.length)) === 2 && await page.$eval('#rrvModal .pin-layer', l => l.dataset.readonly === 'true'));
      ok('the modal is a labelled dialog and the close button has the focus', await page.evaluate(() => { const m = document.getElementById('rrvModal'); return m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true' && !!m.getAttribute('aria-label') && m.contains(document.activeElement); }));
      await page.keyboard.press('Escape');
      await sleep(80);
      ok('Escape closes it (removed from the DOM) and its blob was revoked', (await page.$('#rrvModal')) === null && await page.evaluate(() => window.__blobs.revoked.length >= 1));
      await page.click('#pd-revisions .rrv-photo:first-child .rrv-thumb');
      await page.waitForSelector('#rrvModal');
      await page.click('#rrvModal .rrv-modal-close');
      ok('the close button closes it too', (await page.$('#rrvModal')) === null);
      ok('nothing was written to the Worker: every request was a GET (or the preflight)', w.m.requests.filter(r => !['GET', 'OPTIONS'].includes(r.method)).length === 0, JSON.stringify(w.m.requests.filter(r => r.method !== 'GET').map(r => r.method + r.path)));
    },
    { before: sp.before, initScript: initAdmin, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

// ═════ 5. a handled round starts closed and loads nothing until opened; a missing photo says so
{
  const w = world([pinsRound({ resolved_at: '2026-09-23T00:00:00.000Z' })]);
  const sp = spied(w);
  await sx('finals pins admin — a handled round stays folded (no image read) until opened; a photo that cannot be read says so',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      ok('folded, nothing requested', await page.$eval('#pd-revisions .rrv-photos', d => d.open === false) && sp.reqs.length === 0, JSON.stringify(sp.reqs));
      w.ctl.failImages = true;
      await page.click('#pd-revisions .rrv-photos > summary');
      await page.waitForSelector('#pd-revisions .rrv-thumb .rrv-fail', { timeout: 5000 });
      ok('each failed thumbnail shows 無法載入, the pins list is still there', (await page.$$('#pd-revisions .rrv-fail')).length === 2 && (await page.$$('#pd-revisions .rrv-pins li')).length === 3);
      ok('summary says how many photos', /2 張/.test(await page.textContent('#pd-revisions .rrv-photos > summary')));
    },
    { before: sp.before, initScript: initAdmin });
}

// ═════ 6. the CSV: pure function, the download, an old selection CSV unchanged
{
  const w = world([pinsRound({ marks: { [K(2)]: [pin(0.5, 0.25, '=cmd|x'), pin(0.1, 0.2, '"quoted", comma')], [K(1)]: [pin(0.25, 0.4, '@sum'), pin(0.7, 0.6, '')] } })]);
  await sx('finals pins admin — 下載此輪需求表 (CSV): BOM, one row per pin, formulas neutralised; the picks CSV is untouched',
    ADMIN_URL,
    async (page, ok) => {
      await waitCards(page);
      ok('revisionToCsv exists on SelectionExport (the pure function)', (await page.evaluate(() => typeof window.SelectionExport.revisionToCsv)) === 'function');
      // a blob: download's real name does not come back from suggestedFilename() in headless Chromium
      // (test/suites/09), so the anchor's own `download` attribute is captured
      await page.evaluate(() => {
        window.__dlName = null;
        const orig = document.body.appendChild.bind(document.body);
        document.body.appendChild = e => { if (e.tagName === 'A' && e.download) window.__dlName = e.download; return orig(e); };
      });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#pd-revisions .rrv-csv')]);
      const dlName = await page.evaluate(() => window.__dlName);
      const text = (await (await import('node:fs/promises')).readFile(await dl.path())).toString('utf8');
      ok('the file name names the project and the round (.csv)', dlName === '婚禮精修-修改第1輪.csv', String(dlName));
      ok('starts with the UTF-8 BOM (EF BB BF)', text.charCodeAt(0) === 0xFEFF);
      const rows = text.slice(1).split('\r\n');
      ok('header: 檔名,標示,x,y,備註,總說明', rows[0] === '檔名,標示,x,y,備註,總說明', rows[0]);
      ok('files in key order, pins numbered 1.., x and y as the stored fractions, the file name only (no folder)',
        rows[1].startsWith('IMG_0001.jpg,1,0.25,0.4,') && rows[2].startsWith('IMG_0001.jpg,2,0.7,0.6,') && rows[3].startsWith('IMG_0002.jpg,1,0.5,0.25,') && rows[4].startsWith('IMG_0002.jpg,2,0.1,0.2,'), JSON.stringify(rows));
      ok('a note starting with = or @ gets a leading apostrophe; a quoted comma note is quoted and its quotes doubled',
        rows[1].includes(",'@sum,") && rows[3].includes(",'=cmd|x,") && rows[4].includes('"""quoted"", comma"'), JSON.stringify(rows));
      ok('the bare pin keeps its row with an empty note', /^IMG_0001\.jpg,2,0\.7,0\.6,(,|$)/.test(rows[2]), rows[2]);
      ok('the client\'s overall note is on the first data row only', rows[1].endsWith(',整體再亮一點') && !rows[2].includes('整體再亮一點') && !rows[3].includes('整體再亮一點'), JSON.stringify(rows));
      ok('ends with CRLF (a trailing empty element)', rows[rows.length - 1] === '' && rows.length === 6, JSON.stringify(rows));
      const same = await page.evaluate(() => window.SelectionExport.selectionsToCsv([{ photo_key: 'a/b.jpg', note: '=x', marks: [{ x: 0.1, y: 0.2, note: '亮' }, { x: 0.3, y: 0.4, note: '' }] }]));
      ok('the picks CSV (selectionsToCsv) is byte for byte what it was', same === '﻿檔名,備註,標示\r\n' + `a/b.jpg,'=x,①亮 ②\r\n`, JSON.stringify(same));
      const auto = await page.evaluate(() => window.SelectionExport.revisionToCsv({ message: '請見照片上的標示', message_auto: true, marks: { 'a/b/x.jpg': [{ x: 0.5, y: 0.5, note: 'n' }] } }));
      ok('a message_auto round puts nothing in 總說明 (the fixed Worker string is not the client\'s words)', !auto.includes('請見照片上的標示') && auto.endsWith('x.jpg,1,0.5,0.5,n,\r\n'), JSON.stringify(auto));
    },
    { before: w.before, initScript: initAdmin });
}

// ═════ 7. the review view shows the same rounds
{
  const w = world([textRound(), pinsRound(), autoRound({ resolved_at: '2026-09-24T01:00:00.000Z' })]);
  const sp = spied(w);
  await sx('finals pins admin — review view (index.html?project=): the pins rounds with thumbnails and read-only pins; the proof grid still works',
    REVIEW_URL,
    async (page, ok) => {
      await page.waitForSelector('#pvRevisions .rrv-card', { timeout: 6000 });
      const c = await page.$$eval('#pvRevisions .rrv-card', els => els.map(e => ({ id: e.dataset.roundId, meta: e.querySelector('.pd-rev-meta')?.textContent, msg: e.querySelector('.pd-rev-msg')?.textContent })));
      ok('the two pins rounds are listed (newest first); the text round is not (it has no photos to look at)', c.length === 2 && c[0].id === 'r-auto' && c[1].id === 'r-pins', JSON.stringify(c));
      ok('the note and the no-note line are shown like in admin.html', c[0].msg === AUTO_LINE && c[1].msg === '整體再亮一點', JSON.stringify(c));
      await imgsLoaded(page, '#pvRevisions .rrv-photos[open] .rrv-thumb img', 2);
      ok('thumbnails were read with the admin credential, never a token in the URL', sp.reqs.filter(r => r.w === '400' && r.auth === 'Bearer adm').length >= 2 && sp.reqs.every(r => !/[?&]t=/.test(r.search)), JSON.stringify(sp.reqs));
      const pins = await pinsIn(page, '#pvRevisions .rrv-photo:first-child');
      ok('the pins of the open round are drawn over its first photo, read-only', pins.length === 2 && await page.$eval('#pvRevisions .pin-layer', l => l.dataset.readonly === 'true'), JSON.stringify(pins));
      ok('the review banner is still there', await page.evaluate(() => !document.getElementById('projectViewBanner').hidden));
      ok('the section is above the photo grid, below the banner', await page.evaluate(() => { const s = document.getElementById('pvRevisions'), b = document.getElementById('projectViewBanner'); return !!(b.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    },
    { before: sp.before, initScript: initAdmin, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

// ═════ 8. review view with no pins round: nothing extra, the pins of the picks still work
{
  const w = world([textRound()]);
  await sx('finals pins admin — review view with only a text round: no revisions section at all',
    REVIEW_URL,
    async (page, ok) => {
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 6000 });
      await sleep(300);
      ok('no #pvRevisions section and no round card', (await page.$('#pvRevisions')) === null && (await page.$('.rrv-card')) === null);
    },
    { before: w.before, initScript: initAdmin });
}

}
