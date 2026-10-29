/**
 * 管理接口冒烟（真 HTTP + 真数据库）：
 *   注册普通号 → 非管理员访问管理员接口 403 → 直接改库提权 → 管理员列表/搜索/分页
 *   → 禁用/启用 → 提权/降权 → 不能改自己 → 重置口令（旧口令失效）
 *   → 审计日志 → 清场（恢复角色/启用）
 *
 * 提权走数据库而不是 spawn CLI 子进程：沙箱里 spawn 可能被 EPERM 拦掉，
 * 而且服务端与脚本本来就共用同一个 AUTH_DB_PATH。
 *
 * 跑法（需要后端在跑，且与脚本共用同一个 var/2nkpoker.db）：
 *   node scripts/admin-smoke.js
 *   GAME_URL=http://localhost:3010 node scripts/admin-smoke.js
 */
import 'dotenv/config';
import { env } from '../apps/game-server/src/env.js';
import { initDb } from '../apps/game-server/src/users/db.js';
import { findByNickname, setRole } from '../apps/game-server/src/users/userStore.js';

initDb(env.AUTH_DB_PATH);

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const ADMIN_NICK = `adm_${TAG}`;
const USER_NICK = `usr_${TAG}`;
const PASSWORD = 'poker-2026';
const NEW_PASSWORD = 'poker-2027';

let passed = 0;

function check(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, token?: string }} [options]
 */
async function api(path, { method = 'POST', body, token } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ...(data ?? {}) };
}

const register = (nickname) => api('/auth/register', { body: { nickname, password: PASSWORD } });
const login = (nickname, password = PASSWORD) => api('/auth/login', { body: { nickname, password } });

/**
 * 直接改库设置角色（服务端进程会立刻读到；和 CLI 效果一样，但不用 spawn 子进程）
 * @param {string} nickname
 * @param {'user'|'admin'} role
 */
function setUserRole(nickname, role) {
  const user = findByNickname(nickname);
  if (!user) {
    throw new Error(`数据库里没有账号 ${nickname}（脚本与服务端要用同一个 AUTH_DB_PATH）`);
  }
  setRole(user.id, role);
}

