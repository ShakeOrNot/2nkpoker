import { describe, it, expect } from 'vitest';
import { AVATARS, avatarId, playerAvatar } from '../public/js/core/avatars.js';
import { Store } from '../public/js/store.js';
import { readStore } from '../public/js/core/config.js';

describe('头像资料', () => {
  it('非法 ID 与缺失值回退，绝不拼接任意资源路径', () => {
    expect(avatarId('../../private')).toBe('lion');
    expect(avatarId(null)).toBe('lion');
    expect(avatarId('fox')).toBe('fox');
    expect(new Set(AVATARS.map(a => a.id)).size).toBe(6);
  });
  it('自己使用账号资料，其他玩家使用公开座位资料', () => {
    const state = { session: { userId: 'me', user: { avatarId: 'cat' } } };
    expect(playerAvatar(state, { userId: 'me', avatarId: 'lion' })).toBe('cat');
    expect(playerAvatar(state, { userId: 'friend', avatarId: 'fox' })).toBe('fox');
  });
  it('离线保存按账号隔离，并在重新登录后恢复', async () => {
    const store = new Store(); store.state.offline = true;
    const session = { token: 'offline', userId: 'avatar-test', nickname: '测试', user: {} };
    store.installSession(session);
    expect((await store.updateAvatar('owl')).ok).toBe(true);
    expect(readStore('2nk.avatar.avatar-test')).toBe('owl');
    store.installSession({ ...session, user: {} });
    expect(store.state.session.user.avatarId).toBe('owl');
    store.installSession({ ...session, userId: 'avatar-other', user: {} });
    expect(store.state.session.user.avatarId).toBe('lion');
    store.stopRefreshTimer?.();
  });
});
