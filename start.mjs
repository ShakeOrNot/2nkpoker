#!/usr/bin/env node
/**
 * 2nkpoker 唯一的启动入口：一条命令拉起后端 + 前端。
 *
 *   node start.mjs                 # 后端 3001 + 前端 8080
 *   node start.mjs --port 9000     # 换前端端口
 *   node start.mjs --game-port 4001
 *   node start.mjs --watch         # 后端改动自动重启（开发时用）
 *
 * 也可以双击仓库根目录的「启动.cmd」（会先切到 UTF-8 代码页再跑本脚本）。
 *
 * 两个窗口试玩：浏览器里开一个普通窗口 + 一个无痕窗口访问同一地址，
 * 它们各自有独立的登录态，才能坐成两个玩家。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));

/* ---------------- 运行环境自检 ---------------- */

{
  const [major, minor] = String(process.versions.node).split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`\n[错误] Node.js 版本太低（当前 ${process.versions.node}）`);
    console.error('  用户库用的是内置 node:sqlite，需要 Node ≥ 22.5（推荐 24 LTS）。');
    console.error('  升级后重试。\n');
    process.exit(1);
  }
}

/* ---------------- 配置 ---------------- */

// 与后端共用仓库根的同一份 .env
const envFile = join(root, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
} else if (!existsSync(envFile)) {
  console.error('\n[错误] 找不到 .env\n');
  console.error('  在仓库根目录执行：cp .env.example .env');
  console.error(`  期望位置：${envFile}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WEB_PORT = Number(flag('--port', process.env.WEB_PORT ?? 8080));
const GAME_PORT = Number(flag('--game-port', process.env.PORT ?? 3001));
const WATCH = args.includes('--watch');
const TARGET = `http://127.0.0.1:${GAME_PORT}`;

/* ---------------- 开箱自检 ---------------- */

function verifyLayout() {
  const problems = [];
  if (!existsSync(join(root, 'package.json'))) problems.push(`不是项目根目录：${root}`);
  if (!existsSync(join(root, 'apps', 'game-server', 'src', 'server.js'))) {
    problems.push('缺少后端入口 apps/game-server/src/server.js');
  }
  if (!existsSync(join(root, 'apps', 'web', 'dev-server.mjs'))) {
    problems.push('缺少前端服务 apps/web/dev-server.mjs');
  }
  if (!existsSync(join(root, 'apps', 'web', 'public', 'index.html'))) {
    problems.push('缺少前端页面 apps/web/public/index.html');
  }
  if (!existsSync(join(root, 'node_modules'))) problems.push('缺少 node_modules，请先执行 pnpm install');
  if (!problems.length) return;

  console.error('\n[错误] 启动自检没通过\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n请在项目根目录执行（含 apps/ 和 packages/ 的那一层）：');
  console.error('  pnpm install');
  console.error('  node start.mjs\n');
  process.exit(1);
}

/** 端口是否已被监听 */
function portBusy(port) {
  return new Promise((resolveBusy) => {
    const probe = createServer();
    probe.once('error', () => resolveBusy(true));
    probe.once('listening', () => probe.close(() => resolveBusy(false)));
    probe.listen(port, '0.0.0.0');
  });
}

/** 本机局域网 IPv4，手机同 Wi-Fi 访问用 */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/* ---------------- 子进程管理 ---------------- */

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

/**
 * @param {string} label
 * @param {string[]} command
 * @param {string} cwd
 * @param {Record<string, string>} [env] 额外的环境变量（覆盖 .env 里的同名项）
 */
function start(label, command, cwd, env = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[${label}] 意外退出 code=${code ?? ''} signal=${signal ?? ''}`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/* ---------------- 主流程 ---------------- */

verifyLayout();

if (await portBusy(WEB_PORT)) {
  console.log(`\n前端端口 ${WEB_PORT} 已经在监听——大概已经启动了。`);
  console.log(`直接打开：http://127.0.0.1:${WEB_PORT}\n`);
  console.log('要换端口：node start.mjs --port 9000');
  process.exit(0);
}

if (await portBusy(GAME_PORT)) {
  console.error(`\n[错误] 后端端口 ${GAME_PORT} 已被占用，先关掉占用的进程，或用 --game-port 换一个。\n`);
  process.exit(1);
}

const node = process.execPath;

start('后端', [
  node,
  ...(WATCH ? ['--watch'] : []),
  join(root, 'apps', 'game-server', 'src', 'server.js'),
], join(root, 'apps', 'game-server'), { PORT: String(GAME_PORT) });

start('前端', [
  node,
  join(root, 'apps', 'web', 'dev-server.mjs'),
  '--port', String(WEB_PORT),
  '--target', TARGET,
], root, { WEB_PORT: String(WEB_PORT) });

const lan = lanAddress();

console.log('');
console.log('  2nkpoker 已启动');
console.log('  ---------------------------------------------');
console.log(`  牌桌页面   http://127.0.0.1:${WEB_PORT}`);
if (lan) console.log(`  同一 Wi-Fi  http://${lan}:${WEB_PORT}   （手机用这个）`);
console.log(`  后端接口   ${TARGET}   （/health、/tables、/socket.io）`);
console.log('  ---------------------------------------------');
console.log('  两个人试玩：普通窗口 + 无痕窗口各开一个地址');
console.log('              （普通窗口的多个标签共用同一登录态，坐不成两个玩家）');
console.log('  离线试玩：  登录页点「离线练习（不需要后端）」');
console.log('  停止服务：  Ctrl+C');
console.log('');
