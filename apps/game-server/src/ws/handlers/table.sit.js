import { TableSitSchema, TableLeaveSchema, TableRebuySchema, parseOrError } from '../validate.js';
import {
  getOrCreateTable,
  getTable,
  findFreeSeat,
  removeTableIfEmpty,
  findUserTable,
} from '../../state/tableManager.js';
import { toTableSnapshot } from '../../state/tableSnapshot.js';
import { requestLeave } from '../../state/handOrchestrator.js';

/** 1 个买入 = 100 个 BB；最多 50 个买入 */
const BUY_IN_BB = 100;
const MAX_BUY_IN_UNITS = 50;

/**
 * 这张桌子的一个买入单位值多少筹码
 * @param {any} t
 */
function buyInUnit(t) {
  return Math.max(1, Number(t.bigBlind) || 20) * BUY_IN_BB;
}

/**
 * 买入必须正好是 1~50 个买入单位
 * @param {any} t
 * @param {number} buyIn
 */
function isValidBuyIn(t, buyIn) {
  const unit = buyInUnit(t);
  return (
    Number.isInteger(buyIn) &&
    buyIn >= unit &&
    buyIn <= unit * MAX_BUY_IN_UNITS &&
    buyIn % unit === 0
  );
}

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableSit(nsp, socket) {
  socket.on('table:sit', (payload, ack) => {
    const parsed = parseOrError(TableSitSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, seat: preferredSeat, buyIn } = parsed.data;

    const t = getOrCreateTable(tableId);
    const userId = socket.data.userId;
    const nickname = socket.data.nickname;

    t.actor.run(() => {
      // 跨桌检测
      const existingTable = findUserTable(userId);
      if (existingTable && existingTable.tableId !== tableId) {
        return replyAck(ack, { 
          ok: false, 
          code: 'ALREADY_IN_OTHER_TABLE', 
          message: '你已经在另一张桌子上了，请先退出那张桌子' 
        });
      }

      const currentSeat = t.userToSeat.get(userId);

      // 已经在座：允许直接换座（不用先离座），但手牌进行中不行
      if (currentSeat != null) {
        if (t.handState && !t.handState.settled) {
          return replyAck(ack, { ok: false, code: 'HAND_IN_PROGRESS', message: '牌局进行中，本手结束后才能换座' });
        }
        const target = preferredSeat >= 0 ? preferredSeat : currentSeat;
        if (target === currentSeat) {
          return replyAck(ack, { ok: true, seat: currentSeat, unchanged: true });
        }
        if (target < 0 || target >= t.maxSeats) {
          return replyAck(ack, { ok: false, code: 'SEAT_INVALID', message: '座位号非法' });
        }
        if (t.seats.has(target)) {
          return replyAck(ack, { ok: false, code: 'SEAT_TAKEN', message: '该座位已被占用' });
        }

        const seatState = t.seats.get(currentSeat);
        t.seats.delete(currentSeat);
        seatState.seat = target;
        seatState.ready = false; // 换座后要重新准备
        delete seatState.leaving;
        t.seats.set(target, seatState);
        t.userToSeat.set(userId, target);
        t.version += 1;

        socket.data.tableId = tableId;
        socket.data.seat = target;
        broadcastTable(nsp, t);
        return replyAck(ack, { ok: true, seat: target, moved: true });
      }

      // 新入座才校验买入（换座沿用原筹码，不重新买入）
      if (!isValidBuyIn(t, buyIn)) {
        return replyAck(ack, {
          ok: false,
          code: 'INVALID_BUY_IN',
          message: `1 个买入 = ${buyInUnit(t)} 筹码（100BB），最少 1 个、最多 ${MAX_BUY_IN_UNITS} 个`,
        });
      }

      const free = findFreeSeat(t, preferredSeat);
      if (free == null) {
        return replyAck(ack, { ok: false, code: 'TABLE_FULL', message: 'no free seat' });
      }
      if (t.handState && !t.handState.settled) {
        // 如果已经在队列里，不重复添加
        const existing = (t.sitQueue ?? []).find((q) => q.userId === userId);
        if (!existing) {
          t.sitQueue = t.sitQueue ?? [];
          t.sitQueue.push({
            userId,
            nickname: nickname ?? `user_${userId.slice(0, 6)}`,
            buyIn,
            preferredSeat: preferredSeat ?? -1,
            requestedAt: Date.now(),
          });
          t.version += 1;
        }
        // 排队者也要进房间、记下 tableId：
        //   1. 这手牌期间能实时观战（看到进度，不至于干等）
        //   2. 本手结束被拉上座位时能立刻收到带自己手牌的快照
        //   3. 断线时 disconnectManager 能据此把他从队列里摘掉
        // 注意：这里**不设** socket.data.seat —— 还没坐下，快照里不该有手牌。
        socket.join(`table:${tableId}`);
        socket.data.tableId = tableId;
        socket.data.seat = undefined;
        broadcastTable(nsp, t);
        return replyAck(ack, {
          ok: false,
          code: 'HAND_IN_PROGRESS',
          queued: true,
          seat: null,
          message: '牌局进行中，已加入排队，本手结束后自动入座',
        });
      }

      t.seats.set(free, {
        seat: free,
        userId,
        nickname: nickname ?? `user_${userId.slice(0, 6)}`,
        chips: buyIn,
        buyInTotal: buyIn,
        ready: false,
        connected: true,
      });
      t.userToSeat.set(userId, free);
      t.version += 1;

      socket.join(`table:${tableId}`);
      socket.data.tableId = tableId;
      socket.data.seat = free;

      broadcastTable(nsp, t);
      replyAck(ack, { ok: true, seat: free });
    });
  });

  /* ---------------- 补码（买入）：手牌中提交 → 本手结算时生效 ---------------- */
  socket.on('table:rebuy', (payload, ack) => {
    const parsed = parseOrError(TableRebuySchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, units } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const userId = socket.data.userId;
    t.actor.run(() => {
      const seat = t.userToSeat.get(userId);
      if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });
      const s = t.seats.get(seat);
      if (!s) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });

      const unit = buyInUnit(t);
      const amount = units * unit;
      const already = (s.buyInTotal ?? s.chips) + (s.pendingBuyIn ?? 0);
      if (already + amount > unit * MAX_BUY_IN_UNITS) {
        return replyAck(ack, {
          ok: false,
          code: 'BUY_IN_LIMIT',
          message: `最多 ${MAX_BUY_IN_UNITS} 个买入（已用 ${Math.floor(already / unit)} 个）`,
        });
      }

      const inHand = Boolean(t.handState && !t.handState.settled);
      if (inHand) {
        // 手牌进行中：不能立刻补码，先记下，结算时（cleanupAfterHand）生效
        s.pendingBuyIn = (s.pendingBuyIn ?? 0) + amount;
        t.version += 1;
        broadcastTable(nsp, t);
        return replyAck(ack, {
          ok: true,
          pending: true,
          amount,
          applyAt: 'hand_end',
          chips: s.chips,
        });
      }

      s.chips += amount;
      s.buyInTotal = (s.buyInTotal ?? 0) + amount;
      s.pendingBuyIn = 0;
      t.version += 1;
      broadcastTable(nsp, t);
      return replyAck(ack, { ok: true, pending: false, amount, chips: s.chips });
    });
  });

  socket.on('table:stand', (payload, ack) => {
    const parsed = parseOrError(TableLeaveSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code });
    const { tableId } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const userId = socket.data.userId;
    t.actor.run(async () => {
      const seat = t.userToSeat.get(userId);

      // 不在座位上，但在排队里 → 取消排队（顺手退出房间，别继续收快照）
      if (seat == null && t.sitQueue) {
        const idx = t.sitQueue.findIndex((q) => q.userId === userId);
        if (idx !== -1) {
          t.sitQueue.splice(idx, 1);
          t.version += 1;
          socket.emit('table:snapshot', toTableSnapshot(t, null));
          socket.leave(`table:${tableId}`);
          socket.data.tableId = undefined;
          socket.data.seat = undefined;
          broadcastTable(nsp, t);
          return replyAck(ack, { ok: true, message: '已取消排队' });
        }
      }

      if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });

      // 离桌 = 离座（+ 由客户端 table:leave 退订房间）。
      // 手牌进行中不立刻删座：先标记 leaving，本手结束由 cleanupAfterHand 清掉。
      const result = requestLeave(t, seat);

      // 只离座，**不退出房间**：留在房间里当旁观者，随时可以重新入座。
      // （真正退订房间是 table:leave；这样"等候室离座"不会把人赶出房间）
      socket.data.seat = undefined;
      socket.emit('table:snapshot', toTableSnapshot(t, null));
      broadcastTable(nsp, t);

      if (result.pending) {
        if (result.folded) {
          // 正好轮到他：当场弃牌推进牌局，别让别人等到 30s 超时
          nsp.to(`table:${tableId}`).emit('game:action_applied', {
            seat,
            action: { type: 'fold' },
            handId: result.handId,
            leave: true,
          });
          if (result.settled) {
            const { broadcastResult } = await import('../../state/actionTimer.js');
            broadcastResult(nsp, t, result.handId);
          } else {
            const { broadcastActionRequest } = await import('../../state/actionTimer.js');
            broadcastActionRequest(nsp, t);
          }
        }
        return replyAck(ack, { ok: true, pending: true, message: '本手结束后离桌' });
      }

      removeTableIfEmpty(tableId);
      replyAck(ack, { ok: true });
    });
  });
}

/**
 * 给桌子里的每个 socket 发各自的快照
 * 由于每个座位看到的快照不一样（自己能看到手牌），要按座位分别 emit
 * @param {import('socket.io').Namespace} nsp
 * @param {any} t
 */
export function broadcastTable(nsp, t) {
  const room = `table:${t.tableId}`;
  const sockets = nsp.adapter.rooms.get(room);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = nsp.sockets.get(sid);
    if (!s) continue;
    const forSeat = s.data.seat ?? null;
    s.emit('table:snapshot', toTableSnapshot(t, forSeat));
  }
}

function replyAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}