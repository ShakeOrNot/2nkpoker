import { describe, it, expect } from 'vitest';
import { tablePositions, tablePositionOf } from '../public/js/core/logic.js';

/**
 * 造一个桌子快照
 * @param {number[]} seats 有人坐的座位号
 * @param {number} buttonSeat
 */
function snap(seats, buttonSeat = 0) {
  const all = [];
  for (let i = 0; i < 6; i++) {
    const has = seats.includes(i);
    all.push({
      seat: i,
      userId: has ? `u${i}` : null,
      nickname: has ? `U${i}` : '',
      chips: has ? 1000 : 0,
      ready: false,
      connected: has,
    });
  }
  return { tableId: 't', version: 1, smallBlind: 10, bigBlind: 20, buttonSeat, maxSeats: 6, seats: all, hand: null };
}

describe('tablePositions - 用桌面快照算位次（等候室没有手牌也能用）', () => {
  it('6 人：从 BTN 起 BTN/SB/BB/UTG/HJ/CO', () => {
    const m = tablePositions(snap([0, 1, 2, 3, 4, 5], 0));
    expect([...m.values()]).toEqual(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
  });

  it('3 人 0/2/4：BTN / SB / BB', () => {
    const m = tablePositions(snap([0, 2, 4], 0));
    expect(m.get(0)).toBe('BTN');
    expect(m.get(2)).toBe('SB');
    expect(m.get(4)).toBe('BB');
  });

  it('按钮位停在空座位上时，顺延到之后第一个有人坐的座位', () => {
    // 座位 0 空着，最近的手牌还没开过 → 座位 2 当 BTN
    const m = tablePositions(snap([2, 4], 0));
    expect(m.get(2)).toBe('BTN');
    expect(m.get(4)).toBe('BB'); // 单挑只有 BTN / BB
  });

  it('单挑：BTN + BB，没有 SB', () => {
    const m = tablePositions(snap([1, 3], 3));
    expect(m.get(3)).toBe('BTN');
    expect(m.get(1)).toBe('BB');
  });

  it('空座位/未知座位没有位次名', () => {
    const s = snap([0, 1], 0);
    expect(tablePositionOf(s, 5)).toBe('');
    expect(tablePositionOf(s, null)).toBe('');
    expect(tablePositionOf(null, 0)).toBe('');
  });
});
