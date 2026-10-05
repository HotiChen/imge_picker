// Browser suites: the one shared HTML-escape helper (js/util.js, window.escHtml).
// Six divergent copies used to live in orders-common / side-nav / client-auth-check /
// admin / dashboard / upload, and three of them did not escape the single quote.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { base, suite } from '../lib/harness.mjs';
import { ROOT } from '../lib/env.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ordersFake } from '../lib/orders-fake.mjs';
import { clientMock } from '../lib/auth-mocks.mjs';

export default async function register() {
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

// Every character that can open a tag or break out of an attribute, plus an
// onerror payload. A page that renders this inertly is escaping text AND attribute contexts.
const HOSTILE = `a"b'c<img src=x onerror="window.__xss=1">&amp;\``;
const PROBE = () => ({
  fired: !!window.__xss,
  injected: document.querySelectorAll('img[src="x"]').length,
});

const topHtml = readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
// every <script> block of a page: { src, body, index }
const scriptBlocks = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({
  src: (m[1].match(/\bsrc="([^"]+)"/) || [])[1] || null, body: m[2], index: m.index,
}));
const USERS = /(?:^|\/)(?:side-nav|orders-common|client-auth-check)\.js(?:\?|$)/;

// ── 1. the helper itself ────────────────────────────────────────────────────
await suite('escHtml — the shared helper escapes & < > " \' ` and treats null / numbers sanely',
  `${base}/tutorial.html`,
  async page => {
    const out = [];
    const ok = okFn(out);
    await page.addScriptTag({ url: `${base}/js/util.js` });
    const r = await page.evaluate(() => ({
      hasFn: typeof window.escHtml === 'function',
      same: !!window.Util && window.Util.escHtml === window.escHtml,
      keys: window.Util ? Object.keys(window.Util) : null,
      amp: window.escHtml('&'), lt: window.escHtml('<'), gt: window.escHtml('>'),
      dq: window.escHtml('"'), sq: window.escHtml("'"), bt: window.escHtml('`'),
      all: window.escHtml(`<a href="x" title='y'>&</a>`),
      once: window.escHtml('&amp;'),
      nul: window.escHtml(null), und: window.escHtml(undefined),
      zero: window.escHtml(0), num: window.escHtml(42), neg: window.escHtml(-1.5),
      f: window.escHtml(false), empty: window.escHtml(''),
      plain: window.escHtml('海邊系列 IMG_1.jpg'),
      arr: window.escHtml(['<b>']),
    }));
    ok('window.escHtml is a function', r.hasFn);
    ok('window.Util = { escHtml } exposes the same function and nothing else', r.same && JSON.stringify(r.keys) === '["escHtml"]', JSON.stringify([r.same, r.keys]));
    ok('& → &amp;', r.amp === '&amp;', r.amp);
    ok('< → &lt;', r.lt === '&lt;', r.lt);
    ok('> → &gt;', r.gt === '&gt;', r.gt);
    ok('" → &quot;', r.dq === '&quot;', r.dq);
    ok("' → &#39;", r.sq === '&#39;', r.sq);
    ok('` → &#96;', r.bt === '&#96;', r.bt);
    ok('a whole tag with both quote kinds', r.all === '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;', r.all);
    ok('& is escaped first, exactly once per character (&amp; → &amp;amp;)', r.once === '&amp;amp;', r.once);
    ok('null and undefined become the empty string', r.nul === '' && r.und === '', JSON.stringify([r.nul, r.und]));
    ok('0 stays "0" (a count or rating is not blank)', r.zero === '0', r.zero);
    ok('numbers are String()-ed', r.num === '42' && r.neg === '-1.5', JSON.stringify([r.num, r.neg]));
    ok('false is "false", not blank (only null/undefined are empty)', r.f === 'false', r.f);
    ok('the empty string and a normal name come back untouched', r.empty === '' && r.plain === '海邊系列 IMG_1.jpg', JSON.stringify([r.empty, r.plain]));
    ok('a non-string value goes through String() and is then escaped', r.arr === '&lt;b&gt;', r.arr);
    return out;
  });

