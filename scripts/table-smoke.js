import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;

function makeToken(sub, nickname) {
  return jwt.sign({ nickname, role: 'user' }, secret, {
    subject: sub, issuer, audience, expiresIn: '15m',
  });
}

function connect(sub, nickname) {
  const token = makeToken(sub, nickname);
  return io('http://localhost:3001/game', { auth: { token } });
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

  // Bob 坐下：等快照里出现 alice + bob
  const p2 = waitForSnapshot(bob, (s) => countOccupied(s) === 2);
  bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 1000 }, (res) => {
    console.log('bob sit ack:', res);
  });
  const snap2 = await p2;
  console.log('bob sat, seats:', snap2.seats
    .map((s) => `${s.seat}:${s.userId ?? '-'}`).join(', '));

  // Alice 也应该看到 2 人
  const snapAlice = await waitForSnapshot(alice, (s) => countOccupied(s) === 2);
  console.log('alice sees seats:', snapAlice.seats
    .map((s) => `${s.seat}:${s.userId ?? '-'}`).join(', '));

  // Bob 站起：Alice 观察，等回到 1 人
  const p3 = waitForSnapshot(alice, (s) => countOccupied(s) === 1);
  bob.emit('table:stand', { tableId: TABLE_ID }, (res) => {
    console.log('bob stand ack:', res);
  });
  await p3;
  console.log('bob stood up, alice sees 1 person');

  await new Promise((r) => setTimeout(r, 300));
  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
  // 清理：所有客户端站起
await new Promise((resolve) => {
  alice.emit('table:stand', { tableId: TABLE_ID }, () => resolve());
});
await new Promise((resolve) => {
  bob.emit('table:stand', { tableId: TABLE_ID }, () => resolve());
});
console.log('cleanup done');
});