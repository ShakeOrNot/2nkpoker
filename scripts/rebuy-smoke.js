/**
 * 补码（买入）冒烟（真 HTTP + 真 WebSocket）：
 *   两个真人坐下（各 1 个买入=2000）→ 打一手
 *   → 手牌进行中提交 1 个买入（应 pending，筹码不变）
 *   → 本手结算后座位 buyInTotal 变 4000（补码已生效）
 *   → 两手之间再买 1 个（应立即生效，buyInTotal=6000）
 *
 * 跑法：node scripts/rebuy-smoke.js  或  GAME_URL=http://localhost:3010 node scripts/rebuy-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const NICK_A = `rb_${TAG}_a`;
const NICK_B = `rb_${TAG}_b`;
const PASSWORD = 'poker-2026';
const TABLE_ID = `rebuy_${TAG}`;
const BUY_IN = 2000;

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立（每 100ms 查一次） */
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  console.log(`[补码冒烟] ${BASE}`);

  const regA = await api('/auth/register', { body: { nickname: NICK_A, password: PASSWORD } });
  const regB = await api('/auth/register', { body: { nickname: NICK_B, password: PASSWORD } });
  check(regA.ok && regB.ok, '注册两个测试账号');

  const [sockA, sockB] = [await connect(regA.accessToken), await connect(regB.accessToken)];
  const latest = { a: null, b: null };
  sockA.on('table:snapshot', (s) => (latest.a = s));
  sockB.on('table:snapshot', (s) => (latest.b = s));

  for (const [socket, seat] of [
    [sockA, 0],
    [sockB, 1],
  ]) {
    socket.emit('table:join', { tableId: TABLE_ID }, () => {});
    await delay(80);
    const sit = await new Promise((r) => socket.emit('table:sit', { tableId: TABLE_ID, seat, buyIn: BUY_IN }, r));
    check(sit.ok === true, `座位 ${seat} 买入 1 个（${BUY_IN}）入座`);
  }

  // 自动过牌/跟注，让手牌能打完
  for (const socket of [sockA, sockB]) {
    socket.on('game:action_request', (p) => {
      const action = p.legalActions?.includes('check')
        ? { type: 'check' }
        : p.legalActions?.includes('call')
          ? { type: 'call' }
          : { type: 'fold' };
      socket.emit('game:action', { tableId: TABLE_ID, handId: p.handId, expectedVersion: p.version, action }, () => {});
    });
  }

  for (const socket of [sockA, sockB]) {
    await new Promise((r) => socket.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  }
  await waitFor(() => latest.a?.hand && !latest.a.hand.settled, 8000, '手牌开始');
  check(true, '手牌进行中');

  // 手牌中买入 1 个 → pending，不会立刻计入 buyInTotal/筹码
  const pendingBuy = await new Promise((r) => sockA.emit('table:rebuy', { tableId: TABLE_ID, units: 1 }, r));
  check(pendingBuy.ok === true && pendingBuy.pending === true, '手牌中买入返回 pending');
  check(pendingBuy.applyAt === 'hand_end', '返回 applyAt=hand_end');
  const pendingSeat = latest.a.seats.find((s) => s.seat === 0);
  check(pendingSeat?.pendingBuyIn === BUY_IN, '快照里出现 pendingBuyIn');
  check(pendingSeat?.buyInTotal === BUY_IN, '手牌中买入没有立刻计入累计买入');

  // 等本手结算 → 补码自动生效（自动 check/call 最多 30 秒）
  await waitFor(
    () => {
      const seat = latest.a?.seats.find((s) => s.seat === 0);
      return seat && seat.pendingBuyIn === 0 && seat.buyInTotal >= BUY_IN * 2;
    },
    30000,
    '结算后补码生效',
  );
  const afterSettle = latest.a.seats.find((s) => s.seat === 0);
  check(afterSettle.buyInTotal === BUY_IN * 2, '结算后累计买入变成 2 个');
  check(afterSettle.pendingBuyIn === 0, 'pendingBuyIn 已清零');

  // 两手之间（没有手牌）买入 1 个 → 立刻生效
  await waitFor(() => !latest.a?.hand || latest.a.hand.settled, 5000, '手牌结束');
  const immediate = await new Promise((r) => sockA.emit('table:rebuy', { tableId: TABLE_ID, units: 1 }, r));
  check(immediate.ok === true && immediate.pending === false, '两手之间买入立即生效');
  const afterImmediate = latest.a.seats.find((s) => s.seat === 0);
  check(afterImmediate.buyInTotal === BUY_IN * 3, '累计买入变成 3 个');

  // 超过 50 个买入被拒
  const tooMany = await new Promise((r) => sockA.emit('table:rebuy', { tableId: TABLE_ID, units: 50 }, r));
  check(tooMany.ok === false && tooMany.code === 'BUY_IN_LIMIT', '超过 50 个买入被拒（BUY_IN_LIMIT）');

  sockA.close();
  sockB.close();
  console.log(`\n[补码冒烟] 全部通过：${passed} 项断言`);
}

main().catch((err) => {
  console.error(`\n[补码冒烟] 失败：${err.message}`);
  process.exit(1);
});
