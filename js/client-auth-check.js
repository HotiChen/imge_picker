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
    // .header-right is the top bar beside 上傳 / 相本書 / the avatar.
    // .header-actions is the row above the grid — 全選 / 下載 — where this
    // button was landing among the download controls and going unnoticed.
    const host = document.querySelector('.header-right') || document.body;
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

  // The four query params the app already gives meaning to on this page
  // (js/pick.js `?t=`, js/app.js checkUrlParams `?folder=`/`?id=`,
  // js/project-view.js `?project=`). Any of them picks a mode on its own,
  // with or without a stored session, so none of them should ever bounce to
  // home.html — only a truly bare visit does.
  function hasModeParam() {
    const params = new URLSearchParams(location.search);
    return ['t', 'folder', 'id', 'project'].some(key => !!params.get(key));
  }

  // ── folder switcher: every folder this client's token opens, listed in the
  // left 資料夾 panel (docs/guest-picking.md — the same panel js/pick.js uses
  // for guests, and the same one app.js normally fills with the subfolder
  // tree of whichever folder is loaded). Populated once the mint answers
  // (applyScope), and re-rendered after every later load — including one a
  // client reaches by drilling into a subfolder from the photo grid — so it
  // is never lost to app.js's own tree render, which targets this same
  // container.
  let permittedFolders = [];

  function renderFolderPanel(current) {
    const container = document.getElementById('folderTreeContainer');
    const list = document.getElementById('folderTree');
    if (!container || !list) return;
    if (!permittedFolders.length) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    list.innerHTML = '';
    permittedFolders.forEach(f => {
      const row = document.createElement('div');
      row.className = 'tree-row' + (f === current ? ' tree-active' : '');
      row.dataset.folder = f;
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = '📁';
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = f.replace(/\/$/, '').split('/').pop() || f;
      label.title = f;
      row.appendChild(icon);
      row.appendChild(label);
      row.addEventListener('click', () => selectFolder(f));
      list.appendChild(row);
    });
    const scopeEl = document.getElementById('client-scope');
    if (scopeEl) scopeEl.textContent = current || '';
  }

  function selectFolder(folder) {
    if (!folder) return;
    if (typeof CONFIG !== 'undefined') CONFIG.DEFAULT_FOLDER = folder;
    if (window.app && typeof app.handleLoadPhotos === 'function') app.handleLoadPhotos(folder);
  }

  // Wrapped once app exists, mirroring js/pick.js's own hook on the same
  // method: every load repaints this list with the newly current folder
  // highlighted, whether the load was triggered by clicking a row here, by
  // app.js's own initial scope()-driven load, or by drilling into a subfolder
  // from the grid.
  function wireFolderPanelRerender() {
    if (!window.app || app.__folderPanelWired) return;
    app.__folderPanelWired = true;
    const orig = app.handleLoadPhotos.bind(app);
    app.handleLoadPhotos = async (path) => {
      await orig(path);
      renderFolderPanel(driveManager.currentFolderId || path);
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    // A pick link (index.html?t=...) owns the page — see js/pick.js. Neither
    // the studio/client choice overlay nor a stray studio_token in this same
    // browser has anything to do with a guest opening it from LINE.
    if (window.PickController && window.PickController.active) return;

    const clientSession = getClientSession();
    const studioToken = getStudioToken();

    if (clientSession && clientSession.token) {
      // ── Client mode ──────────────────────────────────────────────────────
      applyClientRestrictions(clientSession);
    } else if (studioToken) {
      // ── Admin mode: restore token to CONFIG (auth.js no longer loaded) ───
      if (typeof CONFIG !== 'undefined') CONFIG.PHOTOGRAPHER_TOKEN = studioToken;
      // imhoti.tw/studio/ itself lands on the dashboard. Only the directory
      // URL: the side menu's 選圖 and upload's 回選圖 link index.html by name
      // and must still open this workspace.
      if (location.pathname.endsWith('/') && !hasModeParam()) {
        window.location.href = 'dashboard.html';
        return;
      }
      addStudioLogout();
      return;
    } else if (!hasModeParam()) {
      // ── Root entrance, no auth, no mode: this is imhoti.tw/studio/ opened
      // cold — send it to the marketing/login page instead of the studio/
      // client choice overlay. Any recognised param, or a session, keeps the
      // overlay exactly as before (checked above and by hasModeParam()).
      window.location.href = 'home.html';
    } else {
      // ── No auth, but a recognised param owns the page: show choice overlay
      showChoiceOverlay();
    }
  });

  function applyClientRestrictions(session) {
    const { user, permissions } = session;

    // Remove the path box and LOAD button outright, not merely lock them: a
    // client has nothing to type there (what loads is settled by the mint
    // below, via the left 資料夾 panel, not by the folder_path in this
    // session, which was snapshotted at login and may since have been
    // narrowed), and a read-only box still looks like a control worth trying.
    // Removed rather than hidden for the same reason uploadPageBtn /
    // openBookEditorBtn below are: .btn carries display:inline-flex, which
    // beats the UA stylesheet's [hidden] { display: none }.
    document.querySelector('.sidebar-section:first-child .input-group')?.remove();

    // A client has no use for these and cannot use them either: both pages
    // accept only the photographer's credential, so clicking one asked a
    // client for a password that is not theirs to have. Hiding beats a
    // disabled button or a hover note — neither stops someone trying.
    // Removed, not hidden: .btn carries display:inline-flex, and an author
    // rule beats the UA stylesheet's [hidden] { display: none }, so setting
    // the attribute left both buttons on screen and looking clickable.
    ['uploadPageBtn', 'openBookEditorBtn'].forEach(id => {
      document.getElementById(id)?.remove();
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

    const folders = Array.isArray(T.folders) ? T.folders.filter(Boolean) : [];
    if (!folders.length) return;

    // The token opens all of them. Showing only the first leaves the client no
    // way to learn the rest exist, which is worse than showing none: they
    // cannot even ask about what they cannot see. Switching now lives in the
    // left 資料夾 panel (renderFolderPanel) rather than a bottom-bar chip row;
    // this bar just names where the client currently is.
    permittedFolders = folders;
    if (typeof CONFIG !== 'undefined') CONFIG.DEFAULT_FOLDER = folders[0];
    wireFolderPanelRerender();
    renderFolderPanel(folders[0]);
    if (scopeEl) scopeEl.textContent = folders[0];
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
