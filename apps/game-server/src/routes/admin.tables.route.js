import { z } from 'zod';
import { closeTable, getTable, listTableDetails } from '../state/tableManager.js';
import { clearActionTimer, clearNextHandTimer, clearStreetTimer } from '../state/actionTimer.js';
import { getGameNamespace } from '../ws/game.namespace.js';
import { broadcastTable } from '../ws/handlers/table.sit.js';
import { clientIp, requireAdmin } from '../auth/adminGuard.js';
import { writeAudit } from '../auth/audit.js';

const KickSchema = z.object({
  userId: z.string().min(1).max(80),
});

/**
 * 房间里的 socket 是按 socket.id 存的，这里按 data.userId 找
 * @param {any} nsp
 * @param {string} tableId
 * @param {string} userId
 */
function findSocketByUserId(nsp, tableId, userId) {
  const room = nsp?.adapter?.rooms?.get(`table:${tableId}`);
  if (!room) return null;
  for (const sid of room) {
    const sock = nsp.sockets.get(sid);
    if (sock?.data?.userId === userId) return sock;
  }
  return null;
}

/**
 * 管理员牌桌管理：查看所有桌子、强制解散、踢人
 * @param {import('fastify').FastifyInstance} app
 */
export function registerAdminTableRoutes(app) {
  /* ---------------- 牌桌列表（含座位） ---------------- */
  app.get('/auth/admin/tables', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;
    return { ok: true, tables: listTableDetails() };
  });

  /* ---------------- 强制解散牌局 ---------------- */
  app.post('/auth/admin/tables/:tableId/close', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;

    const tableId = String(req.params.tableId ?? '');
    const table = getTable(tableId);
    if (!table) {
      reply.code(404);
      return { ok: false, code: 'TABLE_NOT_FOUND', message: '牌局不存在' };
    }

    // 先通知房间里的人（前端收到后回大厅），再清桌
    const nsp = getGameNamespace();
    nsp?.to(`table:${tableId}`).emit('table:closed', { tableId, by: admin.nickname });
    clearActionTimer(tableId);
    clearNextHandTimer(tableId);
    clearStreetTimer(tableId);
    closeTable(tableId);

    writeAudit({
      action: 'admin-close-table',
      userId: admin.id,
      nickname: `${admin.nickname} → #${tableId}`,
      ip: clientIp(req),
      ua: req.headers['user-agent'],
      ok: true,
    });
    return { ok: true, tableId };
  });

  /* ---------------- 踢出某个玩家（手牌中不允许，避免牌局卡死） ---------------- */
  app.post('/auth/admin/tables/:tableId/kick', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;

    const parsed = KickSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '要指定 userId' };
    }
    const tableId = String(req.params.tableId ?? '');
    const table = getTable(tableId);
    if (!table) {
      reply.code(404);
      return { ok: false, code: 'TABLE_NOT_FOUND', message: '牌局不存在' };
    }
    const userId = parsed.data.userId;
    const seat = table.userToSeat.get(userId);
    if (seat == null) {
      reply.code(404);
      return { ok: false, code: 'USER_NOT_IN_TABLE', message: '该玩家不在这张桌上' };
    }
    if (table.handState && !table.handState.settled) {
      reply.code(409);
      return { ok: false, code: 'HAND_IN_PROGRESS', message: '手牌进行中，不能踢人（可以先解散牌局）' };
    }

    table.seats.delete(seat);
    table.userToSeat.delete(userId);
    if (Array.isArray(table.sitQueue)) {
      table.sitQueue = table.sitQueue.filter((q) => q.userId !== userId);
    }
    table.version += 1;

    const nsp = getGameNamespace();
    if (nsp) {
      const sock = findSocketByUserId(nsp, tableId, userId);
      if (sock) {
        sock.leave(`table:${tableId}`);
        sock.data.seat = null;
        sock.data.tableId = null;
        sock.emit('table:kicked', { tableId, by: admin.nickname });
      }
      broadcastTable(nsp, table);
    }

    writeAudit({
      action: 'admin-kick',
      userId: admin.id,
      nickname: `${userId} @${tableId}`,
      ip: clientIp(req),
      ua: req.headers['user-agent'],
      ok: true,
    });
    return { ok: true, tableId, seat };
  });
}
