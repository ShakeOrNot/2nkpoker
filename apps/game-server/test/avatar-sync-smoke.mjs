import './helpers/env.js';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { initDb, closeDb } from '../src/users/db.js';
import { registerAuthRoutes } from '../src/routes/auth.route.js';
import { registerGameNamespace } from '../src/ws/game.namespace.js';
import { closeTable } from '../src/state/tableManager.js';
import { cancelPendingDisconnect } from '../src/state/disconnectManager.js';

initDb(':memory:');
const app = Fastify({ logger: false });
registerAuthRoutes(app);
const server = new Server(app.server);
registerGameNamespace(server);
const clients = [];
const userIds = [];
const tableId = 'avatar-sync';
function snapshot(socket, test) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('table:snapshot', listener); reject(new Error('头像快照超时')); }, 3000);
    function listener(value) { if (test(value)) { clearTimeout(timer); socket.off('table:snapshot', listener); resolve(value); } }
    socket.on('table:snapshot', listener);
  });
}
try {
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const sessions = [];
  for (const nickname of ['同步甲', '同步乙']) {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { nickname, password: 'poker-2026' } });
    assert.equal(res.statusCode, 201);
    const session = res.json(); sessions.push(session);
    userIds.push(session.user.id);
    const socket = io(`${url}/game`, { auth: { token: session.accessToken }, transports: ['websocket'], autoConnect: false });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    assert.equal((await socket.timeout(3000).emitWithAck('table:join', { tableId })).ok, true);
    assert.equal((await socket.timeout(3000).emitWithAck('table:sit', { tableId, seat: clients.length - 1, buyIn: 2000 })).ok, true);
  }
  const updates = clients.map(socket => snapshot(socket, value => value.seats.find(s => s.userId === sessions[0].user.id)?.avatarId === 'fox'));
  const result = await app.inject({ method: 'PATCH', url: '/auth/me/avatar', headers: { authorization: `Bearer ${sessions[0].accessToken}` }, payload: { avatarId: 'fox' } });
  assert.equal(result.statusCode, 200);
  for (const value of await Promise.all(updates)) {
    assert.equal(value.seats[0].avatarId, 'fox');
    assert.equal(value.seats[1].avatarId, 'lion');
    assert.equal(value.seats[0].chips, 2000);
  }
  const fresh = snapshot(clients[1], value => value.seats[0]?.avatarId === 'fox');
  await clients[1].timeout(3000).emitWithAck('table:request_state', { tableId });
  await fresh;
  console.log('头像双客户端实时同步与重新取快照检查通过');
} finally {
  for (const socket of clients) socket.disconnect();
  await new Promise(resolve => server.close(resolve));
  for (const id of userIds) cancelPendingDisconnect(id);
  closeTable(tableId);
  await app.close(); closeDb();
}
