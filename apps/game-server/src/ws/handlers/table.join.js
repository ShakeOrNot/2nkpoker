import { TableJoinSchema, parseOrError } from '../validate.js';
import { getOrCreateRoom, toSnapshot } from '../rooms.js';

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableJoin(nsp, socket) {
  socket.on('table:join', (payload, ack) => {
    const parsed = parseOrError(TableJoinSchema, payload);
    if (!parsed.ok) {
      if (typeof ack === 'function') {
        ack({ ok: false, code: parsed.code, message: parsed.message });
      }
      return;
    }

    const { tableId } = parsed.data;
    const room = getOrCreateRoom(tableId);
    room.members.add(socket.data.userId);
    room.version += 1;

    socket.join(`table:${tableId}`);

    const snapshot = toSnapshot(room);
    nsp.to(`table:${tableId}`).emit('table:snapshot', snapshot);

    if (typeof ack === 'function') ack({ ok: true });
  });
}