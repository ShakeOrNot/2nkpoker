/**
 * 前端纯逻辑层测试（不依赖任何 npm 包、不需要浏览器）
 * 运行：node apps/web/test/run-tests.mjs
 */

import { describe, it, expect } from 'vitest';
import {
  makeRoomId,
  isValidRoomId,
  normalizeRoomInput,
  shareUrl,
  validateBuyIn,
  validateRoomConfig,
  defaultRoomConfig,
  handRunning,
  myHandSeat,
  toCallAmount,
  maxBetTarget,
  allInAmount,
  validateBetAmount,
  potFractionTarget,
  quickBets,
  deriveLegalActions,
  isMyTurn,
  positionOf,
  settlement,
  chipDelta,
  evaluate5,
  compareHands,
  evaluate7,
  bestCategory,
  strengthOf,
  buildPots,
  awardPots,
} from '../public/js/core/logic.js';
import { chips, potPercent, cardText, isRedCard, seconds } from '../public/js/core/format.js';
import { BLIND_LEVELS, MIN_BUY_IN, MAX_BUY_IN } from '../public/js/core/constants.js';

/* ---------------- 测试夹具 ---------------- */

/**
 * 造一份 hand 快照
 * @param {any} over
 */
function hand(over = {}) {
  const seats = over.seats ?? [
    { seat: 0, userId: 'a', nickname: 'A', chips: 1000, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false, holeCards: [] },
    { seat: 1, userId: 'b', nickname: 'B', chips: 1000, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false, holeCards: [] },
    { seat: 2, userId: 'c', nickname: 'C', chips: 1000, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false, holeCards: [] },
  ];
  return {
    handId: 'h1',
    street: 'PREFLOP',
    board: [],
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    seats,
    currentTurnSeat: 0,
    currentBet: over.currentBet ?? 0,
    minRaise: 20,
    pot: over.pot ?? 100,
    version: 3,
    settled: over.settled ?? false,
    result: over.result ?? null,
    ...over,
  };
}

describe('房间号', () => {
  it('生成的房号合法且不含易混字符', () => {
    for (let i = 0; i < 50; i++) {
      const id = makeRoomId();
      expect(id).toHaveLength(6);
      expect(isValidRoomId(id)).toBe(true);
      expect(/[il o01]/.test(id)).toBe(false);
    }
  });

  it('校验非法房号', () => {
    expect(isValidRoomId('')).toBe(false);
    expect(isValidRoomId('a')).toBe(false);
    expect(isValidRoomId('带中文')).toBe(false);
    expect(isValidRoomId('abc-123_x')).toBe(true);
  });

  it('能从分享链接里解析房号', () => {
    expect(normalizeRoomInput('http://192.168.1.5:8080/?table=abc123')).toBe('abc123');
    expect(normalizeRoomInput('http://x/#/table/xyz9')).toBe('xyz9');
    expect(normalizeRoomInput('  abc123  ')).toBe('abc123');
    expect(normalizeRoomInput('')).toBe('');
  });

  it('分享链接基于当前页面地址', () => {
    expect(shareUrl('http://host:8080/index.html?a=1', 'abc')).toBe('http://host:8080/index.html?table=abc');
  });
});

