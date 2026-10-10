import { calcBetSize, BetFraction } from '@2nkpoker/poker-engine';

const scenario = (name, input) => {
  const r = calcBetSize(input);
  console.log(
    `${name.padEnd(28)} | type=${r.type.padEnd(5)} amount=${String(r.amount).padStart(5)}` +
    ` capped=${r.capped} isAllIn=${r.isAllIn}`
  );
};

console.log('--- 无人下注，pot=100 ---');
for (const f of [BetFraction.THIRD, BetFraction.HALF, BetFraction.TWO_THIRDS, BetFraction.FULL, BetFraction.ONE_POINT_TWO]) {
  scenario(`${(f * 100).toFixed(0)}% pot bet`, {
    pot: 100, fraction: f, currentBet: 0, myBetThisStreet: 0,
    chips: 10000, minRaise: 20, bigBlind: 20,
  });
}

console.log('\n--- 有人下注 50，pot=100 ---');
for (const f of [BetFraction.THIRD, BetFraction.HALF, BetFraction.TWO_THIRDS, BetFraction.FULL, BetFraction.ONE_POINT_TWO]) {
  scenario(`${(f * 100).toFixed(0)}% pot raise`, {
    pot: 100, fraction: f, currentBet: 50, myBetThisStreet: 0,
    chips: 10000, minRaise: 20, bigBlind: 20,
  });
}

console.log('\n--- 筹码不足场景 ---');
scenario('pot=1000, chips=300, 1pot', {
  pot: 1000, fraction: 1, currentBet: 0, myBetThisStreet: 0,
  chips: 300, minRaise: 20, bigBlind: 20,
});
scenario('pot=1000, 有人下100, chips=150', {
  pot: 1000, fraction: 1, currentBet: 100, myBetThisStreet: 0,
  chips: 150, minRaise: 20, bigBlind: 20,
});

console.log('\n--- 边界：目标低于 bigBlind ---');
scenario('pot=10, 1/3pot', {
  pot: 10, fraction: 1 / 3, currentBet: 0, myBetThisStreet: 0,
  chips: 10000, minRaise: 20, bigBlind: 20,
});