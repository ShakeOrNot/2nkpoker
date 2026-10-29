// env.js 必须最早求值：它负责把仓库根的 .env 读进 process.env，
// 后面 actionTimer / disconnectManager 在模块顶层读超时配置就依赖这一步。
import { env } from './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Server } from 'socket.io';
import { registerGameNamespace } from './ws/game.namespace.js';
import { registerDevRoutes } from './dev/token.route.js';
import { registerTablesRoutes } from './routes/tables.route.js';
import { registerAuthRoutes } from './routes/auth.route.js';
import { initDb } from './users/db.js';
import { cleanupExpiredTokens } from './auth/session.js';

// 用户库（SQLite）：启动即建表/迁移，顺手清掉过期刷新令牌
initDb(env.AUTH_DB_PATH);
cleanupExpiredTokens();

// 反向代理后面（Nginx/Caddy）要信任 X-Forwarded-For，否则限流按代理 IP 计算
const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY });
await app.register(cors, { origin: true, credentials: true });
await app.register(helmet);

app.get('/health', async () => ({ ok: true, service: 'game-server' }));
app.get('/ready', async () => ({ ok: true }));

registerAuthRoutes(app);
registerDevRoutes(app);
registerTablesRoutes(app);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const io = new Server(app.server, {
  cors: { origin: true, credentials: true },
});
registerGameNamespace(io);

app.log.info(`game-server listening on ${env.PORT}`);
app.log.info(`auth db: ${env.AUTH_DB_PATH}`);