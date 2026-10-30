/**
 * 前端配置与地址解析、本机牌局记录的测试。
 * 依赖 run-tests.mjs 安装的最小浏览器桩（localStorage / document / window）。
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

/**
 * 没有 vitest 时的最小 beforeAll：把异步准备排进队列，不阻塞测试注册
 * @param {() => Promise<void>|void} fn
 */
function beforeAll(fn) {
  globalThis.__beforeAllQueue = globalThis.__beforeAllQueue ?? [];
  globalThis.__beforeAllQueue.push(Promise.resolve().then(fn));
}

describe('服务器地址解析', () => {
  it('同源时直接用当前 origin（配合 dev-server 代理）', async () => {
    const { resolveServerConfig } = await import('../public/js/core/config.js');
    globalThis.window.location.search = '';
    const cfg = resolveServerConfig();
    expect(cfg.apiBase).toBe('http://192.168.1.50:8080');
    expect(cfg.wsBase).toBe('http://192.168.1.50:8080');
    expect(cfg.source).toBe('same-origin');
  });

  it('URL 参数 ?api= 优先级最高（真机连电脑上的后端）', async () => {
    const { resolveServerConfig } = await import('../public/js/core/config.js');
    globalThis.window.location.search = '?api=http://10.0.0.7:3001';
    const cfg = resolveServerConfig();
    expect(cfg.apiBase).toBe('http://10.0.0.7:3001');
    expect(cfg.wsBase).toBe('http://10.0.0.7:3001');
    expect(cfg.source).toBe('query');
    globalThis.window.location.search = '';
  });

  it('localStorage 里保存的地址优先于默认值', async () => {
    const { resolveServerConfig } = await import('../public/js/core/config.js');
    globalThis.window.location.search = '';
    globalThis.window.localStorage.setItem('2nk.server', JSON.stringify({ apiBase: 'http://saved:3001/' }));
    const cfg = resolveServerConfig();
    expect(cfg.apiBase).toBe('http://saved:3001');
    expect(cfg.source).toBe('storage');
    globalThis.window.localStorage.removeItem('2nk.server');
  });

  it('命名空间地址一定以 /game 结尾且不重复拼接', async () => {
    const { gameNamespaceUrl } = await import('../public/js/core/config.js');
    expect(gameNamespaceUrl('http://a:3001')).toBe('http://a:3001/game');
    expect(gameNamespaceUrl('http://a:3001/')).toBe('http://a:3001/game');
    expect(gameNamespaceUrl('http://a:3001/game')).toBe('http://a:3001/game');
  });

  it('分享链接里的 table 参数能被读出来', async () => {
    const { roomFromQuery } = await import('../public/js/core/config.js');
    globalThis.window.location.search = '?table=abc123';
    expect(roomFromQuery()).toBe('abc123');
    globalThis.window.location.search = '';
    expect(roomFromQuery()).toBe('');
  });
});

