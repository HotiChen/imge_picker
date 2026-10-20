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

// ─── What the upload PUT may store, and how objects go out ──────────────────
// (security review of multi-photographer batch 3, finding 2.) The object route
// serves an object with its stored type, on the Worker's origin, so an upload
// that stored text/html or an SVG would be a page running script there.
//
// The types the object route serves inline (as the task and the rounds
// thumbnail route already do). Anything else stored goes out, under a key the
// picker lists (.jpg/.jpeg/.png/.webp/.avif), as that extension's own image
// type (a legacy photo stored as text/html, octet-stream or an alias), and
// otherwise — a legacy SVG or HTML upload, a HEIC / TIFF / GIF / BMP original
// — as application/octet-stream, as an attachment. Uploads keep the photos the
// picker shows on this list: the listing (`?list=`) only ever shows
// .jpg/.jpeg/.png/.webp/.avif keys, and a key with one of those extensions
// is only ever stored as one of these four types (below), so nothing the
// grid, a thumbnail fallback or the lightbox can ask for turns into a
// download. The other formats upload.html takes are never listed: they are
// kept as files, served as downloads.
const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const OCTET_STREAM = 'application/octet-stream';
// What upload.html takes (its IMAGE_EXTS) and the album editor's backgrounds
// are, by the key's extension (lowercased):
// - own: what is stored when the request names no type of its own — no
//   Content-Type, an empty one, or one listed in `asOwn`;
// - keep: the types stored as sent;
// - asOwn: accepted, but stored as `own`: application/octet-stream (what
//   upload.html sends when the browser knows no type) and, for the listed
//   extensions, the legacy aliases image/jpg, image/pjpeg, image/x-png —
//   never stored as such, so a listed photo is always served inline.
// HEIC / HEIF / TIFF / BMP keep octet-stream as sent (served as downloads
// anyway). Never HTML, SVG, XML or script, whatever the extension.
const LEGACY_IMAGE_ALIASES = ['image/jpg', 'image/pjpeg', 'image/x-png'];
const listedPhoto = own => ({ own, keep: INLINE_IMAGE_TYPES, asOwn: [...LEGACY_IMAGE_ALIASES, OCTET_STREAM] });
const UPLOAD_TYPES = Object.assign(Object.create(null), {
  jpg: listedPhoto('image/jpeg'),
  jpeg: listedPhoto('image/jpeg'),
  png: listedPhoto('image/png'),
  webp: listedPhoto('image/webp'),
  avif: listedPhoto('image/avif'),
  gif: { own: 'image/gif', keep: ['image/gif'], asOwn: [OCTET_STREAM] },
  heic: { own: 'image/heic', keep: ['image/heic', 'image/heic-sequence', OCTET_STREAM], asOwn: [] },
  heif: { own: 'image/heif', keep: ['image/heif', 'image/heif-sequence', OCTET_STREAM], asOwn: [] },
  tif: { own: 'image/tiff', keep: ['image/tiff', OCTET_STREAM], asOwn: [] },
  tiff: { own: 'image/tiff', keep: ['image/tiff', OCTET_STREAM], asOwn: [] },
  bmp: { own: 'image/bmp', keep: ['image/bmp', 'image/x-ms-bmp', OCTET_STREAM], asOwn: [] },
});
// upload.html's thumbnails: webp, or jpeg where the browser cannot encode webp
const THUMB_TYPES = { own: 'image/jpeg', keep: INLINE_IMAGE_TYPES, asOwn: [] };
const THUMB_KEY = /^_thumbs\/\d+\/(.+)\.thumb$/;
// A type as sent: lowercased, parameters off. '' when there is none.
const bareType = value => String(value ?? '').split(';')[0].trim().toLowerCase();
// The extension of a key's file name ('' for none, or a name that is only one).
function keyExtension(key) {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
// The Content-Type to store for an upload of `key` sent as `sent` (the
// request's Content-Type header, null when there is none), or null to refuse
// it (415). A photo key goes by its extension (UPLOAD_TYPES); a thumbnail
// `_thumbs/<w>/<photo key>.thumb` needs a photo key and one of the inline
// types (none: jpeg, as the route always defaulted to).
function uploadContentType(key, sent) {
  const thumb = THUMB_KEY.exec(key);
  const byExtension = UPLOAD_TYPES[keyExtension(thumb ? thumb[1] : key)];
  if (!byExtension) return null;
  const rule = thumb ? THUMB_TYPES : byExtension;
  const type = bareType(sent);
  // an empty Content-Type counts as none for a photo; a thumbnail keeps the
  // old rule (only a missing header defaults)
  if (sent === null || (!thumb && !type) || rule.asOwn.includes(type)) return rule.own;
  return rule.keep.includes(type) ? type : null;
}

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
// Compared in constant time (sameSecret), like the operator token. Called
// only from identify(): routes ask requirePhotographer / requireDefault.
function isAdminToken(request, env) {
  const secret = env.PHOTOGRAPHER_TOKEN;
  if (typeof secret !== 'string' || !secret) return false;
  return sameSecret(bearerToken(request), secret);
}

// ─── Operator auth (docs/products-orders.md, platform catalogue) ────────────
// The platform operator (Tim) until accounts exist: OPERATOR_TOKEN, a bearer
// header only (never ?t= or X-Share-Token). Fails CLOSED when unset, and when
// it equals PHOTOGRAPHER_TOKEN — one secret must never open both sides, or a
// photographer would see vendor costs. The compare walks the whole string so
// its time does not say how much of a guess was right.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

function isOperatorToken(request, env) {
  const secret = env.OPERATOR_TOKEN;
  if (typeof secret !== 'string' || !secret) return false;
  if (secret === env.PHOTOGRAPHER_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return sameSecret(token, secret);
}

// ─── Photographer accounts (docs/multi-photographer.md, batch 1) ────────────
// Register (pending) → the operator approves → email + password login gives a
// bearer session token, stored only as its SHA-256. A session opens
// /api/photographer/me, /logout and (batch 2a) /change-password; every other
// photographer route asks requirePhotographer (batch 2b-0), which lets a
// session in only while photographerRoutesOpen(env) — isAdminToken above
// still checks PHOTOGRAPHER_TOKEN only. After an operator reset-password the
// account must change its password first (must_change_password, enforced in
// resolvePhotographer). Registration is closed unless
// PHOTOGRAPHER_SIGNUP is exactly 'on' AND TURNSTILE_SECRET is set.
const PHOTOGRAPHERS_UNAVAILABLE = { error: '攝影師帳號功能尚未啟用', code: 'photographers_unavailable' };
const PHOTOGRAPHER_NO_STORE = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' };
const PHOTOGRAPHER_BODY_MAX = 16 * 1024;
// Cloudflare Workers caps PBKDF2 at 100,000 iterations; the count is kept in
// the stored string so a later raise does not break old hashes.
const PBKDF2_ITERATIONS = 100000;
const PHOTOGRAPHER_PASSWORD_MIN = 10;
const PHOTOGRAPHER_PASSWORD_MAX = 200;
const PHOTOGRAPHER_NAME_MAX = 50;
const PHOTOGRAPHER_NOTE_MAX = 300;
const PHOTOGRAPHER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PHOTOGRAPHER_SIGNUPS_PER_HOUR = 5;
// new sign-ups wait while this many are already pending (429 registration_busy)
const PHOTOGRAPHER_PENDING_MAX = 200;
// failed logins per key (the client's network, or the email) per window, then
// 429 too_many_attempts before any PBKDF2
const PHOTOGRAPHER_LOGIN_FAILURES_MAX = 10;
const PHOTOGRAPHER_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const TURNSTILE_TIMEOUT_MS = 5000;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Verified against when the email is unknown, so a miss costs the same
// PBKDF2 as a hit and the time does not say whether the account exists. Its
// password was random and thrown away.
const PHOTOGRAPHER_DUMMY_HASH = 'pbkdf2$100000$55043f7b9f20cfbde433f9affb41d139$baf8fbec1e748c3284fc7a85d0c9929128ff25cc0fb2ced92cb4b0be67075f15';
// what the operator may see of an account (never password_hash)
const PHOTOGRAPHER_PUBLIC_COLUMNS = 'id, email, display_name, studio_note, status, created_at, approved_at, last_login_at, dup_attempts, last_dup_at';
const PHOTOGRAPHER_LIST_MAX = 500;
// operator actions: the status each moves from and to (reset-password: any)
const PHOTOGRAPHER_ACTIONS = Object.assign(Object.create(null), {
  approve: { from: 'pending', to: 'active' },
  reject: { from: 'pending', to: null },
  suspend: { from: 'active', to: 'suspended' },
  unsuspend: { from: 'suspended', to: 'active' },
  'reset-password': { from: null, to: null },
});
// A temporary password the operator reads out to the photographer: 16 of 31
// unambiguous characters (no 0/o/1/l/i), ~79 bits, rejection-sampled so every
// character is equally likely.
const TEMP_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function tempPhotographerPassword(length = 16) {
  const limit = 256 - (256 % TEMP_PASSWORD_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < limit && out.length < length) out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
    }
  }
  return out;
}
const LOGIN_FAILED = { error: '帳號或密碼不正確，或帳號尚未開通', code: 'login_failed' };
// C0 / C1 controls, line / paragraph separators and bidi marks
const ACCOUNT_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
// the studio note keeps line breaks and tabs
const ACCOUNT_NOTE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

const bytesHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => bytesHex(crypto.getRandomValues(new Uint8Array(n)));

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function pbkdf2Hex(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return bytesHex(new Uint8Array(bits));
}

// pbkdf2$<iters>$<saltHex>$<hashHex>. Not the legacy hashPassword (client
// accounts), which is left alone.
async function hashPhotographerPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesHex(salt)}$${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`;
}

// Always one full PBKDF2: a stored string that does not parse (or names an
// iteration count Workers cannot run) is verified against the dummy instead
// and fails, rather than returning early or throwing.
async function verifyPhotographerPassword(password, stored) {
  const m = /^pbkdf2\$([1-9]\d{0,5})\$((?:[0-9a-f]{2}){8,64})\$([0-9a-f]{64})$/.exec(String(stored ?? ''));
  const iterations = m ? Number(m[1]) : 0;
  const usable = m && iterations <= PBKDF2_ITERATIONS;
  const [, , saltHex, hashHex] = usable ? m : /^pbkdf2\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(PHOTOGRAPHER_DUMMY_HASH);
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const derived = await pbkdf2Hex(String(password ?? ''), salt, usable ? iterations : PBKDF2_ITERATIONS);
  return sameSecret(derived, hashHex) && Boolean(usable);
}

// A plausible login name, printable ASCII only: one @, a local part of
// letters, digits and .!#$%&*+/=?^_{|}~- (no quotes, backquotes, backslashes
// or angle brackets), a domain of dotted letter / digit / hyphen labels, ≤ 254.
// Full-width look-alikes and IDN are refused, so one address has one spelling.
// Lowercased; null if not.
const PHOTOGRAPHER_EMAIL_RE = /^[a-z0-9.!#$%&*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
function photographerEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return PHOTOGRAPHER_EMAIL_RE.test(email) ? email : null;
}

// What a per-client limit keys on: the IPv4 address, or the /64 of an IPv6
// one (a single host is handed a whole /64, so the full address is free to
// change). 'unknown' without CF-Connecting-IP — one shared bucket.
function clientNetwork(request) {
  const ip = String(request.headers.get('CF-Connecting-IP') || '').trim().toLowerCase().slice(0, 64);
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);   // IPv4-mapped
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// Cloudflare Turnstile siteverify. Fails closed: anything but an explicit
// success: true (a network error, a non-200, a body that is not JSON, no
// answer within 5 s, a hostname other than TURNSTILE_HOSTNAME when that is
// set) is no.
async function turnstileVerified(token, request, env) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) form.set('remoteip', ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) });
    if (!res.ok) return false;
    const data = await res.json();
    if (data?.success !== true) return false;
    // only when configured: the widget must have been solved on our site
    return !env.TURNSTILE_HOSTNAME || data.hostname === env.TURNSTILE_HOSTNAME;
  } catch {
    return false;
  }
}

// The session's photographer, or null: the bearer token's SHA-256, a live
// session, an ACTIVE account — suspended is null at once. Throws when the
// tables are missing (the routes answer photographers_unavailable).
// must_change_password: true / false, or null before its column exists
// (2026-10-15 migration), which the guard treats as unknown.
// Reached only through resolvePhotographer (the guard): a test pins that.
async function lookupPhotographerSession(request, env) {
  const token = bearerToken(request);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const sql = flag => `SELECT p.id, p.display_name, p.email, ${flag} AS must_change_password FROM photographer_sessions s JOIN photographers p ON p.id = s.photographer_id WHERE s.token_hash = ? AND s.expires_at > ? AND p.status = 'active'`;
  const row = await withoutMissingColumn(
    () => env.DB.prepare(sql('p.must_change_password')).bind(tokenHash, now).first(),
    () => env.DB.prepare(sql('NULL')).bind(tokenHash, now).first(),
  );
  return row ? { id: row.id, display_name: row.display_name, email: row.email, must_change_password: mustChangeFlag(row.must_change_password) } : null;
}

// The stored flag as the API says it: null (no column yet) stays null, 0 is
// false, anything else true — an odd value fails closed.
function mustChangeFlag(value) {
  return value === null || value === undefined ? null : value !== 0;
}

// <photographer-route-guard>
// What a photographer session may open while must_change_password is set (an
// operator reset): change its password, ask who it is, log out. Read off the
// request itself — its method and its path with empty segments dropped, as
// the router splits it — never from anything a caller passes in, so no route
// can claim to be one of these three (2b-0, security review of 2a).
const PHOTOGRAPHER_MUST_CHANGE_ROUTES = Object.freeze(['GET api/photographer/me', 'POST api/photographer/logout', 'POST api/photographer/change-password']);
const PHOTOGRAPHER_UNAUTHORIZED = { error: 'Unauthorized', code: 'unauthorized' };
const MUST_CHANGE_PASSWORD = { error: '請先修改密碼', code: 'must_change_password' };
const PASSWORD_CHANGE_UNAVAILABLE = { error: '修改密碼功能尚未啟用', code: 'password_change_unavailable' };
// {status, body} to answer instead of the route, or null to let it run. Only
// must_change_password === false opens every route; true is 403, unknown
// (null: the column is missing) 500 — both only outside the three above.
function photographerRouteRefusal(who, request) {
  if (!who) return { status: 401, body: PHOTOGRAPHER_UNAUTHORIZED };
  if (who.must_change_password === false) return null;
  const route = `${request.method} ${new URL(request.url).pathname.split('/').filter(Boolean).join('/')}`;
  if (PHOTOGRAPHER_MUST_CHANGE_ROUTES.includes(route)) return null;
  if (who.must_change_password === true) return { status: 403, body: MUST_CHANGE_PASSWORD };
  return { status: 500, body: PASSWORD_CHANGE_UNAVAILABLE };
}
// </photographer-route-guard>

// The one way to learn which photographer a SESSION is (the /api/photographer
// routes, and requirePhotographer below for every other route):
// {who: {id, display_name, email, must_change_password}} or {refused: Response}
// (401 no live session — before the migration too; 403 / 500 the guard above,
// which reads the request's own method and path).
async function resolvePhotographer(request, env) {
  let who = null;
  if (env.DB) {
    try {
      who = await lookupPhotographerSession(request, env);
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
    }
  }
  const refusal = photographerRouteRefusal(who, request);
  // `who` rides along with a 403 / 500 so identify() can tell a session row
  // named 'default' apart; the /api/photographer routes answer `refused` only
  if (refusal) return { refused: jsonOk(refusal.body, refusal.status, PHOTOGRAPHER_NO_STORE), who };
  return { who };
}

// ─── Who is calling a photographer route (batch 2b-0) ─────────────────────
// The kill switch for every photographer but the default one: while it is
// off (anything but exactly "on", unset included) a photographer session
// opens no route outside /api/photographer/*, exactly as before batch 2b.
// It stays off until every isolation batch (2b-1..3, batch 3) is merged and
// reviewed. The operator's own toggle (a later batch) replaces this body.
function photographerRoutesOpen(env) {
  return env.PHOTOGRAPHER_ROUTES === 'on';
}

const UNAUTHORIZED = () => jsonErr('Unauthorized', 401);

// Who is calling, worked out once per request (the front and the route both
// ask): {who} | {nobody} | {squat} | {refusal: Response} | {error}.
// - PHOTOGRAPHER_TOKEN: the default photographer (fails closed when unset);
// - while photographerRoutesOpen(env): a live session of an active account,
//   through resolvePhotographer and its must_change_password guard (a 403 /
//   500 is `refusal`). A session row named 'default' is `squat`, refused
//   everywhere, flagged or not: only the token is the default photographer.
// - a lookup that throws (D1 down) is `error`: a photographer-only route
//   fails loudly, a route a share link also reaches goes on as anonymous.
async function identify(request, env) {
  if (isAdminToken(request, env)) return { who: { id: DEFAULT_PHOTOGRAPHER_ID } };
  if (!photographerRoutesOpen(env)) return { nobody: true };
  let session;
  try {
    session = await resolvePhotographer(request, env);
  } catch (error) {
    return { error };
  }
  if (session.who && session.who.id === DEFAULT_PHOTOGRAPHER_ID) return { squat: true };
  if (session.refused) return session.refused.status === 401 ? { nobody: true } : { refusal: session.refused };
  return { who: session.who };
}
const IDENTITY = new WeakMap();   // request → identify()'s promise
function photographerIdentity(request, env) {
  let found = IDENTITY.get(request);
  if (!found) IDENTITY.set(request, found = identify(request, env));
  return found;
}
// Requests whose route asked requirePhotographer / requireDefault. The front
// (export default fetch) refuses a photographer-only path whose route did not.
const GUARDED = new WeakSet();

// The one function every photographer route asks: {who: {id, ...}} or
// {refused: Response}. The caller's identity is this `who` and nothing else —
// never a photographer id from the body, the query or a header. Nobody (no
// token, an unknown one, or any session while the switch is off) gets
// `unauthorized()`, the route's own answer to no token, so with the switch
// off nothing changes for anybody. `optional: true` (a route a share link
// also reaches) gives {who: null} instead, and the route goes on to its
// share-link checks.
async function requirePhotographer(request, env, { optional = false, unauthorized = UNAUTHORIZED } = {}) {
  GUARDED.add(request);
  const found = await photographerIdentity(request, env);
  if (found.who) return { who: found.who };
  if (found.refusal) return { refused: found.refusal.clone() };
  if (found.squat) return { refused: unauthorized() };
  if (found.error && !optional) throw found.error;
  return optional ? { who: null } : { refused: unauthorized() };
}

// The paths only a photographer may reach, with each one's answer to nobody
// (null for any other path). The front asks who is calling before their
// handler runs, and refuses a response their handler made without asking
// requirePhotographer / requireDefault — a route that forgets its guard, or
// compares the token by hand, fails closed. Routes a share link also reaches
// (books, ?list=, objects, upload) guard themselves (`optional`).
function photographerOnlyPath(pathname) {
  const [api, area, second, third] = pathname.split('/').filter(Boolean);
  if (api !== 'api') return null;
  if (area === 'admin') return UNAUTHORIZED;
  if (area === 'shares' && (second === 'minted' || (second && third === 'revoke'))) return UNAUTHORIZED;
  if (area === 'auth' && second === 'studio-token') return UNAUTHORIZED;
  if (area === 'auth' && second === 'verify-admin') return () => jsonErr('Token 不正確', 401);
  return null;
}

// 404 (as for anything that is not yours) unless `who` is the default
// photographer; null to go on. For what is not scoped to its caller yet.
function defaultOnly(who) {
  return who && who.id === DEFAULT_PHOTOGRAPHER_ID ? null : jsonErr('Not found', 404);
}

// Routes of the products-and-orders block that read, place, change or pay an
// order (the two GET routes included).
// Paused for every photographer but the default one (see the block below).
const ORDER_ROUTES_PAUSED = new Set(['orders', 'project-orders', 'order', 'order-payment', 'order-status', 'order-erase-contact']);

// requirePhotographer, then default only: a route whose data has no owner
// but the default photographer yet — the books (`// default-only until
// books`) and the retired client accounts (`// default-only until retired`).
// The batch that gives them an owner replaces the call with
// requirePhotographer and `who.id` (photographer-routes.test.mjs keeps the
// table). {who: null} passes through for `optional` routes.
async function requireDefault(request, env, options) {
  const auth = await requirePhotographer(request, env, options);
  if (auth.refused || auth.who === null) return auth;
  const refused = defaultOnly(auth.who);
  return refused ? { refused } : auth;
}

// A new password: a string of 10–200 characters (register and change-password)
function photographerPasswordOk(password) {
  return typeof password === 'string' && !overChars(password, PHOTOGRAPHER_PASSWORD_MAX) && charCount(password) >= PHOTOGRAPHER_PASSWORD_MIN;
}
const INVALID_PHOTOGRAPHER_PASSWORD = { error: `密碼需 ${PHOTOGRAPHER_PASSWORD_MIN}–${PHOTOGRAPHER_PASSWORD_MAX} 個字元`, code: 'invalid_password' };

// The account fields of a registration, open sign-up and invite alike:
// {email, password, name, note} or {refused: body} (the 400 to answer).
function photographerSignupFields(body) {
  const email = photographerEmail(body.email);
  if (!email) return { refused: { error: 'Email 格式不正確', code: 'invalid_email' } };
  const password = body.password;
  if (!photographerPasswordOk(password)) return { refused: INVALID_PHOTOGRAPHER_PASSWORD };
  const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (!name || overChars(name, PHOTOGRAPHER_NAME_MAX) || ACCOUNT_CONTROL.test(name)) {
    return { refused: { error: `顯示名稱需 1–${PHOTOGRAPHER_NAME_MAX} 個字`, code: 'invalid_display_name' } };
  }
  const rawNote = body.studio_note ?? '';
  if (typeof rawNote !== 'string' || overChars(rawNote.trim(), PHOTOGRAPHER_NOTE_MAX) || ACCOUNT_NOTE_CONTROL.test(rawNote)) {
    return { refused: { error: `工作室說明最多 ${PHOTOGRAPHER_NOTE_MAX} 字`, code: 'invalid_studio_note' } };
  }
  return { email, password, name, note: rawNote.trim() || null };
}

// The password throttle, shared by login and change-password: this attempt
// reserves one row per key (the client's network and the email) in one
// conditional insert, before any PBKDF2, so parallel guesses cannot pass the
// cap; a success deletes its own rows again, so what stays are failures.
// Same keys for both routes, so a stolen session gets no extra guesses at the
// password. `emailText` is the email as typed (login) or stored (change).
// Returns the attempt id, or null when either key is at its cap (429).
async function reservePasswordAttempt(request, env, emailText) {
  const now = Date.now();
  const pepper = env.TURNSTILE_SECRET || '';
  const ipKey = await sha256Hex(`photographer-login-ip:${pepper}:${clientNetwork(request)}`);
  const emailKey = await sha256Hex(`photographer-login-email:${pepper}:${String(emailText).trim().toLowerCase().slice(0, 320)}`);
  const attempt = randomHex(16);
  const since = new Date(now - PHOTOGRAPHER_LOGIN_WINDOW_MS).toISOString();
  await env.DB.prepare('DELETE FROM photographer_login_failures WHERE created_at < ?').bind(new Date(now - 24 * 60 * 60 * 1000).toISOString()).run();
  const reserved = await env.DB.prepare(
    `INSERT INTO photographer_login_failures (key_hash, attempt, created_at)
     SELECT k, ?, ? FROM (SELECT ? AS k UNION ALL SELECT ?)
      WHERE (SELECT COUNT(*) FROM photographer_login_failures WHERE key_hash = ? AND created_at > ?) < ?
        AND (SELECT COUNT(*) FROM photographer_login_failures WHERE key_hash = ? AND created_at > ?) < ?`
  ).bind(attempt, new Date(now).toISOString(), ipKey, emailKey, ipKey, since, PHOTOGRAPHER_LOGIN_FAILURES_MAX, emailKey, since, PHOTOGRAPHER_LOGIN_FAILURES_MAX).run();
  return reserved.meta.changes ? attempt : null;
}
const TOO_MANY_ATTEMPTS = { error: '嘗試次數太多，請 15 分鐘後再試', code: 'too_many_attempts' };

// ─── Photographer invite codes (docs/multi-photographer.md, 邀請碼) ─────────
// The operator makes a one-use 8-digit code for ONE email, valid one hour,
// shown once; the photographer registers with that email and that code and
// the account is active at once (no review, no Turnstile). Like the
// co-picking codes: stored only as an HMAC keyed with its own wrangler
// secret, PHOTOGRAPHER_INVITE_SECRET (32+ characters), here over the email
// and the code together, so a guesser needs an invited email AND its code;
// without the secret, or before the 2026-10-18 migration, every invite route
// is 500 invites_unavailable and writes nothing. Change the limits here.
const PHOTOGRAPHER_INVITE_SECRET_MIN = 32;
const PHOTOGRAPHER_INVITE_MS = 60 * 60 * 1000;
// unspent, unrevoked, unexpired codes at once (at most one per email)
const PHOTOGRAPHER_INVITES_LIVE_MAX = 10;
const PHOTOGRAPHER_INVITE_NOTE_MAX = 200;
const PHOTOGRAPHER_INVITE_LIST_MAX = 200;
const INVITES_UNAVAILABLE = { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' };
function photographerInviteSecretOk(env) {
  return typeof env.PHOTOGRAPHER_INVITE_SECRET === 'string' && env.PHOTOGRAPHER_INVITE_SECRET.length >= PHOTOGRAPHER_INVITE_SECRET_MIN;
}
// Whether the migration has run (every column named).
async function photographerInvitesReady(env) {
  try {
    await env.DB.prepare('SELECT id, email, code_hash, created_at, expires_at, used_at, used_by, revoked_at, note FROM photographer_invites WHERE 0').first();
    return true;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}
// What is stored for a code: HMAC-SHA256 keyed with
// PHOTOGRAPHER_INVITE_SECRET over 'photographer-invite\n' + email + '\n' +
// code, hex (the email in photographerEmail's normalised form, which holds
// no newline; the code 8 digits). A leaked table alone reveals no live code,
// and a code is bound to its email. The lookup compares this hash in SQL,
// never the code, so its time says nothing about how close a guess was.
async function photographerInviteHash(env, email, code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PHOTOGRAPHER_INVITE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`photographer-invite\n${email}\n${code}`))));
}
// Refused registrations with a code (wrong, used, expired, revoked,
// malformed, another email than the invited one, or an email already taken)
// per window, per network (IPv6 by /64) and per email, then 429 before the
// code is looked at. A guesser must know an invited email, and each email
// gets 20 guesses an hour at its one code in 10^8, from however many
// networks (at most PHOTOGRAPHER_INVITES_LIVE_MAX emails have a live code).
// No count shared by everyone, not even a high circuit breaker: any shared
// count is one an attacker with enough IPv6 /64s can fill to shut invite
// registration for all. What is left: someone who knows an invited email can
// hold that one email's registration shut for a window by sending bad codes.
const PHOTOGRAPHER_INVITE_WINDOW_MS = 15 * 60 * 1000;
const PHOTOGRAPHER_INVITE_FAILURES_NETWORK = 5;
const PHOTOGRAPHER_INVITE_FAILURES_EMAIL = 5;
const INVALID_INVITE = { error: '邀請碼不正確或已失效，或此 Email 無法使用', code: 'invalid_invite' };
// The login throttle's pattern, in its table (photographer_login_failures)
// under keys of its own, so invite guesses and password guesses never share a
// count: this attempt reserves one row per key in one conditional insert, so
// parallel guesses cannot pass any cap; a registration that lands deletes its
// own rows in its batch, so what stays are refusals. Keys are SHA-256 of a
// prefix, the invite secret and the value, never the bare address or email.
// `email`: the normalised email. The attempt id, or null at any cap.
async function reserveInviteAttempt(request, env, email) {
  const now = Date.now();
  const pepper = env.PHOTOGRAPHER_INVITE_SECRET;
  const netKey = await sha256Hex(`photographer-invite-ip:${pepper}:${clientNetwork(request)}`);
  const emailKey = await sha256Hex(`photographer-invite-email:${pepper}:${email}`);
  const attempt = randomHex(16);
  const since = new Date(now - PHOTOGRAPHER_INVITE_WINDOW_MS).toISOString();
  const count = 'SELECT COUNT(*) FROM photographer_login_failures WHERE key_hash = ? AND created_at > ?';
  await env.DB.prepare('DELETE FROM photographer_login_failures WHERE created_at < ?').bind(new Date(now - 24 * 60 * 60 * 1000).toISOString()).run();
  const reserved = await env.DB.prepare(
    `INSERT INTO photographer_login_failures (key_hash, attempt, created_at)
     SELECT k, ?, ? FROM (SELECT ? AS k UNION ALL SELECT ?)
      WHERE (${count}) < ? AND (${count}) < ?`
  ).bind(attempt, new Date(now).toISOString(), netKey, emailKey,
    netKey, since, PHOTOGRAPHER_INVITE_FAILURES_NETWORK, emailKey, since, PHOTOGRAPHER_INVITE_FAILURES_EMAIL).run();
  return reserved.meta.changes ? attempt : null;
}
// An invite as the operator sees it (never code_hash): the invited email,
// and who used it.
const PHOTOGRAPHER_INVITE_VIEW_SQL = 'SELECT i.id, i.email, i.note, i.created_at, i.expires_at, i.used_at, i.used_by, i.revoked_at, ' +
  'p.email AS used_by_email, p.display_name AS used_by_name FROM photographer_invites i LEFT JOIN photographers p ON p.id = i.used_by';
function photographerInviteView(row, nowIso) {
  const state = row.used_at ? 'used' : row.revoked_at ? 'revoked' : row.expires_at > nowIso ? 'live' : 'expired';
  const { id, email, note, created_at, expires_at, used_at, used_by, revoked_at, used_by_email, used_by_name } = row;
  return { id, email, note, state, created_at, expires_at, used_at, used_by, used_by_email, used_by_name, revoked_at };
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

// Whose files a share link reads (batch 3): a pick link its project's
// photographer's — whatever its own row says; any other row its own
// photographer_id (a studio token: who minted it), where NULL, and a database
// before that column, is the default photographer (album links, client
// sessions and every row written before the column). Never the request.
function shareOwner(share) {
  if (isPickShare(share) && share.project) return share.project.photographer_id;
  const owner = share.photographer_id;
  return owner === null || owner === undefined ? DEFAULT_PHOTOGRAPHER_ID : owner;
}

// The value share_tokens.photographer_id holds for a photographer: NULL for
// the default one (as on every row from before the column), the id otherwise.
// What it writes; reads compare with shareOwnedBy (NULL and 'default' alike).
function shareOwnerColumn(photographerId) {
  return photographerId === DEFAULT_PHOTOGRAPHER_ID ? null : photographerId;
}
// The rows of `col` that `photographerId` owns, as an SQL condition and its
// two bound values: NULL and the literal 'default' alike for the default
// photographer (shareOwner reads both as the default's, so it must be able to
// list and revoke both — security review of batch 3); only its own id for
// anyone else, never NULL or 'default'.
function shareOwnedBy(col, photographerId) {
  return { sql: `COALESCE(${col}, ?) = ?`, args: [DEFAULT_PHOTOGRAPHER_ID, photographerId] };
}
const SHARE_OWNER_UNAVAILABLE = { error: '多攝影師連結功能尚未啟用', code: 'share_owner_unavailable' };

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

// ─── What an album write may store (audit FE-1) ─────────────────────────────
// A slot's photoId and crop go straight into HTML in book_editor/js/layouts.js
// — in the photographer's editor (studio token in sessionStorage) and in every
// viewer of the link. The share-link PATCH lets a CLIENT write both, and the
// folder gate alone does not help: `20260819/a.jpg" onerror="…` is inside the
// folder. The renderer escapes too; this keeps such values out of R2.
//
// Refused in a key: the characters that end or start markup (`"` `<` `>`),
// backtick and backslash, every control character (C0, DEL, C1), the line and
// paragraph separators, the bidi controls and BOM that disguise a name, and a
// lone surrogate (no UTF-8 key holds one; with the `u` flag a paired emoji is
// one code point and does not match).
// Upload keeps the file name as it is (upload.html), so this must not refuse
// real names: Chinese, spaces, parentheses, `&#%+[]{}` and `'` all pass.
// `'` deliberately: "Tim's pick.jpg" / "O'Brien.jpg" are ordinary file names,
// every attribute the renderer writes is double-quoted and escaped, and its
// URL encoder turns `'` into %27 for the one CSS url('…') it builds.
// Windows cannot name a file with `" < > \` anyway; a macOS file named with
// them cannot go into an album (it uploads and shows in the picker as before).
const BOOK_KEY_MAX = 1024;   // R2's own key limit (bytes; chars is looser)
const UNSAFE_KEY_CHAR = /["<>`\\\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
function bookPhotoIdSafe(id) {
  return typeof id === 'string' && id.length <= BOOK_KEY_MAX && !UNSAFE_KEY_CHAR.test(id);
}

// The fields the editor writes (book_editor.js: pan x/y as fractions of the
// slot, unclamped; zoom 1–4; rotation in degrees, which repeated ±90 steps
// let grow). The ranges are far past anything the UI produces and only stop
// absurd values; anything else is refused, unknown keys included.
const CROP_RANGE = { x: [-1000, 1000], y: [-1000, 1000], scale: [0, 1000], rotation: [-1e6, 1e6] };
// allowNull: an old saved book can hold a null (a NaN through JSON.stringify);
// the renderer reads it as the default. Only the photographer's PUT allows it.
function bookCropValid(crop, { allowNull = false } = {}) {
  if (crop === null || typeof crop !== 'object' || Array.isArray(crop)) return false;
  for (const [k, v] of Object.entries(crop)) {
    if (!Object.hasOwn(CROP_RANGE, k)) return false;
    if (v === null && allowNull) continue;
    const [lo, hi] = CROP_RANGE[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return false;
  }
  return true;
}

// The photographer's whole-book PUT: the same two rules on every slot and
// background, lenient where the editor's own saved books differ (null
// slots, null crop, null crop fields). Returns an error code or null.
function bookContentProblem(book) {
  if (book === null || typeof book !== 'object' || Array.isArray(book)) return 'invalid_book';
  if (book.pages === undefined) return null;
  if (!Array.isArray(book.pages)) return 'invalid_book';
  const photoOk = id => !id || bookPhotoIdSafe(id);
  for (const page of book.pages) {
    if (!page || typeof page !== 'object') continue;
    if (page.bgImage && !photoOk(page.bgImage.photoId)) return 'invalid_photo_id';
    if (page.slots === undefined || page.slots === null) continue;
    if (!Array.isArray(page.slots)) return 'invalid_book';
    for (const slot of page.slots) {
      if (!slot || typeof slot !== 'object') continue;
      if (!photoOk(slot.photoId)) return 'invalid_photo_id';
      if (slot.crop !== undefined && slot.crop !== null && !bookCropValid(slot.crop, { allowNull: true })) return 'invalid_crop';
    }
  }
  return null;
}

const BOOK_CONTENT_ERRORS = {
  invalid_book: '相本資料格式不正確',
  invalid_photo_id: '照片路徑含有不允許的字元',
  invalid_crop: '裁切資料格式不正確',
};
const bookContentRefusal = code => jsonOk({ error: BOOK_CONTENT_ERRORS[code], code }, 400);

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

// ─── R2, one photographer at a time (docs/multi-photographer.md §3, batch 3) ─
// One bucket. The default photographer's objects stay where they always were;
// every other photographer's live under `_t/<id>/`. What clients, share links,
// selections, orders and the pages store is the LOGICAL key, which never
// carries the prefix: it is added here, on the way into R2, and stripped here
// on the way out. `_t/` itself is reserved: no logical key may name it, for
// anyone — the default's keys are not prefixed, so a default `_t/B/x` would
// BE B's object. Checked on the logical key, before the prefix, inside the
// helper, so no route can forget it.
const TENANT_PREFIX = '_t/';
function isTenantKey(key) {
  return key === '_t' || key.startsWith(TENANT_PREFIX);
}
// what photographer ids really are (randomHex(8): 16 lowercase hex), with room:
// lowercase letters, digits, `_` and `-`, at most 64, never starting with `_`
// or `-`. Nothing that could end, climb out of or encode a path segment.
const PHOTOGRAPHER_ID_SAFE = /^[0-9a-z][0-9a-z_-]{0,63}$/;
function tenantPrefix(photographerId) {
  const safe = typeof photographerId === 'string' && PHOTOGRAPHER_ID_SAFE.test(photographerId);
  // the default photographer has no prefix (bucketFor never asks for one)
  if (!safe || photographerId === DEFAULT_PHOTOGRAPHER_ID) throw new Error('R2: unsafe photographer id');
  return `${TENANT_PREFIX}${photographerId}/`;
}

// The one way to R2: {get, head, put, delete, list} over `photographerId`'s objects.
// The id comes from the caller's identity (who.id), a link's project, or a
// minted token's owner — never the request. An unsafe id throws before any
// read or write. A reserved key reads as missing (get / head: null; list:
// nothing) and is refused for a write or a delete (throws; the upload route
// answers 400 first). A list returns logical keys and only this
// photographer's objects.
function bucketFor(env, photographerId) {
  const bucket = env.imagepicker;
  const prefix = photographerId === DEFAULT_PHOTOGRAPHER_ID ? '' : tenantPrefix(photographerId);
  const reserved = key => typeof key !== 'string' || isTenantKey(key);
  // R2 key → logical key, or null when it is not this photographer's
  const logical = key => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    return isTenantKey(rest) ? null : rest;
  };
  return {
    get: (key, options) => (reserved(key) ? Promise.resolve(null) : bucket.get(prefix + key, options)),
    head: key => (reserved(key) ? Promise.resolve(null) : bucket.head(prefix + key)),
    put(key, value, options) {
      if (reserved(key)) throw new Error('R2: reserved key');
      return bucket.put(prefix + key, value, options);
    },
    // one string key per call (real R2 also takes an array; not here, so
    // nothing can sweep a list past the check). A missing key is not an
    // error in R2.
    delete(key) {
      if (reserved(key)) throw new Error('R2: reserved key');
      return bucket.delete(prefix + key);
    },
    async list(options = {}) {
      const wanted = options.prefix ?? '';
      if (reserved(wanted)) return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
      const listed = await bucket.list({ ...options, prefix: prefix + wanted });
      // the default's own objects pass through as R2 gave them; a tenant's
      // are re-keyed (only the fields the routes read)
      const objects = [];
      for (const o of listed.objects || []) {
        const key = logical(o.key);
        if (key === null) continue;
        objects.push(prefix ? { key, size: o.size, uploaded: o.uploaded, etag: o.etag, httpEtag: o.httpEtag } : o);
      }
      const delimitedPrefixes = (listed.delimitedPrefixes || []).map(logical).filter(p => p !== null);
      return { ...listed, objects, delimitedPrefixes };
    },
  };
}

// Books have no owner yet (`_books/<id>.json` in R2, share links by book_id):
// they are the default photographer's objects until a later batch gives them
// one, and every book route is default-only until then.
function bookBucket(env) {
  return bucketFor(env, DEFAULT_PHOTOGRAPHER_ID);
}

// ─── Deleting one photo (docs/delivery.md "刪除照片") ──────────────────────
// A photographer removes one photo of their own (a retouched file uploaded
// by mistake, typically): its thumbnails, then the original. Refused (409,
// nothing deleted) while the photo may be in use — see photoLock.
//
// The key a delete may name: a photo key the upload route could have stored
// (an extension upload.html takes), at most R2's 1024 bytes, not a folder,
// never the Worker's own namespaces (`_…`: `_t/`, `_thumbs/`, `_books/`,
// `_assets/`), no `.` / `..` segment (no stored key has one: the URL parser
// folds them away on upload) and no control or line-separator character. A
// backslash, a double or a leading slash are literal R2 key characters,
// looked up as they are, inside the caller's own prefix (bucketFor).
const R2_KEY_MAX_BYTES = 1024;
function deletablePhotoKey(key) {
  if (typeof key !== 'string' || !key || key.endsWith('/') || isInternalKey(key)) return false;
  if (PICK_KEY_CONTROL.test(key) || new TextEncoder().encode(key).length > R2_KEY_MAX_BYTES) return false;
  const segments = key.split('/');
  if (segments.includes('.') || segments.includes('..')) return false;
  return !!UPLOAD_TYPES[keyExtension(key)];
}

// What a lock code tells the photographer (409; photo_lock_unavailable 500).
// In precedence order: the first that holds is the one answered.
const PHOTO_LOCKS = {
  photo_locked_delivered: '這張照片在已交件的專案資料夾裡，不能刪除（要刪請先取消交件或開放修改）',
  photo_locked_archived: '這張照片在已封存的專案資料夾裡，不能刪除',
  photo_in_pick_folder: '這張照片在選片資料夾裡，客人可能已經選了它，不能刪除',
  photo_in_round: '這張照片在客人送出的選片或修改紀錄裡，不能刪除',
  photo_in_order: '這張照片在訂單裡（含已取消的訂單），不能刪除',
  photo_in_album: '這張照片已放進相本，不能刪除',
};
const PHOTO_LOCK_UNAVAILABLE = 'photo_lock_unavailable';

// Whether a folders column (a JSON array of folders, or NULL) covers `key`.
// A value that is not an array of strings counts as covering it: a delete
// that cannot tell fails closed.
function foldersColumnCovers(value, key) {
  if (value === null || value === undefined) return false;
  let folders;
  try { folders = JSON.parse(value); } catch { return true; }
  if (!Array.isArray(folders)) return true;
  return folders.some(f => typeof f !== 'string' || folderCovers(f, key));
}

// Any string anywhere in a stored value that names `key` — an album (a slot,
// a background, the editor's layout cache, a field added later), an order
// line, a round's pins (keyed BY photo key, so object keys count too):
// contains it, as is or URL-encoded. Over-matching (`a.jpg` inside
// `a.jpg.bak`) only refuses a delete; under-matching would lose a photo
// something still shows.
function albumNames(value, key, depth = 0) {
  if (depth > 64) return true;
  const names = v => v.includes(key) || v.includes(encodeURIComponent(key));
  if (typeof value === 'string') return names(value);
  if (value && typeof value === 'object') {
    return Object.keys(value).some(names) || Object.values(value).some(v => albumNames(v, key, depth + 1));
  }
  return false;
}
// A stored JSON column, parsed; its text when it does not parse (so a key the
// text contains still counts).
function parsedOrText(text) {
  try { return JSON.parse(text); } catch { return String(text); }
}

// The most albums one delete reads. Each is an R2 get, a subrequest; on the
// Workers Free plan a request may make 50 (the documented limit for external
// subrequests; calls to R2 / D1 are allowed 1000, but the stricter reading is
// the safe one). Besides the albums a delete makes: the session lookup (1),
// the photo's head (1), three D1 statements (projects, rounds, orders: 3; 4
// before the guest-order migration, the orders one retried), the album
// listing (1), the thumbnail listing (1), the original's delete (1) and a
// head and a delete per thumbnail width (THUMB_BUCKETS: 3 widths, 6) = 14,
// 15 before that migration, +2 per older width folder found. With 25
// albums: 39–40, leaving 10 for older widths or extra listing pages.
// Over it, the lock cannot be decided within one request: 500
// photo_lock_unavailable, nothing deleted (never a partial scan).
const ALBUM_SCAN_MAX = 25;

// Albums (`_books/<id>.json`) belong to the default photographer, and they
// keep their photos' keys (logical, unprefixed) in the JSON R2 holds. All are
// listed first (past the first page); more than ALBUM_SCAN_MAX → null
// (cannot tell); then each is read once. `<id>_status.json` (approved /
// timestamp, no keys) is neither counted nor read when `<id>.json` is listed
// too; otherwise it may be an album whose own id ends in `_status` (book ids
// come from the URL unchecked), so it is read. One that does not parse
// locks a key its text contains. An album that only ever lived in the
// editor's localStorage is invisible here (docs/delivery.md).
async function photoInAlbum(env, key) {
  const books = bookBucket(env);
  const listed = new Set();
  let cursor;
  let truncated = true;
  while (truncated) {
    const page = await books.list({ prefix: '_books/', cursor });
    for (const o of page.objects || []) if (o.key.endsWith('.json')) listed.add(o.key);
    cursor = page.cursor;
    truncated = page.truncated;
  }
  const names = [...listed].filter(k => !(k.endsWith('_status.json') && listed.has(k.slice(0, -'_status.json'.length) + '.json')));
  if (names.length > ALBUM_SCAN_MAX) return null;
  for (const name of names) {
    const obj = await books.get(name);
    if (!obj) continue;
    const text = await obj.text();
    let data;
    try { data = JSON.parse(text); } catch {
      if (text.includes(key)) return true;
      continue;
    }
    if (albumNames(data, key)) return true;
  }
  return false;
}

// Why `ownerId`'s photo `key` may not be deleted now: a PHOTO_LOCKS code,
// PHOTO_LOCK_UNAVAILABLE when the database cannot say (a column a hand-run
// migration adds is missing), or null. Only `ownerId`'s own projects count:
// another photographer's on the same folder names are other objects.
// - a project whose `folders` or `final_folders` cover the key, delivered
//   (`delivered_at` set — never inferred from final_folders, which stays
//   after undeliver and reopen) → photo_locked_delivered; else archived →
//   photo_locked_archived; else under its `folders` (the client picks from
//   them) → photo_in_pick_folder. A finals snapshot of a project neither
//   delivered nor archived locks nothing: that is the retouched file
//   uploaded by mistake, the case this exists for.
// - on any order line of an order of `ownerId`'s (order_items.photo_keys,
//   every status, a cancelled order too), or under the final_folders of the
//   order's project when the line is an album with a layout (a guest album
//   of all the finals) → photo_in_order. One D1 statement;
//   checked before the albums, which cost an R2 read per book.
// - frozen in a round the old-round thumbnail route serves (GET
//   /api/pick/rounds/:id/photo): the pins of any revision_requests row, the
//   photo_keys of any submission, of `ownerId`'s projects → photo_in_round
//   (one D1 statement; ranked before the orders). The round route shows them
//   whatever the finals are now, so a redelivery to other finals does not
//   free them. Draft pins (revision_pins) are not rounds and do not lock.
// - named in an album (the default photographer's only) → photo_in_album.
// A missing table or column (projects' late columns, the order tables, the
// rounds' marks: all in prod since 2026-09-29..10-07) is
// PHOTO_LOCK_UNAVAILABLE: fail closed.
async function photoLock(env, ownerId, key) {
  let rows;
  let frozen;
  let lines;
  try {
    ({ results: rows } = await env.DB.prepare(
      'SELECT folders, final_folders, delivered_at, archived_at FROM projects WHERE photographer_id = ?'
    ).bind(ownerId).all());
    ({ results: frozen } = await env.DB.prepare(
      'SELECT r.marks AS v FROM revision_requests r JOIN projects p ON p.id = r.project_id ' +
      'WHERE p.photographer_id = ?1 AND r.marks IS NOT NULL ' +
      'UNION ALL SELECT s.photo_keys FROM submissions s JOIN projects p ON p.id = s.project_id WHERE p.photographer_id = ?1'
    ).bind(ownerId).all());
    // an album line with a layout (a guest album: photo_keys '[]', layout
    // {source:'all_finals'}) takes every photo under its project's finals.
    // Before the guest-order migration there is no layout column, and so no
    // such line: the listed keys alone (the retry names no layout).
    const orderLines = withLayout => env.DB.prepare(
      `SELECT i.photo_keys, ${withLayout ? "i.kind = 'album' AND i.layout IS NOT NULL" : '0'} AS all_finals, p.final_folders ` +
      'FROM order_items i JOIN orders o ON o.id = i.order_id ' +
      'LEFT JOIN projects p ON p.id = o.project_id AND p.photographer_id = o.photographer_id ' +
      `WHERE o.photographer_id = ? AND (i.photo_keys <> '[]'${withLayout ? " OR (i.kind = 'album' AND i.layout IS NOT NULL)" : ''})`
    ).bind(ownerId).all();
    ({ results: lines } = await withoutMissingColumn(() => orderLines(true), () => orderLines(false)));
  } catch (e) {
    if (isMissingSchema(e)) return PHOTO_LOCK_UNAVAILABLE;
    throw e;
  }
  const held = new Set();
  for (const p of rows || []) {
    const inPick = foldersColumnCovers(p.folders, key);
    if (!inPick && !foldersColumnCovers(p.final_folders, key)) continue;
    if (p.delivered_at !== null) held.add('photo_locked_delivered');
    else if (p.archived_at !== null) held.add('photo_locked_archived');
    else if (inPick) held.add('photo_in_pick_folder');
  }
  // the album rule on each value: contains the key, as is or URL-encoded; a
  // value that does not parse locks a key its text contains
  if ((frozen || []).some(r => albumNames(parsedOrText(r.v), key))) held.add('photo_in_round');
  if ((lines || []).some(l => albumNames(parsedOrText(l.photo_keys), key) ||
      (l.all_finals === 1 && foldersColumnCovers(l.final_folders, key)))) held.add('photo_in_order');
  const code = Object.keys(PHOTO_LOCKS).find(c => held.has(c));
  if (code) return code;
  if (ownerId !== DEFAULT_PHOTOGRAPHER_ID) return null;
  const inAlbum = await photoInAlbum(env, key);
  if (inAlbum === null) return PHOTO_LOCK_UNAVAILABLE;
  return inAlbum ? 'photo_in_album' : null;
}

function photoLockAnswer(code, deleted) {
  if (code === PHOTO_LOCK_UNAVAILABLE) {
    return jsonOk({ error: '現在無法確認這張照片能不能刪除，所以沒有刪除任何東西', code, deleted }, 500, PHOTO_NO_STORE);
  }
  return jsonOk({ error: PHOTO_LOCKS[code], code, deleted }, 409, PHOTO_NO_STORE);
}
const PHOTO_NO_STORE = { 'Cache-Control': 'private, no-store' };

// Every thumbnail key a photo may have: the widths the app writes
// (THUMB_BUCKETS) and any other width folder under `_thumbs/` (an older
// upload page's), smallest first.
async function thumbKeysOf(photos, key) {
  const widths = new Set(THUMB_BUCKETS);
  let cursor;
  let truncated = true;
  while (truncated) {
    const listed = await photos.list({ prefix: THUMB_PREFIX, delimiter: '/', cursor });
    for (const p of listed.delimitedPrefixes || []) {
      const m = /^_thumbs\/(\d+)\/$/.exec(p);
      if (m) widths.add(Number(m[1]));
    }
    cursor = listed.cursor;
    truncated = listed.truncated;
  }
  return [...widths].sort((a, b) => a - b).map(w => `${THUMB_PREFIX}${w}/${key}.thumb`);
}

// The delete itself, for photographer `ownerId` (who.id, never the request).
// 400 invalid_key; 404 when the caller has no such photo (someone else's key
// is exactly this: the existence check comes first, in the caller's own
// prefix, before any D1 statement); 409 / 500 photoLock, checked once; the
// thumbnail keys listed; then the ORIGINAL first (failing: 500
// photo_delete_failed, nothing deleted, a retry starts over), then each
// thumbnail that exists, best effort: one that fails stays as an orphan
// (named in `failed`, the photo is deleted all the same: 200). So there is
// never an original whose thumbnails are gone. Anything thrown before the
// original's delete is a JSON 500 with nothing deleted; nothing after it can
// throw.
async function deletePhoto(env, ownerId, key) {
  if (!deletablePhotoKey(key)) return jsonOk({ error: 'Invalid key', code: 'invalid_key' }, 400);
  const notDone = failed => jsonOk({ error: '刪除沒有完成，沒有刪除任何東西，請再試一次', code: 'photo_delete_failed', deleted: [], failed }, 500, PHOTO_NO_STORE);
  const photos = bucketFor(env, ownerId);
  let thumbs;
  try {
    if (!(await photos.head(key))) return jsonErr('Not found', 404);
    const locked = await photoLock(env, ownerId, key);
    if (locked) return photoLockAnswer(locked, []);
    thumbs = await thumbKeysOf(photos, key);
  } catch (e) {
    console.error('photo delete: refused before deleting anything:', e?.message);
    return notDone([]);
  }
  try {
    await photos.delete(key);
  } catch {
    return notDone([key]);
  }
  const deleted = [key];
  const failed = [];
  for (const thumb of thumbs) {
    try {
      if (!(await photos.head(thumb))) continue;
      await photos.delete(thumb);
      deleted.push(thumb);
    } catch {
      failed.push(thumb);
    }
  }
  return jsonOk({ ok: true, key, deleted, ...(failed.length ? { failed } : {}) }, 200, PHOTO_NO_STORE);
}

// The same checks as deletePhoto, deleting nothing: 200 {key, deletable,
// code, error} (code / error: the 409 DELETE would give, null when free);
// 400 / 404 / 500 photo_lock_unavailable as DELETE, and anything thrown is
// that 500 too. Only a hint: the delete checks again.
async function photoLockReport(env, ownerId, key) {
  if (!deletablePhotoKey(key)) return jsonOk({ error: 'Invalid key', code: 'invalid_key' }, 400);
  try {
    if (!(await bucketFor(env, ownerId).head(key))) return jsonErr('Not found', 404);
    const code = await photoLock(env, ownerId, key);
    if (code === PHOTO_LOCK_UNAVAILABLE) return photoLockAnswer(code, []);
    return jsonOk({ key, deletable: !code, code, error: code ? PHOTO_LOCKS[code] : null }, 200, PHOTO_NO_STORE);
  } catch (e) {
    console.error('photo lock:', e?.message);
    return photoLockAnswer(PHOTO_LOCK_UNAVAILABLE, []);
  }
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

// Whether a link's owner may still hand out its files (security review of
// batch 3): the default photographer always (it has no photographers row, and
// a row that names it changes nothing); anyone else only while their account
// is active — suspended (until un-suspended), pending or deleted is dark.
// A WHERE condition on `col` (the owner column, NULL meaning the default)
// with its bound values, so the check rides in the statement that already
// loads the row (no extra round trip on a hot read) and the row the routes
// get is exactly the table's columns. A dark owner reads as no row at all.
function ownerLiveSql(col) {
  const def = DEFAULT_PHOTOGRAPHER_ID;
  return {
    sql: `(COALESCE(${col}, ?) = ? OR EXISTS (SELECT 1 FROM photographers WHERE id = ${col} AND status = 'active'))`,
    args: [def, def],
  };
}
// The default photographer as a link owner: NULL (every row from before the
// owner column, album links, client sessions) or its id written out. What
// the fallback reads below go by: without the photographers table or the
// share-token owner column only the default can own anything, so any other
// owner fails closed there.
function isDefaultOwner(owner) {
  return owner === null || owner === undefined || owner === DEFAULT_PHOTOGRAPHER_ID;
}
// A pick link's owner is its project's photographer (shareOwner), checked on
// the project; its own row's photographer_id is not looked at. SQL and JS
// say the same thing (a project_id of NULL or '' is no project).
const PICK_WITH_PROJECT_SQL = "(s.kind = 'pick' AND COALESCE(s.project_id, '') != '')";

// Returns the token row (folders already parsed) or null. Revoked, expired,
// unknown, an owner that is not live (ownerLiveSql) and "no D1 bound at all"
// are all deliberately the same answer.
async function resolveShareToken(request, url, env) {
  if (!env.DB) return null;
  const value = url.searchParams.get('t') || request.headers.get('X-Share-Token') || '';
  if (!value) return null;
  let row;
  try {
    const live = ownerLiveSql('s.photographer_id');
    let checked = true;
    row = await withoutMissingSchema(
      () => env.DB.prepare(`SELECT s.* FROM share_tokens s WHERE s.token = ? AND (${PICK_WITH_PROJECT_SQL} OR ${live.sql})`)
        .bind(value, ...live.args).first(),
      () => { checked = false; return env.DB.prepare('SELECT * FROM share_tokens WHERE token = ?').bind(value).first(); },
    );
    if (row && !checked && !(isPickShare(row) && row.project_id) && !isDefaultOwner(row.photographer_id)) return null;
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
  // Its owner is the project's photographer (shareOwner), checked in the
  // same statement: a suspended / deleted photographer's links are dark, and
  // come back on un-suspend (the link rows are untouched).
  if (isPickShare(row) && row.project_id) {
    let project;
    try {
      const live = ownerLiveSql('p.photographer_id');
      let checked = true;
      project = await withoutMissingSchema(
        () => env.DB.prepare(`SELECT p.* FROM projects p WHERE p.id = ? AND p.archived_at IS NULL AND ${live.sql}`)
          .bind(row.project_id, ...live.args).first(),
        () => { checked = false; return env.DB.prepare('SELECT * FROM projects WHERE id = ? AND archived_at IS NULL').bind(row.project_id).first(); },
      );
      if (project && !checked && !isDefaultOwner(project.photographer_id)) return null;
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
// Retouch pins on one ♥ photo (selections.marks): at most this many, each a
// note of at most this many characters. Change them here only.
const PICK_MARKS_MAX = 10;
const PICK_MARK_NOTE_MAX = 100;
// The most pins one project may hold across all its selections (a real one
// is well under 100). Enforced inside the save's own writes like the other
// caps (409 marks_cap). It is what bounds a submission's marks snapshot, and
// with it the admin detail, which returns up to 50 of them.
const PICK_MARKS_TOTAL_MAX = 300;
// A submission's marks snapshot in bytes: every pin on its own photo, every
// character of key and note 4 bytes, plus the JSON around them. A save can
// never produce more; a snapshot over it (hand-edited rows) is refused (409
// marks_cap) rather than stored. 300 × (4·256 + 4·100 + 64) = 446,400.
const PICK_MARKS_SNAPSHOT_MAX = PICK_MARKS_TOTAL_MAX * (4 * PICK_PHOTO_KEY_MAX + 4 * PICK_MARK_NOTE_MAX + 64);
// Request bodies, read with readBodyCapped (413 too_large). A save's worst
// legitimate body is ~1.7 MB: 500 items × (a 256-character key and a
// 500-character note at 4 bytes a character, + JSON) plus 300 pins with
// 100-character notes. A submit is a relationship and an email.
const PICK_BODY_MAX = 2000000;
const PICK_SUBMIT_BODY_MAX = 16 * 1024;
// D1 refuses a single string value over 2,000,000 bytes as an error; a save's
// items travel as one bound JSON value, so one over this is refused (413)
// before the batch rather than failing inside it.
const PICK_BIND_MAX = 1900000;
// One photographer today. Written by the Worker on every project so the data
// is attributable from day one; a request body never chooses it.
const DEFAULT_PHOTOGRAPHER_ID = 'default';

// Characters, not UTF-16 units, so an emoji is one of the fifty.
const charCount = s => [...s].length;
// More than `max` characters, refusing a string over 2·max UTF-16 units
// before spreading it (it cannot be ≤ max characters then).
const overChars = (s, max) => s.length > 2 * max || charCount(s) > max;

// ─── Studio settings and dashboard (docs/dashboard-settings.md) ─────────────
const STUDIO_NAME_MAX = 60;
const BOOKING_URL_MAX = 500;
const LOGO_MAX_BYTES = 200 * 1024;
// Asia/Taipei has no daylight saving, so a fixed offset is its month boundary.
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STATS_MONTHS = 12;
const STUDIO_INT_FIELDS = ['default_pick_limit', 'default_extra_price'];

// ─── Project plan (docs/project-plan.md) ────────────────────────────────────
// projects.extra_max: how many ♥ photos the guest may send above pick_limit.
// ♥ itself is never limited by the plan (a save is a draft; only the system
// caps apply); a submit may send at most pick_limit + extra_max of them (409
// pick_cap); NULL in either = no plan cap. A new project takes the body's
// value, else studio_settings.default_extra_max, else EXTRA_MAX_DEFAULT.
const EXTRA_MAX_MAX = 500;
const EXTRA_MAX_DEFAULT = 10;
const isExtraMax = v => Number.isSafeInteger(v) && v >= 0 && v <= EXTRA_MAX_MAX;
// what PATCH /api/admin/projects/:id accepts, key by key (null clears the
// plan fields; the proof switch is a plain boolean)
const PROJECT_PATCH_FIELDS = {
  title: v => isProjectTitleInput(v),
  allow_proof_download: v => typeof v === 'boolean',
  shoot_date: v => isShootDateInput(v),
  project_type: v => isProjectTypeInput(v),
  pick_limit: v => v === null || (Number.isSafeInteger(v) && v >= 0),
  extra_price: v => v === null || isMoney(v),
  extra_max: v => v === null || isExtraMax(v),
};
const EXTRA_MAX_UNAVAILABLE = { error: '加選上限功能尚未啟用', code: 'extra_max_unavailable' };
// PATCH keys that are not the plan: they still apply to an archived project
const PROJECT_NON_PLAN_FIELDS = ['title', 'allow_proof_download', 'shoot_date', 'project_type'];

// projects.shoot_date (docs/delivery.md, "Shoot date"): the day of the shoot,
// for the completion page. Strictly 'YYYY-MM-DD', a real calendar day from
// SHOOT_YEAR_MIN to SHOOT_YEAR_MAX; '' or null on a write clears it (NULL).
// Its own hand-run migration (2026-10-07-project-shoot-date.sql): before it,
// reads say null and a write naming it answers 500 shoot_date_unavailable.
// A guest reads it only in /api/pick/state while delivered and confirmed.
const SHOOT_YEAR_MIN = 1900;
const SHOOT_YEAR_MAX = 2100;
const SHOOT_DATE_UNAVAILABLE = { error: '拍攝日期功能尚未啟用', code: 'shoot_date_unavailable' };
function isShootDate(v) {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < SHOOT_YEAR_MIN || y > SHOOT_YEAR_MAX) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const isShootDateInput = v => v === null || v === '' || isShootDate(v);
// what a valid input stores: '' clears like null
const shootDateValue = v => (v === '' ? null : v);

// projects.project_type (docs/delivery.md, "Project type"): the photography
// category of the project, photographer-only (no guest route returns it).
// The categories are js/shoot-types.js's, and its 其他 lets the photographer
// type their own, so like users.shoot_type the Worker keeps no copy of the
// list (it could only refuse what the UI allows; a test pins that every UI
// entry is accepted). What it does refuse: anything but a string or null,
// more than PROJECT_TYPE_MAX characters after the trim, and the characters
// that disguise or break a label (C0/DEL/C1 controls, line and paragraph
// separators, bidi marks/overrides/isolates, BOM, a lone surrogate). Stored
// trimmed; '', blank or null clears it (NULL). Its own hand-run migration
// (2026-10-07-project-type.sql): before it reads say null and a write naming
// it answers 500 project_type_unavailable.
const PROJECT_TYPE_MAX = 20;
const PROJECT_TYPE_UNSAFE = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
const PROJECT_TYPE_UNAVAILABLE = { error: '專案類型功能尚未啟用', code: 'project_type_unavailable' };
function isProjectTypeInput(v) {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return charCount(t) <= PROJECT_TYPE_MAX && !PROJECT_TYPE_UNSAFE.test(t);
}
// what a valid input stores: trimmed, '' (or blank) clears like null
const projectTypeValue = v => (v === null ? null : v.trim() || null);

// projects.title on a rename (PATCH /api/admin/projects/:id {title};
// docs/delivery.md, "Renaming a project"): a string, 1 to PROJECT_TITLE_MAX
// characters (code points) after the trim, none of the characters
// PROJECT_TYPE_UNSAFE refuses. A rename never clears it: blank is refused,
// not stored. Stored trimmed. Create keeps its own older rule (any string,
// cut to 200 UTF-16 units). Only the title changes: no R2 folder is renamed.
const PROJECT_TITLE_MAX = 200;
function isProjectTitleInput(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  const n = charCount(t);
  return n >= 1 && n <= PROJECT_TITLE_MAX && !PROJECT_TYPE_UNSAFE.test(t);
}

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

// A JSON body of at most `max` bytes: {body} or {refused: Response} — 413
// too_large over the cap, 400 'Invalid JSON' when it does not parse.
async function readJsonCapped(request, max) {
  const bytes = await readBodyCapped(request, max);
  if (!bytes) return { refused: jsonOk({ error: '資料太大', code: 'too_large', max }, 413) };
  try { return { body: JSON.parse(new TextDecoder().decode(bytes)) }; } catch { return { refused: jsonErr('Invalid JSON') }; }
}

// An uploaded image (the logo, a platform product's photo): the raw body,
// ≤ LOGO_MAX_BYTES (413), PNG / JPEG / WebP by its own magic bytes (415) —
// the client's Content-Type is never read. Returns {bytes, type} or
// {refused: Response}. `what` names it in the message.
async function imageUpload(request, what) {
  const bytes = await readBodyCapped(request, LOGO_MAX_BYTES);
  if (!bytes) return { refused: jsonOk({ error: `${what}不可超過 ${LOGO_MAX_BYTES / 1024} KB`, code: 'too_large', max: LOGO_MAX_BYTES }, 413) };
  const type = sniffImageType(bytes);
  if (!type) return { refused: jsonOk({ error: `${what}只接受 PNG、JPEG 或 WebP`, code: 'unsupported_type' }, 415) };
  return { bytes, type };
}

// A stored image served publicly: as the type its bytes are (re-sniffed, so a
// hand-edited row cannot turn it into something a browser would run), never
// sniffed by the browser, under a CSP that lets it run nothing even if opened
// directly, with `stamp` (its updated_at) as the ETag. 404 when there is none.
// `extra` overrides the headers (a private Cache-Control for a logo read
// through a link or the photographer's own credential).
function imageResponse(request, blob, stamp, extra = {}) {
  // D1 hands a BLOB back as an array of byte values
  const bytes = blob ? new Uint8Array(blob) : null;
  const type = bytes && sniffImageType(bytes);
  if (!type) return jsonErr('Not found', 404);
  const headers = {
    ...corsHeaders,
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'public, max-age=300',
    ...extra,
  };
  const tag = String(stamp || '');
  if (/^[0-9A-Za-z:.+-]+$/.test(tag)) {
    headers.ETag = `"${tag}"`;
    const inm = (request.headers.get('If-None-Match') || '').split(',').map(v => v.trim().replace(/^W\//, ''));
    if (inm.includes(headers.ETag)) return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: 200, headers });
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
  // default_extra_max, transfer_info, pick_link_message and the three
  // link_message_* arrive in hand-run migrations, in any order; until a
  // column exists it reads unset
  const late = ['default_extra_max', 'transfer_info', 'pick_link_message', ...LINK_MESSAGE_FIELDS];
  const read = cols => env.DB.prepare(
    `SELECT studio_name, booking_url, default_pick_limit, default_extra_price${cols}, logo IS NOT NULL AS has_logo, logo_type, logo_updated_at, updated_at FROM studio_settings WHERE photographer_id = ?`
  ).bind(photographerId).first();
  const row = await withoutMissingColumn(() => read(late.map(c => `, ${c}`).join('')), async () => {
    // Not every migration has run, and not necessarily in order: read the
    // base row, then each late column on its own, so one missing column never
    // hides another that is there.
    const base = await read('');
    if (!base) return base;
    for (const col of late) {
      const one = await withoutMissingColumn(() => read(`, ${col}`), () => null);
      if (one) base[col] = one[col];
    }
    return base;
  });
  const hasLogo = !!row?.has_logo;
  const extraMax = row?.default_extra_max ?? null;
  return {
    studio_name: row?.studio_name ?? null,
    booking_url: row?.booking_url ?? null,
    default_pick_limit: row?.default_pick_limit ?? null,
    default_extra_price: row?.default_extra_price ?? null,
    default_extra_max: extraMax,
    // shown to a guest on a confirmed order (S2); null = not set
    transfer_info: row?.transfer_info ?? null,
    // the photographer's default text sent with a pick link; null = the
    // page's built-in one. Admin-only: pickStudio passes three other fields
    pick_link_message: row?.pick_link_message ?? null,
    // the same for the later stages (已送出 / 已交件 / 已完成); admin-only too
    ...Object.fromEntries(LINK_MESSAGE_FIELDS.map(f => [f, row?.[f] ?? null])),
    // what a new project gets when the create body leaves extra_max out
    effective_default_extra_max: isExtraMax(extraMax) ? extraMax : EXTRA_MAX_DEFAULT,
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

// `photographerId`'s logo row {logo, logo_updated_at}, or null: none set, or
// a database the settings migration has not reached. Every logo read goes
// through here, each with the photographer it is for (the caller's who.id, a
// link's project.photographer_id, or the default for /api/studio/logo).
async function readLogo(env, photographerId) {
  try {
    return await env.DB.prepare(
      'SELECT logo, logo_updated_at FROM studio_settings WHERE photographer_id = ? AND logo IS NOT NULL'
    ).bind(photographerId).first();
  } catch { return null; }
}

// The extra_max a new project starts with: the studio's default when it is a
// valid one, else EXTRA_MAX_DEFAULT — also on a database without the column
// or the table yet.
async function studioDefaultExtraMax(env, photographerId) {
  try {
    const row = await env.DB.prepare('SELECT default_extra_max FROM studio_settings WHERE photographer_id = ?')
      .bind(photographerId).first();
    return isExtraMax(row?.default_extra_max) ? row.default_extra_max : EXTRA_MAX_DEFAULT;
  } catch (e) {
    if (isMissingColumn(e) || /no such table/i.test(String(e?.message || ''))) return EXTRA_MAX_DEFAULT;
    throw e;
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

// ─── Products and orders (docs/products-orders.md) ──────────────────────────
// Money is an integer NT$, tax included. Every price, cost, name and kind on
// an order line is read from the catalogue when the line is added and
// snapshotted onto it; the body only names an option. The one exception is an
// explicit admin unit_price. Totals are computed on read, never stored.
const PRODUCT_KINDS = ['print', 'album', 'service'];
// what the platform lists; a photographer's own products are services only
const PLATFORM_KINDS = ['print', 'album'];
const PRODUCT_NAME_MAX = 60;
const PRODUCT_DESCRIPTION_MAX = 500;
const OPTION_LABEL_MAX = 60;
const PRODUCT_OPTIONS_MAX = 20;
const ORDER_NOTE_MAX = 500;
const ORDER_LINES_MAX = 50;
const ORDER_QTY_MAX = 999;
// photo keys on one line (an album's set), and on one whole order
const ORDER_LINE_PHOTOS_MAX = 500;
const ORDER_PHOTOS_MAX = 1000;
// One unit price or cost. Bounded well inside a safe integer so that
// 50 lines × 999 × this still is one, whatever SUM() is asked to add up.
const MONEY_MAX = 10_000_000;
const PAID_METHODS = ['cash', 'transfer', 'other'];
const ORDER_STATUSES = ['requested', 'confirmed', 'fulfilled', 'cancelled'];
// The arrows an admin may move an order along. 'requested' is only ever a
// guest's (Phase B), so nothing leads back to it; fulfilled → confirmed is
// the undo for a mis-tap; cancelled is final.
const ORDER_ARROWS = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['fulfilled', 'cancelled'],
  fulfilled: ['confirmed', 'cancelled'],
  cancelled: [],
};
const EXTRA_PICK_NAME = '加挑照片';
// A payment date may be a day ahead (a date typed in Taipei reads as UTC
// midnight) but no further, and not before this.
const PAID_AT_MIN = Date.UTC(2000, 0, 1);
const PAID_AT_AHEAD_MS = 24 * 60 * 60 * 1000;

const isMoney = v => Number.isSafeInteger(v) && v >= 0 && v <= MONEY_MAX;
const hasField = (body, k) => Object.prototype.hasOwnProperty.call(body, k);
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
// A photographer's own (non-platform) products are service-only today and
// switched off: they sell platform products only. CUSTOM_PRODUCTS (a [vars]
// entry in wrangler.toml) turns them on when it is exactly "on"; unset or
// anything else is off, so a typo fails closed.
const customProductsEnabled = env => env.CUSTOM_PRODUCTS === 'on';
const CUSTOM_PRODUCTS_DISABLED = { error: '目前只能從平台加入商品', code: 'custom_products_disabled' };

// platform_products.min_pages / max_pages: the fewest and the most inside
// spreads an album may have (one spread = 1 P; cover and back are not
// counted). The operator's, bound to the platform product; NULL = no bound;
// albums only (a print stores NULL, like photo_count); 1–PAGE_BOUND_MAX; when
// both are set, max ≥ min. An album order outside the range is refused, never
// charged its way back in (Tim) — albumPagesProblem below, for S3. Spreads
// inside the range but above min_pages may cost extra_page_price each.
// Each column arrives in its own hand-run migration
// (2026-10-06-product-min-pages.sql, …-max-pages.sql), and either may be
// missing: pageColumns says which are there, a missing one reads null, and
// a write of a number into a missing one answers 500 <col>_unavailable
// before anything is written.
const PAGE_BOUNDS = ['min_pages', 'max_pages'];
const PAGE_BOUND_MAX = 200;
// platform_products.bleed_mm: millimetres of bleed the lab wants on each side
// of a page or print, 0–BLEED_MM_MAX inclusive, decimals allowed; NULL = 0 mm.
// Operator only, albums and prints alike (a kind change keeps it). Its own
// hand-run migration (2026-10-07-product-bleed.sql), degrading exactly like
// the page bounds: it rides along in pageColumns / pageSelect / pageBoundsFit.
const BLEED_MM_MAX = 10;
// platform_products.extra_page_price: NT$ per inside spread above min_pages
// (the option price covers the book up to min_pages), a whole number checked
// by isMoney, or NULL = extra pages not priced. Albums only, exactly like the
// page bounds (a print stores NULL, leaving album clears it, entering album
// does not bring a leftover back). Its own hand-run migration
// (2026-10-07-product-extra-page-price.sql), riding the same machinery.
// albumExtraPagesCost below turns it into a line's extra.
// platform_products.category: a short label grouping the catalogue ('婚紗相本',
// '無框畫' …), a string of at most CATEGORY_MAX characters after trim, or NULL
// ('' and only spaces are stored as NULL). Operator only, albums and prints
// alike (a kind change keeps it). Its own hand-run migration
// (2026-10-14-product-category.sql, which also backfills it from the
// description's '【…›<category>】' header), riding the same machinery.
const CATEGORY_MAX = 20;
// every optional platform_products column a hand-run migration adds, in the
// order a write judges them (min, max, bleed, extra-page price, then category)
const PRODUCT_LATE_COLUMNS = [...PAGE_BOUNDS, 'bleed_mm', 'extra_page_price', 'category'];
const PAGES_UNAVAILABLE = {
  min_pages: { error: '最少頁數功能尚未啟用', code: 'min_pages_unavailable' },
  max_pages: { error: '最多頁數功能尚未啟用', code: 'max_pages_unavailable' },
  bleed_mm: { error: '出血設定功能尚未啟用', code: 'bleed_mm_unavailable' },
  extra_page_price: { error: '加頁價格功能尚未啟用', code: 'extra_page_price_unavailable' },
  category: { error: '商品分類功能尚未啟用', code: 'category_unavailable' },
};
// The category an operator write names: {set: {category}} (empty when the
// body leaves it out: the stored value stays; trimmed, '' = NULL) or
// {bad: 'invalid_category'}.
function categoryWrite(body) {
  if (!hasField(body, 'category')) return { set: {} };
  const v = body.category;
  if (v === null) return { set: { category: null } };
  if (typeof v !== 'string') return { bad: 'invalid_category' };
  const t = v.trim();
  if (charCount(t) > CATEGORY_MAX || PICK_KEY_CONTROL.test(t)) return { bad: 'invalid_category' };
  return { set: { category: t || null } };
}
// The bleed an operator write names: {set: {bleed_mm}} (empty when the body
// leaves it out: the stored value stays) or {bad: 'invalid_bleed_mm'}.
function bleedWrite(body) {
  if (!hasField(body, 'bleed_mm')) return { set: {} };
  const v = body.bleed_mm;
  if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= BLEED_MM_MAX)) return { bad: 'invalid_bleed_mm' };
  return { set: { bleed_mm: v } };
}
// The extra-page price an operator write ends with ({set} as pageBoundsWrite:
// the column to write, if any) or {bad: 'invalid_extra_page_price'}. A named
// value is validated on any kind; on a non-album it is stored NULL (and a
// write leaving album clears it); a write entering album that does not name
// it clears a print's leftover; one that stays album and leaves it out keeps
// the stored value (and does not write it back).
function extraPagePriceWrite(body, kind, current) {
  const named = hasField(body, 'extra_page_price');
  const v = named ? body.extra_page_price : null;
  if (v !== null && !isMoney(v)) return { bad: 'invalid_extra_page_price' };
  const was = current ? current.kind : null;
  if (kind !== 'album') return { set: named || was === 'album' ? { extra_page_price: null } : {} };
  if (named) return { set: { extra_page_price: v } };
  return { set: current !== null && was !== 'album' ? { extra_page_price: null } : {} };
}
// a platform product's page bound as every response shows it: albums only
const albumOnly = (kind, v) => (kind === 'album' && v != null ? v : null);

// Which late columns this database has: {min_pages, max_pages, bleed_mm, extra_page_price, category},
// each a boolean, by a query that names the column and reads no row.
async function pageColumns(env) {
  const has = async col => {
    try {
      await env.DB.prepare(`SELECT ${col} FROM platform_products LIMIT 0`).all();
      return true;
    } catch (e) {
      if (isMissingSchema(e)) return false;
      throw e;
    }
  };
  const found = await Promise.all(PRODUCT_LATE_COLUMNS.map(has));
  return Object.fromEntries(PRODUCT_LATE_COLUMNS.map((c, i) => [c, found[i]]));
}
// the late columns for a SELECT on platform products aliased `alias`, NULL
// for one this database does not have
const pageSelect = (cols, alias = 'pp') => PRODUCT_LATE_COLUMNS.map(c => `${cols[c] ? `${alias}.${c}` : 'NULL'} AS ${c}`).join(', ');
const ALL_PAGE_COLUMNS = { min_pages: true, max_pages: true, bleed_mm: true, extra_page_price: true, category: true };
// `query(cols)` as if both columns are there (one round trip on a migrated
// database); only when that fails on a missing column, probe which are and
// run it again. Another missing column fails the retry too: never a looser
// read.
const withPageColumns = (env, query) =>
  withoutMissingColumn(() => query(ALL_PAGE_COLUMNS), async () => query(await pageColumns(env)));

// The page bounds an operator write ends with. `kind`: the product's kind
// after the write; `current`: the stored row ({kind, min_pages, max_pages}),
// null on create. A bound the body names is validated (400 invalid_<col>);
// one it leaves out keeps the stored value as every read shows it (albums
// only: a print's leftover value counts for nothing). On a non-album both
// are NULL (a write leaving album clears both); a write entering album
// clears whatever it does not name, so no hidden value comes back. The
// merged pair must have max ≥ min (400 invalid_page_range). Returns
// {set: {col: value}} — the columns to write — or {bad: code}.
function pageBoundsWrite(body, kind, current) {
  const named = {};
  for (const col of PAGE_BOUNDS) {
    if (!hasField(body, col)) continue;
    const v = body[col];
    if (v !== null && !(Number.isSafeInteger(v) && v >= 1 && v <= PAGE_BOUND_MAX)) return { bad: `invalid_${col}` };
    named[col] = v;
  }
  const was = current ? current.kind : null;
  const set = {};
  if (kind !== 'album') {
    for (const col of PAGE_BOUNDS) if (hasField(named, col) || was === 'album') set[col] = null;
    return { set };
  }
  const stored = col => (current ? albumOnly(current.kind, current[col]) : null);
  for (const col of PAGE_BOUNDS) set[col] = hasField(named, col) ? named[col] : stored(col);
  if (set.min_pages !== null && set.max_pages !== null && set.max_pages < set.min_pages) return { bad: 'invalid_page_range' };
  // write only what changes: the named bounds, and on entering album the
  // others (NULL, clearing a print's leftovers); a create names nothing
  // else (NULL is the default)
  const entering = current !== null && was !== 'album';
  for (const col of PAGE_BOUNDS) if (!hasField(named, col) && !entering) delete set[col];
  return { set };
}

// `set` (from pageBoundsWrite) fitted to the columns this database has: a
// NULL for a missing column is dropped (there is nothing to clear), a number
// is {unavailable: the 500 body}. Returns {set} or {unavailable}.
function pageBoundsFit(set, cols) {
  const out = {};
  for (const col of PRODUCT_LATE_COLUMNS) {
    if (!hasField(set, col)) continue;
    if (cols[col]) out[col] = set[col];
    else if (set[col] !== null) return { unavailable: PAGES_UNAVAILABLE[col] };
  }
  return { set: out };
}

// Whether an album order line's page count fits its product (docs/guest-shop.md,
// S3): `spreads` is the line's layout page count (one layout page = one
// spread = 1 P), `product` the line's platform product ({kind, min_pages,
// max_pages}). null when it fits or the product is not an album (no bounds);
// otherwise the 400 code. Pure and self-contained (a test takes its source).
// Not called yet: no order path carries an album layout.
function albumPagesProblem(spreads, product) {
  if (!(Number.isSafeInteger(spreads) && spreads >= 0)) return 'invalid_layout';
  if (!product || product.kind !== 'album') return null;
  const bound = v => (Number.isSafeInteger(v) && v >= 1 ? v : null);
  const min = bound(product.min_pages);
  const max = bound(product.max_pages);
  if (min !== null && spreads < min) return 'pages_below_min';
  if (max !== null && spreads > max) return 'pages_above_max';
  return null;
}

// What an album line's spreads above min_pages cost (docs/products-orders.md,
// extra_page_price): {extraPages, cost} with extraPages = max(0, spreads −
// min_pages) (a missing min_pages counts as 0) and cost = extraPages ×
// extra_page_price. null when the product is not an album, extra pages are
// not priced (extra_page_price not a whole number ≥ 0), `spreads` is not a
// whole number ≥ 1, spreads exceed max_pages (albumPagesProblem's
// pages_above_max: refused, never priced) or the cost leaves the safe-integer
// range. Below min_pages it is {0, 0}: that refusal is albumPagesProblem's.
// Pure; calls only albumPagesProblem (a test takes both sources).
// Not called yet: no order path carries an album layout.
function albumExtraPagesCost(product, spreads) {
  if (!product || product.kind !== 'album') return null;
  const price = product.extra_page_price;
  if (!(Number.isSafeInteger(price) && price >= 0)) return null;
  if (!(Number.isSafeInteger(spreads) && spreads >= 1)) return null;
  if (albumPagesProblem(spreads, product) === 'pages_above_max') return null;
  const min = Number.isSafeInteger(product.min_pages) && product.min_pages >= 1 ? product.min_pages : 0;
  const extraPages = Math.max(0, spreads - min);
  const cost = extraPages * price;
  if (!Number.isSafeInteger(cost)) return null;
  return { extraPages, cost };
}

// 400 {error, code}, the settings route's shape
const orderBad = (code, error) => jsonOk({ error: error ?? `${code.replace(/_/g, ' ')}`, code }, 400);

// Each order's computed money, for a query over `orders o`. One definition,
// shared by the order reads, the list's unpaid filter and the stats, so the
// three cannot disagree. Outstanding counts only what the studio agreed to
// sell: a guest's request (Phase B) and a cancelled order owe nothing.
const ORDER_SUBTOTAL_SQL = '(SELECT COALESCE(SUM(i.unit_price * i.qty), 0) FROM order_items i WHERE i.order_id = o.id)';
const ORDER_COST_SQL = '(SELECT COALESCE(SUM(i.unit_cost * i.qty), 0) FROM order_items i WHERE i.order_id = o.id)';
const ORDER_TOTAL_SQL = `MAX(0, ${ORDER_SUBTOTAL_SQL} - o.discount)`;
const ORDER_OUTSTANDING_SQL = `(CASE WHEN o.status IN ('confirmed', 'fulfilled') THEN MAX(0, ${ORDER_TOTAL_SQL} - o.paid_amount) ELSE 0 END)`;
// An order is this photographer's only if its project is too, so a row that
// names another photographer's project reads as not found.
const ORDER_SCOPE_SQL = 'FROM orders o JOIN projects p ON p.id = o.project_id AND p.photographer_id = o.photographer_id WHERE o.photographer_id = ?';

// The product columns a body may set, validated. `partial` is PUT, where a
// field left out keeps its value; POST needs kind and name. Returns {set} or
// {bad: code}. photographer_id, active and the image are never read here.
function productFields(body, partial, kinds = PRODUCT_KINDS, guestVisible = true) {
  const set = {};
  if (!partial || hasField(body, 'kind')) {
    if (!kinds.includes(body.kind)) return { bad: 'invalid_kind' };
    set.kind = body.kind;
  }
  if (!partial || hasField(body, 'name')) {
    const v = typeof body.name === 'string' ? body.name.trim() : '';
    if (!v || charCount(v) > PRODUCT_NAME_MAX || PICK_KEY_CONTROL.test(v)) return { bad: 'invalid_name' };
    set.name = v;
  }
  if (hasField(body, 'description')) {
    const v = body.description === null ? '' : body.description;
    if (typeof v !== 'string' || charCount(v.trim()) > PRODUCT_DESCRIPTION_MAX) return { bad: 'invalid_description' };
    set.description = v.trim();
  }
  if (hasField(body, 'photo_count')) {
    const v = body.photo_count;
    if (v !== null && !(Number.isSafeInteger(v) && v >= 1 && v <= ORDER_LINE_PHOTOS_MAX)) return { bad: 'invalid_photo_count' };
    set.photo_count = v;
  }
  if (guestVisible && hasField(body, 'guest_visible')) {
    const v = body.guest_visible;
    if (![true, false, 0, 1].includes(v)) return { bad: 'invalid_guest_visible' };
    set.guest_visible = v ? 1 : 0;
  }
  if (hasField(body, 'sort')) {
    if (!(Number.isSafeInteger(body.sort) && body.sort >= 0)) return { bad: 'invalid_sort' };
    set.sort = body.sort;
  }
  return { set };
}

// The money on an option: [field, code, default]. A photographer's own
// (service) option has a price and a cost; a platform option a vendor cost
// and a platform price, both required.
const CUSTOM_MONEY = [['price', 'invalid_price'], ['cost', 'invalid_cost', 0]];
const PLATFORM_MONEY = [['vendor_cost', 'invalid_vendor_cost'], ['platform_price', 'invalid_platform_price']];

// A product's options as a set: 1..PRODUCT_OPTIONS_MAX of {id?, label,
// ...money}. An id must be one of `existingIds` (this product's own; none
// on create), once. The array order is the sort order. Returns {options} or
// {bad: code}.
function productOptions(value, existingIds, money = CUSTOM_MONEY) {
  if (!Array.isArray(value) || !value.length || value.length > PRODUCT_OPTIONS_MAX) return { bad: 'invalid_options' };
  const seen = new Set();
  const options = [];
  for (const [i, o] of value.entries()) {
    if (!isPlainObject(o)) return { bad: 'invalid_options' };
    if (o.id !== undefined) {
      if (typeof o.id !== 'string' || !existingIds.has(o.id) || seen.has(o.id)) return { bad: 'invalid_options' };
      seen.add(o.id);
    }
    const label = o.label === undefined || o.label === null ? '' : o.label;
    if (typeof label !== 'string' || charCount(label.trim()) > OPTION_LABEL_MAX || PICK_KEY_CONTROL.test(label.trim())) return { bad: 'invalid_label' };
    const option = { id: o.id, label: label.trim(), sort: i };
    for (const [field, code, dflt] of money) {
      const v = o[field] === undefined && dflt !== undefined ? dflt : o[field];
      if (!isMoney(v)) return { bad: code };
      option[field] = v;
    }
    options.push(option);
  }
  return { options };
}

// An adopted product's options as a set: 1..PRODUCT_OPTIONS_MAX of
// {platform_option_id, price}, each an option of the adopted platform product
// (`platformOptions`: its options by id, `active` already false when the
// product is retired), once, active, and priced at or above its platform
// price. Label and cost are the platform's. Returns {options} or {bad: code}.
function adoptedOptions(value, platformOptions) {
  if (!Array.isArray(value) || !value.length || value.length > PRODUCT_OPTIONS_MAX) return { bad: 'invalid_options' };
  const seen = new Set();
  const options = [];
  for (const [i, o] of value.entries()) {
    if (!isPlainObject(o)) return { bad: 'invalid_options' };
    const po = typeof o.platform_option_id === 'string' ? platformOptions.get(o.platform_option_id) : null;
    if (!po || seen.has(po.id)) return { bad: 'invalid_options' };
    seen.add(po.id);
    if (!isMoney(o.price)) return { bad: 'invalid_price' };
    if (!po.active) return { bad: 'retired_option' };
    if (o.price < po.platform_price) return { bad: 'below_platform_price' };
    options.push({ platform_option_id: po.id, label: po.label, price: o.price, cost: po.platform_price, sort: i });
  }
  return { options };
}

// A platform product's options by id, for adoptedOptions: active only while
// the platform product is too.
async function platformOptionMap(env, platformProductId) {
  const { results } = await env.DB.prepare(
    `SELECT po.id, po.label, po.platform_price, po.active AND pp.active AS active
       FROM platform_product_options po JOIN platform_products pp ON pp.id = po.platform_product_id
      WHERE po.platform_product_id = ?`
  ).bind(platformProductId).all();
  return new Map(results.map(r => [r.id, r]));
}

// The statements that write a catalogue product's fields (`set`, column names
// from productFields' fixed list) and, when `opts` is given, its whole active
// option set: an option with an id is updated (and restored), one without is
// inserted, every other one is retired, never deleted — order lines point at
// them. `t` names the tables and option columns, all fixed strings.
// `ownerId`: the photographer whose product it is (who.id), for the tables a
// photographer owns, and null for the platform's (the operator's): every
// statement on an owned product re-checks the owner itself, so an option
// write never lands on a product that is not the caller's, whatever was read
// before the batch.
const CUSTOM_TABLES = { products: 'products', options: 'product_options', fk: 'product_id', owned: true, cols: ['label', 'price', 'cost'] };
const ADOPTED_TABLES = { ...CUSTOM_TABLES, cols: ['label', 'price', 'cost', 'platform_option_id'] };
const PLATFORM_TABLES = { products: 'platform_products', options: 'platform_product_options', fk: 'platform_product_id', owned: false, cols: ['label', 'vendor_cost', 'platform_price'] };
function catalogueWrites(env, t, ownerId, id, set, opts, now) {
  if (t.owned !== (typeof ownerId === 'string' && ownerId !== '')) throw new Error('catalogueWrites: an owned table needs its owner, the platform none');
  const cols = [...Object.keys(set), 'updated_at'];
  const owner = t.owned ? [ownerId] : [];
  // the owner gate on an option statement (none for the platform's tables)
  const mine = t.owned ? ` AND EXISTS (SELECT 1 FROM ${t.products} WHERE id = ? AND photographer_id = ?)` : '';
  const mineBinds = t.owned ? [id, ownerId] : [];
  const statements = [env.DB.prepare(
    `UPDATE ${t.products} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?${t.owned ? ' AND photographer_id = ?' : ''}`
  ).bind(...Object.values(set), now, id, ...owner)];
  if (!opts) return statements;
  statements.push(env.DB.prepare(`UPDATE ${t.options} SET active = 0 WHERE ${t.fk} = ?${mine}`).bind(id, ...mineBinds));
  for (const o of opts) {
    const values = t.cols.map(c => o[c]);
    statements.push(o.id
      ? env.DB.prepare(`UPDATE ${t.options} SET ${t.cols.map(c => `${c} = ?`).join(', ')}, sort = ?, active = 1 WHERE id = ? AND ${t.fk} = ?${mine}`)
        .bind(...values, o.sort, o.id, id, ...mineBinds)
      : t.owned
        ? env.DB.prepare(`INSERT INTO ${t.options} (id, ${t.fk}, ${t.cols.join(', ')}, sort) SELECT ?, ?, ${t.cols.map(() => '?').join(', ')}, ? WHERE 1${mine}`)
          .bind(crypto.randomUUID(), id, ...values, o.sort, ...mineBinds)
        : env.DB.prepare(`INSERT INTO ${t.options} (id, ${t.fk}, ${t.cols.join(', ')}, sort) VALUES (?, ?, ${t.cols.map(() => '?').join(', ')}, ?)`)
          .bind(crypto.randomUUID(), id, ...values, o.sort));
  }
  return statements;
}

// `photographerId`'s products (the caller's who.id) with their options, retired ones included and
// flagged; `id` narrows it to one. Never the image bytes. An adopted product
// reads the platform's live kind, name, description, photo_count, image and
// option labels, and its options' cost is the current platform price, flagged
// when the photographer's price has fallen below it. Never the vendor cost.
async function readProducts(env, photographerId, id = null) {
  if (typeof photographerId !== 'string' || !photographerId) throw new Error('readProducts: no photographer');
  const one = id === null ? '' : ' AND p.id = ?2';
  const binds = id === null ? [photographerId] : [photographerId, id];
  const own = (col, expr = `p.${col}`) => `CASE WHEN pp.id IS NULL THEN ${expr} ELSE ${expr.replace('p.', 'pp.')} END AS ${col}`;
  // the page bounds are the platform's only (a custom product has none), and
  // null for a column the database does not have yet
  const { results: products } = await withPageColumns(env, cols => env.DB.prepare(
    `SELECT p.id, ${own('kind')}, ${own('name')}, ${own('description')}, ${own('photo_count')},
            ${pageSelect(cols)},
            p.guest_visible, p.active, p.sort,
            ${own('has_image', 'p.image IS NOT NULL')}, ${own('image_type')}, ${own('image_updated_at')},
            p.created_at, p.updated_at, p.platform_product_id, pp.active AS platform_active
       FROM products p LEFT JOIN platform_products pp ON pp.id = p.platform_product_id
      WHERE p.photographer_id = ?1${one} ORDER BY p.active DESC, p.sort, p.created_at, p.rowid`
  ).bind(...binds).all());
  const { results: options } = await env.DB.prepare(
    `SELECT o.id, o.product_id, COALESCE(po.label, o.label) AS label, o.price,
            COALESCE(po.platform_price, o.cost) AS cost, o.active, o.sort,
            o.platform_option_id, po.platform_price, po.active AS platform_active
       FROM product_options o JOIN products p ON p.id = o.product_id
       LEFT JOIN platform_product_options po ON po.id = o.platform_option_id
      WHERE p.photographer_id = ?1${one} ORDER BY o.sort, o.rowid`
  ).bind(...binds).all();
  return products.map(p => ({
    ...p,
    min_pages: albumOnly(p.kind, p.min_pages),
    max_pages: albumOnly(p.kind, p.max_pages),
    extra_page_price: albumOnly(p.kind, p.extra_page_price),
    has_image: !!p.has_image,
    options: options.filter(o => o.product_id === p.id).map(({ product_id, ...o }) => ({
      ...o,
      below_platform_price: o.platform_price !== null && o.price < o.platform_price,
    })),
  }));
}

// The platform catalogue as the operator sees it: every product, retired ones
// included, with every option and its vendor cost. `id` narrows it to one.
// Never the image bytes. Operator routes only.
async function readPlatformProducts(env, id = null) {
  const one = id === null ? '' : ' WHERE pp.id = ?';
  const binds = id === null ? [] : [id];
  const { results: products } = await withPageColumns(env, cols => env.DB.prepare(
    `SELECT pp.id, pp.kind, pp.name, pp.description, pp.photo_count, ${pageSelect(cols)},
            pp.active, pp.sort,
            pp.image IS NOT NULL AS has_image, pp.image_type, pp.image_updated_at, pp.created_at, pp.updated_at
       FROM platform_products pp${one} ORDER BY pp.active DESC, pp.sort, pp.created_at, pp.rowid`
  ).bind(...binds).all());
  const { results: options } = await env.DB.prepare(
    `SELECT po.id, po.platform_product_id, po.label, po.vendor_cost, po.platform_price, po.active, po.sort
       FROM platform_product_options po JOIN platform_products pp ON pp.id = po.platform_product_id${one}
      ORDER BY po.sort, po.rowid`
  ).bind(...binds).all();
  return products.map(p => ({
    ...p,
    min_pages: albumOnly(p.kind, p.min_pages),
    max_pages: albumOnly(p.kind, p.max_pages),
    extra_page_price: albumOnly(p.kind, p.extra_page_price),
    has_image: !!p.has_image,
    options: options.filter(o => o.platform_product_id === p.id).map(({ platform_product_id, ...o }) => o),
  }));
}

// ─── Guest shop, read only (docs/guest-shop.md, S1 trimmed) ─────────────────
// What a guest holding a delivered pick link may buy: the products of the
// photographer who owns the link's project (never a value from the request)
// that are adopted from the platform, print or album, shown to guests, and
// live on both sides, each with the options a guest could order today.
// An option is sellable when it and its platform option are active, the
// platform option belongs to this very product's platform product, and the
// photographer's price is not under today's platform price — exactly what
// orderLines would accept, at the price it would charge (the option's
// `price`). Built from a named field list: never cost, platform_price,
// vendor_cost or any platform option id. Capped: GUEST_SHOP_PRODUCTS_MAX
// products × PRODUCT_OPTIONS_MAX options.
const GUEST_SHOP_PRODUCTS_MAX = 50;
const SHOP_UNAVAILABLE = { error: '商品資訊暫時無法顯示', code: 'shop_unavailable' };
const GUEST_SELLABLE_SQL = 'o.active = 1 AND po.active = 1 AND po.platform_product_id = p.platform_product_id AND o.price >= po.platform_price';
const GUEST_OPTION_JOIN = 'FROM product_options o JOIN platform_product_options po ON po.id = o.platform_option_id';

// {products} for the guest, or null when the catalogue tables are not there
// (a hand-run migration missing): the route answers 500, never a guess.
async function readGuestShop(env, photographerId) {
  try {
    const { results: products } = await withPageColumns(env, cols => env.DB.prepare(
      `SELECT p.id, pp.id AS platform_id, pp.kind, pp.name, pp.description, pp.photo_count,
              ${pageSelect(cols)}, pp.image IS NOT NULL AS has_image, pp.image_updated_at
         FROM products p JOIN platform_products pp ON pp.id = p.platform_product_id
        WHERE p.photographer_id = ?1 AND p.guest_visible = 1 AND p.active = 1 AND pp.active = 1
          AND pp.kind IN ('print', 'album') AND p.kind IN ('print', 'album')
          AND EXISTS (SELECT 1 ${GUEST_OPTION_JOIN} WHERE o.product_id = p.id AND ${GUEST_SELLABLE_SQL})
        ORDER BY p.sort, p.created_at, p.rowid LIMIT ${GUEST_SHOP_PRODUCTS_MAX}`
    ).bind(photographerId).all());
    if (!products.length) return [];
    const { results: options } = await env.DB.prepare(
      `SELECT o.id, o.product_id, po.label, o.price ${GUEST_OPTION_JOIN} JOIN products p ON p.id = o.product_id
        WHERE p.photographer_id = ?1 AND o.product_id IN (${products.map((_, i) => `?${i + 2}`).join(', ')})
          AND ${GUEST_SELLABLE_SQL}
        ORDER BY o.sort, o.rowid`
    ).bind(photographerId, ...products.map(p => p.id)).all();
    return products.map(p => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      description: p.description ?? '',
      photo_count: albumOnly(p.kind, p.photo_count),
      min_pages: albumOnly(p.kind, p.min_pages),
      max_pages: albumOnly(p.kind, p.max_pages),
      // mm on each side, prints and albums; null = 0 mm
      bleed_mm: p.bleed_mm ?? null,
      // album only: NT$ per spread above min_pages; null = not priced
      extra_page_price: albumOnly(p.kind, p.extra_page_price),
      // the operator's short label ('婚紗相本'); null = none
      category: p.category ?? null,
      // the public image route (relative to the Worker), versioned by when
      // the operator last changed it
      image_url: p.has_image
        ? `/api/platform/products/${encodeURIComponent(p.platform_id)}/image?v=${encodeURIComponent(p.image_updated_at || '')}`
        : null,
      options: options.filter(o => o.product_id === p.id).slice(0, PRODUCT_OPTIONS_MAX)
        .map(o => ({ id: o.id, label: o.label, price: o.price })),
    })).filter(p => p.options.length);
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
}

// `photographerId`'s orders (the caller's who.id; ORDER_SCOPE_SQL also wants
// the order's project to be that photographer's) matching `where` (on `o`),
// newest first, with
// their lines and computed money. Named columns, never o.* (docs/guest-shop.md
// S2): request_id stays in the database, and a column a later migration adds
// cannot reach a response unannounced. The guest-order columns (contact,
// delivery, consent) come back as `contact` {name, phone, line, erased_at}
// (null on an order without one), `delivery_method` and `consent_version`;
// before the S2 migration they read null. `project_delivered`: the project
// is delivered right now (an order is never touched by undeliver / reopen,
// docs/guest-shop.md §3.4, so the photographer is shown it instead).
const ORDER_BASE_COLUMNS = ['id', 'photographer_id', 'project_id', 'source', 'status', 'picker_id', 'discount', 'paid_amount', 'paid_at',
  'paid_method', 'note', 'guest_note', 'created_at', 'updated_at', 'confirmed_at', 'fulfilled_at', 'cancelled_at'];
const ORDER_GUEST_COLUMNS = ['contact_name', 'contact_phone', 'contact_line', 'delivery_method', 'consent_version', 'contact_erased_at'];
const ORDER_ITEM_LATE_COLUMNS = ['list_price', 'layout'];
const lateColumns = (alias, cols, late) => cols.map(c => (late ? `${alias}.${c}` : `NULL AS ${c}`)).join(', ');
async function readOrders(env, photographerId, where, binds, limit = 500) {
  if (typeof photographerId !== 'string' || !photographerId) throw new Error('readOrders: no photographer');
  const { results: orders } = await withoutMissingColumn(...[true, false].map(late => () => env.DB.prepare(
    `SELECT ${ORDER_BASE_COLUMNS.map(c => `o.${c}`).join(', ')}, ${lateColumns('o', ORDER_GUEST_COLUMNS, late)},
            p.title AS project_title, (p.delivered_at IS NOT NULL AND p.final_folders IS NOT NULL) AS project_delivered,
            ${ORDER_SUBTOTAL_SQL} AS subtotal, ${ORDER_TOTAL_SQL} AS total,
            ${ORDER_COST_SQL} AS cost, ${ORDER_OUTSTANDING_SQL} AS outstanding
       ${ORDER_SCOPE_SQL} AND ${where} ORDER BY o.created_at DESC, o.rowid DESC LIMIT ${limit}`
  ).bind(photographerId, ...binds).all()));
  if (!orders.length) return [];
  const { results: items } = await withoutMissingColumn(...[true, false].map(late => () => env.DB.prepare(
    // named columns, never i.*: vendor_cost is the operator's and must not
    // reach an admin response
    `SELECT i.id, i.order_id, i.kind, i.product_id, i.option_id, i.name, i.option_label, i.unit_price, i.unit_cost,
            i.qty, i.photo_keys, i.platform_option_id, ${lateColumns('i', ORDER_ITEM_LATE_COLUMNS, late)}
       FROM order_items i WHERE i.order_id IN (SELECT o.id ${ORDER_SCOPE_SQL} AND ${where}
       ORDER BY o.created_at DESC, o.rowid DESC LIMIT ${limit}) ORDER BY i.rowid`
  ).bind(photographerId, ...binds).all()));
  return orders.map(({ contact_name, contact_phone, contact_line, contact_erased_at, project_delivered, ...o }) => ({
    ...o,
    contact: contact_name != null || contact_erased_at != null
      ? { name: contact_name, phone: contact_phone, line: contact_line, erased_at: contact_erased_at } : null,
    project_delivered: project_delivered === 1,
    items: items.filter(i => i.order_id === o.id).map(i => ({ ...i, photo_keys: parsePhotoKeys(i.photo_keys), layout: parseLayout(i.layout) })),
  }));
}

// An order_items.layout back as an object; null when there is none or it
// will not parse as one.
function parseLayout(json) {
  if (typeof json !== 'string') return null;
  try {
    const v = JSON.parse(json);
    return isPlainObject(v) ? v : null;
  } catch { return null; }
}

async function readOrder(env, photographerId, id) {
  const [order] = await readOrders(env, photographerId, 'o.id = ?', [id], 1);
  return order || null;
}

// The folders an order line's photo may be in. The photographer's (admin):
// the project's proofs and its last chosen finals (final_folders, kept after
// undeliver and reopen — docs/guest-shop.md §11 Q17: a print is nearly always
// of a final). A guest's: the finals of the delivery up now, through
// pickFinals and nothing else (never a proof, even with the proof originals
// switch on).
function orderPhotoFolders(project, guest) {
  if (guest) return pickFinals(project) || [];
  const parsed = v => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch { return null; } };
  const proofs = parsed(project.folders) || [];
  const finals = typeof project.final_folders === 'string' ? finalFolders(parsed(project.final_folders)) : null;
  return [...proofs, ...(finals || [])];
}

// An order's lines, validated, as the order_items rows they become.
// `project` (the projects row) gives the folders every photo key must be
// inside (orderPhotoFolders); `existing` is the order's current items by id,
// photo_keys parsed (PUT), or null (create). A line with an id keeps its
// snapshot and may change only qty, photo_keys and unit_price (a photo it
// already carries is not re-checked: a later delivery may have moved the
// finals); a line without one names an active option of an active product of
// `photographerId`, and everything else is read from there, list_price (the
// catalogue price) included. `guest`: the guest order path — finals only, and
// unit_price is never read from the input. Returns {lines} or {bad: code}.
async function orderLines(env, project, input, existing, { guest = false, photographerId } = {}) {
  // every caller names the owner: the admin routes who.id, the guest path the
  // link's project's photographer — never a default
  if (typeof photographerId !== 'string' || !photographerId) throw new Error('orderLines: no photographer');
  if (!Array.isArray(input) || !input.length) return { bad: 'invalid_lines' };
  if (input.length > ORDER_LINES_MAX) return { bad: 'too_many_lines' };
  if (guest && existing) return { bad: 'invalid_lines' };
  const scope = { folders: orderPhotoFolders(project, guest) };
  const seen = new Set();
  const lines = [];
  let photos = 0;
  for (const l of input) {
    if (!isPlainObject(l)) return { bad: 'invalid_lines' };
    let old = null;
    if (l.id !== undefined) {
      old = existing && typeof l.id === 'string' ? existing.get(l.id) : null;
      if (!old || seen.has(l.id)) return { bad: 'unknown_line' };
      seen.add(l.id);
      if (l.option_id !== undefined && l.option_id !== old.option_id) return { bad: 'invalid_lines' };
    }
    const qty = l.qty === undefined && old ? old.qty : l.qty;
    if (!(Number.isSafeInteger(qty) && qty >= 1 && qty <= ORDER_QTY_MAX)) return { bad: 'invalid_qty' };
    if (!guest && l.unit_price !== undefined && l.unit_price !== null && !isMoney(l.unit_price)) return { bad: 'invalid_unit_price' };
    const keys = old && l.photo_keys === undefined ? old.photo_keys : (l.photo_keys ?? []);
    if (!Array.isArray(keys) || keys.length > ORDER_LINE_PHOTOS_MAX) return { bad: 'invalid_photo_keys' };
    if (!keys.every(pickKeyValid) || new Set(keys).size !== keys.length) return { bad: 'invalid_photo_keys' };
    const carried = new Set(old && Array.isArray(old.photo_keys) ? old.photo_keys : []);
    if (!keys.every(k => carried.has(k) || pickKeyAllowed(scope, k))) return { bad: 'photo_not_in_project' };
    photos += keys.length;
    if (photos > ORDER_PHOTOS_MAX) return { bad: 'invalid_photo_keys' };
    lines.push({ l, old, qty, keys });
  }
  // every new line's option in one read, scoped to this photographer
  const wanted = [...new Set(lines.filter(x => !x.old).map(x => x.l.option_id))];
  if (wanted.some(id => typeof id !== 'string')) return { bad: 'unknown_option' };
  const catalogue = new Map();
  if (wanted.length) {
    const { results } = await env.DB.prepare(
      // an adopted option reads the platform's live name, label, price and
      // vendor cost; a platform row that is missing reads as retired
      `SELECT o.id, COALESCE(po.label, o.label) AS label, o.price, o.cost, o.active AS option_active,
              p.id AS product_id, COALESCE(pp.kind, p.kind) AS kind, COALESCE(pp.name, p.name) AS name, p.active AS product_active,
              o.platform_option_id, po.platform_price, po.vendor_cost, po.active AND pp.active AS platform_active
         FROM product_options o JOIN products p ON p.id = o.product_id
         LEFT JOIN platform_product_options po ON po.id = o.platform_option_id
         LEFT JOIN platform_products pp ON pp.id = p.platform_product_id AND pp.id = po.platform_product_id
        WHERE p.photographer_id = ? AND o.id IN (${wanted.map(() => '?').join(', ')})`
    ).bind(photographerId, ...wanted).all();
    for (const r of results) catalogue.set(r.id, r);
  }
  // A kept platform line's snapshot covers the units already sold, not new
  // ones: a line that grows needs its platform option live, one read for all
  // of them.
  const grown = [...new Set(lines.filter(x => x.old && x.old.platform_option_id && x.qty > x.old.qty).map(x => x.old.platform_option_id))];
  const live = new Map();
  if (grown.length) {
    const { results } = await env.DB.prepare(
      `SELECT po.id, po.platform_price, po.active AND pp.active AS active
         FROM platform_product_options po JOIN platform_products pp ON pp.id = po.platform_product_id
        WHERE po.id IN (${grown.map(() => '?').join(', ')})`
    ).bind(...grown).all();
    for (const r of results) live.set(r.id, r);
  }
  const out = [];
  for (const { l, old, qty, keys } of lines) {
    let row;
    if (old) {
      row = { ...old, qty, unit_price: l.unit_price ?? old.unit_price };
      // a platform line is never repriced under what it costs the studio
      if (old.platform_option_id && l.unit_price != null && row.unit_price < old.unit_cost) return { bad: 'below_platform_price' };
      // more units: the platform must still sell it, at no more than this
      // line's cost (one cost per line; after a raise, a new line)
      if (old.platform_option_id && qty > old.qty) {
        const p = live.get(old.platform_option_id);
        if (!p || !p.active) return { bad: 'retired_option' };
        if (p.platform_price > old.unit_cost) return { bad: 'below_platform_price', error: '平台價已調高，多的數量請另加新的一行' };
      }
    } else {
      const c = catalogue.get(l.option_id);
      if (!c) return { bad: 'unknown_option' };
      if (!c.option_active || !c.product_active) return { bad: 'retired_option' };
      const platform = c.platform_option_id !== null;
      if (platform && !c.platform_active) return { bad: 'retired_option' };
      row = {
        id: crypto.randomUUID(), kind: c.kind, product_id: c.product_id, option_id: c.id,
        name: c.name, option_label: c.label, qty,
        // a guest's line is always the catalogue's price; only the
        // photographer may name another
        unit_price: guest ? c.price : (l.unit_price ?? c.price),
        list_price: c.price,
        // an adopted option costs the platform price of today, and snapshots
        // the vendor's cost and which platform option it was
        unit_cost: platform ? c.platform_price : c.cost,
        vendor_cost: platform ? c.vendor_cost : 0,
        platform_option_id: platform ? c.platform_option_id : null,
      };
      // the platform price is a floor, the admin's override included
      if (platform && row.unit_price < c.platform_price) return { bad: 'below_platform_price' };
    }
    // service and extra-pick lines carry no photos; a print is one photo per
    // unit at most (none yet is fine); an album's photo_count is advisory
    if ((row.kind === 'service' || row.kind === 'extra_pick') && keys.length) return { bad: 'invalid_photo_keys' };
    if (row.kind === 'print' && keys.length > qty) return { bad: 'invalid_photo_keys' };
    out.push({ ...row, photo_keys: JSON.stringify(keys), isNew: !old });
  }
  return { lines: out };
}

const linesSubtotal = lines => lines.reduce((n, l) => n + l.unit_price * l.qty, 0);

// A discount is a safe integer ≥ 0 no larger than the subtotal it comes off.
function orderDiscount(value, subtotal) {
  if (!Number.isSafeInteger(value) || value < 0) return 'invalid_discount';
  if (value > subtotal) return 'discount_exceeds_subtotal';
  return null;
}

// The photographer's own note: a string (null clears it) ≤ ORDER_NOTE_MAX.
function orderNote(value) {
  const v = value === null ? '' : value;
  if (typeof v !== 'string' || charCount(v.trim()) > ORDER_NOTE_MAX) return null;
  return v.trim();
}

// The extra-pick fee of a submission row (its own snapshot of the plan, never
// the live project): max(0, count − pick_limit) × extra_price. No
// submission, no limit or no price is a fee of 0.
function extraPickFee(sub) {
  const count = sub ? sub.count : null;
  const limit = sub ? sub.pick_limit : null;
  const price = sub ? sub.extra_price : null;
  const extra = count != null && limit != null ? Math.max(0, count - limit) : 0;
  const fee = price != null ? extra * price : 0;
  return { count, pick_limit: limit, extra_price: price, extra, fee };
}

// The latest submission of a project, the one a fee is charged from — of
// `ownerId`'s project only: someone else's project reads as one with no
// submission, the same as an id that does not exist (start-retouch reads it
// before its own gate, and must not tell the two apart by what it does next).
function latestSubmission(env, projectId, ownerId) {
  return env.DB.prepare(
    'SELECT id, count, pick_limit, extra_price FROM submissions WHERE project_id = ? ' +
    'AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).bind(projectId, projectId, ownerId).first();
}

// The writes that bring a project's automatic extra-pick order in line with
// `fee`, for start-retouch to run in the same batch as its phase move. Each
// statement also carries `gate` (SQL on projects, with its binds), so it only
// lands if the phase move did. Only an unpaid order with source 'system' is
// ever rewritten or removed, and that is re-checked inside each statement;
// a new one is only inserted when the project has no system order and no
// order with an extra-pick line at all, so one the photographer edited
// (source 'admin', cancelled included) is never replaced behind their back.
// `ownerId`: the photographer whose project it is (the caller, who.id); the
// system order is looked up and written as theirs, and `gate` re-checks the
// project is still theirs inside every statement.
async function extraPickWrites(env, ownerId, projectId, fee, gate, gateBinds) {
  const now = new Date().toISOString();
  const gated = (sql, ...binds) => env.DB.prepare(`${sql} AND EXISTS (SELECT 1 FROM projects WHERE ${gate})`)
    .bind(...binds, ...gateBinds);
  const sys = await env.DB.prepare(
    "SELECT id, paid_amount FROM orders WHERE project_id = ? AND photographer_id = ? AND source = 'system' ORDER BY created_at, rowid LIMIT 1"
  ).bind(projectId, ownerId).first();
  const unpaidSystem = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND source = 'system' AND paid_amount = 0)";
  if (sys) {
    if (sys.paid_amount > 0) return [];
    if (fee.fee > 0) {
      return [
        gated(`UPDATE order_items SET qty = ?, unit_price = ?, name = ? WHERE order_id = ? AND kind = 'extra_pick' AND ${unpaidSystem}`,
          fee.extra, fee.extra_price, EXTRA_PICK_NAME, sys.id, sys.id),
        gated("UPDATE orders SET updated_at = ? WHERE id = ? AND source = 'system' AND paid_amount = 0", now, sys.id),
      ];
    }
    // the items first: their gate reads the order row the second one deletes
    return [
      gated(`DELETE FROM order_items WHERE order_id = ? AND ${unpaidSystem}`, sys.id, sys.id),
      gated("DELETE FROM orders WHERE id = ? AND source = 'system' AND paid_amount = 0", sys.id),
    ];
  }
  if (fee.fee <= 0) return [];
  const id = crypto.randomUUID();
  return [
    gated(
      "INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at, confirmed_at) " +
      "SELECT ?, ?, ?, 'system', 'confirmed', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM orders WHERE project_id = ? AND source = 'system') " +
      "AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.project_id = ? AND i.kind = 'extra_pick')",
      id, ownerId, projectId, now, now, now, projectId, projectId),
    gated(
      "INSERT INTO order_items (id, order_id, kind, name, option_label, unit_price, unit_cost, qty, photo_keys) " +
      "SELECT ?, ?, 'extra_pick', ?, '', ?, 0, ?, '[]' WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)",
      crypto.randomUUID(), id, EXTRA_PICK_NAME, fee.extra_price, fee.extra, id),
  ];
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
  return typeof key === 'string' && !overChars(key, PICK_PHOTO_KEY_MAX) &&
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

// ─── Delivery (docs/delivery.md) ─────────────────────────────────────────────
// The same pick link turns into the delivery gallery once the photographer
// delivers: projects.final_folders (a snapshot taken by POST .../deliver,
// never from a guest request) together with delivered_at. The most final
// folders one delivery may name. Change it here only.
const DELIVER_MAX_FOLDERS = 20;

// The finals folders a delivery body names: pickFolders' rules, plus the
// bounds a photo key has (length, no control characters). null when any is
// not a folder a delivery may name.
function finalFolders(value) {
  const out = pickFolders(value);
  if (!out) return null;
  if (out.some(f => charCount(f) > PICK_PHOTO_KEY_MAX || PICK_KEY_CONTROL.test(f))) return null;
  return out;
}

// The finals a project is delivered with, or null when it is not delivered.
// Delivered needs both the stamp and a readable snapshot: a stamp from before
// this feature (no snapshot) or a snapshot that no longer parses is not a
// delivery, and the link keeps the picking scope. A snapshot without the
// stamp is normal (undeliver and reopen keep the last choice) and is not a
// delivery either: this check on delivered_at is the one thing between it
// and a link.
// Re-validated on every read, so a snapshot edited by hand in the console
// cannot name `_` objects or `/`.
function pickFinals(project) {
  if (!project || !project.delivered_at || typeof project.final_folders !== 'string') return null;
  let raw;
  try { raw = JSON.parse(project.final_folders); } catch { return null; }
  return finalFolders(raw);
}

// What a pick link may read, as two folder sets. `preview`: listings and
// thumbnails. `full`: the originals (full resolution, downloads). Proofs are
// the link's own snapshot; they are previews while picking and originals only
// when the photographer turned allow_proof_download on. Once delivered, the
// finals are both, and the proofs are gone unless the switch is on (then they
// come back for download). Nothing else, ever. A pick row with no project
// (only ever made by hand) gets its proofs as previews and nothing in full.
function pickReadScope(share) {
  const project = share.project;
  const proofs = Array.isArray(share.folders) ? share.folders : [];
  const proofOriginals = !!project && project.allow_proof_download === 1;
  const finals = pickFinals(project);
  if (finals) {
    const both = proofOriginals ? [...finals, ...proofs] : finals;
    return { mode: 'delivered', finals, proofs: proofOriginals ? proofs : [], proofOriginals, preview: both, full: both };
  }
  return { mode: 'picking', finals: [], proofs, proofOriginals, preview: proofs, full: proofOriginals ? proofs : [] };
}

// Content-Disposition for a download: an ASCII fallback with anything that is
// not printable ASCII, a quote or a backslash replaced, and the real name as
// RFC 5987 UTF-8 (encodeURIComponent leaves ' ( ) * raw, which attr-char does
// not allow).
function attachmentDisposition(key) {
  const name = key.split('/').pop() || 'photo';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// A statement that names a column a hand-run migration adds, retried without
// it when the database has not had that migration yet, so a deploy that lands
// first does not take down what already worked.
async function withoutMissingColumn(primary, fallback) {
  try { return await primary(); } catch (e) {
    if (!isMissingColumn(e)) throw e;
    return fallback();
  }
}

// The admin view of the two delivery columns: the snapshot parsed (null when
// there is none) and the switch as a boolean. The snapshot is the last chosen
// finals and may be there while not delivered (after undeliver or reopen):
// whether the project is delivered is delivered_at, never this.
function deliveryFields(row) {
  let finals = null;
  if (typeof row.final_folders === 'string') {
    try { finals = JSON.parse(row.final_folders); } catch {}
  }
  return { final_folders: Array.isArray(finals) ? finals : null, allow_proof_download: row.allow_proof_download === 1 };
}

// ─── Client confirmation and revision requests (docs/delivery.md) ───────────
// After delivery the seat holder either confirms it (確認完成) or asks for
// changes (要求修改, revision_requests). The photographer may also confirm by
// hand. Nothing confirms on its own. Every deliver (a repeat one too),
// undeliver and reopen clears the confirmation; every deliver and every
// confirmation resolves the open requests in the same batch, so a confirmed
// project never has an open request. Change the limits here only.
const REVISION_MESSAGE_MAX = 1000;
const REVISION_OPEN_MAX = 10;
const REVISION_TOTAL_MAX = 50;
const CONFIRM_UNAVAILABLE = { error: '確認完成功能尚未啟用', code: 'confirm_unavailable' };
// where the photographer's notification email links to (admin.html opens a
// project from #project=<id>)
const STUDIO_ADMIN_URL = 'https://imhoti.tw/studio/admin.html';
// the characters a pin note refuses, every one of them
const PICK_CONTROL_ALL = new RegExp(PICK_KEY_CONTROL.source, 'g');
// the bidirectional marks / overrides / isolates that could make a name
// reorder how a line reads
const BIDI_ALL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// A guest string on one line of an email (the subject, a file name, a pin
// note): control characters and bidi marks become spaces.
const oneLine = v => String(v ?? '').replace(PICK_CONTROL_ALL, ' ').replace(BIDI_ALL, ' ');

// A column or a table a hand-run migration adds is not there yet.
function isMissingSchema(e) {
  return isMissingColumn(e) || /no such table/i.test(String(e?.message || ''));
}
async function withoutMissingSchema(primary, fallback) {
  try { return await primary(); } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return fallback();
  }
}

// A revision request's text: the guest's own words, a paragraph, so line
// breaks stay (CRLF / CR become LF, a tab a space) and every other control or
// line-separator character a pin note refuses (PICK_KEY_CONTROL) is dropped.
// Trimmed; null unless 1–REVISION_MESSAGE_MAX characters are left.
function revisionMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(PICK_CONTROL_ALL, c => (c === '\n' ? c : '')).trim();
  if (!text || overChars(text, REVISION_MESSAGE_MAX)) return null;
  return text;
}

// Resolves a project's open requests, but only once it is confirmed: rides in
// the same batch as a confirmation (guest or photographer). `ownerId` is the
// project's photographer, re-checked inside the statement.
function resolveRevisionsIfConfirmed(env, projectId, at, ownerId) {
  return env.DB.prepare(
    'UPDATE revision_requests SET resolved_at = ? WHERE project_id = ? AND resolved_at IS NULL ' +
    'AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ? AND client_confirmed_at IS NOT NULL)'
  ).bind(at, projectId, projectId, ownerId);
}

// ─── Project activity log (docs/delivery.md, "Activity log") ────────────────
// project_events: one row per action that overwrites project columns
// (deliver, a repeat deliver 改交, undeliver, reopen, start-retouch, confirm),
// so the 進度 history survives the overwrite. Append-only: this INSERT is the
// one statement that touches the table (a worker test scans for it). Called
// AFTER the action's own write and only when that write changed something.
// Best-effort: any failure — the table not there before its migration, a
// locked database — is swallowed, so the log never fails or changes an
// action. The cost: a crash between the write and this insert loses that one
// event. `data`: folders and phases only, never a name, token or key.
const PROJECT_EVENTS_MAX = 200;
async function logProjectEvent(env, projectId, kind, actor, at, data = null) {
  try {
    await env.DB.prepare('INSERT INTO project_events (project_id, at, kind, actor, data) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, at, kind, actor, data == null ? null : JSON.stringify(data)).run();
  } catch (e) {
    if (!isMissingSchema(e)) console.error('project event not logged:', kind, e?.message || e);
  }
}

// A project row's final_folders as an array (a parse that fails is null).
function parsedFinals(row) {
  if (typeof row?.final_folders !== 'string') return null;
  try {
    const v = JSON.parse(row.final_folders);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

// The latest open request of a project ({message, message_auto}) or null —
// also before the migrations (message_auto then reads as absent: the guest's).
async function openRevision(env, projectId) {
  const latest = cols => env.DB.prepare(
    `SELECT message${cols} FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(projectId).first();
  try {
    return await withoutMissingColumn(() => latest(', message_auto'), () => latest(''));
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return null;
  }
}

// The admin's view: the newest REVISION_TOTAL_MAX requests with the asker's
// name when known, and how many are open. Empty before the migration.
// Each row also says what kind of request it is (docs/revision-pins.md §4.6):
// 'pins' (a round sent from pins on the finals: `marks` the frozen pins
// parsed, `finals` the folders it was sent on, `photo_count`) or 'text' (the
// old free text; marks / finals null). `message_auto`: the message is the
// Worker's fixed text, not the guest's. Before the revision-pins migration
// every row is 'text'.
async function revisionRequestsFor(env, projectId) {
  try {
    const listed = cols => env.DB.prepare(
      `SELECT r.id, r.message, r.created_at, r.resolved_at, r.picker_id, pk.name AS picker_name${cols} FROM revision_requests r ` +
      'LEFT JOIN pickers pk ON pk.id = r.picker_id AND pk.project_id = r.project_id ' +
      'WHERE r.project_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?'
    ).bind(projectId, REVISION_TOTAL_MAX).all();
    const { results } = await withoutMissingColumn(() => listed(', r.marks, r.finals, r.message_auto'), () => listed(''));
    const counted = await env.DB.prepare('SELECT COUNT(*) AS open FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL')
      .bind(projectId).first();
    const rows = results.map(r => {
      const marks = parseMarksSnapshot(r.marks);
      let finals = null;
      if (typeof r.finals === 'string') { try { finals = JSON.parse(r.finals); } catch {} }
      return {
        ...r, kind: r.marks == null ? 'text' : 'pins', marks, finals: Array.isArray(finals) ? finals : null,
        message_auto: r.message_auto === 1, photo_count: marks ? Object.keys(marks).length : 0,
      };
    });
    return { rows, open: counted?.open ?? 0 };
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return { rows: [], open: 0 };
  }
}

// 409 for a guest confirm / revision request on a project that is not
// delivered now.
function pickNotDelivered() {
  return jsonOk({ error: '尚未交件', code: 'not_delivered' }, 409);
}

// PHOTOGRAPHER_EMAIL is the default photographer's inbox (Tim's). Every
// notification about a project asks this first: another photographer's
// project mails nobody — silently, no warning — until per-studio
// notify_email (docs/multi-photographer.md, batch 4), so none of their
// guests' names, files, notes or orders reach Tim. The pick submit then stays
// in that photographer's unnotified badge, as when mail is not set up.
function mailsDefaultInbox(project) {
  return Boolean(project) && project.photographer_id === DEFAULT_PHOTOGRAPHER_ID;
}

// Tells the photographer the guest confirmed (message null) or asked for
// changes (message: their text). Same transport and rules as
// sendPickNotification: a skip when mail is not set up, the subject on one
// line, the guest's words never in a header and escaped in the HTML part.
async function sendClientNotification(env, project, pickerName, message) {
  if (!mailsDefaultInbox(project)) return false;
  if (!env.NOTIFY_EMAIL || !env.PHOTOGRAPHER_EMAIL) {
    console.warn('client notification skipped: NOTIFY_EMAIL or PHOTOGRAPHER_EMAIL is not configured');
    return false;
  }
  // (oneLine: control characters and bidi marks out of the subject line)
  const title = oneLine(project.title || '未命名專案');
  const name = oneLine(pickerName || '客人');
  const link = `${STUDIO_ADMIN_URL}#project=${encodeURIComponent(project.id)}`;
  const asked = message != null;
  const lead = asked ? '客人看過交件的精修照片，要求修改：' : '客人已確認交件的精修照片。';
  const subject = oneLine(`[${asked ? '要求修改' : '客人確認完成'}] ${title} — ${name}`);
  const fields = [['專案', title], ['客人', name]];
  const text = fields.map(([k, v]) => `${k}：${v}`).join('\n') + `\n\n${lead}` +
    (asked ? `\n\n${message}` : '') + `\n\n打開專案：${link}`;
  const html = '<table>' +
    fields.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p>${escapeHtml(lead)}</p>` +
    (asked ? `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>` : '') +
    `<p><a href="${escapeHtml(link)}">打開專案</a></p>`;
  await env.NOTIFY_EMAIL.send({
    to: env.PHOTOGRAPHER_EMAIL,
    from: env.NOTIFY_FROM || env.PHOTOGRAPHER_EMAIL,
    subject, html, text,
  });
  return true;
}

// ─── Revision pins on the finals (docs/revision-pins.md) ─────────────────────
// After delivery the seat holder pins the current finals (drafts, one
// revision_pins row per photo, bound to the delivery they were made on) and
// sends them as one round: a revision_requests row whose marks / finals /
// message / message_auto are written once by the submit INSERT and never
// updated (only resolved_at ever is). At most one request is open at a time.
// The history routes read the rounds back; the thumbnail route is the one
// guest read outside pickFinals. Change the limits here only.
const REVISION_PHOTOS_MAX = 100;
const REVISION_PINS_ITEMS_MAX = 20;
const REVISION_PINS_BODY_MAX = 128 * 1024;
// a submit's body: `expect` names up to REVISION_PHOTOS_MAX keys of up to
// PICK_PHOTO_KEY_MAX characters (4 bytes each at worst) plus a 1000-character
// note: ~110 KB, so PICK_SUBMIT_BODY_MAX (16 KB) is far too small
const REVISION_ROUND_BODY_MAX = 128 * 1024;
// what message holds when the guest wrote no overall note: the column is NOT
// NULL with a 1–1000 CHECK, which an append-only migration cannot relax
const REVISION_PINS_MESSAGE = '請見照片上的標示';
const REVISION_EMAIL_PHOTOS_MAX = 20;
// the only thumbnail widths the history serves; never an original
const REVISION_THUMB_WIDTHS = ['400', '1200'];
// the types a history thumbnail is sent as; anything else goes as image/jpeg
const REVISION_THUMB_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const REVISION_ROUND_ID = /^[0-9a-f-]{36}$/;
const REVISION_PINS_UNAVAILABLE = { error: '照片標示修改功能尚未啟用', code: 'revision_pins_unavailable' };
const PIN_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

// Whether the revision-pins migration has fully run: the table and all three
// columns. Every new route asks before it reads or writes either, so a
// half-run paste answers 500 revision_pins_unavailable rather than half
// working (and the thumbnail route never falls back to anything).
async function revisionPinsReady(env) {
  try {
    await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM revision_pins WHERE 0) AS drafts, ' +
      '(SELECT COUNT(marks) + COUNT(finals) + COUNT(message_auto) FROM revision_requests WHERE 0) AS rounds'
    ).first();
    return true;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return false;
  }
}

// Two strings in code point order: the order SQLite's BINARY collation puts
// UTF-8 text in (plain `<` compares UTF-16 units, which differs past U+FFFF).
function byCodePoint(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return (x.done ? 0 : 1) - (y.done ? 0 : 1);
    const d = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (d) return d;
  }
}

// The photos of one round in the one order its indexes (`i`) count in:
// a pins round's snapshot keys, or the selection's photo keys, deduplicated
// and in code point order. The list, one round and the thumbnail route all
// go through this, so an index means the same photo everywhere.
function roundPhotoKeys(keys) {
  return [...new Set(keys.filter(k => typeof k === 'string'))].sort(byCodePoint);
}

// One round of a project, read for the history: {id, kind, created_at, open,
// note, pins: {key: [pins]}, keys (roundPhotoKeys), folders (where its keys
// may be)} or null. `id` is 'selection' (the project's LATEST submission
// only) or a revision_requests id — always looked up with the link's own
// project, never with anything from the request.
async function loadRound(env, share, project, id) {
  if (id === 'selection') {
    const latest = cols => env.DB.prepare(
      `SELECT photo_keys, created_at${cols} FROM submissions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`
    ).bind(project.id).first();
    const row = await withoutMissingColumn(() => latest(', marks'), () => latest(''));
    if (!row) return null;
    let own = null;
    try { own = JSON.parse(project.folders); } catch {}
    // the proofs: the project's folders and the link's own snapshot, each
    // re-validated (a `_` or `/` folder names nothing)
    const folders = [...(pickFolders(own) || []), ...(pickFolders(share.folders) || [])];
    return {
      id: 'selection', kind: 'selection', created_at: row.created_at, open: false, note: null,
      pins: parseMarksSnapshot(row.marks) || {}, keys: roundPhotoKeys(parsePhotoKeys(row.photo_keys)), folders,
    };
  }
  if (!REVISION_ROUND_ID.test(id)) return null;
  const row = await env.DB.prepare(
    'SELECT id, message, message_auto, marks, finals, created_at, resolved_at FROM revision_requests WHERE id = ? AND project_id = ?'
  ).bind(id, project.id).first();
  if (!row) return null;
  const open = row.resolved_at == null;
  if (row.marks == null) {
    return { id: row.id, kind: 'text', created_at: row.created_at, open, note: row.message, pins: {}, keys: [], folders: [] };
  }
  const pins = parseMarksSnapshot(row.marks) || {};
  let finals = null;
  try { finals = finalFolders(JSON.parse(row.finals)); } catch {}
  return {
    id: row.id, kind: 'pins', created_at: row.created_at, open, note: row.message_auto === 1 ? null : row.message,
    pins, keys: roundPhotoKeys(Object.keys(pins)), folders: finals || [],
  };
}

// Tells the photographer the guest sent a round of pins. Same transport and
// rules as sendClientNotification: the subject on one line, every file name
// and pin note through oneLine (no control or bidi characters) in the text
// part and escaped in the HTML part; the guest's own note in the body only.
// `note` null = the guest wrote none (the fixed text is never mailed as
// theirs); `pins` {photo_key: [pins]}. At most REVISION_EMAIL_PHOTOS_MAX
// photos are listed.
async function sendRevisionRoundNotification(env, project, pickerName, note, pins) {
  if (!mailsDefaultInbox(project)) return false;
  if (!env.NOTIFY_EMAIL || !env.PHOTOGRAPHER_EMAIL) {
    console.warn('revision notification skipped: NOTIFY_EMAIL or PHOTOGRAPHER_EMAIL is not configured');
    return false;
  }
  const keys = roundPhotoKeys(Object.keys(pins));
  const title = oneLine(project.title || '未命名專案');
  const name = oneLine(pickerName || '客人');
  const link = `${STUDIO_ADMIN_URL}#project=${encodeURIComponent(project.id)}`;
  const subject = oneLine(`[要求修改] ${title} — ${name}（${keys.length} 張）`);
  const lead = `客人在交件的精修照片上標示了要修改的地方（${keys.length} 張）：`;
  const said = note == null ? null : String(note).replace(BIDI_ALL, ' ');
  const lines = keys.slice(0, REVISION_EMAIL_PHOTOS_MAX).map(k =>
    `${oneLine(k.split('/').pop())}：${pins[k].map((m, i) => PIN_NUMBERS[i] + oneLine(m.note)).join(' ')}`);
  const more = keys.length - lines.length;
  const moreText = more > 0 ? `…另 ${more} 張，請到後台查看` : '';
  const fields = [['專案', title], ['客人', name]];
  const text = fields.map(([k, v]) => `${k}：${v}`).join('\n') + `\n\n${lead}` +
    (said ? `\n\n${said}` : '') + `\n\n${lines.join('\n')}` + (moreText ? `\n${moreText}` : '') + `\n\n打開專案：${link}`;
  const html = '<table>' +
    fields.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p>${escapeHtml(lead)}</p>` +
    (said ? `<p style="white-space:pre-wrap">${escapeHtml(said)}</p>` : '') +
    `<ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` +
    (moreText ? `<p>${escapeHtml(moreText)}</p>` : '') +
    `<p><a href="${escapeHtml(link)}">打開專案</a></p>`;
  await env.NOTIFY_EMAIL.send({
    to: env.PHOTOGRAPHER_EMAIL,
    from: env.NOTIFY_FROM || env.PHOTOGRAPHER_EMAIL,
    subject, html, text,
  });
  return true;
}

// ─── Guest ordering (docs/guest-shop.md, S2) ────────────────────────────────
// On the completion page (delivered AND confirmed by the client) the seat
// holder orders from the guest shop: the order lands as source 'guest',
// status 'requested', and the photographer confirms it with one tap (the
// existing admin status route). Pickup only, no shipping (Tim, 2026-10-08).
// Every price is the catalogue's, recomputed here; the body names options,
// quantities, a final photo (prints) or a spread count (albums). Dark-launched:
// GUEST_ORDERS (wrangler.toml) is "off" until the privacy notice is reviewed.
// Change the limits here only.
const GUEST_ORDER_LINES_MAX = 20;
const GUEST_PRINT_QTY_MAX = 10;
const GUEST_ALBUM_QTY_MAX = 3;
// requested at once, and guest orders in all (cancelled included), per project
const GUEST_OPEN_ORDERS_MAX = 3;
const GUEST_ORDERS_MAX = 20;
const GUEST_ORDER_BODY_MAX = 32 * 1024;
const GUEST_OPTION_ID_MAX = 200;
// the privacy notice the order form shows; a new text bumps it, and a page
// still showing the old one is refused (consent_required)
const ORDER_CONSENT_VERSION = 'v1';
const GUEST_DELIVERY_METHODS = ['pickup'];
const CONTACT_NAME_MAX = 50;
const CONTACT_LINE_MAX = 50;
// a phone: CONTACT_PHONE_MIN–CONTACT_PHONE_MAX characters of digits, + - ( ) and spaces,
// at least CONTACT_PHONE_MIN of them digits (`------` reaches nobody)
const CONTACT_PHONE_MIN = 6;
const CONTACT_PHONE_MAX = 20;
const CONTACT_PHONE = new RegExp(`^[0-9+\\-() ]{${CONTACT_PHONE_MIN},${CONTACT_PHONE_MAX}}$`);
const CONTACT_PHONE_DIGITS = new RegExp(`^(?:[^0-9]*[0-9]){${CONTACT_PHONE_MIN}}`);
const TRANSFER_INFO_MAX = 500;
// a paragraph a guest or the photographer types: line feeds and tabs stay,
// every other control, line-separator, bidi, BOM or lone-surrogate character
// is refused (paragraphText turns a tab into a space first unless told not to)
const PARAGRAPH_UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDERS_UNAVAILABLE = { error: '線上訂購功能尚未啟用', code: 'orders_unavailable' };
// studio_settings.pick_link_message (admin.html 「複製連結」): a paragraph
// whose tabs stay (people indent a list of steps)
const PICK_LINK_MESSAGE_MAX = 1000;
const PICK_LINK_MESSAGE_UNAVAILABLE = { error: '選片連結訊息預設尚未啟用', code: 'pick_link_message_unavailable' };
// the same template for the later stages (已送出 / 已交件 / 已完成), one
// column each from 2026-10-16-link-messages.sql; same rules (pickLinkMessageValue)
const LINK_MESSAGE_FIELDS = ['link_message_submitted', 'link_message_delivered', 'link_message_done'];
const LINK_MESSAGES_UNAVAILABLE = { error: '各階段連結訊息預設尚未啟用', code: 'link_messages_unavailable' };
const ORDERS_REQUESTED_URL = 'https://imhoti.tw/studio/orders.html?status=requested';
const GUEST_ORDER_EMAIL_LINES_MAX = 20;
// what /api/pick/shop tells the page when ordering is open
const GUEST_ORDERING_INFO = {
  consent_version: ORDER_CONSENT_VERSION, delivery_methods: GUEST_DELIVERY_METHODS,
  max_lines: GUEST_ORDER_LINES_MAX, print_qty_max: GUEST_PRINT_QTY_MAX, album_qty_max: GUEST_ALBUM_QTY_MAX,
};
const GUEST_ORDER_ERRORS = {
  invalid_body: '訂單資料不正確', invalid_request_id: '訂單資料不正確，請重新整理', invalid_lines: '訂單品項不正確',
  too_many_lines: `一張訂單最多 ${GUEST_ORDER_LINES_MAX} 項`, invalid_qty: '數量不正確', invalid_photo_key: '照片名稱不正確',
  duplicate_line: '同一張照片同一規格只能一項，請改數量', invalid_spreads: '相本頁數不正確', invalid_contact: '請填姓名，以及電話或 LINE ID',
  invalid_delivery: '目前只提供面交取件', consent_required: '請先閱讀並勾選個資告知', invalid_note: `備註最多 ${ORDER_NOTE_MAX} 字`,
  product_not_offered: '這個商品目前無法訂購', not_in_finals: '只能訂購這次交件的精修照片', photo_not_found: '找不到這張照片',
  album_not_orderable: '這本相本請直接聯絡攝影師訂購', pages_below_min: '相本頁數少於最少頁數', pages_above_max: '相本頁數超過最多頁數',
  invalid_layout: '相本頁數不正確', extra_pages_unpriced: '這本相本無法加頁，請選最少頁數或聯絡攝影師',
};

// Whether guest ordering is open for this project (the projects row): never
// for a project that is not the default photographer's, whatever the switch
// says (docs/multi-photographer.md §4: no per-studio switch until payments
// are decided); otherwise GUEST_ORDERS exactly "on", or exactly "pilot" with
// the project listed in GUEST_ORDERS_PILOT (comma separated ids). Unset or
// anything else is off, so a typo fails closed. The one place either
// variable is read.
function guestOrdersEnabled(env, project) {
  if (!project || project.photographer_id !== DEFAULT_PHOTOGRAPHER_ID) return false;
  const projectId = project.id;
  const mode = env.GUEST_ORDERS;
  if (mode === 'on') return true;
  if (mode !== 'pilot') return false;
  const listed = String(env.GUEST_ORDERS_PILOT ?? '').split(',').map(v => v.trim()).filter(Boolean);
  return typeof projectId === 'string' && listed.includes(projectId);
}

// Whether the S2 migration has fully run (every column; the unique index is a
// backstop the routes do not rely on). The guest routes and erase ask before
// they read or write, so a half-run paste answers 500 orders_unavailable.
async function guestOrdersReady(env) {
  try {
    await env.DB.prepare(
      `SELECT (SELECT ${ORDER_GUEST_COLUMNS.concat('request_id').map(c => `COUNT(${c})`).join(' + ')} FROM orders WHERE 0) AS o, ` +
      `(SELECT ${ORDER_ITEM_LATE_COLUMNS.map(c => `COUNT(${c})`).join(' + ')} FROM order_items WHERE 0) AS i, ` +
      '(SELECT COUNT(transfer_info) FROM studio_settings WHERE 0) AS s'
    ).first();
    return true;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return false;
  }
}

// The transfer details a guest sees on a confirmed order. The one place they
// are read for a guest (docs/guest-shop.md, 「S2 — Tim 的決定」 Q12: who
// receives the money is undecided — the photographer's own account today, the
// platform's or a per-photographer account later: change it here only).
// Today: the project photographer's studio_settings.transfer_info; null when
// unset, or before the migration.
async function readTransferInfo(env, project) {
  const owner = project?.photographer_id;
  if (typeof owner !== 'string' || !owner) return null;
  try {
    const row = await env.DB.prepare('SELECT transfer_info FROM studio_settings WHERE photographer_id = ?').bind(owner).first();
    return typeof row?.transfer_info === 'string' && row.transfer_info ? row.transfer_info : null;
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
}

// A paragraph as stored: CRLF / CR become LF, a tab a space (kept with
// keepTabs), trimmed; null (absent) or '' reads as ''. undefined when it is
// not a string, is over `max` characters or holds a character
// PARAGRAPH_UNSAFE refuses.
function paragraphText(value, max, keepTabs = false) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return undefined;
  const lf = value.replace(/\r\n?/g, '\n');
  const t = (keepTabs ? lf : lf.replace(/\t/g, ' ')).trim();
  if (overChars(t, max) || PARAGRAPH_UNSAFE.test(t)) return undefined;
  return t;
}
// studio_settings.transfer_info from a settings PUT: the stored value (null
// clears) or undefined when refused
function transferInfoValue(value) {
  const t = paragraphText(value, TRANSFER_INFO_MAX);
  return t === undefined ? undefined : t || null;
}

// studio_settings.pick_link_message from a settings PUT: like
// transferInfoValue, but tabs stay. Placeholders ({連結}) are plain text.
function pickLinkMessageValue(value) {
  const t = paragraphText(value, PICK_LINK_MESSAGE_MAX, true);
  return t === undefined ? undefined : t || null;
}

// The guest's contact (docs/guest-shop.md §4.3, Q6-A): a name (1–50
// characters) and a phone (CONTACT_PHONE) and/or a LINE ID (1–50), each
// trimmed, none with a character PROJECT_TYPE_UNSAFE refuses. An empty or
// missing phone / LINE ID is none (stored NULL). {name, phone, line} or null.
function guestContact(v) {
  if (!isPlainObject(v)) return null;
  const field = (x, max, required) => {
    if (x === undefined || x === null) return required ? undefined : null;
    if (typeof x !== 'string') return undefined;
    const t = x.trim();
    if (!t) return required ? undefined : null;
    return overChars(t, max) || PROJECT_TYPE_UNSAFE.test(t) ? undefined : t;
  };
  const name = field(v.name, CONTACT_NAME_MAX, true);
  const phone = field(v.phone, CONTACT_PHONE_MAX, false);
  const line = field(v.line, CONTACT_LINE_MAX, false);
  if (name === undefined || phone === undefined || line === undefined) return null;
  if (phone !== null && !(CONTACT_PHONE.test(phone) && CONTACT_PHONE_DIGITS.test(phone))) return null;
  if (phone === null && line === null) return null;
  return { name, phone, line };
}

// A POST /api/pick/orders body, checked without the database, in the order the
// codes are documented: {order: {requestId, lines: [{option_id, qty,
// photo_key?, spreads?}], contact, note, expected}} or {bad: code, max?}.
// Nothing money-related is read: the lines keep only these four fields.
function guestOrderBody(body) {
  if (!isPlainObject(body)) return { bad: 'invalid_body' };
  if (typeof body.request_id !== 'string' || !REQUEST_ID.test(body.request_id)) return { bad: 'invalid_request_id' };
  if (!Array.isArray(body.lines) || !body.lines.length) return { bad: 'invalid_lines' };
  if (body.lines.length > GUEST_ORDER_LINES_MAX) return { bad: 'too_many_lines', max: GUEST_ORDER_LINES_MAX };
  const seen = new Set();
  const lines = [];
  for (const l of body.lines) {
    if (!isPlainObject(l) || typeof l.option_id !== 'string' || !l.option_id || l.option_id.length > GUEST_OPTION_ID_MAX) return { bad: 'invalid_lines' };
    if (!(Number.isSafeInteger(l.qty) && l.qty >= 1 && l.qty <= GUEST_PRINT_QTY_MAX)) return { bad: 'invalid_qty' };
    if (l.photo_key !== undefined && (typeof l.photo_key !== 'string' || !l.photo_key || !pickKeyValid(l.photo_key))) return { bad: 'invalid_photo_key' };
    const same = `${l.option_id}\n${l.photo_key ?? ''}`;
    if (seen.has(same)) return { bad: 'duplicate_line' };
    seen.add(same);
    if (l.spreads !== undefined && !(Number.isSafeInteger(l.spreads) && l.spreads >= 1 && l.spreads <= PAGE_BOUND_MAX)) return { bad: 'invalid_spreads' };
    lines.push({ option_id: l.option_id, qty: l.qty, photo_key: l.photo_key, spreads: l.spreads });
  }
  const contact = guestContact(body.contact);
  if (!contact) return { bad: 'invalid_contact' };
  const delivery = body.delivery;
  if (delivery !== undefined && !(isPlainObject(delivery) && GUEST_DELIVERY_METHODS.includes(delivery.method))) return { bad: 'invalid_delivery' };
  if (body.consent !== ORDER_CONSENT_VERSION) return { bad: 'consent_required' };
  const note = paragraphText(body.note, ORDER_NOTE_MAX);
  if (note === undefined) return { bad: 'invalid_note' };
  if (!(Number.isSafeInteger(body.expected_total) && body.expected_total >= 0)) return { bad: 'invalid_body' };
  return { order: { requestId: body.request_id.toLowerCase(), lines, contact, note, expected: body.expected_total } };
}

// A guest order's lines against the shop and the finals, priced by the
// Worker: {lines} (order_items rows, list_price and layout included) or
// {fail: [status, code]}. In order: the option is in this project's
// photographer's guest shop right now (readGuestShop: visible, active, its
// platform product and option active, at or above the platform price) — 404
// product_not_offered; the line fits its kind (a print names one final, an
// album a spread count and 1–3 copies); a print's photo is in the finals of the
// delivery up now — 403 not_in_finals — and in R2 — 404 photo_not_found; an
// album's spreads fit its platform product (an album with no min_pages is not
// orderable; extra spreads cost extra_page_price each, and above min_pages
// with no such price it is refused). The snapshot (name, label, price, cost,
// platform option) is orderLines', in its guest scope.
async function guestOrderLines(env, project, finals, wanted) {
  const owner = project.photographer_id;
  const shop = typeof owner === 'string' && owner ? await readGuestShop(env, owner) : [];
  if (!shop) return { fail: [500, 'shop_unavailable'] };
  const offered = new Map();
  for (const p of shop) for (const o of p.options) offered.set(o.id, p);
  if (wanted.some(l => !offered.has(l.option_id))) return { fail: [404, 'product_not_offered'] };
  for (const l of wanted) {
    const p = offered.get(l.option_id);
    if (p.kind === 'print') {
      if (l.spreads !== undefined) return { fail: [400, 'invalid_lines'] };
      if (l.photo_key === undefined) return { fail: [400, 'invalid_photo_key'] };
    } else {
      if (l.photo_key !== undefined) return { fail: [400, 'invalid_lines'] };
      if (l.spreads === undefined) return { fail: [400, 'invalid_spreads'] };
      if (l.qty > GUEST_ALBUM_QTY_MAX) return { fail: [400, 'invalid_qty'] };
    }
  }
  const prints = wanted.filter(l => l.photo_key !== undefined);
  if (prints.some(l => !pickKeyAllowed({ folders: finals }, l.photo_key))) return { fail: [403, 'not_in_finals'] };
  const photos = bucketFor(env, owner);
  const found = await Promise.all(prints.map(l => photos.head(l.photo_key)));
  if (found.some(o => !o)) return { fail: [404, 'photo_not_found'] };
  const extras = [];
  for (const l of wanted) {
    const p = offered.get(l.option_id);
    if (p.kind !== 'album') { extras.push(0); continue; }
    if (p.min_pages == null) return { fail: [400, 'album_not_orderable'] };
    const problem = albumPagesProblem(l.spreads, p);
    if (problem) return { fail: [400, problem] };
    const extra = albumExtraPagesCost(p, l.spreads);
    if (!extra && l.spreads > p.min_pages) return { fail: [400, 'extra_pages_unpriced'] };
    extras.push(extra ? extra.cost : 0);
  }
  const checked = await orderLines(env, project,
    wanted.map(l => ({ option_id: l.option_id, qty: l.qty, photo_keys: l.photo_key === undefined ? [] : [l.photo_key] })),
    null, { guest: true, photographerId: owner });
  // the shop said yes a moment ago: a refusal now is the catalogue changing
  // under the request (or a finals key orderLines would not take)
  if (checked.bad) return { fail: checked.bad === 'photo_not_in_project' ? [403, 'not_in_finals'] : [404, 'product_not_offered'] };
  const lines = checked.lines.map((row, i) => {
    const l = wanted[i];
    if (row.kind !== 'album') return { ...row, layout: null };
    return {
      ...row, unit_price: row.unit_price + extras[i],
      layout: JSON.stringify({ v: 1, mode: 'photographer', source: 'all_finals', spreads: l.spreads }),
    };
  });
  if (lines.some(l => !isMoney(l.unit_price))) return { fail: [400, 'extra_pages_unpriced'] };
  return { lines };
}

// An order line as an INSERT that only lands while `gate` (SQL, with its
// binds) holds. `late`: with list_price and layout (the S2 migration); the
// admin routes retry without them on a database that has not had it.
function orderItemInsert(env, orderId, l, gate, gateBinds, late = true) {
  const cols = ['id', 'order_id', 'kind', 'product_id', 'option_id', 'name', 'option_label', 'unit_price', 'unit_cost', 'qty', 'photo_keys',
    'platform_option_id', 'vendor_cost', ...(late ? ORDER_ITEM_LATE_COLUMNS : [])];
  const values = [l.id, orderId, l.kind, l.product_id, l.option_id, l.name, l.option_label, l.unit_price, l.unit_cost, l.qty, l.photo_keys,
    l.platform_option_id, l.vendor_cost, ...(late ? [l.list_price ?? null, l.layout ?? null] : [])];
  return env.DB.prepare(`INSERT INTO order_items (${cols.join(', ')}) SELECT ${values.map(() => '?').join(', ')} WHERE ${gate}`)
    .bind(...values, ...gateBinds);
}

// The seat holder's guest orders in a project, newest first (at most
// GUEST_ORDERS_MAX, the per-project cap), or the one with `orderId`, in the
// guest view — the only shape a guest route returns, built from named
// columns: never the photographer's note, a cost, the platform option, the
// list price, the request id, the picker, the consent version or the layout
// as stored; a print's photo by its file name only (never its folder: a guest
// route never returns final_folders). The transfer details only on a
// confirmed or fulfilled order (Tim, answer 1).
async function guestOrdersFor(env, project, pickerId, orderId = null) {
  const { results: orders } = await env.DB.prepare(
    `SELECT o.id, o.status, o.created_at, o.confirmed_at, o.cancelled_at, o.discount, o.paid_amount, o.guest_note, o.delivery_method,
            o.contact_name, o.contact_phone, o.contact_line, ${ORDER_SUBTOTAL_SQL} AS subtotal, ${ORDER_TOTAL_SQL} AS total
       FROM orders o WHERE o.project_id = ?1 AND o.picker_id = ?2 AND o.source = 'guest'${orderId === null ? '' : ' AND o.id = ?4'}
      ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?3`
  ).bind(project.id, pickerId, GUEST_ORDERS_MAX, ...(orderId === null ? [] : [orderId])).all();
  if (!orders.length) return [];
  const { results: items } = await env.DB.prepare(
    'SELECT i.order_id, i.kind, i.name, i.option_label, i.qty, i.unit_price, i.photo_keys, i.layout FROM order_items i ' +
    'WHERE i.order_id IN (SELECT value FROM json_each(?)) ORDER BY i.rowid'
  ).bind(JSON.stringify(orders.map(o => o.id))).all();
  const payable = o => o.status === 'confirmed' || o.status === 'fulfilled';
  const transfer = orders.some(payable) ? await readTransferInfo(env, project) : null;
  return orders.map(o => ({
    id: o.id, status: o.status, created_at: o.created_at, confirmed_at: o.confirmed_at, cancelled_at: o.cancelled_at,
    items: items.filter(i => i.order_id === o.id).map(i => {
      const key = parsePhotoKeys(i.photo_keys)[0];
      const spreads = parseLayout(i.layout)?.spreads;
      return {
        kind: i.kind, name: i.name, option_label: i.option_label, qty: i.qty, unit_price: i.unit_price,
        photo_name: i.kind === 'print' && typeof key === 'string' ? key.split('/').pop() : null,
        spreads: i.kind === 'album' && Number.isSafeInteger(spreads) ? spreads : null,
      };
    }),
    subtotal: o.subtotal, discount: o.discount, total: o.total, paid: o.paid_amount >= o.total,
    delivery_method: o.delivery_method, guest_note: o.guest_note,
    contact: o.contact_name == null ? null : { name: o.contact_name, phone: o.contact_phone, line: o.contact_line },
    transfer_info: payable(o) ? transfer : null,
  }));
}

// Tells the photographer about a guest order (`cancelled`: the guest cancelled
// it). Same transport and rules as the other notifications: skipped when
// mail is not set up, the subject on one line, every guest string through
// oneLine in it, everything escaped in the HTML part, the guest's note in the
// body only. `order` is the guest view: never the phone or the LINE ID (no
// personal contact data in the inbox, docs/guest-shop.md §5.6).
async function sendOrderNotification(env, project, order, cancelled = false) {
  if (!mailsDefaultInbox(project)) return false;
  if (!env.NOTIFY_EMAIL || !env.PHOTOGRAPHER_EMAIL) {
    console.warn('order notification skipped: NOTIFY_EMAIL or PHOTOGRAPHER_EMAIL is not configured');
    return false;
  }
  const title = oneLine(project.title || '未命名專案');
  const name = oneLine(order.contact?.name || '客人');
  const subject = oneLine(`[${cancelled ? '客人取消訂單' : '新訂單'}] ${title} — ${name}：NT$${order.total}`);
  const lead = cancelled ? '客人取消了一筆待確認的訂單：' : '客人在完成頁下了一筆訂單，請到訂單頁確認：';
  const lines = order.items.slice(0, GUEST_ORDER_EMAIL_LINES_MAX).map(i =>
    `${oneLine(i.name)}${i.option_label ? `（${oneLine(i.option_label)}）` : ''} × ${i.qty}　NT$${i.unit_price}` +
    (i.spreads != null ? `　${i.spreads} 跨頁` : '') + (i.photo_name ? `　${oneLine(i.photo_name)}` : ''));
  const fields = [['專案', title], ['客人', name], ['取貨', '面交'], ['總額', `NT$${order.total}`]];
  const note = order.guest_note ? String(order.guest_note).replace(BIDI_ALL, ' ') : '';
  const text = fields.map(([k, v]) => `${k}：${v}`).join('\n') + `\n\n${lead}\n${lines.join('\n')}` +
    (note ? `\n\n客人備註：\n${note}` : '') + `\n\n打開訂單：${ORDERS_REQUESTED_URL}`;
  const html = '<table>' +
    fields.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p>${escapeHtml(lead)}</p><ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` +
    (note ? `<p>客人備註：</p><p style="white-space:pre-wrap">${escapeHtml(note)}</p>` : '') +
    `<p><a href="${escapeHtml(ORDERS_REQUESTED_URL)}">打開訂單</a></p>`;
  await env.NOTIFY_EMAIL.send({
    to: env.PHOTOGRAPHER_EMAIL,
    from: env.NOTIFY_FROM || env.PHOTOGRAPHER_EMAIL,
    subject, html, text,
  });
  return true;
}

// ─── 「我有興趣」 (docs/guest-shop.md, product interest) ──────────────────────
// On the completion page (delivered AND confirmed by the client) the seat
// holder taps 「我有興趣」 on a shop product. A demand signal, not an order: one
// row per project and product (product_interests), the photographer emailed
// on the first tap and again at most once per INTEREST_EMAIL_INTERVAL_MS.
// Change the limits here only.
const INTEREST_TABLE = 'product_interests';
const INTEREST_PRODUCTS_MAX = 20;
const INTEREST_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INTEREST_BODY_MAX = 1024;
const INTEREST_PRODUCT_ID_MAX = 200;
const INTEREST_UNAVAILABLE = { error: '有興趣功能尚未啟用', code: 'interest_unavailable' };
const INTEREST_KIND_LABELS = { album: '相本', print: '輸出' };

// Whether the product-interests migration has run.
async function interestReady(env) {
  try {
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${INTEREST_TABLE} WHERE 0`).first();
    return true;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return false;
  }
}

// The project's interests for the admin detail, newest tap first; [] before
// the migration. Named fields only (never last_emailed_at).
async function interestsFor(env, projectId) {
  return withoutMissingSchema(async () => (await env.DB.prepare(
    `SELECT product_id, product_name, product_kind, first_at, last_at, tap_count FROM ${INTEREST_TABLE} ` +
    `WHERE project_id = ? ORDER BY last_at DESC, first_at DESC, product_id LIMIT ${INTEREST_PRODUCTS_MAX * 2}`
  ).bind(projectId).all()).results, () => []);
}

// Tells the photographer the client is interested in a product. Same
// transport and rules as the other notifications: the subject on one line,
// every value through oneLine (no control or bidi characters) and escaped in
// the HTML part. The only guest text is the picker's name; the product name
// is our own catalogue's, snapshotted at this tap.
async function sendInterestNotification(env, project, pickerName, product, tapCount) {
  if (!mailsDefaultInbox(project)) return false;
  if (!env.NOTIFY_EMAIL || !env.PHOTOGRAPHER_EMAIL) {
    console.warn('interest notification skipped: NOTIFY_EMAIL or PHOTOGRAPHER_EMAIL is not configured');
    return false;
  }
  const title = oneLine(project.title || '未命名專案');
  const name = oneLine(pickerName || '客人');
  const productName = oneLine(product.name || '商品');
  const kind = INTEREST_KIND_LABELS[product.kind] || '商品';
  const link = `${STUDIO_ADMIN_URL}#project=${encodeURIComponent(project.id)}`;
  const subject = oneLine(`[有興趣] ${title} — ${name}：${productName}`);
  const lead = tapCount > 1
    ? `客人在完成頁又點了「我有興趣」（共 ${tapCount} 次）。這不是訂單，可以主動聯絡客人。`
    : '客人在完成頁點了「我有興趣」。這不是訂單，可以主動聯絡客人。';
  const fields = [['專案', title], ['客人', name], ['商品', `${productName}（${kind}）`]];
  const text = fields.map(([k, v]) => `${k}：${v}`).join('\n') + `\n\n${lead}\n\n打開專案：${link}`;
  const html = '<table>' +
    fields.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table><p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(link)}">打開專案</a></p>`;
  await env.NOTIFY_EMAIL.send({
    to: env.PHOTOGRAPHER_EMAIL,
    from: env.NOTIFY_FROM || env.PHOTOGRAPHER_EMAIL,
    subject, html, text,
  });
  return true;
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
  // co-picking (docs/co-picking.md): any other key may be a collaborator's.
  // Read on every request, so a removal, an expiry or a seat reset holds
  // from the very next one. No table yet (the migration has not run): nobody
  // is a collaborator.
  let membership = null;
  if (picker && !isOwner) {
    try {
      membership = await env.DB.prepare('SELECT * FROM project_collaborators WHERE picker_id = ? AND project_id = ?')
        .bind(picker.id, project.id).first();
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
    }
  }
  const memberStatus = collaboratorStatus(membership, project.owner_picker_id, new Date().toISOString());
  const isCollaborator = memberStatus === 'active';
  const role = isOwner ? 'owner' : isCollaborator ? 'collaborator' : 'viewer';
  return { project, picker, isOwner, isCollaborator, canEdit: isOwner || isCollaborator, role, membership, memberStatus };
}

// ─── Co-picking (docs/co-picking.md) ────────────────────────────────────────
// The seat holder invites up to PICK_MAX_COLLABORATORS people with one-use
// 8-digit codes. A collaborator is a pickers row plus a project_collaborators
// row, valid only while invited_by is still the project's owner, not revoked
// and not expired. Change the limits here only.
const PICK_MAX_COLLABORATORS = 2;
const PICK_INVITE_MS = 60 * 60 * 1000;
const PICK_DAY_MS = 24 * 60 * 60 * 1000;
const PICK_JOIN_WINDOW_MS = 15 * 60 * 1000;
const PICK_JOIN_FAILURES_PROJECT = 30;
const PICK_JOIN_FAILURES_NETWORK = 5;
const CO_PICKING_UNAVAILABLE = { error: '協作者功能尚未啟用', code: 'co_picking_unavailable' };
// The invite-code HMAC key: its own wrangler secret, at least this long.
// Without it every co-picking route is unavailable (fails closed).
const PICK_INVITE_SECRET_MIN = 32;
function pickInviteSecretOk(env) {
  return typeof env.PICK_INVITE_SECRET === 'string' && env.PICK_INVITE_SECRET.length >= PICK_INVITE_SECRET_MIN;
}
// After the owner declines a renewal, the person may not ask again for this
// long. Kept without a new column: renewal_requested_at holds
// 'declined:<iso>' then, which every reader treats as no pending request.
const PICK_RENEWAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RENEWAL_DECLINED = 'declined:';
// in SQL: the column holds a pending request (not NULL, not the marker)
const RENEWAL_PENDING_SQL = `(renewal_requested_at IS NOT NULL AND renewal_requested_at NOT LIKE '${RENEWAL_DECLINED}%')`;

// renewal_requested_at as a pending request's time, or null (none, or the
// declined marker)
function renewalPending(value) {
  return typeof value === 'string' && !value.startsWith(RENEWAL_DECLINED) ? value : null;
}

// Until when a declined person may not ask again (ISO), or null.
function renewalDeclinedUntil(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.startsWith(RENEWAL_DECLINED)) return null;
  const at = Date.parse(value.slice(RENEWAL_DECLINED.length));
  if (!Number.isFinite(at)) return null;
  const until = at + PICK_RENEWAL_COOLDOWN_MS;
  return until > nowMs ? new Date(until).toISOString() : null;
}

// What a membership row is now: 'active', 'expired' (its period ran out),
// 'removed' (revoked by the owner, or invited by someone who no longer holds
// the seat), or null for no row. `nowIso` is an ISO timestamp, compared as a
// string the way the statements compare it.
function collaboratorStatus(row, ownerId, nowIso) {
  if (!row) return null;
  if (row.revoked_at || !ownerId || row.invited_by !== ownerId) return 'removed';
  if (row.expires_at != null && !(row.expires_at > nowIso)) return 'expired';
  return 'active';
}

// "Picker `who` is an active collaborator of the project row `p`", for use
// inside a statement: the same rule as collaboratorStatus. `now` is a bound
// timestamp parameter.
function activeCollaboratorSql(who, p, now) {
  return `EXISTS (SELECT 1 FROM project_collaborators c WHERE c.picker_id = ${who} AND c.project_id = ${p}.id ` +
    `AND c.invited_by = ${p}.owner_picker_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ${now}))`;
}

// The slots in use on project row `p`: active collaborators of its current
// owner plus that owner's unspent, unexpired invites. `except`: a picker id
// parameter left out of the count (the person being renewed or re-timed).
function collaboratorSlotsSql(p, now, except = null) {
  return `((SELECT COUNT(*) FROM project_collaborators c WHERE c.project_id = ${p}.id AND c.invited_by = ${p}.owner_picker_id ` +
    `AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ${now})${except ? ` AND c.picker_id <> ${except}` : ''}) + ` +
    `(SELECT COUNT(*) FROM pick_invites i WHERE i.project_id = ${p}.id AND i.invited_by = ${p}.owner_picker_id ` +
    `AND i.used_at IS NULL AND i.expires_at > ${now}))`;
}

// Whether the co-picking migration has run (all three tables, the last
// column included).
async function coPickingReady(env) {
  try {
    await env.DB.prepare(
      'SELECT i.id, c.renewal_requested_at, f.bucket FROM pick_invites i, project_collaborators c, pick_join_failures f WHERE 0'
    ).first();
    return true;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

// A uniformly random 8-digit code, zero-padded (rejection sampling, so no
// value is likelier than another).
function pickInviteCode() {
  const buf = new Uint32Array(1);
  const limit = 4294967296 - (4294967296 % 100000000);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 100000000).padStart(8, '0');
}

// What is stored for a code: HMAC-SHA256 keyed with PICK_INVITE_SECRET over
// project_id + ':' + code, hex. A leaked table alone reveals no live code,
// and a code is bound to its project.
async function pickInviteHash(env, projectId, code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PICK_INVITE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${projectId}:${code}`));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// A body's window_days: 1, 7 or null (until the project ends); undefined for
// anything else, a missing key included.
function pickWindowDays(body) {
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'window_days')) return undefined;
  const v = body.window_days;
  return v === null || v === 1 || v === 7 ? v : undefined;
}

// A project's collaborators as the owner and the photographer see them,
// joined order. ownerOnly: only those the current owner invited (the owner's
// list); otherwise all of them (the admin's), an earlier owner's reading as
// 'removed'. null when the migration has not run.
async function collaboratorsFor(env, project, ownerOnly) {
  const nowIso = new Date().toISOString();
  let results;
  try {
    ({ results } = await env.DB.prepare(
      'SELECT c.picker_id, pk.name, c.invited_by, c.joined_at, c.expires_at, c.revoked_at, c.last_seen_at, c.renewal_requested_at ' +
      'FROM project_collaborators c LEFT JOIN pickers pk ON pk.id = c.picker_id AND pk.project_id = c.project_id ' +
      `WHERE c.project_id = ?1${ownerOnly ? ' AND c.invited_by = ?2' : ''} ORDER BY c.joined_at, c.rowid`
    ).bind(...(ownerOnly ? [project.id, project.owner_picker_id] : [project.id])).all());
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
  return results.map(r => collaboratorView(r, project.owner_picker_id, nowIso));
}

function collaboratorView(r, ownerId, nowIso) {
  return {
    picker_id: r.picker_id, name: r.name ?? null, joined_at: r.joined_at, expires_at: r.expires_at ?? null,
    revoked_at: r.revoked_at ?? null, status: collaboratorStatus(r, ownerId, nowIso), last_seen_at: r.last_seen_at ?? null,
    renewal_requested_at: renewalPending(r.renewal_requested_at),
  };
}

// Who last wrote a selection row, for the owner, collaborators and the
// photographer: a function from updated_by to {id, name, role} — role
// 'owner' (the current seat), 'collaborator' (any membership here, removed
// or expired too) or 'other' (a picker of this project who is neither, such
// as the seat holder before a reset) — or null for an id that is no picker
// of this project.
// guest: a page reader (owner or collaborator), who gets no name for 'other'
// — a previous seat holder is not theirs to know; the photographer does.
async function pickAuthors(env, project, guest = false) {
  const { results: people } = await env.DB.prepare('SELECT id, name FROM pickers WHERE project_id = ?').bind(project.id).all();
  let members = [];
  try {
    ({ results: members } = await env.DB.prepare('SELECT picker_id FROM project_collaborators WHERE project_id = ?').bind(project.id).all());
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
  const names = new Map(people.map(p => [p.id, p.name]));
  const collaborators = new Set(members.map(m => m.picker_id));
  return id => {
    if (id == null || !names.has(id)) return null;
    const role = id === project.owner_picker_id ? 'owner' : collaborators.has(id) ? 'collaborator' : 'other';
    return { id, name: guest && role === 'other' ? null : names.get(id), role };
  };
}

// 409 for a project the photographer has started retouching.
function pickRetouching() {
  return jsonOk({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
}

// 409 for a submit sending more ♥ photos than the plan allows
// (pick_limit + extra_max, docs/project-plan.md). `over`: how many to un-heart.
function pickCapRefused(count, limit, extraMax) {
  const max = limit + extraMax;
  const over = count - max;
  return jsonOk({
    error: extraMax > 0
      ? `目前選了 ${count} 張，最多可送出 ${max} 張（方案 ${limit} + 加選 ${extraMax}）。請先取消 ${over} 張再送出`
      : `目前選了 ${count} 張，此專案最多 ${max} 張，不可加選。請先取消 ${over} 張再送出`,
    code: 'pick_cap', count, max, over, limit, extra_max: extraMax,
  }, 409);
}

// A conditional write that changed nothing: the phase moved to retouching or
// the seat moved since the checks before it — or, for a save, the seat and
// phase still hold and it was the selection cap. Re-read to say which.
// `cap`: {pickerId, refused()} — when the seat and phase still hold, the
// write's own cap is what refused it, and refused() builds that 409.
// An archive that landed in between answers like the dead link it now is.
// `cap.collaborator`: the caller saved as a collaborator, so a membership
// still active now (not the seat) is what makes it the cap.
async function pickRefused(env, projectId, notOwner, cap = null) {
  const now = await env.DB.prepare('SELECT phase, owner_picker_id, archived_at FROM projects WHERE id = ?').bind(projectId).first();
  if (now?.archived_at) return jsonErr('Unauthorized', 401);
  if (now && !PICK_OPEN_PHASES.includes(now.phase)) return pickRetouching();
  if (now && cap && now.owner_picker_id === cap.pickerId) return cap.refused();
  if (now && cap?.collaborator) {
    const row = await env.DB.prepare('SELECT * FROM project_collaborators WHERE picker_id = ? AND project_id = ?').bind(cap.pickerId, projectId).first();
    if (collaboratorStatus(row, now.owner_picker_id, new Date().toISOString()) === 'active') return cap.refused();
  }
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

// Over the plan's limit is a warning the guest reads, never a block (only
// over pick_limit + extra_max does the submit refuse: pickCapRefused).
function pickOverText(count, limit, price) {
  if (limit == null || count <= limit) return '';
  const over = count - limit;
  return `方案 ${limit} 張精修，您已選 ${count} 張，多 ${over} 張` +
    (price != null ? `，每張 NT$${price} 加挑費` : '');
}

// A save's `marks` in the one form the Worker stores: an array of at most
// PICK_MARKS_MAX {x, y, note}, x and y finite numbers in [0, 1] rounded to 4
// decimals, note a string (missing = '') trimmed to at most
// PICK_MARK_NOTE_MAX characters with no control or line-separator character.
// Any other field is dropped. null when the value is not that.
function pickMarks(value) {
  if (!Array.isArray(value) || value.length > PICK_MARKS_MAX) return null;
  const out = [];
  for (const m of value) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const { x, y } = m;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) return null;
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) return null;
    const raw = m.note === undefined ? '' : m.note;
    if (typeof raw !== 'string') return null;
    const note = raw.trim();
    if (overChars(note, PICK_MARK_NOTE_MAX) || PICK_KEY_CONTROL.test(note)) return null;
    out.push({ x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, note });
  }
  return out;
}

function pickMarksInvalid() {
  return jsonOk({ error: '標示格式不正確', code: 'invalid_marks' }, 400);
}

// A selections.marks column back as an array, re-checked (a value edited by
// hand in the console reads as none); null when there are none.
function parseMarks(json) {
  if (typeof json !== 'string') return null;
  let v;
  try { v = JSON.parse(json); } catch { return null; }
  const marks = pickMarks(v);
  return marks && marks.length ? marks : null;
}

// A submissions.marks snapshot back as {photo_key: [pins]}; null when there
// is none or it will not parse as that.
function parseMarksSnapshot(json) {
  if (typeof json !== 'string') return null;
  let v;
  try { v = JSON.parse(json); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, pins] of Object.entries(v)) {
    const marks = pickMarks(pins);
    if (!marks) return null;
    if (marks.length) out[k] = marks;
  }
  return Object.keys(out).length ? out : null;
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
  if (!mailsDefaultInbox(project)) return false;
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
    const unauthorized = request.method === 'OPTIONS' ? null : photographerOnlyPath(new URL(request.url).pathname);
    if (unauthorized) {
      const found = await photographerIdentity(request, env);
      if (found.error) throw found.error;
      if (found.refusal) return found.refusal.clone();
      if (!found.who) return unauthorized();
    }
    const response = await routeRequest(request, env, ctx);
    if (unauthorized && !GUARDED.has(request)) return unauthorized();
    return response;
  },
};

async function routeRequest(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const pathParts = url.pathname.split('/').filter(Boolean);

    // resolved at most once per request, and only on the routes that need it
    let sharePromise;
    const share = () => (sharePromise ??= resolveShareToken(request, url, env));

    // ─── Photographer accounts: /api/photographer/* (batches 1, 2a) ───────
    // register / login / logout / change-password (POST), me (GET). API only,
    // no page links here yet. Anything else under /api/photographer is
    // 404/405 here, so nothing falls through to the upload route.
    if (pathParts[0] === 'api' && pathParts[1] === 'photographer') {
      const route = pathParts.length === 3 ? pathParts[2] : null;
      const method = Object.assign(Object.create(null), { register: 'POST', 'register-invite': 'POST', login: 'POST', logout: 'POST', 'change-password': 'POST', me: 'GET' })[route];
      if (!method) return jsonErr('Not found', 404);
      if (request.method !== method) return jsonErr('Method not allowed', 405);
      const reply = (data, status = 200) => jsonOk(data, status, PHOTOGRAPHER_NO_STORE);

      // GET /api/photographer/me — who this session is, and whether it must
      // change its password first (null before that migration). 401
      // otherwise, before the migration too: no session can exist then.
      if (route === 'me') {
        const session = await resolvePhotographer(request, env);
        if (session.refused) return session.refused;
        const { id, display_name, email, must_change_password } = session.who;
        return reply({ photographer: { id, display_name, email }, must_change_password });
      }

      // closed before anything is read: a typo in the switch, or no secret
      if (route === 'register' && (env.PHOTOGRAPHER_SIGNUP !== 'on' || !env.TURNSTILE_SECRET)) {
        return reply({ error: '目前未開放註冊', code: 'registration_closed' }, 403);
      }
      // registering with an invite code gives an account that opens every
      // photographer route at once, so it is closed while they are
      // (PHOTOGRAPHER_ROUTES, before anything is read), then needs the secret
      if (route === 'register-invite') {
        if (!photographerRoutesOpen(env)) return reply({ error: '目前未開放註冊', code: 'registration_closed' }, 403);
        if (!photographerInviteSecretOk(env)) return reply(INVITES_UNAVAILABLE, 500);
      }
      if (!env.DB) return jsonErr('DB not configured', 500);

      try {
        // POST /api/photographer/logout — deletes this session; 200 whether
        // or not it was live
        if (route === 'logout') {
          const token = bearerToken(request);
          if (token) {
            await env.DB.prepare('DELETE FROM photographer_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
          }
          return reply({ ok: true });
        }

        // change-password: the session first, so a request without one is 401
        // before its body is read at all (no 413 / 400 to tell it anything)
        let who = null;
        if (route === 'change-password') {
          const session = await resolvePhotographer(request, env);
          if (session.refused) return session.refused;
          who = session.who;
          if (who.must_change_password === null) return reply(PASSWORD_CHANGE_UNAVAILABLE, 500);
        }
        // before the invite migration: nothing read, nothing written
        if (route === 'register-invite' && !await photographerInvitesReady(env)) return reply(INVITES_UNAVAILABLE, 500);

        const parsed = await readJsonCapped(request, PHOTOGRAPHER_BODY_MAX);
        if (parsed.refused) return parsed.refused;
        const body = parsed.body && typeof parsed.body === 'object' ? parsed.body : {};

        // POST /api/photographer/login — {email, password}. Unknown email,
        // wrong password, pending and suspended are one identical 401, and
        // every attempt runs one full PBKDF2 (the dummy when no row).
        if (route === 'login') {
          const email = photographerEmail(body.email);
          const password = typeof body.password === 'string' && body.password.length <= 2 * PHOTOGRAPHER_PASSWORD_MAX ? body.password : '';
          // the throttle (reservePasswordAttempt). A refused attempt says so
          // (429) whoever owns the email: the attacker caused it.
          const now = Date.now();
          const nowIso = new Date(now).toISOString();
          const attempt = await reservePasswordAttempt(request, env, typeof body.email === 'string' ? body.email : '');
          if (!attempt) return reply(TOO_MANY_ATTEMPTS, 429);
          // must_change_password: null before its migration
          const accountSql = flag => `SELECT id, display_name, password_hash, status, ${flag} AS must_change_password FROM photographers WHERE email = ?`;
          const row = email
            ? await withoutMissingColumn(
              () => env.DB.prepare(accountSql('must_change_password')).bind(email).first(),
              () => env.DB.prepare(accountSql('NULL')).bind(email).first(),
            )
            : null;
          const verified = await verifyPhotographerPassword(password, row ? row.password_hash : PHOTOGRAPHER_DUMMY_HASH);
          if (!row || !verified || row.status !== 'active') return reply(LOGIN_FAILED, 401);
          const token = randomHex(32);
          const tokenHash = await sha256Hex(token);
          // the session is written only while the account is still active
          // AND still has the hash just verified, so a suspend or a
          // reset-password racing this login leaves nothing usable
          const [inserted] = await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO photographer_sessions (token_hash, photographer_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM photographers WHERE id = ? AND status = 'active' AND password_hash = ?)"
            ).bind(tokenHash, row.id, nowIso, new Date(now + PHOTOGRAPHER_SESSION_MS).toISOString(), row.id, row.password_hash),
            // a success is not a failure: its reserved rows go (only if the session landed)
            env.DB.prepare('DELETE FROM photographer_login_failures WHERE attempt = ? AND EXISTS (SELECT 1 FROM photographer_sessions WHERE token_hash = ?)').bind(attempt, tokenHash),
            env.DB.prepare("UPDATE photographers SET last_login_at = ? WHERE id = ? AND status = 'active'").bind(nowIso, row.id),
            env.DB.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ? AND expires_at <= ?').bind(row.id, nowIso),
          ]);
          if (!inserted.meta.changes) return reply(LOGIN_FAILED, 401);
          return reply({ token, photographer: { id: row.id, display_name: row.display_name }, must_change_password: mustChangeFlag(row.must_change_password) });
        }

        // POST /api/photographer/change-password — {current_password,
        // new_password}, from a live session (a flagged one too: this is how
        // it clears the flag). Input 400 (no PBKDF2), the login throttle 429
        // (shared keys), a wrong current password 403 wrong_password (counted
        // as a failure). Then the new hash, the flag cleared and every
        // session of this photographer (this one too) replaced by one new
        // session, whose token is the answer {ok, token} — a token stolen
        // before the change dies with it. One batch that lands only while
        // this session is live, the account active and its hash still the
        // one just verified — a reset, a suspend, a logout or another change
        // in between is 409 password_change_conflict, nothing written.
        if (route === 'change-password') {
          const current = body.current_password;
          const next = body.new_password;
          if (typeof current !== 'string' || !current || current.length > 2 * PHOTOGRAPHER_PASSWORD_MAX) {
            return reply({ error: '請輸入目前的密碼', code: 'invalid_current_password' }, 400);
          }
          if (!photographerPasswordOk(next)) return reply(INVALID_PHOTOGRAPHER_PASSWORD, 400);
          if (next === current) return reply({ error: '新密碼不能和目前的密碼相同', code: 'same_password' }, 400);
          const attempt = await reservePasswordAttempt(request, env, who.email);
          if (!attempt) return reply(TOO_MANY_ATTEMPTS, 429);
          const row = await env.DB.prepare("SELECT password_hash FROM photographers WHERE id = ? AND status = 'active'").bind(who.id).first();
          // both PBKDF2 runs whatever the answer, so right and wrong take as long
          const [verified, newHash] = await Promise.all([
            verifyPhotographerPassword(current, row ? row.password_hash : PHOTOGRAPHER_DUMMY_HASH),
            hashPhotographerPassword(next),
          ]);
          if (!row || !verified) return reply({ error: '目前的密碼不正確', code: 'wrong_password' }, 403);
          const tokenHash = await sha256Hex(bearerToken(request));
          const now = Date.now();
          const nowIso = new Date(now).toISOString();
          const newToken = randomHex(32);
          const [updated] = await env.DB.batch([
            env.DB.prepare(
              "UPDATE photographers SET password_hash = ?, must_change_password = 0 WHERE id = ? AND status = 'active' AND password_hash = ? AND EXISTS (SELECT 1 FROM photographer_sessions WHERE token_hash = ? AND photographer_id = ? AND expires_at > ?)"
            ).bind(newHash, who.id, row.password_hash, tokenHash, who.id, nowIso),
            // only if the new hash landed (its salt is fresh, so it is this
            // write's): every session of this photographer, this one included…
            env.DB.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ? AND EXISTS (SELECT 1 FROM photographers WHERE id = ? AND password_hash = ?)')
              .bind(who.id, who.id, newHash),
            // …and the one new session, on the same condition
            env.DB.prepare(
              "INSERT INTO photographer_sessions (token_hash, photographer_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM photographers WHERE id = ? AND status = 'active' AND password_hash = ?)"
            ).bind(await sha256Hex(newToken), who.id, nowIso, new Date(now + PHOTOGRAPHER_SESSION_MS).toISOString(), who.id, newHash),
            // the current password was right: not a failure
            env.DB.prepare('DELETE FROM photographer_login_failures WHERE attempt = ?').bind(attempt),
          ]);
          if (!updated.meta.changes) return reply({ error: '密碼或登入狀態已改變，請重新登入再試', code: 'password_change_conflict' }, 409);
          return reply({ ok: true, token: newToken });
        }

        // POST /api/photographer/register-invite — {email, password,
        // display_name, studio_note?, invite_code} → 201 {token, photographer,
        // must_change_password} (login's answer). Fields (400, as /register),
        // the guess throttle (429, before the code is looked at), then the
        // code, which is looked up by its HMAC over this email and the code,
        // so a code made for another email is simply not found. Every refusal
        // after the throttle — a wrong, used, expired, revoked or malformed
        // code, another email than the invited one, or an email that already
        // has an account — is the one 400 invalid_invite. One batch: the code is spent (live,
        // and only if the email is free), and only its spender's account
        // (active, approved now), session and release of its throttle rows
        // land after it; so of two racing registrations exactly one makes an
        // account, and a taken email never burns the code.
        if (route === 'register-invite') {
          const fields = photographerSignupFields(body);
          if (fields.refused) return reply(fields.refused, 400);
          const attempt = await reserveInviteAttempt(request, env, fields.email);
          if (!attempt) return reply(TOO_MANY_ATTEMPTS, 429);
          // the password hash (one PBKDF2, the slow step) before anything
          // about the code is known: every attempt past the throttle pays it,
          // so a refusal takes as long as a success and the time says
          // nothing about which check refused it
          const passwordHash = await hashPhotographerPassword(fields.password);
          const invalid = () => reply(INVALID_INVITE, 400);
          const code = body.invite_code;
          if (typeof code !== 'string' || !/^\d{8}$/.test(code)) return invalid();
          const found = await env.DB.prepare(
            'SELECT id FROM photographer_invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, rowid LIMIT 1'
          ).bind(await photographerInviteHash(env, fields.email, code), new Date().toISOString()).first();
          if (!found) return invalid();
          const id = randomHex(8);
          const token = randomHex(32);
          const now = Date.now();
          const nowIso = new Date(now).toISOString();
          const spentBy = 'EXISTS (SELECT 1 FROM photographer_invites WHERE id = ? AND used_by = ?)';
          const [spent] = await env.DB.batch([
            env.DB.prepare(
              'UPDATE photographer_invites SET used_at = ?1, used_by = ?2 WHERE id = ?3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1 ' +
              'AND NOT EXISTS (SELECT 1 FROM photographers WHERE email = ?4)'
            ).bind(nowIso, id, found.id, fields.email),
            // must_change_password is not named: its default 0 where the
            // column exists, and the insert runs before that migration too
            env.DB.prepare(
              `INSERT INTO photographers (id, email, password_hash, display_name, studio_note, status, created_at, approved_at) SELECT ?, ?, ?, ?, ?, 'active', ?, ? WHERE ${spentBy}`
            ).bind(id, fields.email, passwordHash, fields.name, fields.note, nowIso, nowIso, found.id, id),
            env.DB.prepare(
              `INSERT INTO photographer_sessions (token_hash, photographer_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE ${spentBy}`
            ).bind(await sha256Hex(token), id, nowIso, new Date(now + PHOTOGRAPHER_SESSION_MS).toISOString(), found.id, id),
            env.DB.prepare(`DELETE FROM photographer_login_failures WHERE attempt = ? AND ${spentBy}`).bind(attempt, found.id, id),
          ]);
          // spent by someone faster, revoked or expired in between, or the email taken
          if (!spent.meta.changes) return invalid();
          // must_change_password as login says it: null before its migration
          const flag = await withoutMissingColumn(
            () => env.DB.prepare('SELECT must_change_password FROM photographers WHERE id = ?').bind(id).first(),
            () => ({ must_change_password: null }),
          );
          return reply({ token, photographer: { id, display_name: fields.name }, must_change_password: mustChangeFlag(flag?.must_change_password) }, 201);
        }

        // POST /api/photographer/register — {email, password, display_name,
        // studio_note?, turnstileToken}. Fields (400), too many pending
        // (429 registration_busy), Turnstile (403), the per-network hour
        // (429 rate_limited), then one pending row — or, when the email is
        // taken, only that row's dup_attempts / last_dup_at bumped (the
        // operator sees a squatting signal), with the identical answer.
        const fields = photographerSignupFields(body);
        if (fields.refused) return reply(fields.refused, 400);
        const { email, password, name, note } = fields;
        // a flood of sign-ups waits for the operator to catch up (before
        // Turnstile, which costs a call)
        const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM photographers WHERE status = 'pending'").first();
        if (pending.n >= PHOTOGRAPHER_PENDING_MAX) return reply({ error: '目前申請人數較多，請稍後再試', code: 'registration_busy' }, 429);
        if (!(await turnstileVerified(body.turnstileToken, request, env))) {
          return reply({ error: '驗證失敗，請重新整理再試一次', code: 'turnstile_failed' }, 403);
        }
        // one conditional insert: under parallel requests the count and the
        // write are one statement, so the cap holds
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const ipHash = await sha256Hex(`photographer-signup:${env.TURNSTILE_SECRET || ''}:${clientNetwork(request)}`);
        const counted = await env.DB.prepare(
          'INSERT INTO photographer_signups (ip_hash, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM photographer_signups WHERE ip_hash = ? AND created_at > ?) < ?'
        ).bind(ipHash, nowIso, ipHash, new Date(now - 60 * 60 * 1000).toISOString(), PHOTOGRAPHER_SIGNUPS_PER_HOUR).run();
        if (!counted.meta.changes) return reply({ error: '申請太頻繁，請稍後再試', code: 'rate_limited' }, 429);
        const passwordHash = await hashPhotographerPassword(password);
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO photographers (id, email, password_hash, display_name, studio_note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(email) DO UPDATE SET dup_attempts = dup_attempts + 1, last_dup_at = excluded.created_at"
          ).bind(randomHex(8), email, passwordHash, name, note, nowIso),
          env.DB.prepare('DELETE FROM photographer_signups WHERE created_at < ?').bind(new Date(now - 24 * 60 * 60 * 1000).toISOString()),
        ]);
        return reply({ ok: true, message: '已收到，等待審核' }, 202);
      } catch (e) {
        if (isMissingSchema(e)) return reply(PHOTOGRAPHERS_UNAVAILABLE, 500);
        throw e;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AUTH ROUTES
    // ═══════════════════════════════════════════════════════════════════════

    // GET /api/auth/verify-admin — check if PHOTOGRAPHER_TOKEN matches
    if (request.method === 'GET' && url.pathname === '/api/auth/verify-admin') {
      const auth = await requirePhotographer(request, env, { unauthorized: () => jsonErr('Token 不正確', 401) }); // open to every photographer: answers no data
      if (auth.refused) return auth.refused;
      return jsonOk({ ok: true });
    }

    // POST /api/auth/studio-token — a read-only credential the photographer's
    // own pages can put in an <img> src
    if (request.method === 'POST' && url.pathname === '/api/auth/studio-token') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      // the token reads its owner's files only (batch 3), so its row names
      // the owner: share_tokens.photographer_id, NULL for the default
      // photographer. Before that column's migration the default goes on
      // exactly as before (every studio row is its own) and anyone else is
      // refused, nothing written.
      const owner = shareOwnerColumn(auth.who.id);
      const mine = shareOwnedBy('photographer_id', auth.who.id);
      const now = Date.now();
      const reuseAfter = new Date(now + STUDIO_REUSE_MIN_MS).toISOString();
      // both sides are ISO-8601 UTC so this compares as text; a hand-edited
      // row in any other format simply is not reused
      let live;
      let owned = true;
      try {
        live = await env.DB.prepare(
          `SELECT token, expires_at FROM share_tokens WHERE kind = 'studio' AND ${mine.sql} AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`
        ).bind(...mine.args, reuseAfter).first();
      } catch (e) {
        if (!isMissingColumn(e)) throw e;
        if (owner !== null) return jsonOk(SHARE_OWNER_UNAVAILABLE, 500);
        owned = false;
        live = await env.DB.prepare(
          "SELECT token, expires_at FROM share_tokens WHERE kind = 'studio' AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
        ).bind(reuseAfter).first();
      }
      const token = live ? live.token : newShareToken();
      const expiresAt = live ? live.expires_at : new Date(now + STUDIO_TTL_MS).toISOString();
      if (!live) {
        // book_id is empty because the token belongs to no album, which keeps
        // it out of every book route and out of the per-book revoke list.
        // folders is empty so the kind check is not the only thing between
        // this row and the bucket.
        // A photographer session's row is written only while that session
        // still exists, unexpired, for an active account (review of
        // r2-hardening): a suspend / reset / reject landing after the check
        // above has already revoked the account's studio tokens, and a row
        // written after it would outlive them. Not written → the same 401 as
        // an expired session, and nothing else is written. The default
        // (PHOTOGRAPHER_TOKEN) has no session row.
        const createdAt = new Date(now).toISOString();
        const inserted = await (!owned
          ? env.DB.prepare(
            "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES (?, '', 'studio', '[]', ?, ?)"
          ).bind(token, createdAt, expiresAt)
          : owner === null
            ? env.DB.prepare(
              "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) VALUES (?, '', 'studio', '[]', ?, ?, ?)"
            ).bind(token, createdAt, expiresAt, owner)
            : env.DB.prepare(
              "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) SELECT ?, '', 'studio', '[]', ?, ?, ? WHERE EXISTS (SELECT 1 FROM photographer_sessions s JOIN photographers p ON p.id = s.photographer_id WHERE s.token_hash = ? AND s.photographer_id = ? AND s.expires_at > ? AND p.status = 'active')"
            ).bind(token, createdAt, expiresAt, owner, await sha256Hex(bearerToken(request)), owner, createdAt)).run();
        if (!inserted.meta?.changes) return UNAUTHORIZED();
      }
      // One live studio row at a time PER PHOTOGRAPHER, whether we just
      // issued it or handed back the one that was already there; another
      // photographer's rows are never touched. Reuse is what keeps the picker
      // and the editor open side by side on the same token, so it is the
      // handed-back row that is spared here — superseding it instead would
      // have the two pages revoke each other's token in turn. What reuse
      // therefore cannot give is "a fresh login retires a leaked token": the
      // leaked one IS the live one. POST /api/shares/minted/revoke-all is the
      // control for that, and it does not wait on a page load.
      await (owned
        ? env.DB.prepare(
          `UPDATE share_tokens SET revoked_at = ? WHERE kind = 'studio' AND ${mine.sql} AND revoked_at IS NULL AND token != ?`
        ).bind(new Date(now).toISOString(), ...mine.args, token)
        : env.DB.prepare(
          "UPDATE share_tokens SET revoked_at = ? WHERE kind = 'studio' AND revoked_at IS NULL AND token != ?"
        ).bind(new Date(now).toISOString(), token)).run();
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
      if (env.LEGACY_CLIENT_ACCOUNTS !== 'on') return jsonErr('client_accounts_closed', 410);
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
      if (env.LEGACY_CLIENT_ACCOUNTS !== 'on') return jsonErr('client_accounts_closed', 410);
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
      const auth = await requireDefault(request, env); // default-only until retired
      if (auth.refused) return auth.refused;
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
      const auth = await requireDefault(request, env); // default-only until retired
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const userId = parseInt(pathParts[3]);
      if (!userId) return jsonErr('Invalid user id');
      await env.DB.prepare('UPDATE users SET approved = 1 WHERE id = ?').bind(userId).run();
      return jsonOk({ success: true });
    }

    // PUT /api/admin/clients/:id/permissions
    if (request.method === 'PUT' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'clients' && pathParts[4] === 'permissions') {
      const auth = await requireDefault(request, env); // default-only until retired
      if (auth.refused) return auth.refused;
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
      const auth = await requireDefault(request, env); // default-only until retired
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const userId = parseInt(pathParts[3]);
      if (!userId) return jsonErr('Invalid user id');
      await env.DB.prepare('DELETE FROM share_tokens WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM permissions WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return jsonOk({ success: true });
    }

    // DELETE /api/admin/photo?key=<logical key> — one of the caller's own
    // photos, its thumbnails first and the original last (deletePhoto).
    // GET /api/admin/photo/lock?key= — whether that delete would go ahead
    // now (photoLockReport), so a page can leave the button out. The key
    // comes from the query only. Anything else under /api/admin/photo is
    // 404, another method 405.
    if (pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'photo') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const lock = pathParts.length === 4 && pathParts[3] === 'lock';
      if (pathParts.length !== 3 && !lock) return jsonErr('Not found', 404);
      if (request.method !== (lock ? 'GET' : 'DELETE')) return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      return (lock ? photoLockReport : deletePhoto)(env, auth.who.id, params.get('key'));
    }

    // POST /api/admin/projects — a guest-picking project and its one link.
    // The caller's own (who.id). Its folders are logical keys: the link reads
    // them through the project's photographer's prefix (bucketFor), so naming
    // a folder of someone else's opens nothing of theirs.
    if (request.method === 'POST' && url.pathname === '/api/admin/projects') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON'); }
      const { title = '', folders, pick_limit = null, extra_price = null } = body || {};
      if (typeof title !== 'string') return jsonErr('title must be a string');
      const snapshot = pickFolders(folders);
      if (!snapshot) return jsonErr('folders must be a non-empty array of photo folders');
      for (const [name, v] of [['pick_limit', pick_limit], ['extra_price', extra_price]]) {
        // extra_price ends up as an order line's unit_price (the extra-pick
        // order), so it is held to the same bound as any other price
        const max = name === 'extra_price' ? MONEY_MAX : Number.MAX_SAFE_INTEGER;
        if (v !== null && !(Number.isSafeInteger(v) && v >= 0 && v <= max)) return jsonErr(`${name} must be a whole number from 0`);
      }
      // extra_max: the body's (null = no plan cap), else the studio default,
      // else EXTRA_MAX_DEFAULT
      let extra_max;
      if (body && hasField(body, 'extra_max')) {
        extra_max = body.extra_max;
        if (extra_max !== null && !isExtraMax(extra_max)) return jsonErr(`extra_max must be a whole number from 0 to ${EXTRA_MAX_MAX}`);
      } else {
        extra_max = await studioDefaultExtraMax(env, who.id);
      }
      // shoot_date: optional, 'YYYY-MM-DD'; '' or null = not set
      let shoot_date = null;
      if (body && hasField(body, 'shoot_date')) {
        if (!isShootDateInput(body.shoot_date)) return jsonOk({ error: 'shoot_date must be YYYY-MM-DD', code: 'invalid_shoot_date' }, 400);
        shoot_date = shootDateValue(body.shoot_date);
      }
      // project_type: optional category text; '', blank or null = not set
      let project_type = null;
      if (body && hasField(body, 'project_type')) {
        if (!isProjectTypeInput(body.project_type)) return jsonOk({ error: 'project_type must be a short plain label', code: 'invalid_project_type' }, 400);
        project_type = projectTypeValue(body.project_type);
      }
      const id = crypto.randomUUID();
      const token = newShareToken();
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + SHARE_TTL_MS).toISOString();
      const foldersJson = JSON.stringify(snapshot);
      const cleanTitle = title.trim().slice(0, 200);
      // a database without the column yet (hand-run migration) still gets
      // the project, uncapped like every project before the feature. A
      // shoot date is named only when set; set on a database without its
      // column, both tries fail and nothing is written (500, below).
      // project_type likewise: named only when set
      const shootCol = (shoot_date === null ? '' : ', shoot_date') + (project_type === null ? '' : ', project_type');
      const shootVal = [...(shoot_date === null ? [] : [shoot_date]), ...(project_type === null ? [] : [project_type])];
      let inserted;
      try {
        inserted = await withoutMissingColumn(
          () => env.DB.prepare(
            `INSERT INTO projects (id, title, folders, pick_limit, extra_price, created_at, photographer_id, extra_max${shootCol}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${shootVal.map(() => ', ?').join('')})`
          ).bind(id, cleanTitle, foldersJson, pick_limit, extra_price, createdAt, who.id, extra_max, ...shootVal).run().then(() => extra_max),
          () => env.DB.prepare(
            `INSERT INTO projects (id, title, folders, pick_limit, extra_price, created_at, photographer_id${shootCol}) VALUES (?, ?, ?, ?, ?, ?, ?${shootVal.map(() => ', ?').join('')})`
          ).bind(id, cleanTitle, foldersJson, pick_limit, extra_price, createdAt, who.id, ...shootVal).run().then(() => null),
        );
      } catch (e) {
        // the error names the column the database lacks
        if (isMissingColumn(e) && project_type !== null && /project_type/.test(String(e?.message || ''))) return jsonOk(PROJECT_TYPE_UNAVAILABLE, 500);
        if (isMissingColumn(e) && shoot_date !== null) return jsonOk(SHOOT_DATE_UNAVAILABLE, 500);
        throw e;
      }
      // book_id '' keeps it off every book route and out of the per-album
      // list; the kind keeps it off everything else that is not a pick route
      await env.DB.prepare(
        "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES (?, '', ?, 'pick', ?, ?, ?, ?)"
      ).bind(token, cleanTitle, id, foldersJson, createdAt, expiresAt).run();
      return jsonOk({
        project: { id, title: cleanTitle, folders: snapshot, pick_limit, extra_price, extra_max: inserted, shoot_date, project_type, photographer_id: who.id },
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
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = Date.now();
      const archivedFilter = params.get('archived') === '1' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL';
      // the delivery columns come from a hand-run migration: until it runs the
      // list still loads, with every project undelivered and the switch off
      const listed = (delivery, shoot) => env.DB.prepare(
        `SELECT p.id, p.title, p.phase, p.modified_after_submit, p.pick_limit, p.extra_price,
                o.name AS owner_name, p.created_at, p.archived_at, p.delivered_at,${shoot}${delivery}
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
        who.id,
      ).all();
      // extra_max (the plan's extra-pick cap) comes from a later hand-run
      // migration still: without it every project lists as uncapped (null)
      // and the client-confirm columns and table (docs/delivery.md) from a
      // later one: without them nothing is confirmed and nothing is open
      const confirmCols = ' p.client_confirmed_at, p.client_confirmed_by,' +
        ' (SELECT COUNT(*) FROM revision_requests r WHERE r.project_id = p.id AND r.resolved_at IS NULL) AS open_revision_count,';
      // and shoot_date from a later one still: the whole chain runs with it
      // first, so a database without it loses only it, never the rest
      const chain = shoot => withoutMissingSchema(
        () => listed(' p.final_folders, p.allow_proof_download, p.extra_max,' + confirmCols, shoot),
        () => withoutMissingColumn(
          () => listed(' p.final_folders, p.allow_proof_download, p.extra_max,', shoot),
          () => withoutMissingColumn(
            () => listed(' p.final_folders, p.allow_proof_download,', shoot),
            () => listed('', shoot),
          ),
        ),
      );
      // project_type from its own migration, which may land before or after
      // shoot_date's: tried with both, then each alone, then neither
      const { results } = await withoutMissingColumn(
        () => chain(' p.shoot_date, p.project_type,'),
        () => withoutMissingColumn(
          () => chain(' p.shoot_date,'),
          () => withoutMissingColumn(() => chain(' p.project_type,'), () => chain('')),
        ),
      );
      return jsonOk({
        projects: results.map(r => ({
          ...r, extra_max: r.extra_max ?? null, shoot_date: r.shoot_date ?? null, project_type: r.project_type ?? null, ...deliveryFields(r),
          client_confirmed_at: r.client_confirmed_at ?? null,
          client_confirmed_by: r.client_confirmed_by ?? null,
          open_revision_count: r.open_revision_count ?? 0,
        })),
      }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/admin/projects/:id/events — the project's activity log
    // (docs/delivery.md, "Activity log"): the newest PROJECT_EVENTS_MAX
    // events, oldest first, {id, at, kind, actor, data}. The project's
    // photographer only (another's is 404, as for no project); no guest route
    // reads the table. Before the migration: {events: []}.
    if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] &&
        pathParts[4] === 'events' && !pathParts[5]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], who.id).first();
      if (!project) return jsonErr('Not found', 404);
      let listed = [];
      try {
        ({ results: listed } = await env.DB.prepare(
          'SELECT id, at, kind, actor, data FROM project_events WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?'
        ).bind(project.id, PROJECT_EVENTS_MAX).all());
      } catch (e) {
        if (!isMissingSchema(e)) throw e;
      }
      const events = listed.reverse().map(r => {
        let data = null;
        try { data = r.data == null ? null : JSON.parse(r.data); } catch {}
        return { id: r.id, at: r.at, kind: r.kind, actor: r.actor, data };
      });
      return jsonOk({ events }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/admin/projects/:id — the seat holder, every submit record and
    // who set each pick. Guest strings go out raw in JSON; admin.html escapes
    // them when it renders.
    if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[4]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], who.id).first();
      if (!project) return jsonErr('Not found', 404);
      // key_hash is left out by name: it is the one column here that is a
      // credential's stand-in
      const { results: pickers } = await env.DB.prepare(
        'SELECT id, name, relationship, email, user_id, created_at FROM pickers WHERE project_id = ? ORDER BY created_at'
      ).bind(project.id).all();
      // newest first; rowid breaks a tie inside one millisecond, since rows
      // are only ever appended. At most PICK_MAX_SUBMISSIONS: a project the
      // cap never covered (rows from before it) still loads a bounded page
      // `marks` (retouch pins) parsed on both, null when none — and on a
      // database that has not had the retouch-pins migration yet
      const submittedRows = cols => env.DB.prepare(
        `SELECT id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at, notified${cols} FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
      ).bind(project.id, PICK_MAX_SUBMISSIONS).all();
      const { results: submitted } = await withoutMissingColumn(() => submittedRows(', marks'), () => submittedRows(''));
      const { unnotified } = await env.DB.prepare(
        `SELECT ${PICK_UNNOTIFIED_SQL} AS unnotified FROM projects p WHERE p.id = ?`
      ).bind(project.id).first();
      const submissions = submitted.map(r => ({ ...r, photo_keys: parsePhotoKeys(r.photo_keys), marks: parseMarksSnapshot(r.marks) }));
      const selectionRows = cols => env.DB.prepare(
        `SELECT photo_key, rating, note, updated_by, updated_at${cols} FROM selections WHERE project_id = ? ORDER BY photo_key`
      ).bind(project.id).all();
      const { results: selectionsRaw } = await withoutMissingColumn(() => selectionRows(', marks'), () => selectionRows(''));
      // `by`: who last wrote the row (docs/co-picking.md), owner or collaborator
      const author = await pickAuthors(env, project);
      const selections = selectionsRaw.map(r => ({ ...r, marks: parseMarks(r.marks), by: author(r.updated_by) }));
      // every collaborator the project had, an earlier owner's as 'removed';
      // [] before the co-picking migration. Admin only, never a code
      const collaborators = (await collaboratorsFor(env, project, false)) || [];
      // every pick link the project ever had, live or not, so the page can
      // offer revoke on the live ones
      const { results: tokenRows } = await env.DB.prepare(
        "SELECT token, created_at, expires_at, revoked_at, last_seen_at FROM share_tokens WHERE kind = 'pick' AND project_id = ? ORDER BY created_at DESC, rowid DESC"
      ).bind(project.id).all();
      const now = Date.now();
      const tokens = tokenRows.map(t => ({ ...t, status: pickTokenStatus(t, now) }));
      let folders = null;
      try { folders = JSON.parse(project.folders); } catch {}
      // the guest's 要求修改, newest first (docs/delivery.md); none before the
      // client-confirm migration
      const revisions = await revisionRequestsFor(env, project.id);
      // 「我有興趣」 taps, newest first (docs/guest-shop.md); [] before the
      // product-interests migration. Admin only: no guest route reads them
      const interests = await interestsFor(env, project.id);
      return jsonOk({
        project: {
          ...project, folders, extra_max: project.extra_max ?? null, shoot_date: project.shoot_date ?? null, project_type: project.project_type ?? null, ...deliveryFields(project),
          client_confirmed_at: project.client_confirmed_at ?? null,
          client_confirmed_by: project.client_confirmed_by ?? null,
          open_revision_count: revisions.open,
        },
        owner: pickers.find(p => p.id === project.owner_picker_id) || null,
        pickers, selections, collaborators, tokens, submissions, unnotified_submissions: unnotified,
        revision_requests: revisions.rows,
        interests,
      }, 200, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/reset-seat — the guest lost their browser.
    // Frees the seat; the selections belong to the project and stay.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && pathParts[4] === 'reset-seat') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const result = await env.DB.prepare('UPDATE projects SET owner_picker_id = NULL WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], who.id).run();
      if (!result.meta?.changes) return jsonErr('Not found', 404);
      return jsonOk({ ok: true });
    }

    // POST /api/admin/projects/:id/start-retouch — the photographer starts
    // work on what was submitted; from here the guest's saves and submits are
    // refused. Only from 'submitted' (a second press is a no-op): from
    // 'picking' there is nothing to retouch yet.
    // POST /api/admin/projects/:id/reopen — back to 'picking', from either
    // later phase, so the guest can change their picks again. Submissions stay,
    // and so do orders: the next start-retouch recomputes the extra-pick one.
    // A delivery comes down with it (delivered_at cleared); the finals
    // snapshot stays, as with undeliver.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[5] &&
        (pathParts[4] === 'start-retouch' || pathParts[4] === 'reopen')) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      // null: the project is there and past picking, so it was the gate below
      const notMoved = async () => {
        const exists = await env.DB.prepare('SELECT phase FROM projects WHERE id = ? AND photographer_id = ?')
          .bind(id, who.id).first();
        if (!exists) return jsonErr('Not found', 404);
        if (exists.phase === 'picking') return jsonOk({ error: '客人尚未送出，無法開始修圖', code: 'not_submitted', phase: exists.phase }, 409);
        return null;
      };
      // each is one conditional UPDATE, so it cannot interleave with a save
      // or a submit: those re-check the phase inside their own writes
      if (pathParts[4] === 'reopen') {
        // Takes a delivery down like undeliver: clears the stamp only. The
        // finals snapshot stays as the last choice (admin.html prefills the
        // next deliver with it); without the stamp pickFinals reads it as not
        // delivered, so no link can reach it. Names no column the delivery
        // migration adds, so it works before that migration too. The
        // confirmation goes with the delivery, in the same statement (retried
        // without it before the client-confirm migration).
        // The activity log (best-effort) needs what it reopens from: read
        // first, for the event's data only. Whether this request reopened
        // anything is the write's own answer: the statement gated on "not
        // already picking and undelivered" goes first, so of two racing
        // reopens one logs; the ungated one after it (only when that changed
        // nothing) keeps the old answer for a project already picking.
        let before = null;
        try {
          before = await env.DB.prepare('SELECT phase, delivered_at FROM projects WHERE id = ? AND photographer_id = ?').bind(id, who.id).first();
        } catch {}
        const reopen = (confirm, cond) => env.DB.prepare(
          `UPDATE projects SET phase = 'picking', modified_after_submit = 0, delivered_at = NULL${confirm} WHERE id = ? AND photographer_id = ?${cond}`
        ).bind(id, who.id).run();
        const run = cond => withoutMissingColumn(
          () => reopen(', client_confirmed_at = NULL, client_confirmed_by = NULL', cond), () => reopen('', cond));
        const reopened = await run(" AND (phase != 'picking' OR delivered_at IS NOT NULL)");
        const moved = reopened.meta?.changes ? reopened : await run('');
        if (!moved.meta?.changes) return jsonErr('Not found', 404);
        if (reopened.meta?.changes) {
          await logProjectEvent(env, id, 'reopen', 'photographer', new Date().toISOString(),
            { from_phase: before?.phase ?? null, was_delivered: !!before?.delivered_at });
        }
        return jsonOk({ ok: true, phase: 'picking' });
      }
      // start-retouch also brings the automatic extra-pick order in line with
      // the latest submission, in the same batch as the phase move, so either
      // both land or neither does. The fee is read before the batch, so every
      // statement is gated on that submission still being the latest: a
      // submit that lands in between makes the whole batch a no-op, and the
      // loop reads again (the phase then holds, so it cannot happen twice
      // over once retouching). The order writes are gated on the phase having
      // moved too, and re-check their own order inside (extraPickWrites).
      // The batch's first statement moves 'submitted' only: its count says
      // whether this press started the retouch (inside the transaction, so
      // of two racing presses one does), for the activity log. The second is
      // the move as it always was (a press while retouching is a no-op that
      // still rewrites the order).
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await latestSubmission(env, id, who.id);
        const gate = 'id = ? AND photographer_id = ? AND (SELECT s.id FROM submissions s WHERE s.project_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1) IS ?';
        const gateBinds = [id, who.id, id, latest?.id ?? null];
        const writes = await extraPickWrites(env, who.id, id, extraPickFee(latest), `${gate} AND phase = 'retouching'`, gateBinds);
        const [started, moved] = await env.DB.batch([
          env.DB.prepare(`UPDATE projects SET phase = 'retouching' WHERE ${gate} AND phase = 'submitted'`).bind(...gateBinds),
          env.DB.prepare(`UPDATE projects SET phase = 'retouching' WHERE ${gate} AND phase IN ('submitted', 'retouching')`).bind(...gateBinds),
          ...writes,
        ]);
        if (moved.meta?.changes) {
          if (started.meta?.changes) await logProjectEvent(env, id, 'retouch', 'photographer', new Date().toISOString());
          return jsonOk({ ok: true, phase: 'retouching' });
        }
        const refused = await notMoved();
        if (refused) return refused;
      }
      return jsonOk({ error: '客人剛剛又送出了，請再試一次', code: 'busy' }, 409);
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
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      if (pathParts[4] === 'unarchive') {
        const result = await env.DB.prepare('UPDATE projects SET archived_at = NULL WHERE id = ? AND photographer_id = ?')
          .bind(id, who.id).run();
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        return jsonOk({ ok: true, archived_at: null }, 200, ADMIN_ONLY_HEADERS);
      }
      const at = new Date().toISOString();
      const [stamped, revoked] = await env.DB.batch([
        env.DB.prepare('UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE id = ? AND photographer_id = ?')
          .bind(at, id, who.id),
        env.DB.prepare(
          "UPDATE share_tokens SET revoked_at = ? WHERE kind = 'pick' AND project_id = ? AND revoked_at IS NULL " +
          'AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ?)'
        ).bind(at, id, id, who.id),
      ]);
      if (!stamped.meta?.changes) return jsonErr('Not found', 404);
      const row = await env.DB.prepare('SELECT archived_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, who.id).first();
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
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      const hasSubmissions = () => jsonOk({ error: '已有送出紀錄，無法刪除（可改為封存）', code: 'has_submissions' }, 409);
      // an order (paid or not) is a sale record: deleting its project would
      // orphan it out of every list, the stats and what is still owed
      const hasOrders = () => jsonOk({ error: '已有訂單，無法刪除（可改為封存）', code: 'has_orders' }, 409);
      const found = await env.DB.prepare(
        'SELECT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?1) AS submitted, ' +
        'EXISTS (SELECT 1 FROM orders WHERE project_id = ?1) AS ordered FROM projects WHERE id = ?1 AND photographer_id = ?2'
      ).bind(id, who.id).first();
      if (!found) return jsonErr('Not found', 404);
      if (found.submitted) return hasSubmissions();
      if (found.ordered) return hasOrders();
      const gate = 'EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND photographer_id = ?2) AND NOT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?1) ' +
        'AND NOT EXISTS (SELECT 1 FROM orders WHERE project_id = ?1)';
      const del = sql => env.DB.prepare(`${sql} AND ${gate}`).bind(id, who.id);
      // the co-picking rows too, once that migration has run
      const coPicking = await coPickingReady(env)
        ? ['project_collaborators', 'pick_invites', 'pick_join_failures'].map(t => del(`DELETE FROM ${t} WHERE project_id = ?1`))
        : [];
      const results = await env.DB.batch([
        del('DELETE FROM selections WHERE project_id = ?1'),
        del('DELETE FROM pickers WHERE project_id = ?1'),
        del('DELETE FROM project_members WHERE project_id = ?1'),
        del("DELETE FROM share_tokens WHERE kind = 'pick' AND project_id = ?1"),
        ...coPicking,
        del('DELETE FROM projects WHERE id = ?1'),
      ]);
      if (!results[results.length - 1].meta?.changes) {
        const still = await env.DB.prepare(
          'SELECT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?1) AS submitted FROM projects WHERE id = ?1 AND photographer_id = ?2'
        ).bind(id, who.id).first();
        if (!still) return jsonErr('Not found', 404);
        return still.submitted ? hasSubmissions() : hasOrders();
      }
      return jsonOk({ ok: true }, 200, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/links — a fresh pick link for a project
    // whose link leaked or was revoked. Same snapshot as the project (not the
    // old link's, not the body's), same expiry as at creation. The old links
    // stay as they are; POST /api/shares/:token/revoke kills one.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && pathParts[4] === 'links' && !pathParts[5]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const project = await env.DB.prepare('SELECT id, title, folders, archived_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(pathParts[3], who.id).first();
      if (!project) return jsonErr('Not found', 404);
      const archivedErr = () => jsonOk({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
      if (project.archived_at) return archivedErr();
      const token = newShareToken();
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + SHARE_TTL_MS).toISOString();
      // Gated on the project still being open and still the caller's, so an
      // archive (or a delete) landing between the read above and this write
      // leaves no live link behind it.
      const minted = await env.DB.prepare(
        "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) SELECT ?, '', ?, 'pick', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ? AND archived_at IS NULL)"
      ).bind(token, project.title, project.id, project.folders, createdAt, expiresAt, project.id, who.id).run();
      if (!minted.meta || !minted.meta.changes) return archivedErr();
      return jsonOk({ token, expires_at: expiresAt, created_at: createdAt, status: 'live' }, 201, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/deliver {final_folders: [...]} — the
    // finished photos went out: the pick link becomes the delivery gallery
    // (docs/delivery.md). A stamp, not a phase (the phase CHECK cannot change
    // without a table rebuild): only from 'retouching', so the guest's writes
    // stay refused. The finals snapshot is validated like the project's own
    // folders and may not be inside, equal to or around any proof folder (the
    // project's, or any of its pick links' snapshots): the picking view shows
    // a folder's subfolders, so a finals folder there would leak before
    // delivery. The snapshot and the stamp are one conditional UPDATE. A
    // repeat while delivered may change the finals and keeps the first stamp.
    // POST /api/admin/projects/:id/undeliver — takes the gallery down: clears
    // the stamp only. The snapshot stays as the photographer's last choice
    // (admin.html prefills the next deliver with it); without the stamp
    // pickFinals reads it as not delivered, so no link can reach it. Reopen
    // does the same (and moves the phase back to picking). Names no column
    // the delivery migration adds, so it works before that migration too.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[5] &&
        (pathParts[4] === 'deliver' || pathParts[4] === 'undeliver')) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      if (pathParts[4] === 'undeliver') {
        // the confirmation goes with the delivery, in the same statement.
        // The one gated on "delivered" goes first: its count says whether
        // this request took a delivery down (of two racing, one did), for the
        // activity log; the ungated one after it (only when that changed
        // nothing) keeps the old answer for a project not delivered.
        const undeliver = (confirm, cond) => env.DB.prepare(`UPDATE projects SET delivered_at = NULL${confirm} WHERE id = ? AND photographer_id = ?${cond}`)
          .bind(id, who.id).run();
        const run = cond => withoutMissingColumn(
          () => undeliver(', client_confirmed_at = NULL, client_confirmed_by = NULL', cond), () => undeliver('', cond));
        const tookDown = await run(' AND delivered_at IS NOT NULL');
        const result = tookDown.meta?.changes ? tookDown : await run('');
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        if (tookDown.meta?.changes) {
          // the snapshot taken down: undeliver keeps it, so it reads the same
          // after the write (best-effort; null before the delivery migration)
          let row = null;
          try {
            row = await env.DB.prepare('SELECT final_folders FROM projects WHERE id = ? AND photographer_id = ?').bind(id, who.id).first();
          } catch {}
          await logProjectEvent(env, id, 'undeliver', 'photographer', new Date().toISOString(), { final_folders: parsedFinals(row) });
        }
        return jsonOk({ ok: true, delivered_at: null }, 200, ADMIN_ONLY_HEADERS);
      }
      const notRetouching = phase =>
        jsonOk({ error: '尚未開始修圖，無法標記為已交件', code: 'not_retouching', phase }, 409, ADMIN_ONLY_HEADERS);
      const invalid = (code, extra = {}, error = '交件資料夾不正確') => jsonOk({ error, code, ...extra }, 400, ADMIN_ONLY_HEADERS);
      // final_folders as it was: the activity log's 改交 names what it replaced
      const project = await env.DB.prepare('SELECT phase, folders, final_folders, delivered_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, who.id).first();
      if (!project) return jsonErr('Not found', 404);
      if (project.phase !== 'retouching') return notRetouching(project.phase);
      let body = null;
      try { body = await request.json(); } catch {}
      const raw = isPlainObject(body) ? body.final_folders : undefined;
      if (Array.isArray(raw) && raw.length > DELIVER_MAX_FOLDERS) {
        return invalid('too_many_final_folders', { max: DELIVER_MAX_FOLDERS }, `交件資料夾最多 ${DELIVER_MAX_FOLDERS} 個`);
      }
      const finals = finalFolders(raw);
      if (!finals) return invalid('invalid_final_folders');
      // every folder a pick link of this project was ever given, and the
      // project's own
      const proofs = [];
      const addProofs = json => {
        let v = null;
        try { v = JSON.parse(json); } catch {}
        if (Array.isArray(v)) proofs.push(...v.filter(f => typeof f === 'string'));
      };
      addProofs(project.folders);
      const { results: links } = await env.DB.prepare("SELECT folders FROM share_tokens WHERE kind = 'pick' AND project_id = ?").bind(id).all();
      for (const l of links) addProofs(l.folders);
      const clash = finals.find(f => proofs.some(p => folderCovers(p, f) || folderCovers(f, p)));
      if (clash) return invalid('final_overlaps_proofs', { folder: clash }, `「${clash}」與毛片資料夾重疊，精修請放在獨立的資料夾`);
      const at = new Date().toISOString();
      // gated on the phase and on the folders the check above read. Every
      // deliver puts a new version up (docs/delivery.md, client
      // confirmation): it clears the confirmation in the same statement and,
      // in the same batch and under the same gate, resolves the guest's open
      // 要求修改 — so a refused deliver changes neither. Before the
      // client-confirm migration it is the one statement it always was.
      const gate = "id = ? AND photographer_id = ? AND phase = 'retouching' AND folders = ?";
      const gateBinds = [id, who.id, project.folders];
      const stamp = confirm => env.DB.prepare(
        `UPDATE projects SET delivered_at = COALESCE(delivered_at, ?), final_folders = ?${confirm} WHERE ${gate}`
      ).bind(at, JSON.stringify(finals), ...gateBinds);
      const result = await withoutMissingSchema(
        async () => (await env.DB.batch([
          stamp(', client_confirmed_at = NULL, client_confirmed_by = NULL'),
          env.DB.prepare(
            `UPDATE revision_requests SET resolved_at = ? WHERE project_id = ? AND resolved_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE ${gate} AND delivered_at IS NOT NULL)`
          ).bind(at, id, ...gateBinds),
        ]))[0],
        () => stamp('').run(),
      );
      const row = await env.DB.prepare('SELECT phase, delivered_at FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, who.id).first();
      if (!row) return jsonErr('Not found', 404);
      // No change, or a reopen landed between the write and this read and
      // cleared the stamp (the snapshot just written stays, as the last
      // choice): either way the project is not delivered now.
      if (!result.meta?.changes || !row.delivered_at) return notRetouching(row.phase);
      // A stamp older than this request's (COALESCE kept it): a repeat, 改交,
      // replacing the set read before the write. The stamp read before the
      // write counts too: two delivers inside one millisecond share `at`, so
      // the later one would otherwise read as a first deliver.
      const repeat = !!project.delivered_at || row.delivered_at !== at;
      await logProjectEvent(env, id, 'deliver', 'photographer', at,
        repeat ? { final_folders: finals, repeat: true, previous: parsedFinals(project) } : { final_folders: finals });
      return jsonOk({ ok: true, delivered_at: row.delivered_at, final_folders: finals }, 200, ADMIN_ONLY_HEADERS);
    }

    // POST /api/admin/projects/:id/confirm — 標記完成: the photographer marks
    // the delivery complete when the guest never answers (docs/delivery.md,
    // client confirmation). Recorded as the photographer's, never as the
    // guest's. Only while delivered (409 not_delivered); a second press
    // answers the first stamp, whoever made it. Resolves the open requests in
    // the same batch. No email (the photographer did it).
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] &&
        pathParts[4] === 'confirm' && !pathParts[5]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const id = pathParts[3];
      const done = (data, status = 200) => jsonOk(data, status, ADMIN_ONLY_HEADERS);
      const notDelivered = () => done({ error: '尚未交件，無法標記完成', code: 'not_delivered' }, 409);
      const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, who.id).first();
      if (!project) return jsonErr('Not found', 404);
      if (!hasField(project, 'client_confirmed_at')) return done(CONFIRM_UNAVAILABLE, 500);
      if (!project.delivered_at) return notDelivered();
      const at = new Date().toISOString();
      let stamped;
      try {
        [stamped] = await env.DB.batch([
          env.DB.prepare(
            "UPDATE projects SET client_confirmed_at = ?, client_confirmed_by = 'photographer' " +
            'WHERE id = ? AND photographer_id = ? AND delivered_at IS NOT NULL AND client_confirmed_at IS NULL'
          ).bind(at, id, who.id),
          resolveRevisionsIfConfirmed(env, id, at, who.id),
        ]);
      } catch (e) {
        // the columns are there but not the table: nothing was written
        if (isMissingSchema(e)) return done(CONFIRM_UNAVAILABLE, 500);
        throw e;
      }
      const row = await env.DB.prepare('SELECT client_confirmed_at, client_confirmed_by FROM projects WHERE id = ? AND photographer_id = ?')
        .bind(id, who.id).first();
      if (!row) return jsonErr('Not found', 404);
      // not confirmed now: an undeliver landed before the write
      if (!row.client_confirmed_at) return notDelivered();
      // logged only when this press made the stamp (a repeat answers the first)
      if (stamped?.meta?.changes) await logProjectEvent(env, id, 'confirm', 'photographer', at);
      return done({ ok: true, client_confirmed_at: row.client_confirmed_at, client_confirmed_by: row.client_confirmed_by });
    }

    // PATCH /api/admin/projects/:id — any non-empty subset of
    // {title} (a rename: projects.title and its pick links' label, nothing in
    // R2), {shoot_date, project_type},
    // {allow_proof_download: bool} (the proof-originals switch,
    // docs/delivery.md) and the plan {pick_limit, extra_price, extra_max}
    // (whole numbers from 0, or null; docs/project-plan.md). Any other key or
    // a bad value refuses the whole body (400 invalid_body), so a typo cannot
    // pass for a change. One conditional UPDATE: another photographer's
    // project is 404, and an archived one refuses a plan edit (409 archived;
    // the switch alone still flips, as it always did). Submissions keep the
    // plan as it stood at submit: nothing here touches them.
    if (request.method === 'PATCH' && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[4]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const who = auth.who;
      if (!env.DB) return jsonErr('DB not configured', 500);
      let body = null;
      try { body = await request.json(); } catch {}
      const keys = isPlainObject(body) ? Object.keys(body) : [];
      if (!keys.length || !keys.every(k => hasField(PROJECT_PATCH_FIELDS, k) && PROJECT_PATCH_FIELDS[k](body[k]))) {
        return jsonOk({
          error: "Send any of {title: 1 to 200 characters, allow_proof_download: true|false, pick_limit, extra_price, extra_max: a whole number from 0, or null, shoot_date: 'YYYY-MM-DD', '' or null, project_type: a label of up to 20 characters, '' or null}",
          code: 'invalid_body',
        }, 400, ADMIN_ONLY_HEADERS);
      }
      const planEdit = keys.some(k => !PROJECT_NON_PLAN_FIELDS.includes(k));
      // what each key stores (and what the response echoes, for the keys that normalise)
      const storedValue = k => k === 'shoot_date' ? shootDateValue(body[k]) : k === 'project_type' ? projectTypeValue(body[k])
        : k === 'title' ? body[k].trim() : body[k];
      const value = k => k === 'allow_proof_download' ? (body[k] ? 1 : 0) : storedValue(k);
      // column names are the allow-listed keys above, never free text
      const archivedGate = planEdit ? ' AND archived_at IS NULL' : '';
      let result;
      try {
        const update = env.DB.prepare(
          `UPDATE projects SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND photographer_id = ?` + archivedGate
        ).bind(...keys.map(value), pathParts[3], who.id);
        // a rename also rewrites the one stored copy of the title, the label
        // of this project's own pick links (live or revoked), in the same
        // batch and behind the same gate as the project's UPDATE: both land or
        // neither does (docs/delivery.md, "Renaming a project")
        const renameLinks = keys.includes('title') ? env.DB.prepare(
          "UPDATE share_tokens SET label = ? WHERE kind = 'pick' AND project_id = ? " +
          `AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ?${archivedGate})`
        ).bind(storedValue('title'), pathParts[3], pathParts[3], who.id) : null;
        result = renameLinks ? (await env.DB.batch([update, renameLinks]))[0] : await update.run();
      } catch (e) {
        // extra_max, shoot_date or project_type before its hand-run migration: one statement (or one batch
        // with the rename), so nothing was written; the error names the column
        if (isMissingColumn(e) && keys.includes('project_type') && /project_type/.test(String(e?.message || ''))) {
          return jsonOk(PROJECT_TYPE_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
        }
        if (isMissingColumn(e) && keys.includes('shoot_date') && /shoot_date/.test(String(e?.message || ''))) {
          return jsonOk(SHOOT_DATE_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
        }
        if (isMissingColumn(e) && keys.includes('extra_max')) return jsonOk(EXTRA_MAX_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
        throw e;
      }
      if (!result.meta?.changes) {
        const row = await env.DB.prepare('SELECT archived_at FROM projects WHERE id = ? AND photographer_id = ?')
          .bind(pathParts[3], who.id).first();
        if (row?.archived_at && planEdit) {
          return jsonOk({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409, ADMIN_ONLY_HEADERS);
        }
        return jsonErr('Not found', 404);
      }
      return jsonOk({ ok: true, ...Object.fromEntries(keys.map(k => [k, storedValue(k)])) }, 200, ADMIN_ONLY_HEADERS);
    }
    // any other write to /api/admin/projects/:id is not a route (without this
    // a PUT would fall through to the upload route and store it as a key)
    if ((request.method === 'PUT' || request.method === 'POST') && pathParts[0] === 'api' && pathParts[1] === 'admin' && pathParts[2] === 'projects' && pathParts[3] && !pathParts[4]) {
      // the same 405 for any id and anyone's project: answers no data, asks D1 nothing
      const auth = await requirePhotographer(request, env); // open to every photographer: a 405, no data
      if (auth.refused) return auth.refused;
      return jsonErr('Method not allowed', 405);
    }

    // ─── The platform catalogue: operator routes ───────────────────────────
    // /api/operator/products[/:id[/retire|/restore|/image]] and
    // /api/operator/stats. The operator token first (401: no photographer,
    // link or session token opens any of it), then the method (405), then the
    // id (404). Anything else under /api/operator/ is 404 here, so nothing
    // falls through to the upload route. The operator's catalogue carries
    // vendor_cost; nothing here is reachable with the photographer's token.
    if (pathParts[0] === 'api' && pathParts[1] === 'operator') {
      if (!isOperatorToken(request, env)) return jsonErr('Unauthorized', 401);
      const [, , area, id, action] = pathParts;
      let route = null;
      if (pathParts.length > 5) route = null;
      else if (area === 'products') {
        route = !id ? 'products' : !action ? 'product' : ['retire', 'restore'].includes(action) ? 'product-active'
          : action === 'image' ? 'product-image' : null;
      } else if (area === 'stats') route = !id ? 'stats' : null;
      else if (area === 'photographers') {
        route = !id ? 'photographers' : PHOTOGRAPHER_ACTIONS[action] ? 'photographer-action' : null;
      } else if (area === 'photographer-invites') {
        route = !id ? 'invites' : action === 'revoke' ? 'invite-revoke' : null;
      }
      const methods = {
        products: ['GET', 'POST'], product: ['PUT'], 'product-active': ['POST'], 'product-image': ['PUT', 'DELETE'], stats: ['GET'],
        photographers: ['GET'], 'photographer-action': ['POST'], invites: ['GET', 'POST'], 'invite-revoke': ['POST'],
      }[route];
      if (!methods) return jsonErr('Not found', 404);
      if (!methods.includes(request.method)) return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = new Date().toISOString();
      const done = (data, status = 200) => jsonOk(data, status, ADMIN_ONLY_HEADERS);

      // Photographer invite codes. The secret, then the migration (500
      // invites_unavailable, nothing written), then the route. Not behind
      // PHOTOGRAPHER_ROUTES: only registering with a code is.
      // GET /api/operator/photographer-invites — newest first, ≤ 200, each
      //   with its state and who used it; never a code or its hash.
      // POST /api/operator/photographer-invites {note?} → 201 {id, code,
      //   expires_at, note}: the only time the code leaves the Worker. One
      //   conditional insert, so parallel creates never pass the live cap.
      // POST /api/operator/photographer-invites/:id/revoke — an unspent code
      //   stops working; a repeat (or a used code) changes nothing, 200; 404
      //   for an id that is not there.
      if (route === 'invites' || route === 'invite-revoke') {
        if (!photographerInviteSecretOk(env)) return done(INVITES_UNAVAILABLE, 500);
        try {
          if (!await photographerInvitesReady(env)) return done(INVITES_UNAVAILABLE, 500);
          if (route === 'invites' && request.method === 'GET') {
            const { results } = await env.DB.prepare(
              `${PHOTOGRAPHER_INVITE_VIEW_SQL} ORDER BY i.created_at DESC, i.rowid DESC LIMIT ${PHOTOGRAPHER_INVITE_LIST_MAX}`
            ).all();
            return done({ invites: results.map(r => photographerInviteView(r, now)) });
          }
          if (route === 'invites') {
            const bytes = await readBodyCapped(request, PHOTOGRAPHER_BODY_MAX);
            if (!bytes) return done({ error: '資料太大', code: 'too_large', max: PHOTOGRAPHER_BODY_MAX }, 413);
            let body = {};
            if (bytes.length) {
              try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return jsonErr('Invalid JSON'); }
            }
            if (!isPlainObject(body)) return done({ error: 'Invalid body', code: 'invalid_body' }, 400);
            // the invitee: normalised exactly as registration normalises it
            const email = photographerEmail(body.email);
            if (!email) return done({ error: 'Email 格式不正確', code: 'invalid_email' }, 400);
            const rawNote = body.note ?? '';
            if (typeof rawNote !== 'string' || overChars(rawNote.trim(), PHOTOGRAPHER_INVITE_NOTE_MAX) || ACCOUNT_CONTROL.test(rawNote)) {
              return done({ error: `備註最多 ${PHOTOGRAPHER_INVITE_NOTE_MAX} 字，且只能一行`, code: 'invalid_note' }, 400);
            }
            const note = rawNote.trim() || null;
            const code = pickInviteCode();
            const id = randomHex(8);
            const expiresAt = new Date(Date.parse(now) + PHOTOGRAPHER_INVITE_MS).toISOString();
            // One batch: this email's live code (if any) is revoked — one live
            // code per email — and the new one inserted, both only while the
            // email has no account; the insert also only under the live cap
            // (counted after the revoke, so replacing never trips it).
            const free = 'NOT EXISTS (SELECT 1 FROM photographers WHERE email = ?2)';
            const [replaced, made] = await env.DB.batch([
              env.DB.prepare(
                `UPDATE photographer_invites SET revoked_at = ?1 WHERE email = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1 AND ${free}`
              ).bind(now, email),
              env.DB.prepare(
                'INSERT INTO photographer_invites (id, email, code_hash, created_at, expires_at, note) SELECT ?1, ?2, ?3, ?4, ?5, ?6 ' +
                `WHERE (SELECT COUNT(*) FROM photographer_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?4) < ?7 AND ${free}`
              ).bind(id, email, await photographerInviteHash(env, email, code), now, expiresAt, note, PHOTOGRAPHER_INVITES_LIVE_MAX),
            ]);
            if (!made.meta.changes) {
              if (await env.DB.prepare('SELECT 1 FROM photographers WHERE email = ?').bind(email).first()) {
                return done({ error: '這個 Email 已經有帳號', code: 'email_taken' }, 409);
              }
              return done({ error: `尚未使用的邀請碼最多 ${PHOTOGRAPHER_INVITES_LIVE_MAX} 組，請先撤銷不用的`, code: 'invite_limit', max: PHOTOGRAPHER_INVITES_LIVE_MAX }, 409);
            }
            return done({ id, email, code, expires_at: expiresAt, note, replaced: replaced.meta.changes }, 201);
          }
          await env.DB.prepare('UPDATE photographer_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL').bind(now, id).run();
          const row = await env.DB.prepare(`${PHOTOGRAPHER_INVITE_VIEW_SQL} WHERE i.id = ?`).bind(id).first();
          if (!row) return jsonErr('Not found', 404);
          return done({ ok: true, invite: photographerInviteView(row, now) });
        } catch (e) {
          if (isMissingSchema(e)) return done(INVITES_UNAVAILABLE, 500);
          throw e;
        }
      }

      // GET /api/operator/photographers — pending accounts first (so the cap
      // of 500 never hides one waiting for approval; at most 200 can wait),
      // then the rest, newest first; and how many wait for approval. Never a password hash or a session.
      // POST /api/operator/photographers/:id/<action> — see
      // PHOTOGRAPHER_ACTIONS. Each write is conditional on the status it
      // moves from, so of two racing actions one wins and the other is 409
      // (404 once the row is gone).
      if (route === 'photographers' || route === 'photographer-action') {
        try {
          if (route === 'photographers') {
            // must_change_password: true / false, null before its migration;
            // invite_id: the invite code that made the account (created_via
            // 'invite'), null for open sign-up — and for everyone before the
            // invites migration, when no code can have made one. Two late
            // pieces, each retried without on its own.
            const listSql = (flag, invite) => `SELECT ${PHOTOGRAPHER_PUBLIC_COLUMNS}, ${flag} AS must_change_password, ${invite} AS invite_id FROM photographers ORDER BY status = 'pending' DESC, created_at DESC, rowid DESC LIMIT ${PHOTOGRAPHER_LIST_MAX}`;
            const list = invite => withoutMissingColumn(
              () => env.DB.prepare(listSql('must_change_password', invite)).all(),
              () => env.DB.prepare(listSql('NULL', invite)).all(),
            );
            const { results } = await withoutMissingSchema(
              () => list('(SELECT i.id FROM photographer_invites i WHERE i.used_by = photographers.id ORDER BY i.used_at LIMIT 1)'),
              () => list('NULL'),
            );
            const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM photographers WHERE status = 'pending'").first();
            return done({
              photographers: results.map(r => ({ ...r, must_change_password: mustChangeFlag(r.must_change_password), created_via: r.invite_id ? 'invite' : 'signup' })),
              pending_count: pending.n,
            });
          }
          const { from, to } = PHOTOGRAPHER_ACTIONS[action];
          let tempPassword = null;
          let statements;
          let resetResult = null;
          // Suspend, reset-password and reject (the delete) also revoke the
          // account's live studio tokens (a 12-hour read credential for its
          // own files), in the same batch, after the account write. The
          // condition is the account's state once that write has run, not
          // whether this write changed it: suspended, still there, or gone,
          // respectively. So an account that is not active (a pending one
          // asked to suspend, an active one asked to reject: 409) keeps its
          // tokens, while suspending an already suspended account (409) or
          // rejecting an id that is not there (404) also runs the revoke —
          // harmless, neither can hold a usable token. (`changes()` inside
          // the batch would be the session DELETE's, so it cannot tell.)
          // The default photographer's tokens (NULL,
          // or a literal 'default') are never touched: it has no row to act on.
          // Before the share-token owner migration there is no column and no
          // owned studio row can exist yet, so the batch runs without it.
          // Pick links are not revoked: resolveShareToken checks the owner's
          // status, so they go dark while suspended and come back after.
          const revokeTokens = landed => (isDefaultOwner(id) ? [] : [env.DB.prepare(
            `UPDATE share_tokens SET revoked_at = ? WHERE kind = 'studio' AND photographer_id = ? AND revoked_at IS NULL AND ${landed}`
          ).bind(now, id, id)]);
          const withTokens = (writes, landed) => withoutMissingColumn(
            () => env.DB.batch([...writes, ...revokeTokens(landed)]),
            () => env.DB.batch(writes),
          );
          if (action === 'reject') {
            statements = [env.DB.prepare("DELETE FROM photographers WHERE id = ? AND status = 'pending'").bind(id)];
          } else if (action === 'reset-password') {
            tempPassword = tempPhotographerPassword();
            const tempHash = await hashPhotographerPassword(tempPassword);
            // the new hash and must_change_password = 1 in one statement, every
            // session and studio token gone in the same batch. Before the
            // 2026-10-15 migration the flag cannot be written, and a temporary
            // password nobody has to change is worse than none: 500, and the
            // batch (one transaction) wrote nothing — no new hash, no session
            // ended.
            resetResult = await withoutMissingColumn(() => withTokens([
              env.DB.prepare('UPDATE photographers SET password_hash = ?, must_change_password = 1 WHERE id = ?').bind(tempHash, id),
              env.DB.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ?').bind(id),
            ], 'EXISTS (SELECT 1 FROM photographers WHERE id = ?)'), () => null);
            if (!resetResult) return done({ error: '請先執行 must_change_password migration 再重設密碼', code: 'must_change_unavailable' }, 500);
          } else {
            statements = [env.DB.prepare(
              `UPDATE photographers SET status = ?${action === 'approve' ? ', approved_at = ?' : ''} WHERE id = ? AND status = ?`
            ).bind(...(action === 'approve' ? [to, now, id, from] : [to, id, from]))];
            // suspend ends every session in the same batch
            if (action === 'suspend') statements.push(env.DB.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ?').bind(id));
          }
          const landedIf = {
            reject: 'NOT EXISTS (SELECT 1 FROM photographers WHERE id = ?)',
            suspend: "EXISTS (SELECT 1 FROM photographers WHERE id = ? AND status = 'suspended')",
          }[action];
          const [first] = resetResult ?? await (landedIf ? withTokens(statements, landedIf) : env.DB.batch(statements));
          if (!first.meta.changes) {
            const current = await env.DB.prepare('SELECT status FROM photographers WHERE id = ?').bind(id).first();
            if (!current) return jsonErr('Not found', 404);
            return done({ error: '帳號狀態已改變，請重新整理', code: 'wrong_status', status: current.status }, 409);
          }
          if (action === 'reject') return done({ ok: true, deleted: true });
          const photographer = await env.DB.prepare(`SELECT ${PHOTOGRAPHER_PUBLIC_COLUMNS} FROM photographers WHERE id = ?`).bind(id).first();
          if (!tempPassword) return done({ ok: true, photographer });
          return done({ ok: true, photographer, temp_password: tempPassword, must_change_password: true });
        } catch (e) {
          if (isMissingSchema(e)) return done(PHOTOGRAPHERS_UNAVAILABLE, 500);
          throw e;
        }
      }

      // GET /api/operator/stats — what the platform sold: per platform
      // product and per Taipei month (the dashboard's twelve), counted when
      // the order is paid (paid_at, any payment), cancelled excluded, every
      // photographer. Revenue is the platform price and cost the vendor's,
      // both as snapshotted on the line.
      if (route === 'stats') {
        const { months, since } = statsMonths(Date.now());
        const { results: sold } = await env.DB.prepare(
          `SELECT po.platform_product_id AS id, strftime('%Y-%m', o.paid_at, '+8 hours') AS month,
                  SUM(i.qty) AS qty, SUM(i.unit_cost * i.qty) AS revenue, SUM(i.vendor_cost * i.qty) AS vendor_cost
             FROM orders o JOIN order_items i ON i.order_id = o.id
             JOIN platform_product_options po ON po.id = i.platform_option_id
            WHERE o.status != 'cancelled' AND o.paid_amount > 0 AND o.paid_at >= ?
            GROUP BY po.platform_product_id, month`
        ).bind(since).all();
        const { results: catalogue } = await env.DB.prepare(
          'SELECT id, name, kind, active FROM platform_products ORDER BY active DESC, sort, created_at, rowid'
        ).all();
        const thisMonth = months[months.length - 1];
        const zero = () => ({ qty: 0, revenue: 0, vendor_cost: 0, margin: 0 });
        const add = (into, r) => {
          into.qty += r.qty; into.revenue += r.revenue; into.vendor_cost += r.vendor_cost;
          into.margin = into.revenue - into.vendor_cost;
        };
        const perMonth = new Map(months.map(month => [month, { month, ...zero() }]));
        const products = new Map(catalogue.map(p => [p.id, {
          platform_product_id: p.id, name: p.name, kind: p.kind, active: p.active, ...zero(), this_month: zero(),
        }]));
        for (const r of sold) {
          // a payment dated ahead into next month is outside the window
          if (!perMonth.has(r.month)) continue;
          add(perMonth.get(r.month), r);
          const p = products.get(r.id);
          if (!p) continue;
          add(p, r);
          if (r.month === thisMonth) add(p.this_month, r);
        }
        return done({
          per_month: [...perMonth.values()],
          this_month: perMonth.get(thisMonth),
          products: [...products.values()],
        });
      }

      // PUT /api/operator/products/:id/image — raw bytes, the logo's rules;
      // DELETE removes it. Served publicly at /api/platform/products/:id/image.
      if (route === 'product-image') {
        const exists = await env.DB.prepare('SELECT id FROM platform_products WHERE id = ?').bind(id).first();
        if (!exists) return jsonErr('Not found', 404);
        if (request.method === 'DELETE') {
          await env.DB.prepare('UPDATE platform_products SET image = NULL, image_type = NULL, image_updated_at = NULL, updated_at = ? WHERE id = ?')
            .bind(now, id).run();
          return done({ ok: true, has_image: false });
        }
        const upload = await imageUpload(request, '商品圖片');
        if (upload.refused) return upload.refused;
        await env.DB.prepare('UPDATE platform_products SET image = ?, image_type = ?, image_updated_at = ?, updated_at = ? WHERE id = ?')
          .bind(upload.bytes.buffer, upload.type, now, now, id).run();
        return done({ ok: true, has_image: true, image_type: upload.type, image_updated_at: now, size: upload.bytes.byteLength });
      }

      // POST /api/operator/products/:id/retire | /restore — off (or back on)
      // the list photographers adopt from and sell. Existing lines keep
      // their snapshot.
      if (route === 'product-active') {
        const active = action === 'restore' ? 1 : 0;
        const result = await env.DB.prepare('UPDATE platform_products SET active = ?, updated_at = ? WHERE id = ?')
          .bind(active, now, id).run();
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        return done({ ok: true, active });
      }

      if (route === 'products' && request.method === 'GET') {
        return done({ products: await readPlatformProducts(env) });
      }

      let body;
      try { body = await request.json(); } catch { body = null; }
      if (!isPlainObject(body)) return jsonErr('Invalid body');

      // POST /api/operator/products — {kind: print|album, name,
      // description?, photo_count?, min_pages?, max_pages?, bleed_mm?,
      // extra_page_price?, category?, sort?, options: [{label, vendor_cost,
      // platform_price}]}, ≥ 1 option. photo_count and the page bounds stick
      // to albums only; max_pages ≥ min_pages; category any kind (≤ 20, '' = null).
      if (route === 'products') {
        const fields = productFields(body, false, PLATFORM_KINDS, false);
        if (fields.bad) return orderBad(fields.bad);
        const bounds = pageBoundsWrite(body, fields.set.kind, null);
        if (bounds.bad) return orderBad(bounds.bad);
        const bleed = bleedWrite(body);
        if (bleed.bad) return orderBad(bleed.bad);
        const extra = extraPagePriceWrite(body, fields.set.kind, null);
        if (extra.bad) return orderBad(extra.bad);
        const category = categoryWrite(body);
        if (category.bad) return orderBad(category.bad);
        const opts = productOptions(body.options, new Set(), PLATFORM_MONEY);
        if (opts.bad) return orderBad(opts.bad);
        // a NULL bound for a column the database does not have is dropped,
        // so a product without one is made before its migration too; the
        // columns are probed only when the body names a bound or the bleed
        const late = { ...bounds.set, ...bleed.set, ...extra.set, ...category.set };
        const fit = Object.keys(late).length ? pageBoundsFit(late, await pageColumns(env)) : { set: {} };
        if (fit.unavailable) return done(fit.unavailable, 500);
        const pageCols = Object.keys(fit.set);
        const p = { description: '', photo_count: null, sort: 0, ...fields.set };
        if (p.kind !== 'album') p.photo_count = null;
        const productId = crypto.randomUUID();
        // column names: PRODUCT_LATE_COLUMNS' fixed strings only
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO platform_products (id, kind, name, description, photo_count, sort, created_at, updated_at${pageCols.map(c => `, ${c}`).join('')}) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?${pageCols.map(() => ', ?').join('')})`
          ).bind(productId, p.kind, p.name, p.description, p.photo_count, p.sort, now, now, ...pageCols.map(c => fit.set[c])),
          ...opts.options.map(o => env.DB.prepare(
            'INSERT INTO platform_product_options (id, platform_product_id, label, vendor_cost, platform_price, sort) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), productId, o.label, o.vendor_cost, o.platform_price, o.sort)),
        ]);
        const [product] = await readPlatformProducts(env, productId);
        return done({ product }, 201);
      }

      // PUT /api/operator/products/:id — the fields present change; options
      // as a set, the photographer's rules. A price change reaches new lines
      // only; a retired option stops new lines of every adopter. The page
      // bounds are judged on the row as it will be (a bound left out keeps
      // its stored value); leaving album clears both.
      // `cols`: the columns the read below ended up naming (both, unless it
      // had to probe), reused for the write so it never probes again
      let cols = ALL_PAGE_COLUMNS;
      const current = await withPageColumns(env, c => {
        cols = c;
        return env.DB.prepare(`SELECT pp.id, pp.kind, ${pageSelect(c)} FROM platform_products pp WHERE pp.id = ?`).bind(id).first();
      });
      if (!current) return jsonErr('Not found', 404);
      const fields = productFields(body, true, PLATFORM_KINDS, false);
      if (fields.bad) return orderBad(fields.bad);
      const kind = fields.set.kind ?? current.kind;
      const bounds = pageBoundsWrite(body, kind, current);
      if (bounds.bad) return orderBad(bounds.bad);
      const bleed = bleedWrite(body);
      if (bleed.bad) return orderBad(bleed.bad);
      const extra = extraPagePriceWrite(body, kind, current);
      if (extra.bad) return orderBad(extra.bad);
      const category = categoryWrite(body);
      if (category.bad) return orderBad(category.bad);
      let opts = null;
      if (hasField(body, 'options')) {
        const { results } = await env.DB.prepare('SELECT id FROM platform_product_options WHERE platform_product_id = ?').bind(id).all();
        const checked = productOptions(body.options, new Set(results.map(r => r.id)), PLATFORM_MONEY);
        if (checked.bad) return orderBad(checked.bad);
        opts = checked.options;
      }
      // a number for a column this database does not have yet: 500, before
      // anything is written; a NULL for one is dropped (nothing to clear)
      const fit = pageBoundsFit({ ...bounds.set, ...bleed.set, ...extra.set, ...category.set }, cols);
      if (fit.unavailable) return done(fit.unavailable, 500);
      if (kind !== 'album') fields.set.photo_count = null;
      await env.DB.batch(catalogueWrites(env, PLATFORM_TABLES, null, id, { ...fields.set, ...fit.set }, opts, now));
      const [product] = await readPlatformProducts(env, id);
      return done({ product });
    }

    // GET /api/platform/products/:id/image — public: product photos are not
    // secret and the guest shop needs them. The logo's serving rules. Any
    // other path under /api/platform/ is 404, any other method 405.
    if (pathParts[0] === 'api' && pathParts[1] === 'platform') {
      if (pathParts.length !== 5 || pathParts[2] !== 'products' || pathParts[4] !== 'image') return jsonErr('Not found', 404);
      if (request.method !== 'GET') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('Not found', 404);
      let row = null;
      try {
        row = await env.DB.prepare('SELECT image, image_updated_at FROM platform_products WHERE id = ? AND image IS NOT NULL')
          .bind(pathParts[3]).first();
      } catch { row = null; }
      return imageResponse(request, row ? row.image : null, row ? row.image_updated_at : null);
    }

    // ─── Products and orders (docs/products-orders.md) ─────────────────────
    // /api/admin/products[/:id[/retire|/restore]], /api/admin/orders[/:id
    // [/payment|/status]] and /api/admin/projects/:id/orders. The
    // photographer first (401); the order routes are then 404 for anyone but
    // the default photographer (paused), whatever the method; then the method
    // (405), then the id, scoped to the caller (who.id): another photographer's product, order or project
    // is 404, exactly as one that does not exist. The platform catalogue is
    // shared and read only; adopting makes a product of the caller's own. Every 400 is {error, code} and decided before
    // anything is written; writes that touch more than one row are one batch.
    // Anything else under these paths is 404 here, so a PUT can never fall
    // through to the upload route and land in the bucket.
    if (pathParts[0] === 'api' && pathParts[1] === 'admin' &&
        (pathParts[2] === 'products' || pathParts[2] === 'orders' || pathParts[2] === 'platform-products' ||
         (pathParts[2] === 'projects' && pathParts[3] && pathParts[4] === 'orders'))) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id): products and orders
      if (auth.refused) return auth.refused;
      const { who } = auth;
      const [, , area, id, action] = pathParts;
      // null for any deeper or unknown path: 404 below
      let route = null;
      if (pathParts.length > 5) route = null;
      else if (area === 'products') {
        route = !id ? 'products' : id === 'from-platform' && !action ? 'adopt' : !action ? 'product'
          : ['retire', 'restore'].includes(action) ? 'product-active' : null;
      } else if (area === 'platform-products') route = !id ? 'platform-products' : null;
      else if (area === 'projects') route = 'project-orders';
      else route = !id ? 'orders' : !action ? 'order' : ['payment', 'status', 'erase-contact'].includes(action) ? `order-${action}` : null;
      // Ordering is paused for every photographer but the default one: all
      // order routes are 404 for the others, as for a path that does not
      // exist, before the method is looked at and before anything is read
      // or written. Products stay scoped to the caller.
      if (ORDER_ROUTES_PAUSED.has(route)) {
        const paused = defaultOnly(who);
        if (paused) return paused;
      }
      const methods = {
        products: ['GET', 'POST'], product: ['PUT'], 'product-active': ['POST'], 'project-orders': ['GET', 'POST'],
        adopt: ['POST'], 'platform-products': ['GET'],
        orders: ['GET'], order: ['PUT'], 'order-payment': ['POST'], 'order-status': ['POST'], 'order-erase-contact': ['POST'],
      }[route];
      if (!methods) return jsonErr('Not found', 404);
      if (!methods.includes(request.method)) return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      const now = new Date().toISOString();
      let body = null;
      // retire, restore and erase-contact take no body
      if (request.method !== 'GET' && route !== 'product-active' && route !== 'order-erase-contact') {
        try { body = await request.json(); } catch { body = null; }
        if (!isPlainObject(body)) return jsonErr('Invalid body');
      }
      const done = (data, status = 200) => jsonOk(data, status, ADMIN_ONLY_HEADERS);
      // A batch that inserts order lines: built with list_price / layout
      // (`build(true)`), and once more without them on a database the S2
      // migration has not reached (a batch is one transaction: the failed
      // one wrote nothing).
      const batchWithItems = build => withoutMissingColumn(() => env.DB.batch(build(true)), () => env.DB.batch(build(false)));
      // an admin edit takes a system order over; a guest's stays the guest's
      const takeOver = "source = CASE WHEN source = 'system' THEN 'admin' ELSE source END";

      // GET /api/admin/products — the catalogue, retired products and
      // options included (active = 0), never the image bytes.
      if (route === 'products' && request.method === 'GET') {
        return done({ products: await readProducts(env, who.id), custom_products_enabled: customProductsEnabled(env) });
      }

      // GET /api/admin/platform-products — what the platform offers: active
      // products with their active options and platform price (never the
      // vendor cost), and which one this photographer already adopted.
      if (route === 'platform-products') {
        // page bounds: null for a column the database does not have yet
        const { results: offered } = await withPageColumns(env, cols => env.DB.prepare(
          `SELECT pp.id, pp.kind, pp.name, pp.description, pp.photo_count, ${pageSelect(cols)}, pp.sort,
                  pp.image IS NOT NULL AS has_image, pp.image_updated_at,
                  (SELECT p.id FROM products p WHERE p.photographer_id = ? AND p.platform_product_id = pp.id
                    ORDER BY p.rowid LIMIT 1) AS adopted_product_id
             FROM platform_products pp WHERE pp.active = 1 ORDER BY pp.sort, pp.created_at, pp.rowid`
        ).bind(who.id).all());
        const { results: options } = await env.DB.prepare(
          `SELECT po.id, po.platform_product_id, po.label, po.platform_price, po.sort
             FROM platform_product_options po JOIN platform_products pp ON pp.id = po.platform_product_id
            WHERE pp.active = 1 AND po.active = 1 ORDER BY po.sort, po.rowid`
        ).all();
        const products = offered.map(p => ({
          ...p,
          min_pages: albumOnly(p.kind, p.min_pages),
          max_pages: albumOnly(p.kind, p.max_pages),
          extra_page_price: albumOnly(p.kind, p.extra_page_price),
          has_image: !!p.has_image,
          options: options.filter(o => o.platform_product_id === p.id).map(({ platform_product_id, ...o }) => o),
        })).filter(p => p.options.length);
        return done({ products });
      }

      // POST /api/admin/products/from-platform — {platform_product_id,
      // options: [{platform_option_id, price}], guest_visible?, sort?}: adopt
      // a platform product, some of its options, each at a price no lower
      // than its platform price. Name, kind, description, photo_count and
      // image stay the platform's. One per platform product (409).
      if (route === 'adopt') {
        const ppId = body.platform_product_id;
        const pp = typeof ppId === 'string'
          ? await env.DB.prepare('SELECT id, kind, name, description, photo_count, active FROM platform_products WHERE id = ?').bind(ppId).first()
          : null;
        if (!pp) return orderBad('unknown_platform_product');
        if (!pp.active) return orderBad('retired_option');
        const own = {};
        for (const k of ['guest_visible', 'sort']) if (hasField(body, k)) own[k] = body[k];
        const fields = productFields(own, true);
        if (fields.bad) return orderBad(fields.bad);
        const opts = adoptedOptions(body.options, await platformOptionMap(env, pp.id));
        if (opts.bad) return orderBad(opts.bad);
        const adopted = () => env.DB.prepare('SELECT id FROM products WHERE photographer_id = ? AND platform_product_id = ? ORDER BY rowid LIMIT 1')
          .bind(who.id, pp.id).first();
        const already = row => done({ error: '已加入這個平台商品', code: 'already_adopted', product_id: row ? row.id : null }, 409);
        const existing = await adopted();
        if (existing) return already(existing);
        const p = { guest_visible: 0, sort: 0, ...fields.set };
        const productId = crypto.randomUUID();
        // the insert re-checks, so two adopts racing land one product; the
        // options only land with it
        const results = await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO products (id, photographer_id, kind, name, description, photo_count, guest_visible, sort, platform_product_id, created_at, updated_at) ' +
            'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE photographer_id = ? AND platform_product_id = ?)'
          ).bind(productId, who.id, pp.kind, pp.name, pp.description, pp.kind === 'album' ? pp.photo_count : null,
            p.guest_visible, p.sort, pp.id, now, now, who.id, pp.id),
          ...opts.options.map(o => env.DB.prepare(
            'INSERT INTO product_options (id, product_id, label, price, cost, sort, platform_option_id) ' +
            'SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND photographer_id = ?)'
          ).bind(crypto.randomUUID(), productId, o.label, o.price, o.cost, o.sort, o.platform_option_id, productId, who.id)),
        ]);
        if (!results[0].meta?.changes) return already(await adopted());
        const [product] = await readProducts(env, who.id, productId);
        return done({ product }, 201);
      }

      // POST /api/admin/products — {kind, name, description?, photo_count?,
      // guest_visible?, sort?, options: [{label, price, cost?}]}, ≥ 1 option.
      // The photographer's own products are services; albums and prints come
      // from the platform (400 platform_only).
      if (route === 'products') {
        if (!customProductsEnabled(env)) return done(CUSTOM_PRODUCTS_DISABLED, 403);
        const fields = productFields(body, false);
        if (fields.bad) return orderBad(fields.bad);
        if (fields.set.kind !== 'service') return orderBad('platform_only');
        const opts = productOptions(body.options, new Set());
        if (opts.bad) return orderBad(opts.bad);
        const p = { description: '', photo_count: null, guest_visible: 0, sort: 0, ...fields.set };
        // photo_count means something on an album only
        if (p.kind !== 'album') p.photo_count = null;
        const productId = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO products (id, photographer_id, kind, name, description, photo_count, guest_visible, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(productId, who.id, p.kind, p.name, p.description, p.photo_count, p.guest_visible, p.sort, now, now),
          ...opts.options.map(o => env.DB.prepare(
            'INSERT INTO product_options (id, product_id, label, price, cost, sort) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), productId, o.label, o.price, o.cost, o.sort)),
        ]);
        const [product] = await readProducts(env, who.id, productId);
        return done({ product }, 201);
      }

      // PUT /api/admin/products/:id — the fields present change. `options`,
      // when present, is the whole active set: an id keeps (and updates, and
      // if retired restores) that option, no id adds one, and every option
      // left out is retired — never deleted, order lines may point at it.
      // An adopted product takes only {options: [{platform_option_id,
      // price}], guest_visible, sort}; the platform's own fields are 400
      // platform_managed. active is never read here: retire / restore.
      if (route === 'product') {
        const current = await env.DB.prepare('SELECT id, kind, platform_product_id FROM products WHERE id = ? AND photographer_id = ?')
          .bind(id, who.id).first();
        if (!current) return jsonErr('Not found', 404);
        let statements;
        if (current.platform_product_id) {
          if (['kind', 'name', 'description', 'photo_count', 'min_pages', 'max_pages', 'bleed_mm', 'extra_page_price', 'category'].some(k => hasField(body, k))) return orderBad('platform_managed');
          const fields = productFields(body, true);
          if (fields.bad) return orderBad(fields.bad);
          let opts = null;
          if (hasField(body, 'options')) {
            const checked = adoptedOptions(body.options, await platformOptionMap(env, current.platform_product_id));
            if (checked.bad) return orderBad(checked.bad);
            // an option already adopted is the same row, repriced
            const { results } = await env.DB.prepare('SELECT id, platform_option_id FROM product_options WHERE product_id = ?').bind(id).all();
            const byPlatform = new Map(results.map(r => [r.platform_option_id, r.id]));
            opts = checked.options.map(o => ({ ...o, id: byPlatform.get(o.platform_option_id) }));
          }
          statements = catalogueWrites(env, ADOPTED_TABLES, who.id, id, fields.set, opts, now);
        } else {
          if (!customProductsEnabled(env)) return done(CUSTOM_PRODUCTS_DISABLED, 403);
          const fields = productFields(body, true);
          if (fields.bad) return orderBad(fields.bad);
          if (fields.set.kind !== undefined && fields.set.kind !== 'service') return orderBad('platform_only');
          let opts = null;
          if (hasField(body, 'options')) {
            const { results } = await env.DB.prepare('SELECT id FROM product_options WHERE product_id = ?').bind(id).all();
            const checked = productOptions(body.options, new Set(results.map(r => r.id)));
            if (checked.bad) return orderBad(checked.bad);
            opts = checked.options;
          }
          if ((fields.set.kind ?? current.kind) !== 'album') fields.set.photo_count = null;
          statements = catalogueWrites(env, CUSTOM_TABLES, who.id, id, fields.set, opts, now);
        }
        await env.DB.batch(statements);
        const [product] = await readProducts(env, who.id, id);
        return done({ product });
      }

      // POST /api/admin/products/:id/retire | /restore — off (or back on)
      // the list new lines are made from. Existing lines keep their snapshot.
      // With custom products off, a custom one can still be retired (taken
      // off sale) but not restored.
      if (route === 'product-active') {
        const active = action === 'restore' ? 1 : 0;
        if (active && !customProductsEnabled(env)) {
          const current = await env.DB.prepare('SELECT platform_product_id FROM products WHERE id = ? AND photographer_id = ?')
            .bind(id, who.id).first();
          // no row (unknown, or another photographer's) is the 404 below
          if (current && !current.platform_product_id) return done(CUSTOM_PRODUCTS_DISABLED, 403);
        }
        const result = await env.DB.prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ? AND photographer_id = ?')
          .bind(active, now, id, who.id).run();
        if (!result.meta?.changes) return jsonErr('Not found', 404);
        return done({ ok: true, active });
      }

      // GET /api/admin/orders?status=&unpaid=1 — every order across this
      // photographer's projects, archived ones included: the to-do list.
      // unpaid=1 is "outstanding > 0" (confirmed or fulfilled, not fully paid).
      if (route === 'orders') {
        const wanted = params.get('status') || '';
        if (wanted && !ORDER_STATUSES.includes(wanted)) return orderBad('invalid_status');
        const where = ['1 = 1'];
        const binds = [];
        if (wanted) { where.push('o.status = ?'); binds.push(wanted); }
        if (params.get('unpaid') === '1') where.push(`${ORDER_OUTSTANDING_SQL} > 0`);
        return done({ orders: await readOrders(env, who.id, where.join(' AND '), binds) });
      }

      if (route === 'project-orders') {
        // SELECT *: the finals snapshot (final_folders) is one of the folders
        // a line's photo may be in (orderPhotoFolders)
        const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND photographer_id = ?')
          .bind(id, who.id).first();
        if (!project) return jsonErr('Not found', 404);

        // GET /api/admin/projects/:id/orders — the project's orders with
        // their money, and the extra-pick fee as the latest submission says
        // it should be, against the order it is charged on (the system one,
        // else the newest with an extra-pick line). `matches` compares the
        // photo counts, so a waived price is not a mismatch but 10 → 14 is.
        if (request.method === 'GET') {
          const orders = await readOrders(env, who.id, 'o.project_id = ?', [id]);
          const fee = extraPickFee(await latestSubmission(env, id, project.photographer_id));
          const charged = orders.map(o => [o, o.items.find(i => i.kind === 'extra_pick')]).filter(([, line]) => line);
          const [order, line] = charged.find(([o]) => o.source === 'system') || charged[0] || [null, null];
          return done({
            orders,
            extra_pick: {
              ...fee,
              order_id: order ? order.id : null,
              order_extra: line ? line.qty : null,
              matches: line ? line.qty === fee.extra : fee.fee === 0,
            },
          });
        }

        // POST /api/admin/projects/:id/orders — {lines: [{option_id, qty,
        // photo_keys?, unit_price?}], discount?, note?}. Confirmed at once;
        // archived projects too (a late sale is still a sale). photo_keys are
        // logical keys inside the caller's own project's folders (orderLines
        // checks them against the project); any R2 read of one goes through
        // the caller's prefix (bucketFor, batch 3).
        const checked = await orderLines(env, project, body.lines, null, { photographerId: who.id });
        if (checked.bad) return orderBad(checked.bad, checked.error);
        const discount = body.discount ?? 0;
        const discountBad = orderDiscount(discount, linesSubtotal(checked.lines));
        if (discountBad) return orderBad(discountBad);
        const note = hasField(body, 'note') ? orderNote(body.note) : '';
        if (note === null) return orderBad('invalid_note');
        const orderId = crypto.randomUUID();
        await batchWithItems(late => [
          env.DB.prepare(
            "INSERT INTO orders (id, photographer_id, project_id, source, status, discount, note, created_at, updated_at, confirmed_at) " +
            "SELECT ?, ?, ?, 'admin', 'confirmed', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND photographer_id = ?)"
          ).bind(orderId, who.id, id, discount, note, now, now, now, id, who.id),
          ...checked.lines.map(l => orderItemInsert(env, orderId, l, 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND photographer_id = ?)', [orderId, who.id], late)),
        ]);
        const order = await readOrder(env, who.id, orderId);
        if (!order) return jsonErr('Not found', 404);
        return done({ order }, 201);
      }

      // The three single-order routes. Each write is conditional on the
      // order being exactly as read (updated_at, or the status for a status
      // move), so two edits cannot interleave; the loser is a 409.
      const order = await readOrder(env, who.id, id);
      if (!order) return jsonErr('Not found', 404);
      const conflict = () => done({ error: '訂單剛被修改，請重新整理', code: 'conflict' }, 409);
      const cancelled = () => done({ error: '訂單已取消', code: 'cancelled' }, 409);

      // PUT /api/admin/orders/:id — {discount?, note?, lines?}; the fields
      // present change. `lines` is the whole set: {id, qty?, photo_keys?,
      // unit_price?} keeps a line and its snapshot, {option_id, ...} adds one
      // from the catalogue, and a line left out is removed. A cancelled
      // order's money is frozen (409); its note is not. The total may not
      // drop below what was already paid (400 below_paid).
      if (route === 'order') {
        // lines carry photo_keys: logical keys inside the caller's own
        // project's folders, as for a new order (batch 3)
        const money = hasField(body, 'lines') || hasField(body, 'discount');
        if (order.status === 'cancelled' && money) return cancelled();
        let lines = null;
        if (hasField(body, 'lines')) {
          const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND photographer_id = ?')
            .bind(order.project_id, who.id).first();
          const checked = await orderLines(env, project, body.lines, new Map(order.items.map(i => [i.id, i])), { photographerId: who.id });
          if (checked.bad) return orderBad(checked.bad, checked.error);
          lines = checked.lines;
        }
        const discount = hasField(body, 'discount') ? body.discount : order.discount;
        const subtotal = lines ? linesSubtotal(lines) : order.subtotal;
        const discountBad = orderDiscount(discount, subtotal);
        if (discountBad) return orderBad(discountBad);
        const note = hasField(body, 'note') ? orderNote(body.note) : order.note;
        if (note === null) return orderBad('invalid_note');
        if (subtotal - discount < order.paid_amount) return orderBad('below_paid');
        // the owner too, so a line never changes on an order that is no
        // longer the caller's (the last statement checks it again)
        const same = 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND photographer_id = ? AND updated_at = ?)';
        const sameBinds = [id, who.id, order.updated_at];
        // the statements, with or without the S2 line columns (batchWithItems)
        const build = late => {
          const statements = [];
          if (lines) {
            const kept = lines.filter(l => !l.isNew).map(l => l.id);
            statements.push(env.DB.prepare(
              `DELETE FROM order_items WHERE order_id = ? AND id NOT IN (SELECT value FROM json_each(?)) AND ${same}`
            ).bind(id, JSON.stringify(kept), ...sameBinds));
            for (const l of lines) {
              statements.push(l.isNew
                ? orderItemInsert(env, id, l, same, sameBinds, late)
                : env.DB.prepare(`UPDATE order_items SET qty = ?, unit_price = ?, photo_keys = ? WHERE id = ? AND order_id = ? AND ${same}`)
                  .bind(l.qty, l.unit_price, l.photo_keys, l.id, id, ...sameBinds));
            }
          }
          // last, because every statement above is gated on the updated_at it
          // moves
          statements.push(env.DB.prepare(
            `UPDATE orders SET discount = ?, note = ?, ${takeOver}, updated_at = ? WHERE id = ? AND photographer_id = ? AND updated_at = ?`
          ).bind(discount, note, now, id, who.id, order.updated_at));
          return statements;
        };
        const results = await batchWithItems(build);
        if (!results[results.length - 1].meta?.changes) return conflict();
        return done({ order: await readOrder(env, who.id, id) });
      }

      // POST /api/admin/orders/:id/erase-contact (no body) — 清除聯絡資料
      // (docs/guest-shop.md §5.4, Q15-A: by hand only): the guest's phone and
      // LINE ID become NULL and contact_erased_at is stamped; the name stays
      // (the books). Already erased: 200, nothing written. An admin or system
      // order has no contact (409 no_contact). Before the S2 migration: 500.
      if (route === 'order-erase-contact') {
        if (!await guestOrdersReady(env)) return done(ORDERS_UNAVAILABLE, 500);
        if (order.source !== 'guest') return done({ error: '這筆訂單沒有客人聯絡資料', code: 'no_contact' }, 409);
        if (!order.contact?.erased_at) {
          await env.DB.prepare(
            'UPDATE orders SET contact_phone = NULL, contact_line = NULL, contact_erased_at = ?1, updated_at = ?1 ' +
            'WHERE id = ?2 AND photographer_id = ?3 AND contact_erased_at IS NULL'
          ).bind(now, id, who.id).run();
        }
        return done({ order: await readOrder(env, who.id, id) });
      }

      // POST /api/admin/orders/:id/payment — {paid_amount, paid_method,
      // paid_at?}: the one payment an order has (no deposits table). 0 clears
      // it, method and date too. paid_at defaults to now; a date alone reads
      // as that day. Never more than the total (400 overpaid); a cancelled
      // order can only be cleared (a refund), not paid.
      if (route === 'order-payment') {
        const amount = body.paid_amount;
        if (!Number.isSafeInteger(amount) || amount < 0) return orderBad('invalid_paid_amount');
        let method = null;
        let paidAt = null;
        if (amount > 0) {
          if (!PAID_METHODS.includes(body.paid_method)) return orderBad('invalid_paid_method');
          method = body.paid_method;
          if (body.paid_at === undefined || body.paid_at === null) {
            paidAt = now;
          } else {
            const raw = body.paid_at;
            const ms = typeof raw === 'string' && /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d))?$/.test(raw) ? Date.parse(raw) : NaN;
            if (!Number.isFinite(ms) || ms < PAID_AT_MIN || ms > Date.now() + PAID_AT_AHEAD_MS) return orderBad('invalid_paid_at');
            paidAt = new Date(ms).toISOString();
          }
          if (order.status === 'cancelled') return cancelled();
          if (amount > order.total) return orderBad('overpaid');
        }
        const result = await env.DB.prepare(
          `UPDATE orders SET paid_amount = ?, paid_method = ?, paid_at = ?, ${takeOver}, updated_at = ? WHERE id = ? AND photographer_id = ? AND updated_at = ?`
        ).bind(amount, method, paidAt, now, id, who.id, order.updated_at).run();
        if (!result.meta?.changes) return conflict();
        return done({ order: await readOrder(env, who.id, id) });
      }

      // POST /api/admin/orders/:id/status — {status} along ORDER_ARROWS only
      // (409 bad_transition otherwise); asking for the status it already has
      // is a no-op. confirmed_at keeps its first stamp; an undo from
      // fulfilled clears fulfilled_at.
      const to = body.status;
      if (!ORDER_STATUSES.includes(to)) return orderBad('invalid_status');
      if (to === order.status) return done({ order });
      const badArrow = from => done({ error: `無法從 ${from} 改為 ${to}`, code: 'bad_transition', from, to }, 409);
      if (!ORDER_ARROWS[order.status].includes(to)) return badArrow(order.status);
      const stamp = {
        confirmed: 'confirmed_at = COALESCE(confirmed_at, ?1), fulfilled_at = NULL',
        fulfilled: 'fulfilled_at = ?1',
        cancelled: 'cancelled_at = ?1',
      }[to];
      const result = await env.DB.prepare(
        `UPDATE orders SET status = ?2, ${stamp}, ${takeOver}, updated_at = ?1 WHERE id = ?3 AND photographer_id = ?4 AND status = ?5`
      ).bind(now, to, id, who.id, order.status).run();
      if (!result.meta?.changes) {
        const current = await readOrder(env, who.id, id);
        if (!current) return jsonErr('Not found', 404);
        return badArrow(current.status);
      }
      return done({ order: await readOrder(env, who.id, id) });
    }

    // GET /api/admin/stats — the dashboard's counts, this photographer only.
    // One pass over projects for the counts, one for the months (Taipei
    // month boundaries: the stored timestamps are UTC ISO strings).
    if (url.pathname === '/api/admin/stats') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const { who } = auth;
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
      ).bind(who.id).first();
      const { months, since } = statsMonths(Date.now());
      const { results: monthly } = await env.DB.prepare(
        `SELECT month, SUM(c) AS created, SUM(d) AS delivered FROM (
           SELECT strftime('%Y-%m', created_at, '+8 hours') AS month, 1 AS c, 0 AS d
             FROM projects WHERE photographer_id = ?1 AND created_at >= ?2
           UNION ALL
           SELECT strftime('%Y-%m', delivered_at, '+8 hours'), 0, 1
             FROM projects WHERE photographer_id = ?1 AND delivered_at >= ?2
         ) GROUP BY month`
      ).bind(who.id, since).all();
      const byMonth = new Map(monthly.map(r => [r.month, r]));
      // Revenue is counted when paid, and an order's cost with it
      // (docs/products-orders.md): by paid_at, in the same Taipei months.
      // Cancelled orders count for nothing, paid or not.
      const { results: paidMonthly } = await env.DB.prepare(
        `SELECT strftime('%Y-%m', o.paid_at, '+8 hours') AS month, SUM(o.paid_amount) AS paid, SUM(${ORDER_COST_SQL}) AS cost
           ${ORDER_SCOPE_SQL} AND o.status != 'cancelled' AND o.paid_amount > 0 AND o.paid_at >= ?
          GROUP BY month`
      ).bind(who.id, since).all();
      const paidByMonth = new Map(paidMonthly.map(r => [r.month, r]));
      // requested: guest orders waiting for the photographer's confirmation
      // (archived projects included: the order still waits)
      const owed = await env.DB.prepare(
        `SELECT COALESCE(SUM(${ORDER_OUTSTANDING_SQL}), 0) AS outstanding, COALESCE(SUM(${ORDER_OUTSTANDING_SQL} > 0), 0) AS unpaid,
                COALESCE(SUM(o.source = 'guest' AND o.status = 'requested'), 0) AS requested
           ${ORDER_SCOPE_SQL}`
      ).bind(who.id).first();
      return jsonOk({
        by_phase: { picking: c.picking, submitted: c.submitted, retouching: c.retouching },
        delivered: c.delivered,
        archived: c.archived,
        per_month: months.map(month => ({
          month,
          created: byMonth.get(month)?.created ?? 0,
          delivered: byMonth.get(month)?.delivered ?? 0,
        })),
        revenue: months.map(month => {
          const paid = paidByMonth.get(month)?.paid ?? 0;
          const cost = paidByMonth.get(month)?.cost ?? 0;
          return { month, paid, cost, margin: paid - cost };
        }),
        outstanding: owed.outstanding,
        todo: {
          submitted_not_retouching: c.submitted,
          unnotified_submissions: c.unnotified,
          modified_after_submit: c.modified,
          unpaid_orders: owed.unpaid,
          requested_orders: owed.requested,
        },
      }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET/PUT /api/admin/settings — the studio's name, booking link and
    // default plan. PUT changes only the fields it names (null clears one);
    // anything else in the body is ignored, photographer_id above all.
    if (url.pathname === '/api/admin/settings') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const { who } = auth;
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
        // the create route's bound, so a default can always be used as is
        if (has('default_extra_max')) {
          const v = body.default_extra_max;
          if (v !== null && !isExtraMax(v)) return bad('default_extra_max');
          set.default_extra_max = v;
        }
        // the transfer details a guest sees on a confirmed order (S2)
        if (has('transfer_info')) {
          const v = transferInfoValue(body.transfer_info);
          if (v === undefined) return bad('transfer_info');
          set.transfer_info = v;
        }
        // the photographer's default pick-link message (admin-only)
        if (has('pick_link_message')) {
          const v = pickLinkMessageValue(body.pick_link_message);
          if (v === undefined) return bad('pick_link_message');
          set.pick_link_message = v;
        }
        // ... and the later stages' (admin-only, same rules)
        for (const field of LINK_MESSAGE_FIELDS) {
          if (!has(field)) continue;
          const v = pickLinkMessageValue(body[field]);
          if (v === undefined) return bad(field);
          set[field] = v;
        }
        // column names come from the fixed list above, never from the body
        const cols = [...Object.keys(set), 'updated_at'];
        const all = ['photographer_id', ...cols];
        try {
          await env.DB.prepare(
            `INSERT INTO studio_settings (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
            `ON CONFLICT(photographer_id) DO UPDATE SET ${cols.map(k => `${k} = excluded.${k}`).join(', ')}`
          ).bind(who.id, ...Object.values(set), new Date().toISOString()).run();
        } catch (e) {
          // default_extra_max / transfer_info / pick_link_message /
          // link_message_* before its migration: one statement, so nothing
          // landed; the error names the column
          const msg = String(e?.message || '');
          if (isMissingColumn(e) && LINK_MESSAGE_FIELDS.some(f => f in set && msg.includes(f))) {
            return jsonOk(LINK_MESSAGES_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
          }
          if (isMissingColumn(e) && 'pick_link_message' in set && /pick_link_message/.test(String(e?.message || ''))) {
            return jsonOk(PICK_LINK_MESSAGE_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
          }
          if (isMissingColumn(e) && 'transfer_info' in set && /transfer_info/.test(String(e?.message || ''))) {
            return jsonOk(ORDERS_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
          }
          if (isMissingColumn(e) && 'default_extra_max' in set) return jsonOk(EXTRA_MAX_UNAVAILABLE, 500, ADMIN_ONLY_HEADERS);
          throw e;
        }
      }
      return jsonOk(await readStudioSettings(env, who.id), 200, ADMIN_ONLY_HEADERS);
    }

    // PUT /api/admin/settings/logo — raw bytes, ≤ LOGO_MAX_BYTES, PNG / JPEG
    // / WebP by magic bytes (415 otherwise). Kept in D1, not R2: the bucket's
    // lifecycle rule deletes everything after 180 days.
    // DELETE /api/admin/settings/logo — remove it; the rest stays.
    // GET /api/admin/settings/logo — the caller's own logo (the settings
    // page's preview; fetched with the Authorization header, never cached).
    // Each photographer's logo is his own studio_settings row (keyed by
    // photographer_id): no R2 key at all.
    if (url.pathname === '/api/admin/settings/logo') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const { who } = auth;
      if (request.method !== 'GET' && request.method !== 'PUT' && request.method !== 'DELETE') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('DB not configured', 500);
      if (request.method === 'GET') {
        const row = await readLogo(env, who.id);
        return imageResponse(request, row ? row.logo : null, row ? row.logo_updated_at : null, ADMIN_ONLY_HEADERS);
      }
      const now = new Date().toISOString();
      if (request.method === 'DELETE') {
        await env.DB.prepare(
          'UPDATE studio_settings SET logo = NULL, logo_type = NULL, logo_updated_at = NULL, updated_at = ? WHERE photographer_id = ?'
        ).bind(now, who.id).run();
        return jsonOk({ ok: true, has_logo: false }, 200, ADMIN_ONLY_HEADERS);
      }
      const upload = await imageUpload(request, 'Logo ');
      if (upload.refused) return upload.refused;
      const { bytes, type } = upload;
      await env.DB.prepare(
        'INSERT INTO studio_settings (photographer_id, logo, logo_type, logo_updated_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(photographer_id) DO UPDATE SET logo = excluded.logo, logo_type = excluded.logo_type, ' +
        'logo_updated_at = excluded.logo_updated_at, updated_at = excluded.updated_at'
      ).bind(who.id, bytes.buffer, type, now, now).run();
      return jsonOk({ ok: true, has_logo: true, logo_type: type, logo_updated_at: now, size: bytes.byteLength }, 200, ADMIN_ONLY_HEADERS);
    }

    // GET /api/studio/logo — public, the default photographer's logo only
    // (kept for pages already out there; a guest page reads its link's
    // photographer's through GET /api/pick/logo). Served as the type its bytes
    // are (re-sniffed, so a hand-edited row cannot turn it into something a
    // browser would run), never sniffed by the browser, and under a CSP that
    // lets it run nothing even if opened directly.
    if (url.pathname === '/api/studio/logo') {
      if (request.method !== 'GET') return jsonErr('Method not allowed', 405);
      if (!env.DB) return jsonErr('Not found', 404);
      const row = await readLogo(env, DEFAULT_PHOTOGRAPHER_ID);
      return imageResponse(request, row ? row.logo : null, row ? row.logo_updated_at : null);
    }

    // GET /api/shares/minted — the studio and client-session tokens that are
    // live right now. Neither kind carries a book_id, so the per-album list
    // below cannot show them and until this route nothing could: a photographer
    // could not answer "what is out there holding my bucket open". The
    // caller's own only (batch 3): its studio tokens, and for the default
    // photographer the legacy client sessions too (they have no other owner).
    if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] === 'minted' && !pathParts[3]) {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const owner = shareOwnerColumn(auth.who.id);
      const mine = shareOwnedBy('photographer_id', auth.who.id);
      const cols = 'SELECT token, kind, user_id, folders, created_at, expires_at FROM share_tokens';
      const now = new Date().toISOString();
      // before the owner column: the default's as before, anyone else refused
      const listed = await withoutMissingColumn(
        () => env.DB.prepare(
          `${cols} WHERE kind IN ('studio', 'session') AND ${mine.sql} AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
        ).bind(...mine.args, now).all(),
        () => (owner !== null ? null : env.DB.prepare(
          `${cols} WHERE kind IN ('studio', 'session') AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
        ).bind(now).all()),
      );
      if (!listed) return jsonOk(SHARE_OWNER_UNAVAILABLE, 500);
      return jsonOk(listed.results);
    }

    // POST /api/shares/minted/revoke-all — what a photographer reaches for when
    // they think the password leaked. Rotating PHOTOGRAPHER_TOKEN alone does
    // not reach an already-minted token, and no other route could name one.
    // The two minted kinds are named positively, so the album links sitting in
    // clients' chats — which are the expensive thing to kill by accident — are
    // spared, including every row that predates the kind column. The caller's
    // own only (batch 3), as listed above.
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] === 'minted' && pathParts[3] === 'revoke-all') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const owner = shareOwnerColumn(auth.who.id);
      const mine = shareOwnedBy('photographer_id', auth.who.id);
      const now = new Date().toISOString();
      const result = await withoutMissingColumn(
        () => env.DB.prepare(
          `UPDATE share_tokens SET revoked_at = ? WHERE kind IN ('studio', 'session') AND ${mine.sql} AND revoked_at IS NULL`
        ).bind(now, ...mine.args).run(),
        () => (owner !== null ? null : env.DB.prepare(
          "UPDATE share_tokens SET revoked_at = ? WHERE kind IN ('studio', 'session') AND revoked_at IS NULL"
        ).bind(now).run()),
      );
      if (!result) return jsonOk(SHARE_OWNER_UNAVAILABLE, 500);
      return jsonOk({ ok: true, revoked: result.meta?.changes ?? 0 });
    }

    // POST /api/shares/:token/revoke — kill a link that went to the wrong chat.
    // Only a token that is the caller's (batch 3): a link of a project goes by
    // that project's photographer, whatever its own row says; any other token
    // (a studio one, an album link, a client session) by its photographer_id,
    // NULL or 'default' being the default photographer's (shareOwnedBy).
    // Checked inside the UPDATE itself,
    // so a project handed over mid-request is not revoked either. Anyone
    // else's is a token that does not exist: the same 404, the same statement.
    // Before the owner column: a project's link as above, and a project-less
    // token for the default photographer only (nobody else can have one yet).
    if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'shares' && pathParts[2] && pathParts[3] === 'revoke') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      if (!env.DB) return jsonErr('DB not configured', 500);
      const who = auth.who;
      const owner = shareOwnerColumn(who.id);
      const now = new Date().toISOString();
      const theirProject = 'EXISTS (SELECT 1 FROM projects WHERE id = share_tokens.project_id AND photographer_id = ?)';
      const revokeIf = ownerless => env.DB.prepare(
        'UPDATE share_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL ' +
        `AND (CASE WHEN project_id IS NULL THEN ${ownerless.sql} ELSE ${theirProject} END)`
      ).bind(now, pathParts[2], ...ownerless.args, who.id).run();
      const result = await withoutMissingColumn(
        () => revokeIf(shareOwnedBy('share_tokens.photographer_id', who.id)),
        () => revokeIf({ sql: '? IS NULL', args: [owner] }),
      );
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
      const { project, picker, isOwner, isCollaborator, canEdit, role, membership, memberStatus } = ctxPick;
      const route = pathParts.slice(2).join('/');

      // GET /api/pick/logo?t=<link> — the studio logo the guest page shows:
      // the link's project's photographer's (multi-photographer 2b-3), never
      // the request's and never anyone else's; none of his = 404, the same as
      // nobody's. Any live link (owner, collaborator or viewer), like the
      // studio block in /state. Reads only; private, since the URL carries the link.
      if (route === 'logo') {
        if (request.method !== 'GET') return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: 'GET' });
        const owner = project.photographer_id;
        const row = typeof owner === 'string' && owner ? await readLogo(env, owner) : null;
        return imageResponse(request, row ? row.logo : null, row ? row.logo_updated_at : null,
          { 'Cache-Control': 'private, max-age=300', Vary: 'X-Share-Token' });
      }

      // GET /api/pick/shop — 購買資訊 (docs/guest-shop.md, S1 trimmed): what
      // this link's guest may buy, owner and viewers alike (information
      // only). The link first (401 above), then the method (405), then
      // delivered now (409 not_delivered: picking, undelivered, reopened).
      // The photographer is the project's, never the request's. Reads only.
      if (route === 'shop') {
        if (request.method !== 'GET') return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: 'GET' });
        if (pickReadScope(s).mode !== 'delivered') return jsonOk({ error: '尚未交件', code: 'not_delivered' }, 409, SHARED_LINK_HEADERS);
        const owner = project.photographer_id;
        const products = typeof owner === 'string' && owner ? await readGuestShop(env, owner) : [];
        if (!products) return jsonOk(SHOP_UNAVAILABLE, 500, SHARED_LINK_HEADERS);
        // S2: whether this project takes guest orders (the switch, and the
        // migration). Not a secret, the same for owner and viewers, and not a
        // promise that this caller may order (a viewer never may; the page
        // also needs is_owner and confirmed_at from /state).
        const ordering = guestOrdersEnabled(env, project) && await guestOrdersReady(env) ? GUEST_ORDERING_INFO : null;
        return jsonOk({ products, ordering }, 200, SHARED_LINK_HEADERS);
      }

      // POST /api/pick/interest {product_id} — 「我有興趣」 on the completion
      // page (docs/guest-shop.md, product interest). The link (401 above),
      // the method (405), the seat (403 not_owner), delivered AND confirmed
      // by the client now (409 not_confirmed, before the body), the body
      // (413 / 400), the product in this project's photographer's guest shop
      // (404 not_found), the migration (500 interest_unavailable), then one
      // gated upsert. The photographer is emailed in the background, at most
      // once per INTEREST_EMAIL_INTERVAL_MS per product; a mail that fails
      // never fails the tap nor undoes it. Answers {ok, already} only.
      if (route === 'interest') {
        const out = (data, status = 200) => jsonOk(data, status, SHARED_LINK_HEADERS);
        if (request.method !== 'POST') return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: 'POST' });
        const notOwner = () => out({ error: '只有挑選人可以表示有興趣', code: 'not_owner' }, 403);
        const notConfirmed = () => out({ error: '確認完成後才能表示有興趣', code: 'not_confirmed' }, 409);
        if (!isOwner) return notOwner();
        if (pickReadScope(s).mode !== 'delivered' || !project.client_confirmed_at) return notConfirmed();
        const read = await readJsonCapped(request, INTEREST_BODY_MAX);
        if (read.refused) return read.refused;
        const { body } = read;
        const productId = isPlainObject(body) ? body.product_id : undefined;
        if (typeof productId !== 'string' || !productId || productId.length > INTEREST_PRODUCT_ID_MAX) {
          return out({ error: 'Invalid body', code: 'invalid_body' }, 400);
        }
        // the product as the guest shop shows it now: the project's
        // photographer, never the request's; its name and kind come from here
        const owner = project.photographer_id;
        const products = typeof owner === 'string' && owner ? await readGuestShop(env, owner) : [];
        if (!products) return out(SHOP_UNAVAILABLE, 500);
        const product = products.find(p => p.id === productId);
        if (!product) return out({ error: 'Not found', code: 'not_found' }, 404);
        if (!await interestReady(env)) return out(INTEREST_UNAVAILABLE, 500);
        // One INSERT … ON CONFLICT holds every rule inside the write: the
        // seat, delivered and confirmed now (an undeliver, a reopen, a seat
        // reset or an archive after the checks makes it a no-op), and the cap
        // (a product already there always counts its tap). The email slot is
        // taken in the same statement — last_emailed_at moves to this tap's
        // time only when it was NULL or older than the interval — so of two
        // racing taps one mails.
        const nowMs = Date.now();
        const at = new Date(nowMs).toISOString();
        const cutoff = new Date(nowMs - INTEREST_EMAIL_INTERVAL_MS).toISOString();
        let row;
        try {
          row = await env.DB.prepare(
            `INSERT INTO ${INTEREST_TABLE} (project_id, product_id, product_name, product_kind, first_at, last_at, tap_count, last_emailed_at) ` +
            'SELECT ?1, ?2, ?3, ?4, ?5, ?5, 1, ?5 ' +
            'WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND owner_picker_id = ?6 AND archived_at IS NULL ' +
            "AND phase = 'retouching' AND delivered_at IS NOT NULL AND final_folders IS NOT NULL AND client_confirmed_at IS NOT NULL) " +
            `AND ((SELECT COUNT(*) FROM ${INTEREST_TABLE} WHERE project_id = ?1) < ${INTEREST_PRODUCTS_MAX} ` +
            `OR EXISTS (SELECT 1 FROM ${INTEREST_TABLE} WHERE project_id = ?1 AND product_id = ?2)) ` +
            'ON CONFLICT(project_id, product_id) DO UPDATE SET tap_count = tap_count + 1, last_at = excluded.last_at, ' +
            'product_name = excluded.product_name, product_kind = excluded.product_kind, ' +
            'last_emailed_at = CASE WHEN last_emailed_at IS NULL OR last_emailed_at <= ?7 THEN excluded.last_emailed_at ELSE last_emailed_at END ' +
            // mail: this statement inserted the row, or took the slot (a
            // slot taken by a tap in the same millisecond as the first one
            // has first_at = ?5 and does not count twice)
            'RETURNING tap_count, (tap_count = 1 OR (last_emailed_at = ?5 AND first_at <> ?5)) AS mail'
          ).bind(project.id, product.id, product.name, product.kind, at, picker.id, cutoff).first();
        } catch (e) {
          if (isMissingSchema(e)) return out(INTEREST_UNAVAILABLE, 500);
          throw e;
        }
        if (!row) {
          // re-read to say why, in the order the checks above run
          const now = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(project.id).first();
          if (!now || now.archived_at) return jsonOk({ error: 'Unauthorized' }, 401, SHARED_LINK_HEADERS);
          if (now.owner_picker_id !== picker.id) return notOwner();
          if (now.phase !== 'retouching' || !pickFinals(now) || !now.client_confirmed_at) return notConfirmed();
          return out({ error: `最多可對 ${INTEREST_PRODUCTS_MAX} 項商品表示有興趣`, code: 'interest_cap', max: INTEREST_PRODUCTS_MAX }, 409);
        }
        if (row.mail) {
          const notify = Promise.resolve()
            .then(() => sendInterestNotification(env, project, picker.name, product, row.tap_count))
            .catch(e => console.error('interest notification failed:', e?.message || e));
          if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
        }
        return out({ ok: true, already: row.tap_count > 1 });
      }

      // ─── Guest orders (docs/guest-shop.md, S2) ─────────────────────────
      // POST /api/pick/orders — order from the shop; GET /api/pick/orders —
      // the seat holder's own orders here; POST /api/pick/orders/:id/cancel —
      // cancel one's own requested order. Every answer is no-store. Checks,
      // in order: the link (401, above), the path (404), the method (405),
      // the seat (403 not_owner: the receipt is the seat, Q8-A; a viewer
      // never orders, Q16-A). POST then: the switch (403 ordering_disabled),
      // delivered AND confirmed now (409 not_confirmed, before the body), the
      // body (413 / 400), the migration (500 orders_unavailable), a replay of
      // the same request (200), the shop and the finals (404 / 403 / 400),
      // the guest's total (409 price_changed), then one gated batch holding
      // the caps. GET and cancel look at neither the switch nor the delivery:
      // a guest always sees and can cancel their own requested order.
      if (pathParts[2] === 'orders') {
        const out = (data, status = 200) => jsonOk(data, status, SHARED_LINK_HEADERS);
        const sub = pathParts.slice(3);
        const cancelling = sub.length === 2 && sub[1] === 'cancel';
        if (sub.length && !cancelling) return out({ error: 'Not found', code: 'not_found' }, 404);
        const allow = cancelling ? ['POST'] : ['GET', 'POST'];
        if (!allow.includes(request.method)) return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: allow.join(', ') });
        const notOwner = () => out({ error: '只有挑選人可以訂購', code: 'not_owner' }, 403);
        if (!isOwner) return notOwner();
        const refuse = (status, code, extra = {}) => out({ error: GUEST_ORDER_ERRORS[code] || code.replace(/_/g, ' '), code, ...extra }, status);
        const unavailable = () => out(ORDERS_UNAVAILABLE, 500);
        const background = work => {
          const p = Promise.resolve().then(work).catch(e => console.error('order notification failed:', e?.message || e));
          return ctx?.waitUntil ? ctx.waitUntil(p) : p;
        };

        if (cancelling) {
          const orderId = sub[0];
          const notFound = () => out({ error: 'Not found', code: 'not_found' }, 404);
          if (!ORDER_ID.test(orderId)) return notFound();
          if (!await guestOrdersReady(env)) return unavailable();
          const view = async () => (await guestOrdersFor(env, project, picker.id, orderId))[0] || null;
          const badTransition = from => out({ error: `無法從 ${from} 取消`, code: 'bad_transition', from, to: 'cancelled' }, 409);
          const before = await view();
          if (!before) return notFound();
          if (before.status === 'cancelled') return out({ order: before });
          if (before.status !== 'requested') return badTransition(before.status);
          // conditional on requested: an admin confirm landing first wins
          const at = new Date().toISOString();
          const result = await env.DB.prepare(
            "UPDATE orders SET status = 'cancelled', cancelled_at = ?1, updated_at = ?1 " +
            "WHERE id = ?2 AND project_id = ?3 AND picker_id = ?4 AND source = 'guest' AND status = 'requested'"
          ).bind(at, orderId, project.id, picker.id).run();
          const after = await view();
          if (!after) return notFound();
          if (!result.meta?.changes) return after.status === 'cancelled' ? out({ order: after }) : badTransition(after.status);
          await background(() => sendOrderNotification(env, project, after, true));
          return out({ order: after });
        }

        if (request.method === 'GET') {
          if (!await guestOrdersReady(env)) return unavailable();
          return out({ orders: await guestOrdersFor(env, project, picker.id) });
        }

        // POST /api/pick/orders
        if (!guestOrdersEnabled(env, project)) return out({ error: '目前尚未開放線上訂購', code: 'ordering_disabled' }, 403);
        const scope = pickReadScope(s);
        const notConfirmed = () => out({ error: '確認完成後才能訂購', code: 'not_confirmed' }, 409);
        if (scope.mode !== 'delivered' || !project.client_confirmed_at) return notConfirmed();
        const read = await readJsonCapped(request, GUEST_ORDER_BODY_MAX);
        if (read.refused) {
          // the 413 / Invalid JSON answer, no-store like every other here
          for (const [k, v] of Object.entries(SHARED_LINK_HEADERS)) read.refused.headers.set(k, v);
          return read.refused;
        }
        const parsed = guestOrderBody(read.body);
        if (parsed.bad) return refuse(400, parsed.bad, parsed.max ? { max: parsed.max } : {});
        const want = parsed.order;
        if (!await guestOrdersReady(env)) return unavailable();
        // the same submit again (a double tap, a retry after a lost answer):
        // the order that landed, whatever the body says now
        const replayed = async () => {
          const row = await env.DB.prepare(
            "SELECT id FROM orders WHERE project_id = ? AND picker_id = ? AND source = 'guest' AND request_id = ?"
          ).bind(project.id, picker.id, want.requestId).first();
          const [order] = row ? await guestOrdersFor(env, project, picker.id, row.id) : [];
          return order ? out({ order, replay: true }) : null;
        };
        const early = await replayed();
        if (early) return early;
        const priced = await guestOrderLines(env, project, scope.finals, want.lines);
        if (priced.fail) {
          const [status, code] = priced.fail;
          return code === 'shop_unavailable' ? out(SHOP_UNAVAILABLE, 500) : refuse(status, code);
        }
        const { lines } = priced;
        const total = linesSubtotal(lines);
        if (total !== want.expected) {
          return refuse(409, 'price_changed', {
            error: '價格已更新，請確認新的總額',
            quote: { lines: lines.map(l => ({ option_id: l.option_id, qty: l.qty, unit_price: l.unit_price })), subtotal: total, total },
          });
        }
        // One batch (a transaction). The order row lands only while every
        // rule still holds against the rows as they are inside the write:
        // the link not revoked, the seat, not archived, the delivery this
        // request checked the photos against (delivered_at and final_folders
        // as read: a 更換精修 / undeliver / reopen in between makes it a
        // no-op), confirmed, this request not already there, under both
        // caps. The lines land only with it.
        const orderId = crypto.randomUUID();
        const at = new Date().toISOString();
        let landed = false;
        try {
          const results = await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, guest_note, request_id, ' +
              'contact_name, contact_phone, contact_line, delivery_method, consent_version, created_at, updated_at) ' +
              "SELECT ?1, p.photographer_id, p.id, 'guest', 'requested', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 FROM projects p " +
              "WHERE p.id = ?11 AND p.owner_picker_id = ?2 AND p.archived_at IS NULL AND p.phase = 'retouching' " +
              'AND p.delivered_at = ?12 AND p.final_folders = ?13 AND p.client_confirmed_at IS NOT NULL ' +
              "AND EXISTS (SELECT 1 FROM share_tokens t WHERE t.token = ?14 AND t.kind = 'pick' AND t.project_id = p.id AND t.revoked_at IS NULL) " +
              'AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.project_id = p.id AND x.request_id = ?4) ' +
              `AND (SELECT COUNT(*) FROM orders x WHERE x.project_id = p.id AND x.source = 'guest' AND x.status = 'requested') < ${GUEST_OPEN_ORDERS_MAX} ` +
              `AND (SELECT COUNT(*) FROM orders x WHERE x.project_id = p.id AND x.source = 'guest') < ${GUEST_ORDERS_MAX}`
            ).bind(orderId, picker.id, want.note, want.requestId, want.contact.name, want.contact.phone, want.contact.line,
              GUEST_DELIVERY_METHODS[0], ORDER_CONSENT_VERSION, at, project.id, project.delivered_at, project.final_folders, s.token),
            ...lines.map(l => orderItemInsert(env, orderId, l, 'EXISTS (SELECT 1 FROM orders WHERE id = ?)', [orderId])),
          ]);
          landed = !!results[0].meta?.changes;
        } catch (e) {
          if (isMissingSchema(e)) return unavailable();
          // the unique index caught a racing twin of this request
          if (!/UNIQUE constraint failed/i.test(String(e?.message || ''))) throw e;
        }
        if (!landed) {
          const replay = await replayed();
          if (replay) return replay;
          // re-read to say why, in the order the checks above run
          const now = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(project.id).first();
          const link = await env.DB.prepare('SELECT revoked_at FROM share_tokens WHERE token = ?').bind(s.token).first();
          if (!now || now.archived_at || !link || link.revoked_at) return jsonOk({ error: 'Unauthorized' }, 401, SHARED_LINK_HEADERS);
          if (now.owner_picker_id !== picker.id) return notOwner();
          if (now.phase !== 'retouching' || !pickFinals(now) || !now.client_confirmed_at) return notConfirmed();
          if (now.delivered_at !== project.delivered_at || now.final_folders !== project.final_folders) {
            return out({ error: '交件內容剛更新，請重新整理', code: 'delivery_changed' }, 409);
          }
          const counts = await env.DB.prepare(
            "SELECT COALESCE(SUM(status = 'requested'), 0) AS open, COUNT(*) AS total FROM orders WHERE project_id = ? AND source = 'guest'"
          ).bind(project.id).first();
          if ((counts?.open ?? 0) >= GUEST_OPEN_ORDERS_MAX) {
            return out({ error: `待確認的訂單已有 ${GUEST_OPEN_ORDERS_MAX} 筆，請等攝影師確認`, code: 'too_many_open_orders', max: GUEST_OPEN_ORDERS_MAX }, 409);
          }
          if ((counts?.total ?? 0) >= GUEST_ORDERS_MAX) {
            return out({ error: `線上訂單已達上限（${GUEST_ORDERS_MAX} 筆），請直接聯絡攝影師`, code: 'order_cap', max: GUEST_ORDERS_MAX }, 409);
          }
          // the request id is taken in this project by another seat holder
          return out({ error: '訂單資料不正確，請重新整理', code: 'duplicate_request' }, 409);
        }
        const [order] = await guestOrdersFor(env, project, picker.id, orderId);
        await background(() => sendOrderNotification(env, project, order));
        return out({ order }, 201);
      }

      // ─── Co-picking (docs/co-picking.md) ───────────────────────────────
      // POST /invites (owner), POST /join (anyone with the link and a code),
      // GET /collaborators (owner), PATCH | DELETE /collaborators/:id
      // (owner), POST /collaborators/:id/decision (owner), POST /renewal (an
      // expired collaborator). Checks, in order: the link (401, above), the
      // path (404), the method (405), the migration (500
      // co_picking_unavailable), who is asking (403), then the body. Every
      // write is one conditional statement (or one batch) that re-checks the
      // seat, the archive and the slot count itself. Every answer no-store.
      if (route === 'invites' || route === 'join' || route === 'renewal' || pathParts[2] === 'collaborators') {
        const out = (data, status = 200) => jsonOk(data, status, SHARED_LINK_HEADERS);
        const sub = pathParts.slice(3);
        const notFound = () => out({ error: 'Not found', code: 'not_found' }, 404);
        let allow;
        if (pathParts[2] !== 'collaborators') allow = ['POST'];
        else if (sub.length === 0) allow = ['GET'];
        else if (sub.length === 1) allow = ['PATCH', 'DELETE'];
        else if (sub.length === 2 && sub[1] === 'decision') allow = ['POST'];
        else return notFound();
        if (!allow.includes(request.method)) return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: allow.join(', ') });
        if (!pickInviteSecretOk(env) || !await coPickingReady(env)) return out(CO_PICKING_UNAVAILABLE, 500);
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const notOwner = () => out({ error: '只有挑選人可以管理協作者', code: 'not_owner' }, 403);
        const invalidWindow = () => out({ error: '期限只能是 1 天、7 天或到專案結束', code: 'invalid_window' }, 400);
        const limitReached = () => out({ error: `協作者最多 ${PICK_MAX_COLLABORATORS} 位（含尚未使用的邀請碼）`, code: 'collaborator_limit', max: PICK_MAX_COLLABORATORS }, 409);
        const periodEnd = days => (days == null ? null : new Date(nowMs + days * PICK_DAY_MS).toISOString());
        const projectNow = () => env.DB.prepare('SELECT phase, owner_picker_id, archived_at FROM projects WHERE id = ?').bind(project.id).first();
        const dead = () => jsonOk({ error: 'Unauthorized' }, 401, SHARED_LINK_HEADERS);

        // POST /api/pick/invites {window_days: 1 | 7 | null} → {code, expires_at, window_days}
        if (route === 'invites') {
          if (!isOwner) return notOwner();
          if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
          const read = await readJsonCapped(request, PICK_SUBMIT_BODY_MAX);
          if (read.refused) return read.refused;
          const windowDays = pickWindowDays(read.body);
          if (windowDays === undefined) return invalidWindow();
          const code = pickInviteCode();
          const expiresAt = new Date(nowMs + PICK_INVITE_MS).toISOString();
          // the seat, the phase, the archive and the slots, inside the write:
          // of parallel invites only as many as there are slots land
          const made = await env.DB.prepare(
            'INSERT INTO pick_invites (id, project_id, code_hash, invited_by, window_days, created_at, expires_at) ' +
            'SELECT ?1, p.id, ?2, ?3, ?4, ?5, ?6 FROM projects p ' +
            `WHERE p.id = ?7 AND p.owner_picker_id = ?3 AND p.archived_at IS NULL AND p.phase IN ${PICK_OPEN_SQL} ` +
            `AND ${collaboratorSlotsSql('p', '?5')} < ${PICK_MAX_COLLABORATORS}`
          ).bind(crypto.randomUUID(), await pickInviteHash(env, project.id, code), picker.id, windowDays, nowIso, expiresAt, project.id).run();
          if (!made.meta?.changes) {
            const now = await projectNow();
            if (!now || now.archived_at) return dead();
            if (now.owner_picker_id !== picker.id) return notOwner();
            if (!PICK_OPEN_PHASES.includes(now.phase)) return pickRetouching();
            return limitReached();
          }
          // the only time the code ever leaves the Worker
          return out({ code, expires_at: expiresAt, window_days: windowDays });
        }

        // POST /api/pick/join {code, name} → {picker_key, picker_id, name, role, expires_at}
        if (route === 'join') {
          if (!project.owner_picker_id) return out({ error: '這個連結還沒有挑選人，無法加入', code: 'owner_missing' }, 409);
          if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
          const read = await readJsonCapped(request, PICK_SUBMIT_BODY_MAX);
          if (read.refused) return read.refused;
          const { body } = read;
          if (!isPlainObject(body)) return out({ error: 'Invalid body', code: 'invalid_body' }, 400);
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name || overChars(name, PICK_NAME_MAX)) return out({ error: `請輸入 1–${PICK_NAME_MAX} 字的名字`, code: 'invalid_name' }, 400);
          // The guess limit, before the code is looked at: this attempt
          // reserves one failure row for the project and one for the network
          // in one conditional insert, so parallel guesses cannot pass the
          // cap; a join that lands deletes them again in its own batch. What
          // stays are failures. A refusal never says whether a code exists.
          const network = `n:${clientNetwork(request)}`;
          // failures older than a day, every project's (deleted projects too)
          await env.DB.prepare('DELETE FROM pick_join_failures WHERE created_at < ?')
            .bind(new Date(nowMs - PICK_DAY_MS).toISOString()).run();
          const reserved = await env.DB.prepare(
            "INSERT INTO pick_join_failures (project_id, bucket, created_at) SELECT ?1, b, ?2 FROM (SELECT 'p' AS b UNION ALL SELECT ?3) " +
            "WHERE (SELECT COUNT(*) FROM pick_join_failures WHERE project_id = ?1 AND bucket = 'p' AND created_at > ?4) < ?5 " +
            'AND (SELECT COUNT(*) FROM pick_join_failures WHERE project_id = ?1 AND bucket = ?3 AND created_at > ?4) < ?6'
          ).bind(project.id, nowIso, network, new Date(nowMs - PICK_JOIN_WINDOW_MS).toISOString(), PICK_JOIN_FAILURES_PROJECT, PICK_JOIN_FAILURES_NETWORK).run();
          if (!reserved.meta?.changes) return out({ error: '嘗試次數太多，請 15 分鐘後再試', code: 'too_many_attempts' }, 429);
          // wrong, used and expired codes: one answer
          const invalid = () => out({ error: '邀請碼不正確或已失效', code: 'invalid_code' }, 400);
          if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) return invalid();
          const found = await env.DB.prepare(
            'SELECT i.id, i.window_days FROM pick_invites i JOIN projects p ON p.id = i.project_id ' +
            'WHERE i.project_id = ? AND i.code_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND i.invited_by = p.owner_picker_id ' +
            'ORDER BY i.created_at LIMIT 1'
          ).bind(project.id, await pickInviteHash(env, project.id, body.code), nowIso).first();
          if (!found) return invalid();
          const pickerId = crypto.randomUUID();
          // returned once and never stored: the row keeps its hash
          const key = newShareToken();
          const expiresAt = periodEnd(found.window_days);
          // One batch. The first statement spends the invite — unspent,
          // unexpired, made by the project's owner now, the project open and
          // not archived — and only its winner's picker row, membership and
          // the release of its reserved failure rows land after it.
          const spentBy = 'EXISTS (SELECT 1 FROM pick_invites WHERE id = ?1 AND used_by = ?2)';
          const [spent] = await env.DB.batch([
            env.DB.prepare(
              'UPDATE pick_invites SET used_at = ?3, used_by = ?2 WHERE id = ?1 AND project_id = ?4 AND used_at IS NULL AND expires_at > ?3 ' +
              `AND invited_by = (SELECT owner_picker_id FROM projects WHERE id = ?4 AND archived_at IS NULL AND phase IN ${PICK_OPEN_SQL})`
            ).bind(found.id, pickerId, nowIso, project.id),
            env.DB.prepare(
              `INSERT INTO pickers (id, project_id, key_hash, name, created_at) SELECT ?2, ?3, ?4, ?5, ?6 WHERE ${spentBy}`
            ).bind(found.id, pickerId, project.id, await sha256Hex(key), name, nowIso),
            env.DB.prepare(
              'INSERT INTO project_collaborators (picker_id, project_id, invited_by, joined_at, expires_at) ' +
              'SELECT ?2, i.project_id, i.invited_by, ?3, ?4 FROM pick_invites i WHERE i.id = ?1 AND i.used_by = ?2'
            ).bind(found.id, pickerId, nowIso, expiresAt),
            // this attempt's two reserved rows (rows of one bucket and time
            // are identical, so any one of them is this attempt's)
            env.DB.prepare(
              'DELETE FROM pick_join_failures WHERE rowid IN (SELECT MIN(rowid) FROM pick_join_failures ' +
              "WHERE project_id = ?3 AND created_at = ?4 AND bucket IN ('p', ?5) GROUP BY bucket) AND " + spentBy
            ).bind(found.id, pickerId, project.id, nowIso, network),
          ]);
          if (!spent.meta?.changes) {
            const now = await projectNow();
            if (!now || now.archived_at) return dead();
            if (!PICK_OPEN_PHASES.includes(now.phase)) return pickRetouching();
            // spent by someone faster, expired, or the seat moved
            return invalid();
          }
          return out({ picker_key: key, picker_id: pickerId, name, role: 'collaborator', expires_at: expiresAt });
        }

        // POST /api/pick/renewal — an expired collaborator asks the owner to
        // continue. Once: a repeat keeps the first time and answers 200.
        if (route === 'renewal') {
          const notAllowed = () => out({ error: '目前不能要求續期', code: 'renewal_not_allowed' }, 403);
          if (!picker || memberStatus !== 'expired') return notAllowed();
          // a pending request stays as it is; a decline older than the
          // cooldown is replaced; one inside it refuses (inside the write)
          const declined = `renewal_requested_at LIKE '${RENEWAL_DECLINED}%'`;
          const declinedAt = `substr(renewal_requested_at, ${RENEWAL_DECLINED.length + 1})`;
          const asked = await env.DB.prepare(
            `UPDATE project_collaborators SET renewal_requested_at = CASE WHEN renewal_requested_at IS NULL OR ${declined} THEN ?1 ELSE renewal_requested_at END ` +
            'WHERE picker_id = ?2 AND project_id = ?3 AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1 ' +
            `AND NOT COALESCE(${declined} AND ${declinedAt} > ?4, 0) ` +
            'AND invited_by = (SELECT owner_picker_id FROM projects WHERE id = ?3 AND archived_at IS NULL)'
          ).bind(nowIso, picker.id, project.id, new Date(nowMs - PICK_RENEWAL_COOLDOWN_MS).toISOString()).run();
          const row = await env.DB.prepare('SELECT * FROM project_collaborators WHERE picker_id = ? AND project_id = ?').bind(picker.id, project.id).first();
          if (!asked.meta?.changes) {
            const now = await projectNow();
            if (!now || now.archived_at) return dead();
            // the cooldown only for someone still expired (not removed, the
            // seat not reset) as the rows stand now
            const until = renewalDeclinedUntil(row?.renewal_requested_at, nowMs);
            if (until && collaboratorStatus(row, now.owner_picker_id, nowIso) === 'expired') {
              return out({ error: '主人剛拒絕續期，請稍後再試', code: 'renewal_declined', until }, 409);
            }
            return notAllowed();
          }
          return out({ ok: true, renewal_requested_at: renewalPending(row?.renewal_requested_at) });
        }

        // the rest: the owner's list and their changes to one person
        if (!isOwner) return notOwner();

        // GET /api/pick/collaborators
        if (sub.length === 0) {
          const people = (await collaboratorsFor(env, project, true)) || [];
          const inv = await env.DB.prepare(
            'SELECT COUNT(*) AS pending, MIN(expires_at) AS soonest FROM pick_invites WHERE project_id = ? AND invited_by = ? AND used_at IS NULL AND expires_at > ?'
          ).bind(project.id, picker.id, nowIso).first();
          return out({
            collaborators: people,
            invites: { pending: inv?.pending ?? 0, soonest_expires_at: inv?.soonest ?? null },
            pending_renewals: people.filter(c => c.status === 'expired' && c.renewal_requested_at).length,
            max: PICK_MAX_COLLABORATORS,
          });
        }

        const targetId = sub[0];
        const deciding = sub.length === 2;
        let body = null;
        if (request.method !== 'DELETE') {
          const read = await readJsonCapped(request, PICK_SUBMIT_BODY_MAX);
          if (read.refused) return read.refused;
          body = read.body;
        }
        // which change, as SQL over ?1 target, ?2 project, ?3 owner, ?4 now
        // (?5 the new end when there is one)
        let set;
        let where = 'revoked_at IS NULL';
        let slots = false;
        let end = null;
        let noRequest = false;
        if (request.method === 'DELETE') {
          set = 'revoked_at = COALESCE(revoked_at, ?4), renewal_requested_at = NULL';
          where = '1';
        } else if (!deciding) {
          const windowDays = pickWindowDays(body);
          if (windowDays === undefined) return invalidWindow();
          end = periodEnd(windowDays);
          set = 'expires_at = ?5, renewal_requested_at = NULL';
          slots = true;
        } else {
          if (!isPlainObject(body) || typeof body.approve !== 'boolean') return out({ error: 'Invalid body', code: 'invalid_body' }, 400);
          noRequest = true;
          where += ` AND ${RENEWAL_PENDING_SQL}`;
          if (body.approve) {
            const windowDays = pickWindowDays(body);
            if (windowDays === undefined) return invalidWindow();
            end = periodEnd(windowDays);
            set = 'expires_at = ?5, renewal_requested_at = NULL';
            slots = true;
          } else {
            // the marker starts the cooldown (POST /renewal)
            set = `renewal_requested_at = '${RENEWAL_DECLINED}' || ?4`;
          }
        }
        // a statement binds exactly the parameters it names (D1 refuses extra ones)
        const usesNow = /\?4/.test(set) || slots;
        const args = [targetId, project.id, picker.id, ...(usesNow ? [nowIso] : []), ...(slots ? [end] : [])];
        const changed = await env.DB.prepare(
          `UPDATE project_collaborators SET ${set} WHERE picker_id = ?1 AND project_id = ?2 AND invited_by = ?3 AND ${where} ` +
          'AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ?2 AND p.owner_picker_id = ?3 AND p.archived_at IS NULL' +
          `${slots ? ` AND ${collaboratorSlotsSql('p', '?4', '?1')} < ${PICK_MAX_COLLABORATORS}` : ''})`
        ).bind(...args).run();
        const current = () => env.DB.prepare('SELECT * FROM project_collaborators WHERE picker_id = ? AND project_id = ? AND invited_by = ?')
          .bind(targetId, project.id, picker.id).first();
        if (!changed.meta?.changes) {
          // re-read to say why, in the order the statement checks
          const now = await projectNow();
          if (!now || now.archived_at) return dead();
          if (now.owner_picker_id !== picker.id) return notOwner();
          const row = await current();
          if (!row) return notFound();
          if (row.revoked_at) return out({ error: '這位協作者已被移除', code: 'collaborator_removed' }, 409);
          if (noRequest && !renewalPending(row.renewal_requested_at)) return out({ error: '沒有待處理的續期要求', code: 'no_renewal_request' }, 409);
          return limitReached();
        }
        const row = await current();
        const name = (await env.DB.prepare('SELECT name FROM pickers WHERE id = ?').bind(targetId).first())?.name;
        const collaborator = collaboratorView({ ...row, name }, picker.id, new Date().toISOString());
        return out(request.method === 'DELETE' ? { ok: true, collaborator } : { collaborator });
      }

      // GET /api/pick/state — what anyone holding the link may see
      if (request.method === 'GET' && route === 'state') {
        await touchShareToken(s, request, env);
        // notes and retouch pins are the owner's own words to the
        // photographer: a viewer sees what was picked and how it was rated,
        // never the note or the pins. The owner's `marks` is the parsed array
        // or null (also on a database without the column yet).
        // An active collaborator picks with the owner, so reads the same
        // (docs/co-picking.md): notes, pins and who last wrote each row
        // (`by`); a viewer — an expired or removed collaborator included —
        // gets no note, no pin and no name.
        const seesNotes = isOwner || isCollaborator;
        const selected = cols => env.DB.prepare(
          `SELECT photo_key, rating${cols} FROM selections WHERE project_id = ? ORDER BY photo_key`
        ).bind(project.id).all();
        const { results: selections } = seesNotes
          ? await withoutMissingColumn(() => selected(', note, updated_by, marks'), () => selected(', note, updated_by'))
          : await selected('');
        if (seesNotes) {
          const author = await pickAuthors(env, project, true);
          for (const r of selections) {
            r.marks = parseMarks(r.marks);
            r.by = author(r.updated_by);
            delete r.updated_by;
          }
        }
        if (isCollaborator) {
          // what the owner's list shows as last seen (at most once a minute)
          const at = new Date();
          await env.DB.prepare(
            'UPDATE project_collaborators SET last_seen_at = ? WHERE picker_id = ? AND project_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)'
          ).bind(at.toISOString(), picker.id, project.id, new Date(at.getTime() - 60000).toISOString()).run();
        }
        // the owner learns when the project was last submitted and whether they
        // changed anything since; a viewer only which phase it is in
        const last = isOwner ? await env.DB.prepare(
          'SELECT created_at FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        ).bind(project.id).first() : null;
        // which page to show: 'picking' (the proofs) or 'delivered' (the
        // gallery of finals). `folders` is the proofs this link can read now
        // ([] once delivered unless the switch is on), `final_folders` the
        // finals ([] until delivered); the page lists each through ?list=.
        const scope = pickReadScope(s);
        // client confirmation (docs/delivery.md): only once delivered. Owner
        // and viewers alike see when it was confirmed (never who) and whether
        // changes are being asked for; the latest open 要求修改's text is the
        // owner's own words (body, skin…), so like notes and pins only the
        // seat holder reads it back (never the list, never another's)
        const delivered = scope.mode === 'delivered';
        const revision = delivered ? await openRevision(env, project.id) : null;
        // revision pins (docs/revision-pins.md §4.1): the seat holder's own
        // drafts and how many photos the open round has — only while
        // delivered and only to the seat holder (a viewer has neither key,
        // as with notes and pins). revision_drafts null = the migration has
        // not run (the page offers no pins then); [] once confirmed.
        const pinsState = {};
        if (delivered && isOwner) {
          pinsState.revision_drafts = null;
          pinsState.revision_open_photos = null;
          try {
            const { results: drafts } = await env.DB.prepare(
              'SELECT photo_key, marks FROM revision_pins WHERE project_id = ? AND delivery_at = ? AND delivery_finals = ? ORDER BY photo_key'
            ).bind(project.id, project.delivered_at, project.final_folders).all();
            const openRound = await env.DB.prepare(
              'SELECT marks FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL AND marks IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1'
            ).bind(project.id).first();
            // re-checked on the way out: in the finals, pins that parse
            pinsState.revision_drafts = project.client_confirmed_at ? [] : drafts
              .map(d => ({ photo_key: d.photo_key, marks: parseMarks(d.marks) }))
              .filter(d => d.marks && pickKeyAllowed({ folders: scope.finals }, d.photo_key));
            if (openRound) pinsState.revision_open_photos = Object.keys(parseMarksSnapshot(openRound.marks) || {}).length;
          } catch (e) {
            if (!isMissingSchema(e)) throw e;
            pinsState.revision_drafts = null;
            pinsState.revision_open_photos = null;
          }
        }
        return jsonOk({
          // extra_max / max_picks: the plan's cap as the submit enforces it
          // (null = none, also on a database without the column yet)
          project: {
            id: project.id, title: project.title, pick_limit: project.pick_limit, extra_price: project.extra_price,
            extra_max: project.extra_max ?? null,
            max_picks: project.pick_limit != null && project.extra_max != null ? project.pick_limit + project.extra_max : null,
          },
          mode: scope.mode,
          folders: scope.proofs,
          final_folders: scope.finals,
          allow_proof_download: scope.proofOriginals,
          delivered_at: scope.mode === 'delivered' ? project.delivered_at : null,
          confirmed_at: delivered ? project.client_confirmed_at ?? null : null,
          // the shoot day, for the completion page only: delivered and
          // confirmed, owner and viewers alike; null before (and before the
          // shoot-date migration)
          shoot_date: delivered && project.client_confirmed_at ? project.shoot_date ?? null : null,
          revision_open: !!revision,
          // the fixed text of a round sent without a note is not the guest's
          revision_message: revision && isOwner && revision.message_auto !== 1 ? revision.message : null,
          ...pinsState,
          owner: await pickOwnerName(env, project.id),
          // is_owner stays "the seat": may submit, invite, confirm, order.
          // can_edit: may heart / note / pin (the owner or an active
          // collaborator). my_status: this key's membership ('active' |
          // 'expired' | 'removed'), null for the owner and plain viewers.
          is_owner: isOwner,
          role,
          can_edit: canEdit,
          my_expires_at: isCollaborator ? membership.expires_at ?? null : null,
          my_status: memberStatus,
          can_request_renewal: memberStatus === 'expired' && !renewalDeclinedUntil(membership.renewal_requested_at),
          renewal_requested: memberStatus === 'expired' && !!renewalPending(membership.renewal_requested_at),
          renewal_declined_until: memberStatus === 'expired' ? renewalDeclinedUntil(membership.renewal_requested_at) : null,
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
        if (!name || overChars(name, PICK_NAME_MAX)) return jsonErr(`請輸入 1–${PICK_NAME_MAX} 字的名字`);
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
        // the owner, or an active collaborator (docs/co-picking.md), who
        // changes only new rows and rows they last wrote
        if (!canEdit) {
          // a collaborator learns why: the period ran out, or the owner ended it
          if (memberStatus === 'expired') return jsonOk({ error: '協作期限已到', code: 'collaborator_expired' }, 403);
          if (memberStatus === 'removed') return jsonOk({ error: '你已不是協作者', code: 'collaborator_removed' }, 403);
          return jsonErr('只有挑選人可以修改', 403);
        }
        if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
        const read = await readJsonCapped(request, PICK_BODY_MAX);
        if (read.refused) return read.refused;
        const { body } = read;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonErr('Invalid body');
        const upsert = body.upsert ?? [];
        const remove = body.delete ?? [];
        if (!Array.isArray(upsert) || !Array.isArray(remove)) return jsonErr('upsert and delete must be arrays');
        if (upsert.length + remove.length > PICK_KEYS_MAX) return jsonErr(`一次最多 ${PICK_KEYS_MAX} 張`);
        // every item is checked before anything is written, so a refused save
        // leaves nothing half-applied
        const byKey = new Map();
        let carriesMarks = false;
        for (const item of upsert) {
          if (!item || typeof item !== 'object' || typeof item.photo_key !== 'string') return jsonErr('Invalid item');
          const rating = item.rating === undefined ? 0 : item.rating;
          if (!Number.isInteger(rating) || rating < 0 || rating > PICK_RATING_MAX) return jsonErr('Invalid rating');
          const note = item.note === undefined ? '' : item.note;
          if (typeof note !== 'string' || overChars(note, PICK_NOTE_MAX)) return jsonErr(`備註最多 ${PICK_NOTE_MAX} 字`);
          // retouch pins: validated whenever sent, even on a rating 0 item,
          // where they are then ignored
          const marks = item.marks === undefined ? undefined : pickMarks(item.marks);
          if (marks === null) return pickMarksInvalid();
          if (!pickKeyValid(item.photo_key)) return pickKeyInvalid();
          if (!pickKeyAllowed(s, item.photo_key)) return jsonErr('照片不在開放資料夾內', 403);
          // What the save does to the stored pins: `s` = 1 means write `m`
          // (the canonical JSON, or null = none). A pin only makes sense on a
          // ♥ photo, so rating 0 always clears them, whatever the item says.
          // An item with no `marks` on a ♥ photo leaves them alone: a pick.js
          // from before pins, still cached, must not wipe them.
          const entry = { k: item.photo_key, r: rating, n: note };
          // `c`: how many pins that leaves on the photo, for the pins cap
          if (rating === 0) Object.assign(entry, { s: 1, m: null, c: 0 });
          else if (marks) Object.assign(entry, { s: 1, m: marks.length ? JSON.stringify(marks) : null, c: marks.length });
          // a key named twice is written once, as its last mention
          byKey.delete(item.photo_key);
          byKey.set(item.photo_key, entry);
          if (marks) carriesMarks = true;
        }
        // Rating 0 with an empty note is a delete, not a row: kept, it
        // would only use up one of PICK_MAX_ROWS. Judged on a key's last
        // mention; with a note the row stays (the note is the guest's).
        const items = [];
        for (const entry of byKey.values()) {
          if (entry.r === 0 && entry.n === '') remove.push(entry.k);
          else items.push(entry);
        }
        for (const k of remove) {
          if (typeof k !== 'string') return jsonErr('Invalid item');
          if (!pickKeyValid(k)) return pickKeyInvalid();
          if (!pickKeyAllowed(s, k)) return jsonErr('照片不在開放資料夾內', 403);
        }
        // An item on a row someone else last wrote. A collaborator's: refused for that item (`not_yours`) when it would
        // change the rating, the note or the pins — a delete always would — and dropped silently when it would not
        // (re-sending what is there is a no-op, and must not make the row theirs). The owner's: dropped silently when it
        // changes nothing, for the same reason (the lightbox used to re-save every photo the owner flipped past, which
        // took a collaborator's ♥ for the owner); any real change or delete by the owner still goes through. The rest
        // of the batch goes on. This read only decides what to send and what to report: every statement below
        // re-checks the author itself, so a write by the owner landing in between is never overwritten (and is
        // reported after).
        const rejected = isCollaborator ? new Set() : null;
        if (items.length || remove.length) {
          const keys = [...new Set([...items.map(i => i.k), ...remove])];
          const read = cols => env.DB.prepare(
            `SELECT photo_key, rating, note, updated_by${cols} FROM selections WHERE project_id = ? AND photo_key IN (SELECT value FROM json_each(?))`
          ).bind(project.id, JSON.stringify(keys)).all();
          // the pins column is only named when pins are in play (an item that carries them, or a collaborator's save):
          // a save without them must work before the retouch-pins migration has run
          const { results: current } = isCollaborator || items.some(i => i.s === 1)
            ? await withoutMissingColumn(() => read(', marks'), () => read(''))
            : await read('');
          const theirs = new Map(current.filter(r => r.updated_by !== picker.id).map(r => [r.photo_key, r]));
          const kept = items.filter(i => {
            const row = theirs.get(i.k);
            if (!row) return true;
            const pins = parseMarks(row.marks);
            const same = row.rating === i.r && row.note === i.n && (i.s !== 1 || (pins ? JSON.stringify(pins) : null) === i.m);
            if (!same && rejected) rejected.add(i.k);
            return !same && !rejected;       // identical: dropped for both; different: refused for a collaborator, the owner's to change
          });
          items.splice(0, items.length, ...kept);
          const keptRemove = remove.filter(k => {
            if (!theirs.has(k)) return true;
            if (rejected) rejected.add(k);
            return !rejected;                // a delete is always a change: refused for a collaborator, the owner's to do
          });
          remove.splice(0, remove.length, ...keptRemove);
        }
        const answer = () => jsonOk(rejected ? { ok: true, rejected: [...rejected].map(k => ({ photo_key: k, code: 'not_yours' })) } : { ok: true });
        if (!items.length && !remove.length) return answer();
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
        // A collaborator's items count only on rows that are new or theirs
        // (written last by ?2) as the statement sees them: an item on a row
        // the owner took in between is skipped by the writes below, so the
        // caps count that row as it stands instead. The owner's, every item.
        const mineOrNew = k => `NOT EXISTS (SELECT 1 FROM selections mine WHERE mine.project_id = ?1 AND mine.photo_key = ${k} AND mine.updated_by IS NOT ?2)`;
        const itemsIn = isCollaborator ? `(SELECT value FROM json_each(?6) WHERE ${mineOrNew("json_extract(value, '$.k')")})` : 'json_each(?6)';
        const upsertsIn = isCollaborator ? `(SELECT value FROM json_each(?3) WHERE ${mineOrNew('value')})` : 'json_each(?3)';
        const removesIn = isCollaborator ? `(SELECT value FROM json_each(?4) WHERE ${mineOrNew('value')})` : 'json_each(?4)';
        const notRemoved = `NOT IN (SELECT value FROM ${removesIn})`;
        // the ♥ photos (rating ≥ 1) this save leaves, and those there now
        const starsAfter =
          `((SELECT COUNT(*) FROM ${itemsIn} WHERE json_extract(value, '$.r') > 0 AND json_extract(value, '$.k') ${notRemoved}) + ` +
          `(SELECT COUNT(*) FROM selections WHERE project_id = ?1 AND rating > 0 AND photo_key NOT IN (SELECT value FROM ${upsertsIn}) AND photo_key ${notRemoved}))`;
        const starsNow = '(SELECT COUNT(*) FROM selections WHERE project_id = ?1 AND rating > 0)';
        const starsFit = `${starsAfter} <= MAX(?5, ${starsNow})`;
        // (The plan's cap, pick_limit + extra_max, is not a save cap: guests
        // heart freely and narrow down, and it is checked at submit.)
        const rowsFit =
          `(SELECT COUNT(*) FROM (SELECT photo_key FROM selections WHERE project_id = ?1 UNION SELECT value FROM ${upsertsIn}) ` +
          `WHERE photo_key ${notRemoved}) ` +
          '<= MAX(?7, (SELECT COUNT(*) FROM selections WHERE project_id = ?1))';
        // The pins cap the same way: the pins this save leaves — its own
        // `s` = 1 items' counts (0 for a clear or an unrate), plus every other
        // row's pins, minus the deletes — at most PICK_MARKS_TOTAL_MAX, or no
        // more than there are now. Only in a batch that writes pins (a save
        // that writes none cannot add any, and the column may not exist yet).
        const pinsOf = "CASE WHEN json_valid(marks) THEN json_array_length(marks) ELSE 0 END";
        const setsPins = `SELECT json_extract(value, '$.k') FROM ${itemsIn} WHERE json_extract(value, '$.s') = 1`;
        const marksFit =
          `((SELECT COALESCE(SUM(json_extract(value, '$.c')), 0) FROM ${itemsIn} WHERE json_extract(value, '$.s') = 1 AND json_extract(value, '$.k') ${notRemoved}) + ` +
          `(SELECT COALESCE(SUM(${pinsOf}), 0) FROM selections WHERE project_id = ?1 AND marks IS NOT NULL AND photo_key NOT IN (${setsPins}) AND photo_key ${notRemoved})) ` +
          `<= MAX(${PICK_MARKS_TOTAL_MAX}, (SELECT COALESCE(SUM(${pinsOf}), 0) FROM selections WHERE project_id = ?1 AND marks IS NOT NULL))`;
        // Who may write, inside every statement: the seat (?2 is the owner),
        // or for a collaborator's save the owner OR an active collaborator of
        // the owner now — not revoked, not expired at ?8 (this save's time),
        // invited by the one who holds the seat — the rule resolvePick read.
        const who = isCollaborator ? `(owner_picker_id = ?2 OR ${activeCollaboratorSql('?2', 'projects', '?8')})` : 'owner_picker_id = ?2';
        const openFor = withMarks => `id = ?1 AND ${who} AND phase IN ${PICK_OPEN_SQL} AND archived_at IS NULL AND ${starsFit} AND ${rowsFit}` +
          (withMarks ? ` AND ${marksFit}` : '');
        const itemsJson = JSON.stringify(items);
        // the one big bound value: D1 fails a value over 2 MB as an error, so
        // it is refused here, before anything is tried
        if (new TextEncoder().encode(itemsJson).byteLength > PICK_BIND_MAX) {
          return jsonOk({ error: '資料太大', code: 'too_large', max: PICK_BIND_MAX }, 413);
        }
        const gateArgs = [project.id, picker.id, upsertKeys, removeKeys, PICK_MAX_SELECTIONS, itemsJson, PICK_MAX_ROWS];
        let usedMarks = false;
        const updatedAt = new Date().toISOString();
        // a collaborator's gate names ?8 too (a statement binds exactly what
        // it names); the INSERT always does, for updated_at
        const writeArgs = isCollaborator ? [...gateArgs, updatedAt] : gateArgs;
        // and a collaborator writes only a row that is new or theirs: an
        // update or delete of a row the owner (or another collaborator) last
        // wrote is skipped inside the statement, whatever the read above saw
        const onlyMine = isCollaborator ? ' AND updated_by = ?2' : '';
        // withMarks: whether the batch writes selections.marks at all. The
        // INSERT never names the column (a new row starts with none, an
        // existing one keeps its own); the pins are a second write over the
        // rows the INSERT just wrote, for the items with `s` = 1 only, under
        // the same gate. Before it the INSERT has made those rows, and the gate
        // still holds for a save it let through (the DELETE after it relies on
        // the same).
        const build = withMarks => {
          usedMarks = withMarks;
          const open = openFor(withMarks);
          const gate = `EXISTS (SELECT 1 FROM projects WHERE ${open})`;
          const writes = [env.DB.prepare(
            "UPDATE projects SET modified_after_submit = CASE WHEN phase = 'submitted' THEN 1 ELSE modified_after_submit END " +
            `WHERE ${open}`
          ).bind(...writeArgs)];
          if (items.length) {
            writes.push(env.DB.prepare(
              'INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) ' +
              "SELECT ?1, json_extract(value, '$.k'), json_extract(value, '$.r'), json_extract(value, '$.n'), ?2, ?8 " +
              `FROM json_each(?6) WHERE ${gate} ` +
              'ON CONFLICT(project_id, photo_key) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at' +
              (isCollaborator ? ' WHERE selections.updated_by = ?2' : '')
            ).bind(...gateArgs, updatedAt));
          }
          if (withMarks) {
            const marked = "SELECT value FROM json_each(?6) WHERE json_extract(value, '$.s') = 1";
            writes.push(env.DB.prepare(
              "UPDATE selections SET marks = (SELECT json_extract(value, '$.m') FROM json_each(?6) " +
              "WHERE json_extract(value, '$.k') = selections.photo_key AND json_extract(value, '$.s') = 1) " +
              `WHERE project_id = ?1 AND photo_key IN (SELECT json_extract(value, '$.k') FROM (${marked}))${onlyMine} AND ${gate}`
            ).bind(...writeArgs));
          }
          if (remove.length) {
            writes.push(env.DB.prepare(
              `DELETE FROM selections WHERE project_id = ?1 AND photo_key IN (SELECT value FROM json_each(?4))${onlyMine} AND ${gate}`
            ).bind(...writeArgs));
          }
          return env.DB.batch(writes);
        };
        // A save that names no pins and un-hearts nothing never mentions the
        // column. One that only un-hearts would clear pins, which a database
        // without the column (the migration not run yet) has none of: it is
        // retried without them. One that carries `marks` cannot be saved
        // there, and says so rather than dropping the pins silently.
        // (a failed batch is one transaction rolled back, so the retry starts
        // from nothing)
        const result = await withoutMissingColumn(
          () => build(items.some(i => i.s === 1)),
          async () => carriesMarks ? null : build(false),
        );
        if (!result) return jsonOk({ error: '標示功能尚未啟用', code: 'marks_unavailable' }, 500);
        const [allowed] = result;
        if (!allowed.meta?.changes) {
          return pickRefused(env, project.id, '只有挑選人可以修改', {
            pickerId: picker.id,
            collaborator: isCollaborator,
            // only which message to show; the writes above already decided
            // Which cap, in this order: row_cap; then marks_cap (when the
            // stars fit); then selection_cap. None failing now (the rows moved
            // since): selection_cap.
            refused: async () => {
              const fit = await env.DB.prepare(
                `SELECT ${rowsFit} AS rows_ok, ${starsFit} AS stars_ok${usedMarks ? `, ${marksFit} AS marks_ok` : ''}`
              ).bind(...gateArgs).first();
              if (!fit?.rows_ok) return jsonOk({ error: `最多只能保留 ${PICK_MAX_ROWS} 筆`, code: 'row_cap', max: PICK_MAX_ROWS }, 409);
              if (usedMarks && fit.stars_ok && !fit.marks_ok) {
                return jsonOk({ error: `標示總數已達上限（${PICK_MARKS_TOTAL_MAX} 個）`, code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX }, 409);
              }
              return jsonOk({ error: `最多只能選 ${PICK_MAX_SELECTIONS} 張`, code: 'selection_cap', max: PICK_MAX_SELECTIONS }, 409);
            },
          });
        }
        if (rejected) {
          // what the statements skipped: a row someone else wrote between
          // the read above and the batch is still theirs, or still there
          const tried = [...new Set([...items.map(i => i.k), ...remove])];
          const { results: after } = await env.DB.prepare(
            'SELECT photo_key, updated_by FROM selections WHERE project_id = ? AND photo_key IN (SELECT value FROM json_each(?))'
          ).bind(project.id, JSON.stringify(tried)).all();
          for (const r of after) if (r.updated_by !== picker.id) rejected.add(r.photo_key);
        }
        return answer();
      }

      // POST /api/pick/submit {relationship, email?} — the seat holder only,
      // never a collaborator (docs/co-picking.md: the owner has the last word)
      if (request.method === 'POST' && route === 'submit') {
        if (!isOwner) return jsonOk({ error: '只有挑選人可以送出', code: 'not_owner' }, 403);
        if (!PICK_OPEN_PHASES.includes(project.phase)) return pickRetouching();
        const read = await readJsonCapped(request, PICK_SUBMIT_BODY_MAX);
        if (read.refused) return read.refused;
        const { body } = read;
        const { relationship, email } = (body && typeof body === 'object') ? body : {};
        if (!PICK_RELATIONSHIPS.includes(relationship)) return jsonErr('請選擇與新人的關係');
        let mail = null;
        if (email !== undefined && email !== null) {
          if (typeof email !== 'string') return jsonErr('Invalid email');
          const trimmed = email.trim();
          if (trimmed) {
            if (overChars(trimmed, PICK_EMAIL_MAX) || !/^[^\s@]+@[^\s@]+$/.test(trimmed)) return jsonErr('Email 格式不正確');
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
        // the retouch pins of the same photos, {photo_key: [pins]} in key
        // order over the photos that have any; NULL when none do. A value
        // that is not JSON (only ever by hand) is left out rather than
        // failing the submit.
        const pinned = 'SELECT photo_key, marks FROM selections WHERE project_id = p.id AND rating > 0 AND marks IS NOT NULL AND json_valid(marks) ORDER BY photo_key';
        const marksSnapshot = `(SELECT NULLIF(json_group_object(photo_key, json(marks)), '{}') FROM (${pinned}))`;
        const room = `(SELECT COUNT(*) FROM submissions WHERE project_id = p.id) < ${PICK_MAX_SUBMISSIONS}`;
        const open = `p.id = ? AND p.owner_picker_id = ? AND p.phase IN ${PICK_OPEN_SQL} AND p.archived_at IS NULL`;
        // withMarks: false on a database without the marks columns yet, where
        // a repeat is the same photos, as it was before pins
        // and the snapshot must fit PICK_MARKS_SNAPSHOT_MAX bytes; a save
        // cannot make one that does not, so only hand-edited rows are refused
        const marksFit = `COALESCE(length(CAST(${marksSnapshot} AS BLOB)), 0) <= ${PICK_MARKS_SNAPSHOT_MAX}`;
        // The plan's cap (docs/project-plan.md): at most pick_limit +
        // extra_max ♥ photos — the snapshot's own count — may be sent; NULL in
        // either = none. ♥ itself is never capped by the plan (a save is a
        // draft), so this is where it holds. It rides in `fits`, so it gates
        // all three statements, a repeat included (a repeat over a plan
        // lowered since is refused too: the plan is authoritative), and it
        // reads the selections and the project row inside the transaction, so
        // a save or a PATCH landing after the route's reads is seen. Only on a
        // database that has the column (resolveShareToken reads the project
        // with SELECT *, so the key is there exactly then).
        const pickedCount = `(SELECT COUNT(*) FROM (${picked}))`;
        const withPlan = hasField(project, 'extra_max');
        const planFit = `(p.pick_limit IS NULL OR p.extra_max IS NULL OR ${pickedCount} <= p.pick_limit + p.extra_max)`;
        let usedMarks = false;
        const submitBatch = withMarks => {
          usedMarks = withMarks;
          const fits = (withPlan ? ` AND ${planFit}` : '') + (withMarks ? ` AND ${marksFit}` : '');
          // both sides built the same way (json_group_array / _object over
          // keys in the same order), so equal means unchanged: a repeat is
          // the same photos AND the same pins
          const latest = `SELECT photo_keys${withMarks ? ', marks' : ''} FROM submissions WHERE project_id = p.id ORDER BY rowid DESC LIMIT 1`;
          const repeat = `EXISTS (SELECT 1 FROM (${latest}) l WHERE l.photo_keys IS ${snapshot}` +
            `${withMarks ? ` AND l.marks IS ${marksSnapshot}` : ''})`;
          return env.DB.batch([
            env.DB.prepare(
              `INSERT INTO submissions (id, project_id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at${withMarks ? ', marks' : ''}) ` +
              `SELECT ?, p.id, ?, ?, ?, ${snapshot}, ${pickedCount}, ` +
              `p.pick_limit, p.extra_price, ?${withMarks ? `, ${marksSnapshot}` : ''} FROM projects p WHERE ${open} AND NOT (${repeat}) AND ${room}${fits}`
            ).bind(submissionId, picker.id, relationship, mail, submittedAt, project.id, picker.id),
            // the latest contact info stays on the picker
            env.DB.prepare(
              `UPDATE pickers SET relationship = ?, email = ? WHERE id = ? AND EXISTS (SELECT 1 FROM projects p WHERE ${open} AND (${repeat} OR ${room})${fits})`
            ).bind(relationship, mail, picker.id, project.id, picker.id),
            env.DB.prepare(
              `UPDATE projects SET phase = 'submitted', modified_after_submit = 0 WHERE id IN (SELECT p.id FROM projects p WHERE ${open} AND (${repeat} OR ${room})${fits})`
            ).bind(project.id, picker.id),
          ]);
        };
        const [inserted, , moved] = await withoutMissingColumn(() => submitBatch(true), () => submitBatch(false));
        if (!moved.meta?.changes) {
          return pickRefused(env, project.id, '只有挑選人可以送出', {
            pickerId: picker.id,
            // Which cap, in this order: pick_cap (the one the guest can fix
            // by un-hearting); then marks_cap; then submission_cap.
            refused: async () => {
              if (withPlan) {
                const plan = await env.DB.prepare(
                  `SELECT ${planFit} AS ok, ${pickedCount} AS count, p.pick_limit, p.extra_max FROM projects p WHERE p.id = ?`
                ).bind(project.id).first();
                if (plan && !plan.ok) return pickCapRefused(plan.count, plan.pick_limit, plan.extra_max);
              }
              const fit = usedMarks
                ? await env.DB.prepare(`SELECT ${marksFit} AS ok FROM projects p WHERE p.id = ?`).bind(project.id).first()
                : { ok: 1 };
              if (!fit?.ok) {
                return jsonOk({ error: `標示總數已達上限（${PICK_MARKS_TOTAL_MAX} 個）`, code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX }, 409);
              }
              return jsonOk({
                error: `送出次數已達上限（${PICK_MAX_SUBMISSIONS} 次），請聯絡攝影師`,
                code: 'submission_cap', max: PICK_MAX_SUBMISSIONS,
              }, 409);
            },
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

      // POST /api/pick/confirm (no body, or {}) — the seat holder confirms
      // the delivery (確認完成). POST /api/pick/revision {message} — or asks
      // for changes (要求修改). docs/delivery.md, client confirmation. Seat
      // first (403), then delivered now (409 not_delivered, before the body),
      // then the body. Each is one gated write (a batch for confirm, which
      // resolves the open requests with it; a single INSERT for a request,
      // which re-checks "not confirmed" and both caps itself), so a seat
      // reset, an undeliver, an archive or the other route landing after the
      // checks still wins. The photographer is emailed in the background; a
      // mail that fails never fails the request.
      if (request.method === 'POST' && (route === 'confirm' || route === 'revision')) {
        const confirming = route === 'confirm';
        const notOwner = confirming ? '只有挑選人可以確認完成' : '只有挑選人可以要求修改';
        if (!isOwner) return jsonErr(notOwner, 403);
        if (pickReadScope(s).mode !== 'delivered') return pickNotDelivered();
        const bytes = await readBodyCapped(request, PICK_SUBMIT_BODY_MAX);
        if (!bytes) return jsonOk({ error: '資料太大', code: 'too_large', max: PICK_SUBMIT_BODY_MAX }, 413);
        const text = new TextDecoder().decode(bytes);
        let body = {};
        if (text.trim()) {
          try { body = JSON.parse(text); } catch { return jsonErr('Invalid JSON'); }
        }
        if (!isPlainObject(body)) return jsonOk({ error: 'Invalid body', code: 'invalid_body' }, 400);
        const message = confirming ? null : revisionMessage(body.message);
        if (!confirming && !message) {
          return jsonOk({ error: `請輸入 1–${REVISION_MESSAGE_MAX} 字的修改說明`, code: 'invalid_message', max: REVISION_MESSAGE_MAX }, 400);
        }
        // resolveShareToken read the project with SELECT *: the key is there
        // exactly when the migration has run
        if (!hasField(project, 'client_confirmed_at')) return jsonOk(CONFIRM_UNAVAILABLE, 500);
        const done = data => jsonOk({ ok: true, ...data }, 200, SHARED_LINK_HEADERS);
        const alreadyConfirmed = () => jsonOk({ error: '已確認完成，無法再要求修改', code: 'already_confirmed' }, 409);
        // a repeat confirm answers the first stamp (whoever made it) and
        // writes nothing; a request after it is refused
        if (project.client_confirmed_at) return confirming ? done({ confirmed_at: project.client_confirmed_at }) : alreadyConfirmed();
        const at = new Date().toISOString();
        const open = "id = ?1 AND owner_picker_id = ?2 AND archived_at IS NULL AND phase = 'retouching' " +
          'AND delivered_at IS NOT NULL AND final_folders IS NOT NULL';
        let changed;
        try {
          if (confirming) {
            const [stamped] = await env.DB.batch([
              env.DB.prepare(
                `UPDATE projects SET client_confirmed_at = ?3, client_confirmed_by = 'guest' WHERE ${open} AND client_confirmed_at IS NULL`
              ).bind(project.id, picker.id, at),
              resolveRevisionsIfConfirmed(env, project.id, at, project.photographer_id),
            ]);
            changed = stamped.meta?.changes;
          } else {
            const inserted = await env.DB.prepare(
              'INSERT INTO revision_requests (id, project_id, picker_id, message, created_at) SELECT ?3, ?1, ?2, ?4, ?5 ' +
              `WHERE EXISTS (SELECT 1 FROM projects WHERE ${open} AND client_confirmed_at IS NULL) ` +
              `AND (SELECT COUNT(*) FROM revision_requests WHERE project_id = ?1 AND resolved_at IS NULL) < ${REVISION_OPEN_MAX} ` +
              `AND (SELECT COUNT(*) FROM revision_requests WHERE project_id = ?1) < ${REVISION_TOTAL_MAX}`
            ).bind(project.id, picker.id, crypto.randomUUID(), message, at).run();
            changed = inserted.meta?.changes;
          }
        } catch (e) {
          // the columns are there but not the table: nothing was written
          if (isMissingSchema(e)) return jsonOk(CONFIRM_UNAVAILABLE, 500);
          throw e;
        }
        if (!changed) {
          // re-read to say why, in the order the checks above run
          const now = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(project.id).first();
          if (!now || now.archived_at) return jsonErr('Unauthorized', 401);
          if (now.owner_picker_id !== picker.id) return jsonErr(notOwner, 403);
          if (now.phase !== 'retouching' || !pickFinals(now)) return pickNotDelivered();
          if (now.client_confirmed_at) return confirming ? done({ confirmed_at: now.client_confirmed_at }) : alreadyConfirmed();
          if (confirming) return pickNotDelivered();
          const counted = await env.DB.prepare('SELECT COUNT(*) AS open FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL')
            .bind(project.id).first();
          if ((counted?.open ?? 0) >= REVISION_OPEN_MAX) {
            return jsonOk({ error: `尚未處理的修改需求已有 ${REVISION_OPEN_MAX} 則，請等攝影師回覆`, code: 'revision_open_cap', max: REVISION_OPEN_MAX }, 409);
          }
          return jsonOk({ error: `修改需求已達上限（${REVISION_TOTAL_MAX} 則），請直接聯絡攝影師`, code: 'revision_cap', max: REVISION_TOTAL_MAX }, 409);
        }
        // the activity log has the confirmation; a request is its own
        // revision_requests row already (best-effort, never fails this)
        if (confirming) await logProjectEvent(env, project.id, 'confirm', 'client', at);
        const notify = Promise.resolve()
          .then(() => sendClientNotification(env, project, picker.name, message))
          .catch(e => console.error('client notification failed:', e?.message || e));
        if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
        return done(confirming ? { confirmed_at: at } : { message, created_at: at });
      }

      // ─── Revision pins (docs/revision-pins.md) ─────────────────────────
      // PUT /api/pick/revision-pins {items: [{photo_key, marks}]} — draft
      // pins on the current finals. POST /api/pick/revision-round {note?,
      // expect} — send them as one frozen round. GET /api/pick/rounds,
      // /rounds/:id, /rounds/:id/photo?i=&w= — the history. Every one: the
      // link (401, above), the seat (403), delivered now (409 not_delivered,
      // before the body), the body (413 / 400), the migration (500
      // revision_pins_unavailable), then the state and the gated write.
      if (route === 'revision-pins' || route === 'revision-round' || pathParts[2] === 'rounds') {
        const out = (data, status = 200) => jsonOk(data, status, SHARED_LINK_HEADERS);
        const isRounds = pathParts[2] === 'rounds';
        const method = isRounds ? 'GET' : route === 'revision-pins' ? 'PUT' : 'POST';
        if (request.method !== method) return jsonOk({ error: 'Method not allowed' }, 405, { ...SHARED_LINK_HEADERS, Allow: method });
        if (!isOwner) return out({ error: '只有挑選人可以標示修改', code: 'not_owner' }, 403);
        const scope = pickReadScope(s);
        const notDelivered = () => out({ error: '尚未交件', code: 'not_delivered' }, 409);
        if (scope.mode !== 'delivered') return notDelivered();
        const unavailable = () => out(REVISION_PINS_UNAVAILABLE, 500);
        const invalidBody = () => out({ error: 'Invalid body', code: 'invalid_body' }, 400);
        const alreadyConfirmed = () => out({ error: '已確認完成，無法再要求修改', code: 'already_confirmed' }, 409);
        const revisionOpen = () => out({ error: '已送出修改，請等攝影師更新照片', code: 'revision_open' }, 409);
        const ready = async () => hasField(project, 'client_confirmed_at') && await revisionPinsReady(env);
        const anyOpen = async () => !!(await env.DB.prepare(
          'SELECT 1 AS open FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL LIMIT 1'
        ).bind(project.id).first());
        // the delivery this request was checked against: a write is bound to
        // it, so a 更換精修 / undeliver landing in between makes it a no-op
        const sameDelivery = now => now.phase === 'retouching' && !!pickFinals(now) &&
          now.delivered_at === project.delivered_at && now.final_folders === project.final_folders;
        // a write that changed nothing, re-read: the link, the seat, the
        // delivery, the confirmation, an open request — then `rest(now)`
        const refusedBy = async rest => {
          const now = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(project.id).first();
          if (!now || now.archived_at) return jsonOk({ error: 'Unauthorized' }, 401, SHARED_LINK_HEADERS);
          if (now.owner_picker_id !== picker.id) return out({ error: '只有挑選人可以標示修改', code: 'not_owner' }, 403);
          if (!sameDelivery(now)) return notDelivered();
          if (now.client_confirmed_at) return alreadyConfirmed();
          if (await anyOpen()) return revisionOpen();
          return rest(now);
        };

        if (route === 'revision-pins') {
          const read = await readJsonCapped(request, REVISION_PINS_BODY_MAX);
          if (read.refused) return read.refused;
          const { body } = read;
          if (!isPlainObject(body) || !Array.isArray(body.items) || !body.items.length || body.items.length > REVISION_PINS_ITEMS_MAX) {
            return invalidBody();
          }
          // every item is checked before anything is written; a key named
          // twice is written once, as its last mention
          const byKey = new Map();
          for (const item of body.items) {
            if (!isPlainObject(item) || typeof item.photo_key !== 'string') return invalidBody();
            if (!pickKeyValid(item.photo_key)) return pickKeyInvalid();
            const marks = pickMarks(item.marks);
            if (!marks) return pickMarksInvalid();
            byKey.delete(item.photo_key);
            byKey.set(item.photo_key, marks);
          }
          // the current finals only: never a proof, even with the proof
          // originals switch on, never a `_` object
          for (const key of byKey.keys()) {
            if (!pickKeyAllowed({ folders: scope.finals }, key)) return out({ error: '只能標示這次交件的精修照片', code: 'not_in_finals' }, 403);
          }
          if (!await ready()) return unavailable();
          if (project.client_confirmed_at) return alreadyConfirmed();
          if (await anyOpen()) return revisionOpen();
          // {k, m: the canonical JSON or null (= delete the draft), c: pins}
          const items = [...byKey].map(([k, m]) => ({ k, m: m.length ? JSON.stringify(m) : null, c: m.length }));
          // ?1 project, ?2 picker, ?3 delivered_at, ?4 final_folders (both as
          // this request read them), ?5 the items, ?6 the time. A draft
          // counts only while it belongs to this delivery. The caps the way
          // the selections save has them: what this save leaves — its own
          // items plus every other draft of this delivery — is at most the
          // cap, or no more than there is now (so deleting and shrinking
          // still work in a project already over). Every statement re-checks
          // the whole gate inside the batch (one transaction): a deliver, an
          // undeliver, a confirm, a round or a seat reset landing after the
          // checks above wins, for the whole save.
          const valid = 'project_id = ?1 AND delivery_at = ?3 AND delivery_finals = ?4';
          const itemKeys = "SELECT json_extract(value, '$.k') FROM json_each(?5)";
          const pinsOf = 'CASE WHEN json_valid(marks) THEN json_array_length(marks) ELSE 0 END';
          const photosFit =
            `((SELECT COUNT(*) FROM json_each(?5) WHERE json_extract(value, '$.c') > 0) + ` +
            `(SELECT COUNT(*) FROM revision_pins WHERE ${valid} AND photo_key NOT IN (${itemKeys}))) ` +
            `<= MAX(${REVISION_PHOTOS_MAX}, (SELECT COUNT(*) FROM revision_pins WHERE ${valid}))`;
          const pinsFit =
            `((SELECT COALESCE(SUM(json_extract(value, '$.c')), 0) FROM json_each(?5)) + ` +
            `(SELECT COALESCE(SUM(${pinsOf}), 0) FROM revision_pins WHERE ${valid} AND photo_key NOT IN (${itemKeys}))) ` +
            `<= MAX(${PICK_MARKS_TOTAL_MAX}, (SELECT COALESCE(SUM(${pinsOf}), 0) FROM revision_pins WHERE ${valid}))`;
          const open = "id = ?1 AND owner_picker_id = ?2 AND archived_at IS NULL AND phase = 'retouching' " +
            'AND delivered_at = ?3 AND final_folders = ?4 AND client_confirmed_at IS NULL ' +
            'AND NOT EXISTS (SELECT 1 FROM revision_requests r WHERE r.project_id = ?1 AND r.resolved_at IS NULL)';
          const gate = `EXISTS (SELECT 1 FROM projects WHERE ${open} AND ${photosFit} AND ${pinsFit})`;
          const args = [project.id, picker.id, project.delivered_at, project.final_folders, JSON.stringify(items)];
          let result;
          try {
            result = await env.DB.batch([
              // the gate's own row count: it always touches the project when
              // the save is allowed (a DELETE below may touch nothing)
              env.DB.prepare(`UPDATE projects SET id = id WHERE ${open} AND ${photosFit} AND ${pinsFit}`).bind(...args),
              // drafts of an earlier delivery go with the first save after it
              env.DB.prepare(
                `DELETE FROM revision_pins WHERE project_id = ?1 AND (delivery_at IS NOT ?3 OR delivery_finals IS NOT ?4) AND ${gate}`
              ).bind(...args),
              env.DB.prepare(
                'INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) ' +
                "SELECT ?1, json_extract(value, '$.k'), json_extract(value, '$.m'), ?3, ?4, ?2, ?6 FROM json_each(?5) " +
                `WHERE json_extract(value, '$.c') > 0 AND ${gate} ` +
                'ON CONFLICT(project_id, photo_key) DO UPDATE SET marks = excluded.marks, delivery_at = excluded.delivery_at, ' +
                'delivery_finals = excluded.delivery_finals, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
              ).bind(...args, new Date().toISOString()),
              env.DB.prepare(
                "DELETE FROM revision_pins WHERE project_id = ?1 AND photo_key IN (SELECT json_extract(value, '$.k') FROM json_each(?5) " +
                `WHERE json_extract(value, '$.c') = 0) AND ${gate}`
              ).bind(...args),
            ]);
          } catch (e) {
            if (isMissingSchema(e)) return unavailable();
            throw e;
          }
          if (!result[0].meta?.changes) {
            return refusedBy(async () => {
              const fit = await env.DB.prepare(`SELECT ${photosFit} AS photos_ok`).bind(...args).first();
              if (!fit?.photos_ok) {
                return out({ error: `一次最多標示 ${REVISION_PHOTOS_MAX} 張照片`, code: 'revision_photos_cap', max: REVISION_PHOTOS_MAX }, 409);
              }
              return out({ error: `標示總數已達上限（${PICK_MARKS_TOTAL_MAX} 個）`, code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX }, 409);
            });
          }
          return out({ ok: true });
        }

        if (route === 'revision-round') {
          const read = await readJsonCapped(request, REVISION_ROUND_BODY_MAX);
          if (read.refused) return read.refused;
          const { body } = read;
          // expect: the photos and pin counts the page believes it is
          // sending, to catch another tab's change since it last read them
          if (!isPlainObject(body) || !Array.isArray(body.expect) || body.expect.length > REVISION_PHOTOS_MAX) return invalidBody();
          const expected = new Set();
          for (const e of body.expect) {
            if (!isPlainObject(e) || !pickKeyValid(e.k) || expected.has(e.k)) return invalidBody();
            if (!Number.isInteger(e.n) || e.n < 1 || e.n > PICK_MARKS_MAX) return invalidBody();
            expected.add(e.k);
          }
          // the overall note is optional: none, null or blank is none
          let note = null;
          if (body.note !== undefined && body.note !== null) {
            if (typeof body.note !== 'string') {
              return out({ error: `總說明最多 ${REVISION_MESSAGE_MAX} 字`, code: 'invalid_message', max: REVISION_MESSAGE_MAX }, 400);
            }
            if (body.note.trim()) {
              note = revisionMessage(body.note);
              if (!note) return out({ error: `總說明最多 ${REVISION_MESSAGE_MAX} 字`, code: 'invalid_message', max: REVISION_MESSAGE_MAX }, 400);
            }
          }
          if (!await ready()) return unavailable();
          const expectJson = JSON.stringify(body.expect.map(e => ({ k: e.k, n: e.n })));
          // the drafts of project `p` that belong to its delivery now, as an
          // SQL fragment over alias `d`, with the delivery named by `at`/`ff`
          const draftsOf = (pid, at, ff) =>
            `FROM revision_pins d WHERE d.project_id = ${pid} AND d.delivery_at = ${at} AND d.delivery_finals = ${ff} AND json_valid(d.marks)`;
          // the round's snapshot {photo_key: [pins]} in key order, and
          // whether the drafts are exactly what the page expects: the same
          // set of photos, each with the same number of pins (compared as
          // sets in SQL, so no serialisation has to match byte for byte)
          const snapshotOf = drafts => `(SELECT json_group_object(photo_key, json(marks)) FROM (SELECT d.photo_key, d.marks ${drafts} ORDER BY d.photo_key))`;
          const sameAs = (drafts, expectParam) => `((SELECT COUNT(*) ${drafts}) = json_array_length(${expectParam}) AND NOT EXISTS (` +
            `SELECT 1 FROM json_each(${expectParam}) e WHERE NOT EXISTS (SELECT 1 ${drafts} ` +
            "AND d.photo_key = json_extract(e.value, '$.k') AND json_array_length(d.marks) = json_extract(e.value, '$.n'))))";
          const roundRefused = now => refusedBy(async () => {
            const drafts = draftsOf('?1', '?2', '?3');
            const st = await env.DB.prepare(
              `SELECT (SELECT COUNT(*) ${drafts}) AS drafts, ${sameAs(drafts, '?4')} AS same, ` +
              '(SELECT COUNT(*) FROM revision_requests WHERE project_id = ?1) AS total, ' +
              `COALESCE(length(CAST(${snapshotOf(drafts)} AS BLOB)), 0) <= ${PICK_MARKS_SNAPSHOT_MAX} AS fits`
            ).bind(project.id, now.delivered_at, now.final_folders, expectJson).first();
            if (!st?.drafts) return out({ error: '還沒有標示任何照片', code: 'no_pins' }, 409);
            if (!st.same) return out({ error: '標示已在其他頁面更改，請重新確認', code: 'draft_changed' }, 409);
            if (st.total >= REVISION_TOTAL_MAX) {
              return out({ error: `修改需求已達上限（${REVISION_TOTAL_MAX} 則），請直接聯絡攝影師`, code: 'revision_cap', max: REVISION_TOTAL_MAX }, 409);
            }
            if (!st.fits) return out({ error: `標示總數已達上限（${PICK_MARKS_TOTAL_MAX} 個）`, code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX }, 409);
            return null;
          });
          // the checks first, in order, so the guest is told why
          const early = await roundRefused(project);
          if (early) return early;
          // One INSERT … SELECT holds every rule against the rows as they
          // stand inside the write: the seat, the delivery this request
          // checked (a 更換精修 / undeliver / reopen in between makes it a
          // no-op), not confirmed, no open request, under REVISION_TOTAL_MAX,
          // 1–REVISION_PHOTOS_MAX drafts exactly as expected, the snapshot
          // within PICK_MARKS_SNAPSHOT_MAX. The drafts go in the same batch,
          // only if the row landed. marks / finals / message / message_auto
          // are written here once and never updated.
          const drafts = draftsOf('p.id', 'p.delivered_at', 'p.final_folders');
          const snapshot = snapshotOf(drafts);
          const roundId = crypto.randomUUID();
          const at = new Date().toISOString();
          let landed;
          try {
            [landed] = await env.DB.batch([
              env.DB.prepare(
                'INSERT INTO revision_requests (id, project_id, picker_id, message, message_auto, marks, finals, created_at) ' +
                `SELECT ?3, p.id, ?2, ?4, ?5, ${snapshot}, p.final_folders, ?6 FROM projects p ` +
                "WHERE p.id = ?1 AND p.owner_picker_id = ?2 AND p.archived_at IS NULL AND p.phase = 'retouching' " +
                'AND p.delivered_at = ?7 AND p.final_folders = ?8 AND p.client_confirmed_at IS NULL ' +
                'AND NOT EXISTS (SELECT 1 FROM revision_requests r WHERE r.project_id = p.id AND r.resolved_at IS NULL) ' +
                `AND (SELECT COUNT(*) FROM revision_requests r WHERE r.project_id = p.id) < ${REVISION_TOTAL_MAX} ` +
                `AND (SELECT COUNT(*) ${drafts}) BETWEEN 1 AND ${REVISION_PHOTOS_MAX} ` +
                `AND ${sameAs(drafts, '?9')} ` +
                `AND length(CAST(${snapshot} AS BLOB)) <= ${PICK_MARKS_SNAPSHOT_MAX}`
              ).bind(project.id, picker.id, roundId, note ?? REVISION_PINS_MESSAGE, note ? 0 : 1, at,
                project.delivered_at, project.final_folders, expectJson),
              env.DB.prepare(
                'DELETE FROM revision_pins WHERE project_id = ?1 AND EXISTS (SELECT 1 FROM revision_requests WHERE id = ?2 AND project_id = ?1)'
              ).bind(project.id, roundId),
            ]);
          } catch (e) {
            if (isMissingSchema(e)) return unavailable();
            throw e;
          }
          if (!landed.meta?.changes) {
            return (await roundRefused(project)) || out({ error: '標示已在其他頁面更改，請重新確認', code: 'draft_changed' }, 409);
          }
          const row = await env.DB.prepare('SELECT marks FROM revision_requests WHERE id = ?').bind(roundId).first();
          const pins = parseMarksSnapshot(row?.marks) || {};
          const notify = Promise.resolve()
            .then(() => sendRevisionRoundNotification(env, project, picker.name, note, pins))
            .catch(e => console.error('revision notification failed:', e?.message || e));
          if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
          return out({ ok: true, id: roundId, created_at: at, photo_count: Object.keys(pins).length });
        }

        // GET /api/pick/rounds[/:id[/photo]] — the history, read only
        const id = pathParts[3];
        const sub = pathParts[4];
        const notFound = () => out({ error: 'Not found', code: 'not_found' }, 404);
        if (pathParts.length > 5 || (sub !== undefined && sub !== 'photo')) return notFound();
        if (sub === 'photo') {
          // thumbnails only: never a download, never a width the list does
          // not name (1600 and up are close to the original)
          if (params.has('download')) return out({ error: 'Invalid Request', code: 'invalid_request' }, 400);
          const widths = params.getAll('w');
          if (widths.length !== 1 || !REVISION_THUMB_WIDTHS.includes(widths[0])) {
            return out({ error: '縮圖寬度只能是 400 或 1200', code: 'invalid_width' }, 400);
          }
        }
        if (!await ready()) return unavailable();
        if (id === undefined) {
          // newest first: the requests (≤ REVISION_TOTAL_MAX) and the latest
          // submission as `selection`, by created_at (a tie goes to the
          // request, which can only come after)
          const { results } = await env.DB.prepare(
            'SELECT id, message_auto, marks, created_at, resolved_at FROM revision_requests WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
          ).bind(project.id, REVISION_TOTAL_MAX).all();
          const list = results.map(r => {
            const pinsRound = r.marks != null;
            return {
              id: r.id, kind: pinsRound ? 'pins' : 'text', created_at: r.created_at, open: r.resolved_at == null,
              photo_count: pinsRound ? Object.keys(parseMarksSnapshot(r.marks) || {}).length : 0,
              has_note: pinsRound ? r.message_auto !== 1 : true,
            };
          });
          const selection = await loadRound(env, s, project, 'selection');
          if (selection) {
            const entry = { id: 'selection', kind: 'selection', created_at: selection.created_at, open: false, photo_count: selection.keys.length, has_note: false };
            const at = list.findIndex(r => r.created_at < selection.created_at);
            list.splice(at < 0 ? list.length : at, 0, entry);
          }
          return out({ rounds: list });
        }
        const found = await loadRound(env, s, project, id);
        if (!found) return notFound();
        if (sub !== 'photo') {
          let photos = found.keys.map((k, i) => ({ i, name: k.split('/').pop(), pins: found.pins[k] || [] }));
          // the selection: the photos with pins first (each keeps its index)
          if (found.kind === 'selection') photos = [...photos.filter(x => x.pins.length), ...photos.filter(x => !x.pins.length)];
          return out({ id: found.id, kind: found.kind, created_at: found.created_at, open: found.open, note: found.note, photos });
        }
        // GET /api/pick/rounds/:id/photo?i=<n>&w=<400|1200> — the one guest
        // read outside pickFinals (docs/revision-pins.md §4.5): the thumbnail
        // of the key at index i of this project's frozen snapshot. The
        // request names no key; the key is re-checked against the folders
        // the round was made on, and only `_thumbs/<w>/<key>.thumb` is read —
        // a missing one is 404, never the original.
        const indexes = params.getAll('i');
        if (indexes.length !== 1 || !/^\d{1,4}$/.test(indexes[0])) return notFound();
        const index = Number(indexes[0]);
        if (index >= found.keys.length) return notFound();
        const key = found.keys[index];
        if (!pickKeyValid(key) || !pickKeyAllowed({ folders: found.folders }, key)) return notFound();
        // in the project's photographer's files (batch 3), never the request's
        const object = await bucketFor(env, project.photographer_id).get(`${THUMB_PREFIX}${params.get('w')}/${key}.thumb`);
        if (!object || !('body' in object)) return out({ error: '縮圖不存在', code: 'no_thumbnail' }, 404);
        // the stored type only when it is a raster image (an SVG is a
        // script); nothing else the object's metadata says is passed on
        const stored = new Headers();
        object.writeHttpMetadata?.(stored);
        const type = (stored.get('Content-Type') || '').toLowerCase();
        return new Response(object.body, {
          headers: {
            ...corsHeaders,
            'Content-Type': REVISION_THUMB_TYPES.includes(type) ? type : 'image/jpeg',
            'Cache-Control': 'private, no-store',
            'Vary': 'X-Share-Token, X-Picker-Key',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      return jsonErr('Not found', 404);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BOOK / R2 ROUTES — a client reaches these with a share token
    // ═══════════════════════════════════════════════════════════════════════

    if (pathParts[0] === 'api' && pathParts[1] === 'books' && pathParts[2]) {
      const bookId = pathParts[2];
      // books (and their share links) have no owner yet: the default
      // photographer's, and every other photographer gets the 404 of a path
      // that is not theirs
      const auth = await requireDefault(request, env, { optional: true }); // default-only until books
      if (auth.refused) return auth.refused;
      const admin = auth.who !== null;
      const books = bookBucket(env);

      // POST /api/books/:id/share — mint a link for this album
      if (request.method === 'POST' && pathParts[3] === 'share') {
        if (!admin) return jsonErr('Unauthorized', 401);
        if (!env.DB) return jsonErr('DB not configured', 500);
        const obj = await books.get(`_books/${bookId}.json`);
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
        const obj = await books.get(`_books/${bookId}.json`);
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
        if (!admin) return jsonErr('Unauthorized', 401);
        // stored as sent (byte for byte), but only once it is a book whose
        // slots cannot carry markup into the editor and the viewer
        const text = await request.text();
        let book;
        try { book = JSON.parse(text); } catch { return bookContentRefusal('invalid_book'); }
        const problem = bookContentProblem(book);
        if (problem) return bookContentRefusal(problem);
        await books.put(`_books/${bookId}.json`, text, {
          httpMetadata: { contentType: 'application/json' }
        });
        return jsonOk({ ok: true, id: bookId });
      }

      if (request.method === 'PATCH' && !pathParts[3]) {
        const obj = await books.get(`_books/${bookId}.json`);
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
            // checked before the photoId, whose branches `continue` on an
            // empty one — a crop rides along with a cleared slot too
            if (slot.crop !== undefined && !bookCropValid(slot.crop)) return bookContentRefusal('invalid_crop');
            // folderCovers calls startsWith on this and shareCovers splits it,
            // so a number or an array leaves the runtime to turn a TypeError
            // into a 1101. A falsy one still means "clear the slot".
            if (typeof slot.photoId !== 'string') {
              if (slot.photoId) return jsonErr('無效的照片', 400);
              continue;
            }
            if (!slot.photoId) continue;
            // inside the folder is not enough: the rest of the key is rendered
            // into an attribute (FE-1)
            if (!bookPhotoIdSafe(slot.photoId)) return bookContentRefusal('invalid_photo_id');
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
        await books.put(`_books/${bookId}.json`, JSON.stringify(book), {
          httpMetadata: { contentType: 'application/json' }
        });
        return jsonOk({ ok: true });
      }

      if (request.method === 'GET' && pathParts[3] === 'status') {
        const obj = await books.get(`_books/${bookId}_status.json`);
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
        const prev = await books.get(`_books/${bookId}_status.json`);
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
        await books.put(`_books/${bookId}_status.json`, JSON.stringify(status), {
          httpMetadata: { contentType: 'application/json' }
        });
        const bookObj = await books.get(`_books/${bookId}.json`);
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

    // PUT (upload) — a photographer only, into its own files (batch 3: the
    // key is logical; bucketFor puts a non-default photographer's under its
    // prefix). The reserved `_t/` namespace is refused for everyone (400),
    // checked on the key as it will be stored, after `_assets/` comes off.
    // It is the PUT fall-through, so it claims only what can be a photo key
    // (security review of batch 3): an empty key (`PUT /`, `/_assets/`) or one
    // that is not valid percent-encoding is 400, and anything under `api/` —
    // a route that does not exist, never a file — is 404; nothing written.
    if (request.method === 'PUT') {
      const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      const photos = bucketFor(env, auth.who.id);
      const invalidKey = () => jsonOk({ error: 'Invalid key', code: 'invalid_key' }, 400);
      let key;
      try { key = decodeURIComponent(url.pathname.slice(1)); } catch { return invalidKey(); }
      if (key.startsWith('_assets/')) key = key.slice('_assets/'.length);
      if (key.split('/').find(Boolean) === 'api') return jsonErr('Not found', 404);
      // nothing but slashes names no file either
      if (!key.replace(/\//g, '') || isTenantKey(key)) return invalidKey();
      // a photo the app uploads, by extension and type, or 415 (uploadContentType)
      const contentType = uploadContentType(key, request.headers.get('Content-Type'));
      if (!contentType) {
        return jsonOk({ error: '只能上傳照片檔（JPG、PNG、WEBP、AVIF、HEIC、TIFF、GIF、BMP）', code: 'unsupported_type' }, 415);
      }
      await photos.put(key, request.body, { httpMetadata: { contentType } });
      return jsonOk({ ok: true, key });
    }

    // GET list — the caller's own files, or a link's: a pick link its
    // project's photographer's, a studio token its minter's (shareOwner).
    // Logical keys in, logical keys out (bucketFor); a reserved prefix lists
    // nothing.
    const listPrefix = params.get('list');
    if (listPrefix !== null) {
      let listShare = null;
      const auth = await requirePhotographer(request, env, { optional: true }); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      let photos;
      if (auth.who) {
        photos = bucketFor(env, auth.who.id);
      } else {
        listShare = await share();
        // a pick link lists what it may preview now (pickReadScope)
        const covered = listShare && (isPickShare(listShare)
          ? pickKeyAllowed({ folders: pickReadScope(listShare).preview }, listPrefix)
          : isStudioShare(listShare) || shareCovers(listShare, listPrefix));
        if (!covered) return jsonErr('Unauthorized', 401);
        photos = bucketFor(env, shareOwner(listShare));
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
          const listed = await photos.list({
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
      // whether the original (full resolution) may be served; only a pick
      // link is ever told no
      let original = true;
      // the answer depended on X-Picker-Key (a proof original): it goes into Vary
      let ownerKeyed = false;
      const source = sourceKey(key);
      const isThumb = source !== key;
      // ?download=1: the original as an attachment. Never a thumbnail.
      const download = params.get('download') === '1';
      if (download && isThumb) return jsonErr('Invalid Request', 400);
      const auth = await requirePhotographer(request, env, { optional: true }); // scoped to the caller (who.id)
      if (auth.refused) return auth.refused;
      // whose files: the caller's own, or the link's owner's (shareOwner);
      // a `_t/...` key reads as missing (bucketFor)
      let photos = auth.who ? bucketFor(env, auth.who.id) : null;
      if (!auth.who) {
        const s = await share();
        // checked on the source key, so a thumbnail of a book is a book, and
        // ahead of every kind — a studio token is unscoped, and a folder
        // snapshot naming `_books/` would be one editor typo away
        if (!s || isInternalKey(source)) return jsonErr('Unauthorized', 401);
        if (isPickShare(s)) {
          // previews and originals are two checks (docs/delivery.md)
          const scope = pickReadScope(s);
          if (!pickKeyAllowed({ folders: scope.preview }, source)) return jsonErr('Unauthorized', 401);
          original = pickKeyAllowed({ folders: scope.full }, source);
          // A proof original (not a final) is the seat owner's alone, even with the switch on: the key rides in
          // the X-Picker-Key header only (an <img> or a plain link cannot send it, so those never get one).
          // A viewer, a collaborator or anyone without the key keeps the thumbnails; the finals are unchanged.
          if (original && !pickKeyAllowed({ folders: scope.finals }, source)) {
            const seat = request.headers.get('X-Picker-Key') ? await resolvePick(s, request, env) : null;
            original = !!seat && seat.isOwner;
            ownerKeyed = true;
          }
        } else if (!(isStudioShare(s) || shareCovers(s, source))) {
          return jsonErr('Unauthorized', 401);
        }
        photos = bucketFor(env, shareOwner(s));
        await touchShareToken(s, request, env);
        viaShare = true;
      }

      // ?w=N serves a pre-generated thumbnail (written at upload time) when one
      // exists, falling back to the original so old uploads keep working —
      // unless the original is not this reader's to have: then a photo with
      // no thumbnail is a 404, and asking for the original itself is a 403.
      const wanted = parseInt(params.get('w'), 10);
      const thumbs = !download && Number.isFinite(wanted) && wanted > 0 && !key.startsWith(THUMB_PREFIX);
      if (!original && !isThumb && !thumbs) {
        return jsonOk({ error: '原檔未開放下載', code: 'original_not_allowed' }, 403, SHARED_LINK_HEADERS);
      }
      const candidates = [];
      if (thumbs) candidates.push(...thumbCandidates(wanted, key));
      if (original || isThumb) candidates.push(key);

      for (const candidate of candidates) {
        const isLast = candidate === candidates[candidates.length - 1];
        const object = await photos.get(candidate, {
          onlyIf: request.headers,
          range: request.headers
        });
        if (!object) {
          if (isLast) return new Response('Object Not Found', { status: 404, headers: corsHeaders });
          continue; // no thumbnail for this key yet — fall back to the original
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        // Never a page (security review of batch 3): no sniffing, a CSP that
        // runs nothing if opened directly, and anything not stored as an
        // inline image type (a legacy text/html or SVG upload, a HEIC or
        // TIFF original) as an opaque download. On every response below:
        // 200, 206 and 304, original, thumbnail and ?download=1.
        // A legacy object under a key the picker lists (.jpg/.jpeg/.png/.webp/
        // .avif — of the original, for a thumbnail) goes out as that
        // extension's own image type: with nosniff the browser renders it as
        // that image or not at all, and the grid keeps working.
        if (!INLINE_IMAGE_TYPES.includes(bareType(headers.get('Content-Type')))) {
          const listed = UPLOAD_TYPES[keyExtension(sourceKey(candidate))];
          if (listed && INLINE_IMAGE_TYPES.includes(listed.own)) {
            headers.set('Content-Type', listed.own);
          } else {
            headers.set('Content-Type', OCTET_STREAM);
            headers.set('Content-Disposition', attachmentDisposition(key));
          }
        }
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
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
        headers.set('Vary', viaShare ? (ownerKeyed ? 'X-Share-Token, X-Picker-Key' : 'X-Share-Token') : 'Authorization');
        if (download) headers.set('Content-Disposition', attachmentDisposition(key));

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
