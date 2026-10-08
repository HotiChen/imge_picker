// Shared helpers for the studio pages. A plain script (no module): it defines
// window.escHtml and window.Util, and must load BEFORE side-nav.js,
// orders-common.js, client-auth-check.js, pick.js, project-view.js,
// completion-page.js, app.js and any inline script that calls escHtml / Util.
//   Util.escHtml(v)          HTML-escape for text and attribute contexts
//   Util.fmtDate(v, shape)   a date in Taipei time; v = ISO string / Date / ms, '' when invalid
//                            shapes: 'ymd'  2026/9/21     (zh-TW)
//                                    'md'   9/21          (zh-TW)
//                                    'mdhm' 9/27 22:52    (zh-TW, 24h)
//                                    'iso'  2026-09-21    (en-CA)
//   Util.todayTaipei()       today's Taipei date, YYYY-MM-DD
//   Util.PICK_LINK_DEFAULT / Util.pickLinkMessage(template, title, link)   the pick-link message text
//   Util.formatPrice(n)      NT$5,000 (integer, thousands separators, no space; non-finite → NT$0)
(function () {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  // Escape for HTML text AND attribute contexts. null / undefined → ''; anything
  // else goes through String() (so 0 stays "0": a count or rating is not blank).
  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, c => MAP[c]);
  }

  // The studio's dates are Taipei dates whatever the viewer's clock says.
  const TZ = 'Asia/Taipei';
  const DATE_SHAPES = {
    ymd: ['zh-TW', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }],
    md: ['zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric' }],
    mdhm: ['zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }],
    iso: ['en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }],   // en-CA prints YYYY-MM-DD
  };
  const dateFormatters = {};

  function fmtDate(value, shape) {
    if (!Object.prototype.hasOwnProperty.call(DATE_SHAPES, shape)) return '';
    const d = value ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) return '';
    const f = dateFormatters[shape] || (dateFormatters[shape] = new Intl.DateTimeFormat(...DATE_SHAPES[shape]));
    return f.format(d);
  }

  function todayTaipei() {
    return fmtDate(new Date(), 'iso');
  }

  // NT$1,234 — money is an integer. Math.round; NaN / Infinity / non-numbers read NT$0.
  function formatPrice(n) {
    const v = Number(n);
    return 'NT$' + ((Number.isFinite(v) ? Math.round(v) : 0) || 0).toLocaleString('en-US');
  }

  // The message the photographer sends a client with the pick link (settings 「傳給客人的選片訊息」,
  // admin.html 「傳給客人」 dialog). {專案名稱} = the project title, {連結} = the pick link; plain text, replaced here.
  const PICK_LINK_DEFAULT = '{專案名稱} 的選片連結來囉 😊\n{連結}\n\n麻煩用手機點開連結，慢慢挑喜歡的照片，選好之後按「完成提交」，我就會收到了。\n（請由負責選片的人先打開連結喔）';
  // One pass over the template (split on the two placeholders, never String.replace with a replacement string, so a `$&` in
  // a title stays literal, and a placeholder typed inside a title is not substituted again). A template without {連結} gets the
  // link on a new last line; an empty / whitespace template (or a non-string) means the default.
  function pickLinkMessage(template, title, link) {
    const t = typeof template === 'string' && template.trim() ? template : PICK_LINK_DEFAULT;
    const out = t.split(/(\{專案名稱\}|\{連結\})/).map(part => part === '{專案名稱}' ? String(title == null ? '' : title) : part === '{連結}' ? String(link == null ? '' : link) : part).join('');
    return t.includes('{連結}') ? out : out + '\n' + String(link == null ? '' : link);
  }

  window.escHtml = escHtml;
  window.Util = { escHtml, fmtDate, todayTaipei, formatPrice, PICK_LINK_DEFAULT, pickLinkMessage };
})();
