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

    const FIELD_STYLE = T => `width:100%;box-sizing:border-box;min-height:44px;background:${T.field};border:1px solid ${T.border};color:${T.text};padding:10px 12px;border-radius:${T.radius};font-size:16px;outline:none;font-family:inherit;`;

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
                <form id="auth-form" method="post" novalidate>
                    <div style="color:${T.sub};font-size:12px;margin-bottom:28px;">登入攝影師後台</div>
                    <input id="auth-account" type="text" placeholder="帳號" aria-label="帳號" style="${FIELD_STYLE(T)}margin-bottom:10px;">
                    <input id="auth-input" type="password" placeholder="密碼" aria-label="密碼" style="${FIELD_STYLE(T)}">
                    <button id="auth-btn" type="submit"
                        style="margin-top:10px;width:100%;min-height:44px;background:${T.btn};color:${T.btnText};border:none;padding:10px;border-radius:${T.radius};font-size:14px;cursor:pointer;font-weight:600;letter-spacing:0.05em;">
                        登入
                    </button>
                </form>
                <div id="auth-err" style="color:${T.err};font-size:12px;margin-top:10px;min-height:16px;"></div>
            </div>
        `;

        document.body.appendChild(overlay);

        const account = document.getElementById('auth-account');
        const input = document.getElementById('auth-input');   // the 密碼 field
        UnifiedLogin.prepare(account, input);
        PasswordToggle.attach(input, { color: T.sub });
        const btn = document.getElementById('auth-btn');
        const err = document.getElementById('auth-err');

        // one form (js/unified-login.js): `admin` + the studio password is verified against /api/auth/verify-admin
        // (a network error or non-ok answer refuses, nothing stored); anything else is an email + password account login
        async function tryLogin() {
            err.textContent = '';
            btn.disabled = true;
            btn.textContent = '驗證中…';
            try {
                const workerBase = (typeof CONFIG !== 'undefined' && CONFIG.WORKER_URL) || 'https://imagepicker.hotichen.workers.dev';
                const res = await UnifiedLogin.login({
                    account: account.value, password: input.value, workerUrl: workerBase,
                    verifyPath: '/api/auth/verify-admin',
                });
                if (!res.ok) { err.textContent = res.error; return; }
                if (res.kind === 'account' && res.must) { window.location.href = PhotographerSession.settingsUrl(); return; }
                CONFIG.PHOTOGRAPHER_TOKEN = res.token;
                overlay.remove();
            } finally {
                btn.disabled = false;
                btn.textContent = '登入';
            }
        }
        UnifiedLogin.bind(document.getElementById('auth-form'), tryLogin);
        setTimeout(() => account.focus(), 50);
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
