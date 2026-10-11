// Browser suites: co-picking on the photographer's review view (docs/co-picking.md, photographer view) —
// who picked each photo (grid, list, enlarged view) and the read-only collaborators section.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { coPickingFake } from '../lib/co-picking-fake.mjs';

export default async function register() {

const XSS = '<img src=x onerror="window.__xssBy=1">';
const T = '2026-09-27T14:52:00.000Z';
function world(extra = {}) {
  const m = coPickingFake({
    ownerName: 'Lia', projectId: 'proj-co', ...extra,
    collaborators: extra.collaborators || [
      { id: 'c-mia', name: 'Mia', status: 'active', expires_at: '2026-12-31T00:00:00.000Z' },
      { id: 'c-old', name: 'Old', status: 'removed', revoked_at: '2026-10-01T00:00:00.000Z' },
      { id: 'c-xss', name: XSS, status: 'expired', expires_at: '2026-09-30T00:00:00.000Z' },
    ],
    others: [{ id: 'p-ex', name: 'Ex' }],
  });
  const sel = (k, by, marks) => m.state.selections.set(k, { rating: 1, note: '', updated_by: by, updated_at: T, ...(marks ? { marks } : {}) });
  sel('20260819/a.jpg', 'picker-0', [{ x: 0.5, y: 0.5, note: '痘痘' }]);
  sel('20260819/b.jpg', 'c-mia');
  sel('20260819/c.jpg', 'p-ex');
  sel('20260819/d.jpg', 'ghost');      // no picker of this project -> by:null
  sel('20260819/e.jpg', 'c-xss');
  return m;
}
const chips = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.photo-card')].map(c => {
  const ch = c.querySelector('.pv-by');
  return [c.dataset.photoId.split('/').pop(), ch ? { role: ch.dataset.role, text: ch.textContent, bg: getComputedStyle(ch).backgroundColor } : null];
})));

