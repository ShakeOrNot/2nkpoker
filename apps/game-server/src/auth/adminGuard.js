import { findById } from '../users/userStore.js';
import { verifyJwt } from './jwt.js';
import { writeAudit } from './audit.js';

/**
 * @param {import('fastify').FastifyRequest} req
 * @returns {string}
 */
export function clientIp(req) {
  return String(req.ip ?? req.socket?.remoteAddress ?? '');
}

/**
 * 取 Bearer access token 对应的用户（校验签名、tv、禁用状态）
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @returns {any|null}
 */
export function requireUser(req, reply) {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    reply.code(401).send({ ok: false, code: 'AUTH_FAILED', message: '缺少访问令牌' });
    return null;
  }
  let payload;
  try {
    payload = verifyJwt(token);
  } catch (err) {
    const code = err?.name === 'TokenExpiredError' ? 'AUTH_EXPIRED' : 'AUTH_FAILED';
    reply.code(401).send({ ok: false, code, message: '登录已失效' });
    return null;
  }
  const user = findById(payload.sub);
  if (!user) {
    reply.code(401).send({ ok: false, code: 'AUTH_FAILED', message: '账号不存在' });
    return null;
  }
  if (user.disabled) {
    reply.code(403).send({ ok: false, code: 'AUTH_DISABLED', message: '账号已被禁用' });
    return null;
  }
  if (Number(payload.tv ?? 0) !== Number(user.token_version)) {
    reply.code(401).send({ ok: false, code: 'AUTH_CREDENTIALS_CHANGED', message: '口令已变更，请重新登录' });
    return null;
  }
  return user;
}

/**
 * 管理接口统一入口：先校验登录，再校验 role=admin。
 * 失败时已经回过响应，调用方直接 `return reply`。
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @returns {any|null}
 */
export function requireAdmin(req, reply) {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    writeAudit({
      action: 'admin-denied',
      userId: user.id,
      nickname: user.nickname,
      ip: clientIp(req),
      ua: req.headers['user-agent'],
      ok: false,
    });
    reply.code(403).send({ ok: false, code: 'FORBIDDEN', message: '需要管理员权限' });
    return null;
  }
  return user;
}
