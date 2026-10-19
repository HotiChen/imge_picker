// Browser suites: (1) a proof original is the seat owner's alone (Tim 2026-10-15): the owner downloads it with the
// key as a header (a fetch, never a plain link), anyone else with the link sees no download for proofs at all;
// (2) the 驗收頁 button reads 回到毛片 and shares one row with the status block; that strip, and the phone picking
// bar, stay under the header while the page scrolls.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const DESK = { viewport: { width: 1280, height: 900 } };
const PROOFS = Array.from({ length: 4 }, (_, i) => `shoot/毛片/p${i + 1}.jpg`);
const FINALS = Array.from({ length: 40 }, (_, i) => `shoot/精修/f${String(i + 1).padStart(3, '0')}.jpg`);
const delivered = o => pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
  deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: [...PROOFS, ...FINALS], ...o });
// record the proof-original downloads the page makes (the key header, the URL) and answer them with bytes
const recordDownloads = async (page, log) => {
  await page.route('**/*download=1*', async route => {
    const req = route.request();
    log.push({ url: req.url(), key: (await req.allHeaders())['x-picker-key'] || null, method: req.method() });
    await route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: Buffer.from('PROOF-BYTES') });
  });
};

// ── 1. the owner downloads a proof original with the key header; a viewer has no proof download at all
{
  const dl = [];
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: PROOFS, allowProofDownload: true });
  await suite('proof original while picking, switch ON — the owner downloads it with X-Picker-Key (a fetch, not a link)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const btn = await page.$eval('#modalDownloadBtn', e => ({ hidden: e.hidden, disp: getComputedStyle(e).display }));
      ok('the owner has the download button, shown', !btn.hidden && btn.disp !== 'none', JSON.stringify(btn));
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#modalDownloadBtn')]);
      ok('a file was saved, named after the photo', /^p\d\.jpg$/.test(download.suggestedFilename()), download.suggestedFilename());
      ok('the request carried the owner key as a header, once', dl.length === 1 && dl[0].key === 'ZOE-KEY', JSON.stringify(dl));
      ok('...and the key is nowhere in the URL', dl.length === 1 && !/ZOE-KEY|k=|key=/.test(dl[0].url), dl[0] && dl[0].url);
      return out;
    },
    { before: async page => { await m.attach(page); await recordDownloads(page, dl); }, initScript: OWNER, contextOptions: DESK });
}
{
  const dl = [];
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: PROOFS, allowProofDownload: true });
  await suite('proof original while picking, switch ON — a viewer (no key) has no download button',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('control: the viewer sees the proofs', (await page.$$('.photo-card')).length === 4);
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const s = await page.evaluate(() => ({ modal: document.getElementById('modalDownloadBtn'), mHidden: document.getElementById('modalDownloadBtn')?.hidden,
        preview: document.getElementById('previewDownloadBtn'), pHidden: document.getElementById('previewDownloadBtn')?.hidden,
        any: [...document.querySelectorAll('[data-download], a[href*="download=1"]')].filter(e => !e.hidden && getComputedStyle(e).display !== 'none').length }));
      ok('no download button is visible (removed or hidden), no download link anywhere', s.any === 0 && (s.modal === null || s.mHidden) && (s.preview === null || s.pHidden), JSON.stringify(s));
      ok('nothing was requested with download=1', dl.length === 0, JSON.stringify(dl));
      return out;
    },
    { before: async page => { await m.attach(page); await recordDownloads(page, dl); }, initScript: '', contextOptions: DESK });
}

