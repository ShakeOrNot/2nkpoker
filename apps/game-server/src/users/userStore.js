import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

/**
 * @typedef {Object} UserRow
 * @property {string} id
 * @property {string} nickname
 * @property {string} password_hash
 * @property {string} role
 * @property {number} token_version
 * @property {number} disabled
 * @property {number} created_at
 * @property {number|null} last_login_at
 */

/** 昵称即登录名：2~20 个字符，不能含空白/控制字符 */
export const NICKNAME_RE = /^[\p{L}\p{N}_-]{2,20}$/u;

/**
 * @param {string} nickname
 * @returns {boolean}
 */
export function isValidNickname(nickname) {
  return typeof nickname === 'string' && NICKNAME_RE.test(nickname);
}

/**
 * 只在对外输出时用的安全字段（绝不带 password_hash）
 * @param {UserRow|null|undefined} row
 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

/**
 * 建号；昵称冲突会抛错（由调用方转成 AUTH_USER_EXISTS）
 * @param {{ nickname: string, passwordHash: string, role?: string }} input
 * @returns {UserRow}
 */
export function createUser({ nickname, passwordHash, role = 'user' }) {
  const db = getDb();
  const row = {
    id: randomUUID(),
    nickname,
    password_hash: passwordHash,
    role,
    token_version: 0,
    disabled: 0,
    created_at: Date.now(),
    last_login_at: null,
  };
  db.prepare(
    `INSERT INTO users (id, nickname, password_hash, role, token_version, disabled, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.nickname, row.password_hash, row.role, row.token_version, row.disabled, row.created_at, row.last_login_at);
  return /** @type {UserRow} */ (row);
}

/**
 * @param {string} nickname
 * @returns {UserRow|null}
 */
export function findByNickname(nickname) {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE nickname = ? COLLATE NOCASE')
    .get(String(nickname));
  return /** @type {UserRow|null} */ (row ?? null);
}

/**
 * @param {string} id
 * @returns {UserRow|null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(String(id));
  return /** @type {UserRow|null} */ (row ?? null);
}

/**
 * @param {string} userId
 * @param {number} [at]
 */
export function touchLogin(userId, at = Date.now()) {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, userId);
}

/**
 * 改口令：同时把 token_version +1（旧的 access/refresh 立即失效）
 * @param {string} userId
 * @param {string} passwordHash
 * @returns {number} 新的 token_version
 */
export function updatePassword(userId, passwordHash) {
  const db = getDb();
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
    passwordHash,
    userId,
  );
  const row = findById(userId);
  return row ? row.token_version : 0;
}

/**
 * @param {string} userId
 * @returns {number} 新的 token_version
 */
export function bumpTokenVersion(userId) {
  const db = getDb();
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
  const row = findById(userId);
  return row ? row.token_version : 0;
}

/**
 * @param {string} userId
 * @param {number} disabled 0/1
 */
export function setDisabled(userId, disabled) {
  getDb().prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
}

/**
 * @param {string} userId
 * @param {string} role
 */
export function setRole(userId, role) {
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

/**
 * @param {number} [limit]
 * @returns {UserRow[]}
 */
export function listUsers(limit = 100) {
  return /** @type {UserRow[]} */ (
    getDb().prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT ?').all(limit)
  );
}
