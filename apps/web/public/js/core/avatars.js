export const AVATARS = [
  // 保留已保存的 ID，更新对应美术及展示名称。
  { id: 'lion', name: '黑桃王牌' }, { id: 'fox', name: '红心皇后' },
  { id: 'cat', name: '暗夜庄家' }, { id: 'owl', name: '王者之冠' },
  { id: 'panda', name: '黑金筹码' }, { id: 'robot', name: '皇家同花' },
];
export const avatarId = value => AVATARS.some(a => a.id === value) ? value : 'lion';
export function playerAvatar(state, player) {
  if (player?.userId === state.session?.userId) return avatarId(state.session?.user?.avatarId);
  return avatarId(player?.avatarId);
}
