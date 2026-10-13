/**
 * 端到端冒烟：在 Node 里用最小 DOM 真实装配 app.js，
 * 覆盖两条用户路径：
 *   A. store 层：登录 → 创建牌局 → 坐下 → 准备 → 开局 → 动作 → 结算
 *   B. 界面层：点击按钮后，界面上是否真的出现反馈（视图切换 / 房号 / 操作栏 / 结算浮层）
 *
 * 用来定位"点了按钮没反应"这类问题。
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/* ---------------- 最小 DOM（带真实的 class 与后代选择器） ---------------- */

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) if (x) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); return undefined; }
    on ? this.set.add(c) : this.set.delete(c);
    return undefined;
  }
  get value() { return [...this.set].join(' '); }
}

class FakeNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.attributes = {};
    this.listeners = new Map();
    this._text = '';
    this.id = '';
    this.value = '';
    this.type = '';
    this.disabled = false;
    this.title = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get className() { return this.classList.value; }
  set className(v) { this.classList = new FakeClassList(); this.classList.add(...String(v).split(/\s+/)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  set innerHTML(v) { this._text = String(v); this.children = []; }
  appendChild(n) { if (n) { this.children.push(n); n.parentNode = this; } return n; }
  append(...ns) { for (const n of ns) this.appendChild(n); }
  replaceChildren(...ns) { this.children = []; for (const n of ns) this.appendChild(n); }
  replaceWith(...ns) { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1, ...ns.filter(Boolean)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'disabled') this.disabled = true; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'disabled') this.disabled = false; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  click() { for (const fn of [...(this.listeners.get('click') ?? [])]) fn({ preventDefault() {}, target: this }); }
  submit() { for (const fn of [...(this.listeners.get('submit') ?? [])]) fn({ preventDefault() {}, target: this }); }
  input() { for (const fn of [...(this.listeners.get('input') ?? [])]) fn({ preventDefault() {}, target: this }); }
  /** 后代选择器：支持 ".a .b" */
  querySelector(sel) {
    const parts = String(sel).trim().split(/\s+/);
    let scope = this;
    for (const part of parts) {
      const found = [];
      walk(scope, (n) => { if (matchSimple(n, part)) found.push(n); });
      if (!found.length) return null;
      scope = found[0];
    }
    return scope;
  }
  querySelectorAll(sel) {
    const parts = String(sel).trim().split(/\s+/);
    let scope = this;
    for (let i = 0; i < parts.length - 1; i++) {
      const found = [];
      walk(scope, (n) => { if (matchSimple(n, parts[i])) found.push(n); });
      if (!found.length) return [];
      scope = found[0];
    }
    const out = [];
    walk(scope, (n) => { if (matchSimple(n, parts[parts.length - 1])) out.push(n); });
    return out;
  }
  focus() {}
  closest(sel) { let n = this; while (n) { if (matchSimple(n, sel)) return n; n = n.parentNode; } return null; }
  /** 与真实 DOM 一致：判断某节点是否在自己的子树里 */
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const c of this.children) if (c.contains?.(node)) return true;
    return false;
  }
  /** 整棵子树的可见文本，用于断言"界面上出现了什么" */
  text() { return [this._text, ...this.children.map((c) => (c.text ? c.text() : ''))].join(' '); }
  /** 递归找按钮（按文本） */
  findButton(label) {
    if (this.tagName === 'BUTTON' && this._text.includes(label)) return this;
    for (const c of this.children) { const hit = c.findButton?.(label); if (hit) return hit; }
    return null;
  }
}

function walk(node, fn) { for (const c of node.children ?? []) { fn(c); walk(c, fn); } }

function matchSimple(node, sel) {
  if (!node?.classList) return false;
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  return node.tagName === sel.toUpperCase();
}

const document = {
  body: new FakeNode('body'),
  head: new FakeNode('head'),
  activeElement: null,
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n; },
  createDocumentFragment: () => new FakeNode('#fragment'),
  getElementById: (id) => document.__byId.get(id) ?? null,
  querySelector: (s) => document.body.querySelector(s),
  querySelectorAll: (s) => document.body.querySelectorAll(s),
  addEventListener() {},
  __byId: new Map(),
};

globalThis.document = document;
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true });
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a) => a }, configurable: true, writable: true });
}

const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.localStorage = localStorage;
globalThis.window = {
  location: { origin: 'http://localhost:8099', hostname: 'localhost', search: '', href: 'http://localhost:8099/' },
  localStorage,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  prompt() {},
  setTimeout,
  clearTimeout,
};
globalThis.fetch = async (url) => {
  if (String(url).includes('/dev/token')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, token: 'fake.jwt', userId: 'user_me', nickname: '测试玩家' }) };
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

for (const id of ['views', 'toolbar', 'toast', 'error-banner']) {
  const el = new FakeNode('div');
  el.id = id;
  document.__byId.set(id, el);
  document.body.appendChild(el);
}

