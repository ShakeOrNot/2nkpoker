import { startHand, applyAction, toSnapshot } from '@2nkpoker/poker-engine';

function show(state) {
  const snap = toSnapshot(state, null);
  console.log(`--- street=${snap.street}, pot=${snap.pot}, turn=${snap.currentTurnSeat}, board=[${snap.board.join(' ')}] ---`);
  for (const s of snap.seats) {
    console.log(`  P${s.seat}(${s.nickname}): chips=${s.chips}, bet=${s.betThisStreet}, total=${s.totalCommitted}${s.folded ? ' [FOLD]' : ''}${s.allIn ? ' [ALLIN]' : ''}`);
  }
}

const players = [
  { seat: 0, nickname: 'A', chips: 1000 },
  { seat: 1, nickname: 'B', chips: 1000 },
  { seat: 2, nickname: 'C', chips: 1000 },
];

let { state } = startHand({
  handId: 'demo', buttonSeat: 0,
  smallBlind: 10, bigBlind: 20,
  players,
});

console.log('开局：');
show(state);

const seq = [
  [0, { type: 'raise', amount: 60 }],
  [1, { type: 'fold' }],
  [2, { type: 'call' }],
  [2, { type: 'check' }],
  [0, { type: 'bet', amount: 100 }],
  [2, { type: 'call' }],
  [2, { type: 'check' }],
  [0, { type: 'check' }],
  [2, { type: 'check' }],
  [0, { type: 'check' }],
];

for (const [seat, action] of seq) {
  console.log(`\n>>> P${seat} ${JSON.stringify(action)}`);
  const r = applyAction(state, seat, action);
  state = r.state;
  show(state);
}

console.log('\n结算结果：');
console.log(JSON.stringify(state.result, null, 2));