// worker.js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

// ─── Thumbnail helpers ───────────────────────────────────────────────────────
// Thumbnails are generated in the browser at upload time and stored alongside
// the original as `_thumbs/<bucket>/<key>.thumb`.
const THUMB_PREFIX = '_thumbs/';
const THUMB_BUCKETS = [400, 1200, 1600];

// Every bucket at least as large as the requested width, smallest first, then
// the original last. Falling straight back to the original would mean that
// introducing a new bucket makes every already-uploaded photo load at full
// size — slower than before the bucket existed.
function thumbCandidates(width, key) {
  const usable = THUMB_BUCKETS.filter(b => b >= width);
  if (!usable.length) usable.push(THUMB_BUCKETS[THUMB_BUCKETS.length - 1]);
  return usable.map(b => `${THUMB_PREFIX}${b}/${key}.thumb`);
}

function preconditionStatus(request) {
  const hasNoneMatch = request.headers.has('If-None-Match');
  const hasModifiedSince = request.headers.has('If-Modified-Since');
  // a failed If-None-Match / If-Modified-Since means "unchanged" → 304
  return hasNoneMatch || hasModifiedSince ? 304 : 412;
}

// ─── Password helpers ────────────────────────────────────────────────────────
async function hashPassword(password) {
  const salt = crypto.randomUUID().replace(/-/g, '');
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hashHex}:${salt}`;
}

async function verifyPassword(password, stored) {
  const [hash, salt] = stored.split(':');
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === hash;
}

// ─── Session helper ──────────────────────────────────────────────────────────
async function getSessionUser(request, env) {
  if (!env.DB) return null;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  // single quotes: a double-quoted 'now' is an identifier, and only SQLite's
  // legacy fallback turns an unresolvable one back into a string. A build with
  // that fallback off rejects the statement outright, which would make every
  // signed-in client anonymous.
  const session = await env.DB.prepare(
    "SELECT s.*, u.id as uid, u.email, u.name, u.folder_path, u.approved, p.can_book, p.can_upload FROM sessions s JOIN users u ON s.user_id = u.id LEFT JOIN permissions p ON p.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first();
  return session;
}

// sessions.expires_at is written as 'YYYY-MM-DD HH:MM:SS' — UTC, but with
// nothing in the text that says so, and Date.parse reads that shape as local
// time. NaN for anything else, which then fails closed.
function sessionExpiry(value) {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  const zoned = /[Zz]$|[+-]\d\d:?\d\d$/.test(text);
  return Date.parse(zoned ? text : text.replace(' ', 'T') + 'Z');
}

// ─── Admin auth check ────────────────────────────────────────────────────────
// Fails CLOSED: with no PHOTOGRAPHER_TOKEN configured nothing admin-side is
// reachable. The old behaviour ("no token set = open") meant a missing or
// mistyped Cloudflare secret silently threw upload, book writes and every
// admin route open to anyone who found the Worker URL.
function isAdminToken(request, env) {
  if (!env.PHOTOGRAPHER_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token === env.PHOTOGRAPHER_TOKEN;
}

// ─── Client share tokens ─────────────────────────────────────────────────────
// Clients get an album link over LINE. Two things follow. LINE's crawler
// pre-fetches the URL to build the preview card before anyone taps it, so a
// token can never be one-time-use and a crawler fetch must not count as the
// client opening the link. And the client reopens that same chat message for
// months, so the token rides in the query string rather than in any storage
// the in-app webview might drop.
const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// The slide alone means a link forwarded into a group chat never dies on its
// own, and revocation is the only kill switch. A link may not outlive this
// from the day it was issued, whatever its stored expiry says.
const SHARE_MAX_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
// A single album page pulls hundreds of images through the gated object route.
// Bumping the expiry on each one would be hundreds of D1 writes per view.
const SHARE_TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const PREVIEW_CRAWLER = /line-poker|facebookexternalhit/i;

// An <img> cannot send an Authorization header, so gating the object route
// took every photographer-facing page down with it. They get a share_tokens
// row of their own, minted with the real credential and carried in `?t=` the
// same way. It reads the whole bucket, so what keeps it from being a second
// master key is that it expires inside a working day and authorises nothing
// but reads.
const STUDIO_TTL_MS = 12 * 60 * 60 * 1000;
// Handed back while this much life is left, so reloading pages all day does
// not leave a day's worth of live credentials behind, and a page that gets one
// at the eleventh hour still has an hour to load its tiles.
const STUDIO_REUSE_MIN_MS = 60 * 60 * 1000;

// And the same problem on the client's side of index.html: someone signed in
// against D1 holds a session, which is neither the admin credential nor a
// share token, so every tile and every listing refused them. They trade that
// session for a row of their own, scoped to the one folder on their user
// record. An hour, because the trade costs them nothing but a fetch and the
// scope is a snapshot that must not go stale far behind the user row.
const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000;
// Handed back while this much life is left, so a client clicking around all
// evening leaves a handful of rows rather than one per page load. Comfortably
// above the five minutes the frontend treats as spent, or the two would
// disagree about whether a token is worth using.
const SESSION_REUSE_MIN_MS = 15 * 60 * 1000;

// The one place a studio token is told from a client's. A positive test, so a
// row from a database that predates the column reads as the client link it is
// rather than as a key to the bucket.
function isStudioShare(share) {
  return share.kind === 'studio';
}

// Likewise positive, and for the same reason.
function isSessionShare(share) {
  return share.kind === 'session';
}

// The two kinds that are minted rather than sent. Whoever holds the credential
// behind one can trade for another whenever they like, which is why neither
// slides and why neither belongs on an album route — the album link is the
// only kind its holder cannot renew.
function isMintedShare(share) {
  return isStudioShare(share) || isSessionShare(share);
}

// The guest-picking link (docs/guest-picking.md). Sent over LINE like an album
// link, so it slides like one, but it opens the /api/pick routes and photo
// reads inside its own folders and nothing else. Positive for the same reason
// as the two above.
function isPickShare(share) {
  return share.kind === 'pick';
}

function newShareToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── A client account's folders ──────────────────────────────────────────────
// One account opens a set of folders, and the set lives in the single
// `users.folder_path` TEXT column it has always had — share_tokens already
// cost two hand-run ALTERs and a third is not worth a feature.
//
// JSON, for two reasons. Every separator anyone would reach for is a character
// a folder name may contain: this photographer's folders read `2026/王, "小明"
// 婚紗/`, which kills commas and quotes in one name. And `share_tokens.folders`
// is already a JSON array, so the snapshot is written in the encoding it is
// read back in.
//
// Anything that opens the way JSON does — `[`, `{` or `"` — is claimed as this
// encoding and must parse as the array it should be. A value truncated to
// `["20260819/` is one backspace in a text box away, and `{"folders": [...]}`
// is what someone guessing the encoding in the D1 console writes; read as a
// plain path either one names a folder that does not exist, and the client is
// left staring at an empty grid with no explanation, which is the whole
// failure being designed out. Only these three openers, never "does it parse":
// `2026` is valid JSON and a real folder name. Everything else is the plain
// string every account carries today. The cost is an account whose folder
// genuinely starts with one of the three, which now has to be written as a
// one-element set.
//
// Returns null — not [] — when the text cannot be read, because "no folders"
// and "unreadable" are two different things to tell someone.
function parseClientFolders(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  let raw;
  if (/^[[{"]/.test(text)) {
    try { raw = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(raw)) return null;
    if (!raw.every(f => typeof f === 'string' && f.trim())) return null;
  } else {
    raw = [text];
  }
  // Canonicalised on the way out rather than on the way in, because what is
  // already in the column was typed by hand: `20260819` and `20260819/` are
  // different prefixes to R2 and the first one also reaches 20260819-other/.
  // Deduped after that, so the two spellings are the one folder they name.
  // Order is left as the photographer wrote it — the client page opens
  // folders[0] by default, so it is a contract and not an artefact.
  const out = [];
  for (const f of raw) {
    const trimmed = f.trim();
    const slashed = trimmed.endsWith('/') ? trimmed : trimmed + '/';
    if (!out.includes(slashed)) out.push(slashed);
  }
  return out;
}

// 拍攝日期 and 拍攝類型 live in two `users` columns that arrive in a hand-run
// migration, and the deployed database has neither until the photographer
// pastes it into the D1 console. Every statement naming one is therefore
// written twice — once as it should be, once without — so a client can still
// register and the client table still loads in the meantime. SQLite words the
// two cases differently, hence both patterns.
function isMissingColumn(e) {
  return /no such column|has no column named/i.test(String(e?.message || ''));
}

// The account is worth more than the two answers: on a database that predates
// the columns the client still gets an account, and the photographer asks for
// the date again rather than the registration failing in front of them.
async function insertUser(env, email, hash, name, shootDate, shootType) {
  try {
    return await env.DB.prepare(
      'INSERT INTO users (email, password_hash, name, approved, shoot_date, shoot_type) VALUES (?, ?, ?, 0, ?, ?)'
    ).bind(email, hash, name, shootDate, shootType).run();
  } catch (e) {
    if (!isMissingColumn(e)) throw e;
    return await env.DB.prepare(
      'INSERT INTO users (email, password_hash, name, approved) VALUES (?, ?, ?, 0)'
    ).bind(email, hash, name).run();
  }
}

// A token opens folders, not the bucket. The match has to land on a `/`
// boundary or the folder `20260819/` also reaches `20260819-other/`, which is
// a different client's wedding.
function folderCovers(folder, path) {
  if (typeof folder !== 'string' || !folder) return false;
  const prefix = folder.endsWith('/') ? folder : folder + '/';
  // `//x.jpg` reaches us as the key `/x.jpg`, so a bare `/` would open the lot
  if (prefix === '/') return false;
  return path === prefix || path.startsWith(prefix);
}

function shareCovers(share, path) {
  if (!path) return false;
  const segments = path.split('/');
  if (segments.includes('..') || segments.includes('.')) return false;
  return share.folders.some(f => folderCovers(f, path));
}

// Objects the Worker keeps for itself rather than serves as photos. The one
// that matters is `_books/<id>.json`: it carries notifyUrl, a bearer webhook
// secret that revoking a link does not revoke, and the whitelist projection on
// GET /api/books/:id exists to keep it away from anything travelling in a URL.
// The object route handed it back through a different door. No real photo key
// starts with `_` — the listing hides those prefixes from the picker and the
// upload route strips `_assets/` — so refusing the namespace costs nothing.
function isInternalKey(key) {
  return key.startsWith('_');
}

// Thumbnails live under `_thumbs/<width>/<key>.thumb`, so permission on one is
// permission on the photo it was made from.
function sourceKey(key) {
  if (!key.startsWith(THUMB_PREFIX)) return key;
  const rest = key.slice(THUMB_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1 || !/^\d+$/.test(rest.slice(0, slash))) return key;
  return rest.slice(slash + 1).replace(/\.thumb$/, '');
}

// NaN for a row whose created_at cannot be read, which then fails closed.
function shareCeiling(row) {
  const created = Date.parse(row.created_at);
  return created + SHARE_MAX_LIFE_MS;
}

// Returns the token row (folders already parsed) or null. Revoked, expired,
// unknown and "no D1 bound at all" are all deliberately the same answer.
async function resolveShareToken(request, url, env) {
  if (!env.DB) return null;
  const value = url.searchParams.get('t') || request.headers.get('X-Share-Token') || '';
  if (!value) return null;
  let row;
  try {
    row = await env.DB.prepare('SELECT * FROM share_tokens WHERE token = ?').bind(value).first();
  } catch { return null; }
  if (!row || row.revoked_at) return null;
  const expiry = Date.parse(row.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  // checked against created_at rather than trusting the stored expiry, so a
  // hand-edited or clock-skewed row cannot buy itself extra life
  const ceiling = shareCeiling(row);
  if (!Number.isFinite(ceiling) || Date.now() >= ceiling) return null;
  let folders;
  try { folders = JSON.parse(row.folders); } catch { return null; }
  if (!Array.isArray(folders)) return null;
  // A pick link opens nothing once its project is archived or gone, whatever
  // its own row says: the archive revokes every link too, and this is the
  // second lock, for a link revived by hand or minted afterwards. The column
  // is named in the WHERE so a database the archive migration has not reached
  // refuses pick links (the query throws) instead of ignoring the archive;
  // album links never get here. The row is kept for resolvePick.
  if (isPickShare(row) && row.project_id) {
    let project;
    try {
      project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND archived_at IS NULL').bind(row.project_id).first();
    } catch { return null; }
    if (!project) return null;
    return { ...row, folders, project };
  }
  return { ...row, folders };
}

// Sliding 90-day expiry, throttled to at most one write a day and skipped for
// preview crawlers so a link nobody opened does not keep renewing itself.
async function touchShareToken(share, request, env) {
  // A minted token does not slide. Its deadline is the whole reason a leak
  // through a log or a shared screen ages out on its own, and one that kept
  // being used would renew itself forever — for a client token, that would
  // also keep its folder snapshot alive long after the photographer narrowed
  // the user record it was taken from.
  if (isMintedShare(share)) return;
  if (PREVIEW_CRAWLER.test(request.headers.get('User-Agent') || '')) return;
  const now = Date.now();
  const seen = share.last_seen_at ? Date.parse(share.last_seen_at) : 0;
  if (Number.isFinite(seen) && now - seen < SHARE_TOUCH_AFTER_MS) return;
  const next = Math.min(now + SHARE_TTL_MS, shareCeiling(share));
  if (!Number.isFinite(next) || next <= now) return;
  share.last_seen_at = new Date(now).toISOString();
  // clamped, not skipped: at the ceiling this writes the same expiry back
  // while last_seen_at keeps moving, because the photographer reads that off
  // /shares to tell a link nobody opens from one being browsed daily
  share.expires_at = new Date(next).toISOString();
  // the browser opens an album's images in parallel, so every one of those
  // requests read the same stale last_seen_at and got here; the WHERE clause
  // is what keeps all but the first from actually writing
  const cutoff = new Date(now - SHARE_TOUCH_AFTER_MS).toISOString();
  try {
    await env.DB.prepare(
      'UPDATE share_tokens SET last_seen_at = ?, expires_at = ? WHERE token = ? AND (last_seen_at IS NULL OR last_seen_at < ?)'
    ).bind(share.last_seen_at, share.expires_at, share.token, cutoff).run();
  } catch { /* a missed bump just means the next visit tries again */ }
}

// ─── Guest picking ───────────────────────────────────────────────────────────
// One link per shoot (a share_tokens row, kind 'pick'). Opening it claims
// nothing — LINE's crawler opens it too. The first person to POST a name takes
// the seat and gets a picker key, once; only its SHA-256 is stored. Holding the
// seat is what lets a browser save and submit; everyone else only looks.
const PICK_NAME_MAX = 50;
const PICK_EMAIL_MAX = 254;
const PICK_NOTE_MAX = 500;
const PICK_KEYS_MAX = 500;
const PICK_RATING_MAX = 5;
// A photo key is an R2 key the guest sends back to us: bounded, printable, and
// naming a file rather than a folder.
const PICK_PHOTO_KEY_MAX = 256;
const PICK_KEY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// The most starred photos (rating >= 1, what submit counts) one project may
// hold, and the most selection rows of any rating (an un-starred photo keeps
// its row, and its note) — the second only bounds the table. Both are enforced
// inside the save's own writes, so concurrent saves cannot together pass them.
// Change them here only.
const PICK_MAX_SELECTIONS = 500;
const PICK_MAX_ROWS = 1000;
// The most submissions one project may record. A submit that picked the same
// photos as the latest one writes no row, so only real changes count; past
// this a changed submit is refused (409 submission_cap). Enforced inside the
// submit's own INSERT. The admin detail returns at most this many, newest
// first. Change it here only.
const PICK_MAX_SUBMISSIONS = 50;
// At most one notification email per project in this window.
const PICK_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;
const PICK_RELATIONSHIPS = ['本人', '伴侶', '家人', '朋友', '其他'];
// The phases in which the owner may still save and submit. 'retouching' is the
// photographer's; only the admin reopen route leaves it.
const PICK_OPEN_PHASES = ['picking', 'submitted'];
const PICK_OPEN_SQL = "('picking', 'submitted')";
// One photographer today. Written by the Worker on every project so the data
// is attributable from day one; a request body never chooses it.
const DEFAULT_PHOTOGRAPHER_ID = 'default';

// Characters, not UTF-16 units, so an emoji is one of the fifty.
const charCount = s => [...s].length;

// ─── Studio settings and dashboard (docs/dashboard-settings.md) ─────────────
const STUDIO_NAME_MAX = 60;
const BOOKING_URL_MAX = 500;
const LOGO_MAX_BYTES = 200 * 1024;
// Asia/Taipei has no daylight saving, so a fixed offset is its month boundary.
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STATS_MONTHS = 12;
const STUDIO_INT_FIELDS = ['default_pick_limit', 'default_extra_price'];

// The only image types a logo may be, decided by the bytes themselves. The
// client's Content-Type is never consulted: an SVG (script) or HTML file
// labelled image/png is exactly what this is here to refuse.
const LOGO_SIGNATURES = [
  ['image/png', 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', 0, [0xff, 0xd8, 0xff]],
];
function sniffImageType(bytes) {
  const at = (off, sig) => bytes.length >= off + sig.length && sig.every((v, i) => bytes[off + i] === v);
  for (const [type, off, sig] of LOGO_SIGNATURES) if (at(off, sig)) return type;
  // RIFF....WEBP: the RIFF container alone is also WAV and AVI
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

// The request body, or null once it passes `max` bytes. Read as a stream and
// cut off there, so neither a lying Content-Length nor a chunked body can make
// the Worker buffer more than the limit.
async function readBodyCapped(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// A booking link the guest page puts in an href: https only, no whitespace or
// control characters, no user:pass@ (reads as one host, goes to another).
// Returns the URL as the parser re-serialised it, or null.
function cleanBookingUrl(raw) {
  if (raw.length > BOOKING_URL_MAX) return null;
  if (!/^https:\/\//i.test(raw)) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  if (u.href.length > BOOKING_URL_MAX) return null;
  return u.href;
}

// Everything the photographer set, minus the logo bytes. An absent row reads
// as all-null.
async function readStudioSettings(env, photographerId) {
  const row = await env.DB.prepare(
    'SELECT studio_name, booking_url, default_pick_limit, default_extra_price, logo IS NOT NULL AS has_logo, logo_type, logo_updated_at, updated_at FROM studio_settings WHERE photographer_id = ?'
  ).bind(photographerId).first();
  const hasLogo = !!row?.has_logo;
  return {
    studio_name: row?.studio_name ?? null,
    booking_url: row?.booking_url ?? null,
    default_pick_limit: row?.default_pick_limit ?? null,
    default_extra_price: row?.default_extra_price ?? null,
    has_logo: hasLogo,
    logo_type: hasLogo ? row.logo_type : null,
    logo_updated_at: hasLogo ? row.logo_updated_at : null,
    updated_at: row?.updated_at ?? null,
  };
}

// The studio brand a guest sees. booking_url was validated on write. A
// database the settings migration has not reached reads as no brand, so the
// guest page never breaks over it.
async function pickStudio(env, photographerId) {
  try {
    const s = await readStudioSettings(env, photographerId);
    return { name: s.studio_name, booking_url: s.booking_url, has_logo: s.has_logo };
  } catch {
    return { name: null, booking_url: null, has_logo: false };
  }
}

// Month keys ('2026-09') of the last STATS_MONTHS Taipei months, oldest
// first, and the UTC instant the oldest one starts.
function statsMonths(now) {
  const t = new Date(now + TAIPEI_OFFSET_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const months = [];
  for (let i = STATS_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const since = new Date(Date.UTC(y, m - (STATS_MONTHS - 1), 1) - TAIPEI_OFFSET_MS).toISOString();
  return { months, since };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A photo a pick link may name: inside the token's snapshot, and never one of
// the Worker's own `_` objects, whatever the snapshot says.
function pickKeyAllowed(share, key) {
  return typeof key === 'string' && !isInternalKey(key) && shareCovers(share, key);
}

// The shape every photo_key in a save must have, before the folder check:
// at most PICK_PHOTO_KEY_MAX characters, no control or line-separator
// characters (they would forge lines in the email's text part and logs), and
// not a folder.
function pickKeyValid(key) {
  return typeof key === 'string' && charCount(key) <= PICK_PHOTO_KEY_MAX &&
    !PICK_KEY_CONTROL.test(key) && !key.endsWith('/');
}

function pickKeyInvalid() {
  return jsonOk({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
}

// The folders a project is created with, canonicalised the way
// parseClientFolders does it. null when any of them could not name a photo
// folder: `/` would open the bucket, `_` is the Worker's own, and `.`/`..`
// never match a real key.
function pickFolders(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const out = [];
  for (const f of value) {
    if (typeof f !== 'string' || !f.trim()) return null;
    const trimmed = f.trim();
    const slashed = trimmed.endsWith('/') ? trimmed : trimmed + '/';
    if (slashed.startsWith('/') || isInternalKey(slashed)) return null;
    const segments = slashed.split('/');
    if (segments.includes('..') || segments.includes('.')) return null;
    if (!out.includes(slashed)) out.push(slashed);
  }
  return out;
}

// The project behind a pick token and, when the request carries a picker key,
// the picker it belongs to. The key is looked up by its hash and only within
// the token's own project, so a key from another project finds nobody. null
// for anything that is not a live pick link to a project that still exists
// and is not archived — resolveShareToken already read that project.
async function resolvePick(share, request, env) {
  if (!share || !isPickShare(share) || !share.project) return null;
  const { project } = share;
  const key = request.headers.get('X-Picker-Key') || '';
  let picker = null;
  if (key) {
    picker = await env.DB.prepare('SELECT * FROM pickers WHERE key_hash = ? AND project_id = ?')
      .bind(await sha256Hex(key), project.id).first();
  }
  // a key from before a seat reset still finds its picker row; it is the seat
  // that says whether that picker is the owner
  const isOwner = !!picker && project.owner_picker_id === picker.id;
  return { project, picker, isOwner };
}

// 409 for a project the photographer has started retouching.
function pickRetouching() {
  return jsonOk({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
}

// A conditional write that changed nothing: the phase moved to retouching or
// the seat moved since the checks before it — or, for a save, the seat and
// phase still hold and it was the selection cap. Re-read to say which.
// `cap`: {pickerId, refused()} — when the seat and phase still hold, the
// write's own cap is what refused it, and refused() builds that 409.
// An archive that landed in between answers like the dead link it now is.
async function pickRefused(env, projectId, notOwner, cap = null) {
  const now = await env.DB.prepare('SELECT phase, owner_picker_id, archived_at FROM projects WHERE id = ?').bind(projectId).first();
  if (now?.archived_at) return jsonErr('Unauthorized', 401);
  if (now && !PICK_OPEN_PHASES.includes(now.phase)) return pickRetouching();
  if (now && cap && now.owner_picker_id === cap.pickerId) return cap.refused();
  return jsonErr(notOwner, 403);
}

// How many of project p's submissions are newer than the last one the
// photographer was emailed about (all of them if none was). Needs alias `p`.
const PICK_UNNOTIFIED_SQL = '(SELECT COUNT(*) FROM submissions s WHERE s.project_id = p.id AND s.rowid > COALESCE((SELECT MAX(n.rowid) FROM submissions n WHERE n.project_id = p.id AND n.notified = 1), 0))';

// Two submissions picked the same photos.
function samePhotoKeys(a, b) {
  const set = new Set(b);
  return a.length === b.length && a.every(k => set.has(k));
}

// What the photographer sees for a pick link: live, or why it is not.
// Mirrors resolveShareToken.
function pickTokenStatus(row, now) {
  if (row.revoked_at) return 'revoked';
  const expiry = Date.parse(row.expires_at);
  const ceiling = shareCeiling(row);
  if (!Number.isFinite(expiry) || expiry <= now || !Number.isFinite(ceiling) || now >= ceiling) return 'expired';
  return 'live';
}

async function pickOwnerName(env, projectId) {
  const row = await env.DB.prepare(
    'SELECT pk.name FROM projects p JOIN pickers pk ON pk.id = p.owner_picker_id WHERE p.id = ?'
  ).bind(projectId).first();
  return row ? row.name : null;
}

// Over the plan's limit is a warning the guest reads, never a block.
function pickOverText(count, limit, price) {
  if (limit == null || count <= limit) return '';
  const over = count - limit;
  return `方案 ${limit} 張精修，您已選 ${count} 張，多 ${over} 張` +
    (price != null ? `，每張 NT$${price} 加挑費` : '');
}

// A submissions.photo_keys column back as an array; [] if it will not parse.
function parsePhotoKeys(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// What changed between two submissions, as photo keys. null when there is no
// earlier submission to compare with.
function pickDiff(current, previous) {
  if (!previous) return null;
  const now = new Set(current);
  const before = new Set(previous);
  return {
    added: current.filter(k => !before.has(k)),
    removed: previous.filter(k => !now.has(k)),
  };
}

// Tells the photographer a guest submitted. Isolated so the transport can
// change (Cloudflare send_email now, Resend later) without touching the route.
// Everything the guest typed or picked is escaped for the HTML part, and the
// subject is forced onto one line. Missing configuration is a logged skip, not
// an error: the submit is the guest's, and it must land whether or not mail is
// set up. `submission` is the row just written; `previous` the one before it
// for this project (whoever made it), or null.
async function sendPickNotification(env, project, picker, submission, previous) {
  if (!env.NOTIFY_EMAIL || !env.PHOTOGRAPHER_EMAIL) {
    console.warn('pick notification skipped: NOTIFY_EMAIL or PHOTOGRAPHER_EMAIL is not configured');
    return false;
  }
  const count = submission.count ?? 0;
  const limit = submission.pick_limit;
  const price = submission.extra_price;
  const title = project.title || '未命名專案';
  const fields = [
    ['專案', title],
    ['挑選人', picker.name],
    ['關係', submission.relationship],
    ['Email', submission.email || '（未填）'],
    ['已選', `${count} 張`],
    ['方案', limit == null ? '不限張數' : `${limit} 張`],
  ];
  if (price != null) fields.push(['加挑單價', `NT$${price}`]);
  const warning = pickOverText(count, limit, price);
  const diff = pickDiff(submission.photo_keys, previous?.photo_keys);
  // [heading, keys] per non-empty side. A resubmit that changed nothing is
  // never mailed, so there is always something to list after the first.
  const lists = diff ? [['新增', diff.added], ['移除', diff.removed]].filter(([, keys]) => keys.length) : [];
  const subject = `[選片完成] ${title} — ${picker.name}`.replace(/[\r\n]+/g, ' ');
  const text = fields.map(([k, v]) => `${k}：${v}`).join('\n') + (warning ? `\n\n${warning}` : '') +
    lists.map(([h, keys]) => `\n\n${h} ${keys.length} 張：\n` + keys.join('\n')).join('');
  const html = '<table>' +
    fields.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    '</table>' + (warning ? `<p><strong>${escapeHtml(warning)}</strong></p>` : '') +
    lists.map(([h, keys]) => `<h3>${escapeHtml(h)} ${keys.length} 張</h3><ul>` +
      keys.map(k => `<li>${escapeHtml(k)}</li>`).join('') + '</ul>').join('');
  await env.NOTIFY_EMAIL.send({
    to: env.PHOTOGRAPHER_EMAIL,
    from: env.NOTIFY_FROM || env.PHOTOGRAPHER_EMAIL,
    subject, html, text,
  });
  return true;
}

// A share link is a URL sitting in a chat thread. Its responses must not land
// in any cache another request could read, and because the token is also
// accepted as a header — which no shared cache keys on — the response has to
// say so.
const SHARED_LINK_HEADERS = { 'Cache-Control': 'private, no-store', 'Vary': 'X-Share-Token' };

// And the photographer's own reads carry no credential in the URL at all, so a
// shared cache holding one would serve it to whoever asked for that URL next.
const ADMIN_ONLY_HEADERS = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' };

// ─── JSON response helpers ───────────────────────────────────────────────────
function jsonOk(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders }
  });
}

function jsonErr(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const pathParts = url.pathname.split('/').filter(Boolean);

    // resolved at most once per request, and only on the routes that need it
    let sharePromise;
    const share = () => (sharePromise ??= resolveShareToken(request, url, env));

    // ═══════════════════════════════════════════════════════════════════════
    // AUTH ROUTES
    // ═══════════════════════════════════════════════════════════════════════

    // GET /api/auth/verify-admin — check if PHOTOGRAPHER_TOKEN matches
    if (request.method === 'GET' && url.pathname === '/api/auth/verify-admin') {
      if (isAdminToken(request, env)) return jsonOk({ ok: true });
      return jsonErr('Token 不正確', 401);
    }

    // POST /api/auth/studio-token — a read-only credential the photographer's
    // own pages can put in an <img> src
    if (request.method === 'POST' && url.pathname === '/api/auth/studio-token') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = Date.now();
      // both sides are ISO-8601 UTC so this compares as text; a hand-edited
      // row in any other format simply is not reused
      const live = await env.DB.prepare(
        "SELECT token, expires_at FROM share_tokens WHERE kind = 'studio' AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
      ).bind(new Date(now + STUDIO_REUSE_MIN_MS).toISOString()).first();
      const token = live ? live.token : newShareToken();
      const expiresAt = live ? live.expires_at : new Date(now + STUDIO_TTL_MS).toISOString();
      if (!live) {
        // book_id is empty because the token belongs to no album, which keeps
        // it out of every book route and out of the per-book revoke list.
        // folders is empty so the kind check is not the only thing between
        // this row and the bucket.
        await env.DB.prepare(
          "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES (?, '', 'studio', '[]', ?, ?)"
        ).bind(token, new Date(now).toISOString(), expiresAt).run();
      }
      // One live studio row at a time, whether we just issued it or handed
      // back the one that was already there. Reuse is what keeps the picker
      // and the editor open side by side on the same token, so it is the
      // handed-back row that is spared here — superseding it instead would
      // have the two pages revoke each other's token in turn. What reuse
      // therefore cannot give is "a fresh login retires a leaked token": the
      // leaked one IS the live one. POST /api/shares/minted/revoke-all is the
      // control for that, and it does not wait on a page load.
      await env.DB.prepare(
        "UPDATE share_tokens SET revoked_at = ? WHERE kind = 'studio' AND revoked_at IS NULL AND token != ?"
      ).bind(new Date(now).toISOString(), token).run();
      return jsonOk({ token, expires_at: expiresAt });
    }

    // POST /api/auth/session-token — the client's half of the same trade: a
    // D1 session, which fetch can send as a header, for a token an <img> can
    // carry.
    if (request.method === 'POST' && url.pathname === '/api/auth/session-token') {
      const session = await getSessionUser(request, env);
      if (!session) return jsonErr('Unauthorized', 401);
      if (!session.approved) return jsonErr('帳號待審核，請聯繫攝影師', 403);
      // Every folder on the account, each slash-terminated — the client
      // lists these strings straight back as `?list=`, and `20260819` is a
      // different prefix from `20260819/`, the first of which also reaches
      // 20260819-other/.
      const folders = parseClientFolders(session.folder_path);
      // A column nobody can read is refused as loudly as an empty one, and
      // with different wording: the photographer has to be told which of the
      // two it is, and the client is the one carrying the message.
      if (folders === null) return jsonErr('資料夾設定有誤，請聯繫攝影師', 403);
      // '' is what a fresh user row carries. Read as "everything" it would
      // open every other client's wedding, and read as "nothing" it is a
      // silent empty grid, so it is refused out loud instead.
      if (!folders.length) return jsonErr('尚未設定資料夾，請聯繫攝影師', 403);
      const now = Date.now();
      // the token must not outlive the session it was traded for; a hand-edited
      // expiry the SQL above let past is refused rather than guessed at
      const sessionEnd = sessionExpiry(session.expires_at);
      if (!Number.isFinite(sessionEnd) || sessionEnd <= now) return jsonErr('Unauthorized', 401);
      const foldersJson = JSON.stringify(folders);
      // Keyed on the owner AND on the exact snapshot — the canonical set in
      // the photographer's order, not the raw column — so narrowing a
      // client's folders takes effect at their next page load rather than
      // whenever the old row happens to die. Exact text equality is what
      // matters now that the set can change: a narrowed set can never equal
      // the wider string a live row was minted from, so the old set is not
      // reachable through reuse. Two clients who share a folder still get a
      // row each, because the owner is part of the key.
      const live = await env.DB.prepare(
        "SELECT token, expires_at FROM share_tokens WHERE kind = 'session' AND user_id = ? AND folders = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
      ).bind(session.uid, foldersJson, new Date(now + SESSION_REUSE_MIN_MS).toISOString()).first();
      // a row minted from this client's other, longer-lived session must not
      // carry the session in front of us past its own end
      if (live && Date.parse(live.expires_at) <= sessionEnd) {
        return jsonOk({ token: live.token, expires_at: live.expires_at, folders });
      }
      const token = newShareToken();
      const expiresAt = new Date(Math.min(now + SESSION_TOKEN_TTL_MS, sessionEnd)).toISOString();
      // book_id '' for the same reason a studio row carries it: the token
      // belongs to no album, which keeps it out of every book route and out of
      // the per-book revoke list. user_id is what a logout and an account
      // deletion find it by.
      await env.DB.prepare(
        "INSERT INTO share_tokens (token, book_id, kind, user_id, folders, created_at, expires_at) VALUES (?, '', 'session', ?, ?, ?, ?)"
      ).bind(token, session.uid, foldersJson, new Date(now).toISOString(), expiresAt).run();
      return jsonOk({ token, expires_at: expiresAt, folders });
    }

    // POST /api/auth/register
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      if (!env.DB) return jsonErr('DB not configured', 500);
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
      const { email, password, name, shoot_date, shoot_type } = body || {};
      if (!email || !password || !name) return jsonErr('email, password, name required');
      // Optional, because a cached copy of the form predates them; typed,
      // because anything else reaches D1 as a bind of the wrong kind.
      if (shoot_date !== undefined && typeof shoot_date !== 'string') return jsonErr('shoot_date must be a string');
      if (shoot_type !== undefined && typeof shoot_type !== 'string') return jsonErr('shoot_type must be a string');
      const emailLower = email.toLowerCase().trim();
      const hash = await hashPassword(password);
      try {
        const result = await insertUser(env, emailLower, hash, name.trim(),
          (shoot_date || '').trim(), (shoot_type || '').trim());
        const userId = result.meta.last_row_id;
        await env.DB.prepare(
          'INSERT INTO permissions (user_id, can_book, can_upload) VALUES (?, 0, 0)'
        ).bind(userId).run();
        return jsonOk({ success: true, message: '等待管理員審核' }, 201);
      } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) return jsonErr('Email 已被使用', 409);
        return jsonErr(e.message, 500);
      }
    }

    // POST /api/auth/login
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!env.DB) return jsonErr('DB not configured', 500);
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
      const { email, password } = body || {};
      if (!email || !password) return jsonErr('email and password required');
      const emailLower = email.toLowerCase().trim();
      const user = await env.DB.prepare(
        'SELECT u.*, p.can_book, p.can_upload FROM users u LEFT JOIN permissions p ON p.user_id = u.id WHERE u.email = ?'
      ).bind(emailLower).first();
      if (!user) return jsonErr('Email 或密碼錯誤', 401);
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) return jsonErr('Email 或密碼錯誤', 401);
      if (!user.approved) return jsonErr('帳號待審核，請聯繫攝影師', 403);
      // Generate session token
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
      await env.DB.prepare(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
      ).bind(token, user.id, expiresAt).run();
      return jsonOk({
        token,
        // folder_path is the raw column, kept for callers that predate the
        // set; `folders` is what it means. upload.html and the book editor
        // open folders[0], and the encoded text is not a folder path.
        user: { id: user.id, email: user.email, name: user.name, folder_path: user.folder_path || '', folders: parseClientFolders(user.folder_path) },
        permissions: { can_book: !!user.can_book, can_upload: !!user.can_upload }
      });
    }

    // POST /api/auth/logout
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!env.DB) return jsonErr('DB not configured', 500);
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token) {
        // The URL tokens minted from this account go with it. Without this a
        // logout on a shared machine leaves an hour of readable photos in the
        // browser's history. Keyed on user_id alone — the subquery yields NULL
        // for a token that names no session, and `= NULL` matches nothing — and
        // no other route ever writes that column, so it cannot reach an album
        // link. Before the session row goes, or the subquery finds nobody.
        await env.DB.prepare(
          'DELETE FROM share_tokens WHERE user_id = (SELECT user_id FROM sessions WHERE token = ?)'
        ).bind(token).run();
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      }
      return jsonOk({ success: true });
    }

    // GET /api/auth/me
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!env.DB) return jsonErr('DB not configured', 500);
      const session = await getSessionUser(request, env);
      if (!session) return jsonErr('Unauthorized', 401);
      return jsonOk({
        user: { id: session.uid, email: session.email, name: session.name, folder_path: session.folder_path || '', folders: parseClientFolders(session.folder_path) },
        permissions: { can_book: !!session.can_book, can_upload: !!session.can_upload }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN ROUTES (PHOTOGRAPHER_TOKEN required)
    // ═══════════════════════════════════════════════════════════════════════

    // GET /api/admin/clients
    if (request.method === 'GET' && url.pathname === '/api/admin/clients') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const listSql = shoot =>
        `SELECT u.id, u.email, u.name, u.folder_path, u.approved, u.created_at${shoot}, p.can_book, p.can_upload` +
        ' FROM users u LEFT JOIN permissions p ON p.user_id = u.id ORDER BY u.created_at DESC';
      let results;
      try {
        ({ results } = await env.DB.prepare(listSql(', u.shoot_date, u.shoot_type')).all());
      } catch (e) {
        if (!isMissingColumn(e)) throw e;
        // Losing the whole client table over a column nobody has added yet is
        // a worse failure than showing no shoot date, so the answers go and
        // the table stays.
        ({ results } = await env.DB.prepare(listSql('')).all());
      }
      // The raw column rides along beside the parsed set so a value nobody can
      // read — `folders: null` — can still be seen and repaired. Sending only
      // the parse would leave the photographer editing a blank box.
      return jsonOk(results.map(r => ({
        ...r,
        folders: parseClientFolders(r.folder_path),
        // one state for 未填 whether the row was never filled in or the
        // column is not there yet — the page has nothing else to render
        shoot_date: r.shoot_date || '',
        shoot_type: r.shoot_type || '',
      })));
    }

    // PUT /api/admin/clients/:id/approve
    if (request.method === 'PUT' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'clients' && pathParts[4] === 'approve') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const userId = parseInt(pathParts[3]);
      if (!userId) return jsonErr('Invalid user id');
      await env.DB.prepare('UPDATE users SET approved = 1 WHERE id = ?').bind(userId).run();
      return jsonOk({ success: true });
    }

    // PUT /api/admin/clients/:id/permissions
    if (request.method === 'PUT' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'clients' && pathParts[4] === 'permissions') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const userId = parseInt(pathParts[3]);
      if (!userId) return jsonErr('Invalid user id');
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
      const { can_book, can_upload, folder_path, folders, shoot_date, shoot_type } = body || {};
      // Both halves are validated before either is written: a request that
      // names a folder set we cannot store must not leave the permissions
      // applied and the folders stale.
      if (folders !== undefined &&
          (!Array.isArray(folders) || !folders.every(f => typeof f === 'string' && f.trim()))) {
        return jsonErr('folders must be an array of non-empty paths');
      }
      // A half-migrated caller sending the new array under the old field name
      // would otherwise reach D1 as a bind of the wrong type.
      if (folder_path !== undefined && typeof folder_path !== 'string') {
        return jsonErr('folder_path must be a string');
      }
      if (shoot_date !== undefined && typeof shoot_date !== 'string') {
        return jsonErr('shoot_date must be a string');
      }
      if (shoot_type !== undefined && typeof shoot_type !== 'string') {
        return jsonErr('shoot_type must be a string');
      }
      // Written first, in one statement, and only for the fields that were
      // sent. It is the one write here a database without the migration cannot
      // run, and failing it after the permissions had landed would leave the
      // request half-applied — the same reason the two validations above come
      // before either write.
      const shootSets = [];
      const shootBinds = [];
      if (shoot_date !== undefined) { shootSets.push('shoot_date = ?'); shootBinds.push(shoot_date.trim()); }
      if (shoot_type !== undefined) { shootSets.push('shoot_type = ?'); shootBinds.push(shoot_type.trim()); }
      if (shootSets.length) {
        try {
          await env.DB.prepare(`UPDATE users SET ${shootSets.join(', ')} WHERE id = ?`)
            .bind(...shootBinds, userId).run();
        } catch (e) {
          if (!isMissingColumn(e)) throw e;
          // The photographer is the only one who can fix this, and being told
          // is the only way they learn the migration has not been run.
          return jsonErr('拍攝日期／拍攝類型欄位尚未建立，請先執行 users 的 migration', 500);
        }
      }
      await env.DB.prepare(
        'INSERT INTO permissions (user_id, can_book, can_upload) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET can_book = excluded.can_book, can_upload = excluded.can_upload'
      ).bind(userId, can_book ? 1 : 0, can_upload ? 1 : 0).run();
      // `folders` wins when both arrive. A UI mid-migration sends the picker's
      // list alongside whatever is still sitting in the old text box, and the
      // stale box must not be the one that lands.
      if (folders !== undefined) {
        await env.DB.prepare('UPDATE users SET folder_path = ? WHERE id = ?')
          .bind(JSON.stringify(folders.map(f => f.trim())), userId).run();
      } else if (folder_path !== undefined) {
        // written through unchanged, so the old single-value caller reading a
        // set out of the column and writing it back does not corrupt it
        await env.DB.prepare('UPDATE users SET folder_path = ? WHERE id = ?').bind(folder_path, userId).run();
      }
      return jsonOk({ success: true });
    }

    // DELETE /api/admin/clients/:id
    if (request.method === 'DELETE' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'clients' && pathParts[3] && !pathParts[4]) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const userId = parseInt(pathParts[3]);
      if (!userId) return jsonErr('Invalid user id');
      await env.DB.prepare('DELETE FROM share_tokens WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM permissions WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return jsonOk({ success: true });
    }

    // POST /api/admin/projects — a guest-picking project and its one link
    if (request.method === 'POST' && url.pathname === '/api/admin/projects') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
      const { title = '', folders, pick_limit = null, extra_price = null } = body || {};
      if (typeof title !== 'string') return jsonErr('title must be a string');
      const snapshot = pickFolders(folders);
      if (!snapshot) return jsonErr('folders must be a non-empty array of photo folders');
      for (const [name, v] of [['pick_limit', pick_limit], ['extra_price', extra_price]]) {
        if (v !== null && !(Number.isInteger(v) && v >= 0)) return jsonErr(`${name} must be a whole number from 0`);
      }
      const id = crypto.randomUUID();
      const token = newShareToken();
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + SHARE_TTL_MS).toISOString();
      const foldersJson = JSON.stringify(snapshot);
      const cleanTitle = title.trim().slice(0, 200);
      await env.DB.prepare(
        'INSERT INTO projects (id, title, folders, pick_limit, extra_price, created_at, photographer_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, cleanTitle, foldersJson, pick_limit, extra_price, createdAt, DEFAULT_PHOTOGRAPHER_ID).run();
      // book_id '' keeps it off every book route and out of the per-album
      // list; the kind keeps it off everything else that is not a pick route
      await env.DB.prepare(
        "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES (?, '', ?, 'pick', ?, ?, ?, ?)"
      ).bind(token, cleanTitle, id, foldersJson, createdAt, expiresAt).run();
      return jsonOk({
        project: { id, title: cleanTitle, folders: snapshot, pick_limit, extra_price, photographer_id: DEFAULT_PHOTOGRAPHER_ID },
        token, expires_at: expiresAt,
      }, 201);
    }

    // GET /api/admin/projects — the photographer's list, newest first. One
    // statement: the seat holder by join, the submit tally and the live link
    // by correlated subquery, so a long list costs no more round trips than a
    // short one. The owner join also checks the picker's project, so a stray
    // owner id cannot put another project's guest name on this row. "Live"
    // is what resolveShareToken would accept: not revoked, not expired, and
    // inside the ceiling counted from created_at (ISO strings compare in
    // time order). Archived projects are left out; `?archived=1` lists only
    // them (any other value is the default view).
    if (request.method === 'GET' && url.pathname === '/api/admin/projects') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = Date.now();
      const archivedFilter = params.get('archived') === '1' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL';
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.title, p.phase, p.modified_after_submit,
                o.name AS owner_name, p.created_at, p.archived_at, p.delivered_at,
                (SELECT COUNT(*) FROM submissions s WHERE s.project_id = p.id) AS submission_count,
                (SELECT MAX(s.created_at) FROM submissions s WHERE s.project_id = p.id) AS last_submitted_at,
                ${PICK_UNNOTIFIED_SQL} AS unnotified_submissions,
                (SELECT t.token FROM share_tokens t
                  WHERE t.kind = 'pick' AND t.project_id = p.id AND t.revoked_at IS NULL
                    AND t.expires_at > ?1 AND t.created_at > ?2
                  ORDER BY t.created_at DESC LIMIT 1) AS token
           FROM projects p
           LEFT JOIN pickers o ON o.id = p.owner_picker_id AND o.project_id = p.id
          WHERE p.photographer_id = ?3 AND ${archivedFilter}
          ORDER BY p.created_at DESC, p.rowid DESC
          LIMIT 200`
      ).bind(
        new Date(now).toISOString(),
        new Date(now - SHARE_MAX_LIFE_MS).toISOString(),
        DEFAULT_PHOTOGRAPHER_ID,
      ).all();
      return jsonOk({ projects: results }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/admin/projects/:id — the seat holder, every submit record and
    // who set each pick. Guest strings go out raw in JSON; admin.html escapes
    // them when it renders.
    if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[4]) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], DEFAULT_PHOTOGRAPHER_ID).first();
      if (!project) return jsonErr('Not found', 404);
      // key_hash is left out by name: it is the one column here that is a
      // credential's stand-in
      const { results: pickers } = await env.DB.prepare(
        'SELECT id, name, relationship, email, user_id, created_at FROM pickers WHERE project_id = ? ORDER BY created_at'
      ).bind(project.id).all();
      // newest first; rowid breaks a tie inside one millisecond, since rows
      // are only ever appended. At most PICK_MAX_SUBMISSIONS: a project the
      // cap never covered (rows from before it) still loads a bounded page
      const { results: submitted } = await env.DB.prepare(
        'SELECT id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at, notified FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
      ).bind(project.id, PICK_MAX_SUBMISSIONS).all();
      const { unnotified } = await env.DB.prepare(
        `SELECT ${PICK_UNNOTIFIED_SQL} AS unnotified FROM projects p WHERE p.id = ?`
      ).bind(project.id).first();
      const submissions = submitted.map(r => ({ ...r, photo_keys: parsePhotoKeys(r.photo_keys) }));
      const { results: selections } = await env.DB.prepare(
        'SELECT photo_key, rating, note, updated_by, updated_at FROM selections WHERE project_id = ? ORDER BY photo_key'
      ).bind(project.id).all();
      // every pick link the project ever had, live or not, so the page can
      // offer revoke on the live ones
      const { results: tokenRows } = await env.DB.prepare(
        "SELECT token, created_at, expires_at, revoked_at, last_seen_at FROM share_tokens WHERE kind = 'pick' AND project_id = ? ORDER BY created_at DESC, rowid DESC"
      ).bind(project.id).all();
      const now = Date.now();
      const tokens = tokenRows.map(t => ({ ...t, status: pickTokenStatus(t, now) }));
      let folders = null;
      try { folders = JSON.parse(project.folders); } catch {}
      return jsonOk({
        project: { ...project, folders },
        owner: pickers.find(p => p.id === project.owner_picker_id) || null,
        pickers, selections, tokens, submissions, unnotified_submissions: unnotified,
      }, 200, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/reset-seat — the guest lost their browser.
    // Frees the seat; the selections belong to the project and stay.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && pathParts[4] === 'reset-seat') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const result = await env.DB.prepare('UPDATE projects SET owner_picker_id = NULL WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], DEFAULT_PHOTOGRAPHER_ID).run();
      if (!result.meta?.changes) return jsonErr('Not found', 404);
      return jsonOk({ ok: true });
    }

    // POST /api/admin/projects/:id/start-retouch — the photographer starts
    // work on what was submitted; from here the guest's saves and submits are
    // refused. Only from 'submitted' (a second press is a no-op): from
    // 'picking' there is nothing to retouch yet.
    // POST /api/admin/projects/:id/reopen — back to 'picking', from either
    // later phase, so the guest can change their picks again. Submissions stay.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[5] &&
        (pathParts[4] === 'start-retouch' || pathParts[4] === 'reopen')) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      // each is one conditional UPDATE, so it cannot interleave with a save
      // or a submit: those re-check the phase inside their own writes
      const moved = pathParts[4] === 'start-retouch'
        ? await env.DB.prepare(
          "UPDATE projects SET phase = 'retouching' WHERE id = ? AND photographer_id = ? AND phase IN ('submitted', 'retouching')"
        ).bind(id, DEFAULT_PHOTOGRAPHER_ID).run()
        : await env.DB.prepare(
          "UPDATE projects SET phase = 'picking', modified_after_submit = 0, delivered_at = NULL WHERE id = ? AND photographer_id = ?"
        ).bind(id, DEFAULT_PHOTOGRAPHER_ID).run();
      if (!moved.meta?.changes) {
        const exists = await env.DB.prepare('SELECT phase FROM projects WHERE id = ? AND photographer_id = ?')
          .bind(id, DEFAULT_PHOTOGRAPHER_ID).first();
        if (!exists) return jsonErr('Not found', 404);
        return jsonOk({ error: '客人尚未送出，無法開始修圖', code: 'not_submitted', phase: exists.phase }, 409);
      }
      return jsonOk({ ok: true, phase: pathParts[4] === 'start-retouch' ? 'retouching' : 'picking' });
    }

    // POST /api/admin/projects/:id/archive — the shoot is done: off the list,
    // and every live pick link to it revoked in the same batch as the stamp.
    // The stamp alone already refuses the links (resolveShareToken); the
    // revoke is so they read as dead in the detail view and stay dead after
    // an unarchive. Selections and submissions stay. A second archive keeps
    // the first stamp. The revoke is gated on the project being this
    // photographer's, so an unknown id changes nothing.
    // POST /api/admin/projects/:id/unarchive — back on the list. The links
    // stay revoked; POST .../links mints a new one.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[5] &&
        (pathParts[4] === 'archive' || pathParts[4] === 'unarchive')) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      if (pathParts[4] === 'unarchive') {
        const result = await env.DB.prepare('UPDATE projects SET archived_at = NULL WHERE id = ? AND photographer_id = ?')
          .bind(id, DEFAULT_PHOTOGRAPHER_ID).run();
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        return jsonOk({ ok: true, archived_at: null }, 200, ADMIN_ONLY_HEADERS);
      }
      const at = new Date().toISOString();
      const [stamped, revoked] = await env.DB.batch([
        env.DB.prepare('UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE id = ? AND photographer_id = ?')
          .bind(at, id, DEFAULT_PHOTOGRAPHER_ID),
        env.DB.prepare(
          "UPDATE share_tokens SET revoked_at = ? WHERE kind = 'pick' AND project_id = ? AND revoked_at IS NULL " +
          'AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ?)'
        ).bind(at, id, id, DEFAULT_PHOTOGRAPHER_ID),
      ]);
      if (!stamped.meta?.changes) return jsonErr('Not found', 404);
      const row = await env.DB.prepare('SELECT archived_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, DEFAULT_PHOTOGRAPHER_ID).first();
      return jsonOk({ ok: true, archived_at: row?.archived_at ?? at, revoked: revoked.meta?.changes ?? 0 }, 200, ADMIN_ONLY_HEADERS);
    }

    // DELETE /api/admin/projects/:id — only a project nobody ever submitted:
    // a submission is the record a fee is charged from and is never deleted.
    // One batch, and every statement re-checks "this photographer's, and no
    // submission" itself, so a submit that lands after the check below makes
    // the whole batch a no-op instead of orphaning its row or losing it. The
    // project row goes last because the others' gate reads it. R2 is never
    // touched: the photos belong to the shoot, not to the project.
    if (request.method === 'DELETE' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[4]) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      const hasSubmissions = () => jsonOk({ error: '已有送出紀錄，無法刪除（可改為封存）', code: 'has_submissions' }, 409);
      const found = await env.DB.prepare(
        'SELECT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?1) AS submitted FROM projects WHERE id = ?1 AND photographer_id = ?2'
      ).bind(id, DEFAULT_PHOTOGRAPHER_ID).first();
      if (!found) return jsonErr('Not found', 404);
      if (found.submitted) return hasSubmissions();
      const gate = 'EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND photographer_id = ?2) AND NOT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?1)';
      const del = sql => env.DB.prepare(`${sql} AND ${gate}`).bind(id, DEFAULT_PHOTOGRAPHER_ID);
      const results = await env.DB.batch([
        del('DELETE FROM selections WHERE project_id = ?1'),
        del('DELETE FROM pickers WHERE project_id = ?1'),
        del('DELETE FROM project_members WHERE project_id = ?1'),
        del("DELETE FROM share_tokens WHERE kind = 'pick' AND project_id = ?1"),
        del('DELETE FROM projects WHERE id = ?1'),
      ]);
      if (!results[4].meta?.changes) {
        const still = await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND photographer_id = ?')
          .bind(id, DEFAULT_PHOTOGRAPHER_ID).first();
        return still ? hasSubmissions() : jsonErr('Not found', 404);
      }
      return jsonOk({ ok: true }, 200, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/links — a fresh pick link for a project
    // whose link leaked or was revoked. Same snapshot as the project (not the
    // old link's, not the body's), same expiry as at creation. The old links
    // stay as they are; POST /api/shares/:token/revoke kills one.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && pathParts[4] === 'links' && !pathParts[5]) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const project = await env.DB.prepare('SELECT id, title, folders, archived_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], DEFAULT_PHOTOGRAPHER_ID).first();
      if (!project) return jsonErr('Not found', 404);
      const archivedErr = () => jsonOk({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
      if (project.archived_at) return archivedErr();
      const token = newShareToken();
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + SHARE_TTL_MS).toISOString();
      // Gated on the project still being open, so an archive landing between
      // the read above and this write leaves no live link behind it.
      const minted = await env.DB.prepare(
        "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) SELECT ?, '', ?, 'pick', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)"
      ).bind(token, project.title, project.id, project.folders, createdAt, expiresAt, project.id).run();
      if (!minted.meta || !minted.meta.changes) return archivedErr();
      return jsonOk({ token, expires_at: expiresAt, created_at: createdAt, status: 'live' }, 201, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/deliver — the finished photos went out.
    // A stamp, not a phase (the phase CHECK cannot change without a table
    // rebuild): only from 'retouching', so the guest's writes stay refused.
    // A second press keeps the first stamp.
    // POST /api/admin/projects/:id/undeliver — clear it (reopen clears it too).
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[5] &&
        (pathParts[4] === 'deliver' || pathParts[4] === 'undeliver')) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      if (pathParts[4] === 'undeliver') {
        const result = await env.DB.prepare('UPDATE projects SET delivered_at = NULL WHERE id = ? AND photographer_id = ?')
          .bind(id, DEFAULT_PHOTOGRAPHER_ID).run();
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        return jsonOk({ ok: true, delivered_at: null }, 200, ADMIN_ONLY_HEADERS);
      }
      const at = new Date().toISOString();
      const result = await env.DB.prepare(
        "UPDATE projects SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND photographer_id = ? AND phase = 'retouching'"
      ).bind(at, id, DEFAULT_PHOTOGRAPHER_ID).run();
      const row = await env.DB.prepare('SELECT phase, delivered_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, DEFAULT_PHOTOGRAPHER_ID).first();
      if (!row) return jsonErr('Not found', 404);
      // No change, or a reopen landed between the write and this read and
      // cleared the stamp: either way the project is not delivered now.
      if (!result.meta?.changes || !row.delivered_at) {
        return jsonOk({ error: '尚未開始修圖，無法標記為已交付', code: 'not_retouching', phase: row.phase }, 409, ADMIN_ONLY_HEADERS);
      }
      return jsonOk({ ok: true, delivered_at: row.delivered_at }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/admin/stats — the dashboard's counts, this photographer only.
    // One pass over projects for the counts, one for the months (Taipei
    // month boundaries: the stored timestamps are UTC ISO strings).
    if (url.pathname === '/api/admin/stats') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (request.method !== 'GET') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const c = await env.DB.prepare(
        `SELECT
           COALESCE(SUM(p.archived_at IS NULL AND p.phase = 'picking'), 0) AS picking,
           COALESCE(SUM(p.archived_at IS NULL AND p.phase = 'submitted'), 0) AS submitted,
           COALESCE(SUM(p.archived_at IS NULL AND p.phase = 'retouching' AND p.delivered_at IS NULL), 0) AS retouching,
           COALESCE(SUM(p.delivered_at IS NOT NULL), 0) AS delivered,
           COALESCE(SUM(p.archived_at IS NOT NULL), 0) AS archived,
           COALESCE(SUM(p.archived_at IS NULL AND p.modified_after_submit = 1), 0) AS modified,
           COALESCE(SUM(p.archived_at IS NULL AND ${PICK_UNNOTIFIED_SQL} > 0), 0) AS unnotified
           FROM projects p WHERE p.photographer_id = ?`
      ).bind(DEFAULT_PHOTOGRAPHER_ID).first();
      const { months, since } = statsMonths(Date.now());
      const { results: monthly } = await env.DB.prepare(
        `SELECT month, SUM(c) AS created, SUM(d) AS delivered FROM (
           SELECT strftime('%Y-%m', created_at, '+8 hours') AS month, 1 AS c, 0 AS d
             FROM projects WHERE photographer_id = ?1 AND created_at >= ?2
           UNION ALL
           SELECT strftime('%Y-%m', delivered_at, '+8 hours'), 0, 1
             FROM projects WHERE photographer_id = ?1 AND delivered_at >= ?2
         ) GROUP BY month`
      ).bind(DEFAULT_PHOTOGRAPHER_ID, since).all();
      const byMonth = new Map(monthly.map(r => [r.month, r]));
      return jsonOk({
        by_phase: { picking: c.picking, submitted: c.submitted, retouching: c.retouching },
        delivered: c.delivered,
        archived: c.archived,
        per_month: months.map(month => ({
          month,
          created: byMonth.get(month)?.created ?? 0,
          delivered: byMonth.get(month)?.delivered ?? 0,
        })),
        todo: {
          submitted_not_retouching: c.submitted,
          unnotified_submissions: c.unnotified,
          modified_after_submit: c.modified,
        },
      }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET/PUT /api/admin/settings — the studio's name, booking link and
    // default plan. PUT changes only the fields it names (null clears one);
    // anything else in the body is ignored, photographer_id above all.
    if (url.pathname === '/api/admin/settings') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (request.method !== 'GET' && request.method !== 'PUT') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonErr('Invalid body');
        const bad = field => jsonOk({ error: `${field} 格式不正確`, code: `invalid_${field}` }, 400);
        const has = k => Object.prototype.hasOwnProperty.call(body, k);
        const set = {};
        if (has('studio_name')) {
          const v = body.studio_name;
          if (v !== null && typeof v !== 'string') return bad('studio_name');
          const name = v === null ? '' : v.trim();
          if (charCount(name) > STUDIO_NAME_MAX) return bad('studio_name');
          set.studio_name = name || null;
        }
        if (has('booking_url')) {
          const v = body.booking_url;
          if (v !== null && typeof v !== 'string') return bad('booking_url');
          const raw = v === null ? '' : v.trim();
          if (raw) {
            const clean = cleanBookingUrl(raw);
            if (!clean) return bad('booking_url');
            set.booking_url = clean;
          } else {
            set.booking_url = null;
          }
        }
        for (const field of STUDIO_INT_FIELDS) {
          if (!has(field)) continue;
          const v = body[field];
          if (v !== null && !(Number.isSafeInteger(v) && v >= 0)) return bad(field);
          set[field] = v;
        }
        // column names come from the fixed list above, never from the body
        const cols = [...Object.keys(set), 'updated_at'];
        const all = ['photographer_id', ...cols];
        await env.DB.prepare(
          `INSERT INTO studio_settings (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
          `ON CONFLICT(photographer_id) DO UPDATE SET ${cols.map(k => `${k} = excluded.${k}`).join(', ')}`
        ).bind(DEFAULT_PHOTOGRAPHER_ID, ...Object.values(set), new Date().toISOString()).run();
      }
      return jsonOk(await readStudioSettings(env, DEFAULT_PHOTOGRAPHER_ID), 200, ADMIN_ONLY_HEADERS);
    }

    // PUT /api/admin/settings/logo — raw bytes, ≤ LOGO_MAX_BYTES, PNG / JPEG
    // / WebP by magic bytes (415 otherwise). Kept in D1, not R2: the bucket's
    // lifecycle rule deletes everything after 180 days.
    // DELETE /api/admin/settings/logo — remove it; the rest stays.
    if (url.pathname === '/api/admin/settings/logo') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (request.method !== 'PUT' && request.method !== 'DELETE') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = new Date().toISOString();
      if (request.method === 'DELETE') {
        await env.DB.prepare(
          'UPDATE studio_settings SET logo = NULL, logo_type = NULL, logo_updated_at = NULL, updated_at = ? WHERE photographer_id = ?'
        ).bind(now, DEFAULT_PHOTOGRAPHER_ID).run();
        return jsonOk({ ok: true, has_logo: false }, 200, ADMIN_ONLY_HEADERS);
      }
      const bytes = await readBodyCapped(request, LOGO_MAX_BYTES);
      if (!bytes) return jsonOk({ error: `Logo 不可超過 ${LOGO_MAX_BYTES / 1024} KB`, code: 'too_large', max: LOGO_MAX_BYTES }, 413);
      const type = sniffImageType(bytes);
      if (!type) return jsonOk({ error: 'Logo 只接受 PNG、JPEG 或 WebP', code: 'unsupported_type' }, 415);
      await env.DB.prepare(
        'INSERT INTO studio_settings (photographer_id, logo, logo_type, logo_updated_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(photographer_id) DO UPDATE SET logo = excluded.logo, logo_type = excluded.logo_type, ' +
        'logo_updated_at = excluded.logo_updated_at, updated_at = excluded.updated_at'
      ).bind(DEFAULT_PHOTOGRAPHER_ID, bytes.buffer, type, now, now).run();
      return jsonOk({ ok: true, has_logo: true, logo_type: type, logo_updated_at: now, size: bytes.byteLength }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/studio/logo — public: the guest page shows it. Served as the
    // type its bytes are (re-sniffed, so a hand-edited row cannot turn it into
    // something a browser would run), never sniffed by the browser, and under
    // a CSP that lets it run nothing even if opened directly.
    if (url.pathname === '/api/studio/logo') {
      if (request.method !== 'GET') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('Not found', 404);
      let row = null;
      try {
        row = await env.DB.prepare(
          'SELECT logo, logo_updated_at FROM studio_settings WHERE photographer_id = ? AND logo IS NOT NULL'
        ).bind(DEFAULT_PHOTOGRAPHER_ID).first();
      } catch { row = null; }
      // D1 hands a BLOB back as an array of byte values
      const bytes = row ? new Uint8Array(row.logo) : null;
      const type = bytes && sniffImageType(bytes);
      if (!type) return jsonErr('Not found', 404);
      const headers = {
        ...corsHeaders,
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'public, max-age=300',
      };
      const stamp = String(row.logo_updated_at || '');
      if (/^[0-9A-Za-z:.+-]+$/.test(stamp)) {
        headers.ETag = `"${stamp}"`;
        const inm = (request.headers.get('If-None-Match') || '').split(',').map(s => s.trim().replace(/^W\//, ''));
        if (inm.includes(headers.ETag)) return new Response(null, { status: 304, headers });
      }
      return new Response(bytes, { status: 200, headers });
    }

    // GET /api/shares/minted — the studio and client-session tokens that are
    // live right now. Neither kind carries a book_id, so the per-album list
    // below cannot show them and until this route nothing could: a photographer
    // could not answer "what is out there holding my bucket open".
    if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] === 'minted' && !pathParts[3]) {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const { results } = await env.DB.prepare(
        "SELECT token, kind, user_id, folders, created_at, expires_at FROM share_tokens WHERE kind IN ('studio', 'session') AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
      ).bind(new Date().toISOString()).all();
      return jsonOk(results);
    }

    // POST /api/shares/minted/revoke-all — what a photographer reaches for when
    // they think the password leaked. Rotating PHOTOGRAPHER_TOKEN alone does
    // not reach an already-minted token, and no other route could name one.
    // The two minted kinds are named positively, so the album links sitting in
    // clients' chats — which are the expensive thing to kill by accident — are
    // spared, including every row that predates the kind column.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] === 'minted' && pathParts[3] === 'revoke-all') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const result = await env.DB.prepare(
        "UPDATE share_tokens SET revoked_at = ? WHERE kind IN ('studio', 'session') AND revoked_at IS NULL"
      ).bind(new Date().toISOString()).run();
      return jsonOk({ ok: true, revoked: result.meta?.changes ?? 0 });
    }

    // POST /api/shares/:token/revoke — kill a link that went to the wrong chat
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] && pathParts[3] === 'revoke') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const result = await env.DB.prepare(
        'UPDATE share_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL'
      ).bind(new Date().toISOString(), pathParts[2]).run();
      if (!result.meta?.changes) return jsonErr('Not found', 404);
      return jsonOk({ ok: true });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PICK ROUTES — a guest reaches these with a pick link, and nothing else
    // reaches them. Ahead of the book routes and, for PUT, of the upload
    // route, which would otherwise take `PUT /api/pick/selections` as a key.
    // ═══════════════════════════════════════════════════════════════════════

    if (pathParts[0] === 'api' && pathParts[1] === 'pick') {
      if (!env.DB) return jsonErr('DB not configured', 500);
      const s = await share();
      const ctxPick = await resolvePick(s, request, env);
      if (!ctxPick) return jsonErr('Unauthorized', 401);
      const { project, picker, isOwner } = ctxPick;
      const route = pathParts.slice(2).join('/');

      // GET /api/pick/state — what anyone holding the link may see
      if (request.method === 'GET' && route === 'state') {
        await touchShareToken(s, request, env);
        // notes are the owner's own words to the photographer: a viewer sees
        // what was picked and how it was rated, never the note
        const { results: selections } = await env.DB.prepare(
          `SELECT photo_key, rating${isOwner ? ', note' : ''} FROM selections WHERE project_id = ? ORDER BY photo_key`
        ).bind(project.id).all();
        // the owner learns when the project was last submitted and whether they
        // changed anything since; a viewer only which phase it is in
        const last = isOwner ? await env.DB.prepare(
          'SELECT created_at FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        ).bind(project.id).first() : null;
        return jsonOk({
          project: { id: project.id, title: project.title, pick_limit: project.pick_limit, extra_price: project.extra_price },
          folders: s.folders,
          owner: await pickOwnerName(env, project.id),
          is_owner: isOwner,
          phase: project.phase,
          ...(isOwner ? { modified_after_submit: project.modified_after_submit } : {}),
          submitted_at: last ? last.created_at : null,
          selections,
          studio: await pickStudio(env, project.photographer_id),
        }, 200, SHARED_LINK_HEADERS);
      }

      // POST /api/pick/claim {name} — take the seat
      if (request.method === 'POST' && route === 'claim') {
        let body;
        try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name || charCount(name) > PICK_NAME_MAX) return jsonErr(`請輸入 1–${PICK_NAME_MAX} 字的名字`);
        const pickerId = crypto.randomUUID();
        // returned once and never stored: the row keeps its hash
        const key = newShareToken();
        await env.DB.prepare(
          'INSERT INTO pickers (id, project_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(pickerId, project.id, await sha256Hex(key), name, new Date().toISOString()).run();
        // The whole claim is this one conditional statement. Checking the seat
        // first and writing it second would let two guests tapping at once
        // both read it free and both believe they hold it.
        const won = await env.DB.prepare(
          'UPDATE projects SET owner_picker_id = ? WHERE id = ? AND owner_picker_id IS NULL AND archived_at IS NULL'
        ).bind(pickerId, project.id).run();
        if (!won.meta?.changes) {
          await env.DB.prepare('DELETE FROM pickers WHERE id = ?').bind(pickerId).run();
          // archived since the link was checked: the link is dead now
          const still = await env.DB.prepare('SELECT archived_at FROM projects WHERE id = ?').bind(project.id).first();
          if (still?.archived_at) return jsonErr('Unauthorized', 401);
          return jsonOk({ error: '已有人在挑選', owner: await pickOwnerName(env, project.id) }, 409);
        }
        return jsonOk({ picker_key: key, picker_id: pickerId, owner: name });
      }

      // PUT /api/pick/selections {upsert: [{photo_key, rating, note}], delete: [photo_key]}
      if (request.method === 'PUT' && route === 'selections') {
        if (!isOwner) return jsonErr('只有挑選人可以修改', 403);
        if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
        let body;
        try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonErr('Invalid body');
        const upsert = body.upsert ?? [];
        const remove = body.delete ?? [];
        if (!Array.isArray(upsert) || !Array.isArray(remove)) return jsonErr('upsert and delete must be arrays');
        if (upsert.length + remove.length > PICK_KEYS_MAX) return jsonErr(`一次最多 ${PICK_KEYS_MAX} 張`);
        // every item is checked before anything is written, so a refused save
        // leaves nothing half-applied
        const byKey = new Map();
        for (const item of upsert) {
          if (!item || typeof item !== 'object' || typeof item.photo_key !== 'string') return jsonErr('Invalid item');
          const rating = item.rating === undefined ? 0 : item.rating;
          if (!Number.isInteger(rating) || rating < 0 || rating > PICK_RATING_MAX) return jsonErr('Invalid rating');
          const note = item.note === undefined ? '' : item.note;
          if (typeof note !== 'string' || charCount(note) > PICK_NOTE_MAX) return jsonErr(`備註最多 ${PICK_NOTE_MAX} 字`);
          if (!pickKeyValid(item.photo_key)) return pickKeyInvalid();
          if (!pickKeyAllowed(s, item.photo_key)) return jsonErr('照片不在開放資料夾內', 403);
          // a key named twice is written once, as its last mention
          byKey.delete(item.photo_key);
          byKey.set(item.photo_key, { k: item.photo_key, r: rating, n: note });
        }
        const items = [...byKey.values()];
        for (const k of remove) {
          if (typeof k !== 'string') return jsonErr('Invalid item');
          if (!pickKeyValid(k)) return pickKeyInvalid();
          if (!pickKeyAllowed(s, k)) return jsonErr('照片不在開放資料夾內', 403);
        }
        if (!items.length && !remove.length) return jsonOk({ ok: true });
        // One statement per direction however many photos, because D1 caps the
        // queries one invocation may run. They go as one batch, which D1 runs
        // as a transaction, and every statement re-checks the seat and the
        // phase itself: a seat reset or a start-retouch that lands after the
        // checks above still wins, and wins for the whole save. The first
        // statement is the gate: it raises modified_after_submit when the
        // project was already submitted, and its row count says whether the
        // save was allowed at all.
        //
        // The caps ride in the same condition. What this save leaves — the
        // rows there now, overwritten by the upserts, minus the deletes — must
        // hold at most PICK_MAX_SELECTIONS starred rows and PICK_MAX_ROWS rows
        // in all, or at least no more of either than there are now (so
        // re-rating, un-starring or deleting in a project already over still
        // works). Every statement re-checks both against the rows as they
        // stand inside the transaction, so two racing saves cannot both fit.
        // Upserts go before deletes: a key in both ends up deleted either way.
        const upsertKeys = JSON.stringify(items.map(i => i.k));
        const removeKeys = JSON.stringify(remove);
        const notRemoved = 'NOT IN (SELECT value FROM json_each(?4))';
        const starsFit =
          `((SELECT COUNT(*) FROM json_each(?6) WHERE json_extract(value, '$.r') > 0 AND json_extract(value, '$.k') ${notRemoved}) + ` +
          `(SELECT COUNT(*) FROM selections WHERE project_id = ?1 AND rating > 0 AND photo_key NOT IN (SELECT value FROM json_each(?3)) AND photo_key ${notRemoved})) ` +
          '<= MAX(?5, (SELECT COUNT(*) FROM selections WHERE project_id = ?1 AND rating > 0))';
        const rowsFit =
          '(SELECT COUNT(*) FROM (SELECT photo_key FROM selections WHERE project_id = ?1 UNION SELECT value FROM json_each(?3)) ' +
          `WHERE photo_key ${notRemoved}) ` +
          '<= MAX(?7, (SELECT COUNT(*) FROM selections WHERE project_id = ?1))';
        const open = `id = ?1 AND owner_picker_id = ?2 AND phase IN ${PICK_OPEN_SQL} AND archived_at IS NULL AND ${starsFit} AND ${rowsFit}`;
        const gate = `EXISTS (SELECT 1 FROM projects WHERE ${open})`;
        const gateArgs = [project.id, picker.id, upsertKeys, removeKeys, PICK_MAX_SELECTIONS, JSON.stringify(items), PICK_MAX_ROWS];
        const writes = [env.DB.prepare(
          "UPDATE projects SET modified_after_submit = CASE WHEN phase = 'submitted' THEN 1 ELSE modified_after_submit END " +
          `WHERE ${open}`
        ).bind(...gateArgs)];
        if (items.length) {
          writes.push(env.DB.prepare(
            'INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) ' +
            "SELECT ?1, json_extract(value, '$.k'), json_extract(value, '$.r'), json_extract(value, '$.n'), ?2, ?8 " +
            `FROM json_each(?6) WHERE ${gate} ` +
            'ON CONFLICT(project_id, photo_key) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
          ).bind(...gateArgs, new Date().toISOString()));
        }
        if (remove.length) {
          writes.push(env.DB.prepare(
            `DELETE FROM selections WHERE project_id = ?1 AND photo_key IN (SELECT value FROM json_each(?4)) AND ${gate}`
          ).bind(...gateArgs));
        }
        const [allowed] = await env.DB.batch(writes);
        if (!allowed.meta?.changes) {
          return pickRefused(env, project.id, '只有挑選人可以修改', {
            pickerId: picker.id,
            // only which message to show; the writes above already decided
            refused: async () => (await env.DB.prepare(`SELECT ${rowsFit} AS ok`).bind(...gateArgs).first())?.ok
              ? jsonOk({ error: `最多只能選 ${PICK_MAX_SELECTIONS} 張`, code: 'selection_cap', max: PICK_MAX_SELECTIONS }, 409)
              : jsonOk({ error: `最多只能保留 ${PICK_MAX_ROWS} 筆`, code: 'row_cap', max: PICK_MAX_ROWS }, 409),
          });
        }
        return jsonOk({ ok: true });
      }

      // POST /api/pick/submit {relationship, email?}
      if (request.method === 'POST' && route === 'submit') {
        if (!isOwner) return jsonErr('只有挑選人可以送出', 403);
        if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
        let body;
        try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
        const { relationship, email } = (body && typeof body === 'object') ? body : {};
        if (!PICK_RELATIONSHIPS.includes(relationship)) return jsonErr('請選擇與新人的關係');
        let mail = null;
        if (email !== undefined && email !== null) {
          if (typeof email !== 'string') return jsonErr('Invalid email');
          const trimmed = email.trim();
          if (trimmed) {
            if (charCount(trimmed) > PICK_EMAIL_MAX || !/^[^\s@]+@[^\s@]+$/.test(trimmed)) return jsonErr('Email 格式不正確');
            mail = trimmed;
          }
        }
        // One transaction, every statement conditional on the seat and the
        // phase. The snapshot is read inside the INSERT itself — picked = at
        // least one star, the same thing the grid counts — together with the
        // limit and price as they stand now: the record any extra-photo fee is
        // charged from, which a later change to the plan must not rewrite.
        // A snapshot equal to the latest submission's is a repeat: no row, but
        // the rest of the submit (contact info, phase, flag) still lands. A
        // new row needs the project under PICK_MAX_SUBMISSIONS; both checks
        // are inside the statements, so nothing landing between the route's
        // reads and its writes can slip past them. The UPDATEs run after the
        // INSERT, so a row it just added makes them see a repeat.
        const submissionId = crypto.randomUUID();
        const submittedAt = new Date().toISOString();
        const picked = 'SELECT photo_key FROM selections WHERE project_id = p.id AND rating > 0 ORDER BY photo_key';
        const snapshot = `(SELECT json_group_array(photo_key) FROM (${picked}))`;
        // both sides built by json_group_array over keys in the same order
        const repeat = `(SELECT photo_keys FROM submissions WHERE project_id = p.id ORDER BY rowid DESC LIMIT 1) IS ${snapshot}`;
        const room = `(SELECT COUNT(*) FROM submissions WHERE project_id = p.id) < ${PICK_MAX_SUBMISSIONS}`;
        const open = `p.id = ? AND p.owner_picker_id = ? AND p.phase IN ${PICK_OPEN_SQL} AND p.archived_at IS NULL`;
        const [inserted, , moved] = await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO submissions (id, project_id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at) ' +
            `SELECT ?, p.id, ?, ?, ?, ${snapshot}, (SELECT COUNT(*) FROM (${picked})), ` +
            `p.pick_limit, p.extra_price, ? FROM projects p WHERE ${open} AND NOT (${repeat}) AND ${room}`
          ).bind(submissionId, picker.id, relationship, mail, submittedAt, project.id, picker.id),
          // the latest contact info stays on the picker
          env.DB.prepare(
            `UPDATE pickers SET relationship = ?, email = ? WHERE id = ? AND EXISTS (SELECT 1 FROM projects p WHERE ${open} AND (${repeat} OR ${room}))`
          ).bind(relationship, mail, picker.id, project.id, picker.id),
          env.DB.prepare(
            `UPDATE projects SET phase = 'submitted', modified_after_submit = 0 WHERE id IN (SELECT p.id FROM projects p WHERE ${open} AND (${repeat} OR ${room}))`
          ).bind(project.id, picker.id),
        ]);
        if (!moved.meta?.changes) {
          return pickRefused(env, project.id, '只有挑選人可以送出', {
            pickerId: picker.id,
            refused: () => jsonOk({
              error: `送出次數已達上限（${PICK_MAX_SUBMISSIONS} 次），請聯絡攝影師`,
              code: 'submission_cap', max: PICK_MAX_SUBMISSIONS,
            }, 409),
          });
        }
        // the row this submit stands for: its own, or for a repeat the latest
        // one, which it matched
        const recordId = inserted.meta?.changes ? submissionId
          : (await env.DB.prepare('SELECT id FROM submissions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').bind(project.id).first())?.id;
        // this row and the last one before it that the photographer was
        // emailed about: the email tells them everything since then, and a
        // submit that matches what they were told is not worth an email
        const { results: lastTwo } = await env.DB.prepare(
          'SELECT * FROM submissions WHERE project_id = ?1 AND (id = ?2 OR (notified = 1 AND rowid < (SELECT rowid FROM submissions WHERE id = ?2))) ORDER BY rowid DESC LIMIT 2'
        ).bind(project.id, recordId).all();
        const [record, previous] = lastTwo.map(r => ({ ...r, photo_keys: parsePhotoKeys(r.photo_keys) }));
        // the guest is not kept waiting on a mail server, and a mail server
        // that fails does not take the submit down with it. The row above is
        // written either way; only the email is skipped — for a row already
        // emailed about (a repeat of it), for a submit that picked the same
        // photos as the last emailed one, and for any submit inside
        // PICK_NOTIFY_INTERVAL_MS of the last email. The slot is taken with
        // one conditional UPDATE, so of two racing submits one mails; a send
        // that fails hands it back, unless someone has taken it since.
        const notify = Promise.resolve()
          .then(async () => {
            if (record.notified) return false;
            if (previous && samePhotoKeys(record.photo_keys, previous.photo_keys)) return false;
            const before = (await env.DB.prepare('SELECT last_notified_at FROM projects WHERE id = ?').bind(project.id).first())?.last_notified_at ?? null;
            const sentAt = Date.now();
            const mine = new Date(sentAt).toISOString();
            const slot = await env.DB.prepare(
              'UPDATE projects SET last_notified_at = ? WHERE id = ? AND last_notified_at IS ? AND (last_notified_at IS NULL OR last_notified_at <= ?)'
            ).bind(mine, project.id, before, new Date(sentAt - PICK_NOTIFY_INTERVAL_MS).toISOString()).run();
            if (!slot.meta?.changes) return false;
            let sent = false;
            try {
              sent = await sendPickNotification(env, project, picker, record, previous || null);
            } finally {
              if (!sent) {
                await env.DB.prepare('UPDATE projects SET last_notified_at = ? WHERE id = ? AND last_notified_at = ?')
                  .bind(before, project.id, mine).run();
              }
            }
            if (!sent) return false;
            // only a mail actually handed over counts; anything else stays in
            // the admin's unnotified_submissions badge
            await env.DB.prepare('UPDATE submissions SET notified = 1 WHERE id = ?').bind(record.id).run();
            return true;
          })
          .catch(e => console.error('pick notification failed:', e?.message || e));
        if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
        const { count, pick_limit: limit, extra_price: price } = record;
        return jsonOk({
          ok: true, phase: 'submitted', submission_id: record.id, submitted_at: record.created_at,
          count, limit, price, over: limit == null ? 0 : Math.max(0, count - limit),
        });
      }

      return jsonErr('Not found', 404);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BOOK / R2 ROUTES — a client reaches these with a share token
    // ═══════════════════════════════════════════════════════════════════════

    if (pathParts[0] === 'api' && pathParts[1] === 'books' && pathParts[2]) {
      const bookId = pathParts[2];
      const admin = isAdminToken(request, env);

      // POST /api/books/:id/share — mint a link for this album
      if (request.method === 'POST' && pathParts[3] === 'share') {
        if (!admin) return jsonErr('Unauthorized', 401);
        if (!env.DB) return jsonErr('DB not configured', 500);
        const obj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        let book;
        try { book = JSON.parse(await obj.text()); }
        catch { return new Response('Invalid book data', { status: 500, headers: corsHeaders }); }
        let body;
        try { body = await request.json(); } catch { body = {}; }
        const token = newShareToken();
        const now = Date.now();
        const expiresAt = new Date(now + SHARE_TTL_MS).toISOString();
        await env.DB.prepare(
          'INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          token, bookId, String(body?.label ?? '').slice(0, 200),
          JSON.stringify(Array.isArray(book.clientFolders) ? book.clientFolders : []),
          new Date(now).toISOString(), expiresAt
        ).run();
        return jsonOk({ token, expires_at: expiresAt });
      }

      // GET /api/books/:id/shares — which links are out there, to revoke one
      if (request.method === 'GET' && pathParts[3] === 'shares') {
        if (!admin) return jsonErr('Unauthorized', 401);
        if (!env.DB) return jsonErr('DB not configured', 500);
        const { results } = await env.DB.prepare(
          'SELECT token, label, created_at, expires_at, revoked_at, last_seen_at FROM share_tokens WHERE book_id = ? ORDER BY created_at DESC'
        ).bind(bookId).all();
        return jsonOk(results);
      }

      // Everything below is the client-facing album. Without the photographer
      // token it needs a live share token issued for THIS book.
      // null for the photographer; the routes below treat that as "no limits
      // beyond the book's own policy"
      let bookShare = null;
      if (!admin) {
        bookShare = await share();
        // a minted token signs <img> URLs; every book route is driven by
        // fetch, which can carry the real credential — the photographer's, or
        // the client's D1 session — in a header instead
        // nor is a pick link an album link, whatever its book_id says
        if (!bookShare || isMintedShare(bookShare) || isPickShare(bookShare) || bookShare.book_id !== bookId) {
          return jsonErr('Unauthorized', 401);
        }
        await touchShareToken(bookShare, request, env);
      }

      if (request.method === 'GET' && !pathParts[3]) {
        const obj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        const text = await obj.text();
        if (!bookShare) {
          return new Response(text, {
            // `no-cache` so a saved edit is never served stale, and `private`
            // because this is the whole book, notifyUrl included: no-cache
            // governs whether a stored response may be served, not whether it
            // may be stored, so a shared cache would otherwise be entitled to
            // keep a live webhook bearer secret on disk.
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' }
          });
        }
        // The stored book carries notifyUrl — a bearer webhook the client
        // would get in full, and that revoking this link does NOT revoke. Hand
        // over a whitelist instead of trimming a blacklist, so a field added
        // to the editor later is private by default.
        let book;
        try { book = JSON.parse(text); }
        catch { return new Response('Invalid book data', { status: 500, headers: corsHeaders }); }
        return jsonOk({
          name: book.name,
          settings: book.settings,
          coverSettings: book.coverSettings,
          // the viewer restores these before it sanitises pages; without them
          // every custom-layout page silently falls back to a default one
          _customLayouts: book._customLayouts,
          // slot photoIds are left as they are even when the token cannot
          // fetch them: the viewer PATCHes `page.slots` back wholesale, so a
          // nulled slot would be written back as null and destroy the
          // photographer's placement
          pages: book.pages,
          // the token's own snapshot, not the book's current (possibly wider)
          // list — the viewer builds its photo picker from this
          clientFolders: bookShare.folders,
        }, 200, SHARED_LINK_HEADERS);
      }

      if (request.method === 'PUT' && !pathParts[3]) {
        if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
        await env.imagepicker.put(`_books/${bookId}.json`, await request.text(), {
          httpMetadata: { contentType: 'application/json' }
        });
        return jsonOk({ ok: true, id: bookId });
      }

      if (request.method === 'PATCH' && !pathParts[3]) {
        const obj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        let book;
        try { book = JSON.parse(await obj.text()); }
        catch { return new Response('Invalid book data', { status: 500, headers: corsHeaders }); }
        let body;
        try { body = await request.json(); }
        catch { return new Response('Invalid request body', { status: 400, headers: corsHeaders }); }
        const { pageIndex, slots } = body;
        if (typeof pageIndex !== 'number' || !book.pages?.[pageIndex]) {
          return jsonErr('無效的頁碼', 400);
        }
        const page = book.pages[pageIndex];
        if (page.locked) {
          return jsonErr('此頁已鎖定，無法修改', 403);
        }
        const clientFolders = Array.isArray(book.clientFolders) ? book.clientFolders : [];
        if (Array.isArray(slots)) {
          for (const slot of slots) {
            if (!slot) continue;
            // folderCovers calls startsWith on this and shareCovers splits it,
            // so a number or an array leaves the runtime to turn a TypeError
            // into a 1101. A falsy one still means "clear the slot".
            if (typeof slot.photoId !== 'string') {
              if (slot.photoId) return jsonErr('無效的照片', 400);
              continue;
            }
            if (!slot.photoId) continue;
            // the book's own policy, which applies to the photographer too
            if (clientFolders.length > 0 && !clientFolders.some(f => folderCovers(f, slot.photoId))) {
              return jsonErr('照片不在開放資料夾內', 403);
            }
            // and a share token is additionally held to the folders that were
            // snapshotted when the link was issued — no empty-list escape
            // hatch, because empty is the default for a new book
            if (bookShare && !shareCovers(bookShare, slot.photoId)) {
              return jsonErr('照片不在開放資料夾內', 403);
            }
          }
        }
        if (Array.isArray(slots)) {
          slots.forEach((newSlot, idx) => {
            if (!page.slots[idx] || !newSlot) return;
            if (newSlot.photoId !== undefined) page.slots[idx].photoId = newSlot.photoId;
            if (newSlot.crop !== undefined) page.slots[idx].crop = newSlot.crop;
          });
        }
        await env.imagepicker.put(`_books/${bookId}.json`, JSON.stringify(book), {
          httpMetadata: { contentType: 'application/json' }
        });
        return jsonOk({ ok: true });
      }

      if (request.method === 'GET' && pathParts[3] === 'status') {
        const obj = await env.imagepicker.get(`_books/${bookId}_status.json`);
        const data = obj ? await obj.text() : JSON.stringify({ approved: false });
        return new Response(data, {
          headers: {
            ...corsHeaders, 'Content-Type': 'application/json',
            ...(bookShare ? SHARED_LINK_HEADERS : ADMIN_ONLY_HEADERS),
          }
        });
      }

      if (request.method === 'POST' && pathParts[3] === 'approve') {
        // The client taps this, and so can anyone else holding the link. Only
        // the false→true transition is worth a message in the photographer's
        // chat — and a repeat is not an error, the viewer shows its success
        // state off this response.
        const prev = await env.imagepicker.get(`_books/${bookId}_status.json`);
        if (prev) {
          let already = false;
          // an unreadable status file fails toward notifying: a duplicate
          // message costs a line in a chat, a missed one costs the approval
          try { already = JSON.parse(await prev.text()).approved === true; } catch {}
          // the stored timestamp records when the client approved, which a
          // later tap does not change, so the whole row is left alone
          if (already) return jsonOk({ ok: true });
        }
        const status = { approved: true, timestamp: new Date().toISOString() };
        await env.imagepicker.put(`_books/${bookId}_status.json`, JSON.stringify(status), {
          httpMetadata: { contentType: 'application/json' }
        });
        const bookObj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (bookObj) {
          try {
            const book = JSON.parse(await bookObj.text());
            if (book.notifyUrl) {
              const notify = fetch(book.notifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  event: 'book_approved',
                  bookId,
                  bookName: book.name || '相本',
                  timestamp: status.timestamp,
                  message: `📸 客人已批准相本「${book.name || '相本'}」！`
                })
              }).catch(() => {});
              // don't make the client wait on a third-party server
              if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
            }
          } catch (e) { /* ignore notify errors */ }
        }
        return jsonOk({ ok: true });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    // PUT (upload) — admin only
    if (request.method === 'PUT') {
      if (!isAdminToken(request, env)) return jsonErr('Unauthorized', 401);
      let key = decodeURIComponent(url.pathname.slice(1));
      if (key.startsWith('_assets/')) key = key.slice('_assets/'.length);
      const contentType = request.headers.get('Content-Type') || 'image/jpeg';
      await env.imagepicker.put(key, request.body, { httpMetadata: { contentType } });
      return jsonOk({ ok: true, key });
    }

    // GET list
    const listPrefix = params.get('list');
    if (listPrefix !== null) {
      let listShare = null;
      if (!isAdminToken(request, env)) {
        listShare = await share();
        if (!listShare || !(isStudioShare(listShare) || shareCovers(listShare, listPrefix))) {
          return jsonErr('Unauthorized', 401);
        }
        await touchShareToken(listShare, request, env);
      }
      try {
        // R2 list() caps at 1000 per call — follow the cursor or folders with
        // more than 1000 photos silently lose everything past the first page
        const objects = [];
        const prefixes = [];
        let cursor;
        let truncated = true;
        while (truncated) {
          const listed = await env.imagepicker.list({
            prefix: listPrefix, delimiter: '/', cursor
          });
          objects.push(...listed.objects);
          prefixes.push(...(listed.delimitedPrefixes || []));
          cursor = listed.cursor;
          truncated = listed.truncated;
        }

        const files = objects
          .filter(obj => /\.(jpg|jpeg|png|webp|avif)$/i.test(obj.key))
          .map(obj => ({ id: obj.key, name: obj.key.split('/').pop(), size: obj.size, uploaded: obj.uploaded }));
        // hide internal folders (_thumbs/, _books/) from the folder picker
        const folders = prefixes.filter(p => {
          const name = p.split('/').filter(Boolean).pop() || '';
          return !name.startsWith('_');
        });
        return jsonOk({ status: 'success', data: files, folders }, 200,
          listShare ? SHARED_LINK_HEADERS : ADMIN_ONLY_HEADERS);
      } catch (e) {
        return jsonErr(e.message, 500);
      }
    }

    // GET object by key
    const key = decodeURIComponent(url.pathname.slice(1));
    if (key) {
      let viaShare = false;
      if (!isAdminToken(request, env)) {
        const s = await share();
        // checked on the source key, so a thumbnail of a book is a book, and
        // ahead of every kind — a studio token is unscoped, and a folder
        // snapshot naming `_books/` would be one editor typo away
        const source = sourceKey(key);
        if (!s || isInternalKey(source) || !(isStudioShare(s) || shareCovers(s, source))) {
          return jsonErr('Unauthorized', 401);
        }
        await touchShareToken(s, request, env);
        viaShare = true;
      }

      // ?w=N serves a pre-generated thumbnail (written at upload time) when one
      // exists, falling back to the original so old uploads keep working.
      const wanted = parseInt(params.get('w'), 10);
      const candidates = [];
      if (Number.isFinite(wanted) && wanted > 0 && !key.startsWith(THUMB_PREFIX)) {
        candidates.push(...thumbCandidates(wanted, key));
      }
      candidates.push(key);

      for (const candidate of candidates) {
        const isLast = candidate === candidates[candidates.length - 1];
        const object = await env.imagepicker.get(candidate, {
          onlyIf: request.headers,
          range: request.headers
        });
        if (!object) {
          if (isLast) return new Response('Object Not Found', { status: 404, headers: corsHeaders });
          continue; // no thumbnail for this key yet — fall back to the original
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Accept-Ranges', 'bytes');
        // a re-upload reuses the same key, so revalidate rather than pin for a
        // year; the conditional GET below makes revalidation a cheap 304.
        // `private` on both paths: a shared proxy would otherwise keep a photo
        // and hand it to the next request that guessed the URL — the share
        // form because the credential is in the query string, the admin form
        // because there is no credential in the URL to tell the two apart by.
        headers.set('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
        headers.set('Vary', viaShare ? 'X-Share-Token' : 'Authorization');

        // onlyIf failed the precondition → R2 returns metadata with no body
        if (!('body' in object)) {
          return new Response(null, { status: preconditionStatus(request), headers });
        }
        // Only a request that actually asked for a range gets a 206. R2 reports
        // a range covering the whole object whenever `range` is passed at all,
        // so trusting it alone served 206 to every <img> — which browsers
        // refuse to render.
        if (request.headers.has('Range') &&
            object.range && typeof object.range.offset === 'number') {
          const start = object.range.offset;
          const end = start + object.range.length - 1;
          headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
          return new Response(object.body, { status: 206, headers });
        }
        return new Response(object.body, { headers });
      }
    }

    return new Response('Invalid Request', { status: 400, headers: corsHeaders });
  }
};
