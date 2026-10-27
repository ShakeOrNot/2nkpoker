import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

/**
 * 假的传输层：记录所有 request 调用。
 * @param {Record<string, any>} [ack]
 */
function makeSocket(ack = {}) {
  const calls = [];
  return {
    connected: true,
    calls,
    request(event, payload) {
      calls.push({ event, payload });
      return Promise.resolve(ack[event] ?? { ok: true });
    },
  };
}

const SEATED = [
  { seat: 0, userId: 'me', nickname: '我', chips: 1000, ready: false, connected: true },
];

/**
 * @param {{ seats?: any[], phase?: string }} [options]
 */
function makeStore({ seats = SEATED, phase = 'waiting' } = {}) {
  const store = new Store();
  store.state.session = { token: 't', userId: 'me', nickname: '我', expiresAt: 0 };
  store.state.phase = phase;
  store.state.connection = 'online';
  store.state.room = {
    ...store.state.room,
    tableId: 'room1',
    snapshot: {
      tableId: 'room1',
      maxSeats: 6,
      smallBlind: 10,
      bigBlind: 20,
      seats,
      hand: null,
    },
  };
  return store;
}

describe('离座 / 退出房间', () => {
  it('离座只发 table:stand，房间状态保留（等候室可以马上重新入座）', async () => {
    const store = makeStore();
    const sock = makeSocket();
    store.socket = sock;

    const res = await store.stand();

    expect(res.ok).toBe(true);
    expect(sock.calls.map((c) => c.event)).toEqual(['table:stand']);
    // 关键：不能把房间清空，否则等候室会变成"房号 ----、按钮全灰"的空壳
    expect(store.state.room.tableId).toBe('room1');
    expect(store.state.phase).toBe('waiting');
    expect(store.state.room.snapshot).not.toBeNull();
  });

  it('没座位也不在排队时，离座不再打扰服务端', async () => {
    const store = makeStore({ seats: [] });
    const sock = makeSocket();
    store.socket = sock;

    const res = await store.stand();

    expect(res.ok).toBe(true);
    expect(sock.calls.length).toBe(0);
  });

  it('leaveRoom 退订房间并回到大厅', async () => {
    const store = makeStore();
    const sock = makeSocket();
    store.socket = sock;

    await store.leaveRoom();

    expect(sock.calls.map((c) => c.event)).toEqual(['table:leave']);
    expect(store.state.room.tableId).toBe('');
    expect(store.state.room.snapshot).toBeNull();
    expect(store.state.phase).toBe('lobby');
  });

  it('取消排队后 queued 标记会被清掉', async () => {
    const store = makeStore({ seats: [] });
    store.state.room.queued = true;
    const sock = makeSocket();
    store.socket = sock;

    await store.stand();

    expect(sock.calls.map((c) => c.event)).toEqual(['table:stand']);
    expect(store.state.room.queued).toBe(false);
  });
});
