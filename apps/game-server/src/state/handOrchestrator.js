import { startHand, applyAction, nextOccupiedSeat } from '@2nkpoker/poker-engine';
import { findFreeSeat } from './tableManager.js';

/**
 * 检查是否该开局。满足条件就 startHand 并返回 true
 * @param {any} t
 * @returns {boolean}
 */
export function maybeStartHand(t) {
  if (t.handState && !t.handState.settled) return false;
  if (t.seats.size < 2) return false;

  // 恢复：让所有座位上的人都参与（断线的人靠 0.1s 超时秒弃）
  const allReady = [...t.seats.values()].every((s) => s.ready);
  if (!allReady) return false;

  const players = [...t.seats.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      chips: s.chips,
    }));

  const handId = `h_${t.tableId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  // 座位号可能不连续（有人输光离座后留下的空位），按钮位也必须落在真实座位上。
  // 这里先规整一次，保证 t.buttonSeat 每手都往前推进，不会卡在空座位上。
  const occupied = players.map((p) => p.seat);
  const btnSeat = occupied.includes(t.buttonSeat)
    ? t.buttonSeat
    : nextOccupiedSeat(occupied, t.buttonSeat);

  const { state } = startHand({
    handId,
    buttonSeat: btnSeat,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    players,
  });

  t.handState = state;
  t.version += 1;

  for (const hs of state.seats) {
    const seat = t.seats.get(hs.seat);
    if (seat) seat.chips = hs.chips;
  }

  // 下一手按钮位：从本手按钮位顺时针找下一个有人坐的座位
  t.buttonSeat = nextOccupiedSeat(occupied, btnSeat) ?? btnSeat;
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
 * 主动离桌：
 * - 不在手牌中 → 直接删座，立刻生效
 * - 手牌进行中 → 标记 leaving + ready=false，等本手结束由 cleanupAfterHand 清掉座位；
 *   如果正好轮到他，当场弃牌，别把整桌卡住
 *
 * @param {any} t
 * @param {number} seat
 * @returns {{ pending: boolean, folded: boolean, settled: boolean, handId: string|null }}
 */
export function requestLeave(t, seat) {
  const s = t.seats.get(seat);
  if (!s) return { pending: false, folded: false, settled: false, handId: null };

  if (!t.handState || t.handState.settled) {
    t.seats.delete(seat);
    t.userToSeat.delete(s.userId);
    t.version += 1;
    return { pending: false, folded: false, settled: false, handId: null };
  }

  s.leaving = true;
  s.ready = false;
  t.version += 1;

  const hs = t.handState.seats.find((x) => x.seat === seat);
  let folded = false;
  if (t.handState.currentTurnSeat === seat && hs && !hs.folded && !hs.allIn) {
    folded = playAction(t, seat, { type: 'fold' }, t.handState.version).ok;
  }

  return {
    pending: true,
    folded,
    settled: Boolean(t.handState.settled),
    handId: t.handState.handId,
  };
}

/**
 * 结算后清理桌子：把 settle 结果同步回座位、清空 handState、把排队的人拉上座位
 * @param {any} t
 * @returns {Array<{ userId: string, seat: number }>} 本手结束后从排队补位上桌的人
 */
export function cleanupAfterHand(t) {
  if (!t.handState || !t.handState.settled) return [];

  // 1. 同步筹码
  for (const hs of t.handState.seats) {
    const s = t.seats.get(hs.seat);
    if (s) s.chips = hs.chips;
  }

  // 2. 输光筹码的人自动离座；本手结束后要离桌的人也一并清掉
  for (const [seat, s] of [...t.seats.entries()]) {
    if (s.chips <= 0 || s.leaving) {
      t.seats.delete(seat);
      t.userToSeat.delete(s.userId);
    }
  }

  // 3. 清空手牌状态
  t.handState = null;

  // 4. 处理排队队列：把还在等待的人拉上座位
  /** @type {Array<{ userId: string, seat: number }>} */
  const seated = [];
  if (Array.isArray(t.sitQueue) && t.sitQueue.length > 0) {
    for (const q of t.sitQueue) {
      if (t.userToSeat.has(q.userId)) continue; // 已经在座位上了
      const free = findFreeSeat(t, q.preferredSeat);
      if (free == null) continue; // 没位置了，这人这次补不上（下次重新排队）
      t.seats.set(free, {
        seat: free,
        userId: q.userId,
        nickname: q.nickname,
        chips: q.buyIn,
        ready: false,
        // 真实连接状态由调用方按 socket 是否存在修正（见 actionTimer.broadcastResult）
        connected: true,
      });
      t.userToSeat.set(q.userId, free);
      seated.push({ userId: q.userId, seat: free });
    }
    t.sitQueue = []; // 队列清空
  }

  t.version += 1;
  return seated;
}