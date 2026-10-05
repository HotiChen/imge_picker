// Browser suites: cream theme on photographer pages, dark theme kept on client pages.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { ROOT } from '../lib/env.mjs';
import { ADMIN, ADMIN_PLAIN, SHOOT_CLIENTS, adminMock, shareMock } from '../lib/auth-mocks.mjs';
import { ADMIN_BUCKET, ADM_REVS, admDelivered } from '../lib/delivery-helpers.mjs';
import { ADMIN_PICKS, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, PROD_PRINT, SEC_NAMES, clone, ordersFake, secInfo, secOpen, secWait } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// 亮色主題 — the photographer's pages (admin.html, upload.html) share home.html's
// cream/white/ink theme; the client's pages stay dark.
//
// Asserted on computed style, in a real engine. Three kinds of check, because
// each alone has a false-pass shape:
//   1. exact tokens (so a palette drift is caught even when it still clears 4.5:1);
//   2. a contrast scan over EVERY visible text element, with a floor on how many
//      it must have seen (an absent element must not read as a pass);
//   3. a hunt for leftover dark boxes (a hard-coded #1d1a14 on one panel).
// The client pages are asserted positively dark, so "the global :root got
// changed" cannot pass either.
// ═══════════════════════════════════════════════════════════════════════════

const CREAM = 'rgb(255, 248, 238)';
const WHITE = 'rgb(255, 255, 255)';
const CLIENT_DARK = 'rgb(21, 18, 13)';   // index.html / client-login.html (css/styles.css --bg #15120d)
const VIEW_DARK = 'rgb(13, 13, 26)';     // book_editor/view.html (#0d0d1a)

// home.html's :root is the single source of the photographer theme.
const HOME_TOKENS = (() => {
  const css = readFileSync(join(ROOT, 'home.html'), 'utf8').match(/:root\s*\{([^}]*)\}/)[1];
  const o = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) o[m[1]] = m[2].trim().toLowerCase();
  return o;
})();
const SHARED_TOKENS = ['--bg', '--surface', '--accent', '--mint', '--peach', '--ink-90', '--ink-70', '--ink-55', '--rule', '--danger'];

