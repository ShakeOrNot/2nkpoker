import { describe, it, expect } from 'vitest';
import { getOrCreateTable, findFreeSeat, removeTableIfEmpty } from '../src/state/tableManager.js';

describe('tableManager', () => {
  it('创建新桌子', () => {
    const t = getOrCreateTable('t1');
    expect(t.tableId).toBe('t1');
    expect(t.maxSeats).toBe(6);
    expect(t.seats.size).toBe(0);
  });

  it('同名桌子返回同一个对象', () => {
    const a = getOrCreateTable('t2');
    const b = getOrCreateTable('t2');
    expect(a).toBe(b);
  });

  it('findFreeSeat 优先用指定座位', () => {
    const t = getOrCreateTable('t3');
    expect(findFreeSeat(t, 3)).toBe(3);
  });

  it('findFreeSeat 座位被占则找下一个空的', () => {
    const t = getOrCreateTable('t4');
    t.seats.set(0, { seat: 0, userId: 'u', nickname: 'x', chips: 100, ready: false, connected: true });
    expect(findFreeSeat(t, 0)).toBe(1);
  });

  it('满了返回 null', () => {
    const t = getOrCreateTable('t5');
    for (let i = 0; i < 6; i++) {
      t.seats.set(i, { seat: i, userId: `u${i}`, nickname: 'x', chips: 100, ready: false, connected: true });
    }
    expect(findFreeSeat(t, null)).toBeNull();
  });

  it('空桌子会被清掉', () => {
    const t = getOrCreateTable('t6');
    expect(t.seats.size).toBe(0);
    removeTableIfEmpty('t6');
    expect(getOrCreateTable('t7').tableId).toBe('t7');
  });
});