// ── 2. every page that uses the helper loads it first ───────────────────────
await suite('escHtml — every page that loads side-nav / orders-common / client-auth-check (or calls escHtml inline) loads js/util.js first, with the same ?v= stamp',
  `${base}/tutorial.html`,
  async () => {
    const out = [];
    const ok = okFn(out);
    const needing = [];
    for (const f of topHtml) {
      const html = read(f);
      const blocks = scriptBlocks(html);
      const users = blocks.filter(b => (b.src && USERS.test(b.src)) || (!b.src && /\bescHtml\(/.test(b.body)));
      if (!users.length) continue;
      needing.push(f);
      const utilBlocks = blocks.filter(b => b.src && /(?:^|\/)util\.js(?:\?|$)/.test(b.src));
      ok(`${f} — loads js/util.js exactly once`, utilBlocks.length === 1, `${utilBlocks.length} tags`);
      if (utilBlocks.length !== 1) continue;
      const first = Math.min(...users.map(b => b.index));
      ok(`${f} — js/util.js comes BEFORE its first user (${users.length} script blocks use it)`, utilBlocks[0].index < first,
        `util at ${utilBlocks[0].index}, first user at ${first}`);
      // a new tag must carry the same ?v= stamp as the page's other local scripts
      const stamp = s => (s.match(/\?v=([^"&]+)/) || [])[1] || null;
      const others = blocks.filter(b => b.src && !/^https?:/.test(b.src) && b !== utilBlocks[0]).map(b => stamp(b.src));
      const mine = stamp(utilBlocks[0].src);
      ok(`${f} — util.js carries the page's ?v= stamp`, !!mine && others.length > 0 && others.every(s => s === mine),
        JSON.stringify({ mine, others: [...new Set(others)] }));
    }
    ok('floor: at least 7 pages use the helper (admin, dashboard, index, operator, orders, settings, upload)', needing.length >= 7, needing.join(','));
    ok('the pages found include the known six users', ['admin.html', 'dashboard.html', 'upload.html', 'orders.html', 'settings.html', 'index.html', 'operator.html'].every(f => needing.includes(f)), needing.join(','));
    ok('floor: scanned every top-level page', topHtml.length >= 9, String(topHtml.length));
    return out;
  });

// ── 3. no local copy is left ────────────────────────────────────────────────
await suite('escHtml — no local escHtml / esc definition is left in the pages or scripts (one function, in js/util.js)',
  `${base}/tutorial.html`,
  async () => {
    const out = [];
    const ok = okFn(out);
    const jsFiles = readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
    const files = [...topHtml, ...jsFiles];
    // a definition, in any style: function escHtml(, const escHtml =, esc: s => …
    const DEF = /(?:function\s+(?:escHtml|esc)\s*\(|\b(?:const|let|var)\s+(?:escHtml|esc)\s*=(?!\s*(?:window\.)?escHtml\s*;)|\.escHtml\s*=(?!\s*escHtml))/;
    const offenders = [];
    let read_ = 0;
    for (const f of files) {
      if (f === 'js/util.js') continue;
      read_++;
      const lines = read(f).split('\n');
      lines.forEach((l, i) => { if (DEF.test(l)) offenders.push(`${f}:${i + 1}`); });
    }
    ok('floor: scanned the pages and every script in js/', read_ >= 30, String(read_));
    ok('no page or script defines its own escHtml / esc', offenders.length === 0, offenders.join(', '));
    // the six files named in the audit, read explicitly (a scan that skipped one would not notice)
    const six = ['js/orders-common.js', 'js/side-nav.js', 'js/client-auth-check.js', 'admin.html', 'dashboard.html', 'upload.html'];
    ok('floor: the six audited files exist and were read', six.every(f => read(f).length > 500));
    const util = read('js/util.js');
    ok('js/util.js defines exactly one escHtml', (util.match(/function\s+escHtml\s*\(/g) || []).length === 1);
    ok('js/util.js is a plain script: no import / export / module syntax', !/^\s*(?:import|export)\b/m.test(util));
    // positive control for the regex itself: it must flag a copy
    ok('control: the definition regex flags a re-introduced copy',
      DEF.test('function escHtml(s) { return s; }') && DEF.test('  const esc = s => s;') && !DEF.test('const esc = window.escHtml;'));
    return out;
  });

// ── 4. behaviour: hostile names are inert on every kind of page ─────────────
{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': HOSTILE, 'proj-2': '海邊系列' } });
  o.st.addOrder({ id: `o"'<x`, project_id: 'proj-1', status: 'confirmed', items: [{ name: HOSTILE, option_label: `8"x'8`, unit_price: 100, qty: 1 }] });
  o.st.addOrder({ id: 'o-normal', project_id: 'proj-2', status: 'confirmed', items: [{ name: '相本書', unit_price: 200, qty: 1 }] });
  await suite('escHtml — orders.html: a project title / order id / item name with " \' <img onerror> renders inert, a normal one still renders',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      await page.waitForTimeout(300);
      const p = await page.evaluate(PROBE);
      ok('no <img> was injected', p.injected === 0, String(p.injected));
      ok('onerror did not run', p.fired === false, String(p.fired));
      const rows = await page.$$eval('.ord-row', els => els.map(e => ({
        id: e.dataset.orderId, title: e.querySelector('.ord-proj').textContent,
        attrs: [...e.attributes].map(a => a.name).sort().join(','),
        lines: e.querySelector('.ord-lines').textContent,
      })));
      ok('both rows rendered', rows.length === 2, JSON.stringify(rows.map(r => r.id)));
      const h = rows.find(r => r.id === `o"'<x`);
      ok('the hostile title is shown literally, as text', h?.title === HOSTILE, JSON.stringify(h?.title));
      ok('the hostile id survives in data-order-id and added no attribute', !!h && h.attrs === 'class,data-order-id,data-status', JSON.stringify(h?.attrs));
      ok('the hostile item name is shown literally', !!h && h.lines.includes(HOSTILE), JSON.stringify(h?.lines));
      const n = rows.find(r => r.id === 'o-normal');
      ok('positive: a normal title and line still render', n?.title === '海邊系列' && n.lines.includes('相本書'), JSON.stringify(n));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({
    stats: {
      by_phase: { picking: 1, submitted: 0, retouching: 0 }, delivered: 0, archived: 0,
      per_month: [{ month: `2026-0"'<img src=x onerror="window.__xss=1">`, created: 1, delivered: 1 }, { month: '2026-09', created: 2, delivered: 1 }],
      todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0 },
    },
    projects: [{ id: 'p-h', title: HOSTILE, phase: 'picking' }, { id: 'p-n', title: '婚紗', phase: 'picking' }],
  });
  await suite('escHtml — dashboard.html: a hostile project title and chart month (text and title="" attribute) render inert, a normal one still renders',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('.recent-row', { timeout: 5000 });
      await page.waitForSelector('#stat-chart .chart-col', { timeout: 5000 });
      await page.waitForTimeout(300);
      const p = await page.evaluate(PROBE);
      ok('no <img> was injected', p.injected === 0, String(p.injected));
      ok('onerror did not run', p.fired === false, String(p.fired));
      const r = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('.recent-row a')].map(a => a.textContent),
        cols: [...document.querySelectorAll('#stat-chart .chart-col')].map(c => ({
          attrs: [...c.attributes].map(a => a.name).sort().join(','), title: c.getAttribute('title'),
        })),
        labels: [...document.querySelectorAll('#stat-chart-labels span')].map(s => s.textContent),
      }));
      ok('the hostile project title is shown literally', r.titles[0] === HOSTILE, JSON.stringify(r.titles));
      ok('positive: the normal project title renders', r.titles[1] === '婚紗', JSON.stringify(r.titles));
      ok('the hostile month stayed inside title="" and added no attribute', r.cols.length === 2 && r.cols.every(c => c.attrs === 'class,title') &&
        r.cols[0].title.startsWith(`2026-0"'<img src=x onerror="window.__xss=1">`), JSON.stringify(r.cols));
      ok('the month label is text', r.labels.length === 2 && r.labels[1] === '09' && r.labels[0].includes('<img'), JSON.stringify(r.labels));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('escHtml — side-nav: an item label / href / key with " \' <img onerror> is inert, the real items still render',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#sideNav .side-nav-item', { timeout: 5000 });
      const r = await page.evaluate(payload => {
        const box = document.createElement('div');
        document.body.appendChild(box);
        SideNav.ITEMS.push({ key: payload, label: payload, href: payload });
        SideNav.render(box, 'dashboard', () => {});
        const items = [...box.querySelectorAll('a.side-nav-item')];
        const last = items[items.length - 1];
        return {
          n: items.length, real: SideNav.ITEMS.length - 1,
          attrs: [...last.attributes].map(a => a.name).sort().join(','),
          text: last.textContent, href: last.getAttribute('href'), nav: last.dataset.nav,
          firstText: items[0].textContent,
          fired: !!window.__xss, injected: document.querySelectorAll('img[src="x"]').length,
        };
      }, HOSTILE);
      ok('no <img> was injected', r.injected === 0, String(r.injected));
      ok('onerror did not run', r.fired === false, String(r.fired));
      ok('the hostile item is the last link, and every item rendered', r.n === r.real + 1, JSON.stringify([r.n, r.real]));
      ok('it added no attribute beyond class, href, data-nav', r.attrs === 'class,data-nav,href', r.attrs);
      ok('label, href and key all come back literally', r.text === HOSTILE && r.href === HOSTILE && r.nav === HOSTILE, JSON.stringify([r.text, r.href, r.nav]));
      ok('positive: a normal item still renders its label', r.firstText === '儀表板', r.firstText);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

await suite('escHtml — upload.html: a hostile folder name / file name / path / warning is inert, a normal name still renders',
  `${base}/upload.html`,
  async page => {
    const out = [];
    const ok = okFn(out);
    const r = await page.evaluate(payload => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      const mk = (id, path, name, warn) => ({ id, path, file: { name, size: 10 }, state: 'pending', progress: 0, thumbWarning: warn || null });
      const hostile = mk('h1', `${payload}/x.jpg`, payload, payload);
      const normal = mk('n1', '合照/b.jpg', 'b.jpg', null);
      renderDirNode({ children: { [payload]: { name: payload, items: [hostile], children: {} }, '合照': { name: '合照', items: [normal], children: {} } }, items: [] }, box);
      const name = box.querySelector(`[data-id="h1"] .qi-name`);
      const status = box.querySelector(`[data-id="h1"] .qi-status`);
      return {
        fired: !!window.__xss, injected: document.querySelectorAll('img[src="x"]').length,
        dirNames: [...box.querySelectorAll('.tree-dir-name')].map(e => e.textContent),
        nameAttrs: [...name.attributes].map(a => a.name).sort().join(','),
        nameTitle: name.getAttribute('title'), nameText: name.textContent,
        statusAttrs: [...status.attributes].map(a => a.name).sort().join(','), statusTitle: status.getAttribute('title'),
        normalName: box.querySelector('[data-id="n1"] .qi-name').textContent,
      };
    }, HOSTILE);
    ok('no <img> was injected', r.injected === 0, String(r.injected));
    ok('onerror did not run', r.fired === false, String(r.fired));
    ok('the hostile folder name is shown as text', r.dirNames.includes(`${HOSTILE}/`), JSON.stringify(r.dirNames));
    ok('the file name is shown as text, its path stayed inside title=""', r.nameText === HOSTILE && r.nameTitle === `${HOSTILE}/x.jpg` && r.nameAttrs === 'class,title', JSON.stringify([r.nameText, r.nameTitle, r.nameAttrs]));
    ok('the thumbnail warning stayed inside title=""', r.statusTitle === HOSTILE && r.statusAttrs === 'class,title', JSON.stringify([r.statusTitle, r.statusAttrs]));
    ok('positive: a normal folder and file still render', r.dirNames.includes('合照/') && r.normalName === 'b.jpg', JSON.stringify([r.dirNames, r.normalName]));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x') });

{
  const NAME = `Ann "'<img src=x onerror="window.__xss=1">`;
  const m = clientMock();
  await suite('escHtml — client bar (client-auth-check.js): a hostile client name is inert and shown literally',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = okFn(out);
      await page.waitForSelector('#client-bar', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        fired: !!window.__xss, injected: document.querySelectorAll('img[src="x"]').length,
        name: document.querySelector('#client-bar span').textContent,
      }));
      ok('no <img> was injected', r.injected === 0, String(r.injected));
      ok('onerror did not run', r.fired === false, String(r.fired));
      ok('the name is shown literally', r.name === NAME, JSON.stringify(r.name));
      return out;
    },
    {
      before: m.attach,
      // self-contained: an init script is serialised into the page
      initScript: () => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        sessionStorage.setItem('client_session', JSON.stringify({
          token: 'sess',
          user: { id: 7, email: 'c@example.com', name: 'Ann "\'<img src=x onerror="window.__xss=1">', folder_path: '2026/去年' },
          permissions: { can_book: true, can_upload: true },
        }));
      },
    });
}
}
