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
import { setDisabled } from '../src/users/userStore.js';

initDb(':memory:');
const app = Fastify({ logger: false }); registerAuthRoutes(app);
const server = new Server(app.server); registerGameNamespace(server);
const clients = []; const sessions = [];
const request = (socket, event, payload) => socket.timeout(3000).emitWithAck(event, payload);
const waitMessage = socket => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off('chat:message', listener); reject(new Error('聊天消息超时')); }, 3000);
  const listener = value => { clearTimeout(timer); socket.off('chat:message', listener); resolve(value); };
  socket.on('chat:message', listener);
});
try {
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const nickname of ['聊天甲', '聊天乙', '聊天丙']) {
    const session = (await app.inject({ method: 'POST', url: '/auth/register', payload: { nickname, password: 'poker-2026' } })).json();
    sessions.push(session);
    const socket = io(`${url}/game`, { auth: { token: session.accessToken }, transports: ['websocket'], autoConnect: false }); clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    await request(socket, 'table:join', { tableId: clients.length < 3 ? 'chat-room-a' : 'chat-room-b' });
  }
  const [a, b, outsider] = clients;
  let leaked = 0; outsider.on('chat:message', () => leaked++);
  const payload = { tableId: 'chat-room-a', clientId: 'message_001', text: '  牌友你好 <b>加油</b>  ' };
  assert.equal((await request(outsider, 'chat:send', payload)).code, 'CHAT_FORBIDDEN');
  assert.equal((await request(outsider, 'chat:history', { tableId: payload.tableId })).code, 'CHAT_FORBIDDEN');
  assert.equal((await request(a, 'chat:send', { ...payload, userId: sessions[1].user.id })).code, 'INVALID_PAYLOAD');
  assert.equal((await request(a, 'chat:send', { ...payload, text: '长'.repeat(281) })).code, 'INVALID_PAYLOAD');
  assert.equal((await request(a, 'chat:send', { ...payload, text: '   ' })).code, 'INVALID_PAYLOAD');
  const received = [waitMessage(a), waitMessage(b)];
  const sent = await request(a, 'chat:send', payload);
  assert.equal(sent.ok, true);
  const messages = await Promise.all(received);
  for (const message of messages) {
    assert.equal(message.id, sent.message.id); assert.equal(message.userId, sessions[0].user.id);
    assert.equal(message.nickname, '聊天甲'); assert.equal(message.text, payload.text.trim()); assert.equal(message.avatarId, 'lion');
  }
  let repeated = 0; b.on('chat:message', () => repeated++);
  const duplicate = await request(a, 'chat:send', payload);
  assert.equal(duplicate.message.id, sent.message.id);
  assert.equal((await request(a, 'chat:send', { ...payload, clientId: 'message_002' })).code, 'CHAT_RATE_LIMIT');
  const history = await request(b, 'chat:history', { tableId: payload.tableId });
  assert.equal(history.messages.length, 1); assert.equal(history.messages[0].id, sent.message.id);
  assert.equal(repeated, 0); assert.equal(leaked, 0);
  await request(b, 'table:leave', { tableId: payload.tableId });
  assert.equal((await request(b, 'chat:send', { ...payload, clientId: 'message_left' })).code, 'CHAT_FORBIDDEN');
  b.disconnect();
  await new Promise((resolve, reject) => { b.once('connect', resolve); b.once('connect_error', reject); b.connect(); });
  await request(b, 'table:join', { tableId: payload.tableId });
  assert.equal((await request(b, 'chat:history', { tableId: payload.tableId })).messages[0].id, sent.message.id);
  setDisabled(sessions[1].user.id, 1);
  assert.equal((await request(b, 'chat:history', { tableId: payload.tableId })).code, 'CHAT_FORBIDDEN');
  console.log('聊天联机检查通过：收发、身份、跨房隔离、纯文本、长度、限频、重试去重、离房拒绝、重连历史、禁用账号');
} finally {
  for (const socket of clients) socket.disconnect();
  await new Promise(resolve => server.close(resolve));
  for (const session of sessions) cancelPendingDisconnect(session.user.id);
  closeTable('chat-room-a'); closeTable('chat-room-b');
  await app.close(); closeDb();
}
