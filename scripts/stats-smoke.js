/**
 * 战绩冒烟（真 HTTP + 真 WebSocket）：
 *   注册两个真实账号 → 坐下/准备 → 自动跟注打完一手
 *   → GET /auth/me/stats 确认手数/入池/胜率等已记账
 *
 * 跑法（需要后端在跑）：
 *   node scripts/stats-smoke.js
 *   GAME_URL=http://localhost:3010 node scripts/stats-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const NICK_A = `stat_${TAG}_a`;
const NICK_B = `stat_${TAG}_b`;
const PASSWORD = 'poker-2026';
const TABLE_ID = `stats_${TAG}`;

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
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
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

/** 自动应答行动请求：能过就过，否则跟注（保证手牌能打完） */
function autoPlay(socket, tableId) {
  socket.on('game:action_request', (p) => {
    const action = p.legalActions?.includes('check')
      ? { type: 'check' }
      : p.legalActions?.includes('call')
        ? { type: 'call' }
        : { type: 'fold' };
    socket.emit('game:action', { tableId, handId: p.handId, expectedVersion: p.version, action }, () => {});
  });
}

async function main() {
  console.log(`[战绩冒烟] ${BASE}`);

  const regA = await api('/auth/register', { body: { nickname: NICK_A, password: PASSWORD } });
  const regB = await api('/auth/register', { body: { nickname: NICK_B, password: PASSWORD } });
  check(regA.ok && regB.ok, '注册两个测试账号');

  const [sockA, sockB] = [await connect(regA.accessToken), await connect(regB.accessToken)];
  autoPlay(sockA, TABLE_ID);
  autoPlay(sockB, TABLE_ID);

  for (const [socket, seat] of [
    [sockA, 0],
    [sockB, 1],
  ]) {
    socket.emit('table:join', { tableId: TABLE_ID }, () => {});
    await new Promise((r) => setTimeout(r, 100));
    const sit = await new Promise((r) =>
      socket.emit('table:sit', { tableId: TABLE_ID, seat, buyIn: 2000 }, r),
    );
    check(sit.ok === true, `座位 ${seat} 坐下成功`);
  }

  const results = [];
  const onResult = (p) => results.push(p);
  sockA.on('game:result', onResult);

  for (const socket of [sockA, sockB]) {
    await new Promise((r) => socket.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  }

  // 等这一手结算（自动过牌/跟注，最多 25 秒）
  const deadline = Date.now() + 25000;
  while (!results.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  check(results.length > 0, '这一手打到了结算');

  const statA = await api('/auth/me/stats', { method: 'GET', token: regA.accessToken });
  const statB = await api('/auth/me/stats', { method: 'GET', token: regB.accessToken });
  check(statA.ok && statB.ok, '两个账号都能拿到自己的战绩');
  check(statA.stats.hands >= 1 && statB.stats.hands >= 1, '双方都记了至少一手');
  check(statA.stats.hands === statB.stats.hands, '同一手牌双方手数一致');

  for (const [name, s] of [
    ['A', statA.stats],
    ['B', statB.stats],
  ]) {
    console.log(
      `  ${name}: hands=${s.hands} vpip=${s.vpipHands} win=${s.wins} showdown=${s.showdowns} showdownWin=${s.showdownWins} net=${s.net}`,
    );
    check(s.vpipRate >= 0 && s.vpipRate <= 1, `${name} 入池率在 0~1`);
    check(s.winRate >= 0 && s.winRate <= 1, `${name} 胜率在 0~1`);
    check(s.showdownWinRate >= 0 && s.showdownWinRate <= 1, `${name} 摊牌胜率在 0~1`);
  }

  // 管理员视角也能看到这两个账号
  sockA.close();
  sockB.close();
  console.log(`\n[战绩冒烟] 全部通过：${passed} 项断言`);
}

main().catch((err) => {
  console.error(`\n[战绩冒烟] 失败：${err.message}`);
  process.exit(1);
});
