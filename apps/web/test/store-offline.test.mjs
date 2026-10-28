import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

describe('离线练习：退出', () => {
  it('exitOffline 会关掉离线开关、清登录态并回到登录页', () => {
    const store = new Store();
    store.state.session = { token: 'offline', userId: 'local_me', nickname: '我', expiresAt: 0 };
    store.state.phase = 'lobby';
    store.state.offline = true;
    store.state.room = {
      ...store.state.room,
      tableId: 'practice',
      snapshot: { tableId: 'practice', seats: [], maxSeats: 6, hand: null },
    };

    // 这里传空串：toast 需要真实 DOM，单测环境不提供；状态变化才是要守的
    store.exitOffline('');

    expect(store.state.offline).toBe(false);
    expect(store.state.session).toBeNull();
    expect(store.state.phase).toBe('login');
    expect(store.state.room.tableId).toBe('');
    expect(store.state.room.snapshot).toBeNull();
    // 关键：开关要落盘为关，否则下次登录又进离线模式（writeStore 存的是 JSON）
    expect(JSON.parse(globalThis.localStorage.getItem('2nk.offline'))).toBe('0');
  });
});
