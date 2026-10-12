import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;

function connect(sub, nickname) {
  const token = jwt.sign({ nickname, role: 'user' }, secret, {
    subject: sub, issuer, audience, expiresIn: '15m',
  });
  return io('http://localhost:3001/game', { auth: { token } });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TABLE_ID = 'reconnect-smoke';

async function main() {
  const alice = connect('alice', 'Alice');
  let bob = connect('bob', 'Bob');

  await Promise.all([
    new Promise((r) => alice.on('connect', r)),
    new Promise((r) => bob.on('connect', r)),
  ]);

  alice.on('table:snapshot', (s) => {
    const seats = s.seats.map((x) => `${x.seat}:${x.userId ?? '-'}${x.userId && !x.connected ? '(off)' : ''}`).join(', ');
    console.log('[A] snapshot:', seats);
  });
  bob.on('connect', () => console.log('[B] connected'));

  alice.emit('table:join', { tableId: TABLE_ID });
  bob.emit('table:join', { tableId: TABLE_ID });
  await delay(300);

  await new Promise((r) => alice.emit('table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 1000 }, r));
  await new Promise((r) => bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 1000 }, r));
  await delay(300);

  console.log('--- bob 断开 ---');
  bob.close();
  await delay(1000);

  console.log('--- bob 重连（2 秒内） ---');
  bob = connect('bob', 'Bob');
  await Promise.all([new Promise((r) => bob.on('connect', r))]);
  bob.emit('table:join', { tableId: TABLE_ID }, (res) => {
    console.log('[B] rejoin:', JSON.stringify(res));
  });
  await delay(1500);

  console.log('--- bob 再次断开，等超过 grace 期 ---');
  bob.close();
  await delay(7000);

  console.log('--- alice 看看桌上还有谁 ---');
  alice.emit('table:join', { tableId: TABLE_ID });
  await delay(500);

  alice.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });