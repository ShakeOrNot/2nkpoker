import { potPercent, formatChips, formatDuration } from '@2nkpoker/shared';

console.log('pot = 200');
for (const amt of [50, 100, 133, 200, 240]) {
  console.log(`  ${amt} -> ${potPercent(amt, 200)}`);
}

console.log('\nchips:');
for (const n of [50, 999, 1000, 1200, 12500, 99999, 100000, 1500000]) {
  console.log(`  ${n} -> ${formatChips(n)}`);
}

console.log('\nduration:');
for (const ms of [1000, 30000, 60000, 300000, 3600000]) {
  console.log(`  ${ms}ms -> ${formatDuration(ms)}`);
}