{
  const m = world();
  await suite('co-picking photographer — each grid card shows who picked it (owner vs collaborator vs other, null = nothing), names are text only',
    `${base}/index.html?project=proj-co`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const c = await chips(page);
      ok('5 cards rendered (positive)', Object.keys(c).length === 5, JSON.stringify(Object.keys(c)));
      ok('owner pick: owner chip with the name', c['a.jpg']?.role === 'owner' && c['a.jpg'].text.includes('Lia'), JSON.stringify(c['a.jpg']));
      ok('collaborator pick: collaborator chip with the name', c['b.jpg']?.role === 'collaborator' && c['b.jpg'].text.includes('Mia'), JSON.stringify(c['b.jpg']));
      ok('a previous seat holder reads as other, name shown', c['c.jpg']?.role === 'other' && c['c.jpg'].text.includes('Ex'), JSON.stringify(c['c.jpg']));
      ok('by:null shows no chip at all', c['d.jpg'] === null, JSON.stringify(c['d.jpg']));
      ok('owner and collaborator chips look different', c['a.jpg'].bg !== c['b.jpg'].bg, `${c['a.jpg'].bg} / ${c['b.jpg'].bg}`);
      const x = await page.evaluate(() => ({ fired: !!window.__xssBy, imgs: document.querySelectorAll('img[src="x"]').length }));
      ok('a collaborator named <img onerror> is text: no element, no handler', x.imgs === 0 && !x.fired, JSON.stringify(x));
      ok('and the name is shown literally', c['e.jpg']?.text.includes(XSS), JSON.stringify(c['e.jpg']));
      ok('the other card furniture is still there (♥ on every card, one pin badge)', await page.evaluate(() =>
        document.querySelectorAll('.photo-card .pick-heart-btn').length === 5 && document.querySelectorAll('.photo-card .pv-pin-badge').length === 1));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = world();
  await suite('co-picking photographer — list view rows carry the same chip; the modal shows the author; arrows, glow and pins keep working',
    `${base}/index.html?project=proj-co`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      // grid: open photo #2 (b.jpg, Mia)
      await page.locator('.photo-card').nth(1).click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      let by = await page.evaluate(() => { const e = document.querySelector('#modalPhotoRating .pv-by'); return e ? { role: e.dataset.role, text: e.textContent } : null; });
      ok('the modal names the author of the open photo', by && by.role === 'collaborator' && by.text.includes('Mia'), JSON.stringify(by));
      ok('the read-only ♥ is still there beside it', await page.evaluate(() => !!document.querySelector('#modalPhotoRating .pick-heart-btn')));
      await page.click('#nextPhotoBtn');
      await page.waitForTimeout(150);
      by = await page.evaluate(() => document.querySelector('#modalPhotoRating .pv-by')?.textContent || null);
      ok('next: the author follows to Ex', by && by.includes('Ex'), String(by));
      await page.click('#nextPhotoBtn');
      await page.waitForTimeout(150);
      ok('next: a photo with by:null has no author chip in the modal (and no stale one)', await page.evaluate(() => !document.querySelector('#modalPhotoRating .pv-by')));
      await page.click('#closeModal');
      // pins on photo a still list in the modal
      await page.locator('.photo-card').nth(0).click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const pins = await page.evaluate(() => [...document.querySelectorAll('#pvPinList li')].map(l => l.textContent));
      ok('pins list intact next to the author chip', pins.length === 1 && pins[0].includes('痘痘'), JSON.stringify(pins));
      await page.click('#closeModal');
      // keyboard glow with chips in the cards
      await page.mouse.move(5, 5);
      await page.keyboard.press('ArrowRight');
      const cur = await page.evaluate(() => [...document.querySelectorAll('.photo-card.is-current')].map(e => e.dataset.photoId));
      ok('arrow keys still move exactly one .is-current', cur.length === 1, JSON.stringify(cur));
      // list view
      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.pv-list-row')].map(r => {
        const ch = r.querySelector('.pv-by'); return [r.dataset.photoId.split('/').pop(), ch ? { role: ch.dataset.role, text: ch.textContent } : null];
      })));
      ok('list: 5 rows', Object.keys(rows).length === 5);
      ok('list: owner / collaborator / other chips', rows['a.jpg']?.role === 'owner' && rows['b.jpg']?.role === 'collaborator' && rows['c.jpg']?.role === 'other', JSON.stringify(rows));
      ok('list: by:null has no chip', rows['d.jpg'] === null);
      ok('list: XSS name is text', rows['e.jpg']?.text.includes(XSS) && await page.evaluate(() => !window.__xssBy && !document.querySelector('img[src="x"]')));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = world();
  await suite('co-picking photographer — the collaborators section: name, status, valid until, joined; read-only',
    `${base}/index.html?project=proj-co`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('#pvCollaborators .pv-co-row')].map(r => ({
        status: r.dataset.status, name: r.querySelector('.pv-co-name')?.textContent, state: r.querySelector('.pv-co-status')?.textContent,
        until: r.querySelector('.pv-co-until')?.textContent, joined: r.querySelector('.pv-co-joined')?.textContent,
      })));
      ok('three collaborators listed', rows.length === 3, JSON.stringify(rows));
      ok('Mia: active, valid until 2026/12/31, joined shown', rows[0]?.name === 'Mia' && rows[0].status === 'active' && rows[0].until.includes('2026/12/31') && /9\/21/.test(rows[0].joined), JSON.stringify(rows[0]));
      ok('Old: removed', rows[1]?.status === 'removed' && rows[1].state !== rows[0]?.state, JSON.stringify(rows[1]));
      ok('expired one is marked expired and distinct', rows[2]?.status === 'expired' && rows[2].state !== rows[1]?.state && rows[2].state !== rows[0]?.state, JSON.stringify(rows[2]));
      ok('XSS name is text', rows[2]?.name === XSS && await page.evaluate(() => !window.__xssBy && !document.querySelector('img[src="x"]')));
      ok('read-only: no button or input inside the section', await page.evaluate(() => !document.querySelector('#pvCollaborators button, #pvCollaborators input, #pvCollaborators select, #pvCollaborators textarea')));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = world({ collaborators: [] });
  await suite('co-picking photographer — no collaborators: no section (hidden when empty); owner chips still show',
    `${base}/index.html?project=proj-co`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive: the owner chip is there', await page.evaluate(() => !!document.querySelector('.photo-card .pv-by[data-role="owner"]')));
      ok('no collaborators section in the DOM', await page.evaluate(() => !document.getElementById('pvCollaborators')));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = coPickingFake({ ownerName: 'Lia', projectId: 'proj-old', noCollaboratorsField: true });
  m.state.selections.set('20260819/a.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: T });
  await suite('co-picking photographer — a Worker that sends no collaborators field (before the migration) still renders the grid',
    `${base}/index.html?project=proj-old`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('card rendered, no section', await page.evaluate(() => document.querySelectorAll('.photo-card').length === 1 && !document.getElementById('pvCollaborators')));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = world();
  m.state.selections.set('20260819/a.jpg', { rating: 1, note: '有備註', updated_by: 'c-mia', updated_at: T, marks: [{ x: 0.3, y: 0.3, note: 'x' }, { x: 0.6, y: 0.6, note: 'y' }] });
  await suite('co-picking photographer (390px) — the chip overlaps neither ♥, 💬 nor 📍 and the page does not scroll sideways, grid and list',
    `${base}/index.html?project=proj-co`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const scan = () => page.evaluate(() => {
        const hit = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.width && y.width && x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom; };
        let chips = 0, overlaps = 0, outside = 0;
        document.querySelectorAll('.photo-card').forEach(card => {
          const ch = card.querySelector('.pv-by'); if (!ch) return;
          chips++;
          const cr = card.getBoundingClientRect(), r = ch.getBoundingClientRect();
          if (r.left < cr.left - 1 || r.right > cr.right + 1) outside++;
          card.querySelectorAll('.pick-heart-btn, .pv-note-badge, .pv-pin-badge, .photo-badge').forEach(o => { if (hit(ch, o)) overlaps++; });
        });
        return { chips, overlaps, outside, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
      });
      let r = await scan();
      ok('floor: 4 chips scanned (a, b, c, e; d has none)', r.chips === 4, JSON.stringify(r));
      ok('no overlap with ♥ / 💬 / 📍', r.overlaps === 0, JSON.stringify(r));
      ok('chips stay inside their card', r.outside === 0, JSON.stringify(r));
      ok('no sideways scroll', r.scrollW <= r.innerW, JSON.stringify(r));
      await page.evaluate(() => ProjectViewController._toggleViewMode(document.getElementById('headerViewBtn')));   // the button is hidden on a phone
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      r = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        chips: document.querySelectorAll('.pv-list-row .pv-by').length,
        clipped: [...document.querySelectorAll('.pv-list-row')].filter(row => row.scrollWidth > row.clientWidth + 1).length }));
      ok('list: 4 chips, no sideways scroll, no row overflowing', r.chips === 4 && r.scrollW <= r.innerW && r.clipped === 0, JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}
}
