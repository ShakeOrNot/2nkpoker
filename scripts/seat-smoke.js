/**
 * 换座 / 离桌冒烟：
 *  1. 入座后不用先离座就能换座位，且筹码不变
 *  2. 手牌进行中离桌 → 服务端标记 leaving、当场弃牌 → 本手结算后座位被清掉
 *  3. 离桌后可以重新进房入座
 *
 * 跑法（需要后端在跑）：
 *   node scripts/seat-smoke.js
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const BASE = process.env.GAME_URL ?? 'http://localhost:3001';
const TAG = Date.now().toString(36);
const TABLE_ID = `seat_${TAG}`;
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

/** 轮到我就弃牌（只为把牌局推进到结算） */
function makeAutoFolder(socket, tableId, seat, errors) {
  const sent = new Set();
  socket.on('table:snapshot', (snapshot) => {
    const h = snapshot?.hand;
    if (!h || h.settled || h.currentTurnSeat !== seat) return;
    const key = `${h.handId}:${h.version}`;
    if (sent.has(key)) return;
    sent.add(key);
    socket.emit(
      'game:action',
      { tableId, handId: h.handId, expectedVersion: h.version, action: { type: 'fold' } },
      (res) => {
        if (res?.ok) return;
        sent.delete(key);
        if (!['STATE_OUTDATED', 'NOT_YOUR_TURN'].includes(res?.code)) errors.push({ seat, res });
      },
    );
  });
}

async function main() {
  const users = { a: `sa_${TAG}`, b: `sb_${TAG}`, c: `sc_${TAG}` };
  const a = connect(users.a, 'Alice');
  const b = connect(users.b, 'Bob');
  const c = connect(users.c, 'Carol');
  const sockets = { a, b, c };
  const errors = [];
  for (const s of [a, b, c]) s.on('error', (e) => errors.push(e));

  await Promise.all([connectAndWait(a), connectAndWait(b), connectAndWait(c)]);
  for (const s of [a, b, c]) await emitAck(s, 'table:join', { tableId: TABLE_ID });

  await emitAck(a, 'table:sit', { tableId: TABLE_ID, seat: 0, buyIn: BUY_IN });
  await emitAck(b, 'table:sit', { tableId: TABLE_ID, seat: 1, buyIn: BUY_IN });
  await emitAck(c, 'table:sit', { tableId: TABLE_ID, seat: 2, buyIn: BUY_IN });

  /* ---------- 1. 不用离座直接换座 ---------- */
  const movedSnap = waitFor(b, 'table:snapshot', (s) => s.seats.some((x) => x.userId === users.a && x.seat === 3));
  const moved = await emitAck(a, 'table:sit', { tableId: TABLE_ID, seat: 3, buyIn: BUY_IN });
  check(moved.ok === true && moved.moved === true && moved.seat === 3, `换座 ack（${JSON.stringify(moved)}）`);

  const afterMove = await movedSnap;
  const aSeat = afterMove.seats.find((x) => x.userId === users.a);
  check(aSeat.seat === 3, 'Alice 已经在座位 3 上');
  check(aSeat.chips === BUY_IN, `换座后筹码不变（${aSeat.chips}）`);
  check(!afterMove.seats.find((x) => x.seat === 0)?.userId, '原来的 0 号座位空出来了');

  /* ---------- 2. 手牌进行中离桌 ---------- */
  const handStart = waitFor(a, 'hand:start');
  await emitAck(a, 'table:ready', { tableId: TABLE_ID, ready: true });
  await emitAck(b, 'table:ready', { tableId: TABLE_ID, ready: true });
  await emitAck(c, 'table:ready', { tableId: TABLE_ID, ready: true });
  const started = await handStart;
  console.log(`  第一手开始：${started.handId}`);

  const stateSnap = await emitAck(a, 'table:request_state', { tableId: TABLE_ID });
  const turnSeat = stateSnap.snapshot.hand.currentTurnSeat;
  const seatsByKey = { a: aSeat.seat, b: 1, c: 2 };
  const leaverKey = ['a', 'b', 'c'].find((k) => seatsByKey[k] === turnSeat);
  const leaver = sockets[leaverKey];
  const leaverId = users[leaverKey];
  const others = ['a', 'b', 'c'].filter((k) => k !== leaverKey).map((k) => ({ key: k, socket: sockets[k] }));
  for (const { key, socket } of others) makeAutoFolder(socket, TABLE_ID, seatsByKey[key], errors);

  // 离桌后座位上应该出现 leaving 标记（还在手里）
  const leavingSeen = waitFor(
    others[0].socket,
    'table:snapshot',
    (s) => s.seats.some((x) => x.userId === leaverId && x.leaving === true),
    6000,
  );
  const resultP = waitFor(a, 'game:result', null, 15000);
  const leaveAck = await emitAck(leaver, 'table:stand', { tableId: TABLE_ID });
  check(leaveAck.ok === true && leaveAck.pending === true, `手牌中离桌 = 本手结束后生效（${JSON.stringify(leaveAck)}）`);
  await leavingSeen;
  check(true, '离桌者座位上出现 leaving 标记');

  await resultP;
  // 结算后座位被清掉，桌上只剩另外两个人
  const afterSettle = await waitFor(
    others[0].socket,
    'table:snapshot',
    (s) => !s.hand && s.seats.filter((x) => x.userId).length === 2 && !s.seats.some((x) => x.userId === leaverId),
    8000,
  );
  check(
    afterSettle.seats.filter((x) => x.userId).length === 2,
    '本手结束后离桌者的座位被清掉，桌上只剩 2 人',
  );

  // 空出来的座位号（挑一个空的重新坐下）
  const freedSeat = afterSettle.seats.find((x) => !x.userId).seat;

  /* ---------- 3. 离桌后可以重新进入 ---------- */
  // 结算后有 SETTLE_HOLD_MS 的停顿：这期间点"坐下"直接入座；停顿结束、下一手开了则进排队。
  // 两种都是正常路径，这里只要求"不报错、能回到桌上"。
  const reSit = await emitAck(leaver, 'table:sit', { tableId: TABLE_ID, seat: freedSeat, buyIn: BUY_IN });
  check(
    reSit.ok === true || reSit.queued === true,
    `离桌后可以重新入座（直接入座或排队：${JSON.stringify(reSit)}）`,
  );

  // 取消排队 + 退订房间后，还能重新进一张空桌正常入座
  await emitAck(leaver, 'table:stand', { tableId: TABLE_ID });
  await emitAck(leaver, 'table:leave', { tableId: TABLE_ID });
  const TABLE2 = `seat2_${TAG}`;
  await emitAck(leaver, 'table:join', { tableId: TABLE2 });
  const sit2 = await emitAck(leaver, 'table:sit', { tableId: TABLE2, seat: 4, buyIn: BUY_IN });
  check(sit2.ok === true && sit2.seat === 4, `离桌后重新进房可以正常入座（${JSON.stringify(sit2)}）`);

  check(errors.length === 0, `全程没有错误事件（${JSON.stringify(errors)}）`);
  console.log('\n换座/离桌冒烟通过：换座不改筹码、手牌中离桌本手后生效、离桌后可重新入座');

  for (const s of [a, b, c]) {
    try {
      await emitAck(s, 'table:stand', { tableId: TABLE_ID }, 2000);
    } catch {
      /* 忽略 */
    }
    s.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n换座/离桌冒烟失败：${err.message}`);
  process.exit(1);
});
