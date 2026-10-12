import { TableReadySchema, parseOrError } from '../validate.js';
import { getTable } from '../../state/tableManager.js';
import { maybeStartHand } from '../../state/handOrchestrator.js';
import { broadcastTable } from './table.sit.js';
import { broadcastHandStart, broadcastActionRequest } from './game.action.js';

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableReady(nsp, socket) {
  socket.on('table:ready', (payload, ack) => {
    const parsed = parseOrError(TableReadySchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, ready } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const userId = socket.data.userId;

    t.actor.run(() => {
      const seat = t.userToSeat.get(userId);
      if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });
      if (t.handState && !t.handState.settled) {
        return replyAck(ack, { ok: false, code: 'HAND_IN_PROGRESS' });
      }

      const s = t.seats.get(seat);
      s.ready = ready;
      t.version += 1;

      broadcastTable(nsp, t);

      // 检查是否开局
      if (maybeStartHand(t)) {
        broadcastTable(nsp, t);
        broadcastHandStart(nsp, t);
        broadcastActionRequest(nsp, t);
      }

      replyAck(ack, { ok: true });
    });
  });
}

function replyAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}