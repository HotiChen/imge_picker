// 拍攝日期 / 拍攝類型 — what a client answers at registration, and what the
// photographer corrects afterwards. Shared by client-login.html and admin.html
// so the two pages cannot drift apart on what the answers mean.

// The categories on offer. ADD A CATEGORY HERE AND NOWHERE ELSE — both pages
// draw their list from this array at load.
//
// The Worker keeps no copy. 其他 lets the client type their own, so the column
// is free text by definition and a second list server-side could only ever
// refuse what this one already allows.
const SHOOT_TYPES = ['婚紗', '婚禮', '親子', '個人', '活動', '其他'];

// The one entry that opens a text box. A member of the list rather than a
// seventh option, so what gets stored is the text the client typed and a
// category promoted into the list above later still reads back as itself.
const SHOOT_TYPE_OTHER = '其他';

// The date has three states, not two. '' is 未填 — nobody was asked, which is
// every account that predates these columns. This is the client answering
// "not settled yet", and it has to be told from '' or the photographer chases
// someone who has already replied.
const SHOOT_DATE_TBD = '未定';

// A shoot date suggests a folder; it never picks one. The folders are named by
// hand, so the only thing safe to key on is the whole date — a year-only
// `2026/` would mark half the bucket and a bare `0819` is as likely to be a
// frame number. The separators below are the ones that turn up in this
// photographer's bucket (`20260819/`, `2026-08-19 王小明/`); anything else
// reads as no match, which costs a scroll rather than pointing at the wrong
// wedding. Nothing is hidden and nothing is auto-selected on the strength of
// it, so a miss is cheap and a false hit is survivable.
//
// Returns null for 未填, for 未定 and for anything else that is not a date,
// because "no suggestion" is the honest answer to all three.
function shootDateFolderMatcher(shootDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(shootDate || '').trim());
  if (!m) return null;
  const sep = '[-_./]?';
  // the digit guards stop 2026-08-19 matching inside 120260819 or 202608190
  const re = new RegExp(`(?<!\\d)${m[1]}${sep}${m[2]}${sep}${m[3]}(?!\\d)`);
  // The folder's own name, not the path that leads to it. Every child of
  // 20260819/ carries the date in its path, so matching the path would mark
  // all of them the moment the photographer steps inside — and a mark on
  // everything at a level tells them nothing about which one is this client's.
  return folder => re.test(String(folder || '').replace(/\/+$/, '').split('/').pop());
}