/* ---------------- 装配真实 app ---------------- */

const base = new URL('../../public/js/', import.meta.url);
const href = (rel) => pathToFileURL(join(base.pathname.replace(/^\/([A-Za-z]:)/, '$1'), rel)).href;

let failed = 0;
const step = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

try {
  await import(href('app.js'));   // ← 真实入口：建立 store + 4 个视图 + 订阅
} catch (err) {
  console.error('app.js 加载失败：', err);
  process.exit(1);
}
if (!globalThis.window?.__poker) {
  console.error('app.js 跑完了但没有挂上 window.__poker（可能中途抛错）');
  console.error('window keys:', Object.keys(globalThis.window ?? {}).join(','));
  process.exit(1);
}
const { store, views } = globalThis.window.__poker;
store.setOffline(true);

const viewsEl = document.__byId.get('views');
const activeView = () => viewsEl.children.find((c) => c.classList?.contains('view-active'));
const activeText = () => activeView()?.text() ?? '';

/**
 * 关键回归：只有当前阶段的视图可见，其它视图必须 hidden，
 * 并且该视图里的关键按钮真的存在（曾经的 bug：面板忘了挂到 DOM 上，
 * 页面上根本没有这个面板，点页签等于没反应且不报错）。
 * @param {string} phase
 * @param {Array<[string, HTMLElement|null]>} requiredButtons
 */
function checkViewIntegrity(phase, requiredButtons = []) {
  const visible = [...viewsEl.children].filter((v) => !v.classList?.contains('hidden'));
  step(`只有 ${phase} 视图可见`, visible.length === 1 && visible[0].classList.contains(`view-${phase}`),
    visible.map((v) => v.className).join(' | '));

  for (const [label, el] of requiredButtons) {
    const inVisibleView = Boolean(el) && Boolean(visible[0]?.contains(el));
    step(`${phase} 里的「${label}」真的在可见视图内`, inVisibleView);
  }
}

console.log('界面装配：');
step('4 个视图都已实例化', Object.keys(views).length === 4, Object.keys(views).join(','));
step('启动后停在登录页', store.state.phase === 'login' && activeText().includes('用户名'), `len=${activeText().length}`);

/* --- 点击"进入牌局大厅" --- */
const loginView = views.login;
loginView.input.value = '测试玩家';
loginView.root.querySelector('form').submit();
await waitFor(() => store.state.phase === 'lobby', 5000);
step('点登录 → 进入大厅', store.state.phase === 'lobby', `phase=${store.state.phase}`);
await sleep(30);
step('大厅界面已渲染出内容', activeText().includes('创建牌局') || activeText().includes('加入牌局'), `len=${activeText().length}`);

/* --- 点「创建牌局」页签（这一步曾因为面板没挂到 DOM 而毫无反应） --- */
views.lobby.tabCreate.click();
await sleep(30);
checkViewIntegrity('lobby', [['创建并进入等待室', views.lobby.createBtn]]);
step('切到创建页签后，创建面板可见', !views.lobby.panelCreate.classList.contains('hidden'));

/* --- 点击"创建并进入等待室" --- */
const createBtn = views.lobby.createBtn;
step('找到"创建并进入等待室"按钮', Boolean(createBtn), createBtn?.textContent ?? '');
views.lobby.seatValue = 4;
createBtn.click();
await waitFor(() => store.state.phase === 'waiting', 6000);
step('点创建 → 切到等待室', store.state.phase === 'waiting', `phase=${store.state.phase}`);
await sleep(30);
step('等待室显示房号', activeText().includes(store.state.room.tableId), `房号=${store.state.room.tableId}`);
checkViewIntegrity('waiting', [['坐下', views.waiting.sitBtn], ['准备开始', views.waiting.readyBtn]]);

/* --- 等待室：坐下 + 准备 --- */
const waitView = views.waiting;
waitView.buyInput.value = '1000';
waitView.sitBtn.click();
await waitFor(() => store.mySeat() != null, 5000);
step('点坐下 → 有了座位', store.mySeat() != null, `seat=${store.mySeat()}`);
await sleep(30);
waitView.readyBtn.click();
const started = await waitFor(() => Boolean(store.state.room.snapshot?.hand), 6000);
step('点准备 → 自动开局', started);
await waitFor(() => store.state.phase === 'table', 4000);
step('开局后切到牌桌视图', store.state.phase === 'table', `phase=${store.state.phase}`);
checkViewIntegrity('table', [['弃牌', views.table.controls.foldBtn], ['全下', views.table.controls.allInBtn]]);

/* --- 牌桌：操作栏真的出现按钮 --- */
const controls = views.table.controls;
const gotTurn = await waitFor(
  () => store.state.room.actionRequest !== null || Boolean(store.state.room.snapshot?.hand?.settled),
  9000,
);
step('轮到我就收到行动请求（或这一手已被机器人打完）', gotTurn);

