import { describe, it, expect } from 'vitest';
import {
  Position,
  positionsFor,
  positionOf,
  seatPositions,
  preflopOrder,
  postflopOrder,
} from '../src/index.js';

describe('positionsFor', () => {
  it('2 人', () => {
    expect(positionsFor(2)).toEqual(['BTN', 'BB']);
  });
  it('3 人', () => {
    expect(positionsFor(3)).toEqual(['BTN', 'SB', 'BB']);
  });
  it('4 人', () => {
    expect(positionsFor(4)).toEqual(['BTN', 'SB', 'BB', 'UTG']);
  });
  it('5 人', () => {
    expect(positionsFor(5)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'CO']);
  });
  it('6 人', () => {
    expect(positionsFor(6)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
  });
  it('1 人或 7 人报错', () => {
    expect(() => positionsFor(1)).toThrow();
    expect(() => positionsFor(7)).toThrow();
  });
});

describe('positionOf + seatPositions', () => {
  it('buttonSeat=0, 6 人', () => {
    expect(positionOf(0, 0, 6)).toBe('BTN');
    expect(positionOf(1, 0, 6)).toBe('SB');
    expect(positionOf(2, 0, 6)).toBe('BB');
    expect(positionOf(3, 0, 6)).toBe('UTG');
    expect(positionOf(4, 0, 6)).toBe('HJ');
    expect(positionOf(5, 0, 6)).toBe('CO');
  });

  it('buttonSeat=2, 6 人（按钮位在中间）', () => {
    expect(positionOf(2, 2, 6)).toBe('BTN');
    expect(positionOf(3, 2, 6)).toBe('SB');
    expect(positionOf(4, 2, 6)).toBe('BB');
    expect(positionOf(5, 2, 6)).toBe('UTG');
    expect(positionOf(0, 2, 6)).toBe('HJ');
    expect(positionOf(1, 2, 6)).toBe('CO');
  });

  it('buttonSeat=5, 6 人（跨 0 边界）', () => {
    expect(positionOf(5, 5, 6)).toBe('BTN');
    expect(positionOf(0, 5, 6)).toBe('SB');
    expect(positionOf(1, 5, 6)).toBe('BB');
    expect(positionOf(2, 5, 6)).toBe('UTG');
    expect(positionOf(3, 5, 6)).toBe('HJ');
    expect(positionOf(4, 5, 6)).toBe('CO');
  });

  it('seatPositions 返回完整映射', () => {
    const m = seatPositions(0, 6);
    expect(m.get(0)).toBe('BTN');
    expect(m.get(5)).toBe('CO');
    expect(m.size).toBe(6);
  });
});

describe('preflopOrder', () => {
  it('buttonSeat=0, 6 人：UTG -> HJ -> CO -> BTN -> SB -> BB', () => {
    expect(preflopOrder(0, 6)).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it('buttonSeat=2, 6 人', () => {
    // BTN=2, SB=3, BB=4, UTG=5, HJ=0, CO=1
    // 翻前：UTG(5) -> HJ(0) -> CO(1) -> BTN(2) -> SB(3) -> BB(4)
    expect(preflopOrder(2, 6)).toEqual([5, 0, 1, 2, 3, 4]);
  });

  it('3 人', () => {
    // BTN=0, SB=1, BB=2, 翻前：BTN -> SB -> BB
    expect(preflopOrder(0, 3)).toEqual([0, 1, 2]);
  });

  it('4 人', () => {
    // BTN=0, SB=1, BB=2, UTG=3, 翻前：UTG -> BTN -> SB -> BB
    expect(preflopOrder(0, 4)).toEqual([3, 0, 1, 2]);
  });

  it('单挑：BTN 先，BB 后', () => {
    expect(preflopOrder(0, 2)).toEqual([0, 1]);
    expect(preflopOrder(1, 2)).toEqual([1, 0]);
  });
});

describe('postflopOrder', () => {
  it('buttonSeat=0, 6 人：SB -> BB -> UTG -> HJ -> CO -> BTN', () => {
    expect(postflopOrder(0, 6)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('buttonSeat=2, 6 人', () => {
    // SB=3, BB=4, UTG=5, HJ=0, CO=1, BTN=2
    expect(postflopOrder(2, 6)).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it('3 人', () => {
    // BTN=0, SB=1, BB=2, 翻后：SB -> BB -> BTN
    expect(postflopOrder(0, 3)).toEqual([1, 2, 0]);
  });

  it('单挑：BB 先，BTN 后', () => {
    expect(postflopOrder(0, 2)).toEqual([1, 0]);
    expect(postflopOrder(1, 2)).toEqual([0, 1]);
  });
});

describe('Position 常量', () => {
  it('包含 6 个标准位置', () => {
    expect(Object.keys(Position).sort()).toEqual(
      ['BB', 'BTN', 'CO', 'HJ', 'SB', 'UTG'].sort(),
    );
  });
});