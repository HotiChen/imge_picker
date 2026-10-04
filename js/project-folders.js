// Folder naming for a project — the one place that knows the convention
// (docs/delivery.md, "Folder convention").
//
//   <root>/                 YYYYMMDD 專案名稱   (the shoot date, one space, the name)
//   <root>/毛片/            the proofs the guest picks from
//   <root>/精修/            the first finals; then 精修二 … 精修十, then 精修11, 精修12 …
//
// R2 has no real folders (a "folder" is only a key prefix), so creating a project
// only decides the names: a folder exists once its first photo is uploaded. The
// root is fixed at creation; the title may change later, the folders may not.
//
// Pure functions only (no DOM, no network) so the rules can be tested alone.
// Loaded by admin.html as window.ProjectFolders.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectFolders = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const PROOF_NAME = '毛片';
  const FINAL_NAME = '精修';

  // Mirrors worker.js: a photo key is at most PICK_PHOTO_KEY_MAX characters, a
  // project title is cut at 200. Whatever we send must stay inside both, with room
  // left under the root for the deepest folder (/精修NN/) and a file name.
  const KEY_MAX = 256;
  const TITLE_MAX = 200;
  const FILE_ROOM = 64;   // characters kept free for a photo's file name
  const SUB_ROOM = 16;    // '/' + FINAL_NAME + a version number + '/'
  const ROOT_MAX = Math.min(TITLE_MAX, KEY_MAX - FILE_ROOM - SUB_ROOM);
  const DATE_PART = 8 + 1;                    // 'YYYYMMDD' and the space after it
  const NAME_MAX = ROOT_MAX - DATE_PART;

  // The character classes below are built from numeric ranges, so the invisible
  // characters they name never have to appear in this file.
  const hex = n => '\\u{' + n.toString(16) + '}';
  const charClass = (literal, ranges) => new RegExp('[' + literal +
    ranges.map(([a, b]) => hex(a) + (b > a ? '-' + hex(b) : '')).join('') + ']', 'gu');
  // control characters (C0, DEL, C1, line/paragraph separators), then the invisible
  // formatting ones: zero width, bidi marks and overrides, word joiner, BOM
  const FORMAT_RANGES = [[0x00, 0x1F], [0x7F, 0x9F], [0x2028, 0x2029], [0x200B, 0x200F],
    [0x202A, 0x202E], [0x2060, 0x2060], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];

  // Gone from a name: the characters a path or URL gives a meaning to
  // (/ \ ? # % * : | " < >), control characters, and invisible formatting
  // characters that would make two folders look alike.
  const FORBIDDEN = charClass('/\\\\?#%*:|"<>', FORMAT_RANGES);
  // Whitespace controls separate words, so they become a space before the rest goes.
  const WORD_BREAKS = charClass('\\t\\n\\r\\v\\f', [[0x2028, 0x2029]]);

  const codePoints = s => Array.from(s);

  function cleanName(raw) {
    let s = raw === null || raw === undefined ? '' : String(raw);
    s = s.replace(WORD_BREAKS, ' ').replace(FORBIDDEN, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  // 'YYYY-MM-DD' (a date input's value) → 'YYYYMMDD', or null when it is not a
  // real calendar day in 2000–2099.
  function compactDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof iso === 'string' ? iso : '');
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2099) return null;
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return m[1] + m[2] + m[3];
  }

  // The folder root, title and proofs folder a new project gets, or why not.
  function plan(dateIso, rawName) {
    const name = cleanName(rawName);
    if (!name) return { ok: false, reason: 'name' };
    const date = compactDate(dateIso);
    if (!date) return { ok: false, reason: 'date' };
    const chars = codePoints(name);
    const truncated = chars.length > NAME_MAX;
    const kept = truncated ? chars.slice(0, NAME_MAX).join('').trim() : name;
    const root = `${date} ${kept}`;
    return { ok: true, root, title: root, proofFolder: `${root}/${PROOF_NAME}/`, truncated };
  }

  // ── finals versions: 精修, 精修二 … 精修十, 精修11, 精修12 … ──
  const CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function finalDirName(n) {
    if (n <= 1) return FINAL_NAME;
    return FINAL_NAME + (n <= 10 ? (n === 10 ? '十' : CN_DIGITS[n]) : String(n));
  }

  // 一…九十九 → 1…99 (hand-made folders may be 精修十一), else null.
  function chineseNumber(s) {
    const digit = c => CN_DIGITS.indexOf(c);
    if (!s) return null;
    if (s.length === 1) return digit(s) > 0 ? digit(s) : (s === '十' ? 10 : null);
    const tens = s.indexOf('十');
    if (tens === -1) return null;
    const head = s.slice(0, tens), tail = s.slice(tens + 1);
    if (head.length > 1 || tail.length > 1) return null;
    const h = head === '' ? 1 : digit(head), t = tail === '' ? 0 : digit(tail);
    return h > 0 && t >= 0 ? h * 10 + t : null;
  }

  // 精修 → 1, 精修二 → 2, 精修11 → 11; anything else (精修final, 毛片) → null.
  function parseFinalVersion(dirName) {
    if (typeof dirName !== 'string' || !dirName.startsWith(FINAL_NAME)) return null;
    const rest = dirName.slice(FINAL_NAME.length);
    if (rest === '') return 1;
    if (/^\d+$/.test(rest)) { const n = Number(rest); return n >= 1 ? n : null; }
    return chineseNumber(rest);
  }

  // The 精修* versions directly under `rootName` among `listed` (R2 prefixes such as
  // '<root>/精修二/'): a deeper folder, another root or a name that only shares the
  // prefix does not count.
  function finalVersions(rootName, listed) {
    const prefix = rootName + '/';
    const out = [];
    for (const f of Array.isArray(listed) ? listed : []) {
      if (typeof f !== 'string' || !f.startsWith(prefix) || !f.endsWith('/')) continue;
      const dir = f.slice(prefix.length, -1);
      if (!dir || dir.includes('/')) continue;
      const n = parseFinalVersion(dir);
      if (n !== null) out.push({ n, folder: f });
    }
    return out;
  }

  function latestFinalFolder(rootName, listed) {
    const all = finalVersions(rootName, listed);
    if (!all.length) return null;
    return all.reduce((a, b) => (b.n > a.n ? b : a)).folder;
  }

  // Always one past the biggest version there is, so a version is never reused.
  function nextFinalFolder(rootName, listed) {
    const all = finalVersions(rootName, listed);
    const next = all.length ? Math.max(...all.map(v => v.n)) + 1 : 1;
    return `${rootName}/${finalDirName(next)}/`;
  }

  // A project's root, from its proof folders snapshot (no extra column): the parent
  // of the first folder that has two levels. proofShaped = that folder is
  // '<root>/毛片/', i.e. it follows the convention; older projects often do not.
  function rootOfProject(project) {
    const folders = project && Array.isArray(project.folders) ? project.folders : [];
    for (const f of folders) {
      const segs = String(f).split('/').filter(Boolean);
      if (segs.length >= 2) {
        return {
          root: segs.slice(0, -1).join('/'),
          proofShaped: segs[segs.length - 1] === PROOF_NAME,
          proofFolder: segs.join('/') + '/',
        };
      }
    }
    return null;
  }

  // upload.html for a project: the target folder (if any) and whether it is locked
  // (lock=1: the page shows it and offers no other).
  function uploadHref(projectId, folder, lock) {
    const proj = `project=${encodeURIComponent(projectId)}`;
    if (!folder) return `upload.html?${proj}`;
    return `upload.html?folder=${encodeURIComponent(folder)}&${proj}${lock ? '&lock=1' : ''}`;
  }

  return {
    PROOF_NAME, FINAL_NAME, KEY_MAX, TITLE_MAX, FILE_ROOM, SUB_ROOM, ROOT_MAX, NAME_MAX,
    cleanName, compactDate, plan,
    finalDirName, parseFinalVersion, finalVersions, latestFinalFolder, nextFinalFolder,
    rootOfProject, uploadHref,
  };
});
