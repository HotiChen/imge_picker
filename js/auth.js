(function () {
    const STORAGE_KEY = 'studio_token';

    function getToken() {
        return sessionStorage.getItem(STORAGE_KEY) || '';
    }

    function showLoginOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'background:#15120d',
            'display:flex', 'align-items:center', 'justify-content:center',
            'z-index:99999', 'font-family:"IBM Plex Sans",sans-serif'
        ].join(';');

        overlay.innerHTML = `
            <div style="background:#1d1a14;border:1px solid #3a3528;border-radius:8px;padding:40px 32px;width:320px;text-align:center;">
                <div style="color:#e5a448;font-size:13px;letter-spacing:0.15em;font-family:'IBM Plex Mono',monospace;margin-bottom:4px;">STUDIO</div>
                <div style="color:#8c8375;font-size:12px;margin-bottom:28px;">輸入存取密碼以繼續</div>
                <input id="auth-input" type="password" placeholder="密碼"
                    style="width:100%;box-sizing:border-box;background:#221f18;border:1px solid #3a3528;color:#e8e3da;padding:10px 12px;border-radius:4px;font-size:14px;outline:none;font-family:inherit;">
                <button id="auth-btn"
                    style="margin-top:10px;width:100%;background:#e5a448;color:#15120d;border:none;padding:10px;border-radius:4px;font-size:14px;cursor:pointer;font-weight:600;letter-spacing:0.05em;">
                    進入
                </button>
                <div id="auth-err" style="color:#e05c5c;font-size:12px;margin-top:10px;min-height:16px;"></div>
            </div>
        `;

        document.body.appendChild(overlay);

        const input = document.getElementById('auth-input');
        const btn = document.getElementById('auth-btn');
        const err = document.getElementById('auth-err');

        function tryLogin() {
            const val = input.value.trim();
            if (!val) return;
            sessionStorage.setItem(STORAGE_KEY, val);
            CONFIG.PHOTOGRAPHER_TOKEN = val;
            overlay.remove();
        }

        function showError() {
            err.textContent = '請輸入密碼';
            input.style.borderColor = '#e05c5c';
            setTimeout(() => { input.style.borderColor = '#3a3528'; err.textContent = ''; }, 2000);
        }

        btn.addEventListener('click', () => { input.value.trim() ? tryLogin() : showError(); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
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