// In-page. Walks `root`, computes the contrast of every visible piece of text
// against the real backdrop (alpha layers and ancestor opacity composited),
// finds dark-backed boxes, and resolves `named` selectors one by one.
const THEME_PROBE = ({ root = 'body', named = [], inactive = [], allowDark = [], logotype = ['header .brand', '.login-card .brand', '#auth-overlay [style*="letter-spacing:0.15em"]'] } = {}) => {
  const parse = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const shown = el => {
    if (!el.getClientRects().length) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const backdrop = el => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const opacityOf = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const label = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].slice(0, 2).map(c => '.' + c).join('')}`;
  const measure = (el, colorStr, text) => {
    const bg = backdrop(el);
    const fg0 = parse(colorStr) || { r: 0, g: 0, b: 0, a: 1 };
    const fg = over({ ...fg0, a: fg0.a * opacityOf(el) }, bg);
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const letters = /[\p{L}\p{N}]/u.test(text);
    return { sel: label(el), text: text.trim().slice(0, 24), ratio: ratio(fg, bg), need: letters ? (large ? 3 : 4.5) : 3, letters,
      emoji: !letters && /\p{Extended_Pictographic}/u.test(text), fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` };
  };
  const rootEl = document.querySelector(root);
  const items = [];
  let skippedDisabled = 0, skippedInactive = 0;
  const logotypes = [];
  for (const el of rootEl.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'OPTGROUP', 'HEAD', 'META', 'LINK', 'SVG', 'PATH', 'NOSCRIPT'].includes(el.tagName.toUpperCase())) continue;
    if (!shown(el)) continue;
    const tag = el.tagName;
    const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (isField && ['checkbox', 'radio', 'file', 'hidden', 'range'].includes(el.type)) continue;
    let texts = [];
    if (isField) {
      const v = tag === 'SELECT' ? (el.selectedOptions[0]?.textContent || '') : el.value;
      if (v.trim()) texts.push({ t: v, color: getComputedStyle(el).color, el });
      if (el.placeholder && !el.value) texts.push({ t: el.placeholder, color: getComputedStyle(el, '::placeholder').color, el, ph: true });
    } else {
      const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent).join(' ');
      if (own.trim()) texts.push({ t: own, color: getComputedStyle(el).color, el });
    }
    for (const x of texts) {
      if (x.el.disabled || x.el.closest('[disabled]')) { skippedDisabled++; continue; }
      const m = measure(x.el, x.color, x.t);
      if (x.ph) m.sel += '::placeholder';
      if (m.emoji) continue;
      // the STUDIO wordmark is a logotype (WCAG 1.4.3 exempts it) and is the same amber
      // on every photographer page; it is pinned to the exact accent below instead
      if (logotype.some(s => x.el.matches(s))) { logotypes.push(m.fg); continue; }
      if (inactive.some(s => x.el.closest(s))) { skippedInactive++; m.inactive = true; m.need = 3; }
      items.push(m);
    }
  }
  const dark = [];
  for (const el of [document.documentElement, ...rootEl.querySelectorAll('*')]) {
    if (el !== document.documentElement && !shown(el)) continue;
    if (allowDark.some(s => el.closest(s))) continue;
    const c = parse(getComputedStyle(el).backgroundColor);
    if (c && c.a >= 0.5 && lum(c) < 0.18) dark.push(`${label(el)} ${getComputedStyle(el).backgroundColor}`);
  }
  const namedOut = named.map(sel => {
    const el = [...document.querySelectorAll(sel)].find(shown);
    if (!el) return { sel, absent: true };
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') || el.value || el.placeholder || el.textContent;
    return { sel, ...measure(el, getComputedStyle(el).color, own || 'x') };
  });
  return {
    n: items.length, skippedDisabled, skippedInactive, logotypes,
    fails: items.filter(i => i.ratio < i.need).map(i => `${i.sel} "${i.text}" ${i.ratio.toFixed(2)}<${i.need} fg=${i.fg} bg=${i.bg}${i.inactive ? ' (inactive)' : ''}`),
    min: items.length ? Math.min(...items.filter(i => i.letters && !i.inactive).map(i => i.ratio)) : 0,
    dark, named: namedOut,
  };
};

// The bright-theme checks every photographer page shares. `named` are the
// representative elements that MUST exist and be readable; `minItems` is the
// floor on how many text elements the scan has to have seen.
async function brightChecks(page, ok, label, { named = [], minItems = 20, inactive = [], allowDark = [], root = 'body' } = {}) {
  const r = await page.evaluate(THEME_PROBE, { root, named, inactive, allowDark });
  ok(`${label}: the scan really saw the page (>= ${minItems} text elements, saw ${r.n})`, r.n >= minItems, String(r.n));
  ok(`${label}: every visible text clears WCAG AA (min ${r.min.toFixed(2)})`, r.fails.length === 0, r.fails.slice(0, 6).join(' | '));
  ok(`${label}: no leftover dark box`, r.dark.length === 0, r.dark.slice(0, 6).join(' | '));
  ok(`${label}: the only sub-4.5 text is the amber STUDIO wordmark, and it is exactly the accent (${r.logotypes.length} seen)`,
    r.logotypes.every(c => c === 'rgb(245, 161, 59)'), r.logotypes.join(' '));
  for (const n of r.named) {
    ok(`${label}: ${n.sel} is shown and readable (${n.absent ? 'ABSENT' : n.ratio.toFixed(2)})`, !n.absent && n.ratio >= n.need,
      n.absent ? 'element missing or hidden' : `${n.ratio.toFixed(2)}<${n.need} fg=${n.fg} bg=${n.bg}`);
  }
  return r;
}

