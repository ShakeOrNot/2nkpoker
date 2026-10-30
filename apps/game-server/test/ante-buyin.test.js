import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { closeTable, createTable, getTable } from '../src/state/tableManager.js';
import { cleanupAfterHand, maybeStartHand } from '../src/state/handOrchestrator.js';

/** 造一张 2 人桌（座位 0/1），ready 状态可控 */
function twoSeats(tableId, { ante = 5, chipsA = 1000, chipsB = 1000 } = {}) {
  const t = createTable(tableId, { maxSeats: 6, smallBlind: 10, bigBlind: 20, ante });
  t.seats.set(0, { seat: 0, userId: 'a', nickname: 'A', chips: chipsA, ready: true, connected: true, buyInTotal: chipsA });
  t.seats.set(1, { seat: 1, userId: 'b', nickname: 'B', chips: chipsB, ready: true, connected: true, buyInTotal: chipsB });
  t.userToSeat.set('a', 0);
  t.userToSeat.set('b', 1);
  return t;
}

describe('牌桌配置：ante', () => {
  it('createTable 能设置 ante，默认 5', () => {
    const a = createTable('cfg_ante', { ante: 5 });
    expect(a.ante).toBe(5);
    const b = createTable('cfg_default');
    expect(b.ante).toBe(5);
    const c = createTable('cfg_zero', { ante: 0 });
    expect(c.ante).toBe(0);
    closeTable('cfg_ante');
    closeTable('cfg_default');
    closeTable('cfg_zero');
  });

  it('开局时每人先交 ante（按钮位减 5，SB 减 15，BB 减 25）', () => {
    const t = twoSeats('ante_start', { ante: 5 });
    // 单挑：按钮=SB
    t.buttonSeat = 0;
    expect(maybeStartHand(t)).toBe(true);
    const hand = t.handState;
    expect(hand.ante).toBe(5);
    const a = hand.seats.find((s) => s.seat === 0);
    const b = hand.seats.find((s) => s.seat === 1);
    expect(a.chips).toBe(985); // 1000 - ante5 - SB10
    expect(b.chips).toBe(975); // 1000 - ante5 - BB20
    expect(hand.seats.reduce((n, s) => n + s.totalCommitted, 0)).toBe(40);
    closeTable('ante_start');
  });
});

describe('局内补码（买入）', () => {
  it('本手结算时补码：先加筹码，再判断是否输光离座', () => {
    const t = twoSeats('rebuy_apply', { ante: 5 });
    const seat = t.seats.get(0);
    seat.chips = 0;
    seat.pendingBuyIn = 2000;
    seat.buyInTotal = 2000;
    // 手牌结束（简化：结算后所有座位筹码为 0）
    t.handState = { settled: true, seats: [{ seat: 0, chips: 0 }, { seat: 1, chips: 0 }] };
    cleanupAfterHand(t);

    // 有补码就不算输光，不会被清座
    expect(t.seats.has(0)).toBe(true);
    expect(t.seats.get(0).chips).toBe(2000);
    expect(t.seats.get(0).buyInTotal).toBe(4000);
    expect(t.seats.get(0).pendingBuyIn).toBe(0);
    // 没补码的 1 号座位筹码 0 → 离座
    expect(t.seats.has(1)).toBe(false);
    closeTable('rebuy_apply');
  });

  it('没有补码时正常清掉输光的座位', () => {
    const t = twoSeats('rebuy_none', { ante: 5 });
    t.handState = { settled: true, seats: [{ seat: 0, chips: 0 }, { seat: 1, chips: 0 }] };
    cleanupAfterHand(t);
    expect(t.seats.size).toBe(0);
    closeTable('rebuy_none');
  });
});
