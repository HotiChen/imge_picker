(function () {
    const STORAGE_KEY = 'studio_token';

    function getToken() {
        return sessionStorage.getItem(STORAGE_KEY) || '';
    }

    // A bright page says so with <html data-studio-light> (today only upload.html);
    // every other page that loads this file keeps the dark overlay — that includes
    // book_editor/index.html and r2_designer, which are still dark pages. Colours
    // only — the form, the request and the storage are the same either way.
    const PALETTE = {
        dark:  { ground: '#15120d', card: '#1d1a14', border: '#3a3528', brand: '#e5a448', sub: '#8c8375',
                 field: '#221f18', text: '#e8e3da', btn: '#e5a448', btnText: '#15120d', err: '#e05c5c', radius: '4px', cardRadius: '8px', shadow: 'none' },
        light: { ground: '#fff8ee', card: '#ffffff', border: '#efe6d8', brand: '#f5a13b', sub: '#7a6d5d',
                 field: '#fff8ee', text: '#231b12', btn: '#f5a13b', btnText: '#231b12', err: '#c0392b', radius: '8px', cardRadius: '14px', shadow: '0 2px 10px rgba(90,60,20,.06)' },
    };
    const theme = () => (document.documentElement.hasAttribute('data-studio-light') ? PALETTE.light : PALETTE.dark);

    const FIELD_STYLE = T => `width:100%;box-sizing:border-box;background:${T.field};border:1px solid ${T.border};color:${T.text};padding:10px 12px;border-radius:${T.radius};font-size:14px;outline:none;font-family:inherit;`;
    const LINK_STYLE = T => `display:block;margin:10px auto 0;min-height:44px;padding:0 8px;background:none;border:none;color:${T.sub};font-size:12px;font-family:inherit;text-decoration:underline;cursor:pointer;`;
    const LOGIN_ERRORS = {
        login_failed: '帳號或密碼不正確，或帳號尚未開通',
        too_many_attempts: '嘗試次數太多，請 15 分鐘後再試',
        photographers_unavailable: '帳號登入功能尚未啟用',
    };

    function showLoginOverlay() {
        const T = theme();
        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', `background:${T.ground}`,
            'display:flex', 'align-items:center', 'justify-content:center',
            'z-index:99999', 'font-family:"IBM Plex Sans",sans-serif'
        ].join(';');

        overlay.innerHTML = `
            <div style="background:${T.card};border:1px solid ${T.border};border-radius:${T.cardRadius};box-shadow:${T.shadow};padding:40px 32px;width:320px;text-align:center;">
                <div style="color:${T.brand};font-size:13px;letter-spacing:0.15em;font-family:'IBM Plex Mono',monospace;margin-bottom:4px;">STUDIO</div>
                <div id="auth-token-pane">
                    <div style="color:${T.sub};font-size:12px;margin-bottom:28px;">輸入存取密碼以繼續</div>
                    <input id="auth-input" type="password" placeholder="密碼"
                        style="width:100%;box-sizing:border-box;background:${T.field};border:1px solid ${T.border};color:${T.text};padding:10px 12px;border-radius:${T.radius};font-size:14px;outline:none;font-family:inherit;">
                    <button id="auth-btn"
                        style="margin-top:10px;width:100%;background:${T.btn};color:${T.btnText};border:none;padding:10px;border-radius:${T.radius};font-size:14px;cursor:pointer;font-weight:600;letter-spacing:0.05em;">
                        進入
                    </button>
                    <button id="auth-mode-email" type="button" style="${LINK_STYLE(T)}">改用 Email 登入</button>
                </div>
                <div id="auth-email-pane" hidden>
                    <div style="color:${T.sub};font-size:12px;margin-bottom:28px;">用 Email 和密碼登入</div>
                    <input id="auth-email" type="email" placeholder="Email" autocomplete="username" autocapitalize="none" spellcheck="false" inputmode="email"
                        style="${FIELD_STYLE(T)}margin-bottom:10px;">
                    <input id="auth-pw" type="password" placeholder="密碼" autocomplete="current-password"
                        style="${FIELD_STYLE(T)}">
                    <button id="auth-email-btn"
                        style="margin-top:10px;width:100%;background:${T.btn};color:${T.btnText};border:none;padding:10px;border-radius:${T.radius};font-size:14px;cursor:pointer;font-weight:600;letter-spacing:0.05em;">
                        登入
                    </button>
                    <button id="auth-mode-token" type="button" style="${LINK_STYLE(T)}">改用存取密碼</button>
                </div>
                <div id="auth-err" style="color:${T.err};font-size:12px;margin-top:10px;min-height:16px;"></div>
            </div>
        `;

        document.body.appendChild(overlay);

        const input = document.getElementById('auth-input');
        PasswordToggle.attach(input, { color: T.sub });
        const btn = document.getElementById('auth-btn');
        const err = document.getElementById('auth-err');

        async function tryLogin() {
            const val = input.value.trim();
            if (!val) { showError('請輸入密碼'); return; }
            btn.disabled = true;
            btn.textContent = '驗證中…';
            try {
                const workerBase = (typeof CONFIG !== 'undefined' && CONFIG.WORKER_URL) || 'https://imagepicker.hotichen.workers.dev';
                const res = await fetch(`${workerBase}/api/auth/verify-admin`, {
                    headers: { 'Authorization': `Bearer ${val}` }
                });
                if (!res.ok) {
                    showError('密碼不正確，請重試');
                    btn.disabled = false;
                    btn.textContent = '進入';
                    return;
                }
            } catch (e) {
                // network error — let them in anyway
            }
            sessionStorage.setItem(STORAGE_KEY, val);
            CONFIG.PHOTOGRAPHER_TOKEN = val;
            overlay.remove();
        }

        function showError(msg) {
            err.textContent = msg || '請輸入密碼';
            input.style.borderColor = T.err;
            setTimeout(() => { input.style.borderColor = T.border; err.textContent = ''; }, 2000);
        }

        btn.addEventListener('click', () => tryLogin());
        input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

        // email + password (a photographer account); the stored result is the same studio_token
        const tokenPane = document.getElementById('auth-token-pane');
        const emailPane = document.getElementById('auth-email-pane');
        const emailIn = document.getElementById('auth-email');
        const pwIn = document.getElementById('auth-pw');
        const emailBtn = document.getElementById('auth-email-btn');
        PasswordToggle.attach(pwIn, { color: T.sub });
        function showMode(email) {
            tokenPane.hidden = email; emailPane.hidden = !email;
            err.textContent = '';
            (email ? emailIn : input).focus();
        }
        async function tryEmailLogin() {
            const email = emailIn.value.trim();
            const password = pwIn.value;
            if (!email || !password) { err.textContent = '請輸入 Email 和密碼'; return; }
            err.textContent = '';
            emailBtn.disabled = true;
            try {
                const workerBase = (typeof CONFIG !== 'undefined' && CONFIG.WORKER_URL) || 'https://imagepicker.hotichen.workers.dev';
                const res = await fetch(`${workerBase}/api/photographer/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || typeof data.token !== 'string' || !data.token) {
                    err.textContent = LOGIN_ERRORS[data && data.code] || (res.status === 429 ? LOGIN_ERRORS.too_many_attempts : `登入失敗（${res.status}）`);
                    return;
                }
                const must = data.must_change_password === true;
                PhotographerSession.store(data.token, { mustChange: must });
                if (must) { window.location.href = PhotographerSession.settingsUrl(); return; }
                CONFIG.PHOTOGRAPHER_TOKEN = data.token;
                overlay.remove();
            } catch (e) {
                err.textContent = '無法連線到 Worker';
            } finally {
                emailBtn.disabled = false;
            }
        }
        document.getElementById('auth-mode-email').addEventListener('click', () => showMode(true));
        document.getElementById('auth-mode-token').addEventListener('click', () => showMode(false));
        emailBtn.addEventListener('click', tryEmailLogin);
        [emailIn, pwIn].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') tryEmailLogin(); }));
        setTimeout(() => input.focus(), 50);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const token = getToken();
        if (token) {
            CONFIG.PHOTOGRAPHER_TOKEN = token;
        } else {
            showLoginOverlay();
        }
    });
})();
