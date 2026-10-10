import { buildPots, totalPot } from '@2nkpoker/poker-engine';

const cases = [
  {
    name: '4 人 A=100 B=200 C=300 D=400',
    rows: [
      { seat: 0, amount: 100, folded: false },
      { seat: 1, amount: 200, folded: false },
      { seat: 2, amount: 300, folded: false },
      { seat: 3, amount: 400, folded: false },
    ],
  },
  {
    name: '5 人 50/100/150/200/250',
    rows: [
      { seat: 0, amount: 50,  folded: false },
      { seat: 1, amount: 100, folded: false },
      { seat: 2, amount: 150, folded: false },
      { seat: 3, amount: 200, folded: false },
      { seat: 4, amount: 250, folded: false },
    ],
  },
  {
    name: '6 人 10/20/30/40/50/60',
    rows: [
      { seat: 0, amount: 10, folded: false },
      { seat: 1, amount: 20, folded: false },
      { seat: 2, amount: 30, folded: false },
      { seat: 3, amount: 40, folded: false },
      { seat: 4, amount: 50, folded: false },
      { seat: 5, amount: 60, folded: false },
    ],
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  const pots = buildPots(c.rows);
  console.log(`层数: ${pots.length}, 总额: ${totalPot(pots)}`);
  for (let i = 0; i < pots.length; i++) {
    console.log(`  池${i}: amount=${pots[i].amount}, eligibleSeats=[${pots[i].eligibleSeats.join(',')}]`);
  }
}