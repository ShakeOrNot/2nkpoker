/**
 * 一次性的 DOM 冒烟测试：用最小 DOM 桩把每个模块都 import 一遍，
 * 确认没有语法/导入错误，并实例化 4 个视图、渲染 4 个阶段。
 * 通过后可以删除（它不在 *.test.mjs 的自动收集范围内）。
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/* ---------------- 最小 DOM ---------------- */

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); return; } on ? this.set.add(c) : this.set.delete(c); }
  get value() { return [...this.set].join(' '); }
}

class FakeNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {
      setProperty(k, v) { this[k] = v; },
    };
    this.attributes = {};
    this.listeners = new Map();
    this._text = '';
    this.value = '';
    this.title = '';
    this.type = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.datasetKey = '';
  }

  get className() { return this.classList.value; }
  set className(v) { this.classList = new FakeClassList(); for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  set innerHTML(v) { this._text = String(v); this.children = []; }

  appendChild(node) { if (node) { this.children.push(node); node.parentNode = this; } return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
  replaceWith() {}
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'disabled') this.disabled = true; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'disabled') this.disabled = false; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type) { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {} }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  closest() { return null; }
  /** 与真实 DOM 一致：判断某节点是否在自己的子树里 */
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const c of this.children) if (c.contains?.(node)) return true;
    return false;
  }
  get firstChild() { return this.children[0] ?? null; }
}

const document = {
  body: new FakeNode('body'),
  head: new FakeNode('head'),
  documentElement: new FakeNode('html'),
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.textContent = text; return n; },
  createDocumentFragment: () => new FakeNode('#fragment'),
  getElementById: (id) => document.__byId.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  __byId: new Map(),
};

globalThis.document = document;
// Node 里 navigator 是只读 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: null, userAgent: 'node-dom-smoke' },
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = FakeNode;

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.window = {
  location: { origin: 'http://localhost:8080', hostname: 'localhost', search: '', href: 'http://localhost:8080/index.html' },
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  setTimeout,
  clearTimeout,
};
// Node 24 的 crypto 也是只读 getter，只在缺失时才补
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: (a) => a },
    configurable: true,
    writable: true,
  });
}
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

/* 供 app.js 查的两个节点 */
for (const id of ['views', 'toolbar', 'toast']) {
  const el = new FakeNode('div');
  el.id = id;
  document.__byId.set(id, el);
  document.body.appendChild(el);
}

/* ---------------- 逐个 import ---------------- */

const base = new URL('../../public/js/', import.meta.url);
const modules = [
  'core/constants.js', 'core/config.js', 'core/dom.js', 'core/format.js', 'core/logic.js',
  'net/api.js', 'net/socket.js', 'net/roomStore.js', 'net/mock-socket.js',
  'views/base.js', 'views/cards.js', 'views/login.js', 'views/lobby.js',
  'views/waiting.js', 'views/controls.js', 'views/table.js',
  'store.js', 'app.js',
];

let failed = 0;

/** 必须存在的导出 */
const required = {
  'store.js': ['Store', 'actionText'],
  'views/table.js': ['TableView'],
  'views/login.js': ['LoginView'],
  'views/lobby.js': ['LobbyView'],
  'views/waiting.js': ['WaitingView', 'streetText'],
  'views/controls.js': ['ControlsView'],
  'views/cards.js': ['cardEl', 'cardRow', 'boardEl', 'chipText'],
  'net/socket.js': ['GameSocket', 'isAuthError'],
  'net/api.js': ['login', 'listRooms', 'createRoom', 'ping'],
  'net/mock-socket.js': ['createMockSocket', 'MockGameSocket'],
  'core/logic.js': ['validateBetAmount', 'quickBets', 'settlement', 'makeRoomId'],
};

const loaded = {};
for (const mod of modules) {
  try {
    const ns = await import(pathToFileURL(join(base.pathname.replace(/^\/([A-Za-z]:)/, '$1'), mod)).href);
    loaded[mod] = ns;
    for (const name of required[mod] ?? []) {
      if (!(name in ns)) throw new Error(`缺少导出 ${name}`);
    }
    console.log(`  ok    ${mod}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${mod}\n        ${err?.message ?? err}`);
  }
}

/* ---------------- 视图渲染冒烟 ---------------- */

