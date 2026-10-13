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
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, 'public');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const PORT = Number(argValue('--port', process.env.WEB_PORT ?? 8080));
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

  if (!NO_PROXY && (urlPath.startsWith('/api/') || urlPath.startsWith('/socket.io'))) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`2nkpoker 前端: http://localhost:${PORT}`);
  console.log(`静态目录: ${ROOT}`);
  if (NO_PROXY) {
    console.log('代理: 已关闭（--no-proxy）—— 页面直连「服务器与高级设置」里填的地址');
  } else {
    console.log(`代理目标: ${TARGET.origin}`);
    console.log('  /api/*       → 后端（自动去掉 /api 前缀）');
    console.log('  /socket.io/* → 后端（HTTP 轮询 + WebSocket 升级）');
    console.log('  想连本仓库的 game-server：加 --target http://127.0.0.1:3001');
  }
  console.log('手机访问：让手机与电脑同一 Wi-Fi，用电脑局域网 IP 打开上面的地址');
});
