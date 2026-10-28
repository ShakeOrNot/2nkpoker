import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/** access token 有效期（毫秒），默认 15 分钟 */
export const ACCESS_TTL_MS = env.ACCESS_TTL_MS;

/**
 * @typedef {Object} JwtPayload
 * @property {string} sub      用户 id
 * @property {string} nickname 昵称（牌桌显示名，也是登录名）
 * @property {string} role     user | admin
 * @property {number} [tv]     账号 token_version（改密/重置后旧令牌失效）
 */

/**
 * 校验 JWT（握手时用）：只验签名/签发方/受众/有效期，不查库。
 * access token 只有 15 分钟，所以"改密后旧令牌还能用 15 分钟"是可接受的窗口。
 * @param {string} token
 * @returns {JwtPayload}
 */
export function verifyJwt(token) {
  return /** @type {JwtPayload} */ (
    jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    })
  );
}

/**
 * 登录成功后签发 access token（带 token_version，供 /auth/me、/auth/refresh 校验）
 * @param {{ id: string, nickname: string, role: string, tokenVersion: number }} user
 * @returns {string}
 */
export function signAccessToken(user) {
  return jwt.sign(
    {
      nickname: user.nickname,
      role: user.role,
      tv: user.tokenVersion,
    },
    env.JWT_SECRET,
    {
      subject: user.id,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: `${Math.floor(ACCESS_TTL_MS / 1000)}s`,
    },
  );
}

/**
 * 开发/脚本用：不查库、不带 token_version 的简易令牌（保留旧行为）。
 * 生产环境由 /auth/login 签发。
 * @param {{ sub: string, nickname: string, role?: string }} input
 * @returns {string}
 */
export function signJwt(input) {
  return jwt.sign(
    {
      nickname: input.nickname,
      role: input.role ?? 'user',
    },
    env.JWT_SECRET,
    {
      subject: input.sub,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: `${Math.floor(ACCESS_TTL_MS / 1000)}s`,
    },
  );
}