const handAtTurn = store.state.room.snapshot?.hand;
const iCanAct = Boolean(handAtTurn) && !handAtTurn.settled && handAtTurn.currentTurnSeat === store.mySeat();
await sleep(50);
const visibleButtons = [controls.foldBtn, controls.checkBtn, controls.callBtn, controls.submitBtn, controls.allInBtn]
  .filter((b) => b && !b.classList.contains('hidden'))
  .map((b) => b.textContent);

if (iCanAct) {
  step('操作栏出现可用按钮', visibleButtons.length > 0, visibleButtons.join(' / '));
  step('自定义金额输入框的上下限正确',
    Number(controls.amountInput.max) === store.actionContext().maxTarget,
    `max=${controls.amountInput.max} 筹码上限=${store.actionContext().maxTarget}`);

  /* 输入一个超过筹码的金额，界面必须拦住 */
  controls.amountInput.value = String(store.actionContext().maxTarget + 5000);
  controls.amountInput.input();
  step('超过筹码的金额 → 提交按钮被禁用', controls.submitBtn.disabled === true);
  step('并且给出提示文案', controls.amountHint.textContent.includes('最多只能下到'), controls.amountHint.textContent);

  /* 输入合法金额 → 可以提交 */
  controls.amountInput.value = String(store.actionContext().maxTarget);
  controls.amountInput.input();
  step('全部筹码（全下额）→ 允许提交', controls.submitBtn.disabled === false, controls.submitBtn.textContent);
} else {
  step('机器人先打完这手时，我也没被要求行动（合法结果）', visibleButtons.length === 0, visibleButtons.join(' / '));
}

/* --- auto-play 到结算 --- */
let guard = 0;
let stallGuard = 0;
while (!store.state.room.lastResult && guard++ < 1200) {
  const hand = store.state.room.snapshot?.hand;
  const mySeat = store.mySeat();
  const mine = hand?.seats?.find((s) => s.seat === mySeat);
  const myTurn = Boolean(hand) && !hand.settled && hand.currentTurnSeat === mySeat;

  if (myTurn && mine && !mine.folded && !mine.allIn) {
    const toCall = Math.max(0, (hand.currentBet ?? 0) - (mine.betThisStreet ?? 0));
    await store.act(toCall === 0 ? { type: 'check' } : toCall <= 100 ? { type: 'call' } : { type: 'fold' });
    stallGuard = 0;
  } else if (!hand || hand.settled) {
    stallGuard++;
  }
  await sleep(25);
  // 安全阀：连续 8 秒既不是我行动、手牌也没结算 → 认为卡住，跳出
  if (stallGuard > 320) break;
}
step('一手牌打到结算', Boolean(store.state.room.lastResult), `guard=${guard}`);
if (!store.state.room.lastResult) {
  const hand = store.state.room.snapshot?.hand;
  console.log('  debug  卡住的状态:', JSON.stringify({
    street: hand?.street,
    settled: hand?.settled,
    currentTurnSeat: hand?.currentTurnSeat,
    mySeat: store.mySeat(),
    pot: hand?.pot,
    seats: hand?.seats.map((s) => `${s.seat}:${s.folded ? 'F' : s.allIn ? 'A' : s.chips}`),
    actionRequest: Boolean(store.state.room.actionRequest),
    mockTurn: store.socket?.table?.hand?.currentTurnSeat,
    mockSettled: store.socket?.table?.hand?.settled,
    log: store.state.room.log.slice(-8).map((l) => l.text),
  }));
}
await sleep(60);
const overlay = views.table.resultOverlay;
step('结算浮层出现在界面上', overlay.classList.contains('visible') && overlay.text().length > 10, `文本长度=${overlay.text().length}`);
const overlayText = overlay.text();
step('结算浮层说明了输赢', /你赢了|你输了|本手打平/.test(overlayText), overlayText.slice(0, 60));

/* --- 传输层接口约定（这次的踩坑点） --- */
console.log('传输层接口：');
for (const name of ['request', 'setHandlers', 'on', 'off', 'emit', 'close']) {
  step(`socket.${name} 存在`, typeof store.socket?.[name] === 'function');
}

/* --- 静默失败的兜底：错误必须出现在界面上 --- */
console.log('错误兜底：');
const banner = document.__byId.get('error-banner');
Promise.reject(new Error('模拟一个未处理的错误'));
await sleep(120);
step('未处理的错误会显示在顶部错误条', banner.classList.contains('visible') && banner.textContent.includes('模拟一个未处理的错误'), banner.textContent);

console.log(failed ? `\n端到端冒烟：${failed} 项失败` : '\n端到端冒烟：全部通过');
process.exit(failed ? 1 : 0);
