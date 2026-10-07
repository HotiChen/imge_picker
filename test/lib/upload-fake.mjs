// A fake Worker for upload.html: the folder listing plus PUT /<encoded key>, with a scripted outcome per
// attempt of each ORIGINAL key. Thumbnail PUTs (_thumbs/...) always succeed and are recorded apart, so a
// test can tell "the photo was sent again" from "its thumbnails were sent again".
//   plan: { '<key>': [outcome, ...] }  outcome = 'ok' | 'abort' (network error) | <http status number>
//   an attempt past the end of the list succeeds. `plan` is live: a test may push more outcomes later.
export function uploadFake({ plan = {}, delayMs = 0, folders = ['shoot/'] } = {}) {
  const f = { plan, puts: [], thumbs: [], attempts: {}, inflight: 0, maxInflight: 0, hook: null };
  f.attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });
      if ((await req.allHeaders()).authorization !== 'Bearer adm') return json('{"error":"Unauthorized"}', 401);
      if (req.method() === 'GET' && u.searchParams.has('list')) return json(JSON.stringify({ folders }));
      if (req.method() !== 'PUT') return json('{}');
      const key = decodeURIComponent(u.pathname.slice(1));
      if (key.startsWith('_thumbs/')) { f.thumbs.push(key); return json('{"ok":true}'); }
      f.attempts[key] = (f.attempts[key] || 0) + 1;
      const outcome = (f.plan[key] || [])[f.attempts[key] - 1] ?? 'ok';
      f.puts.push({ key, n: f.attempts[key], outcome });
      f.inflight++; f.maxInflight = Math.max(f.maxInflight, f.inflight);
      try {
        if (f.hook) await f.hook(key, outcome);
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        if (outcome === 'abort') { try { await route.abort('failed'); } catch (e) { /* page already offline */ } return; }
        if (outcome === 'ok') return json('{"ok":true}');
        return json(JSON.stringify({ error: 'x' }), outcome);
      } finally { f.inflight--; }
    });
  };
  return f;
}
