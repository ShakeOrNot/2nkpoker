import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * 假的传输层：记录所有 request，并按协议返回 ack。
 * @param {Partial<any>} [overrides]
 */
function makeFakeSocket(overrides = {}) {
  const calls = [];
  const socket = {
    connected: true,
    calls,
    request(event, payload) {
      calls.push({ event, payload });
      if (event === 'table:join') {
        return Promise.resolve({ ok: true, restored: true, seat: 2 });
      }
      if (event === 'table:request_state') {
        return Promise.resolve({
          ok: true,
          snapshot: {
            tableId: payload.tableId,
            version: 1,
            smallBlind: 10,
            bigBlind: 20,
            buttonSeat: 0,
            maxSeats: 6,
            seats: [
              { seat: 2, userId: 'u1', nickname: 'U', chips: 1000, ready: false, connected: true },
            ],
            hand: null,
          },
        });
      }
      return Promise.resolve({ ok: true });
    },
    ...overrides,
  };
  return socket;
}

/**
 * @param {{ phase?: string, tableId?: string, offline?: boolean }} [options]
 */
function makeStore({ phase = 'waiting', tableId = 'room1', offline = false } = {}) {
  const store = new Store();
  store.state.session = { token: 't', userId: 'u1', nickname: 'U', expiresAt: 0 };
  store.state.phase = phase;
  store.state.offline = offline;
  store.state.room = { ...store.state.room, tableId };
  return store;
}

describe('断线重连：重新订阅房间', () => {
  it('在牌局界面重连后会自动 table:join 并补拉一次快照', async () => {
    const store = makeStore();
    const sock = makeFakeSocket();
    store.socket = sock;

    store.buildHandlers().onConnect({ userId: 'sock-1' });
    await tick();

    const events = sock.calls.map((c) => c.event);
    expect(events).toContain('table:join');
    expect(events).toContain('table:request_state');
    // 两个请求都针对当前牌局
    expect(sock.calls[0].payload.tableId).toBe('room1');
    expect(sock.calls[sock.calls.length - 1].payload.tableId).toBe('room1');
    // 快照被应用回状态层，自己的座位也恢复了
    expect(store.state.room.snapshot?.tableId).toBe('room1');
    expect(store.mySeat()).toBe(2);
  });

  it('在大厅里重连不会乱发 join', async () => {
    const store = makeStore({ phase: 'lobby' });
    const sock = makeFakeSocket();
    store.socket = sock;

    store.buildHandlers().onConnect({ userId: 's' });
    await tick();

    expect(sock.calls.length).toBe(0);
  });

  it('离线练习模式不会走服务端 join', async () => {
    const store = makeStore({ offline: true });
    const sock = makeFakeSocket();
    store.socket = sock;

    store.buildHandlers().onConnect({ userId: 's' });
    await tick();

    expect(sock.calls.length).toBe(0);
  });

  it('连接已断开时不会硬发请求', async () => {
    const store = makeStore();
    const sock = makeFakeSocket({ connected: false });
    store.socket = sock;

    store.buildHandlers().onConnect({ userId: 's' });
    await tick();

    expect(sock.calls.length).toBe(0);
  });
});
