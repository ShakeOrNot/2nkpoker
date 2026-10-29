import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../src/users/db.js';
import { registerAuthRoutes } from '../src/routes/auth.route.js';
import { registerAdminTableRoutes } from '../src/routes/admin.tables.route.js';
import { resetRateLimit } from '../src/auth/ratelimit.js';
import { setRole } from '../src/users/userStore.js';
import { closeTable, createTable, getTable } from '../src/state/tableManager.js';

/** 每个用例一个干净的内存库 + 一个挂了 auth/管理 路由的 Fastify */
async function makeApp() {
  initDb(':memory:');
  resetRateLimit();
  const app = Fastify({ logger: false });
  registerAuthRoutes(app);
  registerAdminTableRoutes(app);
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

function patch(app, url, payload, token) {
  return app.inject({
    method: 'PATCH',
    url,
    payload: payload ?? {},
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

describe('管理员：账号列表 / 禁用启用 / 角色', () => {
  /**
   * 注册一个管理员 + 若干账号，返回 { app, boss, users }。
   * 昵称带前缀：initDb(':memory:') 在同路径下会复用同一个库，不加前缀会撞上
   * 前面用例注册过的昵称（AUTH_USER_EXISTS）。
   * @param {string} prefix
   * @param {string[]} names
   */
  async function seed(prefix, names) {
    const app = await makeApp();
    const boss = (await post(app, '/auth/register', { nickname: `${prefix}-boss`, password: PASSWORD })).json();
    setRole(boss.user.id, 'admin');
    /** @type {Record<string, any>} */
    const users = {};
    for (const name of names) {
      users[name] = (await post(app, '/auth/register', { nickname: `${prefix}-${name}`, password: PASSWORD })).json();
    }
    return { app, boss, users };
  }

  it('非管理员访问账号列表 / 写接口都是 403 FORBIDDEN', async () => {
    const { app, users } = await seed('t1', ['plain']);
    const token = users.plain.accessToken;

    const list = await get(app, '/auth/admin/users', token);
    expect(list.statusCode).toBe(403);
    expect(list.json().code).toBe('FORBIDDEN');

    const upd = await patch(app, `/auth/admin/users/${users.plain.user.id}`, { disabled: true }, token);
    expect(upd.statusCode).toBe(403);

    const audit = await get(app, '/auth/admin/audit', token);
    expect(audit.statusCode).toBe(403);
  });

  it('账号列表：按昵称搜索、分页、不泄露口令散列', async () => {
    const { app, boss, users } = await seed('t2', ['alice', 'alice2', 'bob', 'carol']);
    const all = await get(app, '/auth/admin/users?limit=2&offset=0', boss.accessToken);
    expect(all.statusCode).toBe(200);
    const page1 = all.json();
    expect(page1.ok).toBe(true);
    // 库是同一个 :memory:（本文件里所有用例共用），所以只校验下界，不写死条数
    expect(page1.total >= 5).toBe(true);
    expect(page1.users.length).toBe(2);
    expect(page1.users[0].password_hash).toBeUndefined();
    expect(page1.users[0].passwordHash).toBeUndefined();
    expect(typeof page1.users[0].disabled).toBe('boolean');
    expect(typeof page1.users[0].tokenVersion).toBe('number');

    const page2 = (await get(app, '/auth/admin/users?limit=2&offset=2', boss.accessToken)).json();
    expect(page2.users.length).toBe(2);
    expect(page2.users[0].id).not.toBe(page1.users[0].id);

    const found = (await get(app, `/auth/admin/users?q=${encodeURIComponent('t2-alice')}`, boss.accessToken)).json();
    const names = found.users.map((u) => u.nickname);
    expect(names).toContain('t2-alice');
    expect(names).toContain('t2-alice2');
    expect(names).not.toContain('t2-bob');
    expect(users.bob.user.nickname).toBe('t2-bob');
  });

  it('提权：角色变更成功且目标旧令牌立即失效', async () => {
    const { app, boss, users } = await seed('t3', ['promote']);
    const target = users.promote;
    const res = await patch(app, `/auth/admin/users/${target.user.id}`, { role: 'admin' }, boss.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('admin');

    // 角色变更会 bump token_version：旧 access 不能再用
    const oldMe = await get(app, '/auth/me', target.accessToken);
    expect(oldMe.statusCode).toBe(401);
    expect(oldMe.json().code).toBe('AUTH_CREDENTIALS_CHANGED');

    // 重新登录后是管理员
    const login = (await post(app, '/auth/login', { nickname: 't3-promote', password: PASSWORD })).json();
    expect(login.user.role).toBe('admin');

    // 列表里也能看到新角色
    const list = (await get(app, `/auth/admin/users?q=t3-promote`, boss.accessToken)).json();
    expect(list.users[0].role).toBe('admin');
  });

  it('禁用后登不上且旧令牌失效；重新启用后恢复', async () => {
    const { app, boss, users } = await seed('t4', ['banme']);
    const target = users.banme;

    const off = await patch(app, `/auth/admin/users/${target.user.id}`, { disabled: true }, boss.accessToken);
    expect(off.statusCode).toBe(200);
    expect(off.json().user.disabled).toBe(true);

    // 禁用会 bump token_version，旧 access 直接被拒（disabled 优先报 AUTH_DISABLED）
    const oldMe = await get(app, '/auth/me', target.accessToken);
    expect(oldMe.statusCode).toBe(403);
    expect(oldMe.json().code).toBe('AUTH_DISABLED');
    const login = await post(app, '/auth/login', { nickname: 't4-banme', password: PASSWORD });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('AUTH_DISABLED');

    const on = await patch(app, `/auth/admin/users/${target.user.id}`, { disabled: false }, boss.accessToken);
    expect(on.statusCode).toBe(200);
    expect((await post(app, '/auth/login', { nickname: 't4-banme', password: PASSWORD })).statusCode).toBe(200);
  });

  it('不能改自己（CANNOT_MODIFY_SELF）；目标不存在 404；空 patch 400', async () => {
    const { app, boss } = await seed('t5', []);
    const self = await patch(app, `/auth/admin/users/${boss.user.id}`, { disabled: true }, boss.accessToken);
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe('CANNOT_MODIFY_SELF');

    const ghost = await patch(app, '/auth/admin/users/u_ghost', { role: 'user' }, boss.accessToken);
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('USER_NOT_FOUND');

    const empty = await patch(app, `/auth/admin/users/${boss.user.id}`, {}, boss.accessToken);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('INVALID_PAYLOAD');
  });

  it('审计日志：记录管理员操作且不泄露敏感字段', async () => {
    const { app, boss, users } = await seed('t6', ['watched']);
    await patch(app, `/auth/admin/users/${users.watched.user.id}`, { disabled: true }, boss.accessToken);

    const res = await get(app, '/auth/admin/audit?limit=20', boss.accessToken);
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length > 0).toBe(true);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('admin-update');
    const first = entries[0];
    expect(typeof first.at).toBe('number');
    expect(typeof first.ok).toBe('boolean');
    expect(first.password_hash).toBeUndefined();
    expect(first.token_hash).toBeUndefined();

    // 越界 limit 会被夹到区间内，不会 500
    expect((await get(app, '/auth/admin/audit?limit=99999', boss.accessToken)).statusCode).toBe(200);
    expect((await get(app, '/auth/admin/audit?limit=-3', boss.accessToken)).statusCode).toBe(200);
  });
});

describe('管理员：牌桌管理', () => {
  let seq = 0;
  /** 造一个带管理员令牌的 app，返回 { app, token } */
  async function adminApp() {
    const app = await makeApp();
    const tag = `${Date.now().toString(36)}${seq++}`;
    const reg = (await post(app, '/auth/register', { nickname: `adm_${tag}`, password: PASSWORD })).json();
    setRole(reg.user.id, 'admin');
    return { app, token: reg.accessToken, adminUserId: reg.user.id };
  }

  /** 直接塞一张桌子和一个座位（不经过 WS 入座流程） */
  function seedTable(tableId, userId, nickname = '玩家') {
    const table = createTable(tableId, { maxSeats: 6, smallBlind: 10, bigBlind: 20 });
    table.seats.set(0, { seat: 0, userId, nickname, chips: 1000, ready: true, connected: true });
    table.userToSeat.set(userId, 0);
    table.version += 1;
    return table;
  }

  it('非管理员访问牌桌接口 403', async () => {
    const app = await makeApp();
    const reg = (await post(app, '/auth/register', { nickname: `plain_${Date.now().toString(36)}`, password: PASSWORD })).json();
    const list = await get(app, '/auth/admin/tables', reg.accessToken);
    expect(list.statusCode).toBe(403);
    expect(list.json().code).toBe('FORBIDDEN');
  });

  it('牌桌列表带座位详情', async () => {
    const { app, token } = await adminApp();
    const tableId = `tid_${Date.now().toString(36)}`;
    seedTable(tableId, 'u_seat_1', '阿豪');

    const res = await get(app, '/auth/admin/tables', token);
    expect(res.statusCode).toBe(200);
    const tables = res.json().tables;
    const found = tables.find((t) => t.tableId === tableId);
    expect(Boolean(found)).toBe(true);
    expect(found.seats.length).toBe(1);
    expect(found.seats[0].nickname).toBe('阿豪');
    expect(found.seats[0].userId).toBe('u_seat_1');
    expect(typeof found.hasHand).toBe('boolean');
    closeTable(tableId);
  });

  it('解散牌局：返回 ok 并从管理器移除；再解散 404', async () => {
    const { app, token } = await adminApp();
    const tableId = `close_${Date.now().toString(36)}`;
    seedTable(tableId, 'u_close');

    const res = await post(app, `/auth/admin/tables/${tableId}/close`, {}, token);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(getTable(tableId)).toBeNull();

    const again = await post(app, `/auth/admin/tables/${tableId}/close`, {}, token);
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('TABLE_NOT_FOUND');
  });

  it('踢人：清座位；不在桌上 404；手牌中 409；空 body 400', async () => {
    const { app, token } = await adminApp();
    const tableId = `kick_${Date.now().toString(36)}`;
    const table = seedTable(tableId, 'u_kick');

    const kick = await post(app, `/auth/admin/tables/${tableId}/kick`, { userId: 'u_kick' }, token);
    expect(kick.statusCode).toBe(200);
    expect(getTable(tableId).userToSeat.has('u_kick')).toBe(false);
    expect(getTable(tableId).seats.size).toBe(0);

    const ghost = await post(app, `/auth/admin/tables/${tableId}/kick`, { userId: 'nobody' }, token);
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('USER_NOT_IN_TABLE');

    table.handState = { settled: false };
    seedTable(tableId, 'u_kick2');
    const during = await post(app, `/auth/admin/tables/${tableId}/kick`, { userId: 'u_kick2' }, token);
    expect(during.statusCode).toBe(409);
    expect(during.json().code).toBe('HAND_IN_PROGRESS');
    table.handState = null;

    const empty = await post(app, `/auth/admin/tables/${tableId}/kick`, {}, token);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('INVALID_PAYLOAD');
    closeTable(tableId);
  });
});
