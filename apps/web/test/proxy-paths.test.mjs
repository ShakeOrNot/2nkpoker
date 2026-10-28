import { describe, it, expect } from 'vitest';
import { shouldProxy } from '../proxy-paths.mjs';

describe('前端代理路径', () => {
  it('登录/注册/刷新/登出/改密 都要转发到后端', () => {
    for (const p of [
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
      '/auth/logout',
      '/auth/me',
      '/auth/change-password',
    ]) {
      expect(shouldProxy(p)).toBe(true);
    }
  });

  it('牌局与大屏接口也要转发', () => {
    expect(shouldProxy('/tables')).toBe(true);
    expect(shouldProxy('/tables/abc')).toBe(true);
    expect(shouldProxy('/health')).toBe(true);
    expect(shouldProxy('/ready')).toBe(true);
    expect(shouldProxy('/dev/token')).toBe(true);
    expect(shouldProxy('/socket.io/?EIO=4')).toBe(true);
    expect(shouldProxy('/api/foo')).toBe(true);
  });

  it('静态资源不要转发', () => {
    expect(shouldProxy('/')).toBe(false);
    expect(shouldProxy('/index.html')).toBe(false);
    expect(shouldProxy('/js/app.js')).toBe(false);
    expect(shouldProxy('/css/app.css')).toBe(false);
    expect(shouldProxy('/authored.html')).toBe(false);
    expect(shouldProxy('/tables.html')).toBe(false);
  });
});
