import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';
import { GameSocket } from '../public/js/net/socket.js';

const realFetch = globalThis.fetch;

/** @param {any} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sessionBody(overrides = {}) {
  const rand = Math.random().toString(36).slice(2);
  return {
    ok: true,
    accessToken: `access-${rand}-${rand}`,
    refreshToken: `refresh-${rand}-${rand}`,
    expiresAt: Date.now() + 900000,
    user: { id: 'u1', nickname: '阿豪', role: 'user' },
    ...overrides,
  };
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
    calls.push({ url: String(url), body: init?.body, headers: init?.headers });
    return handler(String(url), init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

/** 每次测试一个干净的 store（localStorage 在同一个进程里是共享的） */
function freshStore() {
  globalThis.localStorage.removeItem('2nk.session');
  globalThis.localStorage.removeItem('2nk.offline');
  const store = new Store();
  store.state.offline = false;
  store.state.phase = 'login';
  store.state.session = null;
  return store;
}

describe('账密登录（store ↔ HTTP）', () => {
  it('login 成功：把会话装进 store 并进大厅', async () => {
    const calls = await withFetch(
      () => jsonResponse(sessionBody()),
      async () => {
        const store = freshStore();
        const res = await store.login('阿豪', 'poker-2026');
        expect(res.ok).toBe(true);
        expect(store.state.phase).toBe('lobby');
        expect(String(store.state.session?.token).startsWith('access-')).toBe(true);
        expect(String(store.state.session?.refreshToken).startsWith('refresh-')).toBe(true);
        expect(store.state.session?.nickname).toBe('阿豪');
      },
    );
    expect(calls[0].url.endsWith('/auth/login')).toBe(true);
    expect(JSON.parse(calls[0].body).nickname).toBe('阿豪');
    expect(JSON.parse(calls[0].body).password).toBe('poker-2026');
  });

  it('login 失败：保留登录页并带出错误码', async () => {
    await withFetch(
      () => jsonResponse({ ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: '昵称或口令不对' }, 401),
      async () => {
        const store = freshStore();
        const res = await store.login('阿豪', 'wrong-password');
        expect(res.ok).toBe(false);
        expect(res.code).toBe('AUTH_INVALID_CREDENTIALS');
        expect(store.state.phase).toBe('login');
        expect(store.state.session).toBeNull();
      },
    );
  });

  it('register 成功也会直接进大厅', async () => {
    const calls = await withFetch(
      () => jsonResponse(sessionBody({ user: { id: 'u2', nickname: '新人', role: 'user' } }), 201),
      async () => {
        const store = freshStore();
        const res = await store.register('新人', 'poker-2026');
        expect(res.ok).toBe(true);
        expect(store.state.phase).toBe('lobby');
        expect(store.state.session?.nickname).toBe('新人');
      },
    );
    expect(calls[0].url.endsWith('/auth/register')).toBe(true);
  });

  it('refreshAccessToken 换新令牌；失败只挂横幅、不把人踢回登录页', async () => {
    const store = freshStore();
    store.installSession({
      token: 'old-access-token-value',
      refreshToken: 'old-refresh-token-value',
      userId: 'u1',
      nickname: '阿豪',
      expiresAt: Date.now() + 60000,
    });
    store.state.phase = 'table';

    await withFetch(
      () =>
        jsonResponse(
          sessionBody({ accessToken: 'new-access-token-value', refreshToken: 'new-refresh-token-value' }),
        ),
      async () => {
        const ok = await store.refreshAccessToken();
        expect(ok).toBe(true);
        expect(store.state.session?.token).toBe('new-access-token-value');
        expect(store.state.session?.refreshToken).toBe('new-refresh-token-value');
      },
    );

    // 刷新令牌失效：保留当前页面（phase 仍是 table），只置 authExpired
    await withFetch(
      () => jsonResponse({ ok: false, code: 'AUTH_REFRESH_INVALID' }, 401),
      async () => {
        const ok = await store.refreshAccessToken();
        expect(ok).toBe(false);
        expect(store.state.authExpired).toBe(true);
        expect(store.state.phase).toBe('table');
        expect(Boolean(store.state.session)).toBe(true);
      },
    );

    // 点"重新登录"才回登录页
    store.reLogin();
    expect(store.state.phase).toBe('login');
    expect(store.state.session).toBeNull();
    expect(store.state.authExpired).toBe(false);
  });

  it('changePassword 成功后换上新令牌，且不改当前页面', async () => {
    const store = freshStore();
    store.installSession({
      token: 'old-access',
      refreshToken: 'old-refresh',
      userId: 'u1',
      nickname: '阿豪',
      expiresAt: Date.now() + 60000,
    });
    store.state.phase = 'table';

    let seenUrl = '';
    let seenAuth = '';
    await withFetch(
      (url, init) => {
        seenUrl = url;
        seenAuth = String(init?.headers?.Authorization ?? '');
        return jsonResponse(
          sessionBody({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }),
        );
      },
      async () => {
        const res = await store.changePassword('poker-2026', 'poker-2027');
        expect(res.ok).toBe(true);
      },
    );

    expect(seenUrl.endsWith('/auth/change-password')).toBe(true);
    expect(seenAuth).toBe('Bearer old-access');
    expect(store.state.session?.token).toBe('fresh-access');
    expect(store.state.session?.refreshToken).toBe('fresh-refresh');
    expect(store.state.phase).toBe('table'); // 不被踢回大厅/登录页
  });

  it('changePassword 失败会把错误码带出来', async () => {
    const store = freshStore();
    store.installSession({
      token: 'access-x',
      refreshToken: 'refresh-x',
      userId: 'u1',
      nickname: '阿豪',
      expiresAt: Date.now() + 60000,
    });

    await withFetch(
      () => jsonResponse({ ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: '旧口令不对' }, 401),
      async () => {
        const res = await store.changePassword('wrong', 'poker-2027');
        expect(res.ok).toBe(false);
        expect(res.code).toBe('AUTH_INVALID_CREDENTIALS');
      },
    );
  });

  it('logout 会通知服务端吊销刷新令牌并清本地会话', async () => {
    const store = freshStore();
    store.installSession({
      token: 'access-token-value',
      refreshToken: 'refresh-token-value',
      userId: 'u1',
      nickname: '阿豪',
      expiresAt: Date.now() + 60000,
    });

    const calls = await withFetch(
      () => jsonResponse({ ok: true }),
      async () => {
        store.logout();
        await new Promise((r) => setTimeout(r, 30));
      },
    );

    expect(calls.some((c) => c.url.endsWith('/auth/logout'))).toBe(true);
    expect(store.state.session).toBeNull();
    expect(store.state.phase).toBe('login');
  });
});

