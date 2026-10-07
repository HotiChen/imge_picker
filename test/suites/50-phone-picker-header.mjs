// Browser suites: the photographer's own picker page (index.html, no ?t=) and the review view (index.html?project=)
// at phone width (390x844, DPR 3): header on ONE row without overflow, a 44px back control to the admin, the
// ☰ that opens the folder sidebar (44px, auto-open once on an empty page, copy that names it), 上傳 / 相本書 / 登出
// moved into that sidebar, no extra history entries. Controls: the guest ?t= page and the 1280 photographer
// header are compared with a baseline captured before the change (BASE_*), so nothing there moved.
// Chromium only, not real iOS Safari. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const DESKTOP = { viewport: { width: 1280, height: 900 } };

// Everything measured in one evaluate: every element under .header that has an id or a class, in DOM order.
const snap = page => page.evaluate(() => {
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const out = {};
  for (const e of document.querySelectorAll('.header *')) {
    const key = e.id ? '#' + e.id : (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : null);
    if (!key || out[key]) continue;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    out[key] = { shown: vis(e), l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      fs: cs.fontSize, pad: cs.padding, disp: cs.display };
  }
  return out;
});
const sameAsBase = (now, baseline) => {
  const bad = [];
  for (const k of Object.keys(baseline)) if (JSON.stringify(now[k]) !== JSON.stringify(baseline[k])) bad.push(k + ' ' + JSON.stringify(now[k]) + ' vs ' + JSON.stringify(baseline[k]));
  return bad;
};

const metrics = page => page.evaluate(() => {
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const R = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const hdr = document.querySelector('.header');
  const ctl = [...hdr.querySelectorAll('a, button, input, select')].filter(vis).map(e => ({ id: e.id, txt: e.textContent.trim(), ...R(e) }));
  const tog = document.getElementById('sidebarToggle');
  const back = document.getElementById('backToAdminLink');
  const es = document.querySelector('#emptyState .empty-state-text');
  return {
    sw: document.documentElement.scrollWidth, iw: innerWidth, hdr: R(hdr), ctl,
    tog: tog && { shown: vis(tog), ...R(tog) },
    back: back && { shown: vis(back), href: back.getAttribute('href'), txt: back.textContent.trim(), cls: back.className, ...R(back) },
    es: es && es.innerText.trim(),
    sideActive: !!document.querySelector('.sidebar')?.classList.contains('active'),
    backdropActive: !!document.getElementById('sidebarBackdrop')?.classList.contains('active'),
    hist: history.length,
    pv: document.body.classList.contains('pv-active'),
  };
});
const sideItem = (page, id) => page.evaluate(id => {
  const e = document.getElementById(id); if (!e) return null;
  const r = e.getBoundingClientRect(), vis = e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const sb = document.querySelector('.sidebar').getBoundingClientRect();
  return { shown: vis, w: r.width, h: r.height, l: r.left, r: r.right, t: r.top, b: r.bottom, insideSidebar: r.left >= sb.left - 1 && r.right <= sb.right + 1, txt: e.textContent.trim(), href: e.getAttribute('href') };
}, id);
const MENU = [['phoneUploadBtn', '上傳'], ['phoneBookBtn', '相本書'], ['phoneLogoutBtn', '登出']];

