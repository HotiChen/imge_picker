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
//   Util.LINK_MESSAGE_DEFAULTS / Util.linkMessage(stage, settings, title, link)   the same per project stage
//   Util.groupByCategory(products)  [{name: string|null, items}]: the catalogue grouped by product.category
//                            (data, shown with textContent / escHtml only); groups ordered by the smallest `sort`
//                            of their members (a list with no sort: by first appearance), 未分類 (name null) last,
//                            every group's items in the order they came
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
  function fillLinkMessage(t, title, link) {
    const out = t.split(/(\{專案名稱\}|\{連結\})/).map(part => part === '{專案名稱}' ? String(title == null ? '' : title) : part === '{連結}' ? String(link == null ? '' : link) : part).join('');
    return t.includes('{連結}') ? out : out + '\n' + String(link == null ? '' : link);
  }
  function pickLinkMessage(template, title, link) {
    return fillLinkMessage(typeof template === 'string' && template.trim() ? template : PICK_LINK_DEFAULT, title, link);
  }
  // The message per project stage (複製連結 in admin.html, four blocks in settings.html): pick = 選片中, submitted = 已送出 /
  // 精修中, delivered = 已交件 (not yet confirmed), done = 已完成. Same placeholders and rules as pickLinkMessage.
  const LINK_MESSAGE_DEFAULTS = {
    pick: PICK_LINK_DEFAULT,
    submitted: '{專案名稱} 的選片我收到囉 😊\n我會開始精修，完成後會再通知你。\n\n你也可以從這個連結看目前的狀態：\n{連結}',
    delivered: '{專案名稱} 的精修照片完成囉 ✨\n{連結}\n\n請點開連結看看，有想調整的地方可以在照片上標記並送出修改；都沒問題的話，請按「確認完成」。',
    done: '謝謝你的信任 🙏\n這是 {專案名稱} 的完成頁，可以回顧精修照片，也能看相簿和商品資訊：\n{連結}',
  };
  const LINK_MESSAGE_FIELDS = { pick: 'pick_link_message', submitted: 'link_message_submitted', delivered: 'link_message_delivered', done: 'link_message_done' };
  function linkMessage(stage, settings, title, link) {
    const def = LINK_MESSAGE_DEFAULTS[stage] || PICK_LINK_DEFAULT;
    const v = settings && LINK_MESSAGE_FIELDS[stage] ? settings[LINK_MESSAGE_FIELDS[stage]] : null;
    return fillLinkMessage(typeof v === 'string' && v.trim() ? v : def, title, link);
  }

  // product.category: a trimmed non-empty string, else null (= 未分類)
  const catOf = p => (p && typeof p.category === 'string' && p.category.trim() ? p.category.trim() : null);
  function groupByCategory(products) {
    const list = Array.isArray(products) ? products : [];
    const groups = new Map();   // name|null -> {name, items, rank}
    list.forEach((p, i) => {
      const name = catOf(p);
      const rank = p && Number.isFinite(p.sort) ? p.sort : i;
      let g = groups.get(name);
      if (!g) { g = { name, items: [], rank }; groups.set(name, g); }
      if (rank < g.rank) g.rank = rank;
      g.items.push(p);
    });
    const named = [...groups.values()].filter(g => g.name !== null).sort((a, b) => a.rank - b.rank);   // stable: ties keep first appearance
    const rest = groups.get(null);
    return (rest ? [...named, rest] : named).map(g => ({ name: g.name, items: g.items }));
  }

  window.escHtml = escHtml;
  window.Util = { groupByCategory, escHtml, fmtDate, todayTaipei, formatPrice, PICK_LINK_DEFAULT, pickLinkMessage, LINK_MESSAGE_DEFAULTS, linkMessage };
})();
