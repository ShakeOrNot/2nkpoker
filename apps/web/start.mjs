#!/usr/bin/env node
/**
 * 一键启动脚本：把需要的服务都拉起来，并做一次开箱自检。
 *
 *   node apps/web/start.mjs                # 只起前端（8080），后端不在也能玩离线练习
 *   node apps/web/start.mjs --with-server  # 连后端一起起（需要依赖装好）
 *   node apps/web/start.mjs --port 9000
 *
 * 为什么要这个脚本：
 *   1. 页面用的是原生 ES modules，必须通过 http 打开，file:// 会被浏览器拒绝；
 *   2. 前端服务器进程如果跟着终端一起退出，页面就会 ERR_CONNECTION_REFUSED，
 *      表现和"点了没反应"一模一样，所以这里会把关键信息打印清楚。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/**
 * 启动前自检：找不到项目文件时给出人话提示，而不是让 node 抛一堆 MODULE_NOT_FOUND。
 * （最常见的原因是"在错误的目录里执行了 node apps/web/start.mjs"）
 */
function verifyLayout() {
  const problems = [];
  if (!existsSync(join(here, 'dev-server.mjs'))) problems.push(`missing script dir: ${here}`);
  if (!existsSync(join(repoRoot, 'package.json'))) problems.push(`missing project root: ${repoRoot}`);
  if (!existsSync(join(here, 'public', 'index.html'))) problems.push(`missing page: ${join(here, 'public', 'index.html')}`);
  if (!problems.length) return;

  console.error('\n[error] project files not found or wrong layout\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nRun it from the project root (the folder that contains apps/ and packages/):');
  console.error('    cd /d F:\\2nkpoker\\2nkpoker');
  console.error('    node apps\\web\\start.mjs --port 8080');
  console.error('\nAn absolute path also works from any folder:');
  console.error('    node F:\\2nkpoker\\2nkpoker\\apps\\web\\start.mjs --port 8080');
  console.error('\nEasiest: double-click  启动前端.cmd  in the project root (it cd\'s by itself).');
  console.error('\ncwd: ' + process.cwd());
  console.error('script dir: ' + here);
  process.exit(1);
}

verifyLayout();

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WEB_PORT = Number(flag('--port', process.env.WEB_PORT ?? 8080));
const GAME_PORT = Number(flag('--game-port', process.env.PORT ?? 3001));
/**
 * 前端要代理到哪台后端。
 * 默认远端那台（已验证可用）；本仓库的 game-server 要先 pnpm install 才能起，
 * 所以 --with-server 时自动改回本机 3001。
 */
const withServer = args.includes('--with-server');
const PROXY_TARGET = flag('--target', process.env.GAME_SERVER ?? (withServer ? `http://127.0.0.1:${GAME_PORT}` : 'http://43.135.53.83:3000'));

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

/**
 * @param {string} label
 * @param {string[]} command
 * @param {string} cwd
 * @param {Record<string, string>} [env]
 */
function start(label, command, cwd, env = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.log(`[${label}] 退出 code=${code ?? ''} signal=${signal ?? ''}`);
    if (label === '前端') {
      console.log('[前端] 服务停了，页面会变成"连不上"（ERR_CONNECTION_REFUSED）。按 Ctrl+C 结束全部。');
    }
  });
  children.push(child);
  return child;
}

/** 端口是否被占用 */
function portBusy(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(true));
    probe.once('listening', () => probe.close(() => resolvePort(false)));
    probe.listen(port, '0.0.0.0');
  });
}

const webBusy = await portBusy(WEB_PORT);
if (webBusy) {
  console.log(`[warn] port ${WEB_PORT} is already in use - if a server is already running, just open it; otherwise use --port.`);
}

// 注意：这里刻意只用 ASCII 输出。
// Windows 控制台默认是 GBK，直接打印中文会变成乱码；
// 中文提示统一放在 启动前端.cmd（它用 chcp 65001 切到 UTF-8）里显示。
console.log('2nkpoker web starting');
console.log(`  static dir : ${join(here, 'public')}`);
console.log(`  page       : http://localhost:${WEB_PORT}`);
console.log(`  api proxy  : ${PROXY_TARGET}  (/api/* and /socket.io/*)`);

const node = process.execPath;
start('web', [node, join(here, 'dev-server.mjs'), '--port', String(WEB_PORT), '--target', PROXY_TARGET], repoRoot);

if (withServer) {
  const serverEntry = join(repoRoot, 'apps', 'game-server', 'src', 'server.js');
  if (!existsSync(serverEntry)) {
    console.log('[warn] apps/game-server/src/server.js not found, skip backend');
  } else {
    console.log('starting game-server (requires pnpm install)');
    start('server', [node, '--env-file=.env', serverEntry], join(repoRoot, 'apps', 'game-server'), { PORT: String(GAME_PORT) });
  }
}

console.log('\nOpen the page address above. Phone: same Wi-Fi, replace localhost with this PC LAN IP.');
console.log('No backend? On the login page open "server settings" and turn on offline practice mode.');
console.log('Press Ctrl+C to stop.\n');

const shutdown = () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
