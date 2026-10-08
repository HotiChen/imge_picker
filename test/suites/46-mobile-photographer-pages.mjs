// Browser suites: the photographer's pages at phone width (390x844, DPR 3) and, as the positive control,
// at 1280 where nothing may change. Pages: admin.html (list, create form, detail, clients), dashboard,
// orders, settings, operator.
// Phone: the shared side menu (css/side-nav.css, rendered by js/side-nav.js) turns into a one-line
// horizontally scrollable pill row ABOVE the content, header never wraps, no horizontal page scroll.
// Desktop: .side-nav / .side-nav-item / .active computed styles equal the pre-change baseline (NAV_BASE).
// Chromium only, not real iOS Safari. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN_ALWAYS, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, clone, ordersFake } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openCreateForm } from '../lib/project-helpers.mjs';

export default async function register() {
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const LONG = '王小明 & 陳小美 婚紗外拍 超長的專案名稱用來測試換行是否會把整個頁面撐寬';

// Everything measured in one evaluate. `scanned` is the floor for the "nothing overflows" claims.
const measure = page => page.evaluate(() => {
  const R = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const items = [...document.querySelectorAll('.side-nav-item')].filter(vis);
  const nav = document.querySelector('.side-nav');
  const main = document.querySelector('main');
  const sub = document.querySelector('header .subtitle');
  const lo = document.querySelector('header .btn-logout');
  const bv = document.getElementById('buildVersion');
  const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
  // every visible field/input/select/textarea must end inside the viewport
  const ctl = [...document.querySelectorAll('main input, main select, main textarea, main .field')].filter(vis);
  const mc = cs('main');
  return {
    sw: document.documentElement.scrollWidth, iw: innerWidth,
    nav: R('.side-nav'), main: R('main'), header: R('header'),
    navOverflowX: nav ? getComputedStyle(nav).overflowX : null,
    list: (() => { const l = document.querySelector('.side-nav-list'); return l ? { sw: l.scrollWidth, cw: l.clientWidth, ox: getComputedStyle(l).overflowX } : null; })(),
    items: items.map(e => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), h: r.height, w: r.width, l: r.left, r: r.right, txt: e.textContent.trim(), active: e.classList.contains('active'), nowrap: e.scrollHeight <= r.height + 1 }; }),
    hidden: [...document.querySelectorAll('.side-nav-item')].filter(e => !vis(e)).map(e => e.textContent.trim()),
    sub: sub && { h: sub.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(sub).lineHeight) || parseFloat(getComputedStyle(sub).fontSize) * 1.4, r: sub.getBoundingClientRect().right, txt: sub.textContent },
    logout: lo && { ...(({ left, right, top, bottom, width, height }) => ({ left, right, top, bottom, w: width, h: height }))(lo.getBoundingClientRect()), fs: parseFloat(getComputedStyle(lo).fontSize), ws: getComputedStyle(lo).whiteSpace },
    bv: bv && { shown: vis(bv), txt: bv.textContent },
    mainPad: mc && [mc.paddingLeft, mc.paddingRight],
    ctlCount: ctl.length, ctlOver: ctl.filter(e => e.getBoundingClientRect().right > innerWidth + 0.5).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().right)),
    wide: [...document.querySelectorAll('main *')].filter(e => vis(e) && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.table-wrap, .side-nav-list')).slice(0, 5).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)),
  };
});

