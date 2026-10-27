// Read-only viewer of a GUEST'S album layout, for the photographer (docs/guest-shop.md, "S3 — 客人相本排版", work
// package 3): orders.html and admin.html show 「查看排版」 on a guest album line whose order_items.layout is Layout JSON
// v2 ({v:2, mode:'auto', cover, spreads:[{template, mirrored?, slots:[{photo_key, fit, crop}]}], back}); this file opens
// the cover and each spread, one at a time, with the photos' file names beside them and a 複製排版清單 for the print shop.
//
// Two parts:
//   1. PURE (node-testable, test/unit/album-layout-view.test.mjs): pagesOf(layout, SpreadTemplates) -> pages with
//      geometry and file names, listText, drawBox, imageUrl, baseName. Never throws on a malformed layout.
//   2. DOM: open({layout, opener}). Everything the guest controls (photo keys, template ids, file names) goes in with
//      createElement / textContent / setAttribute ONLY. No HTML string is ever built from them.
//
// Nothing of the ORDER is stored or written. The requests besides the photos: the studio-token mint (POST
// /api/auth/studio-token, js/studio-token.js's own trade; an <img> cannot send an Authorization header) and, only when
// 匯入 book editor is pressed and confirmed, one PUT /api/books/<new id> (a new album; book_editor/js/import_layout.js).
// Photos are thumbnails only: GET <worker>/<key>?w=1200&t=<studio token>, never an original, never ?download.
(function () {
  const MAX_SPREADS = 200;          // the Worker's own cap (docs/guest-shop.md); a longer list is cut, not rendered
  const THUMB_W = 1200;
  const COVER_ASPECT = 210 / 297;
  const SPREAD_ASPECT = 420 / 297;
  const CROP_MAX = 5;               // the Worker accepts crop within +-5

  // ── pure ────────────────────────────────────────────────────────────────
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const baseName = k => String(k).split('/').pop();
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const isV2 = l => isObj(l) && l.v === 2;
  const spreadCount = l => (isObj(l) && Array.isArray(l.spreads) ? l.spreads.length : null);

  function cropOf(c) {
    const o = isObj(c) ? c : {};
    const lim = v => Math.max(-CROP_MAX, Math.min(CROP_MAX, num(v, 0)));
    const sc = num(o.scale, 1);
    return { x: lim(o.x), y: lim(o.y), scale: sc > 0 && sc <= 10 ? sc : 1 };
  }
  const keyOf = s => (isObj(s) && typeof s.photo_key === 'string' ? s.photo_key : '');
  const namesOf = slots => (Array.isArray(slots) ? slots : []).map(keyOf).filter(Boolean).map(baseName);
  const slotOf = (s, box) => ({ key: keyOf(s), x: box.x, y: box.y, w: box.w, h: box.h, fit: isObj(s) && s.fit === 'contain' ? 'contain' : 'cover', crop: cropOf(isObj(s) ? s.crop : null) });

  // Layout JSON v2 -> { pages: [{label, kind, aspect, ok, slots:[{key,x,y,w,h,fit,crop}], names}], unreadable }.
  // `templates` is SpreadTemplates (byId). A spread whose template is unknown or whose slot count is not the template's
  // is { ok: false, slots: [] } but keeps the names it could read. `unreadable`: there is no list of spreads at all.
  function pagesOf(layout, templates) {
    const pages = [];
    if (!isObj(layout)) return { pages, unreadable: true };
    const cover = layout.cover;
    if (isObj(cover) && keyOf(cover)) {
      pages.push({ label: '封面', kind: 'cover', aspect: COVER_ASPECT, ok: true, slots: [slotOf(cover, { x: 0, y: 0, w: 1, h: 1 })], names: namesOf([cover]) });
    }
    const unreadable = !Array.isArray(layout.spreads);
    const list = unreadable ? [] : layout.spreads.slice(0, MAX_SPREADS);
    list.forEach((sp, i) => {
      const label = `第${i + 1}跨頁`;
      const slots = isObj(sp) && Array.isArray(sp.slots) ? sp.slots : [];
      const names = namesOf(slots);
      let t = null;
      try { t = isObj(sp) && typeof sp.template === 'string' && templates && typeof templates.byId === 'function' ? templates.byId(sp.template) : null; } catch (e) { t = null; }
      const good = isObj(t) && Array.isArray(t.slots) && t.slots.length === slots.length && slots.length > 0;
      if (!good) { pages.push({ label, kind: 'spread', aspect: SPREAD_ASPECT, ok: false, slots: [], names }); return; }
      const mirrored = sp.mirrored === true;
      pages.push({ label, kind: 'spread', aspect: SPREAD_ASPECT, ok: true, names,
        slots: slots.map((s, j) => {
          const g = t.slots[j];
          return slotOf(s, { x: mirrored ? 1 - g.x - g.w : g.x, y: g.y, w: g.w, h: g.h });
        }) });
    });
    if (isObj(layout.back)) pages.push({ label: '封底', kind: 'back', aspect: COVER_ASPECT, ok: true, slots: [], names: [] });
    return { pages, unreadable };
  }

  // `封面: IMG_001.jpg / 第1跨頁: IMG_002.jpg, IMG_003.jpg / …` for the print shop; pages without a file name are left out.
  function listText(pages) {
    return (Array.isArray(pages) ? pages : []).filter(p => p && p.names && p.names.length).map(p => `${p.label}: ${p.names.join(', ')}`).join(' / ');
  }

  // Where the photo goes inside its slot (px), the rule of layouts.js fitCoverImage (cover: the photo scaled to cover the
  // slot) and AutoLayout.util.containBox (contain: the whole photo); crop x / y are fractions of the slot.
  function drawBox(fit, natW, natH, slotW, slotH, crop) {
    if (!(natW > 0 && natH > 0 && slotW > 0 && slotH > 0)) return { left: 0, top: 0, w: Math.max(0, slotW) || 0, h: Math.max(0, slotH) || 0 };
    const c = cropOf(crop);
    const a = c.scale * slotW / natW, b = c.scale * slotH / natH;
    const k = fit === 'contain' ? Math.min(a, b) : Math.max(a, b);
    const w = natW * k, h = natH * k;
    return { left: (slotW - w) / 2 + c.x * slotW, top: (slotH - h) / 2 + c.y * slotH, w, h };
  }

  // A thumbnail (never the original) of a key; each path segment encoded, so a '#', '?' or quote in a name is data.
  function imageUrl(workerUrl, key, token) {
    if (typeof key !== 'string' || !key) return '';
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${workerUrl}/${path}?w=${THUMB_W}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
  }

  const api = { MAX_SPREADS, isV2, spreadCount, pagesOf, listText, drawBox, imageUrl, baseName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ── DOM ─────────────────────────────────────────────────────────────────
  const SCRIPT_SRC = document.currentScript && document.currentScript.src;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (cls, label, aria) => {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  };

  // SpreadTemplates and ImportLayout are classic-script `const`s: reachable by name, not as window.X. Each is loaded on the
  // first press that needs it, from beside this script, with this script's own ?v= stamp (one load per name, retried after a
  // failed one).
  const libs = {};
  function loadLib(rel, name, present) {
    const have = present();
    if (have) return Promise.resolve(have);
    if (libs[name]) return libs[name];
    libs[name] = new Promise(resolve => {
      let src = '';
      try {
        const u = new URL(rel, SCRIPT_SRC);
        const v = new URL(SCRIPT_SRC).searchParams.get('v');
        if (v) u.searchParams.set('v', v);
        src = u.href;
      } catch (e) { resolve(null); return; }
      const s = document.createElement('script');
      s.setAttribute('src', src);
      s.addEventListener('load', () => { const got = present() || null; if (!got) libs[name] = null; resolve(got); });
      s.addEventListener('error', () => { libs[name] = null; resolve(null); });
      document.head.appendChild(s);
    });
    return libs[name];
  }
  const loadTemplates = () => loadLib('../book_editor/js/spread_templates.js', 'templates', () => (typeof SpreadTemplates !== 'undefined' ? SpreadTemplates : null));
  // the converter of a guest layout into a book_editor book (book_editor/js/import_layout.js), for 匯入 book editor
  const loadImporter = () => loadLib('../book_editor/js/import_layout.js', 'importer', () => (typeof ImportLayout !== 'undefined' ? ImportLayout : null));

  // A new book id the way book_editor makes one (book_editor.js _generateId).
  function newBookId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function editorUrl(id) {
    const u = new URL('../book_editor/index.html', SCRIPT_SRC || location.href);
    u.search = '';
    u.searchParams.set('id', id);
    return u.href;
  }
  const importFail = (code, status) => {
    if (code === 'no-token') return '請先登入攝影師帳號再匯入';
    if (status === 401) return '登入已過期，請重新登入後再試';
    if (status === 400) return '伺服器拒絕了這份排版，沒有建立相本';
    return `儲存失敗（${status ? `HTTP ${status}` : '連不上伺服器'}），沒有建立相本，可以再按一次`;
  };

  // 匯入 book editor: build the book from the layout, PUT it under a NEW id, open it. Once per viewer: busy / done disables
  // the button, so a second press creates nothing. The order is never touched (only a new _books/<id>.json is written).
  async function importBook(v) {
    if (v.importing || v.imported) return;
    const say = (text, err) => { v.importStatus.textContent = text; v.importStatus.classList.toggle('alv-import-err', !!err); };
    if (!window.confirm('會建立一本新的相本，客人的訂單不會改變')) return;
    v.importing = true;
    v.importBtn.disabled = true;
    say('匯入中…');
    try {
      let token = '';
      try { token = sessionStorage.getItem('studio_token') || ''; } catch (e) { token = ''; }
      if (!token) { say(importFail('no-token'), true); return; }
      const [templates, importer] = await Promise.all([loadTemplates(), loadImporter()]);
      if (!templates || !importer) { say('載入匯入工具失敗，請重新整理後再試', true); return; }
      let book;
      try { book = importer.layoutToBook(v.layout, { name: v.bookName, templates }); }
      catch (e) { say(`這份排版無法匯入：${e && e.message ? e.message : '格式不正確'}`, true); return; }
      const id = newBookId();
      let res;
      try {
        res = await fetch(`${workerUrl()}/api/books/${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(book),
        });
      } catch (e) { say(importFail('net', 0), true); return; }
      if (!res.ok) { say(importFail('http', res.status), true); return; }
      v.imported = id;
      const url = editorUrl(id);
      v.importBtn.textContent = '已匯入';
      v.importStatus.textContent = '';
      v.importStatus.classList.remove('alv-import-err');
      const a = el('a', 'alv-import-link', '已匯入，開啟');
      a.setAttribute('href', url);
      a.setAttribute('data-alv-import-link', '');
      // window.open WITHOUT noopener, like js/app.js opens book_editor: the new tab inherits a copy of sessionStorage, so the
      // editor finds the photographer's studio_token (a target=_blank link is noopener and would meet the login overlay).
      // The URL is this site's own page. If the browser blocks the pop-up, the link is a fresh click.
      const openIt = () => { try { return window.open(url, '_blank'); } catch (e) { return null; } };
      a.addEventListener('click', e => { e.preventDefault(); openIt(); });
      v.importStatus.appendChild(a);
      openIt();
    } finally {
      v.importing = false;
      if (!v.imported) v.importBtn.disabled = false;
    }
  }

  // The read-only thumbnail token (js/studio-token.js's trade), cached until close to its deadline.
  const SKEW_MS = 5 * 60 * 1000;
  let tok = { value: '', expiresAt: 0 };
  const workerUrl = () => (window.PhotographerSession && window.PhotographerSession.WORKER_URL) || (window.CONFIG && window.CONFIG.WORKER_URL) || '';
  async function studioToken() {
    if (tok.value && Date.now() < tok.expiresAt - SKEW_MS) return tok.value;
    let admin = '';
    try { admin = sessionStorage.getItem('studio_token') || ''; } catch (e) { admin = ''; }
    if (!admin) return '';
    try {
      const res = await fetch(`${workerUrl()}/api/auth/studio-token`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
      if (!res.ok) return '';
      const d = await res.json();
      if (!d || typeof d.token !== 'string' || !d.token) return '';
      tok = { value: d.token, expiresAt: Date.parse(d.expires_at) || Date.now() + 60 * 60 * 1000 };
      return tok.value;
    } catch (e) { return ''; }
  }

  let current = null;           // the open viewer, or null

  function close() {
    const v = current;
    if (!v) return;
    current = null;
    document.removeEventListener('keydown', v.onKey, true);
    window.removeEventListener('resize', v.onResize);
    v.root.remove();
    document.body.style.overflow = v.prevOverflow;
    if (v.opener && typeof v.opener.focus === 'function' && document.contains(v.opener)) v.opener.focus();
  }

  function slotNode(slot, token, base) {
    const box = el('div', 'alv-slot');
    box.setAttribute('data-slot', '');
    const pct = v => `${+(v * 100).toFixed(3)}%`;
    box.style.left = pct(slot.x); box.style.top = pct(slot.y); box.style.width = pct(slot.w); box.style.height = pct(slot.h);
    if (slot.fit === 'contain') box.setAttribute('data-fit', 'contain');
    const missing = why => {
      const m = el('div', 'alv-missing');
      m.setAttribute('data-missing', '');
      m.appendChild(el('span', 'alv-missing-why', why));
      if (slot.key) m.appendChild(el('span', 'alv-missing-name', baseName(slot.key)));
      box.replaceChildren(m);
    };
    if (!slot.key) { missing('沒有照片'); return box; }
    const img = new Image();
    img.className = 'alv-img';
    img.setAttribute('alt', baseName(slot.key));
    img.setAttribute('draggable', 'false');
    img.setAttribute('data-photo-key', slot.key);
    img.style.visibility = 'hidden';
    const fit = () => {
      if (!img.naturalWidth || !img.isConnected) return;
      const b = drawBox(slot.fit, img.naturalWidth, img.naturalHeight, box.clientWidth, box.clientHeight, slot.crop);
      img.style.width = `${b.w}px`; img.style.height = `${b.h}px`; img.style.left = `${b.left}px`; img.style.top = `${b.top}px`;
      img.style.visibility = '';
    };
    img.alvFit = fit;
    img.addEventListener('load', fit);
    img.addEventListener('error', () => missing('找不到這張照片'));
    box.appendChild(img);
    img.setAttribute('src', imageUrl(base, slot.key, token));
    return box;
  }

  function render(v) {
    const p = v.pages[v.index];
    const total = v.pages.length;
    v.title.textContent = p ? p.label : '';
    v.count.textContent = total ? `${v.index + 1} / ${total}` : '0 / 0';
    v.prev.disabled = v.index <= 0;
    v.next.disabled = v.index >= total - 1;
    v.stage.replaceChildren();
    v.names.replaceChildren();
    if (!p) {
      v.stage.appendChild(el('div', 'alv-bad', '這份排版無法預覽'));
      v.names.appendChild(el('li', 'alv-none', '沒有可讀的檔名'));
      return;
    }
    const frame = el('div', 'alv-page');
    frame.setAttribute('data-kind', p.kind);
    frame.setAttribute('data-page', p.label);
    frame.style.aspectRatio = String(p.aspect);
    if (p.kind === 'spread') frame.appendChild(el('div', 'alv-fold'));
    if (!p.ok) frame.appendChild(el('div', 'alv-bad', '這份排版無法預覽'));
    else if (p.kind === 'back') frame.appendChild(el('div', 'alv-blank', '封底（沒有照片）'));
    else for (const s of p.slots) frame.appendChild(slotNode(s, v.token, v.base));
    v.stage.appendChild(frame);
    if (p.names.length) p.names.forEach(n => v.names.appendChild(el('li', 'alv-name', n)));
    else v.names.appendChild(el('li', 'alv-none', '（沒有照片）'));
    v.names.querySelectorAll('li').forEach(li => li.setAttribute('dir', 'auto'));
  }
  const refit = v => v.stage.querySelectorAll('.alv-img').forEach(i => { if (i.alvFit) i.alvFit(); });

  function go(v, delta) {
    const to = Math.max(0, Math.min(v.pages.length - 1, v.index + delta));
    if (to === v.index) return;
    v.index = to;
    render(v);
  }

  async function copyList(v) {
    const text = listText(v.pages);
    v.copyStatus.textContent = '';
    v.fallback.hidden = true;
    let done = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); done = true; }
    } catch (e) { done = false; }
    if (done) { v.copyStatus.textContent = '已複製排版清單'; return; }
    v.fallback.hidden = false;
    v.fallback.value = text;
    v.copyStatus.textContent = '無法自動複製，請長按選取下面的文字再複製';
    v.fallback.focus();
    v.fallback.select();
  }

  // open({ layout, opener }): the viewer for one order line's Layout JSON. Safe on anything.
  async function open(opts) {
    if (current) close();
    const o = opts || {};
    const root = el('div', 'alv');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '客人排的版面');
    root.setAttribute('data-layout-viewer', '');
    root.tabIndex = -1;
    const bar = el('div', 'alv-bar');
    const title = el('span', 'alv-title');
    const count = el('span', 'alv-count');
    count.setAttribute('data-page-count', '');
    const closeBtn = button('alv-close', '✕', '關閉');
    closeBtn.setAttribute('data-alv-close', '');
    bar.append(title, count, closeBtn);
    const body = el('div', 'alv-body');
    const main = el('div', 'alv-main');
    const prev = button('alv-nav alv-prev', '‹', '上一頁');
    const next = button('alv-nav alv-next', '›', '下一頁');
    prev.setAttribute('data-alv-prev', ''); next.setAttribute('data-alv-next', '');
    const stage = el('div', 'alv-stage');
    main.append(prev, stage, next);
    const side = el('div', 'alv-side');
    side.appendChild(el('div', 'alv-side-h', '這一頁的檔名（閱讀順序）'));
    const names = el('ol', 'alv-names');
    names.setAttribute('data-alv-names', '');
    const copy = button('btn btn-ghost alv-copy', '複製排版清單');
    copy.setAttribute('data-alv-copy', '');
    const copyStatus = el('div', 'alv-copy-status');
    copyStatus.setAttribute('role', 'status');
    const fallback = el('textarea', 'alv-fallback');
    fallback.setAttribute('readonly', '');
    fallback.setAttribute('rows', '5');
    fallback.setAttribute('aria-label', '排版清單');
    fallback.hidden = true;
    const importBtn = button('btn btn-ghost alv-import', '匯入 book editor');
    importBtn.setAttribute('data-alv-import', '');
    const importStatus = el('div', 'alv-import-status');
    importStatus.setAttribute('role', 'status');
    importStatus.setAttribute('data-alv-import-status', '');
    side.append(names, copy, copyStatus, fallback, importBtn, importStatus);
    body.append(main, side);
    root.append(bar, body);

    const v = { root, title, count, stage, names, prev, next, copyStatus, fallback, pages: [], index: 0, token: '', base: workerUrl(),
      importBtn, importStatus, importing: false, imported: '', layout: o.layout, bookName: typeof o.name === 'string' ? o.name : '',
      opener: o.opener || null, prevOverflow: document.body.style.overflow };
    v.onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(v, -1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(v, 1); return; }
      if (e.key === 'Tab') {                       // keep Tab inside the dialog
        const f = [...root.querySelectorAll('button, textarea, a[href]')].filter(x => !x.disabled && !x.hidden && x.getClientRects().length);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1], at = document.activeElement;
        if (e.shiftKey && (at === first || at === root)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
        else if (!root.contains(at)) { e.preventDefault(); first.focus(); }
      }
    };
    v.onResize = () => refit(v);
    closeBtn.addEventListener('click', close);
    prev.addEventListener('click', () => go(v, -1));
    next.addEventListener('click', () => go(v, 1));
    copy.addEventListener('click', () => copyList(v));
    importBtn.addEventListener('click', () => importBook(v));
    let sx = null, sy = 0;
    stage.addEventListener('touchstart', e => { const t = e.touches[0]; if (e.touches.length === 1 && t) { sx = t.clientX; sy = t.clientY; } else sx = null; }, { passive: true });
    stage.addEventListener('touchend', e => {
      const t = e.changedTouches[0];
      if (sx === null || !t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(v, dx < 0 ? 1 : -1);
    }, { passive: true });
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });

    current = v;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(root);
    document.addEventListener('keydown', v.onKey, true);
    window.addEventListener('resize', v.onResize);
    root.focus();

    stage.appendChild(el('div', 'alv-loading', '載入中…'));
    const [templates, token] = await Promise.all([loadTemplates(), studioToken()]);
    if (current !== v) return;                      // closed while loading
    v.token = token;
    const r = pagesOf(o.layout, templates);
    v.pages = r.pages;
    render(v);
    refit(v);
  }

  window.AlbumLayoutView = Object.assign({}, api, { open, close });
})();
