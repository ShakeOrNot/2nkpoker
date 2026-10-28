#!/usr/bin/env node
/**
 * 运维脚本：账号口令重置 / 角色 / 禁用（AI 不参与，人工执行）
 *
 * 用法（仓库根目录执行）：
 *   node apps/game-server/scripts/reset-password.mjs <昵称> <新口令>
 *   node apps/game-server/scripts/reset-password.mjs --make-admin <昵称>
 *   node apps/game-server/scripts/reset-password.mjs --disable <昵称>
 *   node apps/game-server/scripts/reset-password.mjs --enable <昵称>
 *   node apps/game-server/scripts/reset-password.mjs --list
 *
 * 口令改动会同时把 token_version +1 并撤销该账号所有刷新令牌，
 * 也就是说他其它设备上会立刻被踢下线。
 */
import { env } from '../src/env.js';
import { initDb } from '../src/users/db.js';
import { findByNickname, updatePassword, setRole, setDisabled, listUsers } from '../src/users/userStore.js';
import { checkPasswordPolicy, hashPassword } from '../src/auth/password.js';
import { revokeAllForUser } from '../src/auth/session.js';

initDb(env.AUTH_DB_PATH);

const args = process.argv.slice(2);
const fail = (msg) => {
  console.error(`[错误] ${msg}`);
  process.exit(1);
};

if (args.includes('--list')) {
  const users = listUsers(200);
  if (!users.length) console.log('（一个账号都没有）');
  for (const u of users) {
    console.log(`${u.nickname}\t${u.role}\t${u.disabled ? 'disabled' : 'active'}\ttv=${u.token_version}`);
  }
  process.exit(0);
}

const flag = args.find((a) => a.startsWith('--'));
const nickname = String(args.find((a) => !a.startsWith('--')) ?? '').trim();
if (!nickname) fail('要指定昵称');

const user = findByNickname(nickname);
if (!user) fail(`没有这个账号：${nickname}`);

if (flag === '--make-admin') {
  setRole(user.id, 'admin');
  console.log(`[ok] ${nickname} 现在是 admin`);
  process.exit(0);
}
if (flag === '--disable') {
  setDisabled(user.id, true);
  revokeAllForUser(user.id);
  console.log(`[ok] ${nickname} 已禁用（刷新令牌已撤销）`);
  process.exit(0);
}
if (flag === '--enable') {
  setDisabled(user.id, false);
  console.log(`[ok] ${nickname} 已启用`);
  process.exit(0);
}

const newPassword = args.filter((a) => !a.startsWith('--'))[1];
if (!newPassword) fail('要指定新口令');

const policy = checkPasswordPolicy(newPassword, nickname);
if (!policy.ok) fail(policy.reason);

const hash = await hashPassword(newPassword);
updatePassword(user.id, hash);
revokeAllForUser(user.id);
console.log(`[ok] ${nickname} 的口令已重置，旧刷新令牌已撤销，其它设备需重新登录`);
