// Generates worker/tools/check-migrations.sql: one read-only SELECT that lists
// every table, ALTER TABLE … ADD COLUMN column and index that worker/schema.sql
// and worker/migrations/*.sql expect but the database does not have.
// An empty result = every migration has been run. Each row names the file to
// run (from_file) so the missing piece can be pasted into the D1 Console.
//
//   node worker/tools/gen-migration-check.mjs           rewrite the .sql file
//   node worker/tools/gen-migration-check.mjs --check   exit 1 if it is stale
//
// Attribution: the earliest migration that creates the table / adds the
// column / creates the index; schema.sql only for what no migration has
// (the base tables, and indexes that only schema.sql declares).
// A column of a table that is missing is not listed: the table row says it.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER = new URL('../', import.meta.url);
export const OUTPUT = new URL('./check-migrations.sql', import.meta.url);

// Drop -- comments and split into statements, both outside '…' / "…" only.
export function statements(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const ID = '["`\\[]?(\\w+)["`\\]]?';
const RE_TABLE = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i');
const RE_COLUMN = new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+ADD\\s+(?:COLUMN\\s+)?${ID}`, 'i');
const RE_INDEX = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}\\s+ON\\s+${ID}`, 'i');

// sources: [{file, sql}] in the order they are attributed (migrations by name, then schema.sql).
// Returns [{file, kind: 'table'|'column'|'index', table, name}] in display order:
// schema.sql first, then the migrations by name; within a file, as written.
export function expectedItems(sources) {
  const seen = new Map();
  for (const { file, sql } of sources) {
    if (!/^[\w.-]+\.sql$/.test(file)) throw new Error(`unexpected file name: ${file}`);
    for (const st of statements(sql)) {
      let m, key, item;
      if ((m = RE_TABLE.exec(st))) {
        key = `table:${m[1].toLowerCase()}`;
        item = { file, kind: 'table', table: m[1], name: null };
      } else if ((m = RE_COLUMN.exec(st))) {
        key = `column:${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
        item = { file, kind: 'column', table: m[1], name: m[2] };
      } else if ((m = RE_INDEX.exec(st))) {
        key = `index:${m[1].toLowerCase()}`;
        item = { file, kind: 'index', table: m[2], name: m[1] };
      } else continue;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  const order = new Map(sources.map((s, i) => [s.file, i]));
  const items = [...seen.values()];
  const pos = new Map(items.map((it, i) => [it, i]));
  const rank = f => (f === 'schema.sql' ? -1 : order.get(f));
  return items.sort((a, b) => rank(a.file) - rank(b.file) || pos.get(a) - pos.get(b));
}

export function readSources(dir = WORKER) {
  const migDir = new URL('migrations/', dir);
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
  return [
    ...files.map(file => ({ file, sql: readFileSync(new URL(file, migDir), 'utf8') })),
    { file: 'schema.sql', sql: readFileSync(new URL('schema.sql', dir), 'utf8') },
  ];
}

const lit = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

export function renderSql(items) {
  const counts = { table: 0, column: 0, index: 0 };
  for (const it of items) counts[it.kind]++;
  const rows = items.map((it, i) => `  (${i + 1}, ${lit(it.file)}, ${lit(it.kind)}, ${lit(it.table)}, ${lit(it.name)})`);
  return `-- 檢查 migration 是否都跑過（自動產生，不要手改）：
--   node worker/tools/gen-migration-check.mjs
-- 用法：整段貼到 Cloudflare D1 Console（imagepicker-db）執行。只讀，不會改任何資料。
-- 結果是空的（0 列）= 全部都跑過了。
-- 每一列是一個缺少的項目；from_file = 要去 D1 Console 逐條執行的 worker/migrations/ 檔案
-- （schema.sql = 基本表，或只寫在 worker/schema.sql 的索引：索引可直接複製 schema.sql 裡那一行
--   CREATE INDEX IF NOT EXISTS … 執行；缺「表」請先問開發者，不要自己建）。
-- 表不存在時只列「表」，不再列它的欄位。
-- 檢查項目：${counts.table} 張表、${counts.column} 個 ALTER 欄位、${counts.index} 個索引。
WITH expected(n, from_file, kind, tbl, name) AS (VALUES
${rows.join(',\n')}
)
SELECT e.from_file AS from_file,
       CASE e.kind
         WHEN 'table' THEN '表 ' || e.tbl
         WHEN 'column' THEN '欄位 ' || e.tbl || '.' || e.name
         ELSE '索引 ' || e.name || '（' || e.tbl || '）'
       END AS missing
  FROM expected e
 WHERE CASE e.kind
         WHEN 'table' THEN NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'table' AND m.name = e.tbl COLLATE NOCASE)
         WHEN 'column' THEN EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'table' AND m.name = e.tbl COLLATE NOCASE)
                        AND NOT EXISTS (SELECT 1 FROM pragma_table_info(e.tbl) p WHERE p.name = e.name COLLATE NOCASE)
         ELSE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'index' AND m.name = e.name COLLATE NOCASE)
       END
 ORDER BY e.n;
`;
}

export const generate = (dir = WORKER) => renderSql(expectedItems(readSources(dir)));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sql = generate();
  if (process.argv.includes('--check')) {
    const cur = readFileSync(OUTPUT, 'utf8');
    if (cur !== sql) {
      console.error('worker/tools/check-migrations.sql is stale: run node worker/tools/gen-migration-check.mjs');
      process.exit(1);
    }
    console.log('check-migrations.sql is up to date');
  } else {
    writeFileSync(OUTPUT, sql);
    console.log(`wrote ${fileURLToPath(OUTPUT)}`);
  }
}