describe('牌局配置校验', () => {
  it('买入按"1 个 = 100BB"的整数倍校验（默认档 2000~100000）', () => {
    expect(validateBuyIn(MIN_BUY_IN).ok).toBe(true);
    expect(validateBuyIn(MAX_BUY_IN).ok).toBe(true);
    expect(validateBuyIn(MIN_BUY_IN - 1).ok).toBe(false);
    expect(validateBuyIn(MAX_BUY_IN + 1).ok).toBe(false);
    expect(validateBuyIn(2500).ok).toBe(false); // 不是 2000 的整数倍
    expect(validateBuyIn(NaN).ok).toBe(false);
    // 25/50 档：1 个买入 = 5000
    expect(validateBuyIn(5000, 50).ok).toBe(true);
    expect(validateBuyIn(2000, 50).ok).toBe(false);
  });

  it('座位数 2~6，盲注要合法', () => {
    expect(validateRoomConfig({ maxSeats: 2, smallBlind: 10, bigBlind: 20, buyIn: 2000 }).ok).toBe(true);
    expect(validateRoomConfig({ maxSeats: 6, smallBlind: 10, bigBlind: 20, buyIn: 2000 }).ok).toBe(true);
    expect(validateRoomConfig({ maxSeats: 7, smallBlind: 10, bigBlind: 20, buyIn: 2000 }).ok).toBe(false);
    expect(validateRoomConfig({ maxSeats: 1, smallBlind: 10, bigBlind: 20, buyIn: 2000 }).ok).toBe(false);
    expect(validateRoomConfig({ maxSeats: 6, smallBlind: 50, bigBlind: 20, buyIn: 2000 }).ok).toBe(false);
    expect(validateRoomConfig({ maxSeats: 6, smallBlind: 10, bigBlind: 20, buyIn: 50 }).ok).toBe(false);
    expect(validateRoomConfig({ maxSeats: 6, smallBlind: 10, bigBlind: 20, ante: -1 }).ok).toBe(false);
  });

  it('盲注只保留 10/20 一档', () => {
    expect(BLIND_LEVELS.length).toBe(1);
    expect(BLIND_LEVELS[0].smallBlind).toBe(10);
    expect(BLIND_LEVELS[0].bigBlind).toBe(20);
  });

  it('默认配置跟随盲注档位', () => {
    const cfg = defaultRoomConfig(0);
    expect(cfg.smallBlind).toBe(BLIND_LEVELS[0].smallBlind);
    expect(cfg.bigBlind).toBe(BLIND_LEVELS[0].bigBlind);
    expect(cfg.buyIn).toBe(BLIND_LEVELS[0].bigBlind * 100);
    expect(cfg.ante).toBe(5);
    expect(cfg.maxSeats).toBe(6);
  });
});

describe('手牌基础计算', () => {
  it('识别进行中的手牌', () => {
    expect(handRunning(hand())).toBe(true);
    expect(handRunning(hand({ settled: true }))).toBe(false);
    expect(handRunning(null)).toBe(false);
  });

  it('找我的座位', () => {
    const h = hand();
    expect(myHandSeat(h, 1)?.nickname).toBe('B');
    expect(myHandSeat(h, 5)).toBeNull();
    expect(myHandSeat(h, null)).toBeNull();
  });

  it('跟注额 = 当前注 - 我本街已下注', () => {
    const h = hand({ currentBet: 60, seats: [
      { seat: 0, chips: 1000, betThisStreet: 20, totalCommitted: 20, folded: false, allIn: false },
      { seat: 1, chips: 1000, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false },
    ] });
    expect(toCallAmount(h, 0)).toBe(40);
    expect(toCallAmount(h, 1)).toBe(60);
    expect(toCallAmount(h, 9)).toBe(0);
  });

  it('本街可下注上限 = 本街已下注 + 剩余筹码', () => {
    const h = hand({ currentBet: 20, seats: [
      { seat: 0, chips: 800, betThisStreet: 200, totalCommitted: 200, folded: false, allIn: false },
    ] });
    expect(maxBetTarget(h, 0)).toBe(1000);
    expect(allInAmount(h, 0)).toBe(800);
  });
});

