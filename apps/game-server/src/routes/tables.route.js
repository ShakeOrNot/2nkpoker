import { listTables, createTable, getTable } from '../state/tableManager.js';
import { getDb } from '../users/db.js';
import { requireUser } from '../auth/adminGuard.js';
import { z } from 'zod';

const CreateTableSchema = z.object({
  tableId: z.string().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/),
  maxSeats: z.number().int().min(2).max(6).optional(),
  smallBlind: z.number().int().positive().max(100000).optional(),
  bigBlind: z.number().int().positive().max(1000000).optional(),
  ante: z.number().int().min(0).max(1000).optional(),
});

/**
 * 注册牌局列表/创建路由
 * @param {import('fastify').FastifyInstance} app
 */
export function registerTablesRoutes(app) {
  // GET /tables —— 牌局列表
  app.get('/tables', async () => {
    return { tables: listTables() };
  });

  // GET /tables/:tableId —— 单个牌局详情
  app.get('/tables/:tableId', async (req, reply) => {
    const t = getTable(req.params.tableId);
    if (!t) {
      reply.code(404);
      return { ok: false, code: 'TABLE_NOT_FOUND' };
    }
    return {
      ok: true,
      table: {
        tableId: t.tableId,
        players: t.seats.size,
        maxSeats: t.maxSeats,
        hasHand: Boolean(t.handState && !t.handState.settled),
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        createdAt: t.createdAt ?? Date.now(),
      },
    };
  });

  // GET /tables/:tableId/player-nets —— 本桌每个座位的净盈利（按本桌牌局统计）
  app.get('/tables/:tableId/player-nets', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const tableId = String(req.params.tableId ?? '');
    const t = getTable(tableId);
    if (!t) {
      reply.code(404);
      return { ok: false, code: 'TABLE_NOT_FOUND' };
    }
    const rows = getDb()
      .prepare(
        `SELECT user_id,
                COALESCE(SUM(net), 0) AS net,
                COUNT(*) AS hands
         FROM player_hands
         WHERE table_id = ?
         GROUP BY user_id`,
      )
      .all(tableId);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const players = [...t.seats.values()]
      .map((s) => {
        const row = byUser.get(s.userId);
        return {
          seat: s.seat,
          userId: s.userId,
          nickname: s.nickname,
          net: Number(row?.net ?? 0),
          hands: Number(row?.hands ?? 0),
        };
      })
      .sort((a, b) => b.net - a.net || a.seat - b.seat);
    return { ok: true, tableId, players };
  });

  // POST /tables —— 创建牌局
  app.post('/tables', async (req, reply) => {
    const parsed = CreateTableSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: parsed.error.issues[0]?.message ?? 'invalid body' };
    }
    const { tableId, maxSeats, smallBlind, bigBlind, ante } = parsed.data;
    if (getTable(tableId)) {
      // 已存在：直接返回（前端会 join 进去）
      const t = getTable(tableId);
      return {
        ok: true,
        table: {
          tableId,
          maxSeats: t.maxSeats,
          smallBlind: t.smallBlind,
          bigBlind: t.bigBlind,
          ante: t.ante ?? 0,
          createdAt: t.createdAt,
        },
      };
    }
    const t = createTable(tableId, { maxSeats, smallBlind, bigBlind, ante });
    app.log.info({ tableId, maxSeats: t.maxSeats, smallBlind: t.smallBlind, bigBlind: t.bigBlind, ante: t.ante }, 'table created');
    return {
      ok: true,
      table: {
        tableId: t.tableId,
        maxSeats: t.maxSeats,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        ante: t.ante ?? 0,
        createdAt: t.createdAt,
      },
    };
  });
}