// The exact tokens: a photographer page's :root agrees with home.html's.
async function tokenChecks(page, ok, label, extra = {}) {
  const got = await page.evaluate(names => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim().toLowerCase()])); }, SHARED_TOKENS);
  for (const n of SHARED_TOKENS) ok(`${label}: ${n} is home.html's ${HOME_TOKENS[n]}`, got[n] === HOME_TOKENS[n], `${got[n]} vs ${HOME_TOKENS[n]}`);
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(`${label}: body is the approved cream`, bodyBg === CREAM, bodyBg);
  const htmlBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  ok(`${label}: and the root element too (no dark flash behind overscroll)`, htmlBg === CREAM || htmlBg === 'rgba(0, 0, 0, 0)', htmlBg);
  void extra;
}

const THEME_SHOTS = process.env.SHOTS || '';
const shot = async (page, name) => { if (THEME_SHOTS) await page.screenshot({ path: join(THEME_SHOTS, `${name}.png`), fullPage: true }); };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

// ── admin.html: project list + detail ──────────────────────────────────────
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = pickFakeWorker({ projectId: 'proj-1', title: '亮色專案', phase: 'retouching', ownerName: 'Grace',
    allowProofDownload: true, folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/IMG_1.jpg'], count: 1,
      pick_limit: 4, extra_price: 200, created_at: '2026-01-01T00:00:00Z', marks: { '20260819/IMG_1.jpg': [{ x: 0.1, y: 0.2, note: 'a' }] } },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: 'a@b.com', photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'], count: 2,
      pick_limit: 4, extra_price: 200, notified: 1, created_at: '2026-01-02T00:00:00Z', marks: { '20260819/IMG_1.jpg': [{ x: 0.5, y: 0.5, note: 'b' }] } });
  m.state.project.modified_after_submit = 1;
  const o = ordersFake({ products: [clone(PROD_ALBUM), clone(PROD_PRINT)], platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)],
    extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-a', order_extra: 6, matches: false } });
  o.st.addOrder({ id: 'ord-a', project_id: 'proj-1', status: 'confirmed', discount: 300, note: '週五取件',
    items: [{ name: '相本書', option_label: '8×8 吋', kind: 'album', unit_price: 1500, unit_cost: 600, qty: 2, photo_keys: ['20260819/IMG_1.jpg'] },
            { name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 6 }] });
  o.st.addOrder({ id: 'ord-b', project_id: 'proj-1', status: 'fulfilled', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 500, qty: 1 }] });
  o.st.addOrder({ id: 'ord-c', project_id: 'proj-1', status: 'cancelled', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10 }] });
  await suite(`亮色主題 — admin 選片專案：列表與詳情（交件區、訂單、標示變更、目前選取）[${tag}]`,
    `${base}/admin.html#project=proj-1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-orders .ord-card', { timeout: 5000 });
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      // (the project list is hidden while a detail is open — its badges and create form are scanned by the
      // 建立表單與專案列表 suite below, in the list view)
      // (every section is open: ADMIN stores that preference; 目前選取 used to be a <details> opened here)
      ok('the fixture reached the places under test: pins line, 加挑 warning, a cancelled order, selections table',
        await page.evaluate(() => /標示變更 1 張/.test(document.getElementById('pd-submissions').textContent) &&
          !!document.getElementById('pd-extra-warn') && !!document.querySelector('.ord-card.cancelled') &&
          document.querySelectorAll('#pd-selections-details tbody tr').length === 2));
      await tokenChecks(page, ok, 'admin');
      await brightChecks(page, ok, 'admin 詳情', { minItems: 80,
        named: ['header .subtitle', '.side-nav-item', '.side-nav-item.active', '#pd-back-btn', '.pd-head .badge-approved', '.pd-head .badge-pending',
          '#pd-submissions .badge-pending', '.pd-owner', '.pd-diff', '#project-detail-panel a.pd-link', '#pd-start-retouch-btn', '#pd-reset-seat-btn',
          '#pd-download-btn', '#pd-archive-btn', '#pd-final-pick-btn', 'th', '.field', '.panel-note, .pd-note', '.ord-warn',
          '.ord-card .ord-status', '.ord-owed', '.ord-actions .btn', '[data-copy-link]',
          '.pd-switch'],
        }).then(r => {
          ok('the cancelled order stays legible (positive: it was scanned, and no failure names it)',
            r.fails.every(f => !/ord-card/.test(f)) && r.n > 0);
          ok('the STUDIO ADMIN wordmark was found (so the logotype exemption is not hiding an absent element)', r.logotypes.length === 1, String(r.logotypes.length));
        });
      await shot(page, `admin-detail-${tag}`);
      // the 精修資料夾 chooser is a modal over the page
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
      await page.waitForSelector('#folder-picker [data-browse]', { timeout: 3000 });
      await brightChecks(page, ok, 'admin 資料夾選擇 modal', { minItems: 80, allowDark: ['#folder-picker'],
        named: ['#folder-picker .picker-head', '#folder-picker .folder-pick-row', '#folder-picker [data-confirm-folders]', '#folder-picker .btn-text, #folder-picker .btn-ghost'] });
      const box = await page.$eval('#folder-picker .picker-box', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
      ok('the modal box itself is a light card', box.bg === WHITE, JSON.stringify(box));
      await shot(page, `admin-folder-picker-${tag}`);
      await page.evaluate(() => { document.getElementById('folder-picker').style.display = 'none'; });
      // the order editor
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-order-editor', { timeout: 3000 });
      await brightChecks(page, ok, 'admin 訂單編輯器', { minItems: 80, named: ['#pd-order-editor .field', '#pd-order-editor label', '#pd-order-editor .btn-accent'] });
      await shot(page, `admin-order-editor-${tag}`);
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN, contextOptions: ctx });
}

// the project list view, no detail open (admin#projects), with every list badge
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = pickFakeWorker({ title: '亮色專案列表', phase: 'submitted', ownerName: 'Grace', deliveredAt: '2026-09-20T00:00:00Z',
    finalFolders: ['shoot/精修/'], archivedAt: '2026-09-21T00:00:00Z', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  m.state.project.modified_after_submit = 1;
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/p0.jpg'], count: 1,
    pick_limit: null, extra_price: null, created_at: '2026-01-01T00:00:00Z' });
  await suite(`亮色主題 — admin 選片專案：建立表單與專案列表（所有徽章）[${tag}]`,
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // an archived project is hidden until 顯示已封存 is ticked
      await page.check('#proj-show-archived-toggle');
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      await page.fill('#proj-title', '王小明 & 陳小美 婚紗');
      await page.evaluate(() => { document.getElementById('proj-create-result').style.display = 'block'; document.getElementById('proj-link-output').value = 'https://imhoti.tw/studio/index.html?t=abc'; });
      await page.evaluate(() => { document.getElementById('proj-create-err').textContent = '請輸入專案名稱'; });
      ok('the list row carries every badge (delivered, archived, modified, unnotified)',
        await page.evaluate(() => { const t = document.querySelector('[data-project-row]').textContent; return /已交件/.test(t) && /已封存/.test(t) && /已修改/.test(t) && /未寄信/.test(t); }));
      await tokenChecks(page, ok, 'admin 列表');
      await brightChecks(page, ok, 'admin 列表', { minItems: 25,
        named: ['#proj-title', '#proj-create-btn', '#proj-create-err', '.pick-admin-field label', '#proj-link-output', '[data-project-row] .badge-approved',
          '[data-project-row] .badge-pending', '[data-project-row] .pd-owner', '[data-project-row] [data-open-project]', '.side-nav-logout', '.btn-logout'] });
      const row = await page.$eval('[data-project-row]', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor }; });
      ok('a project row is a white card on the cream page', row.bg === WHITE, JSON.stringify(row));
      await shot(page, `admin-projects-${tag}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

// ── admin.html: client confirmation (docs/delivery.md) in the cream theme ──
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  for (const [state, o] of [
    ['open requests', admDelivered({ revisions: ADM_REVS() })],
    ['confirmed by the photographer', admDelivered({ confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'photographer', revisions: ADM_REVS().map(r => ({ ...r, resolved_at: '2026-09-23T03:30:00.000Z' })) })],
  ]) {
    const m = pickFakeWorker(o);
    await suite(`亮色主題 — admin 交件的確認狀態與要求修改清單（${state}）[${tag}]`,
      `${base}/admin.html#project=proj-cf`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#pd-revisions .pd-rev', { timeout: 5000 });
        await page.waitForSelector('.pd-head [data-confirm-badge]', { timeout: 5000 });
        const open = state === 'open requests';
        ok('the fixture reached the places under test (list of 3, one resolved, status line, a badge in the head)',
          await page.evaluate(() => document.querySelectorAll('#pd-revisions .pd-rev').length === 3 && !!document.getElementById('pd-confirm-status') && !!document.querySelector('.pd-head [data-confirm-badge]')));
        ok(open ? '標記完成 and the explaining line are on screen' : 'the status line is the confirmed (green) one',
          open ? !!(await page.$('#pd-mark-done-btn')) && !!(await page.$('#pd-revision-hint')) : await page.$eval('#pd-confirm-status', e => e.classList.contains('done')));
        await tokenChecks(page, ok, 'admin');
        await brightChecks(page, ok, `admin 確認區 (${state})`, { minItems: 60,
          named: ['#pd-confirm-status', '.pd-rev-meta', '.pd-rev-msg', '.pd-rev.resolved .pd-rev-msg', '.pd-rev-done', '.pd-head [data-confirm-badge]',
            ...(open ? ['#pd-mark-done-btn', '#pd-revision-hint'] : [])] });
        const card = await page.$eval('.pd-rev:not(.resolved), .pd-rev', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor }; });
        ok('a request is a light card (not a dark box)', /^rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)$/.test(card.bg), JSON.stringify(card));
        if (tag === '390') ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await shot(page, `admin-confirm-${state.split(' ')[0]}-${tag}`);
        if (process.env.SHOTS_DONE) await page.screenshot({ path: `${process.env.SHOTS_DONE}/admin-detail-${state.split(' ')[0]}-${tag}.png`, fullPage: true });
        // the list row's badge is on the list view, one 返回 away (it is hidden behind an open detail)
        await page.click('#pd-back-btn');
        await page.waitForSelector('#proj-recent-list [data-confirm-badge]', { state: 'visible', timeout: 5000 });
        await brightChecks(page, ok, `admin 列表的確認徽章 (${state})`, { minItems: 20, named: ['#proj-recent-list [data-confirm-badge]'] });
        return out;
      },
      { before: m.attach, initScript: ADMIN, contextOptions: ctx });
  }
}

