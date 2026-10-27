import { describe, it, expect } from 'vitest';
import { buildPots, totalPot, awardPots } from '../src/index.js';

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
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [0, 1, 2, 3], contributorSeats: [0, 1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 300, eligibleSeats: [1, 2, 3], contributorSeats: [1, 2, 3] });
    expect(pots[2]).toEqual({ amount: 200, eligibleSeats: [2, 3], contributorSeats: [2, 3] });
    expect(pots[3]).toEqual({ amount: 100, eligibleSeats: [3], contributorSeats: [3] });
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
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [0, 1, 2, 3], contributorSeats: [0, 1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 200, eligibleSeats: [2, 3], contributorSeats: [2, 3] });
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
    expect(pots[0]).toEqual({ amount: 400, eligibleSeats: [1, 2, 3], contributorSeats: [0, 1, 2, 3] });
    expect(pots[1]).toEqual({ amount: 300, eligibleSeats: [1, 2, 3], contributorSeats: [1, 2, 3] });
    expect(pots[2]).toEqual({ amount: 200, eligibleSeats: [2, 3], contributorSeats: [2, 3] });
    expect(pots[3]).toEqual({ amount: 100, eligibleSeats: [3], contributorSeats: [3] });
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
    expect(pots[0]).toEqual({ amount: 1000, eligibleSeats: [0, 1], contributorSeats: [0, 1] });
  });
});
describe('awardPots - 单人赢', () => {
  it('三人等额，牌力最高全拿', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    const w = awardPots(pots, new Map([[0, 100], [1, 500], [2, 200]]));
    expect(w.get(1)).toBe(300);
    expect(w.get(0)).toBeUndefined();
    expect(w.get(2)).toBeUndefined();
  });

  it('A all-in 100，B/C 各 200：A 牌最强，A 拿主池，B/C 争边池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    // A=900 最强，B=500 次之，C=100 最弱
    const w = awardPots(pots, new Map([[0, 900], [1, 500], [2, 100]]));
    // 主池 300 归 A
    // 边池 200 归 B
    expect(w.get(0)).toBe(300);
    expect(w.get(1)).toBe(200);
    expect(w.get(2)).toBeUndefined();
  });

  it('A all-in 100，B/C 各 200：B 牌最强，B 拿全部 500', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    const w = awardPots(pots, new Map([[0, 100], [1, 900], [2, 500]]));
    expect(w.get(1)).toBe(500);
    expect(w.get(0)).toBeUndefined();
    expect(w.get(2)).toBeUndefined();
  });
});

