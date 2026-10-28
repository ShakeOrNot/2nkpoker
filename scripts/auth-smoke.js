/**
 * 账密系统冒烟（真 HTTP + 真 WebSocket）：
 *   注册 → 重复注册 → 错口令 → 登录 → /auth/me → 刷新轮换 → 旧刷新令牌重放
 *   → 改口令（旧 access 失效）→ 新口令登录 → 登出 → WS 握手 → 失败锁定
 *
 * 跑法（需要后端在跑）：
 *   node scripts/auth-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const NICK = `smoke_${TAG}`;
const LOCK_NICK = `lock_${TAG}`;
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

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE}/game`, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WS 握手超时'));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`WS 握手失败：${err.message}`));
    });
  });
}

async function main() {
  console.log(`后端：${BASE}`);
  console.log(`测试账号：${NICK}`);

  /* 1. 注册 */
  const reg = await api('/auth/register', { body: { nickname: NICK, password: PASSWORD } });
  check(reg.status === 201 && reg.ok === true, `注册成功（${reg.status}）`);
  check(typeof reg.accessToken === 'string' && reg.accessToken.length > 20, '拿到 access token');
  check(typeof reg.refreshToken === 'string' && reg.refreshToken.length > 20, '拿到 refresh token');
  check(reg.user?.nickname === NICK, '返回的用户就是刚注册的昵称');
  check(!('password_hash' in (reg.user ?? {})), '响应里没有口令哈希');

  /* 2. 重复注册 */
  const dup = await api('/auth/register', { body: { nickname: NICK, password: PASSWORD } });
  check(dup.status === 409 && dup.code === 'AUTH_USER_EXISTS', '重复昵称被拒（AUTH_USER_EXISTS）');

  /* 3. 错口令 */
  const bad = await api('/auth/login', { body: { nickname: NICK, password: 'wrong-password' } });
  check(bad.status === 401 && bad.code === 'AUTH_INVALID_CREDENTIALS', '错口令被拒（统一文案）');

  /* 4. 登录 */
  const login = await api('/auth/login', { body: { nickname: NICK, password: PASSWORD } });
  check(login.status === 200 && login.ok === true, '登录成功');
  check(Number(login.expiresAt) > Date.now(), '有 expiresAt');

  /* 5. /auth/me */
  const me = await api('/auth/me', { method: 'GET', token: login.accessToken });
  check(me.status === 200 && me.user?.nickname === NICK, '/auth/me 能拿到当前用户');

  /* 6. 刷新轮换 + 旧令牌重放 */
  const rotated = await api('/auth/refresh', { body: { refreshToken: login.refreshToken } });
  check(rotated.status === 200 && rotated.refreshToken !== login.refreshToken, '刷新会轮换成新令牌');
  const replay = await api('/auth/refresh', { body: { refreshToken: login.refreshToken } });
  check(replay.status === 401 && replay.code === 'AUTH_REFRESH_INVALID', '旧刷新令牌重放被拒');

  /* 7. 改口令（用登录时那一对 access） */
  const changed = await api('/auth/change-password', {
    body: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
    token: login.accessToken,
  });
  check(changed.status === 200 && changed.ok === true, '改口令成功');
  const oldMe = await api('/auth/me', { method: 'GET', token: login.accessToken });
  check(oldMe.status === 401 && oldMe.code === 'AUTH_CREDENTIALS_CHANGED', '旧 access token 立即失效');

  const oldLogin = await api('/auth/login', { body: { nickname: NICK, password: PASSWORD } });
  check(oldLogin.status === 401, '旧口令登不上');
  const newLogin = await api('/auth/login', { body: { nickname: NICK, password: NEW_PASSWORD } });
  check(newLogin.status === 200, '新口令可以登录');

  /* 8. WS 握手 */
  const socket = await connectWs(newLogin.accessToken);
  check(socket.connected === true, '用 account token 能完成 Socket.IO 握手');
  socket.close();

  /* 9. 登出 */
  const out = await api('/auth/logout', { body: { refreshToken: newLogin.refreshToken } });
  check(out.status === 200 && out.ok === true, '登出成功');
  const afterLogout = await api('/auth/refresh', { body: { refreshToken: newLogin.refreshToken } });
  check(afterLogout.status === 401, '登出后刷新令牌失效');

  /* 10. 失败锁定（独立账号） */
  await api('/auth/register', { body: { nickname: LOCK_NICK, password: PASSWORD } });
  for (let i = 0; i < 5; i++) {
    await api('/auth/login', { body: { nickname: LOCK_NICK, password: `nope-${i}` } });
  }
  const locked = await api('/auth/login', { body: { nickname: LOCK_NICK, password: PASSWORD } });
  check(locked.status === 429 && locked.code === 'AUTH_LOCKED', '连续失败 5 次后锁定（AUTH_LOCKED）');

  console.log(`\n账密冒烟通过：${passed} 项断言`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n账密冒烟失败：${err.message}`);
  process.exit(1);
});
