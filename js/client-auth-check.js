// client-auth-check.js
// Handles dual-mode auth: PHOTOGRAPHER_TOKEN (admin) or client_session (client)
(function () {
  const WORKER_URL = typeof CONFIG !== 'undefined' ? CONFIG.WORKER_URL : 'https://imagepicker.hotichen.workers.dev';

  // Safari in private mode, and any browser set to block site data, throws on
  // sessionStorage access rather than returning null. Uncaught, that killed
  // startup and left a page with no login prompt and no way forward.
  const store = {
    get(key) {
      try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
    },
    set(key, value) {
      try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { sessionStorage.removeItem(key); } catch (e) { /* nothing to clear */ }
    },
  };

  // Clearing sessionStorage by hand in the console was the only way out of an
  // admin session, which matters most when the token turns out to be wrong:
  // this page stores whatever is typed without checking it, so the first sign
  // of a typo is every tile failing.
  function addStudioLogout() {
    const host = document.querySelector('.header-actions, header') || document.body;
    const btn = document.createElement('button');
    btn.id = 'studio-logout';
    btn.className = 'btn btn-outline';
    btn.textContent = '登出';
    btn.addEventListener('click', function () {
      store.remove('studio_token');
      if (typeof CONFIG !== 'undefined') CONFIG.PHOTOGRAPHER_TOKEN = '';
      location.reload();
    });
    host.appendChild(btn);
  }

  function getClientSession() {
    try { return JSON.parse(store.get('client_session') || 'null'); } catch { return null; }
  }

  function getStudioToken() {
    return store.get('studio_token');
  }

  document.addEventListener('DOMContentLoaded', function () {
    const clientSession = getClientSession();
    const studioToken = getStudioToken();

    if (clientSession && clientSession.token) {
      // ── Client mode ──────────────────────────────────────────────────────
      applyClientRestrictions(clientSession);
    } else if (studioToken) {
      // ── Admin mode: restore token to CONFIG (auth.js no longer loaded) ───
      if (typeof CONFIG !== 'undefined') CONFIG.PHOTOGRAPHER_TOKEN = studioToken;
      addStudioLogout();
      return;
    } else {
      // ── No auth: show choice overlay ─────────────────────────────────────
      showChoiceOverlay();
    }
  });

  function findFolderInput() {
    return document.getElementById('folderPath') || document.getElementById('folder-path') ||
      document.querySelector('input[type="text"][placeholder*="料夾"]') ||
      document.querySelector('input[type="text"][placeholder*="folder"]');
  }

  function applyClientRestrictions(session) {
    const { user, permissions } = session;

    // Lock the path box. What goes in it is settled by the mint below, not by
    // the folder_path in this session: that was snapshotted at login and an
    // admin may have narrowed the account since, and it is whatever they typed
    // — `20260819` without the slash is a prefix the Worker refuses, because
    // it would also reach 20260819-other/.
    const folderInput = findFolderInput();
    if (folderInput) {
      folderInput.readOnly = true;
      folderInput.style.opacity = '0.7';
      folderInput.style.cursor = 'not-allowed';
    }

    // A client has no use for these and cannot use them either: both pages
    // accept only the photographer's credential, so clicking one asked a
    // client for a password that is not theirs to have. Hiding beats a
    // disabled button or a hover note — neither stops someone trying.
    ['uploadPageBtn', 'openBookEditorBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });

    // Show client info bar
    const clientBar = document.createElement('div');
    clientBar.id = 'client-bar';
    clientBar.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:#1d1a14', 'border-top:1px solid #3a3528',
      'padding:8px 20px', 'display:flex', 'align-items:center', 'gap:12px',
      'z-index:1000', 'font-family:"IBM Plex Sans",sans-serif', 'font-size:12px',
      'color:#8c8375'
    ].join(';');
    clientBar.innerHTML = `
      <span style="color:#e8e3da;font-weight:500;">${escHtml(user.name || user.email)}</span>
      <span>·</span>
      <span id="client-scope">讀取權限中…</span>
      <span style="flex:1"></span>
      <button id="client-logout" style="background:transparent;border:1px solid #3a3528;color:#8c8375;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;">登出</button>
    `;
    document.body.appendChild(clientBar);

    // The mint is what actually decides what this account can see. Until it
    // answers, the only honest label is that we are still asking — the old one
    // read an unset folder_path as 所有資料夾 and told a client with no folder
    // at all that they had the whole bucket.
    if (window.SessionToken) window.SessionToken.ensure().then(applyScope, applyScope);

    document.getElementById('client-logout').addEventListener('click', function () {
      const token = session.token;
      if (token) {
        fetch(WORKER_URL + '/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token }
        }).catch(() => {});
      }
      store.remove('client_session');
      window.location.href = 'client-login.html';
    });

    // Hide nav links based on permissions
    if (!permissions.can_book) {
      // Hide book editor link
      document.querySelectorAll('a[href*="book_editor"], button[id*="book"], [id*="openBook"], [id*="book-editor"], [data-page*="book"]').forEach(el => {
        el.style.display = 'none';
      });
    }
    if (!permissions.can_upload) {
      // Hide upload link
      document.querySelectorAll('a[href*="upload"], button[id*="upload"], [id*="uploadPage"]').forEach(el => {
        el.style.display = 'none';
      });
    }
  }

  // Called once the trade for a URL-carryable token has settled, whichever way
  // it went. Three outcomes, three different things the client needs from us.
  function applyScope() {
    const T = window.SessionToken;
    if (!T) return;
    const scopeEl = document.getElementById('client-scope');

    // 401 — the session is dead or unknown, and nothing on this page fixes
    // that. It is cleared on the way out, or client-login.html reads it back
    // and sends them straight here again.
    if (T.expired) {
      store.remove('client_session');
      window.location.href = 'client-login.html';
      return;
    }

    // 403 — an account state only the photographer can change. Terminal, so
    // no spinner and no empty grid: the Worker's own wording is the only
    // reading a human can act on.
    if (T.error) {
      if (scopeEl) {
        scopeEl.textContent = T.error;
        scopeEl.style.color = '#e05c5c';
      }
      showBlockedNotice(T.error);
      return;
    }

    const folder = T.folders[0] || '';
    if (!folder) return;
    if (scopeEl) scopeEl.textContent = folder;
    const folderInput = findFolderInput();
    if (folderInput) folderInput.value = folder;
    if (typeof CONFIG !== 'undefined') CONFIG.DEFAULT_FOLDER = folder;
  }

  function showBlockedNotice(message) {
    const empty = document.getElementById('emptyState');
    if (!empty) return;
    const h2 = empty.querySelector('h2');
    const p = empty.querySelector('p');
    if (h2) h2.textContent = '目前無法開啟相簿';
    if (p) p.textContent = message;
    empty.style.display = '';
  }

  function showChoiceOverlay() {
    // Remove old auth overlay if auth.js created one
    const old = document.getElementById('auth-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:#15120d',
      'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:99999', 'font-family:"IBM Plex Sans",sans-serif'
    ].join(';');
    overlay.innerHTML = `
      <div style="background:#1d1a14;border:1px solid #3a3528;border-radius:8px;padding:40px 32px;width:340px;text-align:center;">
        <div style="color:#e5a448;font-size:13px;letter-spacing:0.15em;font-family:'IBM Plex Mono',monospace;margin-bottom:4px;">STUDIO</div>
        <div style="color:#8c8375;font-size:12px;margin-bottom:28px;">請選擇登入方式</div>
        <button id="choice-client" style="width:100%;background:#e5a448;color:#15120d;border:none;padding:11px;border-radius:4px;font-size:14px;cursor:pointer;font-weight:600;margin-bottom:10px;font-family:inherit;">
          客戶登入
        </button>
        <button id="choice-photographer" style="width:100%;background:transparent;color:#8c8375;border:1px solid #3a3528;padding:10px;border-radius:4px;font-size:14px;cursor:pointer;font-family:inherit;">
          攝影師登入
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('choice-client').addEventListener('click', function () {
      window.location.href = 'client-login.html';
    });

    document.getElementById('choice-photographer').addEventListener('click', function () {
      overlay.remove();
      showPhotographerInput();
    });
  }

  function showPhotographerInput() {
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
        <div style="color:#8c8375;font-size:12px;margin-bottom:28px;">輸入攝影師密碼</div>
        <input id="auth-input" type="password" placeholder="密碼"
          style="width:100%;box-sizing:border-box;background:#221f18;border:1px solid #3a3528;color:#e8e3da;padding:10px 12px;border-radius:4px;font-size:14px;outline:none;font-family:inherit;">
        <button id="auth-btn"
          style="margin-top:10px;width:100%;background:#e5a448;color:#15120d;border:none;padding:10px;border-radius:4px;font-size:14px;cursor:pointer;font-weight:600;letter-spacing:0.05em;font-family:inherit;">
          進入
        </button>
        <div id="auth-err" style="color:#e05c5c;font-size:12px;margin-top:10px;min-height:16px;"></div>
        <button onclick="document.getElementById('auth-overlay').remove();window.location.reload();"
          style="margin-top:8px;background:transparent;border:none;color:#8c8375;font-size:11px;cursor:pointer;font-family:inherit;">← 返回</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('auth-input');
    const btn = document.getElementById('auth-btn');
    const err = document.getElementById('auth-err');

    function tryLogin() {
      const val = input.value.trim();
      if (!val) { err.textContent = '請輸入密碼'; return; }
      // if storage is blocked the password still works for this page view,
      // it just won't survive a reload — better than refusing to log in
      store.set('studio_token', val);
      if (typeof CONFIG !== 'undefined') CONFIG.PHOTOGRAPHER_TOKEN = val;
      overlay.remove();
    }

    btn.addEventListener('click', tryLogin);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
    setTimeout(() => input.focus(), 50);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
