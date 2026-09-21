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

function newShareToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
      // '' is what a fresh user row carries. Read as "everything" it would
      // open every other client's wedding, and read as "nothing" it is a
      // silent empty grid, so it is refused out loud instead.
      const folder = String(session.folder_path ?? '').trim();
      if (!folder) return jsonErr('尚未設定資料夾，請聯繫攝影師', 403);
      // stored and handed back slash-terminated, because the client lists this
      // string straight back as `?list=` and `20260819` is a different prefix
      // from `20260819/` — the first one also reaches 20260819-other/
      const folders = [folder.endsWith('/') ? folder : folder + '/'];
      const now = Date.now();
      // the token must not outlive the session it was traded for; a hand-edited
      // expiry the SQL above let past is refused rather than guessed at
      const sessionEnd = sessionExpiry(session.expires_at);
      if (!Number.isFinite(sessionEnd) || sessionEnd <= now) return jsonErr('Unauthorized', 401);
      const foldersJson = JSON.stringify(folders);
      // Keyed on the owner AND on the exact snapshot, so narrowing a client's
      // folder_path takes effect at their next page load rather than whenever
      // the old row happens to die. Two clients who share a folder still get a
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
      const { email, password, name } = body || {};
      if (!email || !password || !name) return jsonErr('email, password, name required');
      const emailLower = email.toLowerCase().trim();
      const hash = await hashPassword(password);
      try {
        const result = await env.DB.prepare(
          'INSERT INTO users (email, password_hash, name, approved) VALUES (?, ?, ?, 0)'
        ).bind(emailLower, hash, name.trim()).run();
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
        user: { id: user.id, email: user.email, name: user.name, folder_path: user.folder_path || '' },
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
        user: { id: session.uid, email: session.email, name: session.name, folder_path: session.folder_path || '' },
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
      const { results } = await env.DB.prepare(
        'SELECT u.id, u.email, u.name, u.folder_path, u.approved, u.created_at, p.can_book, p.can_upload FROM users u LEFT JOIN permissions p ON p.user_id = u.id ORDER BY u.created_at DESC'
      ).all();
      return jsonOk(results);
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
      const { can_book, can_upload, folder_path } = body || {};
      await env.DB.prepare(
        'INSERT INTO permissions (user_id, can_book, can_upload) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET can_book = excluded.can_book, can_upload = excluded.can_upload'
      ).bind(userId, can_book ? 1 : 0, can_upload ? 1 : 0).run();
      if (folder_path !== undefined) {
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
        if (!bookShare || isMintedShare(bookShare) || bookShare.book_id !== bookId) {
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