describe('握手鉴权失败：自动续期重试', () => {
  /** @param {() => Promise<any>} fn */
  async function withSocketStub(connectImpl, fn) {
    const real = GameSocket.prototype.connect;
    GameSocket.prototype.connect = connectImpl;
    try {
      await fn();
    } finally {
      GameSocket.prototype.connect = real;
    }
  }

  function authedStore() {
    const store = freshStore();
    store.installSession({
      token: 'old-access',
      refreshToken: 'refresh-1',
      userId: 'u1',
      nickname: '阿豪',
      expiresAt: Date.now() + 60000,
    });
    store.state.phase = 'lobby';
    return store;
  }

  it('第一次 AUTH_FAILED → 续期后重连成功，不踢回登录页', async () => {
    const store = authedStore();
    let attempts = 0;
    await withSocketStub(
      async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, code: 'AUTH_FAILED' } : { ok: true };
      },
      async () => {
        await withFetch(
          () => jsonResponse(sessionBody({ accessToken: 'new-access', refreshToken: 'refresh-2' })),
          async () => {
            const res = await store.ensureSocket();
            expect(res.ok).toBe(true);
            expect(attempts).toBe(2);
            expect(store.state.phase).toBe('lobby');
            expect(store.state.authExpired).toBe(false);
            expect(store.state.session?.token).toBe('new-access');
          },
        );
      },
    );
    store.closeSocket();
  });

  it('续期也失败 → 保留页面 + 顶部横幅（authExpired），不 logout', async () => {
    const store = authedStore();
    await withSocketStub(
      async () => ({ ok: false, code: 'AUTH_FAILED' }),
      async () => {
        await withFetch(
          () => jsonResponse({ ok: false, code: 'AUTH_REFRESH_INVALID' }, 401),
          async () => {
            const res = await store.ensureSocket();
            expect(res.ok).toBe(false);
            expect(res.code).toBe('AUTH_EXPIRED');
            expect(store.state.phase).toBe('lobby'); // 没被踢回登录
            expect(Boolean(store.state.session)).toBe(true);
            expect(store.state.authExpired).toBe(true);
          },
        );
      },
    );
    store.closeSocket();
  });
});
