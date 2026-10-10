import { describe, it, expect } from 'vitest';
import { legalActions, validateAction, ActionError } from '../src/index.js';

function state(over) {
  const seats = [
    { seat: 0, chips: 1000, betThisStreet: 0, folded: false, allIn: false, sittingOut: false },
    { seat: 1, chips: 1000, betThisStreet: 0, folded: false, allIn: false, sittingOut: false },
    { seat: 2, chips: 1000, betThisStreet: 0, folded: false, allIn: false, sittingOut: false },
  ];
  return {
    bigBlind: 20,
    minRaise: 20,
    currentBet: 0,
    currentTurnSeat: 0,
    seats,
    ...over,
  };
}

describe('legalActions', () => {
  it('无人下注时：fold / check / bet / all_in', () => {
    const s = state();
    expect(legalActions(s, 0).sort()).toEqual(['all_in','bet','check','fold'].sort());
  });

  it('面对下注时：fold / call / raise / all_in', () => {
    const s = state({ currentBet: 50 });
    expect(legalActions(s, 0).sort()).toEqual(['all_in','call','fold','raise'].sort());
  });

  it('不是你的回合，返回空', () => {
    const s = state({ currentTurnSeat: 1 });
    expect(legalActions(s, 0)).toEqual([]);
  });

  it('已弃牌返回空', () => {
    const s = state();
    s.seats[0].folded = true;
    expect(legalActions(s, 0)).toEqual([]);
  });

  it('已全下返回空', () => {
    const s = state();
    s.seats[0].allIn = true;
    expect(legalActions(s, 0)).toEqual([]);
  });
});

describe('validateAction - 合法路径', () => {
  it('fold 总是合法', () => {
    const s = state({ currentBet: 100 });
    expect(validateAction(s, 0, { type: 'fold' })).toEqual({ pay: 0, isRaise: false, isAllIn: false });
  });

  it('check 不欠注时合法', () => {
    const s = state();
    expect(validateAction(s, 0, { type: 'check' }).pay).toBe(0);
  });

  it('call 支付差额', () => {
    const s = state({ currentBet: 50 });
    s.seats[0].betThisStreet = 20;
    const r = validateAction(s, 0, { type: 'call' });
    expect(r.pay).toBe(30);
    expect(r.isAllIn).toBe(false);
  });

  it('call 筹码不足时自动变 all-in', () => {
    const s = state({ currentBet: 500 });
    s.seats[0].chips = 100;
    const r = validateAction(s, 0, { type: 'call' });
    expect(r.pay).toBe(100);
    expect(r.isAllIn).toBe(true);
  });

  it('bet 至少 bigBlind', () => {
    const s = state();
    const r = validateAction(s, 0, { type: 'bet', amount: 20 });
    expect(r.pay).toBe(20);
    expect(r.isRaise).toBe(true);
  });

  it('raise 到 currentBet + minRaise', () => {
    const s = state({ currentBet: 50, minRaise: 20 });
    const r = validateAction(s, 0, { type: 'raise', amount: 70 });
    expect(r.pay).toBe(70);
    expect(r.isRaise).toBe(true);
  });

  it('all_in 用全部剩余筹码', () => {
    const s = state();
    s.seats[0].chips = 500;
    const r = validateAction(s, 0, { type: 'all_in' });
    expect(r.pay).toBe(500);
    expect(r.isAllIn).toBe(true);
  });
});

describe('validateAction - 非法路径', () => {
  it('不是你的回合 -> NOT_YOUR_TURN', () => {
    const s = state({ currentTurnSeat: 1 });
    expect(() => validateAction(s, 0, { type: 'fold' })).toThrow(ActionError.NOT_YOUR_TURN);
  });

  it('已弃牌 -> INVALID_ACTION', () => {
    const s = state();
    s.seats[0].folded = true;
    expect(() => validateAction(s, 0, { type: 'fold' })).toThrow(ActionError.INVALID_ACTION);
  });

  it('欠注时 check 不合法', () => {
    const s = state({ currentBet: 50 });
    expect(() => validateAction(s, 0, { type: 'check' })).toThrow(ActionError.INVALID_ACTION);
  });

  it('不欠注时 call 不合法', () => {
    const s = state();
    expect(() => validateAction(s, 0, { type: 'call' })).toThrow(ActionError.INVALID_ACTION);
  });

  it('有人已下注时不能 bet', () => {
    const s = state({ currentBet: 20 });
    expect(() => validateAction(s, 0, { type: 'bet', amount: 50 })).toThrow(ActionError.INVALID_ACTION);
  });

  it('bet 小于 bigBlind 不合法', () => {
    const s = state();
    expect(() => validateAction(s, 0, { type: 'bet', amount: 10 })).toThrow(ActionError.INVALID_ACTION);
  });

  it('bet 超过筹码 -> INSUFFICIENT_CHIPS', () => {
    const s = state();
    s.seats[0].chips = 30;
    expect(() => validateAction(s, 0, { type: 'bet', amount: 50 })).toThrow(ActionError.INSUFFICIENT_CHIPS);
  });

  it('raise 幅度不足', () => {
    const s = state({ currentBet: 50, minRaise: 20 });
    expect(() => validateAction(s, 0, { type: 'raise', amount: 60 })).toThrow(ActionError.INVALID_ACTION);
  });

  it('无人下注时不能 raise', () => {
    const s = state();
    expect(() => validateAction(s, 0, { type: 'raise', amount: 100 })).toThrow(ActionError.INVALID_ACTION);
  });

  it('未知动作类型', () => {
    const s = state();
    expect(() => validateAction(s, 0, { type: 'teleport' })).toThrow(ActionError.INVALID_ACTION);
  });

  it('不存在的座位 -> SEAT_INVALID', () => {
    const s = state();
    expect(() => validateAction(s, 99, { type: 'fold' })).toThrow(ActionError.SEAT_INVALID);
  });
});