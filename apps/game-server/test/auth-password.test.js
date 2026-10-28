import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/auth/password.js';

describe('口令策略', () => {
  it('正常口令通过', () => {
    expect(checkPasswordPolicy('correct horse 9').ok).toBe(true);
  });
  it('太短 / 纯数字 / 等于昵称 都不行', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('12345678').ok).toBe(false);
    expect(checkPasswordPolicy('Alice_2026', 'alice_2026').ok).toBe(false);
  });
});

describe('口令哈希', () => {
  it('同一口令两次哈希不同（随机盐），但都能验过', async () => {
    const a = await hashPassword('hello-poker-9');
    const b = await hashPassword('hello-poker-9');
    expect(a === b).toBe(false);
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('hello-poker-9', a)).toBe(true);
    expect(await verifyPassword('hello-poker-9', b)).toBe(true);
  });

  it('错口令 / 坏格式 都返回 false，不抛异常', async () => {
    const hash = await hashPassword('hello-poker-9');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
    expect(await verifyPassword('hello-poker-9', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('hello-poker-9', 'scrypt$1$1$1$xx$yy')).toBe(false);
    expect(await verifyPassword('', '')).toBe(false);
  });
});
