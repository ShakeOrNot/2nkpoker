/**
 * 秀牌冒烟：一手牌有人弃牌结束（没有 showdown），结算后 5 秒内参与者可以主动秀牌。
 * 跑法：node scripts/show-smoke.js  或 GAME_URL=http://localhost:3010 node scripts/show-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const TABLE_ID = `show_${TAG}`;
const PASSWORD = 'poker-2026';

let passed = 0;
function check(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

async function api(path, { method = 'POST', body, token } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ...(data ?? {}) };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE}/game`, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WS 握手超时'));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`WS 握手失败：${err.message}`));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[秀牌冒烟] ${BASE}`);
  const regA = await api('/auth/register', { body: { nickname: `sh_${TAG}_a`, password: PASSWORD } });
  const regB = await api('/auth/register', { body: { nickname: `sh_${TAG}_b`, password: PASSWORD } });
  const [sockA, sockB] = [await connect(regA.accessToken), await connect(regB.accessToken)];

  const tableId = TABLE_ID;
  for (const [socket, seat] of [
    [sockA, 0],
    [sockB, 1],
  ]) {
    socket.emit('table:join', { tableId }, () => {});
    await delay(80);
    await new Promise((r) => socket.emit('table:sit', { tableId, seat, buyIn: 2000 }, r));
  }

  /** @type {any} */
  let result = null;
  /** @type {any[]} */
  const shown = [];
  /** @type {any} */
  let queuedAck = null;
  /** @type {string[]} */
  let aCards = [];
  sockA.on('table:snapshot', (p) => {
    const own = p.hand?.seats?.find((s) => s.seat === 0);
    if (own?.holeCards?.length === 2) aCards = own.holeCards;
  });
  sockB.on('hand:start', (p) => {
    // 手牌进行中先排队秀牌（不传 cards = 两张）
    sockB.emit('game:show_cards', { tableId, handId: p.handId }, (r) => (queuedAck = r));
  });
  for (const socket of [sockA, sockB]) {
    socket.on('game:result', (p) => (result = p));
    socket.on('game:show_cards', (p) => shown.push(p));
    socket.on('game:action_request', (p) => {
      // 第一个人直接弃牌，手牌没有 showdown
      // 稍等 200ms，让 B 的预约秀牌先到，避免测试里秒弃牌造成竞态
      setTimeout(() => {
        const action = { type: 'fold' };
        socket.emit('game:action', { tableId, handId: p.handId, expectedVersion: p.version, action }, () => {});
      }, 200);
    });
  }

  for (const socket of [sockA, sockB]) {
    await new Promise((r) => socket.emit('table:ready', { tableId, ready: true }, r));
  }

  const deadline = Date.now() + 15000;
  while (!result && Date.now() < deadline) await delay(100);
  check(Boolean(result), '弃牌结束并收到结算');
  check(!Object.keys(result.result.revealed ?? {}).length, '本手没有摊牌亮牌');
  check(queuedAck?.ok === true && queuedAck.queued === true, '手牌进行中可以预约秀牌');
  check(shown.some((s) => s.seat === 1 && s.cards?.length === 2), '结算时自动亮出预约的牌');
  check(aCards.length === 2, '拿到了自己的底牌');

  const one = await new Promise((r) =>
    sockA.emit('game:show_cards', { tableId, handId: result.handId, cards: [aCards[0]] }, r),
  );
  check(one.ok === true && one.cards?.length === 1, '结算后点一张只秀一张');
  const two = await new Promise((r) =>
    sockA.emit('game:show_cards', { tableId, handId: result.handId, cards: [aCards[1]] }, r),
  );
  check(two.ok === true && two.cards?.length === 2, '再点第二张会合并成两张');
  await delay(150);
  check(shown.some((s) => s.seat === 0 && s.cards?.length === 2), '其他玩家收到了两张秀牌');

  const again = await new Promise((r) =>
    sockA.emit('game:show_cards', { tableId, handId: result.handId, cards: [aCards[0]] }, r),
  );
  check(again.ok === false && again.code === 'ALREADY_SHOWN', '同一张牌不能重复秀');

  sockA.close();
  sockB.close();
  console.log(`\n[秀牌冒烟] 全部通过：${passed} 项断言`);
}

main().catch((err) => {
  console.error(`\n[秀牌冒烟] 失败：${err.message}`);
  process.exit(1);
});
