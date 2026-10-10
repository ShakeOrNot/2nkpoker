import { describe, it, expect } from 'vitest';
import { calcBetSize, BetFraction } from '../src/index.js';

function base(over) {
  return {
    pot: 100,
    fraction: 0.5,
    currentBet: 0,
    myBetThisStreet: 0,
    chips: 1000,
    minRaise: 20,
    bigBlind: 20,
    ...over,
  };
}

describe('calcBetSize - 无人下注（bet）', () => {
  it('1/2 pot', () => {
    const r = calcBetSize(base({ pot: 100, fraction: 0.5 }));
    expect(r.type).toBe('bet');
    expect(r.amount).toBe(50);
    expect(r.capped).toBe(false);
    expect(r.isAllIn).toBe(false);
  });

  it('2/3 pot', () => {
    const r = calcBetSize(base({ pot: 100, fraction: 2 / 3 }));
    expect(r.amount).toBe(67); // 66.67 四舍五入
  });

  it('1 pot', () => {
    const r = calcBetSize(base({ pot: 100, fraction: 1 }));
    expect(r.amount).toBe(100);
  });

  it('1.2 pot', () => {
    const r = calcBetSize(base({ pot: 100, fraction: 1.2 }));
    expect(r.amount).toBe(120);
  });

  it('目标小于 bigBlind 时抬到 bigBlind', () => {
    const r = calcBetSize(base({ pot: 20, fraction: 0.5, bigBlind: 20 }));
    // 0.5 * 20 = 10 < 20
    expect(r.amount).toBe(20);
  });

  it('pot = 0 时仍然至少 bigBlind', () => {
    const r = calcBetSize(base({ pot: 0, fraction: 0.5, bigBlind: 20 }));
    expect(r.amount).toBe(20);
  });

  it('筹码不足时被截断（capped）', () => {
    const r = calcBetSize(base({ pot: 1000, fraction: 1, chips: 300 }));
    // 目标 1000，但只有 300
    expect(r.amount).toBe(300);
    expect(r.capped).toBe(true);
    expect(r.isAllIn).toBe(true);
  });
});

describe('calcBetSize - 有人下注（raise）', () => {
  it('1/2 pot raise，无人下注过自己（toCall = 50）', () => {
    // pot=100, currentBet=50, myBet=0
    // toCall=50, raise_to = 50 + 0.5*(100 + 100) = 50 + 100 = 150
    const r = calcBetSize(base({
      pot: 100, fraction: 0.5, currentBet: 50, myBetThisStreet: 0,
    }));
    expect(r.type).toBe('raise');
    expect(r.amount).toBe(150);
  });

  it('full pot raise', () => {
    // pot=100, currentBet=50, myBet=0
    // toCall=50, raise_to = 50 + 1*(100 + 100) = 250
    const r = calcBetSize(base({
      pot: 100, fraction: 1, currentBet: 50, myBetThisStreet: 0,
    }));
    expect(r.amount).toBe(250);
  });

  it('1.2 pot raise', () => {
    // pot=100, currentBet=50, myBet=0
    // toCall=50, raise_to = 50 + 1.2*(100 + 100) = 290
    const r = calcBetSize(base({
      pot: 100, fraction: 1.2, currentBet: 50, myBetThisStreet: 0,
    }));
    expect(r.amount).toBe(290);
  });

  it('我已经投过一部分（toCall 更小）', () => {
    // pot=100, currentBet=100, myBet=50
    // toCall=50, raise_to = 100 + 0.5*(100 + 100) = 200
    const r = calcBetSize(base({
      pot: 100, fraction: 0.5, currentBet: 100, myBetThisStreet: 50,
    }));
    expect(r.amount).toBe(200);
  });

  it('raise 目标小于 minRaise 时被抬到 minRaise', () => {
    // pot=10, currentBet=20, myBet=0, minRaise=20
    // toCall=20, target = 20 + 0.5*(10 + 40) = 45
    // 其实 45 > 40 不会触发 minRaise
    // 用一个更小的 fraction 触发
    const r = calcBetSize(base({
      pot: 0, fraction: 1 / 3, currentBet: 20, myBetThisStreet: 0, minRaise: 20,
    }));
    // toCall=20, target = 20 + (1/3)*(0 + 40) = 20 + 13.33 = 33.33 -> 33
    // minTarget = 20 + 20 = 40
    // 最终 40
    expect(r.amount).toBe(40);
  });

  it('筹码不足时被截断', () => {
    // pot=1000, currentBet=100, myBet=0, chips=150
    // toCall=100, target = 100 + 1*(1000 + 200) = 1300
    // 但 maxTarget = 0 + 150 = 150
    const r = calcBetSize(base({
      pot: 1000, fraction: 1, currentBet: 100, myBetThisStreet: 0, chips: 150,
    }));
    expect(r.amount).toBe(150);
    expect(r.capped).toBe(true);
    expect(r.isAllIn).toBe(true);
  });

  it('我本街已有下注，筹码按 total 计算', () => {
    // 我本街投了 100，剩 200，chips=200, myBet=100
    // maxTarget = 100 + 200 = 300
    const r = calcBetSize(base({
      pot: 500, fraction: 1.2, currentBet: 200, myBetThisStreet: 100, chips: 200,
    }));
    // toCall=100, target = 200 + 1.2*(500 + 200) = 200 + 840 = 1040
    // maxTarget = 300，capped
    expect(r.amount).toBe(300);
    expect(r.capped).toBe(true);
  });
});

describe('calcBetSize - 输入校验', () => {
  it('fraction <= 0 报错', () => {
    expect(() => calcBetSize(base({ fraction: 0 }))).toThrow();
    expect(() => calcBetSize(base({ fraction: -0.5 }))).toThrow();
  });

  it('chips <= 0 报错', () => {
    expect(() => calcBetSize(base({ chips: 0 }))).toThrow();
    expect(() => calcBetSize(base({ chips: -10 }))).toThrow();
  });

  it('pot < 0 报错', () => {
    expect(() => calcBetSize(base({ pot: -1 }))).toThrow();
  });
});

describe('BetFraction 常量', () => {
  it('包含 5 个快捷比例', () => {
    expect(BetFraction.THIRD).toBeCloseTo(1 / 3);
    expect(BetFraction.HALF).toBe(0.5);
    expect(BetFraction.TWO_THIRDS).toBeCloseTo(2 / 3);
    expect(BetFraction.FULL).toBe(1);
    expect(BetFraction.ONE_POINT_TWO).toBe(1.2);
  });
});