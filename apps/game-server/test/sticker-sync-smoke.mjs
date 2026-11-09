import './helpers/env.js';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { initDb, closeDb } from '../src/users/db.js';
import { registerAuthRoutes } from '../src/routes/auth.route.js';
import { registerStickerRoutes } from '../src/routes/stickers.route.js';
import { registerGameNamespace } from '../src/ws/game.namespace.js';
import { closeTable } from '../src/state/tableManager.js';
import { validateStickerPng } from '../src/users/stickerStore.js';
import { makeStickerPng } from './helpers/sticker-fixture.mjs';

initDb(':memory:'); const app = Fastify({ logger: false }); registerAuthRoutes(app); registerStickerRoutes(app);
const server = new Server(app.server); registerGameNamespace(server); const clients = []; const sessions = [];
const request = (s, event, payload) => s.timeout(3000).emitWithAck(event, payload);
const png = makeStickerPng();
const upload = (token, image = png) => app.inject({ method: 'POST', url: '/auth/me/stickers', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: { name: '自定义筹码', dataUrl: `data:image/png;base64,${image.toString('base64')}` } });
try {
  assert.deepEqual(validateStickerPng(png), png);
  assert.throws(() => validateStickerPng(Buffer.from('<svg onload="alert(1)"/>')));
  assert.throws(() => validateStickerPng(png.subarray(0, -1)));
  assert.throws(() => validateStickerPng(makeStickerPng(513, 1)));
  const broken = Buffer.from(png); broken[45] ^= 1; assert.throws(() => validateStickerPng(broken));
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const nickname of ['表情甲', '表情乙', '表情丙']) {
    const session = (await app.inject({ method: 'POST', url: '/auth/register', payload: { nickname, password: 'poker-2026' } })).json(); sessions.push(session);
    const socket = io(`${url}/game`, { auth: { token: session.accessToken }, transports: ['websocket'], autoConnect: false }); clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    await request(socket, 'table:join', { tableId: clients.length < 3 ? 'sticker-a' : 'sticker-b' });
  }
  assert.equal((await upload()).statusCode, 401);
  assert.equal((await upload(sessions[0].accessToken, Buffer.from('not png'))).statusCode, 400);
  const saved = (await upload(sessions[0].accessToken)).json().sticker; assert.ok(saved.id);
  assert.equal((await upload(sessions[0].accessToken)).json().sticker.id, saved.id);
  const asset = await app.inject({ method: 'GET', url: saved.url }); assert.equal(asset.headers['content-type'], 'image/png'); assert.deepEqual(asset.rawPayload, png);
  for (let i = 0; i < 2; i++) {
    const list = await app.inject({ method: 'GET', url: '/auth/me/stickers', headers: { authorization: `Bearer ${sessions[i].accessToken}` } });
    assert.equal(list.json().stickers.length, i === 0 ? 1 : 0);
  }
  const [a,b,c] = clients; let leaked = 0; c.on('chat:message', () => leaked++);
  const payload = { tableId: 'sticker-a', stickerId: saved.id, clientId: 'sticker_message_1' };
  assert.equal((await request(b, 'chat:send', payload)).code, 'INVALID_STICKER');
  assert.equal((await request(c, 'chat:send', payload)).code, 'CHAT_FORBIDDEN');
  const received = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('表情接收超时')), 3000); b.once('chat:message', m => { clearTimeout(timer); resolve(m); }); });
  const sent = await request(a, 'chat:send', payload); assert.equal(sent.ok, true);
  const message = await received; assert.equal(message.sticker.id, saved.id); assert.equal(message.text, '');
  assert.equal((await request(a, 'chat:send', payload)).message.id, message.id);
  const builtin = await request(b, 'chat:send', { tableId: 'sticker-a', stickerId: 'allin', clientId: 'sticker_builtin_1' });
  assert.equal(builtin.message.sticker.url, '/img/stickers/allin.svg');
  const history = await request(b, 'chat:history', { tableId: 'sticker-a' }); assert.equal(history.messages[0].sticker.id, saved.id); assert.equal(leaked, 0);
  for (let i = 1; i <= 11; i++) assert.equal((await upload(sessions[0].accessToken, makeStickerPng(64, 64, i))).statusCode, 200);
  assert.equal((await upload(sessions[0].accessToken, makeStickerPng(64, 64, 12))).statusCode, 400);
  console.log('表情检查通过：PNG结构/尺寸/CRC、上传鉴权、资源读取、账号隔离、12张上限、内置/自定义跨端收发、跨房隔离、历史、重复去重');
} finally {
  for (const s of clients) s.disconnect(); await new Promise(resolve => server.close(resolve));
  closeTable('sticker-a'); closeTable('sticker-b'); await app.close(); closeDb();
}
