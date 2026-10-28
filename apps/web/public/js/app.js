/**
 * 应用入口：视图路由 + 全局工具栏（布局切换、连接状态、toast）。
 */

import { Store } from './store.js';
import { node, setText, tag } from './views/base.js';
import { LoginView } from './views/login.js';
import { LobbyView } from './views/lobby.js';
import { WaitingView } from './views/waiting.js';
import { TableView } from './views/table.js';

const store = new Store();

const container = document.getElementById('views');

/** @type {Record<string, any>} */
const views = {
  login: new LoginView(store),
  lobby: new LobbyView(store),
  waiting: new WaitingView(store),
  table: new TableView(store),
};

let current = '';

/* ---------- 顶部的全局小工具条（布局切换） ---------- */

const toolbar = document.getElementById('toolbar');
const layoutBtn = document.createElement('button');
layoutBtn.type = 'button';
layoutBtn.className = 'toolbar-btn';
layoutBtn.title = '切换竖屏/横屏布局';
layoutBtn.addEventListener('click', () => {
  const order = ['auto', 'portrait', 'landscape'];
  const idx = order.indexOf(store.state.layout ?? 'auto');
  store.setLayout(order[(idx + 1) % order.length]);
});
toolbar.appendChild(layoutBtn);

const connDot = node('conn-dot');
toolbar.appendChild(connDot);

/* ---------- 登录过期横幅：页面保持不动，用户自己点"重新登录" ---------- */

const authBanner = document.createElement('div');
authBanner.className = 'auth-banner';
authBanner.appendChild(
  tag('span', 'auth-banner-text', '登录已过期：当前页面还在，重新登录后可继续（否则操作会被拒绝）'),
);
const reLoginBtn = document.createElement('button');
reLoginBtn.type = 'button';
reLoginBtn.className = 'btn-primary btn-sm';
reLoginBtn.textContent = '重新登录';
reLoginBtn.addEventListener('click', () => store.reLogin());
authBanner.appendChild(reLoginBtn);
document.body.appendChild(authBanner);

/**
 * 切换视图
 * @param {string} phase
 */
function showPhase(phase) {
  const name = views[phase] ? phase : 'login';
  if (current === name) return;
  for (const [key, view] of Object.entries(views)) {
    if (key === name) view.mount(container);
    else view.unmount();
  }
  current = name;
  document.body.dataset.phase = name;
  // 真实视图接管后，把 index.html 里的启动占位去掉
  document.getElementById('boot-placeholder')?.remove();
}

/* ---------- 订阅 ---------- */

store.subscribe((state) => {
  showPhase(state.phase);
  for (const view of Object.values(views)) {
    if (view.root.classList.contains('view-active')) view.render(state);
  }

  const layoutText = { auto: '自动', portrait: '竖屏', landscape: '横屏' }[state.layout ?? 'auto'];
  setText(layoutBtn, `布局：${layoutText}`);
  authBanner.classList.toggle('visible', Boolean(state.authExpired));

  const connMap = {
    online: ['conn-ok', '已连接'],
    connecting: ['conn-warn', '连接中'],
    offline: ['conn-bad', '已断开'],
    idle: ['conn-idle', state.offline ? '离线练习' : '未连接'],
  };
  const [cls, text] = connMap[state.connection] ?? connMap.idle;
  connDot.className = `conn-dot ${cls}`;
  connDot.title = text;
});

/* ---------- 启动 ---------- */

void store.boot();

/* ---------- 兜底：任何未捕获的错误都要让人看得见 ---------- */

let bannerTimer = null;

/**
 * 顶部错误条 + 一次性 toast，避免"点了没反应"这种沉默失败
 * @param {string} message
 */
function showError(message) {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.add('visible');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.remove('visible'), 6000);
}

window.addEventListener('error', (ev) => {
  const msg = ev?.error?.message ?? ev?.message ?? '未知错误';
  console.error('[uncaught]', ev?.error ?? ev);
  showError(`页面出错：${msg}`);
});

// 屏幕旋转 / 尺寸变化时重绘一次，让座位顺序与椭圆角度重新计算
window.addEventListener('orientationchange', () => setTimeout(() => store.onChange(), 200));
window.addEventListener('resize', () => {
  clearTimeout(window.__resizeTimer);
  window.__resizeTimer = setTimeout(() => store.onChange(), 150);
});

// Node/浏览器都存在的未处理 Promise 拒绝兜底（曾出现"点了没反应"就是被它吞掉的）
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled rejection]', reason);
    showError(`操作失败：${reason?.message ?? String(reason ?? '未知错误')}`);
  });
} else {
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason;
    console.error('[unhandled rejection]', reason);
    showError(`操作失败：${reason?.message ?? String(reason ?? '未知错误')}`);
  });
}

// 切回前台时顺手重连
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.state.session && store.state.connection === 'offline') {
    void store.ensureSocket();
  }
});

// 方便调试
window.__poker = { store, views, tag: (t, c, x) => tag(t, c, x) };
