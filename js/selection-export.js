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

  const api = { selectionsToCsv, pinsText, csvCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SelectionExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
