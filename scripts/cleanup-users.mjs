#!/usr/bin/env node
/**
 * 清理冒烟/测试账号（scripts/*-smoke.js 造的那些）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cleanup-users.mjs --dry-run          # 只列出会被删的账号
 *   node scripts/cleanup-users.mjs                    # 真删（smoke_ / lock_ / adm_ / usr_）
 *   node scripts/cleanup-users.mjs --prefix test_,tmp_
 *
 * 只按昵称前缀匹配；demo、Liuminghua 这种正常账号不会被误删。
 * 删除账号会连带清掉它的 refresh token；审计日志会保留。
 */
import { env } from '../apps/game-server/src/env.js';
import { initDb, getDb } from '../apps/game-server/src/users/db.js';
import { listUsers } from '../apps/game-server/src/users/userStore.js';

const DEFAULT_PREFIXES = ['smoke_', 'lock_', 'adm_', 'usr_', 'stat_', 'rb_', 'probe_'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const prefixArg = args.includes('--prefix') ? String(args[args.indexOf('--prefix') + 1] ?? '') : '';
const prefixes = (prefixArg ? prefixArg.split(',') : DEFAULT_PREFIXES)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!prefixes.length) {
  console.error('[错误] --prefix 不能为空');
  process.exit(1);
}

initDb(env.AUTH_DB_PATH);

const users = listUsers({ limit: 10000 });
const matched = users.filter((u) => prefixes.some((p) => String(u.nickname).toLowerCase().startsWith(p)));

if (!matched.length) {
  console.log(`没有匹配的账号（前缀：${prefixes.join(', ')}）`);
  process.exit(0);
}

console.log(`匹配 ${matched.length} 个账号（前缀：${prefixes.join(', ')}）：`);
for (const u of matched) {
  console.log(`  - ${u.nickname}${u.role === 'admin' ? ' [admin]' : ''}${u.disabled ? ' [disabled]' : ''}`);
}

if (dryRun) {
  console.log('\n--dry-run：没有删除任何东西');
  process.exit(0);
}

const db = getDb();
const delTokens = db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?');
const delUser = db.prepare('DELETE FROM users WHERE id = ?');
let removed = 0;
for (const u of matched) {
  delTokens.run(u.id);
  delUser.run(u.id);
  removed += 1;
}
console.log(`\n已删除 ${removed} 个账号（刷新令牌一并清理）`);
