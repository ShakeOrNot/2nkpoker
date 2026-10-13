/**
 * CDP 探针：连到已经跑着的无头浏览器，或者自己起一个，
 * 然后对页面做任意 DOM 查询（比改主检查脚本更快）。
 *
 * 用法：node apps/web/test/.dsh-tests/cdp-probe.mjs '<js 表达式>'
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const URL_UNDER_TEST = process.env.PROBE_URL ?? 'http://127.0.0.1:8099/';
const PORT = Number(process.env.PROBE_PORT ?? 9223);
const steps = JSON.parse(process.env.PROBE_STEPS ?? '[]');

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
];
const exe = BROWSERS.find((p) => p && existsSync(p));
if (!exe) process.exit(0);

const profile = await mkdtemp(join(tmpdir(), 'dsh-probe-'));
await mkdir(join(profile, 'shots'), { recursive: true });

const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disabled-features=Translate',
  '--window-size=412,915',
  'about:blank',
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
if (!wsUrl) { console.error('CDP 没起来'); child.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let seq = 0;
const waiting = new Map();
const exceptions = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(2500);

for (const step of steps) {
  if (step.wait) await sleep(step.wait);
  const out = await evaluate(step.js);
  console.log(`\n--- ${step.label ?? ''} ---`);
  console.log(out.value ?? out.error);
}

if (exceptions.length) {
  console.log('\n=== 未捕获异常 ===');
  for (const e of exceptions) console.log(e);
}

ws.close();
child.kill();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
