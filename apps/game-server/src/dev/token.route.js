import { signJwt } from '../auth/jwt.js';

/**
 * 开发用 token 生成端点
 * 仅当 NODE_ENV !== 'production' 时挂载
 * @param {import('fastify').FastifyInstance} app
 */
export function registerDevRoutes(app) {
  if (process.env.NODE_ENV === 'production') {
    app.log.info('dev routes disabled in production');
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