import { describe, it, expect } from 'vitest';
import { startHand, applyAction, toSnapshot, Street } from '../src/index.js';

/** 造一个 n 人桌，全部筹码 1000 */
function players(n, chips = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    seat: i, userId: `u${i}`, nickname: `P${i}`, chips,
  }));
}

/** 依次执行一组动作 */
function play(state, actions) {
  for (const [seat, action] of actions) {
    const r = applyAction(state, seat, action);
    state = r.state;
  }
  return state;
}

describe('startHand - 开局', () => {
  it('6 人开局，UTG 先行动，盲注已收', () => {
    const { state } = startHand({
      handId: 'h1', buttonSeat: 0,
      smallBlind: 10, bigBlind: 20,
      players: players(6),
    });
    expect(state.street).toBe(Street.PREFLOP);
    expect(state.currentTurnSeat).toBe(3); // UTG
    expect(state.seats[1].betThisStreet).toBe(10); // SB
    expect(state.seats[2].betThisStreet).toBe(20); // BB
    expect(state.currentBet).toBe(20);
    // 每人两张手牌
    for (const s of state.seats) expect(s.holeCards).toHaveLength(2);
  });

  it('单挑：BTN 也是 SB，翻前 BTN 先', () => {
    const { state } = startHand({
      handId: 'h2', buttonSeat: 0,
      smallBlind: 10, bigBlind: 20,
      players: players(2),
    });
    expect(state.currentTurnSeat).toBe(0); // BTN/SB
    expect(state.seats[0].betThisStreet).toBe(10);
    expect(state.seats[1].betThisStreet).toBe(20);
  });

  it('3 人：BTN 先翻前', () => {
    const { state } = startHand({
      handId: 'h3', buttonSeat: 0,
      smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    // 3 人翻前顺序：BTN -> SB -> BB
    expect(state.currentTurnSeat).toBe(0);
  });

  it('少于 2 人报错', () => {
    expect(() => startHand({
      handId: 'x', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(1),
    })).toThrow();
  });

  it('座位不连续报错', () => {
    expect(() => startHand({
      handId: 'x', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: [
        { seat: 0, chips: 1000 },
        { seat: 2, chips: 1000 },
      ],
    })).toThrow();
  });
});

describe('全员弃牌', () => {
  it('所有人弃到 BB，BB 赢下底池', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    // 3 人翻前顺序：BTN(0) -> SB(1) -> BB(2)
    state = play(state, [
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(state.settled).toBe(true);
    expect(state.result.forcedWinnerSeat).toBe(2);
    // BB 投了 20，赢 SB(10) + BB(20) = 30，净 +10
    expect(state.seats[2].chips).toBe(1010);
  });

  it('SB 弃牌、BB 弃牌，BTN 赢', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    state = play(state, [
      [0, { type: 'raise', amount: 60 }], // BTN raise to 60
      [1, { type: 'fold' }],
      [2, { type: 'fold' }],
    ]);
    expect(state.settled).toBe(true);
    expect(state.result.forcedWinnerSeat).toBe(0);
    // BTN 净赢 SB(10) + BB(20) = 30
    expect(state.seats[0].chips).toBe(1000 + 30);
  });
});

describe('进入翻牌', () => {
  it('全员 call / check，进入 FLOP，SB 先行动', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    // BTN call, SB call, BB check
    state = play(state, [
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    expect(state.street).toBe(Street.FLOP);
    expect(state.board).toHaveLength(3);
    expect(state.currentTurnSeat).toBe(1); // SB
    expect(state.currentBet).toBe(0);
  });

  it('BB 有 option：所有人 call 到 BB 后，BB 可以 check', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    state = play(state, [
      [0, { type: 'call' }],
      [1, { type: 'call' }],
    ]);
    // 现在轮到 BB(2)，还没结束
    expect(state.settled).toBe(false);
    expect(state.currentTurnSeat).toBe(2);
    // BB check
    state = play(state, [[2, { type: 'check' }]]);
    expect(state.street).toBe(Street.FLOP);
  });
});

describe('完整一条街到摊牌', () => {
  it('preflop call，flop check，turn check，river check，进摊牌', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(2),
    });
    // 单挑：BTN/SB(0) 先
    state = play(state, [
      [0, { type: 'call' }],
      [1, { type: 'check' }],
      [1, { type: 'check' }], // flop，BB 先（单挑）
      [0, { type: 'check' }],
      [1, { type: 'check' }], // turn
      [0, { type: 'check' }],
      [1, { type: 'check' }], // river
      [0, { type: 'check' }],
    ]);
    expect(state.street).toBe(Street.SETTLED);
    expect(state.result.pots).toHaveLength(1);
    expect(state.result.pots[0].amount).toBe(40);
    // 有一个人赢
    const winners = Object.keys(state.result.payouts);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // 总筹码守恒
    const total = state.seats.reduce((s, x) => s + x.chips, 0);
    expect(total).toBe(2000);
  });
});

