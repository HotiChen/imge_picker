// Shared studio side menu — dashboard.html, settings.html and admin.html all
// render the same list from here, so adding or renaming a destination is one
// change instead of three. `render` only builds markup and wires clicks; it
// never touches sessionStorage or does the redirect itself, that stays with
// whichever page calls it (admin.html's existing logout button already has
// its own view-toggling logout, dashboard.html/settings.html just clear the
// token and leave for home.html).
(function () {
  const ITEMS = [
    { key: 'dashboard', label: '儀表板', href: 'dashboard.html' },
    { key: 'projects', label: '選片專案', href: 'admin.html#projects' },
    { key: 'orders', label: '訂單', href: 'orders.html' },
    { key: 'clients', label: '客戶', href: 'admin.html#clients' },
    { key: 'pick', label: '選圖', href: 'index.html' },
    { key: 'upload', label: '上傳', href: 'upload.html' },
    { key: 'book', label: '相本', href: 'book_editor/' },
    { key: 'settings', label: '設定', href: 'settings.html' },
  ];

  // activeKey: which ITEMS.key is "current page" (gets .active). onLogout:
  // called when the 登出 item is clicked — the page decides what that means.
  function render(container, activeKey, onLogout) {
    if (!container) return;
    container.innerHTML = `
      <div class="side-nav-brand mono">STUDIO</div>
      <nav class="side-nav-list">
        ${ITEMS.map(i => `<a class="side-nav-item${i.key === activeKey ? ' active' : ''}"
            href="${escHtml(i.href)}" data-nav="${escHtml(i.key)}">${escHtml(i.label)}</a>`).join('')}
        <button type="button" class="side-nav-item side-nav-logout" data-nav="logout">登出</button>
      </nav>`;
    const logoutBtn = container.querySelector('.side-nav-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', () => { if (typeof onLogout === 'function') onLogout(); });
  }

  // The plain-page logout dashboard.html/settings.html share: no login-view
  // to flip back to here, so leaving the token behind just means home.html's
  // login overlay asks again.
  function logoutToHome() {
    try { sessionStorage.removeItem('studio_token'); } catch (e) { /* best effort */ }
    window.location.href = 'home.html';
  }

  // Gate for a page that only makes sense signed in: no token at all → away
  // before anything else runs. A token that turns out to be stale is caught
  // separately, by the page's own fetch getting back a 401.
  function requireToken() {
    let token = '';
    try { token = sessionStorage.getItem('studio_token') || ''; } catch (e) { /* none */ }
    if (!token) { window.location.href = 'home.html'; return ''; }
    return token;
  }

  window.SideNav = { ITEMS, render, logoutToHome, requireToken };
})();