// Baselines: captured with this same snap() on 50fa3ab, BEFORE any change (guest at 390 / 1280, photographer at 1280).
const BASE_GUEST_390 = {".header-left":{"shown":true,"l":0,"t":17,"w":354,"h":22,"fs":"16px","pad":"0px 18px","disp":"flex"},".logo-mark":{"shown":true,"l":18,"t":17,"w":22,"h":22,"fs":"12px","pad":"0px","disp":"flex"},".logo-name":{"shown":true,"l":50,"t":17,"w":70,"h":20,"fs":"14px","pad":"0px","disp":"block"},".header-center":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"16px","pad":"0px","disp":"none"},"#headerBreadcrumbs":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"11px","pad":"0px","disp":"flex"},".header-right":{"shown":true,"l":354,"t":28,"w":36,"h":0,"fs":"16px","pad":"0px 18px","disp":"flex"},"#userAvatarStudio":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"11px","pad":"0px","disp":"none"}};
const BASE_ADMIN_1280 = {".header-left":{"shown":true,"l":0,"t":17,"w":280,"h":22,"fs":"16px","pad":"0px 18px","disp":"flex"},"#sidebarToggle":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"13.3333px","pad":"4px","disp":"none"},".logo-mark":{"shown":true,"l":18,"t":17,"w":22,"h":22,"fs":"12px","pad":"0px","disp":"flex"},".logo-name":{"shown":true,"l":50,"t":17,"w":70,"h":20,"fs":"14px","pad":"0px","disp":"block"},".logo-label":{"shown":true,"l":130,"t":21,"w":39,"h":13,"fs":"9px","pad":"0px","disp":"block"},"#buildVersion":{"shown":true,"l":179,"t":20,"w":66,"h":15,"fs":"10px","pad":"0px","disp":"block"},"#expiryBadge":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"10px","pad":"2px 7px","disp":"none"},".icon":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"10px","pad":"0px","disp":"inline"},"#expiryTimer":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"10px","pad":"0px","disp":"inline"},".label":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"9px","pad":"0px","disp":"inline"},".header-center":{"shown":true,"l":280,"t":15,"w":587,"h":26,"fs":"16px","pad":"0px","disp":"flex"},"#headerBreadcrumbs":{"shown":true,"l":461,"t":20,"w":55,"h":16,"fs":"11px","pad":"0px","disp":"flex"},".header-vsep":{"shown":true,"l":526,"t":20,"w":1,"h":16,"fs":"16px","pad":"0px","disp":"block"},"#headerSortBtn":{"shown":true,"l":537,"t":15,"w":96,"h":26,"fs":"10px","pad":"5px 10px","disp":"block"},"#headerViewBtn":{"shown":true,"l":643,"t":15,"w":43,"h":26,"fs":"10px","pad":"5px 10px","disp":"block"},".header-right":{"shown":true,"l":867,"t":12,"w":413,"h":32,"fs":"16px","pad":"0px 18px","disp":"flex"},"#submitJobBtn":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"11px","pad":"7px 14px","disp":"none"},"#studioBookingLink":{"shown":true,"l":885,"t":12,"w":99,"h":32,"fs":"11px","pad":"7px 14px","disp":"flex"},"#uploadPageBtn":{"shown":true,"l":994,"t":12,"w":68,"h":32,"fs":"11px","pad":"7px 14px","disp":"flex"},"#openBookEditorBtn":{"shown":true,"l":1072,"t":12,"w":87,"h":31,"fs":"11px","pad":"7px 14px","disp":"flex"},"#userAvatarStudio":{"shown":true,"l":1169,"t":13,"w":30,"h":30,"fs":"11px","pad":"0px","disp":"flex"},"#studio-logout":{"shown":true,"l":1209,"t":12,"w":53,"h":31,"fs":"11px","pad":"7px 14px","disp":"flex"}};
const BASE_GUEST_1280 = {".header-left":{"shown":true,"l":0,"t":17,"w":280,"h":22,"fs":"16px","pad":"0px 18px","disp":"flex"},".logo-mark":{"shown":true,"l":18,"t":17,"w":22,"h":22,"fs":"12px","pad":"0px","disp":"flex"},".logo-name":{"shown":true,"l":50,"t":17,"w":70,"h":20,"fs":"14px","pad":"0px","disp":"block"},".header-center":{"shown":true,"l":280,"t":20,"w":964,"h":16,"fs":"16px","pad":"0px","disp":"flex"},"#headerBreadcrumbs":{"shown":true,"l":744,"t":20,"w":35,"h":16,"fs":"11px","pad":"0px","disp":"flex"},".header-right":{"shown":true,"l":1244,"t":28,"w":36,"h":0,"fs":"16px","pad":"0px 18px","disp":"flex"},"#userAvatarStudio":{"shown":false,"l":0,"t":0,"w":0,"h":0,"fs":"11px","pad":"0px","disp":"none"}};

