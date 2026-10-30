import { describe, it, expect } from 'vitest';
import { startHand, applyAction, advancePendingStreet, toSnapshot } from '../src/index.js';

/** 造 3 人桌（座位 0/1/2，按钮在 0） */
function table3(ante = 5) {
  return startHand({
    handId: 'h-ante',
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    ante,
    players: [
      { seat: 0, userId: 'u0', nickname: 'A', chips: 1000 },
      { seat: 1, userId: 'u1', nickname: 'B', chips: 1000 },
      { seat: 2, userId: 'u2', nickname: 'C', chips: 1000 },
    ],
  }).state;
}

describe('ante（前注）', () => {
  it('每个人先交 ante，再交盲注；计入 totalCommitted 与底池', () => {
    const s = table3(5);
    const bySeat = new Map(s.seats.map((x) => [x.seat, x]));
    // 3 人桌：按钮 0、SB 1、BB 2
    expect(bySeat.get(0).chips).toBe(995); // 1000 - ante 5（按钮只交 ante）
    expect(bySeat.get(1).chips).toBe(985); // 1000 - 5 - SB 10
    expect(bySeat.get(2).chips).toBe(975); // 1000 - 5 - BB 20
    expect(bySeat.get(0).totalCommitted).toBe(5);
    expect(bySeat.get(1).totalCommitted).toBe(15);
    expect(bySeat.get(2).totalCommitted).toBe(25);
    // ante 不算本街下注
    expect(bySeat.get(0).betThisStreet).toBe(0);
    expect(bySeat.get(1).betThisStreet).toBe(10);
    expect(bySeat.get(2).betThisStreet).toBe(20);

    const snap = toSnapshot(s);
    expect(snap.ante).toBe(5);
    expect(snap.seats.reduce((n, x) => n + x.totalCommitted, 0)).toBe(45);
    expect(s.currentTurnSeat).toBe(0); // 按钮先行动（3 人桌）
  });

  it('筹码不足 ante：直接 all-in，不会出现负筹码', () => {
    const s = startHand({
      handId: 'h-short',
      buttonSeat: 0,
      smallBlind: 10,
      bigBlind: 20,
      ante: 5,
      players: [
        { seat: 0, userId: 'u0', nickname: 'A', chips: 3 },
        { seat: 1, userId: 'u1', nickname: 'B', chips: 1000 },
        { seat: 2, userId: 'u2', nickname: 'C', chips: 1000 },
      ],
    }).state;
    const a = s.seats.find((x) => x.seat === 0);
    expect(a.chips).toBe(0);
    expect(a.startingChips).toBe(3);
    expect(a.totalCommitted).toBe(3);
    expect(a.allIn).toBe(true);
  });

  it('ante = 0 时与旧行为一致', () => {
    const s = table3(0);
    const bySeat = new Map(s.seats.map((x) => [x.seat, x]));
    expect(bySeat.get(0).chips).toBe(1000);
    expect(bySeat.get(1).chips).toBe(990);
    expect(bySeat.get(2).chips).toBe(980);
  });
});

describe('街道推进延迟（deferStreet）', () => {
  /** 单挑：按钮=SB（座位 0），BB 座位 1 */
  function headsUp() {
    return startHand({
      handId: 'h-defer',
      buttonSeat: 0,
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      players: [
        { seat: 0, userId: 'u0', nickname: 'A', chips: 1000 },
        { seat: 1, userId: 'u1', nickname: 'B', chips: 1000 },
      ],
    }).state;
  }

  it('deferStreet：本街结束只挂起，board 不变；advancePendingStreet 才发翻牌', () => {
    let s = headsUp();
    s = applyAction(s, 0, { type: 'call' }, { deferStreet: true }).state;
    expect(Boolean(s.pendingStreetAdvance)).toBe(false); // BB 还要行动
    s = applyAction(s, 1, { type: 'check' }, { deferStreet: true }).state;
    expect(s.street).toBe('PREFLOP');
    expect(s.board.length).toBe(0);
    expect(s.pendingStreetAdvance).toBe(true);
    expect(s.currentTurnSeat).toBe(null);

    const advanced = advancePendingStreet(s);
    s = advanced.state;
    expect(s.street).toBe('FLOP');
    expect(s.board.length).toBe(3);
    expect(s.pendingStreetAdvance).toBe(false);
    expect(s.currentTurnSeat).not.toBe(null);
  });

  it('不传 deferStreet（默认）仍然立刻发翻牌，保持旧行为', () => {
    let s = headsUp();
    s = applyAction(s, 0, { type: 'call' }).state;
    s = applyAction(s, 1, { type: 'check' }).state;
    expect(s.street).toBe('FLOP');
    expect(s.board.length).toBe(3);
  });

  it('挂起期间再有动作请求会被拒绝', () => {
    let s = headsUp();
    s = applyAction(s, 0, { type: 'call' }, { deferStreet: true }).state;
    s = applyAction(s, 1, { type: 'check' }, { deferStreet: true }).state;
    expect(() => applyAction(s, 0, { type: 'check' })).toThrow();
  });

  it('advancePendingStreet 对没有挂起的状态是幂等的', () => {
    const s = headsUp();
    const again = advancePendingStreet(s);
    expect(again.state).toBe(s);
    expect(again.events.length).toBe(0);
  });
});
