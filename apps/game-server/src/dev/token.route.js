import { env } from '../env.js';
import { signJwt } from '../auth/jwt.js';

/**
 * 开发用 token 生成端点（给脚本/联调兜底用的"无名令牌"）
 * - 生产环境始终关闭
 * - `ALLOW_DEV_TOKEN=0` 也可以关掉（默认开）
 * @param {import('fastify').FastifyInstance} app
 */
export function registerDevRoutes(app) {
  if (process.env.NODE_ENV === 'production' || !env.ALLOW_DEV_TOKEN) {
    app.log.info('dev routes disabled (production or ALLOW_DEV_TOKEN=0)');
    return;
  }

  app.post('/dev/token', async (req) => {
    const body = req.body ?? {};
    const userId = body.userId ?? `user_${Math.random().toString(36).slice(2, 8)}`;
    const nickname = body.nickname ?? userId;
    const token = signJwt({ sub: userId, nickname, role: 'user' });
    return { ok: true, token, userId, nickname };
  });

  app.log.info('dev routes enabled: POST /dev/token');
}
