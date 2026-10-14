import { TableJoinSchema, parseOrError } from '../validate.js';
import { getOrCreateTable, getTable } from '../../state/tableManager.js';
import { toTableSnapshot } from '../../state/tableSnapshot.js';
import { restoreSeat } from '../../state/disconnectManager.js';

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerTableJoin(nsp, socket) {
  /* ---------- table:join ---------- */

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

  /* ---------- table:leave ---------- */
  /* 退订房间（不一定离座）。离座用 table:stand。 */

  socket.on('table:leave', (payload, ack) => {
    const tableId = payload?.tableId;
    if (!tableId) {
      if (typeof ack === 'function') ack({ ok: false, code: 'INVALID_PAYLOAD' });
      return;
    }
    socket.leave(`table:${tableId}`);
    // 如果没坐在任何座位上，就顺手清一下 socket.data
    if (socket.data.tableId === tableId && socket.data.seat == null) {
      socket.data.tableId = undefined;
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  /* ---------- table:request_state ---------- */
  /* 客户端主动请求当前快照。手机切回前台、重连后同步状态时用。 */

  socket.on('table:request_state', (payload, ack) => {
    const tableId = payload?.tableId;
    if (!tableId) {
      if (typeof ack === 'function') ack({ ok: false, code: 'INVALID_PAYLOAD' });
      return;
    }

    const t = getTable(tableId);
    if (!t) {
      if (typeof ack === 'function') ack({ ok: false, code: 'TABLE_NOT_FOUND' });
      return;
    }

    const forSeat = socket.data.seat ?? null;
    const snap = toTableSnapshot(t, forSeat);

    if (typeof ack === 'function') ack({ ok: true, snapshot: snap });
    // 顺手也主动推一份，前端即使没处理 ack 也能拿到
    socket.emit('table:snapshot', snap);
  });
}