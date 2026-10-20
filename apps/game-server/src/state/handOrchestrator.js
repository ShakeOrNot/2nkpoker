import { startHand, applyAction, toSnapshot as handSnapshot } from '@2nkpoker/poker-engine';
import { toTableSnapshot } from './tableSnapshot.js';
import { findFreeSeat } from './tableManager.js';

/**
 * 检查是否该开局。满足条件就 startHand 并返回 true
 * @param {any} t
 * @returns {boolean}
 */
export function maybeStartHand(t) {
  if (t.handState && !t.handState.settled) return false;
  
  // 新增：过滤掉断线玩家
  const activeSeats = [...t.seats.values()].filter((s) => s.connected);
  
  if (activeSeats.length < 2) return false;

  const allReady = activeSeats.every((s) => s.ready);
  if (!allReady) return false;

  // 收集参局者（改成用 activeSeats）
  const players = activeSeats
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
  // 注意：不清 ready —— 玩家只要准备过一次，就一直连续参与牌局
  for (const hs of state.seats) {
    const seat = t.seats.get(hs.seat);
    if (seat) {
      seat.chips = hs.chips;
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