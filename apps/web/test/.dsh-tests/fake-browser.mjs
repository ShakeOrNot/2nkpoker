/**
 * 给 Node 安装一个最小的浏览器环境，用于测试那些碰 window/document 的模块。
 */

const store = new Map();

const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const head = {
  appendChild(node) {
    // 模拟脚本加载失败，用于验证"多个 CDN 依次重试"的分支
    setTimeout(() => node.onerror?.(new Error('offline')), 0);
  },
};

globalThis.localStorage = localStorage;
globalThis.document = {
  createElement: () => ({ src: '', onload: null, onerror: null }),
  head,
};
globalThis.window = {
  location: {
    origin: 'http://192.168.1.50:8080',
    hostname: '192.168.1.50',
    search: '',
    href: 'http://192.168.1.50:8080/index.html',
  },
  matchMedia: () => ({ matches: false }),
  localStorage,
  setTimeout,
  clearTimeout,
};

export { localStorage };
