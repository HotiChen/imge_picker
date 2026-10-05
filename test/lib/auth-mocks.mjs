// Worker mocks for the token suites and the admin page: share links, studio token, client session
// token, admin project list, registration shoot clients.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { PIXEL } from './env.mjs';
import { PHOTOS } from './editor-mocks.mjs';
import { delimitedListFake } from './pick-fake.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// Share tokens — the client album is gated, so the token has to ride along on
// every single request, and the photographer needs a way to issue and kill
// links. Clients open these links from a LINE chat message, so the token lives
// in the URL: it must survive a reload and must not be consumed on first load.
// ═══════════════════════════════════════════════════════════════════════════

export const SHARE_BOOK = {
  name: 'T', clientFolders: ['20260819/'],
  settings: { width: 57, height: 21, dpi: 300 },
  coverSettings: { width: 20, height: 20, dpi: 300 },
  pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
    slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
            { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }],
};

// Records what credential each request actually carried, which is the whole
// point: a src string that looks right but never reaches the Worker is
// exactly the bug this is here to catch.
export function shareMock(opts = {}) {
  const seen = [];
  const state = { shares: opts.shares ?? [], minted: opts.minted ?? 'MINT-TOKEN' };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      seen.push({
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        body: req.postData(),
      });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/studio-token')
        return json(JSON.stringify({ token: 'STUDIO-TOK',
          expires_at: new Date(Date.now() + 12 * 3600000).toISOString() }));
      if (req.method() === 'GET' && u.pathname.endsWith('/shares'))
        return json(JSON.stringify(state.shares));
      if (req.method() === 'POST' && u.pathname.endsWith('/share'))
        return json(JSON.stringify({ token: state.minted, expires_at: '2027-01-01T12:00:00.000Z' }));
      if (req.method() === 'POST' && /\/api\/shares\/.+\/revoke$/.test(u.pathname))
        return json('{"ok":true}');
      if (u.pathname.endsWith('/status')) return json('{"approved":false}');
      if (u.pathname.endsWith('/approve')) return json('{"ok":true}');
      if (u.pathname.includes('/api/books/')) {
        if (req.method() === 'GET') return json(JSON.stringify(SHARE_BOOK));
        return json('{"ok":true}');
      }
      if (u.searchParams.has('list'))
        return json(JSON.stringify({ status: 'success', folders: [], data: PHOTOS(3) }));
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}

// ═══════════════════════════════════════════════════════════════════════════
// Studio tokens — gating GET /<key> broke every photographer-facing page,
// because an <img> cannot send an Authorization header. The photographer now
// trades their real credential for a short-lived, read-only token that fits
// in a URL, and it rides in ?t= exactly like a client's.
//
// Everything below asserts on what actually reached the Worker. A src string
// that looks right but never arrives — or arrives naked and 401s before the
// "fixed" one goes out — is precisely the bug this is here to catch.
// ═══════════════════════════════════════════════════════════════════════════

export const STUDIO_BOOK = {
  name: 'T', clientFolders: ['20260819/'],
  settings: { width: 57, height: 21, dpi: 300 },
  coverSettings: { width: 20, height: 20, dpi: 300 },
  pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
    slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
            { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }],
};

