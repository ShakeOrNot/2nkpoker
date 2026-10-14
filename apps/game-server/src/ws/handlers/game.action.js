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
        // 延迟 2.5 秒（给结算浮层留时间）后自动开下一手
        scheduleNextHand(nsp, t);
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
/**
 * 结算后延迟自动开下一手
 * 只在玩家已 ready 且桌上 ≥ 2 人时才会真正开
 * @param {import('socket.io').Namespace} nsp
 * @param {any} t
 */
function scheduleNextHand(nsp, t) {
  setTimeout(() => {
    t.actor.run(async () => {
      const { maybeStartHand } = await import('../../state/handOrchestrator.js');
      const { broadcastHandStart, broadcastActionRequest } = await import('../../state/actionTimer.js');
      const { broadcastTable } = await import('./table.sit.js');

      if (!maybeStartHand(t)) return;
      broadcastTable(nsp, t);
      broadcastHandStart(nsp, t);
      broadcastActionRequest(nsp, t);
    });
  }, 2500);
}