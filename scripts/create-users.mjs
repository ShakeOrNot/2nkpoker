#!/usr/bin/env node
/**
 * 批量建号（运维用）。适合一次开一批比赛账号。
 *
 * 用法（仓库根目录）：
 *   node scripts/create-users.mjs users.json
 *   node scripts/create-users.mjs users.json --force     # 跳过口令强度校验
 *
 * users.json 格式：
 *   [
 *     { "nickname": "zgz@2nkpoker.com", "password": "ZhaoGuanZeng" },
 *     { "nickname": "wyc@2nkpoker.com", "password": "WuYanChu" }
 *   ]
 *
 * 已存在的昵称会跳过（不会改口令）；--force 只影响"新口令不满足策略"的情况，
 * 例如 7 位口令。建议优先用符合策略的口令。
 */
import { readFileSync } from 'node:fs';
import { env } from '../apps/game-server/src/env.js';
import { initDb } from '../apps/game-server/src/users/db.js';
import { createUser, findByNickname, isValidNickname, touchLogin } from '../apps/game-server/src/users/userStore.js';
import { checkPasswordPolicy, hashPassword } from '../apps/game-server/src/auth/password.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('[错误] 用法：node scripts/create-users.mjs users.json [--force]');
  process.exit(1);
}

/** @type {Array<{ nickname: string, password: string }>} */
let input;
try {
  input = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`[错误] 读不了 ${file}：${err.message}`);
  process.exit(1);
}
if (!Array.isArray(input) || !input.length) {
  console.error('[错误] JSON 必须是非空数组：[{ "nickname": "...", "password": "..." }]');
  process.exit(1);
}

initDb(env.AUTH_DB_PATH);

let created = 0;
let skipped = 0;
const failed = [];

for (const entry of input) {
  const nickname = String(entry?.nickname ?? '').trim();
  const password = String(entry?.password ?? '');
  if (!isValidNickname(nickname)) {
    failed.push(`${nickname || '(空)'}：昵称不合法（2~20，字母/数字/中文/_/-/./@）`);
    continue;
  }
  if (findByNickname(nickname)) {
    console.log(`  - 跳过（已存在）：${nickname}`);
    skipped += 1;
    continue;
  }
  const policy = checkPasswordPolicy(password, nickname);
  if (!policy.ok && !force) {
    failed.push(`${nickname}：口令不满足策略（${policy.reason}），加 --force 可强制创建`);
    continue;
  }
  if (!policy.ok) console.log(`  ! ${nickname}：口令不满足策略（${policy.reason}），--force 仍然创建`);
  const passwordHash = await hashPassword(password);
  const user = createUser({ nickname, passwordHash });
  touchLogin(user.id);
  created += 1;
  console.log(`  + 已创建：${nickname}`);
}

console.log(`\n完成：新建 ${created}，跳过 ${skipped}，失败 ${failed.length}`);
if (failed.length) {
  for (const line of failed) console.error(`  x ${line}`);
  process.exit(1);
}
