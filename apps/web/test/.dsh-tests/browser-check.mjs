/**
 * 用真实浏览器（Edge/Chrome，无头）打开页面，抓取控制台异常与未捕获错误，
 * 然后模拟真实点击：登录 → 创建牌局 → 坐下 → 准备，并在每一步截图。
 *
 * 用法：node apps/web/test/.dsh-tests/browser-check.mjs [url]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:8099/';
const PORT = 9222;

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];

const exe = BROWSERS.find((p) => p && existsSync(p));
if (!exe) {
  console.error('没找到 Edge/Chrome，跳过真实浏览器检查');
  process.exit(0);
}

if (typeof WebSocket !== 'function') {
  console.error('当前 node 没有全局 WebSocket，无法使用 CDP');
  process.exit(0);
}

const profile = await mkdtemp(join(tmpdir(), 'dsh-browser-'));
const shots = join(profile, 'shots');
await mkdir(shots, { recursive: true });
await writeFile(join(profile, 'README.txt'), 'temporary profile');

const child = spawn(
  exe,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--no-proxy-server',
    '--disable-features=Translate,OptimizationGuideModelDownloading',
    '--window-size=412,915',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 就绪并连上页面 target */
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 继续等 */
    }
    await sleep(250);
  }
  throw new Error('浏览器调试端口没起来');
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const waiting = new Map();
const consoleLogs = [];
const exceptions = [];
const failedRequests = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLogs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push(`${d.exception?.description ?? d.text} @ ${d.url ?? ''}:${d.lineNumber ?? ''}`);
  }
  if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(`${msg.params.type} ${msg.params.errorText} ${msg.params.requestId}`);
  }
});

function send(method, params = {}, timeoutMs = 15000) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      console.error(`  [cdp 超时] ${method}`);
      resolve({ error: 'timeout' });
    }, timeoutMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text };
  }
  return { value: res.result?.result?.value };
}

async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const data = res.result?.data;
  if (!data) return;
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Log.enable');

console.log(`浏览器: ${exe}`);
console.log(`打开: ${URL_UNDER_TEST}`);
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(2500);

/* 页面是否真的跑起来了 / 有没有报错 */
const probe = await evaluate(`JSON.stringify({
  hasPoker: Boolean(window.__poker),
  views: window.__poker ? Object.keys(window.__poker.views) : null,
  phase: window.__poker?.store?.state?.phase ?? null,
  offline: window.__poker?.store?.state?.offline ?? null,
  viewsChildren: document.getElementById('views')?.children.length ?? -1,
  toolbarText: document.getElementById('toolbar')?.textContent ?? null,
  btnLabels: [...document.querySelectorAll('button')].map(b => b.textContent).slice(0, 12),
})`);

console.log('\n=== 初始状态 ===');
console.log(probe.value ?? probe.error);
const pageInfo = await evaluate(`JSON.stringify({
  url: location.href,
  title: document.title,
  bodyStart: document.body ? document.body.innerHTML.slice(0, 200) : null,
  scriptSrcs: [...document.querySelectorAll('script')].map(s => s.src),
})`);
console.log('页面信息:', pageInfo.value ?? pageInfo.error);
await shot('01-login');

if (!probe.value || JSON.parse(probe.value).hasPoker !== true) {
  console.log('\n!!! app.js 没有装配起来，后面的点击测试没有意义');
}

/* 关掉离线模式开关之外的干扰：直接打开离线模式 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('离线练习模式'));
  if (btn) { btn.click(); return 'clicked offline toggle'; }
  return 'offline toggle NOT FOUND';
})()`);
await sleep(300);

/* 直接走「离线练习」这条路：后端没起也能完整验证界面流程 */
const offlineRes = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('离线练习'));
  if (!btn) return 'offline button NOT FOUND';
  const input = document.querySelector('input[type=text]');
  if (input) { input.value = '浏览器测试'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  btn.click();
  return 'clicked offline practice';
})()`);
console.log('\n=== 离线练习登录 ===');
console.log(offlineRes.value ?? offlineRes.error);
await sleep(1500);
console.log(await evaluate(`JSON.stringify({ phase: window.__poker.store.state.phase, offline: window.__poker.store.state.offline, session: window.__poker.store.state.session?.nickname })`).then((r) => r.value ?? r.error));
await shot('02-lobby');

/* 点创建 */
const createRes = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建并进入等待室'));
  if (!btn) return 'create button NOT FOUND';
  if (btn.disabled) return 'create button DISABLED';
  btn.click();
  return 'clicked create';
})()`);
console.log('\n=== 创建牌局 ===');
console.log(createRes.value ?? createRes.error);
await sleep(1500);
console.log(await evaluate(`JSON.stringify({
  phase: window.__poker.store.state.phase,
  tableId: window.__poker.store.state.room.tableId,
  busy: window.__poker.store.state.busy,
  connection: window.__poker.store.state.connection,
  log: window.__poker.store.state.room.log.map(l => l.text).slice(-6),
  text: document.getElementById('views').textContent.slice(0, 160),
})`).then((r) => r.value ?? r.error));
await shot('03-after-create');

/* 点坐下 */
const sitRes = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '坐下');
  if (!btn) return 'sit button NOT FOUND';
  if (btn.disabled) return 'sit button DISABLED';
  btn.click();
  return 'clicked sit';
})()`);
console.log('\n=== 坐下 ===');
console.log(sitRes.value ?? sitRes.error);
await sleep(1200);
console.log(await evaluate(`JSON.stringify({
  seat: window.__poker.store.mySeat(),
  text: document.getElementById('views').textContent.slice(0, 160),
})`).then((r) => r.value ?? r.error));
await shot('04-waiting');

/* 点准备 */
const readyRes = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('准备开始'));
  if (!btn) return 'ready button NOT FOUND';
  if (btn.disabled) return 'ready button DISABLED';
  btn.click();
  return 'clicked ready';
})()`);
console.log('\n=== 准备 ===');
console.log(readyRes.value ?? readyRes.error);
await sleep(2500);
console.log(await evaluate(`JSON.stringify({
  phase: window.__poker.store.state.phase,
  hasHand: Boolean(window.__poker.store.state.room.snapshot?.hand),
  street: window.__poker.store.state.room.snapshot?.hand?.street,
  visibleViews: [...document.querySelectorAll('.view')].filter(v => getComputedStyle(v).display !== 'none').map(v => v.className),
  visibleButtons: [...document.querySelectorAll('#views button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean).slice(0, 10),
})`).then((r) => r.value ?? r.error));
await shot('05-table');

console.log('\n=== 控制台输出 ===');
for (const line of consoleLogs.slice(-25)) console.log('  ' + line);
console.log('\n=== 未捕获异常 ===');
if (!exceptions.length) console.log('  （无）');
for (const e of exceptions) console.log('  ' + e);
console.log('\n=== 资源加载失败 ===');
if (!failedRequests.length) console.log('  （无）');
for (const f of failedRequests.slice(0, 10)) console.log('  ' + f);
console.log(`\n截图目录: ${shots}`);

ws.close();
child.kill();
await sleep(400);
try {
  await rm(profile, { recursive: true, force: true });
} catch {
  /* 浏览器可能还没完全退出 */
}
process.exit(exceptions.length ? 1 : 0);
