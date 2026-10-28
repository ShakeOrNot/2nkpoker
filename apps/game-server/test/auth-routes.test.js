import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../src/users/db.js';
import { registerAuthRoutes } from '../src/routes/auth.route.js';
import { resetRateLimit } from '../src/auth/ratelimit.js';
import { setRole } from '../src/users/userStore.js';

/** 每个用例一个干净的内存库 + 一个只挂了 auth 路由的 Fastify */
async function makeApp() {
  initDb(':memory:');
  resetRateLimit();
  const app = Fastify({ logger: false });
  registerAuthRoutes(app);
  await app.ready();
  return app;
}

function post(app, url, payload, token) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload ?? {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function get(app, url, token) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const PASSWORD = 'poker-2026';

describe('注册', () => {
  it('注册成功直接返回会话；昵称就是登录名', async () => {
    const app = await makeApp();
    const res = await post(app, '/auth/register', { nickname: '阿豪', password: PASSWORD });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.accessToken.length > 20).toBe(true);
    expect(body.refreshToken.length > 20).toBe(true);
    expect(body.user.nickname).toBe('阿豪');
    expect(body.user.password_hash).toBeUndefined();
    // 会话可用
    const me = await get(app, '/auth/me', body.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.nickname).toBe('阿豪');
  });

  it('昵称重复（大小写不敏感）被拒', async () => {
    const app = await makeApp();
    await post(app, '/auth/register', { nickname: 'Alice', password: PASSWORD });
    const dup = await post(app, '/auth/register', { nickname: 'alice', password: PASSWORD });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('AUTH_USER_EXISTS');
  });

  it('弱口令 / 非法昵称被拒', async () => {
    const app = await makeApp();
    const weak = await post(app, '/auth/register', { nickname: 'bob', password: '123' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('AUTH_WEAK_PASSWORD');

    const bad = await post(app, '/auth/register', { nickname: 'a b', password: PASSWORD });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('AUTH_INVALID_NICKNAME');
  });
});

describe('登录', () => {
  it('口令正确能拿到会话；错误口令统一文案', async () => {
    const app = await makeApp();
    await post(app, '/auth/register', { nickname: 'carol', password: PASSWORD });

    const ok = await post(app, '/auth/login', { nickname: 'CAROL', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.nickname).toBe('carol'); // 昵称大小写不敏感

    const bad = await post(app, '/auth/login', { nickname: 'carol', password: 'wrong-pass' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('AUTH_INVALID_CREDENTIALS');

    const ghost = await post(app, '/auth/login', { nickname: 'nobody', password: PASSWORD });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('连续失败 5 次后锁定', async () => {
    const app = await makeApp();
    await post(app, '/auth/register', { nickname: 'dave', password: PASSWORD });
    // 前 4 次还只是普通失败
    for (let i = 0; i < 4; i++) {
      const r = await post(app, '/auth/login', { nickname: 'dave', password: `wrong-${i}` });
      expect(r.statusCode).toBe(401);
    }
    // 第 5 次失败就地触发锁定，直接 429
    const fifth = await post(app, '/auth/login', { nickname: 'dave', password: 'wrong-final' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().code).toBe('AUTH_LOCKED');

    // 锁定期间即使口令正确也不放行
    const locked = await post(app, '/auth/login', { nickname: 'dave', password: PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe('AUTH_LOCKED');
  });
});

describe('刷新 / 登出', () => {
  it('刷新会换新令牌，旧刷新令牌再用会被判定失效', async () => {
    const app = await makeApp();
    const reg = (await post(app, '/auth/register', { nickname: 'erin', password: PASSWORD })).json();

    const first = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
    expect(first.statusCode).toBe(200);
    const rotated = first.json();
    expect(rotated.refreshToken !== reg.refreshToken).toBe(true);

    // 旧令牌重放：不仅失败，还会撤销该账号全部刷新令牌
    const replay = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_REFRESH_INVALID');

    const after = await post(app, '/auth/refresh', { refreshToken: rotated.refreshToken });
    expect(after.statusCode).toBe(401);
  });

  it('登出后刷新令牌失效', async () => {
    const app = await makeApp();
    const reg = (await post(app, '/auth/register', { nickname: 'frank', password: PASSWORD })).json();
    const out = await post(app, '/auth/logout', { refreshToken: reg.refreshToken });
    expect(out.statusCode).toBe(200);
    const again = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
    expect(again.statusCode).toBe(401);
  });
});

describe('改口令', () => {
  it('旧口令错被拒；成功后旧 access 失效、旧口令登不上、新口令可用', async () => {
    const app = await makeApp();
    const reg = (await post(app, '/auth/register', { nickname: 'grace', password: PASSWORD })).json();

    const wrong = await post(app, '/auth/change-password', { oldPassword: 'nope-nope', newPassword: 'new-poker-9' }, reg.accessToken);
    expect(wrong.statusCode).toBe(401);

    const changed = await post(app, '/auth/change-password', { oldPassword: PASSWORD, newPassword: 'new-poker-9' }, reg.accessToken);
    expect(changed.statusCode).toBe(200);
    const fresh = changed.json();
    expect(fresh.accessToken !== reg.accessToken).toBe(true);

    // 旧 access 的 tv 已过期
    const oldMe = await get(app, '/auth/me', reg.accessToken);
    expect(oldMe.statusCode).toBe(401);
    expect(oldMe.json().code).toBe('AUTH_CREDENTIALS_CHANGED');

    // 新 access 正常
    const me = await get(app, '/auth/me', fresh.accessToken);
    expect(me.statusCode).toBe(200);

    // 旧口令登不上，新口令可以
    const oldLogin = await post(app, '/auth/login', { nickname: 'grace', password: PASSWORD });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await post(app, '/auth/login', { nickname: 'grace', password: 'new-poker-9' });
    expect(newLogin.statusCode).toBe(200);
  });
});

describe('鉴权失败', () => {
  it('没有 token / 乱写 token 都是 401', async () => {
    const app = await makeApp();
    expect((await get(app, '/auth/me')).statusCode).toBe(401);
    expect((await get(app, '/auth/me', 'not-a-jwt')).statusCode).toBe(401);
  });
});

describe('管理员重置口令', () => {
  it('普通账号调用被拒（403 FORBIDDEN）', async () => {
    const app = await makeApp();
    const reg = (await post(app, '/auth/register', { nickname: 'user1', password: PASSWORD })).json();
    const res = await post(
      app,
      '/auth/admin/reset-password',
      { nickname: 'user1', newPassword: 'another-2026' },
      reg.accessToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('管理员重置成功：目标旧令牌失效、新口令可登录', async () => {
    const app = await makeApp();
    const boss = (await post(app, '/auth/register', { nickname: 'boss', password: PASSWORD })).json();
    setRole(boss.user.id, 'admin'); // 模拟运维用 CLI 提权
    const target = (await post(app, '/auth/register', { nickname: 'target', password: PASSWORD })).json();

    const res = await post(
      app,
      '/auth/admin/reset-password',
      { nickname: 'target', newPassword: 'reset-2026' },
      boss.accessToken,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // 目标原来的 access 立刻失效
    const oldMe = await get(app, '/auth/me', target.accessToken);
    expect(oldMe.statusCode).toBe(401);
    expect(oldMe.json().code).toBe('AUTH_CREDENTIALS_CHANGED');

    // 旧口令登不上，新口令可以
    expect((await post(app, '/auth/login', { nickname: 'target', password: PASSWORD })).statusCode).toBe(401);
    expect((await post(app, '/auth/login', { nickname: 'target', password: 'reset-2026' })).statusCode).toBe(200);
  });

  it('目标不存在 404 USER_NOT_FOUND；新口令太弱 400', async () => {
    const app = await makeApp();
    const boss = (await post(app, '/auth/register', { nickname: 'boss2', password: PASSWORD })).json();
    setRole(boss.user.id, 'admin');

    const missing = await post(
      app,
      '/auth/admin/reset-password',
      { nickname: 'nobody', newPassword: 'reset-2026' },
      boss.accessToken,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('USER_NOT_FOUND');

    const weak = await post(
      app,
      '/auth/admin/reset-password',
      { nickname: 'boss2', newPassword: '123' },
      boss.accessToken,
    );
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('AUTH_WEAK_PASSWORD');
  });
});
