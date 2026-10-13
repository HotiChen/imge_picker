// The photographer's account session (email + password login, or an invited registration), next to Tim's own token.
//
// Both ride in sessionStorage.studio_token as a bearer token, so every page keeps working with either. This file only
// remembers WHICH kind it is, in sessionStorage.studio_session = {t: <the token it describes>, must: <bool>}:
//  - it is tied to the token it was written for, so a stale record never describes another token (Tim's token entry
//    keeps working exactly as before and never sees this);
//  - `must` = the account must change its password first (must_change_password): every page but settings.html sends the
//    person to settings.html until it is done (the Worker also answers 403 must_change_password on the other routes).
// Nothing secret is added: the token is already in studio_token. Loaded in <head> by every photographer page so the
// redirect runs before the page starts its own requests.
(function () {
  const TOKEN = 'studio_token';
  const SESSION = 'studio_session';
  const WORKER_URL = 'https://imagepicker.hotichen.workers.dev';

  const get = k => { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const set = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* the page shows the error itself */ } };
  const del = k => { try { sessionStorage.removeItem(k); } catch (e) { /* best effort */ } };

  function record() {
    try {
      const r = JSON.parse(get(SESSION) || 'null');
      return r && typeof r.t === 'string' && r.t && r.t === get(TOKEN) ? r : null;
    } catch (e) { return null; }
  }
  const isSession = () => !!record();
  const mustChange = () => !!(record() && record().must);

  // A session the Worker just gave: login, register-invite, or change-password's new token.
  function store(token, opts) {
    set(TOKEN, token);
    set(SESSION, JSON.stringify({ t: token, must: !!(opts && opts.mustChange) }));
  }
  function setMust(on) {
    const r = record();
    if (r) set(SESSION, JSON.stringify({ t: r.t, must: !!on }));
  }
  function clear() { del(TOKEN); del(SESSION); }

  // Sign out: tell the Worker (best effort, only for an account session; Tim's token has nothing to end), then forget.
  function logout() {
    const r = record();
    if (r) {
      try {
        fetch(`${WORKER_URL}/api/photographer/logout`, { method: 'POST', keepalive: true, headers: { 'Authorization': `Bearer ${r.t}` } }).catch(() => {});
      } catch (e) { /* the token is dropped below either way */ }
    }
    clear();
  }

  // settings.html resolved from this script's own address (js/ is beside it), so it is right from book_editor/ and
  // r2_designer/ too, where a bare 'settings.html' would be a 404.
  const me = document.currentScript && document.currentScript.src;
  const settingsUrl = () => (me ? new URL('../settings.html', me).href : 'settings.html');

  // Where a flagged account may be: settings.html only.
  function guard() {
    if (!mustChange()) return;
    if (/\/settings\.html$/.test(location.pathname)) return;
    location.replace(settingsUrl());
  }

  window.PhotographerSession = { WORKER_URL, isSession, mustChange, store, setMust, clear, logout, settingsUrl };
  guard();
})();