async function main() {
  console.log(`[管理接口冒烟] ${BASE}`);

  // 1. 两个普通号
  const adminReg = await register(ADMIN_NICK);
  check(adminReg.ok, '注册管理员候选账号');
  const userReg = await register(USER_NICK);
  check(userReg.ok, '注册普通账号');
  const userId = userReg.user.id;

  // 2. 普通号访问管理员接口 → 403
  const denied = await api('/auth/admin/users', { method: 'GET', token: adminReg.accessToken });
  check(denied.status === 403 && denied.code === 'FORBIDDEN', '普通账号访问列表 403 FORBIDDEN');

  // 3. 提权后重新登录，role=admin
  setUserRole(ADMIN_NICK, 'admin');
  const adminLogin = await login(ADMIN_NICK);
  check(adminLogin.ok && adminLogin.user.role === 'admin', 'CLI 提权后 role=admin');

  const adminToken = adminLogin.accessToken;
  const adminId = adminLogin.user.id;

  // 4. 列表 / 搜索 / 分页
  const list = await api(`/auth/admin/users?q=${TAG}&limit=10&offset=0`, { method: 'GET', token: adminToken });
  check(list.ok && list.total >= 2, '按昵称搜索到两位测试账号');
  check(list.users.every((u) => u.password_hash === undefined && u.passwordHash === undefined), '列表不泄露口令散列');
  check(typeof list.users[0].disabled === 'boolean' && typeof list.users[0].tokenVersion === 'number', '列表带 disabled / tokenVersion');
  const page = await api('/auth/admin/users?limit=1&offset=0', { method: 'GET', token: adminToken });
  check(page.ok && page.users.length === 1 && page.total >= 2, '分页 limit=1 生效');

  // 5. 禁用 → 登录被拒 / 旧令牌失效 → 启用
  const off = await api(`/auth/admin/users/${userId}`, { method: 'PATCH', body: { disabled: true }, token: adminToken });
  check(off.status === 200 && off.user.disabled === true, '禁用普通账号成功');
  const banned = await login(USER_NICK);
  check(banned.status === 403 && banned.code === 'AUTH_DISABLED', '被禁用账号不能登录（AUTH_DISABLED）');
  const oldMe = await api('/auth/me', { method: 'GET', token: userReg.accessToken });
  check(oldMe.status === 403 && oldMe.code === 'AUTH_DISABLED', '被禁用账号旧 access 失效');
  const on = await api(`/auth/admin/users/${userId}`, { method: 'PATCH', body: { disabled: false }, token: adminToken });
  check(on.status === 200 && on.user.disabled === false, '重新启用成功');
  check((await login(USER_NICK)).status === 200, '重新启用后可登录');

  // 6. 提权 → 目标旧令牌失效、重登是 admin；再降回 user
  const userLogin = await login(USER_NICK);
  const up = await api(`/auth/admin/users/${userId}`, { method: 'PATCH', body: { role: 'admin' }, token: adminToken });
  check(up.status === 200 && up.user.role === 'admin', '提为管理员成功');
  const stale = await api('/auth/me', { method: 'GET', token: userLogin.accessToken });
  check(stale.status === 401 && stale.code === 'AUTH_CREDENTIALS_CHANGED', '角色变更后旧 access 失效（AUTH_CREDENTIALS_CHANGED）');
  const reLogin = await login(USER_NICK);
  check(reLogin.ok && reLogin.user.role === 'admin', '重新登录后是新角色');
  const down = await api(`/auth/admin/users/${userId}`, { method: 'PATCH', body: { role: 'user' }, token: adminToken });
  check(down.status === 200 && down.user.role === 'user', '降回普通玩家成功');

  // 7. 不能改自己 / 目标不存在 / 空 patch
  const self = await api(`/auth/admin/users/${adminId}`, { method: 'PATCH', body: { disabled: true }, token: adminToken });
  check(self.status === 400 && self.code === 'CANNOT_MODIFY_SELF', '不能禁用自己（CANNOT_MODIFY_SELF）');
  const ghost = await api('/auth/admin/users/u_ghost', { method: 'PATCH', body: { role: 'user' }, token: adminToken });
  check(ghost.status === 404 && ghost.code === 'USER_NOT_FOUND', '目标不存在 404 USER_NOT_FOUND');
  const empty = await api(`/auth/admin/users/${userId}`, { method: 'PATCH', body: {}, token: adminToken });
  check(empty.status === 400 && empty.code === 'INVALID_PAYLOAD', '空 patch 400 INVALID_PAYLOAD');

  // 8. 管理员重置口令：旧口令失效、新口令可登录
  const reset = await api('/auth/admin/reset-password', {
    body: { nickname: USER_NICK, newPassword: NEW_PASSWORD },
    token: adminToken,
  });
  check(reset.status === 200 && reset.ok, '管理员重置口令成功');
  check((await login(USER_NICK)).code === 'AUTH_INVALID_CREDENTIALS', '旧口令失效');
  check((await login(USER_NICK, NEW_PASSWORD)).status === 200, '新口令可登录');

  // 9. 审计日志
  const audit = await api('/auth/admin/audit?limit=50', { method: 'GET', token: adminToken });
  check(audit.ok && Array.isArray(audit.entries) && audit.entries.length > 0, '审计日志非空');
  const actions = new Set(audit.entries.map((e) => e.action));
  check(actions.has('admin-update') && actions.has('admin-reset'), '审计含 admin-update / admin-reset');
  const first = audit.entries[0];
  check(typeof first.at === 'number' && typeof first.ok === 'boolean' && first.password_hash === undefined, '审计条目字段正确且不泄露散列');
  const deniedAudit = await api('/auth/admin/audit?limit=50', { method: 'GET', token: reLogin.accessToken });
  check(deniedAudit.status === 401 && deniedAudit.code === 'AUTH_CREDENTIALS_CHANGED', '降权后目标旧 access 失效（不会残留管理员权限）');

  // 10. 牌桌管理：建桌 → 列表能看到 → 解散 → 列表里消失
  const tableId = `admtbl_${TAG}`;
  const created = await api('/tables', { body: { tableId, maxSeats: 6, smallBlind: 10, bigBlind: 20 } });
  check(created.status === 200 || created.status === 201, '建一张测试牌桌');
  const tables = await api('/auth/admin/tables', { method: 'GET', token: adminToken });
  check(tables.ok && tables.tables.some((t) => t.tableId === tableId), '牌桌列表里能看到它');
  const closed = await api(`/auth/admin/tables/${tableId}/close`, { body: {}, token: adminToken });
  check(closed.ok, '解散牌桌成功');
  const afterClose = await api('/auth/admin/tables', { method: 'GET', token: adminToken });
  check(!afterClose.tables.some((t) => t.tableId === tableId), '解散后列表里消失');

  // 11. 清场：删不掉账号，至少把测试管理员降回普通账号
  setUserRole(ADMIN_NICK, 'user');
  console.log(`\n[管理接口冒烟] 全部通过：${passed} 项断言`);
}

main().catch((err) => {
  console.error(`\n[管理接口冒烟] 失败：${err.message}`);
  process.exit(1);
});
