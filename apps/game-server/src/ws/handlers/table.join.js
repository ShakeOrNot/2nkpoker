import { TableJoinSchema, parseOrError } from '../validate.js';
import { getOrCreateTable } from '../../state/tableManager.js';
import { toTableSnapshot } from '../../state/tableSnapshot.js';
import { restoreSeat } from '../../state/disconnectManager.js';

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableJoin(nsp, socket) {
  socket.on('table:join', (payload, ack) => {
    const parsed = parseOrError(TableJoinSchema, payload);
    if (!parsed.ok) {
      if (typeof ack === 'function') ack({ ok: false, code: parsed.code, message: parsed.message });
      return;
    }

    const { tableId } = parsed.data;
    const userId = socket.data.userId;
    const t = getOrCreateTable(tableId);

    // 断线重连：如果用户之前坐在这张桌
    const existingSeat = t.userToSeat.get(userId);
    if (existingSeat != null) {
      restoreSeat(socket, tableId, existingSeat, nsp);
      if (typeof ack === 'function') ack({ ok: true, restored: true, seat: existingSeat });
      return;
    }

    // 普通 join：订阅房间，只给自己发一份初始快照
    socket.join(`table:${tableId}`);
    const forSeat = socket.data.seat ?? null;
    socket.emit('table:snapshot', toTableSnapshot(t, forSeat));

    if (typeof ack === 'function') ack({ ok: true });
  });
}