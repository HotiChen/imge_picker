// Minimal stand-ins for the R2 and D1 bindings the Worker receives at runtime.
// They mimic the parts of the real API the Worker actually depends on —
// notably that R2 get() returns an object WITHOUT a `body` property when an
// onlyIf precondition fails, and that list() is capped and cursor-paginated.

export function fakeBucket(initial = {}, { pageSize = 1000 } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, entry(k, v)]));

  function entry(key, value, contentType = 'image/jpeg') {
    const body = typeof value === 'string' ? value : value.body;
    return {
      key,
      body,
      contentType: typeof value === 'string' ? contentType : (value.contentType || contentType),
      uploaded: new Date('2026-01-01T00:00:00Z'),
    };
  }

  return {
    _store: store,

    async get(key, opts = {}) {
      const rec = store.get(key);
      if (!rec) return null;
      const etag = `"${key}-v1"`;
      const meta = {
        key,
        httpEtag: etag,
        size: rec.body.length,
        uploaded: rec.uploaded,
        writeHttpMetadata(headers) { headers.set('Content-Type', rec.contentType); },
      };

      const ifNoneMatch = opts.onlyIf?.get?.('If-None-Match');
      if (ifNoneMatch && ifNoneMatch === etag) return meta; // no `body` key at all

      // R2ObjectBody also exposes these, and the book routes rely on them
      const withBody = body => ({
        ...meta,
        body,
        async text() { return body; },
        async json() { return JSON.parse(body); },
        async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
      });

      const rangeHeader = opts.range?.get?.('Range');
      const m = rangeHeader && /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : rec.body.length - 1;
        return {
          ...withBody(rec.body.slice(start, end + 1)),
          range: { offset: start, length: end - start + 1 },
        };
      }
      return withBody(rec.body);
    },

    async put(key, value, opts = {}) {
      // the upload route hands us request.body (a stream), the book routes a string
      const text = typeof value === 'string' ? value : await new Response(value).text();
      store.set(key, entry(key, { body: text, contentType: opts.httpMetadata?.contentType }));
      return { key };
    },

    async list({ prefix = '', delimiter, cursor } = {}) {
      const objects = [];
      const prefixSet = new Set();
      for (const [key, rec] of store) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (delimiter && rest.includes(delimiter)) {
          prefixSet.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
        } else {
          objects.push({ key, size: rec.body.length, uploaded: rec.uploaded });
        }
      }
      objects.sort((a, b) => a.key.localeCompare(b.key));

      const start = cursor ? Number(cursor) : 0;
      const page = objects.slice(start, start + pageSize);
      const nextStart = start + page.length;
      const truncated = nextStart < objects.length;
      return {
        objects: page,
        // real R2 only reports delimited prefixes it saw on this page; the
        // Worker accumulates across pages, so returning them each time is fine
        delimitedPrefixes: [...prefixSet].sort(),
        truncated,
        cursor: truncated ? String(nextStart) : undefined,
      };
    },
  };
}

export function makeEnv(overrides = {}) {
  return {
    imagepicker: fakeBucket(),
    ...overrides,
  };
}

export const ctx = { waitUntil() {} };

export function req(path, { method = 'GET', headers = {}, body, token } = {}) {
  const h = new Headers(headers);
  if (token) h.set('Authorization', `Bearer ${token}`);
  return new Request(`https://worker.test${path}`, { method, headers: h, body });
}
