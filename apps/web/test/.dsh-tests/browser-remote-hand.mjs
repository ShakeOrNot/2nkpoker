/**
 * 双人端到端联调：浏览器里的我们（协议适配层） + Node 里的对手（原生协议），
 * 在真实远端服务器上打完整一手，验证：
 *   加入 → 准备 → 开局（手牌翻译）→ 我出手 → 结算（showdownResult 翻译成我们的结果）
 *
 * 前提：静态服务器已启动
 *   node apps/web/dev-server.mjs --port 8199 --no-proxy
 *
 * 用法：node apps/web/test/.dsh-tests/browser-remote-hand.mjs [前端地址]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePlayer, sleep } from './remote-player.mjs';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:8199/';
const BASE = 'http://43.135.53.83:3000';
const ROOM = `hand${Math.floor(Math.random() * 10000)}`;
const PORT = 9225;

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

/* 1) 先用 Node 客户端占一个座位 */
const rival = new RemotePlayer({ baseUrl: BASE, roomId: ROOM, name: '对手' });
await rival.start({ ready: true });
step('Node 对手已入座', rival.seat != null, `seat=${rival.seat}`);

/* 2) 打开浏览器里的我们，并加入同一房间 */
const profile = await mkdtemp(join(tmpdir(), 'dsh-hand-'));
await mkdir(join(profile, 'shots'), { recursive: true });
await writeFile(join(profile, 'x.txt'), 'tmp');
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
const exceptions = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});
function send(method, params = {}, timeoutMs = 20000) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, timeoutMs = 20000) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
  const d = res.result?.exceptionDetails;
  if (d) {
    console.log('  [页面内报错]', d.exception?.description ?? d.text, '|', JSON.stringify(d.exception?.preview ?? {}));
    return { error: d.exception?.description ?? d.text };
  }
  if (res.error) console.log('  [CDP 错误]', res.error);
  return { value: res.result?.result?.value, description: res.result?.result?.description };
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${PAGE}?api=${encodeURIComponent(BASE)}&table=${ROOM}&proto=remote` });
await sleep(2500);

const login = await evaluate(`(async () => {
  const input = document.querySelector('input[type=text]');
  input.value = '我';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('进入牌局大厅')).click();
  await new Promise(r => setTimeout(r, 2500));
  return JSON.stringify({ phase: window.__poker.store.state.phase, seat: window.__poker.store.mySeat() });
})()`);
console.log('  浏览器登录:', login.value ?? login.error);
const loginState = JSON.parse(login.value ?? '{}');
step('浏览器端已入座', typeof loginState.seat === 'number', `seat=${loginState.seat}`);

/* 3) 双方准备 → 应该自动开局 */
const readyOut = await evaluate(`(async () => {
  const res = await window.__poker.store.setReady(true);
  const ok = await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const s = window.__poker.store.state;
      if (s.room.snapshot?.hand) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > 8000) { clearInterval(timer); resolve(false); }
    }, 100);
  });
  const s = window.__poker.store.state;
  const snap = s.room.snapshot;
  const me = snap?.hand?.seats?.find(x => x.seat === window.__poker.store.mySeat());
  return JSON.stringify({
    readyRes: res, started: ok, phase: s.phase,
    street: snap?.hand?.street, pot: snap?.hand?.pot,
    community: snap?.hand?.board, myCards: me?.holeCards,
    seats: snap?.hand?.seats?.map(x => x.seat + ':' + x.nickname + ':' + x.chips + (x.folded ? ':F' : '')),
  });
})()`);
console.log('  开局:', readyOut.value ?? readyOut.error);
const started = JSON.parse(readyOut.value ?? '{}');
step('双方准备后自动开局', started.started === true, `phase=${started.phase} street=${started.street}`);
step('我的底牌已翻译成我们的格式（如 As / Td）', Array.isArray(started.myCards) && started.myCards.length === 2 && started.myCards.every((c) => /^[2-9TJQKA][shdc]$/.test(c)), JSON.stringify(started.myCards));
step('底池与座位来自远端', Number(started.pot) >= 30 && Array.isArray(started.seats) && started.seats.length === 2, `pot=${started.pot}`);

/* 4) 轮到我时出手一次，然后陪对手打完整手 */
/* 4) 轮到我时出手，同时驱动 Node 对手，直到分出结果 */
let opponentStopped = false;
const driveOpponent = (async () => {
  while (!opponentStopped) {
    await rival.actIfMyTurn();
    await sleep(120);
  }
})();

const playOut = await evaluate(`(async () => {
  const store = window.__poker.store;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let actions = 0;
  const usedTypes = [];
  const errors = [];
  const started = Date.now();
  let overlaySeen = false;
  let overlaySeenText = '';
  let quickSample = [];
  let quickCtx = { quicks: [], maxTarget: 0 };
  const started2 = Date.now();
  try {
    while (Date.now() - started < 45000) {
      // 结算浮层只显示几秒，这里持续采样，确认它真的出现过
      const overlay = document.querySelector('.result-overlay');
      if (overlay?.classList.contains('visible')) {
        overlaySeen = true;
        overlaySeenText = overlay.textContent.slice(0, 140);
      }
      const hand = store.state.room.snapshot?.hand;
      if (store.state.room.lastResult && overlaySeen && Date.now() - started2 > 800) break;
      if (!hand || hand.settled) { await sleep(200); continue; }
      const mySeat = store.mySeat();
      const me = hand.seats.find(x => x.seat === mySeat);
      if (hand.currentTurnSeat === mySeat && me && !me.folded && !me.allIn) {
        const ctx = store.actionContext();
        // 第一次轮到我时，把操作栏上的快捷下注按钮采下来（结算后就隐藏了）
        if (!quickSample.length) {
          quickSample = [...document.querySelectorAll('.ctrl-quicks .chip')].map((b) => b.textContent.trim());
          quickCtx = { quicks: ctx.quicks.map((q) => q.key + '=' + q.amount), maxTarget: ctx.maxTarget };
        }
        const toCall = Math.max(0, hand.currentBet - me.betThisStreet);
        let action;
        if (actions === 0 && ctx.legal.includes('raise') && ctx.maxTarget > hand.currentBet) {
          action = { type: 'raise', amount: Math.min(hand.currentBet + hand.minRaise, ctx.maxTarget) };
        } else if (toCall === 0) {
          action = { type: 'check' };
        } else {
          action = { type: 'call' };
        }
        const res = await store.act(action);
        usedTypes.push(action.type + (res.ok ? '' : '!' + (res.code || res.message || '?')));
        if (res.ok) actions++;
        await sleep(300);
      } else {
        await sleep(150);
      }
    }
  } catch (err) {
    errors.push(String(err && err.stack || err));
  }
  const s = store.state;
  return JSON.stringify({
    actions, usedTypes, errors,
    phase: s.phase,
    lastResult: s.room.lastResult ? {
      pots: s.room.lastResult.result?.pots,
      payouts: s.room.lastResult.result?.payouts,
      board: s.room.lastResult.board,
    } : null,
    log: s.room.log.map(l => l.text).slice(-10),
    overlaySeen, overlaySeenText,
    quickLabels: quickSample, quickCtx,
    overlayVisible: document.querySelector('.result-overlay')?.classList.contains('visible') ?? false,
    overlayText: document.querySelector('.result-card')?.textContent?.slice(0, 160) ?? '',
  });
})()`, 60000);   // 浏览器脚本最长跑 45 秒，CDP 必须等得起

opponentStopped = true;
await driveOpponent;
console.log('  对手出手记录:', rival.timeline.filter((t) => t.event === 'gameState').length, '个状态更新，错误:', rival.errors);
console.log('  对局:', playOut.value ?? playOut.error);
const played = JSON.parse(playOut.value ?? '{}');

/* 诊断：结算刚结束时浮层的真实状态 */
const overlayDebug = await evaluate(`(() => {
  const el = document.querySelector('.result-overlay');
  const s = window.__poker.store.state;
  return JSON.stringify({
    exists: Boolean(el),
    cls: el ? el.className : null,
    display: el ? getComputedStyle(el).display : null,
    inDom: el ? document.body.contains(el) : null,
    parentActive: el?.closest('.view')?.className ?? null,
    dismissFlag: s.room.dismissResult,
    hasLastResult: Boolean(s.room.lastResult),
  });
})()`);
console.log('  浮层诊断:', overlayDebug.value ?? overlayDebug.error);

/* 打开 renderResult 的调试日志，再触发一次渲染看分支 */
const debugOut = await evaluate(`(async () => {
  const view = window.__poker.views.table;
  const seen = [];
  const origLog = console.log;
  console.log = (...args) => { seen.push(args.join(' ')); origLog(...args); };
  // 直接清掉"已收起"标记并手动触发一次结算渲染，同时记录异常
  try {
    view.resultDismissedFor = '';
    view._dbg = true;
    const state = window.__poker.store.state;
    seen.push('state: hasLastResult=' + Boolean(state.room.lastResult)
      + ' handSettled=' + Boolean(state.room.snapshot?.hand?.settled)
      + ' snapshotHand=' + Boolean(state.room.snapshot?.hand)
      + ' seats=' + (state.room.snapshot?.hand?.seats?.length ?? 0));
    view.render(state);
  } catch (err) {
    seen.push('THREW: ' + (err && err.stack || err));
  }
  await new Promise(r => setTimeout(r, 100));
  console.log = origLog;
  const el = document.querySelector('.result-overlay');
  return JSON.stringify({ logs: seen.slice(-6), cls: el?.className, display: el ? getComputedStyle(el).display : null });
})()`);
console.log('  renderResult 分支:', debugOut.value ?? debugOut.error);
step('我在浏览器里成功出手', played.actions > 0, `次数=${played.actions} 类型=${(played.usedTypes ?? []).join(',')}`);
step('打到结算并翻译出结果', Boolean(played.lastResult), JSON.stringify(played.lastResult?.pots ?? null));
step('桌面上出现过结算浮层', played.overlaySeen === true, (played.overlaySeenText ?? '').slice(0, 100));
step('结算里的公共牌也是我们的格式', (played.lastResult?.board ?? []).every((c) => /^[2-9TJQKA][shdc]$/.test(c)), JSON.stringify(played.lastResult?.board));

/* 快捷下注按钮：轮到我时采到的操作栏按钮 */
const labels = played.quickLabels ?? [];
const quicks = played.quickCtx?.quicks ?? [];
console.log('  快捷下注按钮:', JSON.stringify({ labels, quicks, maxTarget: played.quickCtx?.maxTarget }));
if (labels.length) {
  step('操作栏含「1/3 池」按钮', labels.some((l) => l.startsWith('1/3 池')), labels.join(' | '));
  step('操作栏含「1.2 池」按钮', labels.some((l) => l.startsWith('1.2 池')));
  step(
    '所有快捷金额都不超过筹码上限',
    quicks.every((q) => Number(String(q).split('=')[1]) <= (played.quickCtx?.maxTarget ?? 0)),
    `上限=${played.quickCtx?.maxTarget}`,
  );
} else {
  step('采到操作栏快捷按钮', false, '轮到我时没采到');
}

console.log('\n  === 浏览器未捕获异常 ===');
if (!exceptions.length) console.log('  （无）');
for (const e of exceptions) console.log('  ' + e);

console.log(failed ? `\n双人联调：${failed} 项失败` : '\n双人联调：全部通过');
ws.close();
child.kill();
rival.close();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed ? 1 : 0);