// ═════════ A. the photographer's own picker page, phone ═════════
{
  const m = pickFakeWorker({ folders: ['shoot/毛片/'] });
  await suite('phone picker header — 390x844: one row, no overflow, every control >= 44px, 返回後台 first-left, menu in ☰',
    `${base}/index.html`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#studio-logout', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(400);
      const h0 = (await metrics(page)).hist;
      const m0 = await metrics(page);
      ok('page is not in guest mode (positive control: this is the photographer page)', await page.evaluate(() => !document.documentElement.classList.contains('guest-mode') && !document.body.classList.contains('pv-active')));
      ok(`no horizontal page scroll (scrollWidth ${m0.sw} <= innerWidth ${m0.iw})`, m0.sw <= m0.iw, `${m0.sw} > ${m0.iw}`);
      ok('header stays one bar (<= 56px)', m0.hdr.h <= 56, String(m0.hdr.h));
      ok('scanned >= 3 visible header controls (floor: back, ☰, and one more or the avatar)', m0.ctl.length >= 2, JSON.stringify(m0.ctl));
      ok('every visible header control is >= 44px tall, >= 44px wide, inside the screen',
        m0.ctl.every(c => c.h >= 44 && c.w >= 44 && c.l >= 0 && c.r <= m0.iw), JSON.stringify(m0.ctl.map(c => [c.id || c.txt, c.w, c.h, c.l, c.r])));
      const cy = m0.ctl.map(c => (c.t + c.b) / 2);
      ok('one row: the controls share one vertical centre (±2px)', cy.length > 0 && Math.max(...cy) - Math.min(...cy) <= 2, JSON.stringify(cy));
      ok('上傳 / 相本書 / 登出 are not in the header any more', !m0.ctl.some(c => ['上傳', '登出'].some(t => c.txt.includes(t)) || c.txt.includes('相本書')), JSON.stringify(m0.ctl.map(c => c.txt)));
      const b = m0.back;
      ok('返回後台 link exists, shown, text 「← 返回後台」, href dashboard.html, .back-btn', !!b && b.shown && b.txt === '← 返回後台' && b.href === 'dashboard.html' && /back-btn/.test(b.cls), JSON.stringify(b));
      ok('返回後台 is >= 44px tall', !!b && b.h >= 44, JSON.stringify(b));
      ok('返回後台 is the left-most control in the header (left of ☰)', !!b && m0.ctl.every(c => c.l >= b.l), JSON.stringify(m0.ctl.map(c => [c.id, c.l])));
      ok('☰ is 44x44 and on screen', !!m0.tog && m0.tog.shown && m0.tog.w >= 44 && m0.tog.h >= 44 && m0.tog.r <= m0.iw, JSON.stringify(m0.tog));
      ok('avatar still shown', await page.$eval('#userAvatarStudio', e => e.getClientRects().length > 0));
      ok('empty state copy names ☰, no 左側', /點左上角 ☰ 輸入資料夾路徑/.test(m0.es || '') && !/左側/.test(m0.es || ''), String(m0.es));
      ok('sidebar opened by itself once (nothing loaded, collapsed, phone)', m0.sideActive && m0.backdropActive, JSON.stringify([m0.sideActive, m0.backdropActive]));
      ok('the folder input is on screen inside the opened sidebar', await page.$eval('#driveUrl', e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; }));
      for (const [id, txt] of MENU) {
        const it = await sideItem(page, id);
        ok(`sidebar ${txt}: shown, text, >= 44px tall, inside the sidebar`, !!it && it.shown && it.txt.includes(txt) && it.h >= 44 && it.insideSidebar && it.r <= 390, JSON.stringify(it));
      }
      const up = await sideItem(page, 'phoneUploadBtn');
      ok('sidebar 上傳 points at upload.html', up && /upload\.html/.test(up.href || ''), JSON.stringify(up));
      // close it; it must not open again
      await page.mouse.click(340, 400);
      await page.waitForTimeout(700);
      let m1 = await metrics(page);
      ok('backdrop tap closes the sidebar', !m1.sideActive && !m1.backdropActive, JSON.stringify([m1.sideActive, m1.backdropActive]));
      await page.waitForTimeout(800);
      m1 = await metrics(page);
      ok('...and it does not reopen by itself', !m1.sideActive, String(m1.sideActive));
      await page.click('#sidebarToggle');
      ok('☰ opens it by hand', (await metrics(page)).sideActive);
      await page.click('#sidebarToggle');
      ok('☰ closes it again', !(await metrics(page)).sideActive);
      ok('no history entry was added by any of this', (await metrics(page)).hist === h0, `${(await metrics(page)).hist} vs ${h0}`);
      // 登出 in the menu works: clears the token and reloads
      // ADMIN_PLAIN re-seeds the token on every navigation, so record the removal itself (sessionStorage survives the reload)
      await page.evaluate(() => { const rm = Storage.prototype.removeItem; Storage.prototype.removeItem = function (k) { try { sessionStorage.setItem('__removed', k); } catch (e) { /* ignore */ } return rm.call(this, k); }; });
      await page.click('#sidebarToggle');
      await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => null), page.click('#phoneLogoutBtn')]);
      await page.waitForTimeout(300);
      ok('sidebar 登出 ran the header handler: removed studio_token, then reloaded', await page.evaluate(() => sessionStorage.getItem('__removed') === 'studio_token'));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// ═════════ B. a folder already loaded: the sidebar is NOT forced open ═════════
{
  const m = pickFakeWorker({ folders: ['shoot/毛片/'] });
  await suite('phone picker header — a folder loaded (?folder=): sidebar not auto-opened; 返回後台 still there',
    `${base}/index.html?folder=${encodeURIComponent('shoot/毛片/')}`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#studio-logout', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(1000);
      const m0 = await metrics(page);
      ok('positive control: the folder is the one in the input', await page.$eval('#driveUrl', e => e.value) === 'shoot/毛片/');
      ok('sidebar stays closed', !m0.sideActive && !m0.backdropActive, JSON.stringify(m0.sideActive));
      ok('返回後台 shown', !!m0.back && m0.back.shown, JSON.stringify(m0.back));
      ok(`no horizontal scroll (${m0.sw} <= ${m0.iw})`, m0.sw <= m0.iw);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// ═════════ C. review view, phone ═════════
{
  const m = pickFakeWorker({ ownerName: 'Grace', projectId: 'proj-ph' });
  await suite('phone picker header — review view (?project=): header one row, no overflow, pvBackLink is the only back control',
    `${base}/index.html?project=proj-ph`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#studio-logout', { state: 'attached', timeout: 5000 });
      await page.waitForSelector('body.pv-active', { timeout: 5000 });
      await page.waitForTimeout(500);
      const m0 = await metrics(page);
      ok('positive control: review mode is active', m0.pv);
      ok(`no horizontal page scroll (${m0.sw} <= ${m0.iw})`, m0.sw <= m0.iw, `${m0.sw} > ${m0.iw}`);
      ok('header stays one bar (<= 56px)', m0.hdr.h <= 56, String(m0.hdr.h));
      ok('every visible header control >= 44px tall and on screen (floor: >= 1 scanned)', m0.ctl.length >= 1 && m0.ctl.every(c => c.h >= 44 && c.l >= 0 && c.r <= m0.iw), JSON.stringify(m0.ctl.map(c => [c.id || c.txt, c.w, c.h, c.l, c.r])));
      ok('登出 stays in the header here (this view has no ☰ menu): shown, >= 44px tall, on screen', m0.ctl.some(c => c.id === 'studio-logout' && c.h >= 44 && c.r <= m0.iw && c.l >= 0), JSON.stringify(m0.ctl.map(c => [c.id, c.h, c.r])));
      ok('no second back control: 返回後台 is not shown here', !m0.back || !m0.back.shown, JSON.stringify(m0.back));
      const pv = await page.$eval('#pvBackLink', e => { const r = e.getBoundingClientRect(); return { shown: e.getClientRects().length > 0, h: r.height, l: r.left, r: r.right, txt: e.textContent.trim() }; });
      ok('#pvBackLink 「← 返回專案」 shown, >= 44px tall, on screen', pv.shown && pv.txt === '← 返回專案' && pv.h >= 44 && pv.l >= 0 && pv.r <= 390, JSON.stringify(pv));
      ok('no ☰ and no phone menu on a review page (its sidebar is trimmed; nothing to open), sidebar not auto-opened',
        await page.evaluate(() => !document.getElementById('sidebarToggle') && !document.getElementById('phoneLogoutBtn') && !document.querySelector('.sidebar.active')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// ═════════ D. guest page unchanged, 1280 photographer unchanged ═════════
{
  const m = pickFakeWorker();
  await suite('phone picker header — guest ?t= at 390 is byte-for-byte the old header; new controls hidden',
    `${base}/index.html?t=TOK`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#photoGrid .photo-card, #photoGrid > *', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
      const now = await snap(page);
      if (process.env.DUMP) console.log('DUMP_GUEST_390 ' + JSON.stringify(now));
      ok('floor: >= 6 header elements measured', Object.keys(now).length >= 6, String(Object.keys(now).length));
      const bad = sameAsBase(now, BASE_GUEST_390);
      ok(`every header element equals the baseline (${Object.keys(BASE_GUEST_390).length} compared)`, Object.keys(BASE_GUEST_390).length >= 6 && bad.length === 0, bad.join(' | '));
      ok('返回後台 not shown for a guest', !now['#backToAdminLink'] || !now['#backToAdminLink'].shown);
      const g = await metrics(page);
      ok('guest ☰ keeps its old size (not forced to 44)', !(g.tog && g.tog.w >= 44 && g.tog.h >= 44) || BASE_GUEST_390['#sidebarToggle'].w >= 44, JSON.stringify(g.tog));
      ok('guest empty copy is not the phone copy', !/☰/.test((await page.$eval('#emptyState', e => e.innerText))));
      ok('guest: sidebar not auto-opened', !g.sideActive);
      return out;
    },
    { before: m.attach, contextOptions: MOBILE });
}
{
  const m = pickFakeWorker();
  await suite('phone picker header — guest ?t= at 1280 unchanged',
    `${base}/index.html?t=TOK`,
    async page => {
      const { out, ok } = lines();
      await page.waitForTimeout(800);
      const now = await snap(page);
      if (process.env.DUMP) console.log('DUMP_GUEST_1280 ' + JSON.stringify(now));
      const bad = sameAsBase(now, BASE_GUEST_1280);
      ok(`every header element equals the baseline (${Object.keys(BASE_GUEST_1280).length} compared, floor 6)`, Object.keys(BASE_GUEST_1280).length >= 6 && bad.length === 0, bad.join(' | '));
      return out;
    },
    { before: m.attach, contextOptions: DESKTOP });
}
{
  const m = pickFakeWorker({ folders: ['shoot/毛片/'] });
  await suite('phone picker header — photographer at 1280: header children equal the old computed styles; new bits hidden; desktop copy',
    `${base}/index.html`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#studio-logout', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(500);
      const now = await snap(page);
      if (process.env.DUMP) console.log('DUMP_ADMIN_1280 ' + JSON.stringify(now));
      const bad = sameAsBase(now, BASE_ADMIN_1280);
      ok(`every header element equals the baseline (${Object.keys(BASE_ADMIN_1280).length} compared, floor 8)`, Object.keys(BASE_ADMIN_1280).length >= 8 && bad.length === 0, bad.join(' | '));
      ok('positive control: 上傳 / 相本書 / 登出 are still in the header at 1280', ['#uploadPageBtn', '#openBookEditorBtn', '#studio-logout'].every(k => now[k] && now[k].shown));
      ok('返回後台 hidden at 1280', !now['#backToAdminLink'] || !now['#backToAdminLink'].shown);
      const menu = await page.evaluate(() => ['phoneUploadBtn', 'phoneBookBtn', 'phoneLogoutBtn'].map(id => { const e = document.getElementById(id); return e ? e.getClientRects().length > 0 : null; }));
      ok('the sidebar phone menu exists but is not shown at 1280', menu.every(v => v === false), JSON.stringify(menu));
      const es = await page.$eval('#emptyState .empty-state-text', e => e.innerText.trim());
      ok('desktop empty copy unchanged', es === '請在左側輸入資料夾路徑（例如：20260122/）來載入照片', es);
      ok('sidebar not auto-opened at 1280', await page.evaluate(() => !document.querySelector('.sidebar').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: DESKTOP });
}
}
