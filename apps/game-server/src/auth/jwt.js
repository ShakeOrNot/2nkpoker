import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/**
 * @typedef {Object} JwtPayload
 * @property {string} sub
 * @property {string} nickname
 * @property {string} role
 */

/**
 * 校验 JWT（握手时用）
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
 * 签发 JWT（**仅开发环境**用，正式签发归 A）
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
      expiresIn: '15m',
    },
  );
}