// The phone contract, shared by every page that has the side menu.
function phoneChecks(ok, m, label, { hasNav = true, hasFields = 0 } = {}) {
  ok(`${label}: no horizontal page scroll (scrollWidth ${m.sw} <= innerWidth ${m.iw})`, m.sw <= m.iw, `${m.sw} > ${m.iw}`);
  ok(`${label}: nothing visible in <main> sticks out past the viewport (outside own scroll containers)`, m.wide.length === 0, JSON.stringify(m.wide));
  if (hasFields) ok(`${label}: scanned >= ${hasFields} form controls (floor) and none overflows`, m.ctlCount >= hasFields && m.ctlOver.length === 0, `${m.ctlCount} ${JSON.stringify(m.ctlOver)}`);
  ok(`${label}: main padding is 16px both sides`, m.mainPad && m.mainPad[0] === '16px' && m.mainPad[1] === '16px', JSON.stringify(m.mainPad));
  ok(`${label}: header: subtitle on one line`, m.sub && m.sub.h <= m.sub.lh * 1.5 && m.sub.r <= m.iw, JSON.stringify(m.sub));
  ok(`${label}: header: 登出 on one line, nowrap, inside the screen, >= 44px tall`, m.logout && m.logout.ws === 'nowrap' && m.logout.h <= 48 && m.logout.h >= 44 && m.logout.right <= m.iw - 8, JSON.stringify(m.logout));
  ok(`${label}: header: version stamp not shown on a phone (and it was filled, so this is not an empty span)`, m.bv && !m.bv.shown, JSON.stringify(m.bv));
  ok(`${label}: header stays one bar (<= 56px)`, m.header.h <= 56, String(m.header.h));
  if (!hasNav) return;
  ok(`${label}: side menu is full width, not a column (width ${Math.round(m.nav.w)})`, m.nav.w >= m.iw - 1, String(m.nav.w));
  ok(`${label}: side menu sits ABOVE main, not beside it`, m.nav.b <= m.main.t + 1 && m.main.l <= 1, JSON.stringify([m.nav, m.main]));
  ok(`${label}: main uses the full width`, m.main.w >= m.iw - 1, String(m.main.w));
  ok(`${label}: >= 7 nav pills, all on ONE line (same top)`, m.items.length >= 7 && new Set(m.items.map(i => i.t)).size === 1, JSON.stringify(m.items.map(i => i.t)));
  ok(`${label}: every pill >= 44px tall, label never wraps`, m.items.every(i => i.h >= 44 && i.nowrap), JSON.stringify(m.items.map(i => [i.txt, i.h, i.nowrap])));
  ok(`${label}: the pill row scrolls inside itself (overflow-x auto/scroll, content wider than box)`, m.list && /auto|scroll/.test(m.list.ox) && m.list.sw > m.list.cw, JSON.stringify(m.list));
  ok(`${label}: exactly one active pill, and it is scrolled into the visible part of the row`, m.items.filter(i => i.active).length === 1 && m.items.filter(i => i.active).every(i => i.l >= -1 && i.r <= m.iw + 1), JSON.stringify(m.items.filter(i => i.active)));
  ok(`${label}: no second 登出 in the menu (it is in the header)`, !m.items.some(i => i.txt === '登出'), JSON.stringify(m.items.map(i => i.txt)));
}

