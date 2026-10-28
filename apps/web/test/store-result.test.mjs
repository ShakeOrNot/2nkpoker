import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

/** 造一份"已结算"的手牌快照 */
function settledHand(handId = 'h1') {
  return {
    handId,
    street: 'SETTLED',
    board: ['As', 'Kd', '2c', '7h', '9s'],
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    seats: [
      { seat: 0, userId: 'me', nickname: '我', chips: 1030, betThisStreet: 0, totalCommitted: 10, folded: false, allIn: false, sittingOut: false, holeCards: [] },
      { seat: 1, userId: 'bot', nickname: '豆豆', chips: 990, betThisStreet: 0, totalCommitted: 10, folded: true, allIn: false, sittingOut: false, holeCards: [] },
    ],
    currentTurnSeat: null,
    currentBet: 0,
    minRaise: 20,
    pot: 20,
    version: 9,
    settled: true,
    result: {
      pots: [{ amount: 20, eligibleSeats: [0], contributorSeats: [0, 1] }],
      payouts: { 0: 20 },
      revealed: {},
      forcedWinnerSeat: 0,
    },
  };
}

const TABLE_SEATS = [
  { seat: 0, userId: 'me', nickname: '我', chips: 1030, ready: true, connected: true },
  { seat: 1, userId: 'bot', nickname: '豆豆', chips: 990, ready: true, connected: true },
];

/** @param {{ hand: any }} opts */
function snapshotWith({ hand }) {
  return { tableId: 't1', version: 3, smallBlind: 10, bigBlind: 20, buttonSeat: 0, maxSeats: 6, seats: TABLE_SEATS, hand };
}

function makeStore() {
  const store = new Store();
  store.state.session = { token: 't', userId: 'me', nickname: '我', expiresAt: 0 };
  store.state.phase = 'table';
  store.state.connection = 'online';
  return store;
}

describe('结算数据：服务端清空手牌后浮层仍能画', () => {
  it('先收到已结算快照：lastResult 连座位一起存下来', () => {
    const store = makeStore();
    store.applySnapshot(snapshotWith({ hand: settledHand('h1') }));

    const last = store.state.room.lastResult;
    expect(last?.handId).toBe('h1');
    expect(last?.seats?.length).toBe(2);
    expect(last.seats.find((s) => s.userId === 'me')?.totalCommitted).toBe(10);
  });

  it('随后 hand=null 的清理快照不会把结算数据冲掉', () => {
    const store = makeStore();
    store.applySnapshot(snapshotWith({ hand: settledHand('h1') }));
    store.applySnapshot(snapshotWith({ hand: null }));

    expect(store.state.room.snapshot?.hand).toBeNull();
    expect(store.state.room.lastResult?.seats?.length).toBe(2);
  });

  it('applyResult 自带 seats 时能独立画出结算框（不依赖快照）', () => {
    const store = makeStore();
    const hand = settledHand('h2');
    store.applyResult({
      handId: 'h2',
      result: hand.result,
      board: hand.board,
      seats: hand.seats,
    });

    const last = store.state.room.lastResult;
    expect(last?.handId).toBe('h2');
    expect(last?.seats?.length).toBe(2);
    expect(last?.result?.payouts?.[0]).toBe(20);
  });

  it('applyResult 不带 seats 时，沿用上一份快照里的座位', () => {
    const store = makeStore();
    store.applySnapshot(snapshotWith({ hand: settledHand('h3') }));
    store.applyResult({ handId: 'h3', result: settledHand('h3').result, board: [] });

    expect(store.state.room.lastResult?.seats?.length).toBe(2);
  });

  it('没有座位数据时不会崩，只是没有可以画的行', () => {
    const store = makeStore();
    expect(() => store.applyResult({ handId: 'h4', result: { pots: [], payouts: {} }, board: [] })).not.toThrow();
    expect(store.state.room.lastResult?.handId).toBe('h4');
  });
});
