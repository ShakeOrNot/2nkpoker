import {
  seatPositions, preflopOrder, postflopOrder, positionOf,
} from '@2nkpoker/poker-engine';

const btn = 0;
const n = 6;

console.log('=== buttonSeat =', btn, ', numPlayers =', n, '===');
console.log('座位 -> 位置:');
for (const [seat, pos] of seatPositions(btn, n)) {
  console.log(`  seat ${seat}: ${pos}`);
}
console.log('翻前顺序:', preflopOrder(btn, n).map((s) => `${s}(${positionOf(s, btn, n)})`).join(' -> '));
console.log('翻后顺序:', postflopOrder(btn, n).map((s) => `${s}(${positionOf(s, btn, n)})`).join(' -> '));