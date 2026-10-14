// Fake Worker for deleting one photo from the photographer's file view, mirroring worker.js:
//   DELETE /api/admin/photo?key=   deletePhoto  (401 Unauthorized without the token; 400 invalid_key for an empty key or
//                                   a folder; 404 {error:'Not found'}; 409 {error, code, deleted:[]}; 500
//                                   photo_lock_unavailable / photo_delete_failed; 200 {ok, key, deleted:[key, thumbs…], failed?})
//   GET    /api/admin/photo/lock?key=  photoLockReport  ({key, deletable, code, error}; same 400 / 404 / 500)
// The key is read from the QUERY (searchParams decodes it once, like the Worker's URL parsing), so a key sent
// unencoded (+ # & % ?) arrives as something else and the test notices. Also serves the folder listing (live: a deleted
// file leaves it), the studio-token mint and a pixel for every image.
import { PIXEL } from './env.mjs';
import { delimitedListFake } from './pick-fake.mjs';

// worker.js PHOTO_LOCKS, verbatim
export const PHOTO_LOCKS = {
  photo_locked_delivered: '這張照片在已交件的專案資料夾裡，不能刪除（要刪請先取消交件或開放修改）',
  photo_locked_archived: '這張照片在已封存的專案資料夾裡，不能刪除',
  photo_in_pick_folder: '這張照片在選片資料夾裡，客人可能已經選了它，不能刪除',
  photo_in_round: '這張照片在客人送出的選片或修改紀錄裡，不能刪除',
  photo_in_order: '這張照片在訂單裡（含已取消的訂單），不能刪除',
  photo_in_album: '這張照片已放進相本，不能刪除',
};
const UNAVAILABLE = { error: '現在無法確認這張照片能不能刪除，所以沒有刪除任何東西', code: 'photo_lock_unavailable', deleted: [] };
const NOT_DONE = { error: '刪除沒有完成，沒有刪除任何東西，請再試一次', code: 'photo_delete_failed', deleted: [], failed: [] };

export function photoDeleteFake({ files = [], folder = 'shoot/', token = 'adm', locks = {}, names = {} } = {}) {
  const st = {
    files: [...files],
    locks: { ...locks },            // key -> lock code
    lockMode: 'normal',             // 'normal' | 'error' (503 html) | 'abort' (connection dropped) | 'unavailable'
    deleteMode: 'normal',           // 'normal' | 'unauthorized' | 'unavailable' | 'failed' | 'abort'
    failedThumbs: null,             // answer 200 with this `failed` list
    delay: 0,                       // ms before the DELETE answers
    calls: [],                      // every /api/admin/photo* request: {method, rawUrl, path, key, auth}
    listAuth: [],
  };
  const deletes = () => st.calls.filter(c => c.method === 'DELETE');
  const locksSeen = () => st.calls.filter(c => c.method === 'GET');

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
      const json = (body, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

      if (u.pathname === '/api/auth/studio-token')
        return json({ token: 'STUDIO-1', expires_at: new Date(Date.now() + 12 * 3600000).toISOString() });

      if (u.pathname === '/api/admin/photo' || u.pathname === '/api/admin/photo/lock') {
        const lock = u.pathname.endsWith('/lock');
        const key = u.searchParams.get('key');
        st.calls.push({ method: req.method(), rawUrl: req.url(), path: u.pathname, key, auth: h['authorization'] ?? null });
        if (h['authorization'] !== `Bearer ${token}`) return json({ error: 'Unauthorized' }, 401);
        if (req.method() !== (lock ? 'GET' : 'DELETE')) return json({ error: 'Method not allowed' }, 405);
        if (lock) {
          if (st.lockMode === 'abort') return route.abort();
          if (st.lockMode === 'error') return route.fulfill({ status: 503, contentType: 'text/html', headers: cors, body: '<h1>oops</h1>' });
          if (st.lockMode === 'unavailable') return json(UNAVAILABLE, 500);
        } else {
          if (st.delay) await new Promise(r => setTimeout(r, st.delay));
          if (st.deleteMode === 'unauthorized') return json({ error: 'Unauthorized' }, 401);
          if (st.deleteMode === 'abort') return route.abort();
        }
        if (!key || key.endsWith('/')) return json({ error: 'Invalid key', code: 'invalid_key' }, 400);
        if (!st.files.includes(key)) return json({ error: 'Not found' }, 404);
        if (!lock && st.deleteMode === 'unavailable') return json(UNAVAILABLE, 500);
        if (!lock && st.deleteMode === 'failed') return json({ ...NOT_DONE, failed: [key] }, 500);
        const code = st.locks[key] || null;
        if (lock) return json({ key, deletable: !code, code, error: code ? PHOTO_LOCKS[code] : null });
        if (code) return json({ error: PHOTO_LOCKS[code], code, deleted: [] }, 409);
        st.files = st.files.filter(f => f !== key);
        return json({
          ok: true, key, deleted: [key, `_thumbs/400/${key}.thumb`],
          ...(st.failedThumbs ? { failed: st.failedThumbs } : {}),
        });
      }

      if (u.searchParams.has('list')) {
        st.listAuth.push(h['authorization'] ?? null);
        const { data, folders } = delimitedListFake(st.files, u.searchParams.get('list'));
        return json({ status: 'success', data: data.map(d => ({ ...d, name: names[d.id] ?? d.name })), folders });
      }
      if (u.pathname.endsWith('/status')) return json({ approved: false });
      route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PIXEL });
    });
  };
  return { st, attach, deletes, locksSeen, folder };
}
