/**
 * 跑马（all-in 摊牌）冒烟：
 *   两个真人坐下各 1 个买入 → 翻前直接 all-in → 发完公共牌
 *   → GET /auth/me/stats 应出现 luck.runoutCount >= 1、LuckyHands 里的 runout 项
 *   → 手牌分类/牌型权重也应有记录（categories 非空）
 *
 * 跑法：node scripts/allin-smoke.js  或  GAME_URL=http://localhost:3010 node scripts/allin-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const NICK_A = `ai_${TAG}_a`;
const NICK_B = `ai_${TAG}_b`;
const PASSWORD = 'poker-2026';
const TABLE_ID = `allin_${TAG}`;
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
  console.log(`[跑马冒烟] ${BASE}`);
  const regA = await api('/auth/register', { body: { nickname: NICK_A, password: PASSWORD } });
  const regB = await api('/auth/register', { body: { nickname: NICK_B, password: PASSWORD } });
  check(regA.ok && regB.ok, '注册两个测试账号');

  const [sockA, sockB] = [await connect(regA.accessToken), await connect(regB.accessToken)];
  for (const [socket, seat] of [
    [sockA, 0],
    [sockB, 1],
  ]) {
    socket.emit('table:join', { tableId: TABLE_ID }, () => {});
    await delay(80);
    const sit = await new Promise((r) => socket.emit('table:sit', { tableId: TABLE_ID, seat, buyIn: BUY_IN }, r));
    check(sit.ok === true, `座位 ${seat} 入座`);
  }

  /** @type {any} */
  let lastResult = null;
  /** @type {any} */
  let runoutOffer = null;
  /** @type {any} */
  let runoutAgreed = null;
  /** @type {any[]} */
  const streetEvents = [];
  /** @type {any[]} */
  const boardEvents = [];
  for (const socket of [sockA, sockB]) {
    socket.on('game:result', (p) => (lastResult = p));
    if (socket === sockA) socket.on('game:street', (p) => streetEvents.push(p));
    if (socket === sockA) socket.on('game:runout_board', (p) => boardEvents.push(p));
    socket.on('game:runout_offer', (p) => {
      runoutOffer = p;
      // 两边都同意跑 2 次
      socket.emit('game:runout_propose', { tableId: TABLE_ID, handId: p.handId, runs: 2 }, () => {});
    });
    socket.on('game:runout_agreed', (p) => {
      runoutAgreed = p;
    });
    socket.on('game:action_request', (p) => {
      const action = p.legalActions?.includes('all_in')
        ? { type: 'all_in' }
        : p.legalActions?.includes('call')
          ? { type: 'call' }
          : { type: 'check' };
      socket.emit('game:action', { tableId: TABLE_ID, handId: p.handId, expectedVersion: p.version, action }, () => {});
    });
  }

  for (const socket of [sockA, sockB]) {
    await new Promise((r) => socket.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  }

  const deadline = Date.now() + 30000;
  while (!lastResult && Date.now() < deadline) await delay(150);
  check(Boolean(lastResult), '一手 all-in 跑到结算');
  check(Boolean(runoutOffer) && runoutOffer.maxRuns >= 2, '收到跑马协商（最多次数 ≥2）');
  check(runoutAgreed?.runs === 2, '双方同意后按 2 次跑马');  const boards = lastResult?.result?.boards ?? [];
  check(boards.length === 2 && boards.every((b) => b.length === 5), '结算里有 2 个完整 board');
  check(
    boardEvents.length === 2 && boardEvents.every((b) => b.board.length === 5),
    '两个 board 是逐个亮出来的（有动画事件）',
  );
  const potTotal = (lastResult?.result?.pots ?? []).reduce((n, p) => n + (p.amount ?? 0), 0);
  const payoutTotal = Object.values(lastResult?.result?.payouts ?? {}).reduce((n, v) => n + Number(v), 0);
  check(payoutTotal === potTotal, '2 个 board 的派彩合计等于底池（筹码守恒）');

  const statA = await api('/auth/me/stats', { method: 'GET', token: regA.accessToken });
  check(statA.ok && statA.stats.hands >= 1, '战绩可读');
  check(statA.stats.luck?.runoutCount >= 1, '跑马记录 ≥1');
  const runout = statA.stats.luck?.lucky?.find((x) => x.kind === 'runout');
  check(Boolean(runout), 'LuckyHands 里有跑马项');
  check(typeof runout?.expected === 'number' && typeof runout?.deviation === 'number', '跑马项带期望收益/偏移');
  check(
    Object.keys(statA.stats.categories ?? {}).length >= 1,
    '牌型统计已记录（categories 非空）',
  );

  sockA.close();
  sockB.close();
  console.log(`\n[跑马冒烟] 全部通过：${passed} 项断言`);
}

main().catch((err) => {
  console.error(`\n[跑马冒烟] 失败：${err.message}`);
  process.exit(1);
});