// ── admin.html: the project detail's section title rows (區塊收合), closed and open ──
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = pickFakeWorker({ projectId: 'proj-sec', title: '收合專案', phase: 'retouching', ownerName: 'Grace', pickLimit: 30, extraMax: 10, extraPrice: 500,
    folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite(`亮色主題 — admin 專案詳情的區塊標題列（收合與展開）[${tag}]`,
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await tokenChecks(page, ok, 'admin 區塊');
      const named = ['.pd-sec-title', '.pd-sec-sum', '.pd-sec-caret', '#pd-sec-selections .pd-sec-head a.pd-link'];
      await brightChecks(page, ok, 'admin 區塊（收合）', { minItems: 30, named });
      const bg = await page.$eval('.pd-sec', e => getComputedStyle(e).backgroundColor);
      ok('a section is a white card on the cream page', bg === WHITE, bg);
      for (const n of SEC_NAMES) { if (!secOpen((await secInfo(page))[n])) await page.click(`#pd-sec-${n}-btn`); }
      await brightChecks(page, ok, 'admin 區塊（全部展開）', { minItems: 60, named });
      await shot(page, `admin-sections-${tag}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: ctx });
}

// ── admin.html: the 客戶 table ─────────────────────────────────────────────
{
  const m = adminMock({ clients: [...SHOOT_CLIENTS,
    { id: 5, name: '待審核', email: 'p@b.c', approved: 0, can_book: 0, can_upload: 1, folder_path: '', folders: [], shoot_date: '', shoot_type: '' }] });
  await suite('亮色主題 — admin 客戶列表：表頭、儲存格、輸入框、開關、徽章',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr[data-id]').length >= 5, null, { timeout: 6000 });
      await tokenChecks(page, ok, 'admin 客戶');
      await brightChecks(page, ok, 'admin 客戶', { minItems: 30,
        named: ['#clients-table th', '#clients-tbody td', '#clients-tbody .badge-approved', '#clients-tbody .badge-pending', '#clients-tbody [data-shoot-date]',
          '#clients-tbody .btn', '.folder-none', '.folder-chip'] });
      const th = await page.$eval('#clients-table thead', e => getComputedStyle(e).backgroundColor);
      ok('the table head is a warm tint, not the old dark card', th !== 'rgb(34, 31, 24)' && th !== 'rgba(0, 0, 0, 0)', th);
      await shot(page, 'admin-clients-1280');
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: DESKTOP });
}

// ── admin.html: the login card ─────────────────────────────────────────────
await suite('亮色主題 — admin 登入畫面',
  `${base}/admin.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#login-view', { state: 'visible', timeout: 5000 });
    await page.fill('#admin-token-input', 'x');
    await page.evaluate(() => { document.getElementById('admin-login-err').textContent = '密碼錯誤'; });
    await tokenChecks(page, ok, 'admin 登入');
    await brightChecks(page, ok, 'admin 登入', { minItems: 4, named: ['.login-card .subtitle', '#admin-token-input', '#admin-login-btn', '#admin-login-err'] });
    const card = await page.$eval('.login-card', e => getComputedStyle(e).backgroundColor);
    ok('the card is white on cream', card === WHITE, card);
    await shot(page, 'admin-login-1280');
    return out;
  },
  { contextOptions: DESKTOP });

// ── upload.html ────────────────────────────────────────────────────────────
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = adminMock({ tree: { '': ['20260819/', '20260901/'], '20260819/': ['20260819/Anita/', '20260819/毛片/'] } });
  await suite(`亮色主題 — upload.html：資料夾樹、拖放區、進度條、佇列各狀態、toast [${tag}]`,
    `${base}/upload.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.sb-node', { timeout: 5000 });
      ok('the page is the upload page, signed in (positive: not the login overlay)',
        await page.evaluate(() => !document.getElementById('auth-overlay') && !!document.getElementById('dropZone')));
      await tokenChecks(page, ok, 'upload');
      // state 1: nothing chosen yet — the drop zone is the inactive one
      await brightChecks(page, ok, 'upload 未選資料夾', { minItems: 10, inactive: ['.drop-zone.no-target'],
        named: ['.logo-name', '.btn-back', '.sidebar-label', '.sidebar-refresh', '.sb-name', '.sb-toggle', '.section-label', '#targetDisplay'] });
      await shot(page, `upload-initial-${tag}`);
      // expand a folder, hover a row (reveals the + button), pick it, open the new-folder input
      await page.click('.sb-node[data-path="20260819/"] > .sb-row > .sb-toggle');
      await page.waitForSelector('.sb-node[data-path="20260819/Anita/"]', { timeout: 3000 });
      await page.click('.sb-node[data-path="20260819/Anita/"] .sb-name');
      await page.hover('.sb-node[data-path="20260819/毛片/"] > .sb-row');
      await page.hover('.sb-node[data-path="20260819/"] > .sb-row');
      await page.click('.sb-node[data-path="20260819/"] > .sb-row .sb-add');
      await page.waitForSelector('#sidebarTree .sb-new-input', { timeout: 2000 });
      ok('a folder is selected (selected row, 已選定 hint, drop zone active)',
        await page.evaluate(() => !!document.querySelector('.sb-row.selected') && document.getElementById('targetHint').textContent === '已選定' &&
          !document.getElementById('dropZone').classList.contains('no-target')));
      // the queue in every state, a folder node, and the overall bar in each colour
      await page.evaluate(() => {
        const mk = (name, path, state, extra = {}) => ({ id: 'q' + Math.random().toString(36).slice(2), file: { name, size: 3.2 * 1024 * 1024 }, path, state, progress: 0, error: null, ...extra });
        queue.push(mk('IMG_0001.jpg', 'IMG_0001.jpg', 'done', { progress: 100 }),
          mk('IMG_0002.jpg', 'IMG_0002.jpg', 'uploading', { progress: 45 }),
          mk('IMG_0003.jpg', 'IMG_0003.jpg', 'pending'),
          mk('IMG_0004.heic', 'IMG_0004.heic', 'error', { error: '上傳失敗 (413)' }),
          mk('IMG_0005.jpg', 'IMG_0005.jpg', 'done', { progress: 100, thumbWarning: '縮圖失敗' }),
          mk('IMG_0006.jpg', '毛片/IMG_0006.jpg', 'done', { progress: 100 }),
          mk('IMG_0007.jpg', '毛片/IMG_0007.jpg', 'uploading', { progress: 80 }));
        renderQueue();
        document.getElementById('overallWrap').classList.add('visible');
        document.getElementById('queueSection').style.display = '';
        renderOverall();
      });
      await page.waitForSelector('.queue-item.error', { timeout: 2000 });
      await page.waitForSelector('.tree-dir-summary', { timeout: 2000 });
      const states = await page.evaluate(() => ['done', 'uploading', 'pending', 'error'].map(s => [s, !!document.querySelector(`.queue-item.${s}`)])
        .concat([['warn', !!document.querySelector('.qi-status.warn')]]));
      ok('the fixture shows every queue state, the no-thumbnail warning and a folder node', states.every(([, v]) => v), JSON.stringify(states));
      await brightChecks(page, ok, 'upload 佇列', { minItems: 40, inactive: ['.drop-zone.no-target'],
        named: ['.drop-title', '.drop-sub', '.drop-zone .btn-secondary', '.overall-stats', '#overallPct', '.queue-title', '#clearDoneBtn', ...(tag === '1280' ? ['.qi-name'] : []), '.qi-size', '.qi-status.uploading', '.qi-status.done',
          '.qi-status.done.warn', '.qi-status.error', '.qi-status:not(.uploading):not(.done):not(.error)', '.tree-dir-name', '.tree-dir-meta', '.sb-new-input', '.sb-row.selected .sb-name', '.target-hint'] });
      // the toast from selecting a folder is still up (2.8s)
      await page.evaluate(() => selectFolder('20260901/'));
      const toastC = await page.evaluate(() => { const t = [...document.querySelectorAll('body > div')].find(d => /已選擇/.test(d.textContent) && getComputedStyle(d).position === 'fixed'); if (!t) return null; const c = getComputedStyle(t); return { bg: c.backgroundColor, color: c.color }; });
      ok('the toast exists (positive)', !!toastC, JSON.stringify(toastC));
      if (toastC) {
        const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
        const lumOf = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const a = lumOf(parse(toastC.bg)), b = lumOf(parse(toastC.color));
        const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        ok('the toast is readable and not a dark slab on the light page', cr >= 4.5 && a > 0.5, `${toastC.bg} / ${toastC.color} = ${cr.toFixed(2)}`);
      }
      await shot(page, `upload-queue-${tag}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

// upload.html signed out: auth.js's overlay follows the page's theme…
await suite('亮色主題 — upload.html 未登入：auth.js 的登入遮罩也是亮色',
  `${base}/upload.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#auth-overlay', { timeout: 5000 });
    const ov = await page.$eval('#auth-overlay', e => getComputedStyle(e).backgroundColor);
    ok('the overlay ground is the cream', ov === CREAM, ov);
    await brightChecks(page, ok, 'upload 登入遮罩', { root: '#auth-overlay', minItems: 3, named: ['#auth-overlay #auth-input', '#auth-overlay #auth-btn'] });
    await shot(page, 'upload-login-1280');
    return out;
  },
  { contextOptions: DESKTOP });

// …while a dark page that shares auth.js keeps its dark overlay.
await suite('亮色主題 — r2_designer（共用 auth.js 的深色頁）的登入遮罩維持深色',
  `${base}/r2_designer/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#auth-overlay', { timeout: 5000 });
    const ov = await page.$eval('#auth-overlay', e => getComputedStyle(e).backgroundColor);
    ok('the overlay ground is still the dark one', ov === CLIENT_DARK, ov);
    return out;
  },
  // fabric.js comes from a CDN the sandbox cannot reach; the designer needs
  // it only to boot, and this test is about auth.js's overlay, so stub it
  { contextOptions: DESKTOP, before: page => page.route('**/fabric.min.js', r => r.fulfill({ contentType: 'text/javascript',
      body: 'const P = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : P()), apply: () => P(), construct: () => P() }); window.fabric = P();' })) });

// ── the client's pages stay dark (positive assertions) ─────────────────────
{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY' });
  await suite('客戶端維持深色 — index.html 客戶選片連結（?t=）：body、:root 與卡片都還是深色',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the guest picking page really loaded (positive: photos, no redirect to home.html)',
        await page.evaluate(() => document.querySelectorAll('.photo-card').length > 0 && /index\.html$/.test(location.pathname)));
      const r = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
        ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().toLowerCase(),
        card: getComputedStyle(document.querySelector('.photo-card')).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      ok('body ground is the dark one', r.body === CLIENT_DARK, r.body);
      ok('css/styles.css :root --bg is still #15120d', r.bg === '#15120d', r.bg);
      ok('and --ink is still the light text colour', r.ink === '#f1ead8', r.ink);
      ok('text on it is light', /^rgb\((2\d\d|1[5-9]\d), /.test(r.text), r.text);
      await shot(page, 'client-pick-dark-1280');
      return out;
    },
    { before: m.attach, contextOptions: DESKTOP });
}

{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY' });
  await suite('客戶端維持深色 — index.html 客戶選片連結（手機 390px）',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok('body ground is the dark one on a phone too', body === CLIENT_DARK, body);
      await shot(page, 'client-pick-dark-390');
      return out;
    },
    { before: m.attach, contextOptions: PHONE });
}

