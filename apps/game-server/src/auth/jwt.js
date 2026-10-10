import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/**
 * @typedef {Object} JwtPayload
 * @property {string} sub
 * @property {string} nickname
 * @property {string} role
 */

/**
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