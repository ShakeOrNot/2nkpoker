import { describe, it, expect } from 'vitest';
import { makeDeck, shuffle, draw } from '../src/index.js';
import { SUITS, RANKS, isCard } from '@2nkpoker/shared';

describe('makeDeck', () => {
  it('返回 52 张牌', () => {
    expect(makeDeck()).toHaveLength(52);
  });

  it('每张牌都合法', () => {
    for (const c of makeDeck()) {
      expect(isCard(c)).toBe(true);
    }
  });

  it('没有重复', () => {
    const deck = makeDeck();
    expect(new Set(deck).size).toBe(52);
  });

  it('覆盖每个花色和点数', () => {
    const deck = new Set(makeDeck());
    for (const s of SUITS) {
      for (const r of RANKS) {
        expect(deck.has(`${r}${s}`)).toBe(true);
      }
    }
  });
});

describe('shuffle', () => {
  it('不修改入参', () => {
    const original = makeDeck();
    const copy = [...original];
    shuffle(original);
    expect(original).toEqual(copy);
  });

  it('长度不变、无重复、牌面一致', () => {
    const original = makeDeck();
    const s = shuffle(original);
    expect(s).toHaveLength(52);
    expect(new Set(s).size).toBe(52);
    expect([...s].sort()).toEqual([...original].sort());
  });

  it('多次洗牌结果不同（概率性）', () => {
    const a = shuffle(makeDeck()).join(',');
    const b = shuffle(makeDeck()).join(',');
    expect(a).not.toBe(b);
  });

  it('分布大致均匀（1 万次抽样）', () => {
    const N = 10000;
    const counts = new Map();
    for (let i = 0; i < N; i++) {
      const top = shuffle(makeDeck())[0];
      counts.set(top, (counts.get(top) || 0) + 1);
    }
    const expected = N / 52;
    const tolerance = expected * 0.25; // 25% 容忍，跑 1 万次基本稳定
    for (const c of makeDeck()) {
      const n = counts.get(c) || 0;
      expect(Math.abs(n - expected)).toBeLessThan(tolerance);
    }
  });
});

describe('draw', () => {
  it('取 2 张，剩 50 张', () => {
    const deck = makeDeck();
    const [hand, rest] = draw(deck, 2);
    expect(hand).toHaveLength(2);
    expect(rest).toHaveLength(50);
  });

  it('取 5 张，剩 47 张', () => {
    const deck = makeDeck();
    const [board, rest] = draw(deck, 5);
    expect(board).toHaveLength(5);
    expect(rest).toHaveLength(47);
  });

  it('取出的牌 + 剩下的牌 = 原牌堆', () => {
    const deck = makeDeck();
    const [top, rest] = draw(deck, 7);
    expect([...top, ...rest]).toEqual(deck);
  });

  it('n = 0 时返回空数组', () => {
    const [top, rest] = draw(makeDeck(), 0);
    expect(top).toHaveLength(0);
    expect(rest).toHaveLength(52);
  });

  it('n = 52 时全取走', () => {
    const [top, rest] = draw(makeDeck(), 52);
    expect(top).toHaveLength(52);
    expect(rest).toHaveLength(0);
  });

  it('n 超过牌堆长度时报错', () => {
    expect(() => draw(makeDeck(), 53)).toThrow(/not enough cards/);
  });

  it('n 为负数时报错', () => {
    expect(() => draw(makeDeck(), -1)).toThrow(/non-negative integer/);
  });

  it('n 不是整数时报错', () => {
    expect(() => draw(makeDeck(), 1.5)).toThrow(/non-negative integer/);
  });
});