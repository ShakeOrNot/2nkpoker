import { verifyJwt } from '../auth/jwt.js';
import { registerTableJoin } from './handlers/table.join.js';
import { registerTableSit } from './handlers/table.sit.js';
import { registerTableReady } from './handlers/table.ready.js';
import { registerGameAction } from './handlers/game.action.js';
import {
  handleDisconnect,
  cancelPendingDisconnect,
} from '../state/disconnectManager.js';

export function registerGameNamespace(io) {
  const nsp = io.of('/game');

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('AUTH_FAILED'));
    try {
      const payload = verifyJwt(token);
      socket.data.userId = payload.sub;
      socket.data.nickname = payload.nickname;
      cancelPendingDisconnect(payload.sub);
      next();
    } catch {
      next(new Error('AUTH_FAILED'));
    }
  });

  nsp.on('connection', (socket) => {
    console.log('connected:', socket.data.userId);

    registerTableJoin(nsp, socket);
    registerTableSit(nsp, socket);
    registerTableReady(nsp, socket);
    registerGameAction(nsp, socket);

    socket.on('disconnect', () => {
      console.log('disconnected:', socket.data.userId);
      handleDisconnect(nsp, socket);
    });
  });
}