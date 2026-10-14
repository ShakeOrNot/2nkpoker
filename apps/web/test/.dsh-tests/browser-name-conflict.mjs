/**
 * 端到端验证：同名加入时，界面上应提示"昵称已被占用"，而不是"牌局已坐满"。
 * 前提：静态服务器已启动（默认 8080/8081 均可）
 * 用法：node apps/web/test/.dsh-tests/browser-name-conflict.mjs [页面地址]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePlayer, sleep } from './remote-player.mjs';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:8081/';
const BASE = 'http://43.135.53.83:3000';
const ROOM = `dup${Math.floor(Math.random() * 9000 + 1000)}`;
const SHARED_NAME = '同名联调';
const PORT = 9227;

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
];
const exe = BROWSERS.find((p) => p && existsSync(p));
if (!exe) { console.error('没找到浏览器'); process.exit(0); }

let failed = 0;
const step = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

/* 1) Node 端先用这个昵称占住座位 */
const rival = new RemotePlayer({ baseUrl: BASE, roomId: ROOM, name: SHARED_NAME });
await rival.start({ ready: false });
step('Node 端先用同名占住座位', rival.seat != null, `seat=${rival.seat}`);

/* 2) 浏览器用同一个昵称加入，应该被拒绝 */
const profile = await mkdtemp(join(tmpdir(), 'dsh-dup-'));
await mkdir(join(profile, 'x'), { recursive: true });
await writeFile(join(profile, 'x', 'a.txt'), 'tmp');
const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--no-proxy-server', '--window-size=412,915', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch { /* 等 */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('CDP 未就绪'); child.kill(); rival.close(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
function send(method, params = {}, timeoutMs = 20000) {
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${PAGE}?api=${encodeURIComponent(BASE)}&table=${ROOM}&proto=remote` });
await sleep(2500);

/* 3) 用同一个昵称登录 → 应被远端拒绝，并给出"昵称被占用"提示 */
const out = await evaluate(`(async () => {
  const input = document.querySelector('input[type=text]');
  input.value = ${JSON.stringify(SHARED_NAME)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('进入牌局大厅')).click();
  await new Promise(r => setTimeout(r, 2500));
  const s = window.__poker.store.state;
  return JSON.stringify({
    phase: s.phase,
    seat: window.__poker.store.mySeat(),
    log: s.room.log.map(l => l.text).slice(-5),
    banner: document.getElementById('error-banner')?.textContent ?? '',
    bannerVisible: document.getElementById('error-banner')?.classList.contains('visible') ?? false,
  });
})()`);
console.log('  同名加入结果:', out.value ?? out.error);
const r = JSON.parse(out.value ?? '{}');

const allText = [r.banner, ...(r.log ?? [])].join(' | ');
step('没有坐到座位上（同名被正确拒绝）', r.seat == null, `seat=${r.seat}`);
step('提示里出现"名字/昵称被占用"的真实原因', /名字|昵称/.test(allText), allText.slice(0, 120));
step('不再误报"牌局已坐满"', !/已坐满/.test(r.banner ?? ''), `banner=${(r.banner ?? '').slice(0, 80)}`);

/* 4) 换个昵称应能正常加入（失败后仍在大厅；改昵称要同时改会话与已连接的适配层） */
const out2 = await evaluate(`(async () => {
  const store = window.__poker.store;
  const NEW_NAME = '另一个名字';
  store.state.session.nickname = NEW_NAME;
  if (store.socket) store.socket.playerName = NEW_NAME;
  const res = await store.joinRoom(${JSON.stringify(ROOM)});
  await new Promise(r => setTimeout(r, 1500));
  return JSON.stringify({
    joinRes: res,
    phase: store.state.phase,
    seat: store.mySeat(),
    log: store.state.room.log.map(l => l.text).slice(-4),
  });
})()`);
console.log('  换昵称加入:', out2.value ?? out2.error);
const r2 = JSON.parse(out2.value ?? '{}');
step('换一个昵称后能正常入座', typeof r2.seat === 'number', `seat=${r2.seat} phase=${r2.phase} join=${JSON.stringify(r2.joinRes)}`);

console.log(failed ? `\n同名场景联调：${failed} 项失败` : '\n同名场景联调：全部通过');
ws.close();
child.kill();
rival.close();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed ? 1 : 0);
