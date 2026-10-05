// Shared helpers for the studio pages. A plain script (no module): it defines
// window.escHtml and window.Util, and must load BEFORE side-nav.js,
// orders-common.js, client-auth-check.js and any inline script that calls escHtml.
(function () {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  // Escape for HTML text AND attribute contexts. null / undefined → ''; anything
  // else goes through String() (so 0 stays "0": a count or rating is not blank).
  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, c => MAP[c]);
  }

  window.escHtml = escHtml;
  window.Util = { escHtml };
})();