describe('awardPots - 平分', () => {
  it('两人并列最高，平分主池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    // 0 和 1 并列最高
    const w = awardPots(pots, new Map([[0, 500], [1, 500], [2, 100]]));
    // 300 / 2 = 150
    expect(w.get(0)).toBe(150);
    expect(w.get(1)).toBe(150);
    expect(w.get(2)).toBeUndefined();
  });

  it('三人并列最高，300 分三份各 100', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    const w = awardPots(pots, new Map([[0, 500], [1, 500], [2, 500]]));
    expect(w.get(0)).toBe(100);
    expect(w.get(1)).toBe(100);
    expect(w.get(2)).toBe(100);
  });

  it('300 分给 2 人除不尽，余数给座位号小的', () => {
    // 造一个 301 的池子：A=101, B=100, C=100
    const pots = buildPots([
      { seat: 0, amount: 101, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    // 层高 100 时三人，100 一层时 A 单人
    // 层0: 100*3 = 300, seats=[0,1,2]
    // 层1: 1*1 = 1,   seats=[0]
    expect(totalPot(pots)).toBe(301);

    const w = awardPots(pots, new Map([[0, 500], [1, 500], [2, 100]]));
    // 层0：0 和 1 并列 150 + 150
    // 层1：只有 0，拿 1
    expect(w.get(0)).toBe(151);
    expect(w.get(1)).toBe(150);
  });

  it('平分层池奇数：3 人争 100，余数给最小座位', () => {
    // 造一个池子 100，3 人并列
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    // 用一个奇怪的筹码量做奇数：改成 A=100 B=100 C=100 但赢家只算 2 人
    // 实际我们需要 3 人并列 + 100 不能被 3 整除。
    // 用单人层：A=1, B=0, C=0 —— 不行，0 会被过滤
    // 换思路：池 100，只有两人争，100/2=50 整除。
    // 我们直接手工造 pots：
    const manualPots = [{ amount: 100, eligibleSeats: [0, 1, 2] }];
    const w = awardPots(manualPots, new Map([[0, 500], [1, 500], [2, 500]]));
    // 100 / 3 = 33 余 1，座位号最小的 0 拿余数
    expect(w.get(0)).toBe(34);
    expect(w.get(1)).toBe(33);
    expect(w.get(2)).toBe(33);
  });
});

describe('awardPots - 弃牌与孤池', () => {
  it('无人有资格争的池层：原路退还给出资者，不会凭空消失', () => {
    const pots = buildPots([
      { seat: 0, amount: 300, folded: true },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    // pots[1] = { amount: 200, eligibleSeats: [], contributorSeats: [0] }
    const w = awardPots(pots, new Map([[1, 500], [2, 100]]));
    // pots[0] = 300，1 牌最强，1 拿 300
    expect(w.get(1)).toBe(300);
    // 顶层 200 只有座位 0 投过 → 退还给他
    expect(w.get(0)).toBe(200);
    expect(w.get(2)).toBeUndefined();
    // 守恒：派彩总额 == 池子总额
    const sum = [...w.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(totalPot(pots));
    expect(sum).toBe(500);
  });

  it('多人平分的孤池层：按人头均分，除不尽给最小座位', () => {
    const pots = buildPots([
      { seat: 0, amount: 150, folded: true },
      { seat: 1, amount: 150, folded: true },
      { seat: 2, amount: 100, folded: false },
    ]);
    // pots[1] = { amount: 100, eligibleSeats: [], contributorSeats: [0, 1] }
    const w = awardPots(pots, new Map([[2, 500]]));
    expect(w.get(2)).toBe(300);
    expect(w.get(0)).toBe(50);
    expect(w.get(1)).toBe(50);
    expect([...w.values()].reduce((a, b) => a + b, 0)).toBe(totalPot(pots));
  });
});

describe('awardPots - 全部筹码守恒', () => {
  it('赢得的筹码总和 == 参与分钱的池子总额', () => {
  const pots = buildPots([
    { seat: 0, amount: 100, folded: false },
    { seat: 1, amount: 200, folded: false },
    { seat: 2, amount: 300, folded: false },
    { seat: 3, amount: 400, folded: false },
  ]);
  const w = awardPots(pots, new Map([
    [0, 100], [1, 200], [2, 300], [3, 400],
  ]));
  let sum = 0;
  for (const v of w.values()) sum += v;
  expect(sum).toBe(totalPot(pots));
  // 牌力按投入金额递增，seat 3 每层都最强，应通吃 1000
  expect(w.get(3)).toBe(1000);
  expect(w.get(0)).toBeUndefined();
  expect(w.get(1)).toBeUndefined();
  expect(w.get(2)).toBeUndefined();
});

  it('4 人不同牌力，最低牌力拿自己专属的那层', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 300, folded: false },
      { seat: 3, amount: 400, folded: false },
    ]);
    // 牌力：0 最弱，3 最强
    const w = awardPots(pots, new Map([
      [0, 100], [1, 200], [2, 300], [3, 400],
    ]));
    // 各层赢家：
    // 层0 (400, [0,1,2,3]) -> 3
    // 层1 (300, [1,2,3])   -> 3
    // 层2 (200, [2,3])     -> 3
    // 层3 (100, [3])       -> 3
    expect(w.get(3)).toBe(1000);
    expect(w.get(0)).toBeUndefined();
    expect(w.get(1)).toBeUndefined();
    expect(w.get(2)).toBeUndefined();
  });
});
describe('awardPots - 规则验证（用户提问场景）', () => {
  it('A 投 300 牌最强，B 投 400 牌弱 -> A 拿 600，B 退回 100', () => {
    const pots = buildPots([
      { seat: 0, amount: 300, folded: false }, // A
      { seat: 1, amount: 400, folded: false }, // B
    ]);
    // 层0: 300*2=600, seats=[0,1]
    // 层1: 100*1=100, seats=[1]
    expect(pots).toHaveLength(2);

    const w = awardPots(pots, new Map([[0, 999], [1, 100]]));
    // A 拿 600
    expect(w.get(0)).toBe(600);
    // B 拿自己孤池的 100（退还）
    expect(w.get(1)).toBe(100);
  });

  it('A 投 300 牌弱，B 投 400 牌强 -> A 拿 0，B 拿 1000', () => {
    const pots = buildPots([
      { seat: 0, amount: 300, folded: false },
      { seat: 1, amount: 400, folded: false },
    ]);
    const w = awardPots(pots, new Map([[0, 100], [1, 999]]));
    // B 每层都赢：600 + 100 = 700... 等等
    // 层0: 600 -> B 赢
    // 层1: 100 -> 只有 B，B 赢
    // 合计 700？不对，B 只投了 400，A 投 300，总池 700
    // 但 layers 是 [300, 400]：
    //   层0 = 300*2 = 600
    //   层1 = (400-300)*1 = 100
    //   总计 700 = 300 + 400 ✓
    expect(w.get(1)).toBe(700);
    expect(w.get(0)).toBeUndefined();
  });

  it('边池必须比 B/C 牌力（A all-in 100 全下，B/C 各 200）', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false }, // A all-in 100
      { seat: 1, amount: 200, folded: false }, // B
      { seat: 2, amount: 200, folded: false }, // C
    ]);
    // 层0: 300, seats=[0,1,2]
    // 层1: 200, seats=[1,2]

    // A 牌力最强，B 次之，C 最弱
    const w = awardPots(pots, new Map([[0, 999], [1, 500], [2, 100]]));
    // 主池 300 -> A
    // 边池 200 -> B（因为 B > C）
    expect(w.get(0)).toBe(300);
    expect(w.get(1)).toBe(200);
    expect(w.get(2)).toBeUndefined();
  });

  it('边池比牌力 - C 更强时，C 拿边池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    // A 牌力最强，C 次之，B 最弱
    const w = awardPots(pots, new Map([[0, 999], [1, 100], [2, 500]]));
    // 主池 300 -> A
    // 边池 200 -> C
    expect(w.get(0)).toBe(300);
    expect(w.get(2)).toBe(200);
    expect(w.get(1)).toBeUndefined();
  });
});