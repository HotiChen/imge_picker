// Who is signed in: a small name label right before 登出 on the photographer's pages (dashboard, orders, settings, admin,
// the picker index.html). Nothing else on a page depends on it: a failed lookup shows nothing and changes nothing.
//   - account session (js/photographer-session.js: email login / invited friend): display_name from GET /api/photographer/me
//   - Tim's own token (no account): the studio name from GET /api/admin/settings, else the fixed 「攝影師」
// ONE lookup per sign-in: the answer is kept in sessionStorage.studio_who = {t: <the token it describes>, name}. It is tied
// to the token like studio_session is, so another token never reads it; PhotographerSession.clear() (every logout) removes
// it and calls unmount(). The name is user-controlled: it only ever reaches the page through textContent / setAttribute,
// never innerHTML, and never a URL.
// Markup: <span class="studio-who" title="full name"><span class="studio-who-ini">首字</span><span class="studio-who-name">名字</span></span>
// (css/studio-who.css: desktop shows the name, ellipsised; a phone shows the initial only).
(function () {
  const TOKEN = 'studio_token';
  const CACHE = 'studio_who';
  const FALLBACK = '攝影師';
  const PS = () => window.PhotographerSession || null;
  const WORKER_URL = () => (PS() && PS().WORKER_URL) || 'https://imagepicker.hotichen.workers.dev';

  const get = k => { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const set = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* the label just is not cached */ } };
  const del = k => { try { sessionStorage.removeItem(k); } catch (e) { /* best effort */ } };

  let mounts = [];          // {before, full, el}
  let inflight = null;      // {t, promise}: one lookup at a time per token

  function cached(t) {
    try {
      const r = JSON.parse(get(CACHE) || 'null');
      return r && typeof r.t === 'string' && r.t === t && typeof r.name === 'string' && r.name ? r.name : '';
    } catch (e) { return ''; }
  }

  function build(name, full) {
    const el = document.createElement('span');
    el.className = 'studio-who' + (full ? ' studio-who--menu' : '');
    el.setAttribute('title', name);
    const ini = document.createElement('span');
    ini.className = 'studio-who-ini';
    ini.setAttribute('aria-hidden', 'true');
    ini.textContent = Array.from(name)[0] || '';
    const nm = document.createElement('span');
    nm.className = 'studio-who-name';
    nm.textContent = name;
    el.appendChild(ini);
    el.appendChild(nm);
    return el;
  }

  function paint(m, name) {
    if (m.el && m.el.parentNode) m.el.remove();
    m.el = null;
    if (!name || !m.before || !m.before.parentNode) return;
    m.el = build(name, m.full);
    m.before.parentNode.insertBefore(m.el, m.before);
  }

  // GET /api/photographer/me once per token at a time, shared with settings.html (which needs the whole answer for its
  // account form): {status, ok, data}. A network failure rejects.
  let meCall = null;
  function me(t) {
    if (meCall && meCall.t === t) return meCall.promise;
    const promise = fetch(`${WORKER_URL()}/api/photographer/me`, { headers: { 'Authorization': `Bearer ${t}` } })
      .then(async r => ({ status: r.status, ok: r.ok, data: r.ok ? await r.json().catch(() => null) : null }))
      .then(x => { if (meCall && meCall.promise === promise) meCall = null; return x; },
            e => { if (meCall && meCall.promise === promise) meCall = null; throw e; });
    meCall = { t, promise };
    return promise;
  }

  async function lookup(t) {
    if (PS() && PS().isSession()) {
      const r = await me(t);
      if (!r.ok) return '';
      const p = r.data && r.data.photographer;
      const n = p && typeof p.display_name === 'string' ? p.display_name.trim() : '';
      return n || FALLBACK;
    }
    const r = await fetch(`${WORKER_URL()}/api/admin/settings`, { headers: { 'Authorization': `Bearer ${t}` } });
    if (!r.ok) return '';
    const s = await r.json();
    const n = s && typeof s.studio_name === 'string' ? s.studio_name.trim() : '';
    return n || FALLBACK;
  }

  // The name for the current token: the cache, else one lookup (shared by every mount on the page). '' = unknown.
  function resolve() {
    const t = get(TOKEN);
    if (!t) return Promise.resolve('');
    const c = cached(t);
    if (c) return Promise.resolve(c);
    if (inflight && inflight.t === t) return inflight.promise;
    const promise = lookup(t).then(name => {
      if (name && get(TOKEN) === t) set(CACHE, JSON.stringify({ t, name }));
      return get(TOKEN) === t ? name : '';
    }).catch(() => '').then(name => { if (inflight && inflight.promise === promise) inflight = null; return name; });
    inflight = { t, promise };
    return promise;
  }

  // Put the label right before `before` (the logout button). opts.full = the menu variant (the name itself, not the initial).
  // Safe to call again for the same button, and when nobody is signed in.
  function mount(before, opts) {
    if (!before || !before.parentNode) return;
    if (mounts.some(m => m.before === before)) return;
    const m = { before, full: !!(opts && opts.full), el: null };
    mounts.push(m);
    const t = get(TOKEN);
    if (!t) return;
    const c = cached(t);
    if (c) { paint(m, c); return; }     // already known on this device: no flash, no wait
    resolve().then(name => { if (name && mounts.includes(m) && get(TOKEN) === t) paint(m, name); });
  }

  // Everything off the page, cache gone (PhotographerSession.clear() calls this on every logout).
  function unmount() {
    mounts.forEach(m => { if (m.el && m.el.parentNode) m.el.remove(); });
    mounts = [];
    inflight = null;
    del(CACHE);
  }

  // Tim's own token only: settings.html just saved a new studio name, so the label follows without another read.
  function setStudioName(name) {
    if (PS() && PS().isSession()) return;
    const t = get(TOKEN);
    if (!t) return;
    const n = typeof name === 'string' ? name.trim() : '';
    const shown = n || FALLBACK;
    set(CACHE, JSON.stringify({ t, name: shown }));
    mounts.forEach(m => paint(m, shown));
  }

  window.StudioWho = { mount, unmount, setStudioName, me };
})();
