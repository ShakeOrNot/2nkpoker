import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Server } from 'socket.io';
import { env } from './env.js';
import { registerGameNamespace } from './ws/game.namespace.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, credentials: true });
await app.register(helmet);

app.get('/health', async () => ({ ok: true, service: 'game-server' }));
app.get('/ready', async () => ({ ok: true }));

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const io = new Server(app.server, {
  cors: { origin: true, credentials: true },
});
registerGameNamespace(io);

app.log.info(`game-server listening on ${env.PORT}`);