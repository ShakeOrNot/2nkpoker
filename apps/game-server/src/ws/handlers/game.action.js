import { GameActionSchema, parseOrError } from '../validate.js';
import { getTable } from '../../state/tableManager.js';
import { playAction } from '../../state/handOrchestrator.js';
import { notePreflopAction } from '../../state/handStats.js';
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
      // 入池率按"翻牌前的主动投钱动作"算，必须在应用动作前判断街
      const wasPreflop = t.handState?.street === 'PREFLOP';
      const result = playAction(t, seat, action, expectedVersion);
      if (!result.ok) return replyAck(ack, result);
      if (wasPreflop) notePreflopAction(t, seat, action.type);

      nsp.to(`table:${tableId}`).emit('game:action_applied', { seat, action, handId });
      broadcastTable(nsp, t);

      if (t.handState.settled) {
        clearActionTimer(tableId);
        // broadcastResult 内部会在 SETTLE_HOLD_MS 后自己开下一手（留时间给结算动画）
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