import { TableSitSchema, TableLeaveSchema, parseOrError } from '../validate.js';
import {
  getOrCreateTable,
  getTable,
  findFreeSeat,
  removeTableIfEmpty,
  findUserTable,
} from '../../state/tableManager.js';
import { toTableSnapshot } from '../../state/tableSnapshot.js';

const MIN_BUY_IN = 100;
const MAX_BUY_IN = 100000;

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableSit(nsp, socket) {
  socket.on('table:sit', (payload, ack) => {
    const parsed = parseOrError(TableSitSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, seat: preferredSeat, buyIn } = parsed.data;
    if (buyIn < MIN_BUY_IN || buyIn > MAX_BUY_IN) {
      return replyAck(ack, { ok: false, code: 'INVALID_BUY_IN', message: `buyIn must be ${MIN_BUY_IN}~${MAX_BUY_IN}` });
    }

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

      if (t.userToSeat.has(userId)) {
        return replyAck(ack, { ok: false, code: 'ALREADY_SEATED', message: 'already seated' });
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
          });
          t.version += 1;
          broadcastTable(nsp, t);
        }
        return replyAck(ack, {
          ok: false,
          code: 'HAND_IN_PROGRESS',
          queued: true,
          message: '牌局进行中，已加入排队，本手结束后自动入座',
        });
      }

      t.seats.set(free, {
        seat: free,
        userId,
        nickname: nickname ?? `user_${userId.slice(0, 6)}`,
        chips: buyIn,
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

  socket.on('table:stand', (payload, ack) => {
    const parsed = parseOrError(TableLeaveSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code });
    const { tableId } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const userId = socket.data.userId;
        t.actor.run(() => {
      const seat = t.userToSeat.get(userId);

      // 不在座位上，但在排队里 → 取消排队
      if (seat == null && t.sitQueue) {
        const idx = t.sitQueue.findIndex((q) => q.userId === userId);
        if (idx !== -1) {
          t.sitQueue.splice(idx, 1);
          t.version += 1;
          broadcastTable(nsp, t);
          return replyAck(ack, { ok: true, message: '已取消排队' });
        }
      }

      if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });
      if (t.handState && !t.handState.settled) {
        return replyAck(ack, { ok: false, code: 'HAND_IN_PROGRESS' });
      }

      t.seats.delete(seat);
      t.userToSeat.delete(userId);
      t.version += 1;

      socket.leave(`table:${tableId}`);
      socket.data.tableId = undefined;
      socket.data.seat = undefined;

      broadcastTable(nsp, t);
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