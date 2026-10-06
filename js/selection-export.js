// 下載需求表 (CSV): what the retoucher needs per picked photo — the file name,
// the client's note and the retouch pins ("標示"). Pure functions, no DOM, so
// they unit-test in node as well as run in admin.html.
//
//   selectionsToCsv(selected) → string, starting with a UTF-8 BOM so Excel
//   opens Traditional Chinese correctly. `selected` is the project detail's
//   selections (already filtered to the picked ones): {photo_key, note,
//   marks: [{x, y, note}] | null}.
(function (root) {
  const BOM = String.fromCharCode(0xFEFF); // UTF-8 byte order mark, as an escape: an invisible literal is too easy to lose
  const HEADER = ['檔名', '備註', '標示'];

  // ① … ⑳ are U+2460 … U+2473; a photo holds at most 10 pins today, but past
  // 20 a plain (n) keeps the numbering unambiguous rather than inventing glyphs.
  function circled(n) {
    return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
  }

  // "①文字 ②文字": one entry per pin, in order. A pin without text still
  // takes its number, so the retoucher knows a mark exists there.
  function pinsText(marks) {
    if (!Array.isArray(marks)) return '';
    return marks.map((m, i) => `${circled(i + 1)}${m && typeof m.note === 'string' ? m.note : ''}`).join(' ');
  }

  // One CSV cell. Guest text goes through here, so a cell starting with a
  // character a spreadsheet reads as a formula (= + - @, and tab / CR) gets a
  // leading ' — checked BEFORE quoting, since the quote would hide the lead.
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function selectionsToCsv(selected) {
    const rows = (Array.isArray(selected) ? selected : []).map(s =>
      [s.photo_key, s.note, pinsText(s.marks)].map(csvCell).join(','));
    return BOM + [HEADER.map(csvCell).join(',')].concat(rows).join('\r\n') + '\r\n';
  }

  // 下載此輪需求表: one pins round of revision requests on the delivered finals
  // (docs/revision-pins.md 6.2). `round` is a GET /api/admin/projects/:id
  // revision_requests row: {marks: {photo_key: [{x, y, note}]} | null, message,
  // message_auto}. One row per pin: file name (the last path segment of the key),
  // pin number, x / y as the stored 0-1 fractions of the photo, the pin's note.
  // 總說明 is the client's own overall note, on the first row only; a
  // message_auto round has none (its `message` is the Worker's fixed string).
  // Every cell goes through csvCell, so guest text cannot start a formula.
  const REVISION_HEADER = ['檔名', '標示', 'x', 'y', '備註', '總說明'];
  function revisionToCsv(round) {
    const marks = round && round.marks && typeof round.marks === 'object' && !Array.isArray(round.marks) ? round.marks : {};
    const overall = round && !round.message_auto && typeof round.message === 'string' ? round.message : '';
    const rows = [];
    Object.keys(marks).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).forEach(key => {
      const name = key.slice(key.lastIndexOf('/') + 1);
      (Array.isArray(marks[key]) ? marks[key] : []).forEach((m, i) => {
        if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        rows.push([name, i + 1, m.x, m.y, typeof m.note === 'string' ? m.note : '', rows.length === 0 ? overall : ''].map(csvCell).join(','));
      });
    });
    return BOM + [REVISION_HEADER.map(csvCell).join(',')].concat(rows).join('\r\n') + '\r\n';
  }

  const api = { selectionsToCsv, revisionToCsv, pinsText, csvCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SelectionExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
