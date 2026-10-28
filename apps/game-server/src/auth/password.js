import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

/** scrypt 参数：N=2^15 大约 50~100ms，够挡住在线爆破又不会拖慢登录 */
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64, saltBytes: 16 });
const MAXMEM = 128 * 1024 * 1024;

/**
 * 口令策略：≥8 位、≤72 位、不能纯数字、不能和昵称相同。
 * @param {string} password
 * @param {string} [nickname]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkPasswordPolicy(password, nickname = '') {
  const pw = String(password ?? '');
  if (pw.length < PASSWORD_MIN) return { ok: false, reason: `口令至少 ${PASSWORD_MIN} 位` };
  if (pw.length > PASSWORD_MAX) return { ok: false, reason: `口令最多 ${PASSWORD_MAX} 位` };
  if (/^\d+$/.test(pw)) return { ok: false, reason: '口令不能是纯数字' };
  if (nickname && pw.toLowerCase() === String(nickname).toLowerCase()) {
    return { ok: false, reason: '口令不能和昵称相同' };
  }
  return { ok: true };
}

/**
 * 生成哈希串：scrypt$N$r$p$saltB64$hashB64（参数入库，将来能平滑升级）
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const pw = String(password ?? '');
  if (!pw) throw new Error('hashPassword: empty password');
  const { N, r, p, keylen, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const hash = /** @type {Buffer} */ (await scryptAsync(pw, salt, keylen, { N, r, p, maxmem: MAXMEM }));
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * 校验口令；任何异常（格式坏、参数不认）都当失败，不抛给上层。
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !salt.length || !expected.length) {
      return false;
    }
    const actual = /** @type {Buffer} */ (
      await scryptAsync(String(password ?? ''), salt, expected.length, { N, r, p, maxmem: MAXMEM })
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
