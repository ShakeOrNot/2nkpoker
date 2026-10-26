import { describe, it, expect } from 'vitest';
import { getOrCreateTable } from '../src/state/tableManager.js';
import { maybeStartHand, playAction, cleanupAfterHand } from '../src/state/handOrchestrator.js';

function seedTable(t, seats) {
  for (const s of seats) {
    t.seats.set(s.seat, {
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      chips: s.chips,
      ready: s.ready,
      connected: true,
    });
    t.userToSeat.set(s.userId, s.seat);
  }
}

describe('maybeStartHand', () => {
  it('两人坐下都 ready，开局', () => {
    const t = getOrCreateTable('h1');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 1, userId: 'b', nickname: 'B', chips: 1000, ready: true },
    ]);
    expect(maybeStartHand(t)).toBe(true);
    expect(t.handState).not.toBeNull();
    expect(t.handState.street).toBe('PREFLOP');
  });

  it('有一人未 ready，不开局', () => {
    const t = getOrCreateTable('h2');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 1, userId: 'b', nickname: 'B', chips: 1000, ready: false },
    ]);
    expect(maybeStartHand(t)).toBe(false);
    expect(t.handState).toBeNull();
  });

  it('只有 1 人，不开局', () => {
    const t = getOrCreateTable('h3');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
    ]);
    expect(maybeStartHand(t)).toBe(false);
  });

  it('座位号有空位（有人输光离座后）也能开局', () => {
    const t = getOrCreateTable('h4');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 2, userId: 'b', nickname: 'B', chips: 1000, ready: true },
      { seat: 4, userId: 'c', nickname: 'C', chips: 1000, ready: true },
    ]);
    expect(maybeStartHand(t)).toBe(true);
    expect(t.handState.seats.map((s) => s.seat)).toEqual([0, 2, 4]);
    expect(t.handState.buttonSeat).toBe(0);
    // SB=2, BB=4，并且每人都发了牌
    expect(t.handState.seats.find((s) => s.seat === 2).betThisStreet).toBe(10);
    expect(t.handState.seats.find((s) => s.seat === 4).betThisStreet).toBe(20);
    for (const s of t.handState.seats) expect(s.holeCards).toHaveLength(2);
    // 下一手按钮位前进到下一个有人坐的座位
    expect(t.buttonSeat).toBe(2);
  });

  it('按钮位停在空座位上时自动顺延，不会卡死', () => {
    const t = getOrCreateTable('h5');
    t.buttonSeat = 3; // 3 号座位没人
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 2, userId: 'b', nickname: 'B', chips: 1000, ready: true },
    ]);
    expect(maybeStartHand(t)).toBe(true);
    // 3 之后绕回 0
    expect(t.handState.buttonSeat).toBe(0);
    expect(t.buttonSeat).toBe(2);
  });
});

describe('playAction', () => {
  function startHeadsUp() {
    const t = getOrCreateTable('p1');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 1, userId: 'b', nickname: 'B', chips: 1000, ready: true },
    ]);
    maybeStartHand(t);
    return t;
  }

  it('合法 call', () => {
    const t = startHeadsUp();
    const v = t.handState.version;
    const turn = t.handState.currentTurnSeat;
    const r = playAction(t, turn, { type: 'call' }, v);
    expect(r.ok).toBe(true);
    expect(t.handState.version).toBeGreaterThan(v);
  });

  it('版本过期', () => {
    const t = startHeadsUp();
    const r = playAction(t, 0, { type: 'call' }, 9999);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('STATE_OUTDATED');
  });

  it('不是你的回合', () => {
    const t = startHeadsUp();
    const turn = t.handState.currentTurnSeat;
    const other = turn === 0 ? 1 : 0;
    const r = playAction(t, other, { type: 'call' }, t.handState.version);
    expect(r.ok).toBe(false);
  });
});

describe('cleanupAfterHand', () => {
  it('结算后 handState 变 null', () => {
    const t = getOrCreateTable('c1');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 1, userId: 'b', nickname: 'B', chips: 1000, ready: true },
    ]);
    maybeStartHand(t);
    // 让所有人在翻前弃牌，快速结算
    t.handState.settled = true; // 强制打标记
    cleanupAfterHand(t);
    expect(t.handState).toBeNull();
  });

  it('有人输光离座后，下一手仍能开局（回归：座位不连续导致 startHand 崩溃）', () => {
    const t = getOrCreateTable('c2');
    seedTable(t, [
      { seat: 0, userId: 'a', nickname: 'A', chips: 1000, ready: true },
      { seat: 1, userId: 'b', nickname: 'B', chips: 1000, ready: true },
      { seat: 2, userId: 'c', nickname: 'C', chips: 1000, ready: true },
    ]);
    expect(maybeStartHand(t)).toBe(true);

    // 模拟座位 1 输光并结算
    t.handState.settled = true;
    t.handState.seats.find((s) => s.seat === 1).chips = 0;
    cleanupAfterHand(t);

    expect(t.seats.has(1)).toBe(false); // 输光的人已经离座
    expect(t.seats.size).toBe(2);

    // 剩下座位 0 和 2 —— 座位号不连续，但下一手必须能正常开
    expect(maybeStartHand(t)).toBe(true);
    expect(t.handState.seats.map((s) => s.seat)).toEqual([0, 2]);
    for (const s of t.handState.seats) expect(s.holeCards).toHaveLength(2);
  });
});