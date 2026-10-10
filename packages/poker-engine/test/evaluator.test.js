import { describe, it, expect } from 'vitest';
import { evaluate5, evaluate7, compareHands, Category } from '../src/index.js';
import { makeDeck, shuffle, draw } from '../src/deck.js';

/** 快速造 5 张牌：'As Kh Qd Jc Ts' -> ['As','Kh','Qd','Jc','Ts'] */
const h = (s) => s.split(' ');

describe('evaluate5 - 基本牌型识别', () => {
  it('皇家同花顺', () => {
    expect(evaluate5(h('As Ks Qs Js Ts')).category).toBe(Category.ROYAL_FLUSH);
  });

  it('同花顺', () => {
    const v = evaluate5(h('9h 8h 7h 6h 5h'));
    expect(v.category).toBe(Category.STRAIGHT_FLUSH);
    expect(v.tiebreakers[0]).toBe(9);
  });

  it('轮子同花顺（A2345 同花）', () => {
    const v = evaluate5(h('Ah 2h 3h 4h 5h'));
    expect(v.category).toBe(Category.STRAIGHT_FLUSH);
    expect(v.tiebreakers[0]).toBe(5);
  });

  it('四条', () => {
    const v = evaluate5(h('As Ah Ad Ac Kd'));
    expect(v.category).toBe(Category.FOUR_OF_A_KIND);
    expect(v.tiebreakers).toEqual([14, 13]);
  });

  it('葫芦', () => {
    const v = evaluate5(h('As Ah Ad Kc Kd'));
    expect(v.category).toBe(Category.FULL_HOUSE);
    expect(v.tiebreakers).toEqual([14, 13]);
  });

  it('同花', () => {
    const v = evaluate5(h('As Ks Qs Js 9s'));
    expect(v.category).toBe(Category.FLUSH);
  });

  it('顺子', () => {
    const v = evaluate5(h('9h 8s 7d 6c 5h'));
    expect(v.category).toBe(Category.STRAIGHT);
    expect(v.tiebreakers[0]).toBe(9);
  });

  it('轮子顺（A2345，非顺子中的 A 高）', () => {
    const v = evaluate5(h('Ah 2s 3d 4c 5h'));
    expect(v.category).toBe(Category.STRAIGHT);
    expect(v.tiebreakers[0]).toBe(5);
  });

  it('三条', () => {
    const v = evaluate5(h('As Ah Ad Kc Qd'));
    expect(v.category).toBe(Category.THREE_OF_A_KIND);
    expect(v.tiebreakers).toEqual([14, 13, 12]);
  });

  it('两对', () => {
    const v = evaluate5(h('As Ah Kc Kd Qd'));
    expect(v.category).toBe(Category.TWO_PAIR);
    expect(v.tiebreakers).toEqual([14, 13, 12]);
  });

  it('一对', () => {
    const v = evaluate5(h('As Ah Kc Qd Jd'));
    expect(v.category).toBe(Category.ONE_PAIR);
    expect(v.tiebreakers).toEqual([14, 13, 12, 11]);
  });

  it('高牌', () => {
    const v = evaluate5(h('As Kh Qd Jc 9s'));
    expect(v.category).toBe(Category.HIGH_CARD);
  });
});

