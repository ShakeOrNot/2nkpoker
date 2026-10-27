/**
 * 排队入座冒烟：验证"手牌进行中点坐下 → 排队 → 本手结束自动入座 → 能准备并参局"。
 *
 * 背景：table:sit 的排队分支以前只把用户塞进 sitQueue，没有 socket.join 房间、
 * 也没写 socket.data.tableId，结果排队者收不到任何快照、入座后也拿不到自己的手牌，
 * 整桌会卡在一个永远不会 ready 的幽灵座位上。
 *
 * 跑法（需要后端在 3001 上）：
 *   node scripts/queue-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const TABLE_ID = `queue_${TAG}`;
const SECRET = process.env.JWT_SECRET ?? 'change_me';
const ISSUER = process.env.JWT_ISSUER ?? '2nkpoker';
const AUDIENCE = process.env.JWT_AUDIENCE ?? '2nkpoker-web';
const BUY_IN = 1000;

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

/** 轮询等到某个条件成立（避免"先发生、后监听"的竞态） */
function waitUntil(predicate, timeout = 8000, interval = 50) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('等待条件超时'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** 自动过牌/跟注，让手牌尽快打完 */
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
        sent.delete(key);
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
  const users = {
    a: `qa_${TAG}`,
    b: `qb_${TAG}`,
    c: `qc_${TAG}`,
  };
  const a = connect(users.a, 'Alice');
  const b = connect(users.b, 'Bob');
  const c = connect(users.c, 'Carol');
  const errors = [];
  for (const s of [a, b, c]) s.on('error', (e) => errors.push(e));

  await Promise.all([connectAndWait(a), connectAndWait(b), connectAndWait(c)]);
  for (const s of [a, b, c]) await emitAck(s, 'table:join', { tableId: TABLE_ID });

  const sitA = await emitAck(a, 'table:sit', { tableId: TABLE_ID, seat: 0, buyIn: BUY_IN });
  const sitB = await emitAck(b, 'table:sit', { tableId: TABLE_ID, seat: 1, buyIn: BUY_IN });
  check(sitA.ok && sitB.ok, 'Alice / Bob 已入座 0、1');

  const firstHand = waitFor(c, 'hand:start');
  await emitAck(a, 'table:ready', { tableId: TABLE_ID, ready: true });
  await emitAck(b, 'table:ready', { tableId: TABLE_ID, ready: true });
  const started = await firstHand;
  check(Boolean(started.handId), `第一手开始：${started.handId}`);

  // 关键：手牌进行中让 Carol 坐下 → 应该进入排队，并且立刻收到房间快照（能观战）
  const cSnapshot = waitFor(c, 'table:snapshot', (s) => s.hand && s.hand.handId === started.handId);
  const sitC = await emitAck(c, 'table:sit', { tableId: TABLE_ID, seat: 3, buyIn: BUY_IN });
  check(sitC.ok === false && sitC.queued === true, `Carol 入座被排进队列（${JSON.stringify(sitC)}）`);

  const liveSnap = await cSnapshot;
  check(true, '排队中的 Carol 能收到进行中的房间快照（可以观战）');
  const leaks = (liveSnap.hand.seats ?? []).filter((s) => (s.holeCards ?? []).length > 0);
  check(leaks.length === 0, '旁观者看不到任何人的手牌');

  // Alice / Bob 自动打完这一手
  const actA = makeAutoPlayer(a, TABLE_ID, 0, errors);
  const actB = makeAutoPlayer(b, TABLE_ID, 1, errors);
  const aState = await emitAck(a, 'table:request_state', { tableId: TABLE_ID });
  actA(aState.snapshot);
  const bState = await emitAck(b, 'table:request_state', { tableId: TABLE_ID });
  actB(bState.snapshot);

  // Carol 应该在结算后自动被拉上座位（快照里 her 座位有 chips，且 hand 为 null）
  const seatedSnap = await waitFor(
    c,
    'table:snapshot',
    (s) => !s.hand && s.seats.some((x) => x.userId === users.c && x.chips === BUY_IN),
    10000,
  );
  const carolSeat = seatedSnap.seats.find((x) => x.userId === users.c).seat;
  check(carolSeat === 3, `Carol 自动入座到座位 ${carolSeat}`);
  check(seatedSnap.seats.find((x) => x.userId === users.c).ready === false, '补位后是未准备状态');

  // Carol 准备 → 应能在下一手里真正参局（拿到自己的手牌、收到行动请求）
  // 行动请求可能在她准备后瞬间就发出，所以先挂监听再点准备，避免竞态
  const cRequests = [];
  c.on('game:action_request', (p) => cRequests.push(p));
  const secondHand = waitFor(c, 'hand:start');
  const cReady = await emitAck(c, 'table:ready', { tableId: TABLE_ID, ready: true });
  check(cReady.ok, 'Carol 准备成功');
  const started2 = await secondHand;
  check(started2.handId !== started.handId, `第二手开始：${started2.handId}`);

  const cState = await emitAck(c, 'table:request_state', { tableId: TABLE_ID });
  const myCards = cState.snapshot?.hand?.seats?.find((x) => x.userId === users.c)?.holeCards ?? [];
  check(myCards.length === 2, `Carol 能拿到自己的两张手牌（${myCards.join(' ')}）`);

  await waitUntil(() => cRequests.length > 0, 8000);
  const actionReq = cRequests[0];
  check(
    actionReq.seat === carolSeat,
    `Carol 收到行动请求（座位 ${actionReq.seat}，可选 ${actionReq.legalActions.join('/')}）`,
  );

  check(errors.length === 0, `全程没有错误事件（${JSON.stringify(errors)}）`);
  console.log('\n排队入座冒烟通过：排队 → 观战 → 自动入座 → 准备 → 参局');

  for (const s of [a, b, c]) {
    try {
      await emitAck(s, 'table:stand', { tableId: TABLE_ID }, 2000);
    } catch {
      /* 牌局进行中站不起来就算了，进程直接退出 */
    }
    s.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n排队入座冒烟失败：${err.message}`);
  process.exit(1);
});
