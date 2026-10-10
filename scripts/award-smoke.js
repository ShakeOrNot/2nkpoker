import { buildPots, totalPot, awardPots } from '@2nkpoker/poker-engine';

function show(title, contributions, strengths) {
  const pots = buildPots(contributions);
  const map = new Map(Object.entries(strengths).map(([k, v]) => [Number(k), v]));
  const w = awardPots(pots, map);
  console.log(`\n=== ${title} ===`);
  console.log('池子:');
  for (const [i, p] of pots.entries()) {
    console.log(`  池${i}: amount=${p.amount}, seats=[${p.eligibleSeats.join(',')}]`);
  }
  console.log('赢家:');
  for (const [seat, chips] of [...w.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  seat ${seat}: +${chips}`);
  }
  console.log(`总额: ${totalPot(pots)}, 发出: ${[...w.values()].reduce((a, b) => a + b, 0)}`);
}

// 场景 1：A all-in 100，B/C 各 200，A 牌最强
show('A all-in 100, B/C 各 200, A 牌最强', [
  { seat: 0, amount: 100, folded: false },
  { seat: 1, amount: 200, folded: false },
  { seat: 2, amount: 200, folded: false },
], { 0: 900, 1: 500, 2: 100 });

// 场景 2：B 牌最强
show('A all-in 100, B/C 各 200, B 牌最强', [
  { seat: 0, amount: 100, folded: false },
  { seat: 1, amount: 200, folded: false },
  { seat: 2, amount: 200, folded: false },
], { 0: 100, 1: 900, 2: 500 });

// 场景 3：A/B 并列最强
show('A/B 并列最强', [
  { seat: 0, amount: 100, folded: false },
  { seat: 1, amount: 100, folded: false },
  { seat: 2, amount: 100, folded: false },
], { 0: 500, 1: 500, 2: 100 });

// 场景 4：4 人 all-in 不同金额，牌力由弱到强 0<1<2<3
show('4 人 100/200/300/400，牌力 3 最强', [
  { seat: 0, amount: 100, folded: false },
  { seat: 1, amount: 200, folded: false },
  { seat: 2, amount: 300, folded: false },
  { seat: 3, amount: 400, folded: false },
], { 0: 100, 1: 200, 2: 300, 3: 400 });