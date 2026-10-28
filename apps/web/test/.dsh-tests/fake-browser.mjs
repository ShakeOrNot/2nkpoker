/**
 * 给 Node 安装一个最小的浏览器环境，用于测试那些碰 window/document 的模块。
 * 只实现视图/提示层真正用到的那几个 API（class/style/text/append/remove）。
 */

const store = new Map();

const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

/** 极简节点：够 toast / 视图层用 */
class FakeNode {
  /**
   * @param {string} [tag]
   */
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.parentNode = null;
    this._text = '';
    this._classes = new Set();
    this.style = { setProperty() {}, removeProperty() {} };
    this.value = '';
    this.disabled = false;
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(v) {
    this._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean));
  }

  get classList() {
    const s = this._classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, on) => {
        if (on === undefined) {
          if (s.has(c)) s.delete(c);
          else s.add(c);
        } else if (on) s.add(c);
        else s.delete(c);
      },
      contains: (c) => s.has(c),
    };
  }

  get textContent() {
    return this._text;
  }

  set textContent(v) {
    this._text = String(v ?? '');
    this.children = [];
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'disabled') this.disabled = true;
  }

  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'disabled') this.disabled = false;
  }

  getAttribute(k) {
    return this.attributes[k] ?? null;
  }

  appendChild(node) {
    if (node) {
      this.children.push(node);
      node.parentNode = this;
    }
    return node;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }

  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
}

const head = {
  appendChild(node) {
    // 模拟脚本加载失败，用于验证"多个 CDN 依次重试"的分支
    setTimeout(() => node.onerror?.(new Error('offline')), 0);
  },
};

globalThis.localStorage = localStorage;
globalThis.document = {
  body: new FakeNode('body'),
  head,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const n = new FakeNode('#text');
    n.textContent = text;
    return n;
  },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
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
  addEventListener() {},
};

export { localStorage, FakeNode };
