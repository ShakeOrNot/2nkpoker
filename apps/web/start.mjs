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

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WEB_PORT = Number(flag('--port', process.env.WEB_PORT ?? 8080));
const GAME_PORT = Number(flag('--game-port', process.env.PORT ?? 3001));
const withServer = args.includes('--with-server');

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
  console.log(`端口 ${WEB_PORT} 已被占用——如果就是之前起的服务，直接访问即可；否则换 --port。`);
}

console.log('启动 2nkpoker 前端');
console.log(`  静态目录: ${join(here, 'public')}`);
console.log(`  页面地址: http://localhost:${WEB_PORT}`);
console.log(`  后端代理: http://127.0.0.1:${GAME_PORT}  (/api/* 与 /socket.io/*)`);

const node = process.execPath;
start('前端', [node, join(here, 'dev-server.mjs'), '--port', String(WEB_PORT), '--target', `http://127.0.0.1:${GAME_PORT}`], repoRoot);

if (withServer) {
  const serverEntry = join(repoRoot, 'apps', 'game-server', 'src', 'server.js');
  if (!existsSync(serverEntry)) {
    console.log('[后端] 找不到 apps/game-server/src/server.js，跳过');
  } else {
    console.log('启动 game-server（需要依赖已安装）');
    start('后端', [node, '--env-file=.env', serverEntry], join(repoRoot, 'apps', 'game-server'), { PORT: String(GAME_PORT) });
  }
}

console.log('\n打开上面的页面地址即可。手机访问：让手机与电脑同一 Wi-Fi，用电脑的局域网 IP 换掉 localhost。');
console.log('后端没起也没关系：登录页展开「服务器与高级设置」→ 打开「离线练习模式」，用内置对手引擎照样能玩。');
console.log('按 Ctrl+C 结束。\n');

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
