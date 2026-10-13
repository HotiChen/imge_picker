// Fake of /api/photographer/* (register-invite, login, me, logout, change-password), mirroring worker.js:
// the method per route (405), register-invite closed before anything is read (403 registration_closed), the field
// checks in the Worker's order (invalid_email, invalid_password, invalid_display_name -> 400), the guess throttle
// (429 too_many_attempts), one uniform 400 invalid_invite for every wrong / used / expired / other-email code, 201
// {token, photographer:{id,display_name}, must_change_password}; login's one 401 login_failed and 429; me / change-password
// answer 401 {error, code:'unauthorized'} without a live session; change-password swaps every session of the account for
// ONE new token ({ok, token}); a flagged session (must_change_password) is 403 must_change_password everywhere but
// me / logout / change-password. `gate(path, auth)` lets a page's other routes ask the same session rules.
// Shared by more than one file in test/suites/.
const clone = x => JSON.parse(JSON.stringify(x));

export function photographerFake({
  accounts = [], invites = [], open = true, unavailable = false, failuresMax = 10,
} = {}) {
  const st = {
    accounts: clone(accounts),        // { id, email, password, display_name, must_change }
    invites: clone(invites),          // { email, code, used }
    sessions: new Map(),              // token -> account id
    calls: [], failures: 0, seq: 0, closed: !open,
  };
  const body403 = { error: '請先修改密碼', code: 'must_change_password' };
  const unauth = { error: 'Unauthorized', code: 'unauthorized' };
  const tok = () => `sess-${++st.seq}-${Math.random().toString(16).slice(2, 10)}`;
  const accountOf = auth => {
    const t = (auth || '').replace(/^Bearer\s+/i, '');
    const id = st.sessions.get(t);
    return id ? st.accounts.find(a => a.id === id) || null : null;
  };
  const pwOk = p => typeof p === 'string' && [...p].length >= 10 && [...p].length <= 200;
  const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const norm = e => e.trim().toLowerCase();

  // the same refusal rules the Worker's guard applies to every other photographer route
  function gate(path, auth) {
    const a = accountOf(auth);
    if (!a) return null;
    return a.must_change && !['/api/photographer/me', '/api/photographer/logout', '/api/photographer/change-password'].includes(path)
      ? { status: 403, body: body403 } : null;
  }

  function handle(method, path, auth, bodyText) {
    const route = path.split('/').filter(Boolean)[2];
    const METHOD = { 'register-invite': 'POST', login: 'POST', logout: 'POST', 'change-password': 'POST', me: 'GET' }[route];
    if (!METHOD) return { status: 404, body: { error: 'Not found' } };
    if (method !== METHOD) return { status: 405, body: { error: 'Method not allowed' } };
    if (route === 'register-invite' && st.closed) return { status: 403, body: { error: '目前未開放註冊', code: 'registration_closed' } };
    if (route === 'register-invite' && unavailable) return { status: 500, body: { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' } };
    if (route === 'me') {
      const a = accountOf(auth);
      if (!a) return { status: 401, body: unauth };
      return { body: { photographer: { id: a.id, display_name: a.display_name, email: a.email }, must_change_password: !!a.must_change } };
    }
    if (route === 'logout') {
      const t = (auth || '').replace(/^Bearer\s+/i, '');
      if (t) st.sessions.delete(t);
      return { body: { ok: true } };
    }
    let body = {};
    if (route === 'change-password') {
      if (!accountOf(auth)) return { status: 401, body: unauth };
    }
    try { body = JSON.parse(bodyText || '{}'); } catch (e) { return { status: 400, body: { error: 'Invalid JSON' } }; }
    if (!body || typeof body !== 'object') body = {};
    const tooMany = { error: '嘗試次數太多，請 15 分鐘後再試', code: 'too_many_attempts' };

    if (route === 'login') {
      if (st.failures >= failuresMax) return { status: 429, body: tooMany };
      const a = typeof body.email === 'string' ? st.accounts.find(x => x.email === norm(body.email)) : null;
      if (!a || a.password !== body.password) {
        st.failures++;
        return { status: 401, body: { error: '帳號或密碼不正確，或帳號尚未開通', code: 'login_failed' } };
      }
      const t = tok();
      st.sessions.set(t, a.id);
      return { body: { token: t, photographer: { id: a.id, display_name: a.display_name }, must_change_password: !!a.must_change } };
    }

    if (route === 'change-password') {
      const a = accountOf(auth);
      const { current_password: cur, new_password: next } = body;
      if (typeof cur !== 'string' || !cur) return { status: 400, body: { error: '請輸入目前的密碼', code: 'invalid_current_password' } };
      if (!pwOk(next)) return { status: 400, body: { error: '密碼需 10–200 個字元', code: 'invalid_password' } };
      if (next === cur) return { status: 400, body: { error: '新密碼不能和目前的密碼相同', code: 'same_password' } };
      if (st.failures >= failuresMax) return { status: 429, body: tooMany };
      if (a.password !== cur) { st.failures++; return { status: 403, body: { error: '目前的密碼不正確', code: 'wrong_password' } }; }
      a.password = next;
      a.must_change = false;
      for (const [t, id] of [...st.sessions]) if (id === a.id) st.sessions.delete(t);
      const t = tok();
      st.sessions.set(t, a.id);
      return { body: { ok: true, token: t } };
    }

    // register-invite
    if (!emailOk(body.email)) return { status: 400, body: { error: 'Email 格式不正確', code: 'invalid_email' } };
    if (!pwOk(body.password)) return { status: 400, body: { error: '密碼需 10–200 個字元', code: 'invalid_password' } };
    const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!name || [...name].length > 50) return { status: 400, body: { error: '顯示名稱需 1–50 個字', code: 'invalid_display_name' } };
    if (st.failures >= failuresMax) return { status: 429, body: tooMany };
    const email = norm(body.email);
    const inv = typeof body.invite_code === 'string' && /^\d{8}$/.test(body.invite_code)
      ? st.invites.find(i => !i.used && i.email === email && i.code === body.invite_code) : null;
    if (!inv || st.accounts.some(a => a.email === email)) {
      st.failures++;
      return { status: 400, body: { error: '邀請碼不正確或已失效，或此 Email 無法使用', code: 'invalid_invite' } };
    }
    inv.used = true;
    const a = { id: `ph-${++st.seq}`, email, password: body.password, display_name: name, must_change: false };
    st.accounts.push(a);
    const t = tok();
    st.sessions.set(t, a.id);
    return { status: 201, body: { token: t, photographer: { id: a.id, display_name: name }, must_change_password: false } };
  }

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/api/photographer/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      st.calls.push({ method: req.method(), path: u.pathname, auth: h['authorization'] || null, body: req.postData() || null });
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const res = handle(req.method(), u.pathname, h['authorization'] || null, req.postData());
      route.fulfill({
        status: res.status || 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'private, no-store' },
        body: JSON.stringify(res.body),
      });
    });
  };
  return { st, attach, gate, accountOf };
}

// r2_designer/index.html needs fabric.js only to boot, and it comes from a CDN the sandbox cannot reach (suite 25 does the same).
export const stubFabric = page => page.route('**/fabric.min.js', r => r.fulfill({ contentType: 'text/javascript',
  body: 'const P = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : P()), apply: () => P(), construct: () => P() }); window.fabric = P();' }));
