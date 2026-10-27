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
  return io(`${BASE}/game`, { auth: { token: makeToken(sub, nickname) } });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitEvent(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting ${event}`));
    }, timeout);
    function handler(data) {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    }
    socket.on(event, handler);
  });
}

const TABLE_ID = 'play-smoke';

function setupClient(socket, name, mySeat) {
  let myVersion = 0;

  socket.on('table:snapshot', (s) => {
    if (s.hand) myVersion = s.hand.version;
    const hand = s.hand;
    const line = hand
      ? `street=${hand.street} pot=${hand.pot} turn=${hand.currentTurnSeat} board=[${hand.board.join(' ')}] myHole=${hand.seats.find((x) => x.seat === mySeat)?.holeCards.join(' ') ?? ''}`
      : 'no-hand';
    console.log(`[${name}] snapshot ${line}`);
  });

  socket.on('hand:start', (p) => console.log(`[${name}] hand:start ${p.handId}`));

  socket.on('game:action_request', (p) => {
    console.log(`[${name}] MY TURN, legal=${p.legalActions.join(',')}`);
    const action = p.legalActions.includes('check')
      ? { type: 'check' }
      : p.legalActions.includes('call')
        ? { type: 'call' }
        : { type: 'fold' };
    console.log(`[${name}] sending ${JSON.stringify(action)}`);
    socket.emit('game:action', {
      tableId: TABLE_ID,
      handId: p.handId,
      expectedVersion: myVersion,
      action,
    }, (res) => console.log(`[${name}] action ack:`, res));
  });

  socket.on('game:result', (p) => console.log(`[${name}] RESULT ${JSON.stringify(p.result.payouts)}`));
  socket.on('game:action_applied', (p) => console.log(`[${name}] saw action by seat ${p.seat}`));
}

async function main() {
  const alice = connect('alice', 'Alice');
  const bob = connect('bob', 'Bob');

  await Promise.all([
    waitEvent(alice, 'connect'),
    waitEvent(bob, 'connect'),
  ]);

  setupClient(alice, 'A', 0);
  setupClient(bob, 'B', 1);

  alice.emit('table:join', { tableId: TABLE_ID });
  bob.emit('table:join', { tableId: TABLE_ID });
  await delay(200);

  await new Promise((r) => alice.emit('table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 1000 }, r));
  await new Promise((r) => bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 1000 }, r));
  await delay(200);

  await new Promise((r) => alice.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  await new Promise((r) => bob.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));

  await delay(15000);

  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});