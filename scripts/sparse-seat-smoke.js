/**
 * 稀疏座位冒烟：验证"座位号不连续"的牌桌能真正打完一手。
 *
 * 背景：startHand 曾经要求座位号必须是 0..n-1 连续，
 * 但真实桌子是 6 个固定座位——有人输光离座后就会留下空洞，
 * 下一手直接抛 "seats must be 0..n-1 consecutive"。
 *
 * 跑法（需要后端在 3001 上）：
 *   node scripts/sparse-seat-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

// 配置统一在仓库根的 .env（后端也读这一份），不需要单独指定路径。
const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
// 每次跑用独立的房号 + userId：上一手结束后服务端会自动开下一手，
// 这时 table:stand 会被 HAND_IN_PROGRESS 挡下来，玩家可能残留在桌上。
const TAG = Date.now().toString(36);
const TABLE_ID = `sparse_${TAG}`;
const SECRET = process.env.JWT_SECRET ?? 'change_me';
const ISSUER = process.env.JWT_ISSUER ?? '2nkpoker';
const AUDIENCE = process.env.JWT_AUDIENCE ?? '2nkpoker-web';

function connect(sub, nickname) {
  const token = jwt.sign({ nickname, role: 'user' }, SECRET, {
    subject: sub,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: '15m',
  });
  return io(`${BASE}/game`, { auth: { token }, transports: ['websocket'] });
}

function emitAck(socket, event, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), timeout);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor(socket, event, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时`));
    }, timeout);
    function handler(payload) {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

function connectAndWait(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`连接失败：${err.message}`));
    });
  });
}

function check(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

/** 只在"轮到我了且这个 version 还没发过动作"时出手；失败就允许重试 */
function makeAutoPlayer(socket, tableId, seat, errors) {
  const sent = new Set();

  const maybeAct = (snapshot) => {
    const h = snapshot?.hand;
    if (!h || h.settled || h.currentTurnSeat !== seat) return;
    const key = `${h.handId}:${h.version}`;
    if (sent.has(key)) return;
    sent.add(key);

    const me = h.seats.find((x) => x.seat === seat);
    const toCall = h.currentBet - me.betThisStreet;
    const action = toCall > 0 ? { type: 'call' } : { type: 'check' };

    socket.emit(
      'game:action',
      { tableId, handId: h.handId, expectedVersion: h.version, action },
      (res) => {
        if (res?.ok) return;
        sent.delete(key); // 版本过期之类：等下一份快照再试
        // STATE_OUTDATED / NOT_YOUR_TURN 属于正常竞态，不算错误
        if (!['STATE_OUTDATED', 'NOT_YOUR_TURN'].includes(res?.code)) {
          errors.push({ seat, action, res });
        }
      },
    );
  };

  socket.on('table:snapshot', maybeAct);
  return maybeAct;
}

async function main() {
  const alice = connect(`sparse_a_${TAG}`, 'Alice');
  const bob = connect(`sparse_b_${TAG}`, 'Bob');
  const errors = [];
  for (const s of [alice, bob]) s.on('error', (e) => errors.push(e));

  await Promise.all([connectAndWait(alice), connectAndWait(bob)]);
  console.log('两个客户端已连接');

  await emitAck(alice, 'table:join', { tableId: TABLE_ID });
  await emitAck(bob, 'table:join', { tableId: TABLE_ID });

  // 关键：故意坐在 0 和 3 —— 中间隔着两个空座位
  const aSit = await emitAck(alice, 'table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 1000 });
  const bSit = await emitAck(bob, 'table:sit', { tableId: TABLE_ID, seat: 3, buyIn: 1000 });
  check(aSit.ok && aSit.seat === 0, `Alice 入座 0（ack: ${JSON.stringify(aSit)}）`);
  check(bSit.ok && bSit.seat === 3, `Bob 入座 3（ack: ${JSON.stringify(bSit)}）`);

  const handStart = waitFor(alice, 'hand:start');
  const resultPromise = waitFor(alice, 'game:result', null, 15000);
  const aReady = await emitAck(alice, 'table:ready', { tableId: TABLE_ID, ready: true });
  const bReady = await emitAck(bob, 'table:ready', { tableId: TABLE_ID, ready: true });
  check(aReady.ok && bReady.ok, '两人都准备成功');

  const started = await handStart;
  console.log(`  开局成功：handId=${started.handId}，按钮位=${started.buttonSeat}`);

  // 主动拉一份快照（顺带触发自动出牌）
  const aState = await emitAck(alice, 'table:request_state', { tableId: TABLE_ID });
  const hand = aState.snapshot?.hand;
  check(Boolean(hand), '桌上确实有进行中的手牌');

  const seatsInHand = hand.seats.map((s) => s.seat).sort((a, b) => a - b);
  check(
    JSON.stringify(seatsInHand) === '[0,3]',
    `引擎收到的座位是 [0,3]，不是连续座位（实际 ${JSON.stringify(seatsInHand)}）`,
  );
  check(hand.buttonSeat === 0, `按钮位落在真实座位 ${hand.buttonSeat}`);
  check(hand.seats.find((s) => s.seat === 0).betThisStreet === 10, '座位 0 下了小盲 10');
  check(hand.seats.find((s) => s.seat === 3).betThisStreet === 20, '座位 3 下了大盲 20');
  check(hand.currentTurnSeat === 0, '翻前从按钮位开始行动');

  const actAlice = makeAutoPlayer(alice, TABLE_ID, 0, errors);
  const actBob = makeAutoPlayer(bob, TABLE_ID, 3, errors);
  actAlice(aState.snapshot);
  const bState = await emitAck(bob, 'table:request_state', { tableId: TABLE_ID });
  actBob(bState.snapshot);

  const result = await resultPromise;
  const pots = result.result?.pots ?? [];
  const potTotal = pots.reduce((sum, p) => sum + p.amount, 0);
  const payoutTotal = Object.values(result.result?.payouts ?? {}).reduce((a, b) => a + b, 0);
  check(potTotal === 40, `底池 = 盲注 10 + 20 = 40（实际 ${potTotal}）`);
  check(payoutTotal === 40, `派彩总额 = 40（实际 ${payoutTotal}）`);
  check(Object.keys(result.result?.payouts ?? {}).length >= 1, '有赢家');
  check(errors.length === 0, `全程没有错误事件（${JSON.stringify(errors)}）`);

  console.log(`\n稀疏座位冒烟通过：座位 [0,3] 正常开局 → 打满四条街 → 结算（底池 ${potTotal}）`);

  for (const socket of [alice, bob]) {
    try {
      await emitAck(socket, 'table:stand', { tableId: TABLE_ID }, 2000);
    } catch {
      /* 已经开了下一手，站不起来也无所谓，直接退出 */
    }
    socket.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n稀疏座位冒烟失败：${err.message}`);
  process.exit(1);
});
