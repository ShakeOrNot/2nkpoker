// 本地美术验收入口，不随 public 静态目录发布。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const previewFile = new URL('./settlement-preview.html', import.meta.url);
const previewModules = new Map([
  ['/preview-flow.mjs', fileURLToPath(new URL('./preview-flow.mjs', import.meta.url))],
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = path === '/' ? fileURLToPath(previewFile) : previewModules.get(path) ?? resolve(publicRoot, `.${path}`);
    if (path !== '/' && !previewModules.has(path) && !file.startsWith(resolve(publicRoot) + sep)) {
      res.writeHead(403).end(); return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
}).listen(8081, '127.0.0.1', () => console.log('Settlement preview: http://127.0.0.1:8081/'));
