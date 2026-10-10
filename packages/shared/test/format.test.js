import { describe, it, expect } from 'vitest';
import { potPercent, formatChips, formatDuration } from '../src/index.js';

describe('potPercent', () => {
  it('50/100 = 50%', () => expect(potPercent(50, 100)).toBe('50%'));
  it('120/100 = 120%', () => expect(potPercent(120, 100)).toBe('120%'));
  it('33/100 四舍五入为 33%', () => expect(potPercent(33, 100)).toBe('33%'));
  it('66.67/100 四舍五入为 67%', () => expect(potPercent(66.67, 100)).toBe('67%'));
  it('pot = 0 返回 0%', () => expect(potPercent(100, 0)).toBe('0%'));
  it('pot 为负返回 0%', () => expect(potPercent(100, -5)).toBe('0%'));
  it('amount 非数字返回 0%', () => expect(potPercent(NaN, 100)).toBe('0%'));
});

describe('formatChips', () => {
  it('999 -> "999"', () => expect(formatChips(999)).toBe('999'));
  it('1000 -> "1k"', () => expect(formatChips(1000)).toBe('1k'));
  it('1200 -> "1.2k"', () => expect(formatChips(1200)).toBe('1.2k'));
  it('12500 -> "12.5k"', () => expect(formatChips(12500)).toBe('12.5k'));
  it('100000 -> "100k"', () => expect(formatChips(100000)).toBe('100k'));
  it('1500000 -> "1.5m"', () => expect(formatChips(1500000)).toBe('1.5m'));
  it('负数 -> "0"', () => expect(formatChips(-5)).toBe('0'));
});

describe('formatDuration', () => {
  it('5000ms -> "5s"', () => expect(formatDuration(5000)).toBe('5s'));
  it('60000ms -> "1m"', () => expect(formatDuration(60000)).toBe('1m'));
  it('3600000ms -> "1h"', () => expect(formatDuration(3600000)).toBe('1h'));
  it('负数 -> "0s"', () => expect(formatDuration(-1)).toBe('0s'));
});