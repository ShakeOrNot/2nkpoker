import { toSnapshot as handSnapshot } from '@2nkpoker/poker-engine';

/**
 * 生成一张桌子的完整快照
 * @param {any} t  Table
 * @param {number|null} forSeat
 */
export function toTableSnapshot(t, forSeat = null) {
  const seats = [];
  for (let i = 0; i < t.maxSeats; i++) {
    const s = t.seats.get(i);
    if (!s) {
      seats.push({ seat: i, userId: null, nickname: '', chips: 0, ready: false, connected: false });
      continue;
    }
    seats.push({
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      chips: s.chips,
      ready: s.ready,
      connected: s.connected,
    });
  }

  return {
    tableId: t.tableId,
    version: t.version,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    buttonSeat: t.buttonSeat,
    maxSeats: t.maxSeats,
    seats,
    hand: t.handState ? handSnapshot(t.handState, forSeat) : null,
  };
}