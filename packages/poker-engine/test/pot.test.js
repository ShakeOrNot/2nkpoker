import { describe, it, expect } from 'vitest';
import { buildPots, totalPot } from '../src/index.js';

describe('buildPots - 基本', () => {
  it('三人等额，单池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2]);
  });

  it('弃牌玩家投钱但不参与', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: true },
      { seat: 2, amount: 100, folded: false },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats).toEqual([0, 2]);
  });

  it('无人投入，返回空数组', () => {
    const pots = buildPots([
      { seat: 0, amount: 0, folded: false },
      { seat: 1, amount: 0, folded: false },
    ]);
    expect(pots).toEqual([]);
  });

  it('单个玩家投入，单池', () => {
    const pots = buildPots([{ seat: 0, amount: 50, folded: false }]);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(50);
  });
});

describe('buildPots - 边池', () => {
  it('A all-in 100，B/C 各 200 -> 主池 300 + 边池 200', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2]);
    expect(pots[1].amount).toBe(200);
    expect(pots[1].eligibleSeats).toEqual([1, 2]);
    expect(totalPot(pots)).toBe(500);
  });

  it('三人全下不同金额：50 / 100 / 200', () => {
    const pots = buildPots([
      { seat: 0, amount: 50, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    expect(pots).toHaveLength(3);
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2]);
    expect(pots[1].amount).toBe(100);
    expect(pots[1].eligibleSeats).toEqual([1, 2]);
    expect(pots[2].amount).toBe(100);
    expect(pots[2].eligibleSeats).toEqual([2]);
    expect(totalPot(pots)).toBe(350);
  });

  it('弃牌玩家的大额下注进池，但不参与任何一层', () => {
    const pots = buildPots([
      { seat: 0, amount: 300, folded: true },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats).toEqual([1, 2]);
    expect(pots[1].amount).toBe(200);
    expect(pots[1].eligibleSeats).toEqual([]);
    expect(totalPot(pots)).toBe(500);
  });

  it('相同资格层会自动合并', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
      { seat: 3, amount: 100, folded: false },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(400);
  });

  it('四人 100/100/200/200 -> 主池 400 + 边池 200', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 200, folded: false },
      { seat: 3, amount: 200, folded: false },
    ]);
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(400);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2, 3]);
    expect(pots[1].amount).toBe(200);
    expect(pots[1].eligibleSeats).toEqual([2, 3]);
  });
});

describe('buildPots - 多人 all-in 多层边池', () => {
  it('4 人 A=100 B=200 C=300 D=400 -> 4 层池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 300, folded: false },
      { seat: 3, amount: 400, folded: false },
    ]);
    expect(pots).toHaveLength(4);
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [0, 1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 300, eligibleSeats: [1, 2, 3] });
    expect(pots[2]).toEqual({ amount: 200, eligibleSeats: [2, 3] });
    expect(pots[3]).toEqual({ amount: 100, eligibleSeats: [3] });
    expect(totalPot(pots)).toBe(1000);
  });

  it('5 人 50/100/150/200/250 -> 5 层池', () => {
    const pots = buildPots([
      { seat: 0, amount: 50,  folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 150, folded: false },
      { seat: 3, amount: 200, folded: false },
      { seat: 4, amount: 250, folded: false },
    ]);
    expect(pots).toHaveLength(5);
    expect(pots[0].amount).toBe(250);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2, 3, 4]);
    expect(pots[1].amount).toBe(200);
    expect(pots[1].eligibleSeats).toEqual([1, 2, 3, 4]);
    expect(pots[2].amount).toBe(150);
    expect(pots[2].eligibleSeats).toEqual([2, 3, 4]);
    expect(pots[3].amount).toBe(100);
    expect(pots[3].eligibleSeats).toEqual([3, 4]);
    expect(pots[4].amount).toBe(50);
    expect(pots[4].eligibleSeats).toEqual([4]);
    expect(totalPot(pots)).toBe(750);
  });

  it('6 人 10/20/30/40/50/60 -> 6 层池', () => {
    const pots = buildPots([
      { seat: 0, amount: 10, folded: false },
      { seat: 1, amount: 20, folded: false },
      { seat: 2, amount: 30, folded: false },
      { seat: 3, amount: 40, folded: false },
      { seat: 4, amount: 50, folded: false },
      { seat: 5, amount: 60, folded: false },
    ]);
    expect(pots).toHaveLength(6);
    expect(pots[0].amount).toBe(60);
    expect(pots[1].amount).toBe(50);
    expect(pots[2].amount).toBe(40);
    expect(pots[3].amount).toBe(30);
    expect(pots[4].amount).toBe(20);
    expect(pots[5].amount).toBe(10);
    expect(pots[5].eligibleSeats).toEqual([5]);
    expect(totalPot(pots)).toBe(210);
  });

  it('两人同额 all-in 与其他两人不同额（部分合并）', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 200, folded: false },
      { seat: 3, amount: 200, folded: false },
    ]);
    expect(pots).toHaveLength(2);
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [0, 1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 200, eligibleSeats: [2, 3] });
    expect(totalPot(pots)).toBe(600);
  });

  it('多人全下 + 一人弃牌：弃牌玩家钱在池子里，但不出现在任何层', () => {
  const pots = buildPots([
    { seat: 0, amount: 100, folded: true  },
    { seat: 1, amount: 200, folded: false },
    { seat: 2, amount: 300, folded: false },
    { seat: 3, amount: 400, folded: false },
  ]);
    expect(pots).toHaveLength(4);
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 300, eligibleSeats: [1, 2, 3] });
    expect(pots[2]).toEqual({ amount: 200, eligibleSeats: [2, 3] });
    expect(pots[3]).toEqual({ amount: 100, eligibleSeats: [3] });
    expect(totalPot(pots)).toBe(1000);
    expect(pots[0].amount).toBe(400);
    expect(pots[0].eligibleSeats).toEqual([1, 2, 3]);
    expect(pots[1].amount).toBe(300);
    expect(pots[1].eligibleSeats).toEqual([1, 2, 3]);
    expect(pots[2].amount).toBe(200);
    expect(pots[2].eligibleSeats).toEqual([2, 3]);
    expect(pots[3].amount).toBe(100);
    expect(pots[3].eligibleSeats).toEqual([3]);
    expect(totalPot(pots)).toBe(1000);
  });

  it('两人只 all-in 到同一层（对照）', () => {
    const pots = buildPots([
      { seat: 0, amount: 500, folded: false },
      { seat: 1, amount: 500, folded: false },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0]).toEqual({ amount: 1000, eligibleSeats: [0, 1] });
  });
});