import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const schemaFile = fileURLToPath(new URL('./schema.sql', import.meta.url));
/** 默认库文件：仓库根/var/2nkpoker.db（不想放仓库里就用 AUTH_DB_PATH 覆盖） */
const defaultPath = fileURLToPath(new URL('../../../../var/2nkpoker.db', import.meta.url));

/** @type {DatabaseSync|null} */
let db = null;
let openedPath = '';

/**
 * 打开（并初始化）用户库。重复调用同路径直接复用；换路径会先关旧的。
 * @param {string} [path] 文件路径，或 ':memory:'（测试用）
 * @returns {DatabaseSync}
 */
export function initDb(path = process.env.AUTH_DB_PATH || defaultPath) {
  path = path || process.env.AUTH_DB_PATH || defaultPath;
  if (db && path === openedPath) return db;
  if (db) {
    db.close();
    db = null;
  }
  openedPath = path;
  if (path !== ':memory:') {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    db = new DatabaseSync(abs);
  } else {
    db = new DatabaseSync(':memory:');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(schemaFile, 'utf8'));
  return db;
}

/**
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (!db) return initDb();
  return db;
}

/** 测试/退出时用 */
export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
  db = null;
  openedPath = '';
}

/** @returns {string} 当前打开的库路径 */
export function currentDbPath() {
  return openedPath;
}