// ── 2. the 驗收頁: the button reads 回到毛片, shares a row with the status, and the strip stays put
// (EDITED 2026-10-19: the 驗收頁 is the 毛片 page — the standard .photo-card grid scrolls inside .content as on the
// picking page; the strip must stay under the header whether the photos or the page scroll)
const scrollAll = page => page.evaluate(() => { document.querySelector('.content').scrollTo(0, 1500); window.scrollTo(0, 1500); });
const scrolled = page => page.evaluate(() => Math.max(scrollY, document.querySelector('.content').scrollTop));
for (const [label, co] of [['phone 390px', MOBILE], ['desktop 1280px', DESK]]) {
  const m = delivered({ allowProofDownload: true });
  await suite(`驗收頁 strip (${label}) — 回到毛片 beside the status, fixed under the header while scrolling`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForFunction(() => document.querySelectorAll('#photoGrid .photo-card').length >= 30, null, { timeout: 6000 });
      const geo = () => page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height }; };
        return { header: r('.header'), strip: r('#deliveryStrip'), btn: r('#deliveryProofsBtn'), status: r('#deliveryDoneStatus'), done: r('#deliveryDone'),
          btnText: document.getElementById('deliveryProofsBtn')?.textContent.trim(), pos: getComputedStyle(document.getElementById('deliveryStrip')).position, sy: scrollY, iw: innerWidth };
      });
      const a = await geo();
      ok('the button says 回到毛片, and the old wording is gone', a.btnText === '回到毛片' && !(await page.evaluate(() => /下載毛片原檔/.test(document.body.innerText))), a.btnText);
      ok('the button and the status text are on one row: their vertical spans overlap and the button is left of the text', !!a.btn && !!a.status && a.btn.h > 0 && a.status.t < a.btn.b && a.btn.t < a.status.b && a.btn.r <= a.status.l + 1, JSON.stringify([a.btn, a.status]));
      ok('the strip is sticky and sits right under the header', a.pos === 'sticky' && Math.abs(a.strip.t - a.header.b) <= 1, JSON.stringify([a.pos, a.strip, a.header]));
      await scrollAll(page);
      await page.waitForTimeout(300);
      const b = await geo();
      const moved = await scrolled(page);
      ok('control: the photos really scrolled', moved >= 1000, String(moved));
      ok('after scrolling the strip is still under the header, fully on screen, with its button and status', Math.abs(b.strip.t - b.header.b) <= 1 && b.strip.b > b.strip.t && b.btn.t >= b.header.b - 1 && b.status.t >= b.header.b - 1, JSON.stringify(b));
      ok('what a tap in the middle of the button hits is the button', await page.evaluate(() => { const e = document.getElementById('deliveryProofsBtn'); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === e || e.contains(hit); }));
      // the proofs view: title 毛片, the strip is still the strip
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.getElementById('deliveryTitle')?.textContent.startsWith('毛片'), null, { timeout: 5000 });
      const t = await page.evaluate(() => ({ title: document.getElementById('deliveryTitle').textContent, btn: document.getElementById('deliveryProofsBtn').textContent.trim() }));
      ok('in the 毛片 view the title is 毛片 (not 僅供下載) and the way back is named', /^毛片/.test(t.title) && !/僅供下載/.test(t.title) && /回精修成品/.test(t.btn), JSON.stringify(t));
      ok('...and that title is shown there (only the 驗收頁 strip leaves it to the header)', await page.evaluate(() => { const e = document.getElementById('deliveryTitle'); return getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: co });
}
{
  const m = delivered({});
  await suite('驗收頁 strip, switch off — no 毛片 button, the status block alone, still fixed under the header',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForFunction(() => document.querySelectorAll('#photoGrid .photo-card').length >= 30, null, { timeout: 6000 });
      await scrollAll(page);
      await page.waitForTimeout(300);
      ok('control: the photos really scrolled', (await scrolled(page)) >= 1000);
      const g = await page.evaluate(() => { const h = document.querySelector('.header').getBoundingClientRect(), d = document.getElementById('deliveryDone').getBoundingClientRect();
        return { btn: !!document.getElementById('deliveryProofsBtn'), hb: h.bottom, dt: d.top, db: d.bottom, text: document.getElementById('deliveryDoneStatus')?.textContent }; });
      ok('no 毛片 button in the DOM', !g.btn, JSON.stringify(g));
      ok('the status block is under the header and on screen after scrolling', Math.abs(g.dt - g.hb) <= 1 && g.db > g.dt && /精修完成/.test(g.text || ''), JSON.stringify(g));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: MOBILE });
}

// ── 3. picking: the page itself does not scroll (no footer pushing it past the viewport), the content scrolls under
//       a header and a guest bar that stay put
for (const [label, co, hasBar] of [['phone 390px', MOBILE, true], ['desktop 1280px', DESK, false]]) {
  const files = Array.from({ length: 60 }, (_, i) => `20260819/p${String(i).padStart(3, '0')}.jpg`);
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['20260819/'], pickFiles: files, pickLimit: 20 });
  await suite(`picking (${label}) — the page does not scroll, the header${hasBar ? ' and the guest bar stay' : ' stays'} put while the photos scroll`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length >= 30, null, { timeout: 6000 });
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => ({ inner: innerHeight, doc: document.documentElement.scrollHeight, footer: !!document.querySelector('footer.app-footer') && getComputedStyle(document.querySelector('footer.app-footer')).display !== 'none',
        cs: document.querySelector('.content').scrollHeight, ch: document.querySelector('.content').clientHeight, oc: getComputedStyle(document.querySelector('.content')).overscrollBehaviorY }));
      ok('control: the photos overflow their own scroller (there is something to scroll)', before.cs > before.ch + 500, JSON.stringify(before));
      ok('the page is exactly one screen tall: no outer scroll, no footer on a picking page', before.doc <= before.inner && !before.footer, JSON.stringify(before));
      ok('the photo scroller does not chain its scroll to the page', before.oc === 'contain', before.oc);
      await page.evaluate(() => { document.querySelector('.content').scrollTo(0, 900); window.scrollTo(0, 500); });
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => { const h = document.querySelector('.header').getBoundingClientRect(), c = document.querySelector('.content').getBoundingClientRect(), gb = document.querySelector('.guest-bar');
        return { sy: scrollY, ct: document.querySelector('.content').scrollTop, hb: h.bottom, htop: h.top, contentTop: c.top, gbTop: gb ? gb.getBoundingClientRect().top : null,
          hit: gb ? document.elementFromPoint(gb.getBoundingClientRect().left + 20, gb.getBoundingClientRect().top + 10) === gb || gb.contains(document.elementFromPoint(gb.getBoundingClientRect().left + 20, gb.getBoundingClientRect().top + 10)) : null }; });
      ok('control: the photos scrolled', g.ct >= 500, JSON.stringify(g));
      ok('the page did not move and the header is still at the top', g.sy === 0 && g.htop === 0, JSON.stringify(g));
      if (hasBar) ok('the guest bar is still pinned at the top of the photos, under the header, and on top', g.gbTop !== null && Math.abs(g.gbTop - g.hb) <= 1 && g.hit === true, JSON.stringify(g));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: co });
}

}
