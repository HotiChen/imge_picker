// Checks a plain D1 export (.github/workflows/d1-backup.yml, docs/backup.md).
// Prints table names and counts of problems only, never a row's content.
//
//   node worker/tools/verify-backup.mjs gate  <backup.sql>
//     Before encrypting/uploading: the file is big enough, has CREATE TABLE
//     for every core table and at least one projects row. Exit 1 otherwise.
//   node worker/tools/verify-backup.mjs drill <backup.sql>
//     Restore drill: loads the file into an in-memory SQLite database, checks
//     the core tables came back, then runs worker/tools/check-migrations.sql
//     on the copy. Exit 1 if it does not load or a core table is missing.
//     A migration the copy lacks is only a warning (the backup is still good).
import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const CORE_TABLES = ['projects', 'share_tokens', 'selections', 'pickers', 'submissions', 'studio_settings'];
export const MIN_BYTES = 10 * 1024; // the schema alone is larger than this

const ID = t => `["\`\\[]?${t}["\`\\]]?`;

export function gateCheck(text, size) {
  const errors = [];
  if (!(size >= MIN_BYTES)) errors.push(`備份檔太小（${size} bytes，下限 ${MIN_BYTES}）`);
  if (!/CREATE TABLE/i.test(text)) errors.push('備份檔沒有任何 CREATE TABLE');
  for (const t of CORE_TABLES) {
    if (!new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${ID(t)}\\s*\\(`, 'i').test(text)) errors.push(`備份檔缺少核心表 ${t}`);
  }
  if (!new RegExp(`INSERT INTO\\s+${ID('projects')}[\\s(]`, 'i').test(text)) errors.push('備份檔沒有任何 projects 資料列');
  return errors;
}

export function drill(text, checkSql) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(text);
  } catch (e) {
    return { errors: [`無法載入備份檔（SQLite: ${String(e.message).slice(0, 200)}）`], tables: 0, missing: [] };
  }
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const errors = CORE_TABLES.filter(t => !names.has(t)).map(t => `載入後缺少核心表 ${t}`);
  if (names.has('projects') && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n < 1) errors.push('載入後 projects 沒有任何資料');
  const missing = db.prepare(checkSql.trim().replace(/;$/, '')).all().map(r => ({ ...r }));
  db.close();
  return { errors, tables: names.size, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, file] = process.argv.slice(2);
  if (!['gate', 'drill'].includes(mode) || !file) {
    console.error('usage: node worker/tools/verify-backup.mjs gate|drill <backup.sql>');
    process.exit(2);
  }
  let errors;
  if (mode === 'gate') {
    let size = 0;
    try { size = statSync(file).size; } catch { /* reported below */ }
    errors = size ? gateCheck(readFileSync(file, 'utf8'), size) : ['備份檔不存在或是空的'];
    if (!errors.length) console.log(`完整性檢查通過（${size} bytes，核心表 ${CORE_TABLES.length} 張都在）`);
  } else {
    const r = drill(readFileSync(file, 'utf8'), readFileSync(new URL('./check-migrations.sql', import.meta.url), 'utf8'));
    errors = r.errors;
    console.log(`還原演練：載入 ${r.tables} 張表`);
    for (const m of r.missing) console.log(`::warning::正式庫缺少 migration 項目：${m.missing}（${m.from_file}）`);
    if (!r.missing.length) console.log('migration 檢查：0 項缺少（全部都跑過）');
  }
  for (const e of errors) console.log(`::error::${e}`);
  process.exit(errors.length ? 1 : 0);
}