// Desktop baseline, captured from 860c645 BEFORE css/side-nav.css existed (ONE deliberate change: the 登出 item of
// dashboard/orders/settings had border-radius 999px, admin's 0; unified to admin's 0, see LOGOUT_RADIUS).
const NAV_BASE = {
  admin: {"nav":{"width":"190px","paddingTop":"20px","paddingRight":"14px","paddingBottom":"20px","paddingLeft":"14px","backgroundColor":"rgb(255, 255, 255)","borderRightWidth":"1px","borderRightColor":"rgb(239, 230, 216)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"brand":{"width":"161px","paddingTop":"0px","paddingRight":"10px","paddingBottom":"12px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"10px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"2px","borderBottomWidth":"1px","marginBottom":"10px"},"list":{"width":"161px","paddingTop":"0px","paddingRight":"0px","paddingBottom":"0px","paddingLeft":"0px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"flex","textAlign":"start","marginTop":"0px","flexDirection":"column","gap":"2px","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"item":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(91, 79, 66)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(91, 79, 66)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"active":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgb(255, 217, 168)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"600","color":"rgb(35, 27, 18)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"logout":{"width":"161px","paddingTop":"14px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"1px","borderRadius":"0px","fontSize":"13px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"left","marginTop":"14px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"}},
  dashboard: {"nav":{"width":"190px","paddingTop":"20px","paddingRight":"14px","paddingBottom":"20px","paddingLeft":"14px","backgroundColor":"rgb(255, 255, 255)","borderRightWidth":"1px","borderRightColor":"rgb(239, 230, 216)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"brand":{"width":"161px","paddingTop":"0px","paddingRight":"10px","paddingBottom":"12px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"10px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"2px","borderBottomWidth":"1px","marginBottom":"10px"},"list":{"width":"161px","paddingTop":"0px","paddingRight":"0px","paddingBottom":"0px","paddingLeft":"0px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"flex","textAlign":"start","marginTop":"0px","flexDirection":"column","gap":"2px","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"item":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(91, 79, 66)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(91, 79, 66)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"active":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgb(255, 217, 168)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"600","color":"rgb(35, 27, 18)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"logout":{"width":"161px","paddingTop":"14px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"1px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"left","marginTop":"14px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"}},
  orders: {"nav":{"width":"190px","paddingTop":"20px","paddingRight":"14px","paddingBottom":"20px","paddingLeft":"14px","backgroundColor":"rgb(255, 255, 255)","borderRightWidth":"1px","borderRightColor":"rgb(239, 230, 216)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"brand":{"width":"161px","paddingTop":"0px","paddingRight":"10px","paddingBottom":"12px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"10px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"2px","borderBottomWidth":"1px","marginBottom":"10px"},"list":{"width":"161px","paddingTop":"0px","paddingRight":"0px","paddingBottom":"0px","paddingLeft":"0px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"flex","textAlign":"start","marginTop":"0px","flexDirection":"column","gap":"2px","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"item":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(91, 79, 66)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(91, 79, 66)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"active":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgb(255, 217, 168)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"600","color":"rgb(35, 27, 18)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"logout":{"width":"161px","paddingTop":"14px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"1px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"left","marginTop":"14px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"}},
  settings: {"nav":{"width":"190px","paddingTop":"20px","paddingRight":"14px","paddingBottom":"20px","paddingLeft":"14px","backgroundColor":"rgb(255, 255, 255)","borderRightWidth":"1px","borderRightColor":"rgb(239, 230, 216)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"brand":{"width":"161px","paddingTop":"0px","paddingRight":"10px","paddingBottom":"12px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"10px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"start","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"2px","borderBottomWidth":"1px","marginBottom":"10px"},"list":{"width":"161px","paddingTop":"0px","paddingRight":"0px","paddingBottom":"0px","paddingLeft":"0px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"0px","fontSize":"14px","fontWeight":"400","color":"rgb(35, 27, 18)","display":"flex","textAlign":"start","marginTop":"0px","flexDirection":"column","gap":"2px","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"item":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(91, 79, 66)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(91, 79, 66)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"active":{"width":"161px","paddingTop":"9px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgb(255, 217, 168)","borderRightWidth":"0px","borderRightColor":"rgb(35, 27, 18)","borderTopWidth":"0px","borderRadius":"999px","fontSize":"13px","fontWeight":"600","color":"rgb(35, 27, 18)","display":"block","textAlign":"left","marginTop":"0px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"},"logout":{"width":"161px","paddingTop":"14px","paddingRight":"10px","paddingBottom":"9px","paddingLeft":"10px","backgroundColor":"rgba(0, 0, 0, 0)","borderRightWidth":"0px","borderRightColor":"rgb(122, 109, 93)","borderTopWidth":"1px","borderRadius":"999px","fontSize":"13px","fontWeight":"400","color":"rgb(122, 109, 93)","display":"block","textAlign":"left","marginTop":"14px","flexDirection":"row","gap":"normal","letterSpacing":"normal","borderBottomWidth":"0px","marginBottom":"0px"}},
};
// the one intended desktop difference: the three pages now share admin's square 登出 item (a 1px top rule with
// a pill radius curled at its ends)
const LOGOUT_RADIUS = { dashboard: '999px', orders: '999px', settings: '999px', admin: '0px' };
const navStyle = page => page.evaluate(() => {
  const P = ['width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'borderRightWidth', 'borderRightColor', 'borderTopWidth', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'display', 'textAlign', 'marginTop', 'flexDirection', 'gap', 'letterSpacing', 'borderBottomWidth', 'marginBottom'];
  const pick = s => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); return Object.fromEntries(P.map(p => [p, c[p]])); };
  return { nav: pick('.side-nav'), brand: pick('.side-nav-brand'), list: pick('.side-nav-list'), item: pick('.side-nav-item:not(.active):not(.side-nav-logout)'), active: pick('.side-nav-item.active'), logout: pick('.side-nav-logout') };
});
const diff = (a, b) => { const d = []; for (const k of Object.keys(b)) for (const p of Object.keys(b[k] || {})) if (a?.[k]?.[p] !== b[k][p]) d.push(`${k}.${p}: ${a?.[k]?.[p]} != ${b[k][p]}`); return d; };

const dash = () => dashSettingsMock({
  stats: { by_phase: { picking: 3, submitted: 2, retouching: 1 }, delivered: 9, archived: 0,
    per_month: [{ month: '2026-05', created: 2, delivered: 1 }, { month: '2026-06', created: 4, delivered: 3 }], todo: { submitted_not_retouching: 1, unnotified_submissions: 0, modified_after_submit: 0 } },
  projects: [{ id: 'p1', title: LONG, phase: 'submitted', created_at: '2026-09-01T00:00:00Z' }],
});
const PAGES = {
  admin: () => { const m = pickFakeWorker({ projectId: 'proj-1', title: LONG, folders: ['20260819/'] }); return { url: `${base}/admin.html#projects`, before: m.attach, initScript: ADMIN_PLAIN }; },
  detail: () => { const m = pickFakeWorker({ projectId: 'proj-1', title: LONG, folders: ['20260819/'] }); return { url: `${base}/admin.html#project=proj-1`, before: m.attach, initScript: ADMIN_PLAIN }; },
  clients: () => { const m = pickFakeWorker({ projectId: 'proj-1', title: LONG }); return { url: `${base}/admin.html#clients`, before: m.attach, initScript: ADMIN_PLAIN }; },
  dashboard: () => { const m = dash(); return { url: `${base}/dashboard.html`, before: m.attach, initScript: SEED_TOKEN_ALWAYS }; },
  settings: () => { const m = dash(); return { url: `${base}/settings.html`, before: m.attach, initScript: SEED_TOKEN_ALWAYS }; },
  orders: () => {
    const m = dash(); const o = ordersFake({ products: [], titles: { 'proj-1': LONG } });
    o.st.addOrder({ id: 'o1', project_id: 'proj-1', status: 'confirmed', items: [{ name: '相本書 超長的品名 超長的品名 超長的品名', option_label: '8×8 吋', unit_price: 1234, qty: 1 }, { name: '無框畫', unit_price: 3000, qty: 2 }] });
    o.st.addOrder({ id: 'o2', project_id: 'proj-1', status: 'fulfilled', paid_amount: 3000, paid_method: 'cash', items: [{ name: '無框畫', unit_price: 3000, qty: 1 }] });
    return { url: `${base}/orders.html`, before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN_ALWAYS };
  },
  operator: () => { const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [] }); return { url: `${base}/operator.html`, before: o.attach, initScript: OP_SEED }; },
};
const CAPTURE = process.env.CAPTURE === '1';
const SHOT = process.env.SHOTS;   // dir: screenshots at 390 for the report

const run = (name, key, opts, fn) => {
  const p = PAGES[key]();
  return suite(name, p.url, async page => {
    const { out, ok } = lines();
    await page.waitForTimeout(250);
    await fn(page, ok, out);
    if (SHOT) await page.screenshot({ path: `${SHOT}/${opts.shot || key}-${opts.tag || process.env.TAG || 'after'}.png`, fullPage: false });
    return out;
  }, { before: p.before, initScript: p.initScript, contextOptions: opts.desktop ? DESKTOP : MOBILE });
};

// ═════════════════════ phone ═════════════════════
await run('mobile pages 390 — admin 選片專案 list + create form', 'admin', { shot: 'admin-list' }, async (page, ok) => {
  await page.waitForSelector('[data-project-row]', { timeout: 5000 });
  await openCreateForm(page);   // the form is behind 「＋ 新增專案」
  const m = await measure(page);
  ok('positive control: the list row for the long title is rendered', m.main && (await page.$$('[data-project-row]')).length >= 1);
  phoneChecks(ok, m, 'list', { hasFields: 4 });
  const date = await page.$eval('#proj-date', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
  ok('create form: the date field is inside the screen with the 16px gutter', date.l >= 15 && date.r <= 390 - 15, JSON.stringify(date));
  const cols = await page.$$eval('#project-create-panel .pick-admin-row', rows => rows.map(r => new Set([...r.children].map(c => Math.round(c.getBoundingClientRect().top))).size === r.children.length));
  ok('create form: two-column rows are single column (children stacked)', cols.length >= 2 && cols.every(Boolean), JSON.stringify(cols));
  const row = await page.$eval('[data-project-row]', e => { const r = e.getBoundingClientRect(); return { r: r.right, sw: e.scrollWidth, cw: e.clientWidth }; });
  ok('project row stays inside the screen', row.r <= 390 && row.sw <= row.cw + 1, JSON.stringify(row));
});
await run('mobile pages 390 — admin 專案詳情', 'detail', { shot: 'admin-detail' }, async (page, ok) => {
  await page.waitForSelector('#pd-rename-btn', { timeout: 5000 });
  const m = await measure(page);
  phoneChecks(ok, m, 'detail', {});
  const btns = await page.$$eval('#project-detail-panel button, #project-detail-panel a.btn', els => els.filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().right)));
  ok('detail: buttons scanned (floor >= 3) and none past the screen', btns.length >= 3 && btns.every(r => r <= 390), JSON.stringify(btns));
});
await run('mobile pages 390 — admin 客戶', 'clients', {}, async (page, ok) => {
  const m = await measure(page);
  ok('positive control: the clients view is the active one', m.items.some(i => i.active && i.txt === '客戶'), JSON.stringify(m.items.map(i => [i.txt, i.active])));
  phoneChecks(ok, m, 'clients', {});
});
await run('mobile pages 390 — dashboard', 'dashboard', { shot: 'dashboard' }, async (page, ok) => {
  await page.waitForFunction(() => document.getElementById('stat-picking')?.textContent !== '–', null, { timeout: 4000 }).catch(() => {});
  const m = await measure(page);
  ok('positive control: stats loaded', (await page.textContent('#stat-picking')) === '3');
  phoneChecks(ok, m, 'dashboard', {});
  await page.evaluate(() => { for (const id of ['stat-revenue', 'stat-margin', 'stat-outstanding']) document.getElementById(id).textContent = 'NT$1,234,567'; });
  const money = await page.$$eval('.stat-cards.money .stat-card', els => els.map(e => [e.scrollWidth <= e.clientWidth, Math.round(e.getBoundingClientRect().width)]));
  ok('money cards (3) hold a 7-digit amount without overflowing, one per row', money.length === 3 && money.every(x => x[0] && x[1] >= 300), JSON.stringify(money));
  const cards = await page.$$eval('.stat-card', els => els.map(e => Math.round(e.getBoundingClientRect().right)));
  ok('stat cards: scanned 7 and inside the screen', cards.length === 7 && cards.every(r => r <= 390), JSON.stringify(cards));
});
await run('mobile pages 390 — orders', 'orders', {}, async (page, ok) => {
  await page.waitForSelector('.ord-row', { timeout: 5000 });
  const m = await measure(page);
  phoneChecks(ok, m, 'orders', {});
  const rows = await page.$$eval('.ord-row', els => els.map(e => ({ r: Math.round(e.getBoundingClientRect().right), wrap: getComputedStyle(e).flexWrap, side: Math.round(e.querySelector('.ord-side').getBoundingClientRect().right) })));
  ok('order rows (2): inside the screen incl. the right-hand column', rows.length === 2 && rows.every(r => r.r <= 390 && r.side <= 390), JSON.stringify(rows));
});
await run('mobile pages 390 — settings', 'settings', { shot: 'settings' }, async (page, ok) => {
  await page.waitForSelector('#set-studio-name', { timeout: 5000 });
  const m = await measure(page);
  phoneChecks(ok, m, 'settings', { hasFields: 4 });
});
await run('mobile pages 390 — operator (own layout, no side menu)', 'operator', {}, async (page, ok) => {
  await page.waitForSelector('#op-list', { timeout: 5000 });
  await page.waitForSelector('#op-add-btn', { timeout: 5000 });
  await page.click('#op-add-btn');
  await page.waitForSelector('#op-form');
  const m = await measure(page);
  ok('positive control: the product form is open', !!(await page.$('#op-form')));
  phoneChecks(ok, m, 'operator', { hasNav: false, hasFields: 5 });
  const hdr = await page.$eval('header .brand', e => e.getBoundingClientRect().height);
  ok('operator brand on one line', hdr <= 24, String(hdr));
  const rows = await page.$$eval('#op-form .opt-row', rs => rs.map(r => Math.round(r.getBoundingClientRect().right)));
  ok('option rows (floor >= 1) inside the screen', rows.length >= 1 && rows.every(r => r <= 390), JSON.stringify(rows));
});

