import { getTable } from '../../state/tableManager.js';
import { handleRunoutPropose } from '../../state/actionTimer.js';

const replyAck = (ack, res) => {
  if (typeof ack === 'function') ack(res);
};

/**
 * 跑马协商：所有 all-in 玩家都选同一个次数才执行。
 * ws: game:runout_propose { tableId, handId, runs }
 */
export function registerGameRunout(nsp, socket) {
  socket.on('game:runout_propose', (payload, ack) => {
    const tableId = String(payload?.tableId ?? '');
    const handId = String(payload?.handId ?? '');
    const runs = Number(payload?.runs);
    const t = tableId ? getTable(tableId) : null;
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });
    const seat = t.userToSeat.get(socket.data.userId);
    if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });

    t.actor.run(() => {
      const res = handleRunoutPropose(nsp, t, seat, handId, runs);
      replyAck(ack, res);
    });
  });
}
