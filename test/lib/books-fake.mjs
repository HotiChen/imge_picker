// The Worker's album routes, for the suites that import a guest layout into book_editor (test/suites/99v-import-layout.mjs):
//   PUT /api/books/:id   Bearer must be the photographer's token (401), body must be JSON (400 invalid_book) and pass the
//                        Worker's own book check (worker.js bookContentProblem / bookPhotoIdSafe / bookCropValid, copied
//                        below with the same ranges; a node test, test/unit/import-layout.test.mjs, runs the real function
//                        on the same books), then it is stored byte for byte -> {ok: true, id}.
//   GET /api/books/:id   the stored text (Bearer required), 404 when none.   GET .../status -> {approved: false}.
// And, for a tab that opens book_editor on such a book: the studio-token mint, `?list=` (empty), and every other path =
// the 1x1 PIXEL, so the editor's thumbnails resolve. Attach on the CONTEXT so a new tab is covered too.
import { PIXEL } from './env.mjs';

const UNSAFE_KEY_CHAR = /["<>`\\\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
const keySafe = id => typeof id === 'string' && id.length <= 1024 && !UNSAFE_KEY_CHAR.test(id);
const CROP_RANGE = { x: [-1000, 1000], y: [-1000, 1000], scale: [0, 1000], rotation: [-1e6, 1e6] };
const cropValid = c => {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return false;
  for (const [k, v] of Object.entries(c)) {
    if (!Object.hasOwn(CROP_RANGE, k)) return false;
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < CROP_RANGE[k][0] || v > CROP_RANGE[k][1]) return false;
  }
  return true;
};
export function bookProblem(book) {
  if (book === null || typeof book !== 'object' || Array.isArray(book)) return 'invalid_book';
  if (book.pages === undefined) return null;
  if (!Array.isArray(book.pages)) return 'invalid_book';
  const ok = id => !id || keySafe(id);
  for (const page of book.pages) {
    if (!page || typeof page !== 'object') continue;
    if (page.bgImage && !ok(page.bgImage.photoId)) return 'invalid_photo_id';
    if (page.slots === undefined || page.slots === null) continue;
    if (!Array.isArray(page.slots)) return 'invalid_book';
    for (const slot of page.slots) {
      if (!slot || typeof slot !== 'object') continue;
      if (!ok(slot.photoId)) return 'invalid_photo_id';
      if (slot.crop !== undefined && slot.crop !== null && !cropValid(slot.crop)) return 'invalid_crop';
    }
  }
  return null;
}

// opts.token: the Bearer the PUT/GET need (default 'adm', what SEED_TOKEN stores).
// st.putStatus: when set, every PUT answers that status and stores nothing (st.putStatus = 500 for the failure path).
// st.putDelay: ms to hold every PUT (double-press tests).
export function booksFake(opts = {}) {
  const st = { token: opts.token || 'adm', puts: [], gets: [], books: new Map(), putStatus: null, putDelay: 0, mints: 0 };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const makeHandler = images => async route => {
    const req = route.request();
    const u = new URL(req.url());
    const parts = u.pathname.split('/').filter(Boolean);
    const auth = (await req.allHeaders())['authorization'] || '';
    if (u.pathname === '/api/auth/studio-token' && req.method() === 'POST') {
      st.mints++;
      return json(route, 200, { token: 'STUDIO-TOK', expires_at: new Date(Date.now() + 12 * 3600000).toISOString() });
    }
    if (parts[0] === 'api' && parts[1] === 'books' && parts[2] && !parts[4]) {
      const id = decodeURIComponent(parts[2]);
      if (parts[3] === 'status') return json(route, 200, { approved: false });
      if (parts[3]) return route.fallback();
      if (req.method() === 'PUT') {
        const text = req.postData() || '';
        st.puts.push({ id, auth, text, contentType: (await req.allHeaders())['content-type'] || '' });
        if (st.putDelay) await new Promise(r => setTimeout(r, st.putDelay));
        if (st.putStatus) return json(route, st.putStatus, { error: 'fake failure' });
        if (auth !== `Bearer ${st.token}`) return json(route, 401, { error: 'Unauthorized' });
        let book;
        try { book = JSON.parse(text); } catch { return json(route, 400, { error: '相本資料格式不正確', code: 'invalid_book' }); }
        const problem = bookProblem(book);
        if (problem) return json(route, 400, { error: problem, code: problem });
        st.books.set(id, text);
        return json(route, 200, { ok: true, id });
      }
      if (req.method() === 'GET') {
        st.gets.push({ id, auth });
        if (auth !== `Bearer ${st.token}`) return json(route, 401, { error: 'Unauthorized' });
        if (!st.books.has(id)) return route.fulfill({ status: 404, body: 'Not found' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: st.books.get(id) });
      }
      return route.fallback();
    }
    if (parts[0] === 'api') return route.fallback();
    if (u.searchParams.has('list')) return json(route, 200, { status: 'success', folders: [], data: [] });
    if (req.method() === 'GET' && images) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL, headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.fallback();
  };
  // images: false leaves non-API paths alone (the viewer page has its own thumbnail fake); the editor tab wants them (default)
  const attach = async (where, { images = true } = {}) => { await where.route('**/imagepicker.hotichen.workers.dev/**', makeHandler(images)); };
  return { st, attach };
}
