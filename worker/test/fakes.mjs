import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

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

// D1 stand-in backed by Node's built-in SQLite, running the Worker's real
// schema.sql. A hand-rolled mock would happily accept a query the real D1
// rejects, so the tests would pass against SQL that cannot run in production.
export function fakeDB({ schema } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema ?? readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

  const sqlLog = [];
  let rowsChanged = 0;

  const normalise = v => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };

  const result = (stmt, sql, params) => ({
    async first() {
      sqlLog.push(sql);
      return stmt.get(...params) ?? null;
    },
    async all() {
      sqlLog.push(sql);
      return { success: true, results: stmt.all(...params) }; // D1 wraps rows in {results}
    },
    async run() {
      sqlLog.push(sql);
      const r = stmt.run(...params);
      rowsChanged += r.changes;
      return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  return {
    _db: db,
    _sql: sqlLog,
    _writes: () => sqlLog.filter(s => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)),
    // statements issued vs rows actually changed: under parallel requests only
    // the second is a meaningful bound
    _changed: () => rowsChanged,
    prepare(sql) {
      const stmt = db.prepare(sql); // throws on malformed SQL, exactly as D1 does
      return {
        bind(...args) { return result(stmt, sql, args.map(normalise)); },
        ...result(stmt, sql, []),
      };
    },
  };
}