describe('下注金额校验', () => {
  it('未有人下注：不低于大盲', () => {
    const h = hand({ currentBet: 0, bigBlind: 20 });
    expect(validateBetAmount(h, 0, 20).ok).toBe(true);
    expect(validateBetAmount(h, 0, 19).ok).toBe(false);
    expect(validateBetAmount(h, 0, 0).ok).toBe(false);
    expect(validateBetAmount(h, 0, -5).ok).toBe(false);
  });

  it('有人下注：加注至少到 currentBet + minRaise', () => {
    const h = hand({ currentBet: 50, minRaise: 20 });
    expect(validateBetAmount(h, 0, 70).ok).toBe(true);
    expect(validateBetAmount(h, 0, 69).ok).toBe(false);
    expect(validateBetAmount(h, 0, 69).reason).toContain('70');
  });

  it('金额不得超过自己的筹码上限（核心约束）', () => {
    const h = hand({
      currentBet: 0,
      seats: [{ seat: 0, chips: 300, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    });
    const over = validateBetAmount(h, 0, 301);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('INSUFFICIENT_CHIPS');
    expect(over.clamped).toBe(300);
    const exact = validateBetAmount(h, 0, 300);
    expect(exact.ok).toBe(true);
  });

  it('已下注过的人：上限包含本街已下注部分', () => {
    const h = hand({
      currentBet: 100,
      seats: [{ seat: 0, chips: 200, betThisStreet: 100, totalCommitted: 100, folded: false, allIn: false }],
    });
    expect(validateBetAmount(h, 0, 300).ok).toBe(true);   // 全下
    expect(validateBetAmount(h, 0, 301).ok).toBe(false);
  });

  it('全下可以低于最小加注', () => {
    const h = hand({
      currentBet: 100,
      minRaise: 50,
      seats: [{ seat: 0, chips: 30, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    });
    // 上限 30 < 150，但正好是全下 → 放行
    expect(validateBetAmount(h, 0, 30).ok).toBe(true);
  });

  it('没座位时直接拒绝', () => {
    expect(validateBetAmount(hand(), 9, 100).ok).toBe(false);
  });
});

describe('按底池比例算金额', () => {
  it('无人下注时按底池比例，且不低于大盲', () => {
    const base = { pot: 100, currentBet: 0, myBetThisStreet: 0, chips: 10000, minRaise: 20, bigBlind: 20 };
    expect(potFractionTarget({ ...base, fraction: 0.5 })).toBe(50);
    expect(potFractionTarget({ ...base, fraction: 1 })).toBe(100);
    expect(potFractionTarget({ ...base, pot: 10, fraction: 0.5 })).toBe(20); // 抬到大盲
  });

  it('有人下注时用 currentBet + fraction*(pot + 2*toCall)', () => {
    const input = { pot: 100, currentBet: 50, myBetThisStreet: 0, chips: 10000, minRaise: 20, bigBlind: 20 };
    expect(potFractionTarget({ ...input, fraction: 0.5 })).toBe(150);
    expect(potFractionTarget({ ...input, fraction: 1 })).toBe(250);
  });

  it('筹码不够时截断到全下', () => {
    const input = { pot: 1000, currentBet: 0, myBetThisStreet: 0, chips: 300, minRaise: 20, bigBlind: 20 };
    expect(potFractionTarget({ ...input, fraction: 1 })).toBe(300);
  });
});

describe('快捷下注按钮', () => {
  it('需要跟注时第一个是跟注，最后一个是全下', () => {
    const h = hand({ currentBet: 50, pot: 150 });
    const quicks = quickBets(h, 0);
    expect(quicks[0].kind).toBe('call');
    expect(quicks[0].amount).toBe(0);
    expect(quicks[quicks.length - 1].kind).toBe('allin');
    expect(quicks[quicks.length - 1].amount).toBe(1000);
  });

  it('五个底池比例按钮齐全，且按金额从小到大排列', () => {
    const quicks = quickBets(hand({ pot: 100 }), 0).filter((q) => q.kind === 'preset');
    expect(quicks.map((q) => q.key)).toEqual(['third', 'half', 'twoThirds', 'full', 'onePointTwo']);
    expect(quicks.map((q) => q.fraction)).toEqual([1 / 3, 0.5, 2 / 3, 1, 1.2]);
    for (let i = 1; i < quicks.length; i++) {
      expect(quicks[i].amount > quicks[i - 1].amount).toBe(true);
    }
  });

  it('1/3 池：无人下注 = round(pot/3)，且不低于大盲', () => {
    const q = quickBets(hand({ pot: 100 }), 0).find((x) => x.key === 'third');
    expect(q.amount).toBe(33);
    expect(q.label).toBe('1/3 池 33');
    // 底池 30、大盲 20 → 10 被抬到大盲
    expect(quickBets(hand({ pot: 30, bigBlind: 20 }), 0).find((x) => x.key === 'third').amount).toBe(20);
  });

  it('1/3 池：有人下注 = currentBet + (1/3)(pot + 2×toCall)', () => {
    // pot=100, currentBet=50, toCall=50 → 50 + 200/3 = 116.67 → 117
    const q = quickBets(hand({ currentBet: 50, pot: 100 }), 0).find((x) => x.key === 'third');
    expect(q.amount).toBe(117);
  });

  it('1.2 池：无人下注 = round(1.2 × pot)', () => {
    const q = quickBets(hand({ pot: 100 }), 0).find((x) => x.key === 'onePointTwo');
    expect(q.amount).toBe(120);
    expect(q.label).toBe('1.2 池 120');
    expect(quickBets(hand({ pot: 200 }), 0).find((x) => x.key === 'onePointTwo').amount).toBe(240);
  });

  it('1.2 池：有人下注时是超额加注（一定大于满池）', () => {
    // pot=400, currentBet=100, myBet=0 → toCall=100 → 100 + 1.2×600 = 820
    const h = hand({ currentBet: 100, pot: 400 });
    const oneTwo = quickBets(h, 0).find((x) => x.key === 'onePointTwo');
    const full = quickBets(h, 0).find((x) => x.key === 'full');
    expect(oneTwo.amount).toBe(820);
    expect(full.amount).toBe(700);
    expect(oneTwo.amount > full.amount).toBe(true);
  });

  it('筹码不够时两个新按钮会被截断或跳过，绝不超出筹码上限', () => {
    const h = hand({
      pot: 5000,
      seats: [{ seat: 0, chips: 150, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    });
    for (const q of quickBets(h, 0)) {
      expect(q.amount <= 150).toBe(true);
    }
    // 150 筹码够不到任何比例的合法下注额 → 只剩最小下注与全下
    expect(quickBets(h, 0).map((q) => q.key)).toEqual(['min', 'allin']);
  });

  it('所有快捷金额都不超过自己筹码上限', () => {
    const h = hand({
      currentBet: 0,
      pot: 5000,
      seats: [{ seat: 0, chips: 400, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    });
    for (const q of quickBets(h, 0)) {
      expect(q.amount <= 400).toBe(true);
    }
  });

  it('没有半池按钮时不会出现低于最小加注的选项', () => {
    const h = hand({ currentBet: 100, minRaise: 100, pot: 20 });
    for (const q of quickBets(h, 0)) {
      if (q.kind === 'preset' || q.kind === 'min') {
        expect(q.amount >= 200).toBe(true);
      }
    }
  });

  it('未入座返回空数组', () => {
    expect(quickBets(hand(), 9)).toEqual([]);
  });
});

describe('合法动作推导', () => {
  it('无人下注：fold/check/bet/all_in', () => {
    const h = hand({ currentBet: 0 });
    expect(deriveLegalActions(h, 0).sort()).toEqual(['all_in', 'bet', 'check', 'fold']);
  });

  it('面对下注：fold/call/raise/all_in', () => {
    const h = hand({ currentBet: 50 });
    expect(deriveLegalActions(h, 0).sort()).toEqual(['all_in', 'call', 'fold', 'raise']);
  });

  it('不是我的回合：空', () => {
    const h = hand({ currentTurnSeat: 1 });
    expect(deriveLegalActions(h, 0)).toEqual([]);
    expect(isMyTurn(h, 0)).toBe(false);
    expect(isMyTurn(h, 1)).toBe(true);
  });

  it('已弃牌 / 已全下：空', () => {
    const folded = hand({ seats: [{ seat: 0, chips: 100, betThisStreet: 0, folded: true, allIn: false }] });
    expect(deriveLegalActions(folded, 0)).toEqual([]);
    const allIn = hand({ seats: [{ seat: 0, chips: 0, betThisStreet: 100, folded: false, allIn: true }] });
    expect(deriveLegalActions(allIn, 0)).toEqual([]);
  });

  it('筹码不足跟注时不能加注', () => {
    const h = hand({
      currentBet: 100,
      seats: [{ seat: 0, chips: 100, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    });
    const legal = deriveLegalActions(h, 0);
    expect(legal.includes('raise')).toBe(false);
    expect(legal.includes('call')).toBe(true);
  });
});

describe('位置名', () => {
  it('6 人桌按钮位在 0', () => {
    const h = hand({ buttonSeat: 0, seats: [0, 1, 2, 3, 4, 5].map((i) => ({ seat: i, chips: 100, betThisStreet: 0, folded: false, allIn: false })) });
    expect(positionOf(h, 0)).toBe('BTN');
    expect(positionOf(h, 1)).toBe('SB');
    expect(positionOf(h, 2)).toBe('BB');
    expect(positionOf(h, 3)).toBe('UTG');
    expect(positionOf(h, 5)).toBe('CO');
  });

  it('单挑：按钮位同时是小盲', () => {
    const h = hand({ buttonSeat: 0, seats: [0, 1].map((i) => ({ seat: i, chips: 100, betThisStreet: 0, folded: false, allIn: false })) });
    expect(positionOf(h, 0)).toBe('BTN');
    expect(positionOf(h, 1)).toBe('BB');
  });

  it('没有手牌时返回空串', () => {
    expect(positionOf(null, 0)).toBe('');
  });
});

describe('结算明细', () => {
  it('赢家净变化为正，输家为负，筹码守恒', () => {
    const h = hand({
      settled: true,
      board: ['2c', '7d', '9h', 'Js', 'Qd'],
      seats: [
        { seat: 0, userId: 'a', nickname: 'A', chips: 1200, betThisStreet: 0, totalCommitted: 100, folded: false, allIn: false, holeCards: ['As', 'Ah'] },
        { seat: 1, userId: 'b', nickname: 'B', chips: 900, betThisStreet: 0, totalCommitted: 100, folded: false, allIn: false, holeCards: ['Ks', 'Kh'] },
      ],
      result: {
        pots: [{ amount: 200, eligibleSeats: [0, 1] }],
        payouts: { 0: 200 },
        revealed: { 0: ['As', 'Ah'], 1: ['Ks', 'Kh'] },
        forcedWinnerSeat: null,
      },
    });
    const s = settlement(h);
    expect(s.totalPaid).toBe(200);
    const a = s.rows.find((r) => r.seat === 0);
    const b = s.rows.find((r) => r.seat === 1);
    expect(a.net).toBe(100);
    expect(b.net).toBe(-100);
    expect(a.net + b.net).toBe(0);
    expect(s.rows[0].seat).toBe(0); // 赢得多的排前面
  });

  it('孤池退款会被标记成 refundOnly', () => {
    const h = hand({
      settled: true,
      seats: [
        { seat: 0, userId: 'a', nickname: 'A', chips: 300, betThisStreet: 0, totalCommitted: 300, folded: true, allIn: false, holeCards: [] },
        { seat: 1, userId: 'b', nickname: 'B', chips: 500, betThisStreet: 0, totalCommitted: 300, folded: false, allIn: false, holeCards: [] },
      ],
      result: {
        pots: [{ amount: 600, eligibleSeats: [1] }],
        payouts: { 1: 600 },
        revealed: {},
        forcedWinnerSeat: null,
      },
    });
    const s = settlement(h);
    const b = s.rows.find((r) => r.seat === 1);
    expect(b.net).toBe(300);
    expect(b.refundOnly).toBe(false);
  });

  it('没有 result 时返回空', () => {
    expect(settlement(hand()).rows).toEqual([]);
  });

  it('chipDelta 与结算净额一致', () => {
    const h = hand({
      settled: true,
      seats: [
        { seat: 0, userId: 'a', nickname: 'A', chips: 1100, betThisStreet: 0, totalCommitted: 50, folded: false, allIn: false, holeCards: [] },
        { seat: 1, userId: 'b', nickname: 'B', chips: 900, betThisStreet: 0, totalCommitted: 50, folded: false, allIn: false, holeCards: [] },
      ],
      result: { pots: [{ amount: 100, eligibleSeats: [0, 1] }], payouts: { 0: 100 }, revealed: {}, forcedWinnerSeat: null },
    });
    const delta = chipDelta(h);
    expect(delta.get(0)).toBe(50);
    expect(delta.get(1)).toBe(-50);
  });
});

describe('牌型评估', () => {
  it('10 种牌型识别正确', () => {
    expect(evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts']).category).toBe(9); // 皇家同花顺
    expect(evaluate5(['9h', '8h', '7h', '6h', '5h']).category).toBe(8);
    expect(evaluate5(['As', 'Ah', 'Ad', 'Ac', 'Kd']).category).toBe(7);
    expect(evaluate5(['As', 'Ah', 'Ad', 'Kc', 'Kd']).category).toBe(6);
    expect(evaluate5(['As', 'Ks', 'Qs', 'Js', '9s']).category).toBe(5);
    expect(evaluate5(['9h', '8s', '7d', '6c', '5h']).category).toBe(4);
    expect(evaluate5(['As', 'Ah', 'Ad', 'Kc', 'Qd']).category).toBe(3);
    expect(evaluate5(['As', 'Ah', 'Kc', 'Kd', 'Qd']).category).toBe(2);
    expect(evaluate5(['As', 'Ah', 'Kc', 'Qd', 'Jd']).category).toBe(1);
    expect(evaluate5(['As', 'Kh', 'Qd', 'Jc', '9s']).category).toBe(0);
  });

  it('轮子顺是 5 高', () => {
    const wheel = evaluate5(['Ah', '2s', '3d', '4c', '5h']);
    expect(wheel.category).toBe(4);
    expect(wheel.tiebreakers[0]).toBe(5);
    expect(compareHands(evaluate5(['2h', '3s', '4d', '5c', '6h']), wheel)).toBeGreaterThan(0);
  });

  it('7 张里取最佳 5 张', () => {
    expect(evaluate7(['As', 'Ah', 'Ad', 'Kc', 'Kd', '2s', '3h']).category).toBe(6);
    expect(evaluate7(['9h', '8h', '7h', '6h', '5h', 'Kc', '2s']).category).toBe(8);
    expect(evaluate7(['As', 'Ah', 'Kc', 'Kd', 'Qs', 'Qd', '2h']).tiebreakers).toEqual([14, 13, 12]);
  });

  it('不足 5 张返回 null，bestCategory 给中文名', () => {
    expect(evaluate7(['As', 'Kh'])).toBeNull();
    expect(bestCategory(['As', 'Ks'], ['Qs', 'Js', 'Ts'])).toEqual({ category: 9, name: '皇家同花顺' });
    expect(bestCategory(['2c', '7d'], [])).toBeNull();
  });

  it('strengthOf 越大牌越强', () => {
    // AAAA + K 踢脚（四条 A，带 K） vs 9999 + A 踢脚（四条 9，带 A）
    const quadA = strengthOf(['As', 'Ah'], ['Ad', 'Ac', 'Kd', '2s', '3h']);
    const quad9 = strengthOf(['9s', '9h'], ['9d', '9c', 'Ad', '2s', '3h']);
    expect(quadA).toBeGreaterThan(quad9);
    // 同样是四条 A，踢脚大的更强
    const quadAK = strengthOf(['As', 'Ah'], ['Ad', 'Ac', 'Kd', '2s', '3h']);
    const quadAQ = strengthOf(['As', 'Ah'], ['Ad', 'Ac', 'Qd', '2s', '3h']);
    expect(quadAK).toBeGreaterThan(quadAQ);
  });
});

describe('分层底池（离线引擎用）', () => {
  it('三人不同筹码：主池 + 边池', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(300);
    expect(pots[1].eligibleSeats).toEqual([1, 2]);
  });

  it('弃牌玩家的钱进池但不参与分层', () => {
    const pots = buildPots([
      { seat: 0, amount: 300, folded: true },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 100, folded: false },
    ]);
    expect(pots[0].eligibleSeats).toEqual([1, 2]);
    expect(pots[1].eligibleSeats).toEqual([]);
  });

  it('平分时余数给座位号小的', () => {
    const w = awardPots([{ amount: 100, eligibleSeats: [0, 1, 2] }], new Map([[0, 5], [1, 5], [2, 5]]));
    expect(w.get(0)).toBe(34);
    expect(w.get(1)).toBe(33);
    expect(w.get(2)).toBe(33);
  });

  it('每层独立比牌力', () => {
    const pots = buildPots([
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 200, folded: false },
    ]);
    const w = awardPots(pots, new Map([[0, 900], [1, 500], [2, 100]]));
    expect(w.get(0)).toBe(300); // 主池
    expect(w.get(1)).toBe(200); // 边池
  });
});

describe('展示格式化', () => {
  it('筹码简写', () => {
    expect(chips(999)).toBe('999');
    expect(chips(1000)).toBe('1k');
    expect(chips(1200)).toBe('1.2k');
    expect(chips(12500)).toBe('12.5k');
    expect(chips(1500000)).toBe('1.5m');
    expect(chips(-5)).toBe('0');
  });

  it('底池百分比', () => {
    expect(potPercent(50, 100)).toBe('50%');
    expect(potPercent(120, 100)).toBe('120%');
    expect(potPercent(5, 0)).toBe('0%');
  });

  it('牌面与红黑', () => {
    expect(cardText('As')).toBe('A♠');
    expect(cardText('Th')).toBe('T♥');
    expect(isRedCard('Th')).toBe(true);
    expect(isRedCard('Tc')).toBe(false);
    expect(cardText('bad')).toBe('?');
  });

  it('秒数', () => {
    expect(seconds(12000)).toBe('12s');
    expect(seconds(-10)).toBe('0s');
  });
});
