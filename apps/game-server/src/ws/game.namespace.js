import { verifyJwt } from '../auth/jwt.js';
import { registerTableJoin } from './handlers/table.join.js';
import { registerTableSit } from './handlers/table.sit.js';

/**
 * @param {import('socket.io').Server} io
 */
export function registerGameNamespace(io) {
  const nsp = io.of('/game');

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('AUTH_FAILED'));
    try {
      const payload = verifyJwt(token);
      socket.data.userId = payload.sub;
      socket.data.nickname = payload.nickname;
      next();
    } catch {
      next(new Error('AUTH_FAILED'));
    }
  });

  nsp.on('connection', (socket) => {
    console.log('connected:', socket.data.userId);

    registerTableJoin(nsp, socket);
    registerTableSit(nsp, socket);

    socket.on('disconnect', () => {
      console.log('disconnected:', socket.data.userId);
    });
  });
}