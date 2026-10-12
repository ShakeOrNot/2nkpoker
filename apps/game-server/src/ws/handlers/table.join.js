import { TableJoinSchema, parseOrError } from '../validate.js';
import { getOrCreateRoom, toSnapshot } from '../rooms.js';
import { getTable } from '../../state/tableManager.js';
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

    // 先尝试恢复：如果用户之前坐在这张桌的某座位，标记 connected 并恢复 socket.data
    const t = getTable(tableId);
    if (t) {
      const seat = t.userToSeat.get(userId);
      if (seat != null) {
        restoreSeat(socket, tableId, seat, nsp);
        if (typeof ack === 'function') ack({ ok: true, restored: true, seat });
        return;
      }
    }

    // 正常 join（可能是观战）
    const room = getOrCreateRoom(tableId);
    room.members.add(userId);
    room.version += 1;
    socket.join(`table:${tableId}`);

    const snapshot = toSnapshot(room);
    nsp.to(`table:${tableId}`).emit('table:snapshot', snapshot);

    if (typeof ack === 'function') ack({ ok: true });
  });
}