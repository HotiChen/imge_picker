// ONE login for every photographer page (home.html, admin.html, and the overlay js/auth.js draws on upload.html,
// book_editor/ and r2_designer/): a 帳號 field and a 密碼 field.
//  - 帳號 (trimmed, any case) is exactly `admin`  -> 密碼 is the studio password (Tim's PHOTOGRAPHER_TOKEN). The page's own
//    verification call runs exactly as before (GET <verifyPath> with Bearer <password>) and the token is stored in
//    sessionStorage.studio_token. No /api/photographer/* call is made on this path.
//  - anything else -> 帳號 is an email: POST /api/photographer/login {email, password}; the session goes through
//    PhotographerSession.store (studio_token + studio_session, must_change_password flag).
// An email always contains '@', so the two can never be mistaken for each other.
// Nothing is remembered: no localStorage, no password in a URL (the form is method=post and never navigates).
// Needs js/photographer-session.js loaded first. Usage: see home.html / admin.html / auth.js.
(function () {
  const TOKEN_KEY = 'studio_token';
  const DEFAULT_WORKER = 'https://imagepicker.hotichen.workers.dev';

  // One sentence for a refused studio password; the email path says the Worker's own sentence (ERRORS.login_failed).
  // Both start with the same words and neither says which part was wrong.
  const WRONG = '帳號或密碼不正確，或帳號尚未開通';
  const UNREACHABLE = '無法連線，請稍後再試';
  const ERRORS = {
    login_failed: '帳號或密碼不正確，或帳號尚未開通',
    too_many_attempts: '嘗試次數太多，請 15 分鐘後再試',
    photographers_unavailable: '帳號登入功能尚未啟用',
  };

  const isAdmin = account => String(account == null ? '' : account).trim().toLowerCase() === 'admin';

  // Keep the keyboards and the browser from touching what is typed, and let a password manager recognise the pair.
  function prepare(accountInput, passwordInput) {
    if (accountInput) {
      accountInput.type = 'text';                       // not "email": `admin` must be accepted
      accountInput.setAttribute('name', 'username');
      accountInput.setAttribute('autocomplete', 'username');
      accountInput.setAttribute('inputmode', 'email');  // the phone keyboard with @
      accountInput.setAttribute('autocapitalize', 'off');
      accountInput.setAttribute('autocorrect', 'off');
      accountInput.setAttribute('spellcheck', 'false');
      accountInput.setAttribute('enterkeyhint', 'go');
    }
    if (passwordInput) {
      passwordInput.setAttribute('name', 'password');
      passwordInput.setAttribute('autocomplete', 'current-password');
      passwordInput.setAttribute('autocapitalize', 'off');
      passwordInput.setAttribute('autocorrect', 'off');
      passwordInput.setAttribute('spellcheck', 'false');
      passwordInput.setAttribute('enterkeyhint', 'go');
    }
  }

  // The form submits with Enter or the button; the page handles it, the browser never navigates (no password in a URL).
  function bind(form, handler) {
    form.addEventListener('submit', e => { e.preventDefault(); handler(); });
  }

  // opts: { account, password, workerUrl, verifyPath }
  // -> { ok:true, kind:'admin', token } | { ok:true, kind:'account', token, must } | { ok:false, error }
  async function login(opts) {
    const worker = opts.workerUrl || DEFAULT_WORKER;
    const account = String(opts.account == null ? '' : opts.account).trim();
    if (!account) return { ok: false, error: '請輸入帳號' };

    if (isAdmin(account)) {
      const token = String(opts.password == null ? '' : opts.password).trim();
      if (!token) return { ok: false, error: '請輸入密碼' };
      let r;
      try {
        r = await fetch(`${worker}${opts.verifyPath}`, { headers: { 'Authorization': `Bearer ${token}` } });
      } catch (e) {
        return { ok: false, error: UNREACHABLE };   // never store a password that was not verified
      }
      if (r.status === 401 || r.status === 403) return { ok: false, error: WRONG };
      if (!r.ok) return { ok: false, error: UNREACHABLE };   // 5xx and the rest: refused, nothing stored
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) { /* the page shows what it can */ }
      return { ok: true, kind: 'admin', token };
    }

    const password = String(opts.password == null ? '' : opts.password);
    if (!password) return { ok: false, error: '請輸入密碼' };
    try {
      const r = await fetch(`${worker}/api/photographer/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || typeof data.token !== 'string' || !data.token) {
        return { ok: false, error: ERRORS[data && data.code] || (r.status === 429 ? ERRORS.too_many_attempts : `登入失敗（${r.status}）`) };
      }
      const must = data.must_change_password === true;
      PhotographerSession.store(data.token, { mustChange: must });
      return { ok: true, kind: 'account', token: data.token, must };
    } catch (e) {
      return { ok: false, error: UNREACHABLE };
    }
  }

  window.UnifiedLogin = { isAdmin, prepare, bind, login, WRONG, UNREACHABLE, ERRORS };
})();
