import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;
// 默认本机 3001；换端口调试时用 GAME_URL 覆盖
const BASE = process.env.GAME_URL ?? 'http://localhost:3001';

function makeToken(sub, nickname) {
  return jwt.sign({ nickname, role: 'user' }, secret, {
    subject: sub, issuer, audience, expiresIn: '15m',
  });
}

function connect(sub, nickname) {
  const token = makeToken(sub, nickname);
  return io(`${BASE}/game`, { auth: { token } });
}

/** 等快照满足条件，捕获下一条就 resolve */
function waitForSnapshot(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('table:snapshot', handler);
      reject(new Error('timeout waiting matching snapshot'));
    }, timeout);
    function handler(snap) {
      if (predicate(snap)) {
        clearTimeout(timer);
        socket.off('table:snapshot', handler);
        resolve(snap);
      }
    }
    socket.on('table:snapshot', handler);
  });
}

function countOccupied(snap) {
  return snap.seats.filter((s) => s.userId).length;
}

const TABLE_ID = 'smoke-table';

async function main() {
  const alice = connect('alice', 'Alice');
  const bob = connect('bob', 'Bob');

  await Promise.all([
    new Promise((r) => alice.on('connect', r)),
    new Promise((r) => bob.on('connect', r)),
  ]);
  console.log('both connected');

  alice.emit('table:join', { tableId: TABLE_ID }, () => {});
  bob.emit('table:join', { tableId: TABLE_ID }, () => {});
  await new Promise((r) => setTimeout(r, 300));

  // Alice 坐下：等快照里出现 alice
  const p1 = waitForSnapshot(alice, (s) => countOccupied(s) === 1);
  alice.emit('table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 1000 }, (res) => {
    console.log('alice sit ack:', res);
  });
  await p1;
  console.log('alice sat');

  // Bob 坐下：Alice 和 Bob 都要看到 2 人。
  // 注意：两个监听都必须在 emit 之前注册，否则会漏掉这次广播（本地服务器太快）。
  const p2 = waitForSnapshot(bob, (s) => countOccupied(s) === 2);
  const pAlice = waitForSnapshot(alice, (s) => countOccupied(s) === 2);
  bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 1000 }, (res) => {
    console.log('bob sit ack:', res);
  });
  const snap2 = await p2;
  console.log('bob sat, seats:', snap2.seats
    .map((s) => `${s.seat}:${s.userId ?? '-'}`).join(', '));

  // Alice 也应该看到 2 人
  const snapAlice = await pAlice;
  console.log('alice sees seats:', snapAlice.seats
    .map((s) => `${s.seat}:${s.userId ?? '-'}`).join(', '));

  // Bob 站起：Alice 观察，等回到 1 人
  const p3 = waitForSnapshot(alice, (s) => countOccupied(s) === 1);
  bob.emit('table:stand', { tableId: TABLE_ID }, (res) => {
    console.log('bob stand ack:', res);
  });
  await p3;
  console.log('bob stood up, alice sees 1 person');

  /* ---------- 回归：离座≠退出房间，应该能马上重新入座 ---------- */

  // Bob 离座后仍在房间里：Alice 准备（会让服务端广播一次）时，Bob 也要能收到。
  // 旧实现里 table:stand 会顺带 socket.leave，这一步会超时。
  const pEcho = waitForSnapshot(bob, (s) => s.seats.some((x) => x.userId === 'alice' && x.ready));
  await new Promise((r) => alice.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  await pEcho;
  console.log('bob (stood up) still receives broadcasts — still in room');
  await new Promise((r) => alice.emit('table:ready', { tableId: TABLE_ID, ready: false }, r));

  // Bob 还在房间里（table:stand 不再退订），所以能收到广播并直接重新坐下
  const pReSit = waitForSnapshot(bob, (s) => countOccupied(s) === 2);
  bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 1000 }, (res) => {
    console.log('bob re-sit ack:', res);
  });
  const snapReSit = await pReSit;
  console.log('bob re-sat, seats:', snapReSit.seats
    .map((s) => `${s.seat}:${s.userId ?? '-'}`).join(', '));

  // 再离座（仍在房间），然后 table:leave 才真正退订
  const p3b = waitForSnapshot(alice, (s) => countOccupied(s) === 1);
  bob.emit('table:stand', { tableId: TABLE_ID }, () => {});
  await p3b;

  // 等自己离座那条在途快照落地，再开始数（否则会把旧快照算进来）
  await new Promise((r) => setTimeout(r, 400));
  let afterLeave = 0;
  bob.on('table:snapshot', () => { afterLeave += 1; });
  await new Promise((r) => bob.emit('table:leave', { tableId: TABLE_ID }, r));

  // Alice 站起来触发一次广播；Bob 已经退订，不应该再收到
  await new Promise((r) => alice.emit('table:stand', { tableId: TABLE_ID }, r));
  await new Promise((r) => setTimeout(r, 500));
  if (afterLeave !== 0) {
    console.error(`FAIL 退订房间后仍收到 ${afterLeave} 条快照`);
    process.exit(1);
  }
  console.log('bob left the room, no more snapshots');

  await new Promise((r) => setTimeout(r, 300));
  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});