describe('socket.io 客户端加载', () => {
  it('CDN 全部失败时抛出可读的中文错误（而不是卡死）', async () => {
    const { GameSocket } = await import('../public/js/net/socket.js');
    const socket = new GameSocket({});
    let message = '';
    try {
      await socket.connect({ wsBase: 'http://127.0.0.1:1', token: 'x' });
    } catch (err) {
      message = String(err?.message ?? err);
    }
    expect(message).toContain('socket.io');
    expect(message).toContain('离线练习');
  });

  it('三个 CDN 音源都是 https，且版本号一致', async () => {
    const src = await readFile(new URL('../public/js/net/socket.js', import.meta.url), 'utf8');
    const urls = [...src.matchAll(/https:\/\/[^']+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(url.includes('4.7.5')).toBe(true);
    }
  });

  it('未连接时发请求直接返回 NOT_CONNECTED，不会挂起', async () => {
    const { GameSocket } = await import('../public/js/net/socket.js');
    const socket = new GameSocket({});
    const res = await socket.request('table:join', { tableId: 'x' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_CONNECTED');
  });
});

describe('本机牌局记录', () => {
  it('写入后能读回，并按最近访问排序', async () => {
    const { upsertRecord, loadRecords, forgetRecord } = await import('../public/js/net/roomStore.js');
    upsertRecord({ roomId: 'aaa111', nickname: '我', isHost: true, bigBlind: 20, maxSeats: 6, buyIn: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    upsertRecord({ roomId: 'bbb222', nickname: '我', isHost: false });
    const list = loadRecords();
    expect(list[0].roomId).toBe('bbb222');
    expect(list.find((r) => r.roomId === 'aaa111').isHost).toBe(true);

    forgetRecord('bbb222');
    expect(loadRecords().some((r) => r.roomId === 'bbb222')).toBe(false);
  });

  it('合并后端列表时后端数据优先', async () => {
    const { mergeRooms } = await import('../public/js/net/roomStore.js');
    const merged = mergeRooms([
      { tableId: 'aaa111', players: 3, maxSeats: 6, hasHand: true, smallBlind: 25, bigBlind: 50 },
      { tableId: 'srv999', players: 1, maxSeats: 2, hasHand: false },
    ]);
    const a = merged.find((r) => r.roomId === 'aaa111');
    expect(a.source).toBe('server');
    expect(a.players).toBe(3);
    expect(a.hasHand).toBe(true);
    expect(a.bigBlind).toBe(50);
    expect(merged.some((r) => r.roomId === 'srv999')).toBe(true);
  });

  it('兼容后端多种字段命名', async () => {
    const { mergeRooms } = await import('../public/js/net/roomStore.js');
    const merged = mergeRooms([{ id: 'x1', seatCount: 4, inHand: true, maxSeats: 6 }]);
    expect(merged[0].roomId).toBe('x1');
    expect(merged[0].players).toBe(4);
    expect(merged[0].hasHand).toBe(true);
  });
});

describe('传输层接口契约（曾经的"点了没反应"根因）', () => {
  it('store 依赖的方法，两种传输都必须实现', async () => {
    const { createMockSocket } = await import('../public/js/net/mock-socket.js');
    const { GameSocket } = await import('../public/js/net/socket.js');
    // store/views 实际调用的：
    const required = ['request', 'setHandlers', 'close', 'disconnect'];
    const mock = createMockSocket({ tableId: 'c1', userId: 'u', nickname: 'n' });
    const real = new GameSocket({});
    const missing = [];
    for (const name of required) {
      if (typeof mock[name] !== 'function') missing.push(`mock.${name}`);
      if (typeof real[name] !== 'function') missing.push(`real.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('离线引擎额外提供 socket.io 风格接口（测试与调试要用）', async () => {
    const { createMockSocket } = await import('../public/js/net/mock-socket.js');
    const mock = createMockSocket({ tableId: 'c1b', userId: 'u', nickname: 'n' });
    for (const name of ['on', 'off', 'emit', 'removeAllListeners']) {
      expect(typeof mock[name]).toBe('function');
    }
  });

  it('离线 request 能拿到 ack，未连接时立刻返回 NOT_CONNECTED', async () => {
    const { createMockSocket } = await import('../public/js/net/mock-socket.js');
    const mock = createMockSocket({ tableId: 'c2', userId: 'u', nickname: 'n' });
    const res = await mock.request('table:join', { tableId: 'c2' });
    expect(res.ok).toBe(true);

    const fresh = createMockSocket({ tableId: 'c3', userId: 'u', nickname: 'n' });
    fresh.connected = false;
    const off = await fresh.request('table:join', { tableId: 'c3' });
    expect(off.ok).toBe(false);
    expect(off.code).toBe('NOT_CONNECTED');
  });

  it('setHandlers 注册过的回调会被触发（快照真的进得来）', async () => {
    const { createMockSocket } = await import('../public/js/net/mock-socket.js');
    const mock = createMockSocket({ tableId: 'c4', userId: 'u', nickname: 'n' });
    const seen = { snapshots: 0, hands: 0 };
    mock.setHandlers({
      onSnapshot: () => { seen.snapshots++; },
      onHandStart: () => { seen.hands++; },
    });
    await mock.request('table:join', { tableId: 'c4' });
    expect(seen.snapshots).toBeGreaterThan(0);
  });

  it('store 在离线模式下能连上并完成建房（端到端回归）', async () => {
    const { Store } = await import('../public/js/store.js');
    const store = new Store();
    store.setOffline(true);

    const login = await store.login('回归测试');
    expect(login.ok).toBe(true);
    expect(store.state.phase).toBe('lobby');

    const created = await store.createRoom({ maxSeats: 4, smallBlind: 10, bigBlind: 20, buyIn: 2000 });
    expect(created.ok).toBe(true);
    expect(store.state.phase).toBe('waiting');
    expect(store.state.room.tableId).toBe(created.tableId);

    const seat = await store.sit(null, 2000);
    expect(seat.ok).toBe(true);

    await store.setReady(true);
    const started = await waitFor(() => Boolean(store.state.room.snapshot?.hand), 6000);
    expect(started).toBe(true);
    expect(store.state.phase).toBe('table');
    expect(store.actionContext().maxTarget).toBeGreaterThan(0);
  }, 20000);

  it('离线模式下 joinRoom 对非法房号给出明确错误', async () => {
    const { Store } = await import('../public/js/store.js');
    const store = new Store();
    store.setOffline(true);
    await store.login('回归测试2');
    const bad = await store.joinRoom('带中文的房号');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('INVALID_PAYLOAD');
  });

  it('同源 IP 不会误走远端协议适配层（部署到 43.135.53.83 的回归）', async () => {
    const { Store } = await import('../public/js/store.js');
    const store = new Store();
    store.state.offline = false;
    store.state.serverConfig = {
      apiBase: 'http://43.135.53.83',
      wsBase: 'http://43.135.53.83',
      source: 'same-origin',
    };

    store.state.proto = 'auto';
    expect(store.usesRemoteAdapter()).toBe(false);

    // 只有显式 ?proto=remote 才走适配层
    store.state.proto = 'remote';
    expect(store.usesRemoteAdapter()).toBe(true);
  });
});

beforeAll(async () => {
  // 等一等，让上面注册的测试有机会跑完（这里只是占位，保持结构一致）
  await Promise.resolve();
});

async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
