import { verifyJwt } from '../auth/jwt.js';

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

    socket.emit('table:snapshot', {
      tableId: 'lobby',
      version: 0,
      street: 'WAITING',
      handId: null,
      buttonSeat: 0,
      smallBlind: 1,
      bigBlind: 2,
      board: [],
      pots: [],
      seats: [],
      currentTurnSeat: null,
      actionDeadline: null,
    });

    socket.on('disconnect', () => {
      console.log('disconnected:', socket.data.userId);
    });
  });
}