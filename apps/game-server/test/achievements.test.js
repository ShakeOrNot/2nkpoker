import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { computeAchievements, levelOf, ROMAN, SERIES, HAND_TYPES } from '../src/users/achievements.js';

describe('成就等级', () => {
  it('数值达到阈值才升级（0 = 未解锁）', () => {
    expect(levelOf(0, [1, 10, 100])).toBe(0);
    expect(levelOf(1, [1, 10, 100])).toBe(1);
    expect(levelOf(9, [1, 10, 100])).toBe(1);
    expect(levelOf(10, [1, 10, 100])).toBe(2);
    expect(levelOf(999, [1, 10, 100])).toBe(3);
    expect(levelOf(100, [1, 10, 100])).toBe(3);
    expect(levelOf(100000, [1, 10, 100, 1000, 10000, 100000])).toBe(6);
  });

  it('罗马数字等级表', () => {
    expect(ROMAN.slice(0, 7)).toEqual(['', 'I', 'II', 'III', 'IV', 'V', 'VI']);
  });
});

describe('成就计算', () => {
  it('手数/胜场/盈利三条线 + 10 种牌型', () => {
    const ach = computeAchievements({
      hands: 100,
      wins: 10,
      profit: 5000,
      categories: { ROYAL_FLUSH: 1, FULL_HOUSE: 25 },
    });

    expect(ach.series.length).toBe(SERIES.length);
    expect(ach.handTypes.length).toBe(HAND_TYPES.length);

    const hands = ach.series.find((x) => x.key === 'hands');
    expect(hands.level).toBe(3);
    expect(hands.levelName).toBe('III');
    expect(hands.next).toBe(1000);

    const wins = ach.series.find((x) => x.key === 'wins');
    expect(wins.level).toBe(2);
    expect(wins.next).toBe(100);

    const profit = ach.series.find((x) => x.key === 'profit');
    expect(profit.value).toBe(5000);
    expect(profit.level).toBe(2);

    const royal = ach.handTypes.find((h) => h.key === 'ROYAL_FLUSH');
    expect(royal.level).toBe(1);
    const full = ach.handTypes.find((h) => h.key === 'FULL_HOUSE');
    expect(full.level).toBe(2);
    expect(full.next).toBe(100);
  });

  it('满级后 next 为 null', () => {
    const ach = computeAchievements({ hands: 1000000 });
    const hands = ach.series.find((x) => x.key === 'hands');
    expect(hands.level).toBe(6);
    expect(hands.next).toBe(null);
  });

  it('空数据不会崩：全部未解锁', () => {
    const ach = computeAchievements({});
    expect(ach.series.every((x) => x.level === 0)).toBe(true);
    expect(ach.handTypes.every((x) => x.level === 0)).toBe(true);
  });
});
