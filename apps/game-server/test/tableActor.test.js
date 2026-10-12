import { describe, it, expect } from 'vitest';
import { TableActor } from '../src/state/tableActor.js';

describe('TableActor', () => {
  it('串行执行', async () => {
    const a = new TableActor('t');
    const log = [];
    const p1 = a.run(async () => {
      log.push('1-start');
      await new Promise((r) => setTimeout(r, 20));
      log.push('1-end');
    });
    const p2 = a.run(async () => {
      log.push('2-start');
      log.push('2-end');
    });
    await Promise.all([p1, p2]);
    expect(log).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('前一个报错不影响后一个', async () => {
    const a = new TableActor('t');
    const log = [];
    const p1 = a.run(() => {
      log.push('1');
      throw new Error('boom');
    });
    const p2 = a.run(() => {
      log.push('2');
    });
    await p1.catch(() => {});
    await p2;
    expect(log).toEqual(['1', '2']);
  });
});