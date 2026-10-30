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
/** 每手结算到下一手 hand:start 的间隔（毫秒）；用来守住"结算动画时间" */
const gaps = [];
/** game:result 里的座位信息：结算框要靠它画"谁赢谁输" */
const resultSeatInfo = [];

function setupClient(socket, name, mySeat) {
  let myVersion = 0;
  let lastResultAt = 0;

  socket.on('table:snapshot', (s) => {
    if (s.hand) myVersion = s.hand.version;
    const hand = s.hand;
    const line = hand
      ? `street=${hand.street} pot=${hand.pot} turn=${hand.currentTurnSeat} board=[${hand.board.join(' ')}] myHole=${hand.seats.find((x) => x.seat === mySeat)?.holeCards.join(' ') ?? ''}`
      : 'no-hand';
    console.log(`[${name}] snapshot ${line}`);
  });

  socket.on('hand:start', (p) => {
    if (lastResultAt) {
      gaps.push(Date.now() - lastResultAt);
      console.log(`[${name}] hand:start ${p.handId} (距上次结算 ${gaps[gaps.length - 1]}ms)`);
      lastResultAt = 0;
    } else {
      console.log(`[${name}] hand:start ${p.handId}`);
    }
  });

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

  socket.on('game:result', (p) => {
    lastResultAt = Date.now();
    // 结算框需要座位信息（昵称/投入/弃牌）；且不能带别人的手牌
    const seats = Array.isArray(p.seats) ? p.seats : [];
    resultSeatInfo.push({ count: seats.length, leaks: seats.some((s) => 'holeCards' in s) });
    console.log(`[${name}] RESULT ${JSON.stringify(p.result.payouts)} seats=${seats.length}`);
  });
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

  await new Promise((r) => alice.emit('table:sit', { tableId: TABLE_ID, seat: 0, buyIn: 2000 }, r));
  await new Promise((r) => bob.emit('table:sit', { tableId: TABLE_ID, seat: 1, buyIn: 2000 }, r));
  await delay(200);

  await new Promise((r) => alice.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));
  await new Promise((r) => bob.emit('table:ready', { tableId: TABLE_ID, ready: true }, r));

  await delay(15000);

  console.log(`\n结算 → 下一手 间隔：${gaps.length ? gaps.join('ms / ') + 'ms' : '（没观察到连续两手）'}`);
  if (!gaps.length) {
    console.error('FAIL 没观察到"结算后开下一手"，无法确认结算动画时间');
    process.exit(1);
  }
  const tooFast = gaps.filter((g) => g < 1500);
  if (tooFast.length) {
    console.error(`FAIL 结算后 ${tooFast.join(',')}ms 就开下一手，前端来不及放结算动画（SETTLE_HOLD_MS?）`);
    process.exit(1);
  }
  console.log('PASS 结算后停顿足够放结算动画');

  // 结算框靠 game:result.seats 画"谁赢谁输"，缺了它联机就没有结算框
  const missingSeats = resultSeatInfo.filter((r) => r.count < 2);
  if (missingSeats.length) {
    console.error(`FAIL game:result 缺少座位信息（${missingSeats.length} 手），结算框画不出来`);
    process.exit(1);
  }
  if (resultSeatInfo.some((r) => r.leaks)) {
    console.error('FAIL game:result.seats 里带了 holeCards，会泄露没亮牌的玩家手牌');
    process.exit(1);
  }
  console.log(`PASS 每手结算都带了座位信息（${resultSeatInfo.length} 手）`);

  alice.close();
  bob.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});