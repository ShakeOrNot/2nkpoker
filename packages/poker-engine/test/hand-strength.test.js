import { describe, it, expect } from 'vitest';
import { evaluate7, handValueToStrength, compareHands } from '../src/index.js';

const h = (s) => s.split(' ');
const board = h('Ah Kd 7c 4s 2h');

describe('handValueToStrength - 跑马多 board 比大小', () => {
  it('三条必须大于高牌（不同 tiebreakers 长度不能影响牌型优先级）', () => {
    const trips = evaluate7([...h('Ac Ad'), ...board]);
    const high = evaluate7([...h('Qc Jd'), ...board]);
    expect(trips.category).toBe(3); // THREE_OF_A_KIND
    expect(high.category).toBe(0); // HIGH_CARD
    expect(handValueToStrength(trips)).toBeGreaterThan(handValueToStrength(high));
    expect(compareHands(trips, high)).toBeGreaterThan(0);
  });

  it('一对大于高牌，两对大于一对', () => {
    const pair = evaluate7([...h('Ac 9d'), ...board]);
    const twoPair = evaluate7([...h('Ac Kc'), ...board]);
    const high = evaluate7([...h('Qc Jd'), ...board]);
    expect(handValueToStrength(pair)).toBeGreaterThan(handValueToStrength(high));
    expect(handValueToStrength(twoPair)).toBeGreaterThan(handValueToStrength(pair));
  });

  it('同牌型按固定 5 位踢脚比较', () => {
    const a = evaluate7([...h('Ac Qd'), ...board]);
    const b = evaluate7([...h('Ac Jd'), ...board]);
    expect(handValueToStrength(a)).toBeGreaterThan(handValueToStrength(b));
  });
});