describe('compareHands - 同类型比较', () => {
  it('四条：A 四条 > K 四条', () => {
    const a = evaluate5(h('As Ah Ad Ac 2d'));
    const b = evaluate5(h('Ks Kh Kd Kc Ad'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('四条同点数时比 kicker', () => {
    const a = evaluate5(h('As Ah Ad Ac Kd'));
    const b = evaluate5(h('As Ah Ad Ac Qd'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('葫芦：AAA22 > KKKQQ', () => {
    const a = evaluate5(h('As Ah Ad 2c 2d'));
    const b = evaluate5(h('Ks Kh Kd Qc Qd'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('同花比逐张点数', () => {
    const a = evaluate5(h('As Ks Qs Js 9s'));
    const b = evaluate5(h('As Ks Qs Ts 9s'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('顺子：9TJQK > 56789', () => {
    const a = evaluate5(h('9h Ts Jd Qc Kh'));
    const b = evaluate5(h('5h 6s 7d 8c 9h'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('轮子顺 5 高 < 6 高顺', () => {
    const wheel = evaluate5(h('Ah 2s 3d 4c 5h'));
    const six = evaluate5(h('2h 3s 4d 5c 6h'));
    expect(compareHands(six, wheel)).toBeGreaterThan(0);
  });

  it('两对：AA KK Q > AA KK J', () => {
    const a = evaluate5(h('As Ah Kc Kd Qd'));
    const b = evaluate5(h('As Ah Kc Kd Jd'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('一对：AA KQJ > AA KQT', () => {
    const a = evaluate5(h('As Ah Kc Qd Jd'));
    const b = evaluate5(h('As Ah Kc Qd Td'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('完全相同牌力平局', () => {
    const a = evaluate5(h('As Ah Kc Qd Jd'));
    const b = evaluate5(h('Ac Ad Kh Qs Js'));
    expect(compareHands(a, b)).toBe(0);
  });

  it('高牌比到第 5 张', () => {
    const a = evaluate5(h('As Kh Qd Jc 9s'));
    const b = evaluate5(h('As Kh Qd Jc 8s'));
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });
});

describe('牌型等级优先于 kicker', () => {
  it('一对 A 大不过两对 2', () => {
    const pairA = evaluate5(h('As Ah Kc Qd Jd'));
    const twoPair2 = evaluate5(h('2s 2h 3c 3d 4d'));
    expect(compareHands(twoPair2, pairA)).toBeGreaterThan(0);
  });

  it('同花大不过葫芦', () => {
    const flush = evaluate5(h('As Ks Qs Js 9s'));
    const fullHouse = evaluate5(h('2s 2h 2c 3d 3d'));
    expect(compareHands(fullHouse, flush)).toBeGreaterThan(0);
  });
});

describe('evaluate7 - 从 7 张选最佳 5 张', () => {
  it('7 张里凑出同花', () => {
    const v = evaluate7(h('As Ks Qs Js 9s 2h 3d'));
    expect(v.category).toBe(Category.FLUSH);
  });

  it('7 张里凑出顺子', () => {
    const v = evaluate7(h('9h 8s 7d 6c 5h Kd 2s'));
    expect(v.category).toBe(Category.STRAIGHT);
    expect(v.tiebreakers[0]).toBe(9);
  });

  it('7 张里两对 + 三条可以凑葫芦', () => {
    // 手牌 As Ah，公共 Ad Kc Kd 2s 3h
    // 三条 A + 一对 K = 葫芦
    const v = evaluate7(h('As Ah Ad Kc Kd 2s 3h'));
    expect(v.category).toBe(Category.FULL_HOUSE);
  });

  it('7 张里同花 + 顺子取同花顺', () => {
    const v = evaluate7(h('9h 8h 7h 6h 5h Kc 2s'));
    expect(v.category).toBe(Category.STRAIGHT_FLUSH);
  });

  it('7 张里取最大的两对', () => {
    // As Ah Kc Kd Qs Qd 2h -> 应该取 AA KK Q
    const v = evaluate7(h('As Ah Kc Kd Qs Qd 2h'));
    expect(v.category).toBe(Category.TWO_PAIR);
    expect(v.tiebreakers).toEqual([14, 13, 12]);
  });

  it('5 张时 evaluate7 等同于 evaluate5', () => {
    const cards = h('As Ks Qs Js Ts');
    expect(evaluate7(cards).category).toBe(Category.ROYAL_FLUSH);
  });

  it('6 张也能处理', () => {
    const v = evaluate7(h('As Ah Ad Kc Qd Jd'));
    expect(v.category).toBe(Category.THREE_OF_A_KIND);
  });
});

describe('边界与随机', () => {
  it('7 张随机跑 10000 次不报错', () => {
  for (let i = 0; i < 10000; i++) {
      const [cards] = draw(shuffle(makeDeck()), 7);
      const v = evaluate7(cards);
      expect(v.category).toBeGreaterThanOrEqual(0);
      expect(v.category).toBeLessThanOrEqual(9);
  }
  });

  it('evaluate5 传入非 5 张时报错', () => {
    expect(() => evaluate5(h('As Kh Qd Jc'))).toThrow();
    expect(() => evaluate5(h('As Kh Qd Jc Ts 9h'))).toThrow();
  });

  it('evaluate7 传入少于 5 张或多于 7 张时报错', () => {
    expect(() => evaluate7(h('As Kh Qd Jc'))).toThrow();
    expect(() => evaluate7(h('As Kh Qd Jc Ts 9h 8s 7d'))).toThrow();
  });
});