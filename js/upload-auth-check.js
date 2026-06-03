// upload-auth-check.js
// Redirects to index.html if client doesn't have can_upload permission
(function () {
  const studioToken = sessionStorage.getItem('studio_token') || '';
  if (studioToken) return; // Photographer has full access

  const raw = sessionStorage.getItem('client_session');
  if (!raw) {
    window.location.href = 'client-login.html';
    return;
  }
  try {
    const session = JSON.parse(raw);
    if (!session || !session.token) {
      window.location.href = 'client-login.html';
      return;
    }
    if (!session.permissions || !session.permissions.can_upload) {
      window.location.href = 'index.html?error=' + encodeURIComponent('您沒有上傳權限，請聯繫攝影師');
      return;
    }
    // Has permission — set folder restriction
    if (session.user && session.user.folder_path && typeof CONFIG !== 'undefined') {
      CONFIG.DEFAULT_FOLDER = session.user.folder_path;
    }
  } catch (e) {
    sessionStorage.removeItem('client_session');
    window.location.href = 'client-login.html';
  }
})();