// `ttlHours` is what the Worker says the minted token is good for; `mintStatus`
// stands in for a wrong PHOTOGRAPHER_TOKEN; `failPhotos` makes object reads
// 401 the way a dead token would.
export function studioMock(opts = {}) {
  const seen = [];
  const state = {
    ttlHours: opts.ttlHours ?? 12,
    mintStatus: opts.mintStatus ?? 200,
    // mints past this many succeed no more — 500, not 401, so it reads as
    // transient and nothing is allowed to remember it as a refusal
    mintFailAfter: opts.mintFailAfter ?? Infinity,
    // 'none' | 'first' (only the first read of each key) | 'all'
    failPhotos: opts.failPhotos ?? 'none',
    photos: opts.photos ?? 3,
    minted: [],
    reads: new Map(),
  };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      seen.push({
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        w: u.searchParams.get('w'),
      });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/studio-token') {
        if (state.mintStatus !== 200) return json('{"error":"Unauthorized"}', state.mintStatus);
        if (state.minted.length >= state.mintFailAfter) {
          state.minted.push(null);
          return json('{"error":"DB not configured"}', 500);
        }
        const token = `STUDIO-${state.minted.length + 1}`;
        state.minted.push(token);
        return json(JSON.stringify({
          token,
          expires_at: new Date(Date.now() + state.ttlHours * 3600000).toISOString(),
        }));
      }
      if (u.pathname.endsWith('/status')) return json('{"approved":false}');
      if (u.pathname.includes('/api/books/')) {
        if (req.method() === 'GET') return json(JSON.stringify(STUDIO_BOOK));
        return json('{"ok":true}');
      }
      if (u.searchParams.has('list'))
        return json(JSON.stringify({ status: 'success', folders: [], data: PHOTOS(state.photos) }));

      const n = (state.reads.get(u.pathname) || 0) + 1;
      state.reads.set(u.pathname, n);
      if (state.failPhotos === 'all' || (state.failPhotos === 'first' && n === 1))
        return json('{"error":"Unauthorized"}', 401);
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}
// Every project-detail section expanded (stored preference, see "區塊收合"): the admin suites below were written
// against a page that showed everything, and this is a photographer who has opened every section once.
export const ADMIN = () => {
  sessionStorage.setItem('studio_token', 'adm');
  try { for (const k of ['delivery', 'settings', 'selections', 'orders', 'submissions', 'people']) localStorage.setItem('pd_sec_' + k, '1'); } catch (e) { /* no storage */ }
};
// the token only: sections start at their defaults
export const ADMIN_PLAIN = () => sessionStorage.setItem('studio_token', 'adm');
export const CLIENT_FOLDER = '20260819/';

// Seeded once per browser context, not once per document: addInitScript runs
// on every navigation, and a session that grows back after the page deletes it
// would make client-login.html bounce straight back to index.html forever —
// a loop in the harness that says nothing about the product.
// (self-contained: an init script is serialised into the page, so it cannot
// close over anything defined out here)
export const CLIENT = () => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  sessionStorage.setItem('client_session', JSON.stringify({
    token: 'sess',
    user: { id: 7, email: 'c@example.com', name: '陳小姐', folder_path: '2026/去年' },
    permissions: { can_book: true, can_upload: true },
  }));
};

// A mock that refuses what the Worker refuses, so a tile cannot render and a
// listing cannot succeed on a credential the real thing would have thrown out.
export function clientMock(opts = {}) {
  const seen = [];
  const state = {
    mintStatus: opts.mintStatus ?? 200,
    mintError: opts.mintError ?? 'Unauthorized',
    folders: opts.folders ?? [CLIENT_FOLDER],
    ttlMinutes: opts.ttlMinutes ?? 60,
    // sessions the Worker knows; anything else is a 401 before mintStatus is
    // even consulted, exactly as an unknown token is
    sessions: opts.sessions ?? ['sess'],
    // which of those it refuses with mintStatus/mintError. A second, accepted
    // session is how a test tells "never asks again" from "never asks again
    // about this one".
    refuse: opts.refuse ?? ((opts.mintStatus && opts.mintStatus !== 200) ? ['sess'] : []),
    // mints past this many fail with a 500 — transient, so nothing may write
    // it off as a refusal
    mintFailAfter: opts.mintFailAfter ?? Infinity,
    // …and past this many, 401: the session died under a page that already
    // has a token, which is the only way to reach that branch without the
    // redirect the first-mint case triggers
    refuseAfter: opts.refuseAfter ?? Infinity,
    // 'none' | 'first' (only the first read of each key) | 'all'
    failPhotos: opts.failPhotos ?? 'none',
    photos: opts.photos ?? 3,
    minted: [],
    reads: new Map(),
  };
  const covers = p => typeof p === 'string' &&
    state.folders.some(f => p === f || p.startsWith(f));
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const rec = {
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        w: u.searchParams.get('w'),
      };
      seen.push(rec);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/session-token') {
        // the Worker reads the session from a header and refuses ?t=
        const cred = /^Bearer (.+)$/.exec(rec.auth || '')?.[1] || '';
        if (!state.sessions.includes(cred)) return json('{"error":"Unauthorized"}', 401);
        if (state.refuse.includes(cred))
          return json(JSON.stringify({ error: state.mintError }), state.mintStatus);
        if (state.minted.filter(Boolean).length >= state.refuseAfter)
          return json('{"error":"Unauthorized"}', 401);
        if (state.minted.length >= state.mintFailAfter) {
          state.minted.push(null);
          return json('{"error":"DB not configured"}', 500);
        }
        const token = `SESSION-${state.minted.length + 1}`;
        state.minted.push(token);
        return json(JSON.stringify({
          token,
          expires_at: new Date(Date.now() + state.ttlMinutes * 60000).toISOString(),
          folders: state.folders,
        }));
      }
      if (u.pathname === '/api/auth/logout') return json('{"ok":true}');

      if (rec.list !== null) {
        if (!rec.share || !state.minted.includes(rec.share) || !covers(rec.list))
          return json('{"error":"Unauthorized"}', 401);
        // Nested subfolders (docs/backlog.md "Guest page hides subfolders"),
        // delimiter-listed exactly like worker.js's own R2 call — see
        // delimitedListFake.
        if (opts.clientFiles) {
          const { data, folders } = delimitedListFake(opts.clientFiles, rec.list);
          return json(JSON.stringify({ status: 'success', data, folders }));
        }
        // Distinct photos per folder, when a test needs to prove which one
        // actually loaded rather than just which sidebar row looks active.
        const data = opts.photosByFolder ? (opts.photosByFolder[rec.list] || []) : PHOTOS(state.photos);
        return json(JSON.stringify({ status: 'success', folders: [], data }));
      }

      const source = rec.path.replace(/^\//, '');
      if (!rec.t || !state.minted.includes(rec.t) || !covers(source))
        return json('{"error":"Unauthorized"}', 401);
      const n = (state.reads.get(rec.path) || 0) + 1;
      state.reads.set(rec.path, n);
      if (state.failPhotos === 'all' || (state.failPhotos === 'first' && n === 1))
        return json('{"error":"Unauthorized"}', 401);
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}

