#!/usr/bin/env node
/**
 * 备份用户库（SQLite）。用 `VACUUM INTO` 做一致性快照，服务运行中也能安全执行。
 *
 * 用法（仓库根目录）：
 *   node scripts/backup-db.mjs                 # 备份到 var/backups/
 *   node scripts/backup-db.mjs D:\backups      # 指定目录
 *   BACKUP_KEEP=30 node scripts/backup-db.mjs  # 只保留最近 30 份（默认 14）
 *
 * 建议：Linux 上用 cron 每天跑一次，例如
 *   0 4 * * * cd /srv/2nkpoker && /usr/bin/node scripts/backup-db.mjs >> var/backup.log 2>&1
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../apps/game-server/src/env.js';
import { initDb } from '../apps/game-server/src/users/db.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dbPath = resolve(env.AUTH_DB_PATH);
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'var/backups'));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const target = join(outDir, `2nkpoker-${stamp}.db`);

mkdirSync(outDir, { recursive: true });

// 打开（并确保 schema 存在）后做快照；VACUUM INTO 生成的是紧凑的独立文件
initDb(dbPath);
const db = new DatabaseSync(dbPath);
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = (statSync(target).size / 1024).toFixed(1);
console.log(`[备份] ${dbPath}`);
console.log(`[备份] → ${target}（${size} KB）`);

// 清理旧备份：按文件名倒序保留 keep 份
const old = readdirSync(outDir)
  .filter((n) => /^2nkpoker-\d{8}-\d{6}\.db$/.test(n))
  .sort()
  .reverse()
  .slice(keep);
for (const name of old) {
  rmSync(join(outDir, name));
  console.log(`[备份] 删除旧备份 ${name}`);
}
console.log(`[备份] 保留最近 ${keep} 份`);