describe('all-in 与边池', () => {
  it('三人 all-in 不同金额，结算正确', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: [
        { seat: 0, chips: 100, nickname: 'A' },
        { seat: 1, chips: 200, nickname: 'B' },
        { seat: 2, chips: 300, nickname: 'C' },
      ],
    });
    // 3 人顺序：BTN(0) -> SB(1) -> BB(2)
    // 每人 all-in
    state = play(state, [
      [0, { type: 'all_in' }],
      [1, { type: 'all_in' }],
      [2, { type: 'all_in' }],
    ]);
    expect(state.settled).toBe(true);
    expect(state.street).toBe(Street.SETTLED);
    // 总池 = 100 + 200 + 300 = 600
    expect(state.result.pots.reduce((s, p) => s + p.amount, 0)).toBe(600);
    // 筹码守恒
    const total = state.seats.reduce((s, x) => s + x.chips, 0);
    expect(total).toBe(600);
  });
  });

  it('翻前短 all-in 不重置别人的 hasActed，但已行动者需补差额', () => {
  let { state } = startHand({
    handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
    players: [
      { seat: 0, chips: 1000 }, // BTN
      { seat: 1, chips: 25 },   // SB
      { seat: 2, chips: 1000 }, // BB
    ],
  });

  // BTN call 20, SB all-in 25（只多 5），BB call 25
  state = play(state, [
    [0, { type: 'call' }],
    [1, { type: 'all_in' }],
    [2, { type: 'call' }],
  ]);

  // 短 all-in 后：BTN 面对 5 的差额，需要再行动
  expect(state.street).toBe(Street.PREFLOP);
  expect(state.currentTurnSeat).toBe(0);

  // BTN 补差额 5
  state = play(state, [[0, { type: 'call' }]]);

    // 现在进 FLOP
  expect(state.street).toBe(Street.FLOP);
  // 新街开始，betThisStreet 全部重置为 0
  expect(state.seats[0].betThisStreet).toBe(0);
  expect(state.seats[1].betThisStreet).toBe(0);
  expect(state.seats[2].betThisStreet).toBe(0);
  // totalCommitted 保留本手累计投入
  expect(state.seats[0].totalCommitted).toBe(25);
  expect(state.seats[1].totalCommitted).toBe(25);
  expect(state.seats[2].totalCommitted).toBe(25);
  // SB 已经 all-in
  expect(state.seats[1].allIn).toBe(true);
  // 底池 = 25 + 25 + 25 = 75
  const totalPot =
    state.seats[0].totalCommitted +
    state.seats[1].totalCommitted +
    state.seats[2].totalCommitted;
  expect(totalPot).toBe(75);
});

describe('toSnapshot', () => {
  it('隐藏非本人手牌', () => {
    const { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    const snap = toSnapshot(state, 0);
    expect(snap.seats[0].holeCards).toHaveLength(2);
    expect(snap.seats[1].holeCards).toHaveLength(0);
    expect(snap.seats[2].holeCards).toHaveLength(0);
    expect(snap.pot).toBe(30);
  });

  it('不传 forSeat，所有人手牌都空', () => {
    const { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    const snap = toSnapshot(state, null);
    for (const s of snap.seats) expect(s.holeCards).toHaveLength(0);
  });
});

describe('非法调用', () => {
  it('不是当前回合的人 applyAction 报错', () => {
    const { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    // 3 人翻前 BTN(0) 先
    expect(() => applyAction(state, 1, { type: 'fold' })).toThrow();
  });

  it('已结算再 applyAction 报错', () => {
    let { state } = startHand({
      handId: 'h', buttonSeat: 0, smallBlind: 10, bigBlind: 20,
      players: players(3),
    });
    state = play(state, [
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(state.settled).toBe(true);
    expect(() => applyAction(state, 2, { type: 'fold' })).toThrow();
  });
});

describe('筹码守恒（随机局）', () => {
  it('跑 100 局随机，筹码守恒', () => {
    for (let i = 0; i < 100; i++) {
      const n = 2 + (i % 5); // 2~6 人
      const initChips = 1000;
      const { state } = startHand({
        handId: `h${i}`, buttonSeat: i % n, smallBlind: 10, bigBlind: 20,
        players: players(n, initChips),
      });
      let s = state;
      let guard = 0;
      while (!s.settled && guard++ < 200) {
        const seat = s.currentTurnSeat;
        const me = s.seats.find((x) => x.seat === seat);
        const toCall = s.currentBet - me.betThisStreet;
        // 简单策略：能 check 就 check，否则 30% 弃牌 / 70% call
        let action;
        if (toCall === 0) action = { type: 'check' };
        else if (Math.random() < 0.3) action = { type: 'fold' };
        else action = { type: 'call' };
        const r = applyAction(s, seat, action);
        s = r.state;
      }
      expect(s.settled).toBe(true);
      const total = s.seats.reduce((a, x) => a + x.chips, 0);
      expect(total).toBe(n * initChips);
    }
  });
});