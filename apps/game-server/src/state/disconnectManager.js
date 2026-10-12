import { getTable, removeTableIfEmpty } from './tableManager.js';
import { broadcastTable } from '../ws/handlers/table.sit.js';
import { clearActionTimer } from './actionTimer.js';

const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS ?? 30000);

/** @type {Map<string, NodeJS.Timeout>} */
const pending = new Map();

const key = (userId) => `d:${userId}`;

/**
 * socket 断开时调用
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function handleDisconnect(nsp, socket) {
  const userId = socket.data.userId;
  const tableId = socket.data.tableId;
  const seat = socket.data.seat;
  if (!userId || !tableId || seat == null) return;

  const t = getTable(tableId);
  if (!t) return;

  t.actor.run(() => {
    const s = t.seats.get(seat);
    if (!s) return;
    s.connected = false;
    t.version += 1;
    broadcastTable(nsp, t);
  });

  const k = key(userId);
  const old = pending.get(k);
  if (old) clearTimeout(old);

  const timer = setTimeout(() => {
    pending.delete(k);
    const t2 = getTable(tableId);
    if (!t2) return;
    t2.actor.run(() => {
      const s = t2.seats.get(seat);
      if (!s || s.connected) return;
      // 仍在局中 → 先把他的座位标记清掉（下一手不再发牌给他）
      t2.seats.delete(seat);
      t2.userToSeat.delete(userId);
      t2.version += 1;
      clearActionTimer(t2.tableId);
      broadcastTable(nsp, t2);
      removeTableIfEmpty(tableId);
    });
  }, RECONNECT_GRACE_MS);

  pending.set(k, timer);
}

/**
 * 用户重新连接时调用（在 JWT 校验成功后）
 * @param {string} userId
 */
export function cancelPendingDisconnect(userId) {
  const k = key(userId);
  const timer = pending.get(k);
  if (timer) clearTimeout(timer);
  pending.delete(k);
}

/**
 * 玩家重连后恢复 socket.data
 * @param {import('socket.io').Socket} socket
 * @param {string} tableId
 * @param {number} seat
 * @param {import('socket.io').Namespace} nsp
 */
export function restoreSeat(socket, tableId, seat, nsp) {
  const t = getTable(tableId);
  if (!t) return false;
  const s = t.seats.get(seat);
  if (!s || s.userId !== socket.data.userId) return false;

  s.connected = true;
  t.version += 1;
  socket.data.tableId = tableId;
  socket.data.seat = seat;
  socket.join(`table:${tableId}`);
  broadcastTable(nsp, t);
  return true;
}