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
 * 结算后清理桌子：把 settle 结果同步回座位、清空 handState
 * @param {any} t
 */
export function cleanupAfterHand(t) {
  if (!t.handState || !t.handState.settled) return;

  // 1. 同步筹码
  for (const hs of t.handState.seats) {
    const s = t.seats.get(hs.seat);
    if (s) s.chips = hs.chips;
  }

  // 2. 输光筹码的人自动离座
  for (const [seat, s] of [...t.seats.entries()]) {
    if (s.chips <= 0) {
      t.seats.delete(seat);
      t.userToSeat.delete(s.userId);
    }
  }

  // 3. 清空手牌状态
  t.handState = null;

  // 4. 处理排队队列：把还在等待的人拉上座位
  if (Array.isArray(t.sitQueue) && t.sitQueue.length > 0) {
    for (const q of t.sitQueue) {
      if (t.userToSeat.has(q.userId)) continue; // 已经在座位上了
      const free = findFreeSeat(t, q.preferredSeat);
      if (free != null) {
        t.seats.set(free, {
          seat: free,
          userId: q.userId,
          nickname: q.nickname,
          chips: q.buyIn,
          ready: false,
          connected: true, // 注意：如果重连逻辑还没处理，先设为 true 兜底
        });
        t.userToSeat.set(q.userId, free);
      }
    }
    t.sitQueue = []; // 队列清空
  }

  t.version += 1;
}