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
const TABLE_ID = 'timeout-smoke';

async function main() {
  const alice = connect('alice', 'Alice');
  const bob = connect('bob', 'Bob');
  await Promise.all([
    new Promise((r) => alice.on('connect', r)),
    new Promise((r) => bob.on('connect', r)),
  ]);

  alice.on('game:action_request', (p) => console.log('[A] got action_request, IGNORING it'));
  bob.on('game:action_request', (p) => {
    console.log('[B] got action_request, will fold/call');
    const action = p.legalActions.includes('check')
      ? { type: 'check' }
      : { type: 'call' };
    bob.emit('game:action', { tableId: TABLE_ID, handId: p.handId, expectedVersion: 0, action }, () => {});
  });
  alice.on('game:action_applied', (p) => {
    if (p.timeout) console.log(`[A] saw TIMEOUT action by seat ${p.seat}: ${JSON.stringify(p.action)}`);
    else console.log(`[A] saw action by seat ${p.seat}: ${JSON.stringify(p.action)}`);
  });
  bob.on('game:action_applied', (p) => {
    if (p.timeout) console.log(`[B] saw TIMEOUT action by seat ${p.seat}: ${JSON.stringify(p.action)}`);
  });

  alice.emit('table:join', { tableId: TABLE_ID });
  bob.emit('table:join', { tableId: TABLE_ID });
  await delay(300);

  await new Promise((r) => alice.emit('table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 2000 }, r));
  await new Promise((r) => bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 2000 }, r));
  await delay(300);

  await new Promise((r) => alice.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  await new Promise((r) => bob.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));

  console.log('waiting 35s to observe timeout...');
  await delay(35000);
  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });