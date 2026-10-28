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
  querySelector(sel) {
    // 只支持 '.class' 选择器（够视图层用），深度优先按插入顺序找第一个
    if (typeof sel !== 'string' || !sel.startsWith('.')) return null;
    const want = sel.slice(1);
    const queue = [...this.children];
    while (queue.length) {
      const n = queue.shift();
      if (n.classList?.contains(want)) return n;
      if (n.children?.length) queue.push(...n.children);
    }
    return null;
  }
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

  /* ---- 回归：等候室里离座不能把人踢出房间（否则无法重新入座、UI 变成空壳） ---- */
  try {
    const appStore = globalThis.window.__poker?.store;
    const waiting = globalThis.window.__poker?.views?.waiting;
    if (!appStore || !waiting) throw new Error('app.js 没有暴露 store/views');

    const idleSnapshot = {
      ...fakeSnapshot,
      hand: null,
      seats: [
        { seat: 0, userId: 'me', nickname: '我', chips: 1000, ready: false, connected: true },
        { seat: 1, userId: 'bot_1', nickname: '阿豪', chips: 1000, ready: false, connected: true },
      ],
    };

    appStore.state.session = { token: 't', userId: 'me', nickname: '我', expiresAt: 0 };
    appStore.state.connection = 'online';
    appStore.state.phase = 'waiting';
    appStore.state.room = { ...appStore.state.room, tableId: 'demo01', snapshot: idleSnapshot, queued: false };

    const calls = [];
    appStore.socket = {
      connected: true,
      request: async (event, payload) => {
        calls.push({ event, payload });
        return { ok: true };
      },
      close() {},
    };
    appStore.onChange();

    // 座位名用位次：2 人桌 = BTN / BB；空座位上还有「换到这里」
    const cells = waiting.seatGrid.children;
    const seatLabel = (i) => cells[i]?.children?.[0]?.textContent ?? '';
    if (seatLabel(0) !== 'BTN' || seatLabel(1) !== 'BB') {
      throw new Error(`座位名不是位次：${JSON.stringify([seatLabel(0), seatLabel(1)])}`);
    }
    const swapBtn = cells[2]?.children?.find?.((n) => n.tagName === 'BUTTON');
    if (!swapBtn || swapBtn.textContent !== '换到这里') {
      throw new Error(`已入座时空位没有「换到这里」按钮：${swapBtn?.textContent ?? '无'}`);
    }

    await waiting.doStand();

    if (!calls.some((c) => c.event === 'table:stand')) throw new Error('离座没有发 table:stand');
    if (calls.some((c) => c.event === 'table:leave')) throw new Error('离座后不应该退订房间（table:leave）');
    if (appStore.state.room.tableId !== 'demo01') throw new Error(`离座后房间被清空：${appStore.state.room.tableId}`);
    if (appStore.state.phase !== 'waiting') throw new Error(`离座后阶段变成了 ${appStore.state.phase}`);

    // 服务端离座后推来的快照：我的座位空出来，房间照旧
    const afterStand = {
      ...idleSnapshot,
      seats: idleSnapshot.seats.map((s) =>
        s.userId === 'me' ? { seat: s.seat, userId: null, nickname: '', chips: 0, ready: false, connected: false } : s,
      ),
    };
    appStore.applySnapshot(afterStand);

    if (waiting.roomIdEl.textContent !== 'demo01') throw new Error(`房号显示异常：${waiting.roomIdEl.textContent}`);
    if (waiting.sitBtn.disabled) throw new Error('离座后「坐下」按钮被禁用，无法重新入座');
    if (!waiting.standBtn.disabled) throw new Error('离座后「离座」按钮还应该禁用');
    console.log('  ok    等候室离座后仍留在房间，可以重新入座');
  } catch (err) {
    failed++;
    console.log(`  FAIL  等候室离座后重新入座: ${err?.message ?? err}`);
  }

  /* ---- 离线练习：大厅/等待室/牌桌都要有「退出离线」按钮 ---- */
  try {
    const appStore = globalThis.window.__poker.store;
    const views = globalThis.window.__poker.views;
    const snap = {
      tableId: 'demo01',
      version: 1,
      smallBlind: 10,
      bigBlind: 20,
      buttonSeat: 0,
      maxSeats: 6,
      seats: [
        { seat: 0, userId: 'local_me', nickname: '我', chips: 1000, ready: false, connected: true, leaving: false },
      ],
      hand: null,
    };

    appStore.state.offline = true;
    appStore.state.session = { token: 'offline', userId: 'local_me', nickname: '我', expiresAt: 0 };
    appStore.state.room = { ...appStore.state.room, tableId: 'demo01', snapshot: snap };
    const st = appStore.state;

    views.lobby.render(st);
    views.waiting.render(st);
    views.table.render(st);

    if (views.lobby.logoutBtn.textContent !== '退出离线') {
      throw new Error(`大厅按钮文案是 ${views.lobby.logoutBtn.textContent}`);
    }
    if (views.waiting.exitBtn.textContent !== '退出离线') {
      throw new Error(`等待室按钮文案是 ${views.waiting.exitBtn.textContent}`);
    }
    if (views.table.exitBtn.textContent !== '退出离线') {
      throw new Error(`牌桌按钮文案是 ${views.table.exitBtn.textContent}`);
    }

    // 结算浮层：服务端清空 hand 之后仍要能画（联机少结算框的回归点）
    appStore.state.room.lastResult = {
      handId: 'h9',
      result: {
        pots: [{ amount: 20, eligibleSeats: [0], contributorSeats: [0, 1] }],
        payouts: { 0: 20 },
        revealed: {},
        forcedWinnerSeat: 0,
      },
      board: ['As', 'Kd', '2c', '7h', '9s'],
      seats: [
        { seat: 0, userId: 'local_me', nickname: '我', chips: 1020, totalCommitted: 10, folded: false, allIn: false },
        { seat: 1, userId: 'bot_1', nickname: '豆豆', chips: 990, totalCommitted: 10, folded: true, allIn: false },
      ],
      at: Date.now(),
    };
    appStore.state.room.snapshot = { ...snap, hand: null };
    views.table.render(appStore.state);
    if (!views.table.resultOverlay.classList.contains('visible')) {
      throw new Error('手牌被清空后结算浮层消失了（联机模式会没有结算框）');
    }

    appStore.state.offline = false;
    console.log('  ok    离线模式下大厅/等待室/牌桌都有「退出离线」');
    console.log('  ok    hand 被清空后结算浮层仍显示');
  } catch (err) {
    failed++;
    console.log(`  FAIL  离线模式退出按钮: ${err?.message ?? err}`);
    if (err?.stack) console.log(err.stack.split('\n').slice(0, 4).join('\n'));
  }
}

console.log(failed ? `DOM 冒烟：${failed} 个失败` : 'DOM 冒烟：全部通过');
process.exit(failed ? 1 : 0);