if (!failed) {
  const { Store } = loaded['store.js'];
  const store = new Store();
  // 造一个"登录后在大厅"的状态，再逐个阶段渲染
  store.state.session = { token: 't', userId: 'me', nickname: '我', expiresAt: 0 };
  store.state.phase = 'lobby';

  const fakeSnapshot = {
    tableId: 'demo01',
    version: 4,
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 0,
    maxSeats: 6,
    seats: [
      { seat: 0, userId: 'me', nickname: '我', chips: 1000, ready: true, connected: true },
      { seat: 1, userId: 'bot_1', nickname: '阿豪', chips: 900, ready: true, connected: true },
      { seat: 2, userId: null, nickname: '', chips: 0, ready: false, connected: false },
    ],
    hand: {
      handId: 'h1',
      street: 'FLOP',
      board: ['9c', '5h', 'Qc'],
      buttonSeat: 0,
      smallBlind: 10,
      bigBlind: 20,
      seats: [
        { seat: 0, userId: 'me', nickname: '我', chips: 900, betThisStreet: 0, totalCommitted: 60, folded: false, allIn: false, sittingOut: false, holeCards: ['As', 'Ks'] },
        { seat: 1, userId: 'bot_1', nickname: '阿豪', chips: 900, betThisStreet: 0, totalCommitted: 60, folded: false, allIn: false, sittingOut: false, holeCards: [] },
      ],
      currentTurnSeat: 0,
      currentBet: 0,
      minRaise: 20,
      pot: 120,
      version: 7,
      settled: false,
      result: null,
    },
  };

  const phases = ['login', 'lobby', 'waiting', 'table'];
  for (const phase of phases) {
    try {
      store.state.phase = phase;
      store.state.room = { ...store.state.room, tableId: 'demo01', snapshot: fakeSnapshot, log: [] };
      store.onChange();
      console.log(`  ok    渲染阶段 ${phase}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  渲染阶段 ${phase}: ${err?.message ?? err}`);
    }
  }

  // 结算状态也要能渲染（结果浮层）
  try {
    store.state.room.lastResult = {
      handId: 'h1',
      board: ['9c', '5h', 'Qc', '2d', '7s'],
      result: {
        pots: [{ amount: 240, eligibleSeats: [0, 1] }],
        payouts: { 0: 240 },
        revealed: { 0: ['As', 'Ks'], 1: ['Ad', 'Qd'] },
        forcedWinnerSeat: null,
      },
    };
    store.state.room.snapshot = { ...fakeSnapshot, hand: { ...fakeSnapshot.hand, settled: true, version: 9, result: store.state.room.lastResult.result } };
    store.state.phase = 'table';
    store.onChange();
    console.log('  ok    渲染结算浮层');
  } catch (err) {
    failed++;
    console.log(`  FAIL  渲染结算浮层: ${err?.message ?? err}`);
  }

  // 快捷键：actionContext 能出快捷按钮
  const ctx = store.actionContext();
  console.log(`  ok    actionContext: legal=${JSON.stringify(ctx.legal)} quicks=${ctx.quicks.length} maxTarget=${ctx.maxTarget}`);

  // 收到 action_request 时应该给出真实可用按钮
  try {
    store.state.room.actionRequest = {
      handId: 'h1',
      seat: 0,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      deadline: Date.now() + 30000,
      version: 8,
    };
    store.state.room.snapshot = {
      ...fakeSnapshot,
      hand: { ...fakeSnapshot.hand, currentBet: 0, currentTurnSeat: 0, version: 8, settled: false, result: null },
    };
    store.onChange();
    const live = store.actionContext();
    if (!live.legal.includes('check') || !live.legal.includes('bet')) {
      throw new Error(`legalActions 没透传：${JSON.stringify(live.legal)}`);
    }
    if (!live.quicks.some((q) => q.kind === 'allin')) throw new Error('缺少全下快捷按钮');
    if (!live.quicks.some((q) => q.kind === 'preset')) throw new Error('缺少按底池比例的快捷按钮');
    if (live.quicks.some((q) => q.amount > live.maxTarget)) throw new Error('快捷金额超过筹码上限');
    console.log(
      `  ok    轮到我的操作栏: legal=${live.legal.join('/')} 快捷=${live.quicks.map((q) => q.label).join(' | ')}`,
    );
  } catch (err) {
    failed++;
    console.log(`  FAIL  轮到我的操作栏: ${err?.message ?? err}`);
  }
}

console.log(failed ? `DOM 冒烟：${failed} 个失败` : 'DOM 冒烟：全部通过');
process.exit(failed ? 1 : 0);
