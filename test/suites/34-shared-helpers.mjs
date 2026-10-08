// Browser suites: the shared date and price helpers in js/util.js (Util.fmtDate, Util.todayTaipei,
// Util.formatPrice). Before them the same Intl.DateTimeFormat / toLocaleString code lived in pick.js,
// project-view.js, admin.html, completion-page.js and orders-common.js. The one intended output change:
// the 完成頁 prints NT$5,000 (it used to print "NT$ 5,000", with a space).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { base, suite } from '../lib/harness.mjs';
import { ROOT } from '../lib/env.mjs';
import { ADMIN, ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ordersFake, secInfo, secWait } from '../lib/orders-fake.mjs';
import { pickFakeWorker, shopProductsFake } from '../lib/pick-fake.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { doneOpts, ADMIN_BUCKET } from '../lib/delivery-helpers.mjs';

export default async function register() {
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
const topHtml = readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const jsFiles = readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
const scriptBlocks = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({
  src: (m[1].match(/\bsrc="([^"]+)"/) || [])[1] || null, body: m[2], index: m.index,
}));

// ── 1. the helpers themselves, in a real page ───────────────────────────────
await suite('util helpers — Util.fmtDate / todayTaipei / formatPrice: shapes, invalid input, Taipei midnight, money edge cases',
  `${base}/tutorial.html`,
  async page => {
    const out = [];
    const ok = okFn(out);
    await page.addScriptTag({ url: `${base}/js/util.js` });
    const r = await page.evaluate(() => {
      const U = window.Util;
      const f = (v, s) => U.fmtDate(v, s);
      // pin "now" so todayTaipei can be probed on both sides of Taipei midnight (UTC+8: 16:00Z is 00:00 next day)
      const RealDate = Date;
      const at = iso => { const t = new RealDate(iso).getTime(); window.Date = class extends RealDate { constructor(...a) { a.length ? super(...a) : super(t); } static now() { return t; } }; };
      const today = {};
      for (const iso of ['2026-10-05T15:59:59.999Z', '2026-10-05T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2026-03-01T00:00:00.000Z']) { at(iso); today[iso] = U.todayTaipei(); }
      window.Date = RealDate;
      return {
        keys: Object.keys(U).sort(),
        types: ['escHtml', 'fmtDate', 'todayTaipei', 'formatPrice'].map(k => typeof U[k]),
        ymd: f('2026-09-21T03:00:00.000Z', 'ymd'), md: f('2026-09-21T03:00:00.000Z', 'md'),
        mdhm: f('2026-09-27T14:52:00.000Z', 'mdhm'), iso: f('2026-09-21T03:00:00.000Z', 'iso'),
        // the boundary: 15:59Z is still the 5th in Taipei, 16:00Z is the 6th
        b1: ['ymd', 'md', 'iso', 'mdhm'].map(s => f('2026-10-05T15:59:00.000Z', s)),
        b2: ['ymd', 'md', 'iso', 'mdhm'].map(s => f('2026-10-05T16:00:00.000Z', s)),
        // a year boundary: 2026-12-31T16:00Z is already 2027/1/1 in Taipei
        ny: [f('2026-12-31T16:00:00.000Z', 'ymd'), f('2026-12-31T16:00:00.000Z', 'iso'), f('2026-12-31T15:59:00.000Z', 'ymd')],
        invalid: [undefined, null, '', 0, 'not a date', '2026-13-45', NaN, {}].map(v => ['ymd', 'md', 'mdhm', 'iso'].map(s => f(v, s))),
        badShape: [f('2026-09-21T03:00:00.000Z', 'nope'), f('2026-09-21T03:00:00.000Z'), f('2026-09-21T03:00:00.000Z', 'toString')],
        dateObj: f(new Date('2026-09-21T03:00:00.000Z'), 'ymd'), epoch: f(Date.UTC(2026, 8, 21, 3), 'md'),
        today,
        todayShape: /^\d{4}-\d{2}-\d{2}$/.test(U.todayTaipei()),
        p: [5000, 0, 1234567, 1e6, 999, 1000, 12, 1500.4, 1500.5, -100, -0.4, 1e21].map(U.formatPrice),
        pBad: [NaN, Infinity, -Infinity, undefined, null, 'abc', '', {}].map(U.formatPrice),
        pStr: [U.formatPrice('5000'), U.formatPrice('1234.6')],
      };
    });
    ok('Util exposes escHtml, the date / price functions and the pick-link message pair (nothing else)', JSON.stringify(r.keys) === '["PICK_LINK_DEFAULT","escHtml","fmtDate","formatPrice","pickLinkMessage","todayTaipei"]' && r.types.every(t => t === 'function'), JSON.stringify([r.keys, r.types]));
    ok("fmtDate 'ymd' is zh-TW numeric y/m/d (2026/9/21)", r.ymd === '2026/9/21', r.ymd);
    ok("fmtDate 'md' is zh-TW numeric m/d (9/21)", r.md === '9/21', r.md);
    ok("fmtDate 'mdhm' is zh-TW m/d hh:mm 24h in Taipei (9/27 22:52)", r.mdhm === '9/27 22:52', r.mdhm);
    ok("fmtDate 'iso' is en-CA yyyy-mm-dd (2026-09-21)", r.iso === '2026-09-21', r.iso);
    ok('boundary 15:59Z is still the 5th in Taipei, in every shape', JSON.stringify(r.b1) === JSON.stringify(['2026/10/5', '10/5', '2026-10-05', '10/5 23:59']), JSON.stringify(r.b1));
    ok('boundary 16:00Z is the 6th (a UTC-based date would still say the 5th), in every shape', JSON.stringify(r.b2.slice(0, 3)) === JSON.stringify(['2026/10/6', '10/6', '2026-10-06']) && /^10\/6 0?0:00$/.test(r.b2[3]), JSON.stringify(r.b2));
    ok('the year rolls over in Taipei time (2026-12-31T16:00Z is 2027/1/1, 15:59Z is still 2026/12/31)', JSON.stringify(r.ny) === JSON.stringify(['2027/1/1', '2027-01-01', '2026/12/31']), JSON.stringify(r.ny));
    ok("invalid input (undefined, null, '', 0, garbage, NaN, {}) gives '' in every shape, never 'Invalid Date' or a throw", r.invalid.length === 8 && r.invalid.every(row => row.every(x => x === '')), JSON.stringify(r.invalid));
    ok("an unknown or missing shape gives '' (no invented formats)", r.badShape.every(x => x === ''), JSON.stringify(r.badShape));
    ok('a Date object and an epoch number work like an ISO string', r.dateObj === '2026/9/21' && r.epoch === '9/21', JSON.stringify([r.dateObj, r.epoch]));
    ok('todayTaipei: 15:59:59.999Z is the 5th, 16:00Z the 6th, 2026-12-31T16:00Z is 2027-01-01, midnight UTC is 08:00 the same day',
      r.today['2026-10-05T15:59:59.999Z'] === '2026-10-05' && r.today['2026-10-05T16:00:00.000Z'] === '2026-10-06' && r.today['2026-12-31T16:00:00.000Z'] === '2027-01-01' && r.today['2026-03-01T00:00:00.000Z'] === '2026-03-01', JSON.stringify(r.today));
    ok('todayTaipei is YYYY-MM-DD for the real clock', r.todayShape);
    ok('formatPrice: NT$5,000 with no space, thousands separators', r.p[0] === 'NT$5,000' && r.p[2] === 'NT$1,234,567' && r.p[3] === 'NT$1,000,000' && r.p[4] === 'NT$999' && r.p[5] === 'NT$1,000' && r.p[6] === 'NT$12', JSON.stringify(r.p));
    ok('formatPrice: 0 is NT$0, floats are rounded (1500.4 → 1,500; 1500.5 → 1,501)', r.p[1] === 'NT$0' && r.p[7] === 'NT$1,500' && r.p[8] === 'NT$1,501', JSON.stringify(r.p));
    ok('formatPrice: a negative keeps its sign after the NT$ (callers like operator.html build −NT$ themselves); a -0 from rounding is NT$0, not NT$-0', r.p[9] === 'NT$-100' && r.p[10] === 'NT$0', JSON.stringify([r.p[9], r.p[10]]));
    ok('formatPrice: 1e21 does not turn into exponent text', /^NT\$1,000,000,000,000,000,000,000$/.test(r.p[11]), r.p[11]);
    ok('formatPrice: NaN / ±Infinity / undefined / null / garbage / {} → NT$0', r.pBad.every(x => x === 'NT$0'), JSON.stringify(r.pBad));
    ok('formatPrice: numeric strings are numbers (the Worker may send "5000"); "1234.6" rounds', r.pStr[0] === 'NT$5,000' && r.pStr[1] === 'NT$1,235', JSON.stringify(r.pStr));
    return out;
  });

