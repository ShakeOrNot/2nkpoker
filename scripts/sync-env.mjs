#!/usr/bin/env node
/**
 * 把 env.shared 里的行为参数同步到目标 .env（默认仓库根 .env）。
 * - 只更新/追加 env.shared 里出现的键
 * - 保留目标文件里的其他行、注释和密钥
 * - 更新前备份为 .env.bak
 *
 * 用法：
 *   node scripts/sync-env.mjs                 # 同步本地 .env
 *   node scripts/sync-env.mjs /srv/2nkpoker/.env
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const sourcePath = resolve(root, 'env.shared');
const targetPath = resolve(process.argv[2] ?? resolve(root, '.env'));

if (!existsSync(sourcePath)) {
  console.error(`找不到 ${sourcePath}`);
  process.exit(1);
}
if (!existsSync(targetPath)) {
  console.error(`找不到 ${targetPath}（先 cp .env.example .env）`);
  process.exit(1);
}

const readPairs = (text) => {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
};

const desired = readPairs(readFileSync(sourcePath, 'utf8'));
const original = readFileSync(targetPath, 'utf8');
const lines = original.split(/\r?\n/);
const seen = new Set();
const result = lines.map((line) => {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
  if (!m) return line;
  const key = m[1];
  if (!desired.has(key)) return line;
  seen.add(key);
  return `${key}=${desired.get(key)}`;
});
for (const [key, value] of desired) {
  if (!seen.has(key)) result.push(`${key}=${value}`);
}

const next = result.join('\n');
if (next === original) {
  console.log(`已是最新：${targetPath}`);
} else {
  copyFileSync(targetPath, `${targetPath}.bak`);
  writeFileSync(targetPath, next);
  console.log(`已同步 ${targetPath}（备份 ${targetPath}.bak）`);
}
for (const [key, value] of desired) console.log(`  ${key}=${value}`);
