import { startHand, applyAction, toSnapshot as handSnapshot } from '@2nkpoker/poker-engine';
import { toTableSnapshot } from './tableSnapshot.js';

/**
 * 检查是否该开局。满足条件就 startHand 并返回 true
 * @param {any} t
 * @returns {boolean}
 */
export function maybeStartHand(t) {
  if (t.handState && !t.handState.settled) return false;
  if (t.seats.size < 2) return false;

  const allReady = [...t.seats.values()].every((s) => s.ready);
  if (!allReady) return false;

  // 收集参局者
  const players = [...t.seats.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      chips: s.chips,
    }));

  const handId = `h_${t.tableId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const { state } = startHand({
    handId,
    buttonSeat: t.buttonSeat,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    players,
  });

  t.handState = state;
  t.version += 1;

  // 把手牌同步回座位 chips（起手筹码已扣盲）
  for (const hs of state.seats) {
    const seat = t.seats.get(hs.seat);
    if (seat) {
      seat.chips = hs.chips;
      seat.ready = false; // 开局后清 ready
    }
  }

  // 移动按钮位到下一个有人坐的座位
  t.buttonSeat = nextButton(t, t.buttonSeat);

  return true;
}

/**
 * 玩家动作
 * @param {any} t
 * @param {number} seat
 * @param {{type:string,amount?:number}} action
 * @param {number} expectedVersion
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function playAction(t, seat, action, expectedVersion) {
  if (!t.handState || t.handState.settled) {
    return { ok: false, code: 'HAND_NOT_ACTIVE' };
  }
  if (t.handState.version !== expectedVersion) {
    return { ok: false, code: 'STATE_OUTDATED', message: `expected ${t.handState.version}` };
  }

  let result;
  try {
    result = applyAction(t.handState, seat, action);
  } catch (e) {
    return { ok: false, code: e.message || 'INVALID_ACTION' };
  }
  t.handState = result.state;
  t.version += 1;

  // 同步筹码回座位
  for (const hs of t.handState.seats) {
    const seatState = t.seats.get(hs.seat);
    if (seatState) seatState.chips = hs.chips;
  }

  return { ok: true };
}

/**
 * 结算后清理桌子：把 settle 结果同步回座位、清空 handState
 * @param {any} t
 */
export function cleanupAfterHand(t) {
  if (!t.handState || !t.handState.settled) return;

  // chips 已经在 applyAction / settle 里更新过了，确保一致
  for (const hs of t.handState.seats) {
    const s = t.seats.get(hs.seat);
    if (s) s.chips = hs.chips;
  }

  // 输光筹码的人自动离座
  for (const [seat, s] of [...t.seats.entries()]) {
    if (s.chips <= 0) {
      t.seats.delete(seat);
      t.userToSeat.delete(s.userId);
    }
  }

  t.handState = null;
  t.version += 1;
}

/**
 * 从 buttonSeat 的下一个座位找起，找下一个有人坐的座位
 * @param {any} t
 * @param {number} current
 * @returns {number}
 */
function nextButton(t, current) {
  if (t.seats.size === 0) return 0;
  for (let i = 1; i <= t.maxSeats; i++) {
    const idx = (current + i) % t.maxSeats;
    if (t.seats.has(idx)) return idx;
  }
  return current;
}