// ═══════════════════════════════════════════════════════════════════════════
// REVOKE ALL — the photographer's answer to "I think my password leaked".
// Rotating PHOTOGRAPHER_TOKEN does not reach a studio token already minted, so
// this is the only control that kills one. It deliberately spares the album
// links already sitting in clients' chats, and the page has to say so.
// ═══════════════════════════════════════════════════════════════════════════

export const MINTED_ROWS = [
  { token: 'STUDIO-aaa', kind: 'studio', user_id: null, folders: '[]',
    created_at: '2026-09-21T00:00:00.000Z', expires_at: '2026-09-21T12:00:00.000Z' },
  { token: 'STUDIO-bbb', kind: 'studio', user_id: null, folders: '[]',
    created_at: '2026-09-21T05:00:00.000Z', expires_at: '2026-09-21T17:00:00.000Z' },
  { token: 'SESSION-ccc', kind: 'session', user_id: 7, folders: '["20260819/"]',
    created_at: '2026-09-21T06:00:00.000Z', expires_at: '2026-09-21T07:00:00.000Z' },
];

export function adminMock(opts = {}) {
  const seen = [];
  const state = {
    rows: opts.rows ?? MINTED_ROWS, revoked: opts.revoked ?? 2,
    clients: opts.clients ?? [],
    tree: opts.tree ?? { '': ['20260819/', '20260901/'], '20260819/': ['20260819/Anita/'] },
  };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const rec = { path: u.pathname, method: req.method(), auth: h['authorization'] ?? null,
                    list: u.searchParams.get('list'), body: req.postData() };
      seen.push(rec);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });
      if (rec.auth !== 'Bearer adm') return json('{"error":"Unauthorized"}', 401);
      if (rec.list !== null) {
        // the folder picker browses the bucket through the listing route
        const kids = state.tree[rec.list] || [];
        return json(JSON.stringify({ status: 'success', data: [], folders: kids }));
      }
      if (u.pathname === '/api/admin/clients') return json(JSON.stringify(state.clients));
      if (u.pathname === '/api/shares/minted') return json(JSON.stringify(state.rows));
      if (u.pathname === '/api/shares/minted/revoke-all')
        return json(JSON.stringify({ ok: true, revoked: state.revoked }));
      return json('{}');
    });
  };
  return { seen, state, attach };
}

export const SHOOT_CLIENTS = [
  { id: 1, name: '王小明', email: 'w@b.c', approved: 1, can_book: 1, can_upload: 0,
    folder_path: '["20260819/"]', folders: ['20260819/'],
    shoot_date: '2026-08-19', shoot_type: '婚紗' },
  // every account that exists today: the columns are new, so both are empty
  { id: 2, name: '林先生', email: 'l@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '', shoot_type: '' },
  { id: 3, name: '陳小姐', email: 'c@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '未定', shoot_type: '寵物寫真' },
  // typed straight into the D1 console: neither a date nor 未定, and close
  // enough to one that a loose parse would read it as 2026-08-19
  { id: 4, name: '張太太', email: 'z@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '2026-08-19 上午', shoot_type: '' },
];