await suite('客戶端維持深色 — index.html 攝影師看照片（studio token）也維持現狀',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!document.getElementById('studio-logout'), null, { timeout: 5000 });
    ok('signed in as photographer, still on index.html (positive: not bounced to home.html)', await page.evaluate(() => /index\.html$/.test(location.pathname)));
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('body ground is unchanged (dark)', body === CLIENT_DARK, body);
    return out;
  },
  { initScript: ADMIN, before: pickFakeWorker().attach, contextOptions: DESKTOP });

await suite('客戶端維持深色 — client-login.html',
  `${base}/client-login.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#login-email', { state: 'visible', timeout: 5000 });
    const r = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      card: getComputedStyle(document.querySelector('.card')).backgroundColor,
      field: getComputedStyle(document.getElementById('login-email')).backgroundColor,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
    }));
    ok('body ground is the dark one', r.body === CLIENT_DARK, r.body);
    ok('the card is dark', r.card === 'rgb(29, 26, 20)', r.card);
    ok('the field is dark', r.field === 'rgb(34, 31, 24)', r.field);
    ok('its own --bg token is still #15120d', r.bg === '#15120d', r.bg);
    await shot(page, 'client-login-dark-1280');
    return out;
  },
  { contextOptions: DESKTOP });

{
  const m = shareMock();
  await suite('客戶端維持深色 — book_editor/view.html（客戶看相本）',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      ok('the album really loaded (positive: canvases exist)', (await page.$$('.page-canvas')).length > 0);
      const r = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        header: getComputedStyle(document.querySelector('.viewer-header')).backgroundColor,
      }));
      ok('body ground is the dark one', r.body === VIEW_DARK, r.body);
      ok('the header is the dark navy', r.header === 'rgb(22, 33, 62)', r.header);
      await shot(page, 'client-album-dark-1280');
      return out;
    },
    { before: async page => { page.on('dialog', d => d.accept()); await m.attach(page); }, contextOptions: DESKTOP });
}
}
