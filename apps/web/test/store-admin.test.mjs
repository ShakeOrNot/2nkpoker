import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

const realFetch = globalThis.fetch;

/** @param {any} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 用可控的 fetch 跑一段逻辑，结束后恢复
 * @param {(url: string, init: any) => any} handler
 * @param {() => Promise<void>} fn
 */
async function withFetch(handler, fn) {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body, headers: init?.headers });
    return handler(String(url), init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

/** @param {'user'|'admin'} role */
function adminStore(role = 'admin') {
  globalThis.localStorage.removeItem('2nk.session');
  globalThis.localStorage.removeItem('2nk.offline');
  const store = new Store();
  store.state.offline = false;
  store.state.phase = 'lobby';
  store.state.session = {
    token: 'access-abc',
    refreshToken: 'refresh-abc',
    userId: 'u_me',
    nickname: '老板',
    expiresAt: Date.now() + 900000,
    user: { id: 'u_me', nickname: '老板', role },
  };
  return store;
}

describe('管理面板入口（store）', () => {
  it('普通账号 openAdmin 被拒，停在大厅', () => {
    const store = adminStore('user');
    expect(store.isAdmin).toBe(false);
    const ok = store.openAdmin();
    expect(ok).toBe(false);
    expect(store.state.phase).toBe('lobby');
  });

  it('管理员可以进出管理面板', () => {
    const store = adminStore('admin');
    expect(store.isAdmin).toBe(true);
    expect(store.openAdmin()).toBe(true);
    expect(store.state.phase).toBe('admin');
    store.exitAdmin();
    expect(store.state.phase).toBe('lobby');
  });

  it('刷新页面后能从 localStorage 恢复角色', () => {
    globalThis.localStorage.setItem(
      '2nk.session',
      JSON.stringify({
        token: 'access-xyz',
        refreshToken: 'refresh-xyz',
        userId: 'u_boss',
        nickname: '老板',
        expiresAt: Date.now() + 600000,
        user: { id: 'u_boss', nickname: '老板', role: 'admin' },
      }),
    );
    const store = new Store();
    expect(store.state.session?.user?.role).toBe('admin');
    expect(store.isAdmin).toBe(true);
  });
});

describe('管理面板接口（store ↔ HTTP）', () => {
  it('adminListUsers 带上 Bearer、q、分页参数', async () => {
    const store = adminStore();
    const calls = await withFetch(
      () => jsonResponse({ ok: true, total: 3, users: [{ id: 'u1', nickname: '阿豪', role: 'user', disabled: false, tokenVersion: 0 }] }),
      async () => {
        const res = await store.adminListUsers({ q: '阿', limit: 20, offset: 40 });
        expect(res.ok).toBe(true);
        expect(res.total).toBe(3);
        expect(res.users.length).toBe(1);
      },
    );
    const url = calls[0].url;
    expect(url).toContain('/auth/admin/users');
    expect(url).toContain('limit=20');
    expect(url).toContain('offset=40');
    expect(url).toContain(`q=${encodeURIComponent('阿')}`);
    expect(calls[0].headers.Authorization).toBe('Bearer access-abc');
  });

  it('adminUpdateUser 用 PATCH 发 role/disabled', async () => {
    const store = adminStore();
    const calls = await withFetch(
      () => jsonResponse({ ok: true, user: { id: 'u2', disabled: true } }),
      async () => {
        const res = await store.adminUpdateUser('u2', { disabled: true });
        expect(res.ok).toBe(true);
        expect(res.user.disabled).toBe(true);
      },
    );
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url.endsWith('/auth/admin/users/u2')).toBe(true);
    expect(JSON.parse(calls[0].body)).toEqual({ disabled: true });
  });

  it('adminResetPassword 发昵称+新口令；失败时带回错误码', async () => {
    const store = adminStore();
    const calls = await withFetch(
      (url) =>
        url.endsWith('/auth/admin/reset-password')
          ? jsonResponse({ ok: false, code: 'USER_NOT_FOUND', message: '没有这个账号' }, 404)
          : jsonResponse({ ok: true }),
      async () => {
        const res = await store.adminResetPassword('nobody', 'reset-2026');
        expect(res.ok).toBe(false);
        expect(res.code).toBe('USER_NOT_FOUND');
      },
    );
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ nickname: 'nobody', newPassword: 'reset-2026' });
  });

  it('adminAudit 带 limit 拉审计日志', async () => {
    const store = adminStore();
    const calls = await withFetch(
      () => jsonResponse({ ok: true, entries: [{ at: 1700000000000, action: 'admin-reset', nickname: '阿豪', ip: '1.2.3.4', ok: true }] }),
      async () => {
        const res = await store.adminAudit(50);
        expect(res.ok).toBe(true);
        expect(res.entries.length).toBe(1);
        expect(res.entries[0].action).toBe('admin-reset');
      },
    );
    expect(calls[0].url).toContain('/auth/admin/audit?limit=50');
    expect(calls[0].headers.Authorization).toBe('Bearer access-abc');
  });

  it('非管理员调用管理接口不会发请求', async () => {
    const store = adminStore('user');
    const calls = await withFetch(
      () => jsonResponse({ ok: true }),
      async () => {
        const a = await store.adminListUsers();
        const b = await store.adminUpdateUser('u2', { disabled: true });
        const c = await store.adminResetPassword('x', 'whatever-1');
        const d = await store.adminAudit();
        const e = await store.adminTables();
        expect(a.ok).toBe(false);
        expect(b.ok).toBe(false);
        expect(c.ok).toBe(false);
        expect(d.ok).toBe(false);
        expect(e.ok).toBe(false);
      },
    );
    expect(calls.length).toBe(0);
  });

  it('牌桌管理：列表 / 解散 / 踢人 走对应接口', async () => {
    const store = adminStore();
    const calls = await withFetch(
      (url) => {
        if (url.includes('/auth/admin/tables/') && url.endsWith('/close')) return jsonResponse({ ok: true });
        if (url.includes('/auth/admin/tables/') && url.endsWith('/kick')) return jsonResponse({ ok: true });
        return jsonResponse({ ok: true, tables: [{ tableId: 't1', seats: [] }] });
      },
      async () => {
        const list = await store.adminTables();
        expect(list.ok).toBe(true);
        expect(list.tables.length).toBe(1);

        const closed = await store.adminCloseTable('t1');
        expect(closed.ok).toBe(true);
        const kicked = await store.adminKickUser('t1', 'u9');
        expect(kicked.ok).toBe(true);
      },
    );
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.endsWith('/auth/admin/tables')).toBe(true);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url.endsWith('/auth/admin/tables/t1/close')).toBe(true);
    expect(calls[2].url.endsWith('/auth/admin/tables/t1/kick')).toBe(true);
    expect(JSON.parse(calls[2].body).userId).toBe('u9');
  });

  it('收到 table:closed / table:kicked 会清掉房间回大厅', () => {
    const store = adminStore();
    store.state.phase = 'table';
    store.state.room = { ...store.state.room, tableId: 't1', snapshot: { tableId: 't1' } };

    store.handleTableClosed({ tableId: 't1' });
    expect(store.state.phase).toBe('lobby');
    expect(store.state.room.tableId).toBe('');
    expect(store.state.room.snapshot).toBeNull();

    store.state.phase = 'table';
    store.state.room = { ...store.state.room, tableId: 't2', snapshot: { tableId: 't2' } };
    store.handleTableKicked({ tableId: 't2' });
    expect(store.state.phase).toBe('lobby');
    expect(store.state.room.tableId).toBe('');
  });
});
