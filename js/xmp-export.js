// 轉出精挑相片 XMP: Lightroom sidecar files (.xmp) for the photos the client picked,
// so the photographer does not have to re-mark them by hand. Pure functions, no DOM,
// no network, so they unit-test in node as well as run in admin.html.
//
// A selection is {photo_key, rating (1-5 = picked), marks: [{x,y,note}] | null}. Nothing the
// guest typed (note, pin text) ever goes into an XMP: only a star number, a colour name and
// a flag. The Lightroom behaviour of the pick flag (xmpDM:pick) has NOT been checked against
// a real Lightroom; docs/xmp-export.md says so.
(function (root) {
  const BOM = String.fromCharCode(0xFEFF); // the packet header carries a BOM inside begin="…"; as an escape, an invisible literal is too easy to lose
  const LABELS = ['Red', 'Yellow', 'Green', 'Blue', 'Purple']; // the names Lightroom's default colour label set reads
  const LABEL_ZH = { Red: '紅', Yellow: '黃', Green: '綠', Blue: '藍', Purple: '紫' };

  function defaultSettings() {
    // rating follows the client's stars; Green, Red when the photo has pins; no pick flag
    return { rating: 'follow', label: 'Green', labelPins: 'Red', flag: 'off' };
  }

  function normRating(v) {
    if (v === 'off' || v === 'follow') return v;
    const n = typeof v === 'string' && /^[1-5]$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  function normLabel(v) { return LABELS.includes(v) ? v : null; }

  // junk, missing or partial input -> the defaults field by field; never throws
  function normalizeSettings(raw) {
    const d = defaultSettings();
    let r = null;
    try { r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null; } catch (e) { r = null; }
    if (!r) return d;
    let rating = d.rating, label = d.label, labelPins = d.labelPins, flag = d.flag;
    try {
      const nr = normRating(r.rating); if (nr !== null) rating = nr;
      if (r.label === 'off') label = 'off'; else { const nl = normLabel(r.label); if (nl) label = nl; }
      if (r.labelPins === 'same') labelPins = 'same'; else { const np = normLabel(r.labelPins); if (np) labelPins = np; }
      if (r.flag === 'off' || r.flag === 'pick') flag = r.flag;
    } catch (e) { return d; }
    return { rating, label, labelPins, flag };
  }

  function hasPins(sel) { return !!sel && Array.isArray(sel.marks) && sel.marks.length > 0; }

  // the attributes this selection gets, in a fixed order: [['xmp:Rating','4'], …]
  function attrsFor(settings, sel) {
    const s = normalizeSettings(settings);
    const out = [];
    let stars = null;
    if (s.rating === 'follow') stars = sel ? Number(sel.rating) : NaN;
    else if (typeof s.rating === 'number') stars = s.rating;
    if (stars !== null && Number.isInteger(stars) && stars >= 1 && stars <= 5) out.push(['xmp:Rating', String(stars)]);
    if (s.label !== 'off') {
      const colour = hasPins(sel) && s.labelPins !== 'same' ? s.labelPins : s.label;
      out.push(['xmp:Label', colour]);
    }
    if (s.flag === 'pick') out.push(['xmpDM:pick', '1']);
    return out;
  }

  // one sidecar's text, or '' when every setting is off for this photo
  function buildXmp(settings, sel) {
    const attrs = attrsFor(settings, sel);
    if (!attrs.length) return '';
    return [
      `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="imge-picker">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" ' +
        attrs.map(([k, v]) => `${k}="${v}"`).join(' ') + '/>',
      '</rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n') + '\n';
  }

  // "a/b/IMG_001.CR3" -> "IMG_001": last path segment, extension off, nothing a file system or a
  // zip would read as a path or control character. '' when nothing usable is left.
  const NAME_BAD = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2028\\u2029\\ufeff\\\\/:*?"<>|]', 'g');
  function xmpBaseName(key) {
    if (typeof key !== 'string') return '';
    let seg = key.slice(Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\')) + 1);
    const dot = seg.lastIndexOf('.');
    if (dot > 0) seg = seg.slice(0, dot);
    seg = seg.replace(NAME_BAD, '').trim();
    if (/^\.+$/.test(seg)) return '';
    return seg;
  }

  // The export: only rating >= 1 (picked). Two picked photos with the same base name (different
  // folders; compared case-insensitively, as a zip extracts onto Windows / macOS) -> the first
  // is kept, the rest are listed in `collisions`. Not-picked entries are ignored silently.
  function planExport(settings, selected) {
    const files = [], skipped = [], collisions = [];
    const seen = new Map(); // lower-cased base name -> photo_key that holds it
    let pinned = 0;
    for (const sel of Array.isArray(selected) ? selected : []) {
      if (!sel || typeof sel !== 'object' || !(Number(sel.rating) >= 1)) continue;
      const base = xmpBaseName(sel.photo_key);
      if (!base) { skipped.push({ photo_key: sel.photo_key, reason: 'bad_name' }); continue; }
      const text = buildXmp(settings, sel);
      if (!text) continue; // every setting off: nothing to write
      const id = base.toLowerCase();
      if (seen.has(id)) { collisions.push({ photo_key: sel.photo_key, name: `${base}.xmp`, kept: seen.get(id) }); continue; }
      seen.set(id, sel.photo_key);
      files.push({ name: `${base}.xmp`, text, photo_key: sel.photo_key, pins: hasPins(sel) });
      if (hasPins(sel)) pinned++;
    }
    return { files, skipped, collisions, pinned };
  }

  function readme() {
    return [
      '轉出精挑相片 XMP 說明',
      '====================',
      '',
      '這個 zip 裡的每個 .xmp 檔，對應客人挑的一張照片，內容只有星等、色標、旗標（依你轉出時的設定）。',
      '不含客人的備註或標示文字。',
      '',
      '【注意】請不要解壓縮到已經有 .xmp 的資料夾！',
      '同名的 .xmp 會被覆蓋，Lightroom 裡你已經調好的修圖設定會跟著不見。',
      '',
      '使用方式：',
      '1. 把 .xmp 放在 RAW 檔旁邊，檔名要一樣（例如 IMG_001.CR3 配 IMG_001.xmp）。',
      '2. 在 Lightroom 選取那些照片，選單：中繼資料 (Metadata) → 從檔案讀取中繼資料 (Read Metadata from File)。',
      '3. 星等與色標會套到照片上。',
      '',
      '旗標（Pick）尚未用真正的 Lightroom 驗證，請先拿一張照片試試，確認有出現再大量使用。',
      '',
    ].join('\r\n');
  }

  const api = { defaultSettings, normalizeSettings, buildXmp, planExport, readme, xmpBaseName, LABELS, LABEL_ZH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XmpExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