// ── 2. no duplicate formatter is left; the pages that call Util load util.js first ──
// A copy is any Intl.DateTimeFormat or toLocaleString('en-US') outside util.js, or a price printed as "NT$ ${...".
const COPY = /Intl\.DateTimeFormat|toLocaleString\(\s*['"]en-US['"]\s*\)|toLocaleDateString\(|NT\$ ?\$\{[^}]*toLocale/;
const COPY_SPACE = /NT\$ \$\{/;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
await suite('util helpers — no Intl.DateTimeFormat / toLocaleString(en-US) copy is left outside js/util.js; callers delegate to Util',
  `${base}/tutorial.html`,
  async () => {
    const out = [];
    const ok = okFn(out);
    const files = [...topHtml, ...jsFiles];
    const offenders = [];
    let readCount = 0;
    for (const f of files) {
      if (f === 'js/util.js') continue;
      readCount++;
      stripComments(read(f)).split('\n').forEach((l, i) => { if (COPY.test(l) || COPY_SPACE.test(l)) offenders.push(`${f}:${i + 1}`); });
    }
    ok('floor: scanned the top-level pages and every script in js/', readCount >= 30 && topHtml.length >= 9, String(readCount));
    ok('no page or script (admin.html, pick.js, project-view.js, completion-page.js, orders-common.js, ...) formats a date or price itself', offenders.length === 0, offenders.join(', '));
    const must = {
      'js/pick.js': [/Util\.fmtDate\(/], 'js/project-view.js': [/Util\.fmtDate\(/],
      'admin.html': [/Util\.fmtDate\(/, /Util\.todayTaipei\(/], 'js/completion-page.js': [/Util\.formatPrice/],
      'js/orders-common.js': [/Util\.formatPrice/],
    };
    for (const [f, res] of Object.entries(must)) {
      const src = stripComments(read(f));
      ok(`${f} calls the shared helper (${res.map(r => r.source).join(', ')})`, res.every(r => r.test(src)));
    }
    const util = read('js/util.js');
    ok('js/util.js is where they live: Intl.DateTimeFormat with zh-TW and en-CA, Asia/Taipei, and the NT$ price', /zh-TW/.test(util) && /en-CA/.test(util) && /Asia\/Taipei/.test(util) && /NT\$/.test(util));
    ok('js/util.js is still a plain script (no import / export)', !/^\s*(?:import|export)\b/m.test(util));
    // controls: the regex must flag a reintroduced copy, and not flag the delegating code
    ok('control: the scan flags a re-introduced date copy, an en-US price copy and the spaced price',
      COPY.test(`return new Intl.DateTimeFormat('zh-TW', {})`) && COPY.test(`Number(n).toLocaleString('en-US')`) && COPY_SPACE.test('`NT$ ${n}`'));
    ok('control: the scan does not flag the delegating code', !COPY.test(`return Util.fmtDate(iso, 'ymd');`) && !COPY.test(`const money = n => Util.formatPrice(n);`));
    // config.js keeps its escapeHtml: book_editor loads config.js but not util.js
    const cfg = read('js/config.js');
    const beUsers = ['book_editor/index.html', 'book_editor/view.html'].map(read);
    ok('config.js still defines escapeHtml, because book_editor pages load config.js and not util.js',
      /function escapeHtml\(/.test(cfg) && beUsers.every(h => /js\/config\.js/.test(h) && !/util\.js/.test(h)));
    ok('app.js and project-view.js use window.escHtml, not the config.js copy',
      !/\bescapeHtml\(/.test(stripComments(read('js/app.js'))) && !/\bescapeHtml\(/.test(stripComments(read('js/project-view.js'))) &&
      /escHtml\(/.test(read('js/app.js')) && /escHtml\(/.test(read('js/project-view.js')));
    return out;
  });

await suite('util helpers — every page that loads a Util-using script loads js/util.js first, once, with the same ?v= stamp',
  `${base}/tutorial.html`,
  async () => {
    const out = [];
    const ok = okFn(out);
    const USERS = /(?:^|\/)(?:pick|project-view|completion-page|orders-common|app)\.js(?:\?|$)/;
    const stamp = s => (s.match(/\?v=([^"&]+)/) || [])[1] || null;
    const needing = [];
    for (const f of topHtml) {
      const blocks = scriptBlocks(read(f));
      const users = blocks.filter(b => (b.src && USERS.test(b.src)) || (!b.src && /\bUtil\.(?:fmtDate|todayTaipei|formatPrice)\b/.test(b.body)));
      if (!users.length) continue;
      needing.push(f);
      const utilBlocks = blocks.filter(b => b.src && /(?:^|\/)util\.js(?:\?|$)/.test(b.src));
      ok(`${f} — loads js/util.js exactly once`, utilBlocks.length === 1, `${utilBlocks.length} tags`);
      if (utilBlocks.length !== 1) continue;
      const first = Math.min(...users.map(b => b.index));
      ok(`${f} — js/util.js comes before its first Util user`, utilBlocks[0].index < first, `util at ${utilBlocks[0].index}, first user at ${first}`);
      const others = blocks.filter(b => b.src && !/^https?:/.test(b.src) && b !== utilBlocks[0]).map(b => stamp(b.src));
      ok(`${f} — util.js carries the page's ?v= stamp`, !!stamp(utilBlocks[0].src) && others.length > 0 && others.every(s => s === stamp(utilBlocks[0].src)), JSON.stringify({ mine: stamp(utilBlocks[0].src), others: [...new Set(others)] }));
    }
    ok('floor: index, admin, orders, operator, settings, dashboard use Util scripts', ['index.html', 'admin.html', 'orders.html'].every(f => needing.includes(f)) && needing.length >= 4, needing.join(','));
    return out;
  });

// ── 3. behaviour on the real pages ──────────────────────────────────────────
// project-view (index.html?project=): the list's update time, as before
{
  const m = pickFakeWorker({ ownerName: 'Sara', projectId: 'proj-list' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '備註A', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  m.state.selections.set('20260819/b.jpg', { rating: 4, note: '', updated_by: 'picker-0', updated_at: '2026-10-05T16:00:00.000Z' });
  await suite('util helpers — project review list: update time shows Taipei m/d hh:mm (9/27 22:52), across Taipei midnight too',
    `${base}/index.html?project=proj-list`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const rows = await page.$$eval('.pv-list-row', els => els.map(e => ({ name: e.querySelector('.pv-list-name')?.textContent, time: e.querySelector('.pv-list-time')?.textContent })));
      ok('floor: two list rows', rows.length === 2, JSON.stringify(rows));
      const a = rows.find(r => r.name === 'a.jpg'), b = rows.find(r => r.name === 'b.jpg');
      ok('a.jpg: 9/27 22:52', a?.time === '9/27 22:52', JSON.stringify(a));
      ok('b.jpg updated 16:00Z is 10/6 00:00 in Taipei (not 10/5)', /^10\/6 (?:00|24):00$/.test(b?.time || ''), JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// pick.js: the confirmed date on the 完成頁 line, and the viewer's confirmed status
{
  const m = pickFakeWorker(doneOpts({ confirmedAt: '2026-09-21T03:00:00.000Z' }));
  await suite('util helpers — guest page: 已確認完成（2026/9/21） keeps its Taipei date',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#completionPage', { timeout: 5000 });
      const t = await page.textContent('#cpConfirmed');
      ok('the confirmed line is 已確認完成（2026/9/21）', t === '已確認完成（2026/9/21）', t);
      return out;
    },
    { before: m.attach });
}
{
  const w = pickFakeWorker(doneOpts({ confirmedAt: '2026-10-05T16:00:00.000Z' }));
  await suite('util helpers — guest page: a confirmation at 16:00Z reads 2026/10/6 (Taipei), not 10/5',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#completionPage', { timeout: 5000 });
      ok('已確認完成（2026/10/6）', (await page.textContent('#cpConfirmed')) === '已確認完成（2026/10/6）', await page.textContent('#cpConfirmed'));
      return out;
    },
    { before: w.attach });
}

// completion page: the shop price, the one intended output change (NT$5,000, no space)
{
  const w = albumWorld({ n: 12, sub: 0, fake: { title: '婚禮精修', confirmedAt: '2026-09-21T03:00:00.000Z', studio: { name: '光影', booking_url: 'https://studio.example/book', has_logo: false }, shopProducts: shopProductsFake() } });
  await suite('util helpers — 完成頁 shop: prices read NT$5,000 / NT$7,000 / NT$3,000 (no space after NT$)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#cpShop .cp-option-price', { timeout: 8000 });
      const prices = await page.$$eval('#cpShop .cp-option-price', els => els.map(e => e.textContent));
      ok('floor: the shop shows prices', prices.length >= 3, JSON.stringify(prices));
      ok('every price is NT$ then digits with thousands separators, no space', prices.every(p => /^NT\$\d{1,3}(,\d{3})*$/.test(p)), JSON.stringify(prices));
      ok('the album options are NT$5,000 and NT$7,000 (positive: the separator is there)', prices.includes('NT$5,000') && prices.includes('NT$7,000'), JSON.stringify(prices));
      ok('and the old spaced form appears nowhere on the page', !(await page.evaluate(() => /NT\$\s/.test(document.getElementById('completionPage').textContent))));
      return out;
    },
    { before: w.before, initScript: `localStorage.setItem('pick_key:TOK', 'ZOE-KEY');`, contextOptions: ALB_DESK });
}

// orders.html: money
{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊' } });
  o.st.addOrder({ id: 'o-1', project_id: 'proj-1', status: 'confirmed', items: [{ name: '相本書', unit_price: 1500, qty: 2 }] });
  o.st.addOrder({ id: 'o-2', project_id: 'proj-1', status: 'confirmed', items: [{ name: '小物', unit_price: 12, qty: 1 }] });
  await suite('util helpers — orders.html: totals read NT$3,000 and NT$12 through window.Orders.money (no space)',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('.ord-row')].map(e => ({ id: e.dataset.orderId, total: e.querySelector('.ord-total')?.textContent, owed: e.querySelector('.ord-owed')?.textContent })),
        money: [window.Orders.money(1500), window.Orders.money(0), window.Orders.money(NaN), window.Orders.money(1234567.4), window.Orders.money('x')],
        same: window.Orders.money(98765) === window.Util.formatPrice(98765),
      }));
      ok('floor: two rows', r.rows.length === 2, JSON.stringify(r.rows));
      ok('o-1: total and owed NT$3,000', r.rows.find(x => x.id === 'o-1')?.total === 'NT$3,000' && r.rows.find(x => x.id === 'o-1')?.owed === 'NT$3,000', JSON.stringify(r.rows));
      ok('o-2: NT$12', r.rows.find(x => x.id === 'o-2')?.total === 'NT$12', JSON.stringify(r.rows));
      ok('window.Orders.money keeps its behaviour (NT$1,500, NT$0, NaN → NT$0, rounds, garbage → NT$0) and equals Util.formatPrice', JSON.stringify(r.money) === JSON.stringify(['NT$1,500', 'NT$0', 'NT$0', 'NT$1,234,567', 'NT$0']) && r.same, JSON.stringify(r.money));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// admin.html: the one-line summary date (M/D), the time column (m/d hh:mm), the create form's default date (todayTaipei)
{
  const m = pickFakeWorker({ projectId: 'proj-sec', title: '收合專案', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET, phase: 'retouching',
    deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] });
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: '2026-09-27T14:52:00.000Z' });
  m.state.submissions.push({ id: 's2', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: 'not-a-date' });
  await suite('util helpers — admin: delivery summary 已交件 9/20, submission time 9/27 22:52, an unparseable time falls back to the raw text',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await secWait(page);
      const info = await secInfo(page);
      ok('the delivery one-liner starts with 已交件 9/20 (fmtDay)', /^已交件 9\/20 /.test(info.delivery?.sum || ''), JSON.stringify(info.delivery));
      await page.waitForSelector('#pd-submissions .pd-submission', { state: 'attached', timeout: 5000 });
      const subs = await page.$$eval('.pd-submission', els => els.map(e => e.textContent));
      ok('floor: both submissions are listed', subs.length === 2, JSON.stringify(subs));
      ok('the submission time is 9/27 22:52 (fmtTime)', subs.some(t => t.includes('9/27 22:52') && !t.includes('2026-09-27T')), JSON.stringify(subs));
      ok('a submission whose time cannot be parsed shows its raw text (admin fmtTime fallback)', subs.some(t => t.startsWith('not-a-date') || t.includes('not-a-date')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}
{
  const m = pickFakeWorker({ ownerName: 'Leo' });
  await suite('util helpers — admin: the create form defaults 拍攝日期 to today in Taipei (16:00Z is already the next day)',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#proj-date', { state: 'attached', timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('proj-date').value !== '', null, { timeout: 5000 });
      const v = await page.inputValue('#proj-date');
      ok('the date is 2026-10-06 when the clock is 2026-10-05T16:00:00Z', v === '2026-10-06', v);
      return out;
    },
    { before: m.attach, initScript: () => {
      sessionStorage.setItem('studio_token', 'adm');
      const R = Date, t = new R('2026-10-05T16:00:00.000Z').getTime();
      window.Date = class extends R { constructor(...a) { a.length ? super(...a) : super(t); } static now() { return t; } };
    } });
}

// operator.html keeps its negative form on top of window.Orders.money (suite 20 asserts the cells; here the rule itself)
{
  await suite('util helpers — window.Orders.money stays NT$-style underneath operator.html’s −NT$ form',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForFunction(() => window.Orders && window.Util, null, { timeout: 5000 });
      const r = await page.evaluate(() => { const signed = n => (n < 0 ? `−${window.Orders.money(-n)}` : window.Orders.money(n)); return [signed(-100), signed(100), signed(0), signed(-1234)]; });
      ok('−NT$100, NT$100, NT$0, −NT$1,234', JSON.stringify(r) === JSON.stringify(['−NT$100', 'NT$100', 'NT$0', '−NT$1,234']), JSON.stringify(r));
      return out;
    },
    { before: dashSettingsMock().attach, initScript: SEED_TOKEN });
}
}
