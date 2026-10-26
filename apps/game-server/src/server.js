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

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, credentials: true });
await app.register(helmet);

app.get('/health', async () => ({ ok: true, service: 'game-server' }));
app.get('/ready', async () => ({ ok: true }));

registerDevRoutes(app);
registerTablesRoutes(app);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const io = new Server(app.server, {
  cors: { origin: true, credentials: true },
});
registerGameNamespace(io);

app.log.info(`game-server listening on ${env.PORT}`);