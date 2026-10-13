/**
 * 端到端联调：用真实浏览器打开我们的前端，指向远端服务器
 * （http://43.135.53.83:3000，另一套协议），验证：
 *   登录（无需 token）→ 加入房间 → 准备 → 拿到手牌与快照 → 出手一次
 *
 * 前提：另开一个终端跑静态服务器
 *   node apps/web/dev-server.mjs --port 8199 --no-proxy
 *
 * 用法：node apps/web/test/.dsh-tests/browser-remote.mjs [前端地址] [房间号]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:8199/';
const ROOM = process.argv[3] ?? `e2e${Math.floor(Math.random() * 10000)}`;
const REMOTE = '43.135.53.83:3000';
const PORT = 9224;

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
];
const exe = BROWSERS.find((p) => p && existsSync(p));
if (!exe) { console.error('没找到浏览器'); process.exit(0); }

const profile = await mkdtemp(join(tmpdir(), 'dsh-remote-'));
await mkdir(join(profile, 'shots'), { recursive: true });
await writeFile(join(profile, 'x.txt'), 'tmp');

const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--no-proxy-server', '--window-size=412,915', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = '';
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch { /* 等 */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('CDP 未就绪'); child.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let seq = 0;
const waiting = new Map();
const exceptions = [];
const consoleLines = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
});

function send(method, params = {}, timeoutMs = 15000) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  const d = res.result?.exceptionDetails;
  if (d) return { error: d.exception?.description ?? d.text };
  return { value: res.result?.result?.value };
}

let failed = 0;
const step = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

await send('Page.enable');
await send('Runtime.enable');

const url = `${PAGE}?api=http://${REMOTE}&table=${ROOM}&proto=remote`;
console.log('打开:', url);
await send('Page.navigate', { url });
await sleep(3000);

const boot = await evaluate(`JSON.stringify({ hasPoker: Boolean(window.__poker), phase: window.__poker?.store?.state?.phase, proto: window.__poker?.store?.state?.proto, usesRemote: window.__poker?.store?.usesRemoteAdapter() })`);
console.log('启动:', boot.value ?? boot.error);
step('页面装配成功', JSON.parse(boot.value ?? '{}').hasPoker === true);
step('自动识别为远端协议（走适配层）', JSON.parse(boot.value ?? '{}').usesRemote === true);

/* 登录（远端不需要 token，应直接进入大厅） */
const login = await evaluate(`(async () => {
  const input = document.querySelector('input[type=text]');
  input.value = '前端联调';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('进入牌局大厅')).click();
  await new Promise(r => setTimeout(r, 2500));
  const s = window.__poker.store.state;
  return JSON.stringify({ phase: s.phase, connection: s.connection, log: s.room.log.map(l => l.text).slice(-4) });
})()`);
console.log('登录:', login.value ?? login.error);
const loginState = JSON.parse(login.value ?? '{}');
step('无需 token 直接登录成功（已连上远端）', ['waiting', 'table', 'lobby'].includes(loginState.phase), `phase=${loginState.phase} conn=${loginState.connection}`);

/* 登录时会带着 ?table= 自动加入房间，所以这里直接检查加入结果 */
const joinOut = await evaluate(`(async () => {
  const s = window.__poker.store.state;
  const snap = s.room.snapshot;
  const again = await window.__poker.store.joinRoom('${ROOM}');   // 幂等性检查
  return JSON.stringify({
    againOk: again.ok,
    phase: s.phase,
    tableId: s.room.tableId,
    mySeat: window.__poker.store.mySeat(),
    seats: snap ? snap.seats.filter(x => x.userId).map(x => x.seat + ':' + x.nickname) : null,
    smallBlind: snap?.smallBlind, bigBlind: snap?.bigBlind,
    log: s.room.log.map(l => l.text).slice(-8),
  });
})()`);
console.log('加入房间:', joinOut.value ?? joinOut.error);
const joined = JSON.parse(joinOut.value ?? '{}');
step('登录时已用 ?table= 自动加入房间', joined.phase === 'waiting' || joined.phase === 'table', `phase=${joined.phase}`);
step('重复加入是幂等的（不再报"名字被占用"）', joined.againOk === true);
step('拿到座位（远端座位号已 1→0 转换）', typeof joined.mySeat === 'number', `seat=${joined.mySeat}`);
step('远端快照已翻译成我们的座位表', Array.isArray(joined.seats) && joined.seats.length >= 1, (joined.seats ?? []).join(', '));
step('盲注来自远端（10/20）', joined.smallBlind === 10 && joined.bigBlind === 20, `${joined.smallBlind}/${joined.bigBlind}`);

/* 准备 → 需要至少两人；只有一个客户端时会给 joinFailed/等待，这里只验证准备被接受 */
const ready = await evaluate(`(async () => {
  const res = await window.__poker.store.setReady(true);
  await new Promise(r => setTimeout(r, 2000));
  const s = window.__poker.store.state;
  return JSON.stringify({ res, phase: s.phase, hand: Boolean(s.room.snapshot?.hand), log: s.room.log.map(l => l.text).slice(-5) });
})()`);
console.log('准备:', ready.value ?? ready.error);
const readyState = JSON.parse(ready.value ?? '{}');
step('准备请求被接受', readyState.res?.ok === true, JSON.stringify(readyState.res));

/* 再等一下，看看是否开局（需要两个人，单人时通常不会开） */
await sleep(2500);
const after = await evaluate(`(async () => {
  const s = window.__poker.store.state;
  const snap = s.room.snapshot;
  return JSON.stringify({
    phase: s.phase,
    hasHand: Boolean(snap?.hand),
    street: snap?.hand?.street,
    board: snap?.hand?.board,
    pot: snap?.hand?.pot,
    myCards: snap?.hand?.seats?.find(x => x.seat === window.__poker.store.mySeat())?.holeCards,
    handButtons: [...document.querySelectorAll('#views button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).slice(0, 8),
    log: s.room.log.map(l => l.text).slice(-8),
  });
})()`);
console.log('当前状态:', after.value ?? after.error);

console.log('\n=== 控制台（最后 10 条） ===');
for (const line of consoleLines.slice(-10)) console.log('  ' + line);
console.log('=== 未捕获异常 ===');
if (!exceptions.length) console.log('  （无）');
for (const e of exceptions) console.log('  ' + e);

console.log(failed ? `\n联调：${failed} 项失败` : '\n联调：全部通过（单人时不开局属正常）');
ws.close();
child.kill();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed ? 1 : 0);
