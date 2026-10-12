import { GameActionSchema, parseOrError } from '../validate.js';
import { getTable } from '../../state/tableManager.js';
import { playAction } from '../../state/handOrchestrator.js';
import { broadcastTable } from './table.sit.js';
import {
  broadcastActionRequest,
  broadcastResult,
  clearActionTimer,
} from '../../state/actionTimer.js';

export function registerGameAction(nsp, socket) {
  socket.on('game:action', (payload, ack) => {
    const parsed = parseOrError(GameActionSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, handId, expectedVersion, action } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const seat = t.userToSeat.get(socket.data.userId);
    if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });
    if (t.handState?.handId !== handId) {
      return replyAck(ack, { ok: false, code: 'HAND_NOT_ACTIVE' });
    }

    t.actor.run(() => {
      const result = playAction(t, seat, action, expectedVersion);
      if (!result.ok) return replyAck(ack, result);

      nsp.to(`table:${tableId}`).emit('game:action_applied', { seat, action, handId });
      broadcastTable(nsp, t);

      if (t.handState.settled) {
        clearActionTimer(tableId);
        broadcastResult(nsp, t, handId);
      } else {
        broadcastActionRequest(nsp, t);
      }
      replyAck(ack, { ok: true });
    });
  });
}

function replyAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}