import { listTables, createTable, getTable } from '../state/tableManager.js';
import { z } from 'zod';

const CreateTableSchema = z.object({
  tableId: z.string().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/),
  maxSeats: z.number().int().min(2).max(6).optional(),
  smallBlind: z.number().int().positive().max(100000).optional(),
  bigBlind: z.number().int().positive().max(1000000).optional(),
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

  // POST /tables —— 创建牌局
  app.post('/tables', async (req, reply) => {
    const parsed = CreateTableSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: parsed.error.issues[0]?.message ?? 'invalid body' };
    }
    const { tableId, maxSeats, smallBlind, bigBlind } = parsed.data;
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
          createdAt: t.createdAt,
        },
      };
    }
    const t = createTable(tableId, { maxSeats, smallBlind, bigBlind });
    app.log.info({ tableId, maxSeats: t.maxSeats, smallBlind: t.smallBlind, bigBlind: t.bigBlind }, 'table created');
    return {
      ok: true,
      table: {
        tableId: t.tableId,
        maxSeats: t.maxSeats,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        createdAt: t.createdAt,
      },
    };
  });
}