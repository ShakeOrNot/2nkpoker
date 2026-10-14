#!/usr/bin/env node
/**
 * 本地静态服务器（可选，零依赖）。
 *
 * 为什么需要它：
 *   1. 页面用的是原生 ESM（type="module"），file:// 直接打开会被浏览器拦；
 *   2. 手机访问电脑上的后端时，同源可以避免 CORS 与混合内容问题。
 *
 * 用法（默认不随项目启动，需要时手动跑）：
 *   node apps/web/dev-server.mjs
 *   node apps/web/dev-server.mjs --port 8080 --target http://127.0.0.1:3001
 *
 * 环境变量：WEB_PORT / GAME_SERVER
 *
 * 行为：
 *   /            → apps/web/public 下的静态文件
 *   /api/*       → 转发到后端（自动去掉 /api 前缀）
 *   /socket.io/* → 转发到后端（含 WebSocket 升级）
 */

import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, 'public');

// 启动前自检：给"路径不对/文件不全"这种问题一个人话提示，而不是一堆堆栈
if (!existsSync(join(ROOT, 'index.html')) || !existsSync(join(ROOT, 'js', 'app.js'))) {
  console.error('\n[error] front-end files not found\n');
  console.error('  expected: ' + join(ROOT, 'index.html'));
  console.error('  expected: ' + join(ROOT, 'js', 'app.js'));
  console.error('\nMake sure apps/web/public is complete (index.html, css/, js/).');
  console.error('script dir: ' + here);
  process.exit(1);
}

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const PORT = Number(argValue('--port', process.env.WEB_PORT ?? 8080));
// 默认代理到远端那台后端。本仓库的 game-server 要先 pnpm install 才能起，
// 默认值不能指向它：否则页面能打开，但所有 /api 与 /socket.io 都 502，
// 表现就是"前端连不上后端"。
const TARGET = new URL(argValue('--target', process.env.GAME_SERVER ?? 'http://43.135.53.83:3000'));
/** --no-proxy：纯静态服务器，页面直连「服务器与高级设置」里填的地址 */
const NO_PROXY = process.argv.includes('--no-proxy');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把请求路径映射到 public 目录内的文件，越界返回 null
 * @param {string} urlPath
 * @returns {string|null}
 */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, '');
  const full = resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

/**
 * 转发 HTTP 请求到后端
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function proxyHttp(req, res) {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const stripped = url.pathname.replace(/^\/api/, '') || '/';
  const options = {
    hostname: TARGET.hostname,
    port: TARGET.port || 80,
    method: req.method,
    path: `${stripped}${url.search}`,
    headers: { ...req.headers, host: TARGET.host },
  };

  const upstream = httpRequest(options, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `proxy failed: ${err.message}` }));
  });
  req.pipe(upstream);
}

/**
 * 转发 WebSocket 升级（socket.io 需要）
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
function proxyUpgrade(req, socket, head) {
  const upstream = createConnection({ host: TARGET.hostname, port: Number(TARGET.port || 80) }, () => {
    const headers = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

    const PROXY_PATHS = ['/api/', '/socket.io', '/health', '/ready', '/dev/', '/tables'];
  if (!NO_PROXY && PROXY_PATHS.some((p) => urlPath.startsWith(p))) {
    // /api/* 转发时会去掉前缀；/socket.io/* 原样转发（HTTP 轮询与 WebSocket 升级都要）
    proxyHttp(req, res);
    return;
  }

  let file = resolveFile(urlPath === '/' ? '/index.html' : urlPath);
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${urlPath}`);
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // 开发期强制回源校验，避免改完代码刷新还是旧文件
      'cache-control': 'no-store, must-revalidate',
      expires: '0',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!NO_PROXY && (req.url ?? '').startsWith('/socket.io')) proxyUpgrade(req, socket, head);
  else socket.destroy();
});

// 与 start.mjs 一致：这里只用 ASCII 输出，避免 Windows 控制台（GBK）下中文变乱码。
// 中文提示放在 启动前端.cmd 里显示。
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n[warn] port ${PORT} is already in use - maybe a web server is already running.\n` +
      `  - open http://localhost:${PORT} to check\n` +
      `  - or use another port: node apps/web/dev-server.mjs --port 8081\n` +
      `  - find the owner: netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error('[error] web server failed to start:', err?.message ?? err);
  }
  process.exit(1);
});

/**
 * 列出本机所有局域网 IPv4 地址（同一 Wi-Fi/网线下的设备用这些地址访问）
 * @returns {string[]}
 */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log(`2nkpoker web: http://localhost:${PORT}`);
  console.log(`static dir : ${ROOT}`);
  // 监听 0.0.0.0，所以同一局域网内的设备可以直接访问下面这些地址
  if (lan.length) {
    console.log('LAN access (same Wi-Fi, scan/open on phone):');
    for (const ip of lan) {
      console.log(`  http://${ip}:${PORT}`);
      console.log(`  http://${ip}:${PORT}/?api=${TARGET.origin}&table=abc123&proto=remote`);
    }
    if (lan.length > 1) console.log('  (pick the address on the same subnet as your phone)');
  } else {
    console.log('LAN access: no LAN IPv4 found (are you connected to Wi-Fi / a cable?)');
  }
  console.log(`firewall   : if a phone cannot open it, run this ONCE in an ADMIN prompt:`);
  console.log(`  netsh advfirewall firewall add rule name="2nkpoker-web-${PORT}" dir=in action=allow protocol=TCP localport=${PORT}`);
  console.log(`  (if even ping between the phone and this PC fails, the Wi-Fi/router blocks`);
  console.log(`   device-to-device traffic: use a phone hotspot or the remote backend instead)`);
  if (NO_PROXY) {
    console.log('proxy      : disabled (--no-proxy); the page talks directly to the address you configure in the UI');
  } else {
    console.log(`proxy      : ${TARGET.origin}`);
    console.log('  /api/*       -> backend (the /api prefix is stripped)');
    console.log('  /socket.io/* -> backend (HTTP polling + WebSocket upgrade)');
    console.log('  for the bundled game-server add: --target http://127.0.0.1:3001');
  }
  console.log(`phone: same Wi-Fi, replace localhost with this PC LAN IP`);
});