// ═════════════════════ desktop control: unchanged ═════════════════════
for (const [key, nm] of [['admin', 'admin'], ['dashboard', 'dashboard'], ['orders', 'orders'], ['settings', 'settings']]) {
  await run(`mobile pages 1280 control — ${nm}: side menu still a 190px column beside main, computed styles identical to the baseline`, key, { desktop: true, tag: 'desktop' }, async (page, ok) => {
    const m = await measure(page);
    const s = await navStyle(page);
    if (CAPTURE) console.log('CAPTURE ' + key + ' ' + JSON.stringify(s));
    ok('nav is a 190px column to the LEFT of main', Math.round(m.nav.w) === 190 && m.nav.r <= m.main.l + 1 && m.nav.t < m.main.b, JSON.stringify([m.nav, m.main]));
    ok('all 8 items + 登出 in the list, stacked vertically', m.items.length === 9 && new Set(m.items.map(i => i.t)).size === 9, String(m.items.length));
    ok('header version stamp still shown on desktop', m.bv && m.bv.shown, JSON.stringify(m.bv));
    ok('main padding still 24px', m.mainPad[0] === '24px', JSON.stringify(m.mainPad));
    ok('baseline exists for this page (not an empty compare)', !!NAV_BASE[key]);
    if (!CAPTURE) { const d = diff(s, NAV_BASE[key] || {}).filter(x => !(x.startsWith('logout.borderRadius') && x.endsWith(LOGOUT_RADIUS[key])));
      ok('the 登出 item radius is now admin’s 0 everywhere (the single deliberate difference)', s.logout.borderRadius === '0px', s.logout.borderRadius); ok('computed styles of .side-nav / brand / list / item / active / logout equal the baseline', d.length === 0, d.join('; ')); }
  });
}
}
