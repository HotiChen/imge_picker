// Retention for the encrypted D1 backups on Google Drive
// (.github/workflows/d1-backup.yml, docs/backup.md).
//
//   node worker/tools/prune-backups.mjs <remote:folder> <just-uploaded-name>
//
// Deletes (Drive: moves to the trash) a backup only when ALL hold:
//   - its name is exactly imagepicker-db-YYYYMMDDTHHMMSSZ.sql.enc (anything
//     else in the folder is never touched);
//   - it is not one of the newest KEEP (12) backups;
//   - it is at least MIN_AGE_DAYS (90) days old by the time in its name;
//   - the newest backup in the folder is the one this run just uploaded and
//     verified (otherwise nothing is deleted at all);
//   - at most MAX_DELETES (4) per run.
// rclone is called with argument arrays (no shell).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KEEP = 12;
export const MIN_AGE_DAYS = 90;
export const MAX_DELETES = 4;
const NAME = /^imagepicker-db-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sql\.enc$/;

export function stampOf(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  // reject 20261340T… and the like (Date.UTC would roll them over)
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h) return null;
  return t;
}

export function planPrune(names, { now, justUploaded, keep = KEEP, minAgeDays = MIN_AGE_DAYS, maxDeletes = MAX_DELETES }) {
  const backups = [...new Set(names)].filter(n => stampOf(n) != null).sort();
  if (!backups.length || backups[backups.length - 1] !== justUploaded) {
    throw new Error(`最新的備份不是這次剛上傳的 ${justUploaded}：為了安全，不刪任何舊備份`);
  }
  if (backups.some(n => stampOf(n) > now + 86400e3)) {
    throw new Error('有備份檔名的時間在未來：為了安全，不刪任何舊備份');
  }
  if (backups.length <= keep) return [];
  const minAge = minAgeDays * 86400e3;
  return backups
    .slice(0, backups.length - keep)
    .filter(n => now - stampOf(n) >= minAge)
    .slice(0, maxDeletes);
}

function rclone(args) {
  return execFileSync('rclone', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
const list = remote => rclone(['lsf', '--files-only', '--max-depth', '1', remote]).split('\n').map(s => s.trim()).filter(Boolean);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [remote, justUploaded] = process.argv.slice(2);
  if (!remote || !justUploaded || !remote.endsWith('/')) {
    console.error('usage: node worker/tools/prune-backups.mjs <remote:folder/> <just-uploaded-name>');
    process.exit(2);
  }
  const before = list(remote);
  let doomed;
  try {
    doomed = planPrune(before, { now: Date.now(), justUploaded });
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
  const count = before.filter(n => stampOf(n) != null).length;
  console.log(`雲端現有 ${count} 份備份；保留最新 ${KEEP} 份，刪除超過 ${MIN_AGE_DAYS} 天的較舊備份：${doomed.length} 份`);
  for (const n of doomed) {
    rclone(['deletefile', remote + n]);
    console.log(`已移到垃圾桶：${n}`);
  }
  const after = list(remote).filter(n => stampOf(n) != null).length;
  if (after < Math.min(count, KEEP)) {
    console.log(`::error::刪除後只剩 ${after} 份備份（預期至少 ${Math.min(count, KEEP)}）`);
    process.exit(1);
  }
}
