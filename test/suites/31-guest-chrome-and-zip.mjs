// Browser suites: photographer-only chrome hidden on share-link pages (logout, avatar), and the
// review view's zip download (file name, unique names inside the zip, count toast, 下載選取 hidden).
// Registered by test/run.mjs in file-name order; see test/README.md.
import fs from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

// What an element looks like to a person: computed display (not the hidden attribute, not mere
// presence in the DOM) plus a real box.
const CHROME = () => {
  const look = el => el ? { inDom: true, display: getComputedStyle(el).display, w: el.getBoundingClientRect().width } : { inDom: false };
  return { avatar: look(document.getElementById('userAvatarStudio')), logout: look(document.getElementById('studio-logout')) };
};

// ─── (1) guest pages: logout and avatar are hidden, not deleted ───────────────────────────────

const GUEST_FILES = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg'];
// client-auth-check.js stops at a share link, so #studio-logout is never created there today; the
// rule has to hold if it ever is (e.g. a studio_token in the same browser), so the test plants one
// exactly where client-auth-check.js puts it (.header-right, a .btn).
const plantLogout = () => {
  const b = document.createElement('button');
  b.id = 'studio-logout'; b.className = 'btn btn-outline'; b.textContent = '登出';
  document.querySelector('.header-right').appendChild(b);
};

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES });
  await suite('guest chrome — picking link: 登出 and the avatar are display:none but still in the DOM',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(plantLogout);
      const r = await page.evaluate(CHROME);
      const crumbs = await page.evaluate(() => getComputedStyle(document.getElementById('headerBreadcrumbs')).display);
      ok('positive: the page is the guest picking page and the rest of the header is shown', crumbs !== 'none' && (await page.$$('.photo-card')).length === 2, crumbs);
      ok('the avatar is still in the DOM (switch-back-on stays possible) and is the guest icon',
        r.avatar.inDom && await page.evaluate(() => !!document.querySelector('#userAvatarStudio.guest-avatar svg')));
      ok('the avatar is display:none', r.avatar.display === 'none' && r.avatar.w === 0, JSON.stringify(r.avatar));
      ok('a 登出 button (.btn, display:inline-flex otherwise) is display:none, still in the DOM',
        r.logout.inDom && r.logout.display === 'none' && r.logout.w === 0, JSON.stringify(r.logout));
      ok('the page is flagged as guest mode', await page.evaluate(() => document.documentElement.classList.contains('guest-mode')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'],
    finalFolders: ['shoot/精修/'], deliveredAt: '2026-09-20T00:00:00.000Z', title: '婚禮精修',
    pickFiles: [...GUEST_FILES, 'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg'] });
  await suite('guest chrome — delivered gallery link: 登出 and the avatar are display:none but still in the DOM',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForFunction(() => document.getElementById('deliveryBar') && !document.getElementById('deliveryBar').hidden
        || document.querySelector('.fg-hero, .fg-row, .photo-card'), null, { timeout: 5000 });
      await page.evaluate(plantLogout);
      const r = await page.evaluate(CHROME);
      const bar = await page.evaluate(() => { const e = document.getElementById('deliveryBar'); return !!e && !e.hidden; });
      ok('positive: the delivered view is really showing (delivery bar visible)', bar === true);
      ok('the avatar is in the DOM and display:none', r.avatar.inDom && r.avatar.display === 'none' && r.avatar.w === 0, JSON.stringify(r.avatar));
      ok('a 登出 button is in the DOM and display:none', r.logout.inDom && r.logout.display === 'none' && r.logout.w === 0, JSON.stringify(r.logout));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

// ─── (2) the photographer's pages keep both ───────────────────────────────────────────────────

{
  const m = pickFakeWorker({ ownerName: 'Rex', projectId: 'proj-chrome' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('guest chrome — photographer review view keeps the avatar and 登出 visible',
    `${base}/index.html?project=proj-chrome`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#studio-logout', { timeout: 5000 });
      const r = await page.evaluate(CHROME);
      ok('the avatar is shown with its box', r.avatar.inDom && r.avatar.display !== 'none' && r.avatar.w > 0, JSON.stringify(r.avatar));
      ok('登出 is shown with its box', r.logout.inDom && r.logout.display !== 'none' && r.logout.w > 0, JSON.stringify(r.logout));
      ok('the page is not flagged as guest mode', await page.evaluate(() => !document.documentElement.classList.contains('guest-mode')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({});
  await suite('guest chrome — photographer studio page (index.html, no params) keeps the avatar and 登出; 下載選取 is there',
    `${base}/index.html`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#studio-logout', { timeout: 5000 });
      const r = await page.evaluate(CHROME);
      ok('the avatar is shown with its box', r.avatar.display !== 'none' && r.avatar.w > 0, JSON.stringify(r.avatar));
      ok('登出 is shown with its box', r.logout.display !== 'none' && r.logout.w > 0, JSON.stringify(r.logout));
      const dl = await page.evaluate(() => {
        const b = document.getElementById('downloadSelectedHeaderBtn');
        return { inDom: !!b, display: b && getComputedStyle(b).display, text: b && b.textContent.trim() };
      });
      ok('下載選取 is present and not hidden outside the review view', dl.inDom && dl.display !== 'none' && dl.text === '下載選取', JSON.stringify(dl));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ─── (3) zip downloads ────────────────────────────────────────────────────────────────────────

// A stand-in for the cdnjs JSZip that behaves like the real one where it matters here: adding a
// second file under a name that already exists REPLACES the first (and a zip extracts onto
// case-insensitive file systems, so the lookup key is the lower-cased name). The "zip" it
// generates is a JSON {name: text} so the test can read what the photographer would get.
const FAKE_JSZIP = () => {
  window.JSZip = function () {
    const files = new Map();
    this.file = (name, blob) => { files.set(String(name).toLowerCase(), { name, blob }); };
    this.generateAsync = async () => {
      const out = {};
      for (const { name, blob } of files.values()) out[name] = await blob.text();
      return new Blob([JSON.stringify(out)], { type: 'application/json' });
    };
  };
  // The name the page asks for (<a download>). Chromium itself falls back to "download" for a
  // non-ASCII name when the process has no UTF-8 locale (this container), so the event's
  // suggestedFilename() cannot be the check; the file content is still read from the event.
  window.__dlNames = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlNames.push(this.download); return click.call(this); };
};
const lastName = page => page.evaluate(() => window.__dlNames[window.__dlNames.length - 1] ?? null);
// The fake Worker serves one PNG for every full-size admin read, so the originals the zip fetches
// (no ?w=) are answered here with bytes that name their own key; thumbnails fall through to it.
const withKeyBytes = m => async page => {
  await m.attach(page);
  await page.route(/imagepicker\.hotichen\.workers\.dev\/\d{8}\/[^?]*$/, route => {
    const u = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.from(`BYTES-OF:${decodeURIComponent(u.pathname.slice(1))}`) });
  });
};
const readDownload = async dl => JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
const successToast = page => page.evaluate(() => [...document.querySelectorAll('.toast.success .toast-message')].map(e => e.textContent.trim()));

{
  const TITLE = ' 王/小明:婚*禮?"精<選>|  合集 \u0007 ';
  const m = pickFakeWorker({ ownerName: 'Rex', projectId: 'proj-zip', title: TITLE });
  for (const k of ['20260819/a.jpg', '20260901/a.jpg', '20260819/b.jpg']) {
    m.state.selections.set(k, { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  }
  await suite('zip names — review view: <title>_選片_<N>張.zip, same-named photos both packed, count toast, 下載選取 hidden',
    `${base}/index.html?project=proj-zip`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(FAKE_JSZIP);
      const EXPECT_NAME = '王小明婚禮精選 合集_選片_3張.zip';

      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#downloadAllBtn')]);
      ok('the zip is named after the sanitised title with the photo count (illegal characters stripped, Chinese kept)',
        await lastName(page) === EXPECT_NAME, await lastName(page));
      const zip = await readDownload(dl);
      const names = Object.keys(zip).sort();
      ok('positive: the zip holds all 3 photos (none overwritten)', names.length === 3, JSON.stringify(names));
      ok('the first a.jpg keeps its name, the second gets "a (2).jpg", extension kept',
        names.includes('a.jpg') && names.includes('a (2).jpg') && names.includes('b.jpg'), JSON.stringify(names));
      ok('each name holds its own photo (a.jpg = the 0819 one, a (2).jpg = the 0901 one)',
        zip['a.jpg'] === 'BYTES-OF:20260819/a.jpg' && zip['a (2).jpg'] === 'BYTES-OF:20260901/a.jpg' && zip['b.jpg'] === 'BYTES-OF:20260819/b.jpg', JSON.stringify(zip));
      await page.waitForFunction(() => document.querySelector('.toast.success'), null, { timeout: 3000 });
      const toasts = await successToast(page);
      ok('the success toast states the count: 已打包 3 張', toasts.some(t => t.includes('已打包 3 張')), JSON.stringify(toasts));

      // 下載選取: hidden here (both the header button and the bulk bar's), still in the DOM, still wired
      const sel = await page.evaluate(() => {
        const header = document.getElementById('downloadSelectedHeaderBtn');
        const bulk = document.querySelector('#bulkActionBar button[onclick="app.downloadSelected()"]');
        const look = e => e ? { display: getComputedStyle(e).display, w: e.getBoundingClientRect().width } : null;
        const all = document.getElementById('downloadAllBtn');
        return { header: look(header), bulk: look(bulk), all: look(all) };
      });
      ok('positive: 打包全部下載 is visible in the review view', sel.all && sel.all.display !== 'none' && sel.all.w > 0, JSON.stringify(sel.all));
      ok('下載選取 (header) is in the DOM and display:none', sel.header && sel.header.display === 'none' && sel.header.w === 0, JSON.stringify(sel.header));
      ok('下載選取 (bulk bar) is in the DOM and display:none', sel.bulk && sel.bulk.display === 'none', JSON.stringify(sel.bulk));
      await page.evaluate(() => { window.__dlNames.length = 0; });
      const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.evaluate(() => app.downloadSelected())]);
      ok('the (hidden but still wired) 下載選取 hook produces the same named zip', await lastName(page) === EXPECT_NAME, await lastName(page));
      return out;
    },
    { before: withKeyBytes(m), initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Rex', projectId: 'proj-zip2', title: '///:::***' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/b.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('zip names — a title that is nothing but illegal characters falls back to "Project"',
    `${base}/index.html?project=proj-zip2`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(FAKE_JSZIP);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#downloadAllBtn')]);
      ok('Project_選片_2張.zip', await lastName(page) === 'Project_選片_2張.zip', await lastName(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({});
  await suite('zip names — sanitiser edge cases and unique names (driveManager), other zip names untouched',
    `${base}/index.html`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#studio-logout', { timeout: 5000 });
      await page.evaluate(FAKE_JSZIP);
      const s = await page.evaluate(() => {
        const f = t => driveManager.sanitizeFileTitle(t);
        const long = '長'.repeat(80);
        return {
          plain: f('Wedding 2026'), spaces: f('  a   b \t c  '), ctrl: f('x\u0000y\u001Fz\u007F\u2028w'),
          illegal: f('a/b\\c:d*e?f"g<h>i|j'), empty: f(''), nul: f(null), und: f(undefined), blank: f('   '),
          onlyIllegal: f('?*<>'), long: f(long), longLen: Array.from(f(long)).length,
          dots: f('..hidden.'), num: f(2026),
        };
      });
      ok('plain titles pass through unchanged', s.plain === 'Wedding 2026', s.plain);
      ok('whitespace is collapsed and trimmed', s.spaces === 'a b c', JSON.stringify(s.spaces));
      ok('control characters are stripped', s.ctrl === 'xyzw', JSON.stringify(s.ctrl));
      ok('/ \\ : * ? " < > | are stripped', s.illegal === 'abcdefghij', s.illegal);
      ok('empty / null / undefined / blank / only-illegal fall back to Project',
        [s.empty, s.nul, s.und, s.blank, s.onlyIllegal].every(v => v === 'Project'), JSON.stringify(s));
      ok('capped at 60 characters, Chinese counted per character', s.longLen === 60 && s.long === '長'.repeat(60), String(s.longLen));
      ok('leading and trailing dots are stripped (no hidden or Windows-invalid names)', s.dots === 'hidden', JSON.stringify(s.dots));
      ok('a number title is accepted', s.num === '2026', JSON.stringify(s.num));

      // unique names, through the real downloadPhotos, with a name already taken by "a (2).jpg"
      const photos = [
        { id: 'x/a.jpg', name: 'a.jpg' }, { id: 'y/a.jpg', name: 'a.jpg' }, { id: 'z/a (2).jpg', name: 'a (2).jpg' },
        { id: 'p/A.JPG', name: 'A.JPG' }, { id: 'p/note', name: 'note' }, { id: 'q/note', name: 'note' },
        { id: 'p/b.tar.gz', name: 'b.tar.gz' }, { id: 'q/b.tar.gz', name: 'b.tar.gz' },
      ];
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }),
        page.evaluate(ps => driveManager.downloadPhotos(ps, 'Selected_8_Photos.zip'), photos)]);
      ok('other zip names are used as given', await lastName(page) === 'Selected_8_Photos.zip', await lastName(page));
      const zip = await readDownload(dl);
      const names = Object.keys(zip);
      ok('positive: all 8 photos are in the zip', names.length === 8, JSON.stringify(names));
      ok('first keeps the name; later ones count up around a name already taken; case-insensitively unique',
        names.includes('a.jpg') && names.includes('a (2).jpg') && names.includes('a (2) (2).jpg') && names.includes('A (3).JPG'), JSON.stringify(names));
      ok('names without an extension get "note (2)"; multi-dot keeps only the last extension split',
        names.includes('note') && names.includes('note (2)') && names.includes('b.tar.gz') && names.includes('b.tar (2).gz'), JSON.stringify(names));
      ok('no two names collide case-insensitively', new Set(names.map(n => n.toLowerCase())).size === names.length);
      await page.waitForFunction(() => document.querySelector('.toast.success'), null, { timeout: 3000 });
      ok('count toast: 已打包 8 張', (await successToast(page)).some(t => t.includes('已打包 8 張')), JSON.stringify(await successToast(page)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

}
