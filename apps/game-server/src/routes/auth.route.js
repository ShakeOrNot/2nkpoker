import { z } from 'zod';
import {
  findByNickname,
  findById,
  isValidNickname,
  createUser,
  touchLogin,
  updatePassword,
  toPublicUser,
} from '../users/userStore.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password.js';
import { ACCESS_TTL_MS, signAccessToken, verifyJwt } from '../auth/jwt.js';
import {
  consumeRefreshToken,
  createRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
} from '../auth/session.js';
import {
  checkLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from '../auth/ratelimit.js';
import { writeAudit } from '../auth/audit.js';

/**
 * 用于"用户不存在"时的等时校验，避免通过响应时间枚举账号。
 * 生成方式：hashPassword('dummy-password-for-timing')；参数与线上一致。
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$a8PQl48FQRWh2tMnc9rssw==$I3IdaRuMbhOSuGQwEQ0h5/bF7fJdYcl0SJa3xwdqIA6CD9NoweGvNbAM9hUnBtgmOp0ZKUvFJgX60K9lIucjmg==';

const CredentialsSchema = z.object({
  nickname: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(10).max(500),
});

const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

const AdminResetSchema = z.object({
  nickname: z.string().min(1).max(40),
  newPassword: z.string().min(1).max(200),
});

/**
 * @param {any} user 数据库行
 */
function issueSession(user) {
  const accessToken = signAccessToken({
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    tokenVersion: user.token_version,
  });
  const refresh = createRefreshToken(user.id);
  return {
    ok: true,
    accessToken,
    refreshToken: refresh.token,
    expiresAt: Date.now() + ACCESS_TTL_MS,
    user: toPublicUser(user),
  };
}

/**
 * @param {import('fastify').FastifyRequest} req
 * @returns {string}
 */
function clientIp(req) {
  return String(req.ip ?? req.socket?.remoteAddress ?? '');
}

/**
 * 取 Bearer access token 对应的用户（校验签名、tv、禁用状态）
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @returns {any|null}
 */
function requireUser(req, reply) {
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
 * @param {import('fastify').FastifyInstance} app
 */
export function registerAuthRoutes(app) {
  /* ---------------- 注册 ---------------- */
  app.post('/auth/register', async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '昵称和口令都要填' };
    }
    const nickname = String(parsed.data.nickname).trim();
    const password = String(parsed.data.password);

    if (!isValidNickname(nickname)) {
      reply.code(400);
      return { ok: false, code: 'AUTH_INVALID_NICKNAME', message: '昵称需 2~20 个字符，只能是字母/数字/下划线/中划线/中文' };
    }
    const policy = checkPasswordPolicy(password, nickname);
    if (!policy.ok) {
      reply.code(400);
      return { ok: false, code: 'AUTH_WEAK_PASSWORD', message: policy.reason };
    }
    if (findByNickname(nickname)) {
      reply.code(409);
      writeAudit({ action: 'register', nickname, ip: clientIp(req), ua: req.headers['user-agent'], ok: false });
      return { ok: false, code: 'AUTH_USER_EXISTS', message: '这个昵称已经被注册了' };
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = createUser({ nickname, passwordHash });
    } catch {
      // 并发注册撞唯一约束
      reply.code(409);
      return { ok: false, code: 'AUTH_USER_EXISTS', message: '这个昵称已经被注册了' };
    }
    touchLogin(user.id);
    writeAudit({ action: 'register', userId: user.id, nickname, ip: clientIp(req), ua: req.headers['user-agent'], ok: true });
    reply.code(201);
    return issueSession({ ...user, last_login_at: Date.now() });
  });

  /* ---------------- 登录 ---------------- */
  app.post('/auth/login', async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '昵称和口令都要填' };
    }
    const nickname = String(parsed.data.nickname).trim();
    const password = String(parsed.data.password);
    const ip = clientIp(req);

    const gate = checkLoginAllowed({ nickname, ip });
    if (!gate.ok) {
      reply.code(429);
      return {
        ok: false,
        code: gate.code,
        message: gate.code === 'AUTH_LOCKED' ? '失败次数过多，账号已临时锁定' : '尝试太频繁，稍后再试',
        retryAfterMs: gate.retryAfterMs,
      };
    }

    const user = findByNickname(nickname);
    // 账号不存在也跑一次 scrypt，避免用响应时间枚举昵称
    const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOk) {
      const failure = recordLoginFailure({ nickname, ip });
      writeAudit({ action: 'login', nickname, ip, ua: req.headers['user-agent'], ok: false });
      if (failure.locked) {
        reply.code(429);
        return {
          ok: false,
          code: 'AUTH_LOCKED',
          message: '失败次数过多，账号已临时锁定',
          retryAfterMs: failure.retryAfterMs,
        };
      }
      reply.code(401);
      return { ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: '昵称或口令不对' };
    }

    if (user.disabled) {
      writeAudit({ action: 'login', userId: user.id, nickname, ip, ua: req.headers['user-agent'], ok: false });
      reply.code(403);
      return { ok: false, code: 'AUTH_DISABLED', message: '账号已被禁用' };
    }

    clearLoginFailures(nickname);
    touchLogin(user.id);
    writeAudit({ action: 'login', userId: user.id, nickname, ip, ua: req.headers['user-agent'], ok: true });
    return issueSession({ ...user, last_login_at: Date.now() });
  });

  /* ---------------- 刷新 ---------------- */
  app.post('/auth/refresh', async (req, reply) => {
    const parsed = RefreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '缺少 refreshToken' };
    }
    const result = consumeRefreshToken(parsed.data.refreshToken);
    if (!result.ok) {
      reply.code(401);
      writeAudit({ action: 'refresh', ip: clientIp(req), ua: req.headers['user-agent'], ok: false });
      return { ok: false, code: result.reason, message: '登录已失效，请重新登录' };
    }
    const user = findById(result.userId);
    if (!user || user.disabled) {
      revokeAllForUser(result.userId);
      reply.code(401);
      return { ok: false, code: 'AUTH_REFRESH_INVALID', message: '登录已失效，请重新登录' };
    }
    const accessToken = signAccessToken({
      id: user.id,
      nickname: user.nickname,
      role: user.role,
      tokenVersion: user.token_version,
    });
    return {
      ok: true,
      accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + ACCESS_TTL_MS,
      user: toPublicUser(user),
    };
  });

  /* ---------------- 登出 ---------------- */
  app.post('/auth/logout', async (req) => {
    const token = String(req.body?.refreshToken ?? '');
    if (token) revokeRefreshToken(token);
    return { ok: true };
  });

  /* ---------------- 当前用户 ---------------- */
  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return { ok: true, user: toPublicUser(user) };
  });

  /* ---------------- 改口令 ---------------- */
  app.post('/auth/change-password', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;

    const parsed = ChangePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '旧口令和新口令都要填' };
    }
    const { oldPassword, newPassword } = parsed.data;

    if (!(await verifyPassword(oldPassword, user.password_hash))) {
      writeAudit({ action: 'change-password', userId: user.id, nickname: user.nickname, ip: clientIp(req), ua: req.headers['user-agent'], ok: false });
      reply.code(401);
      return { ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: '旧口令不对' };
    }
    const policy = checkPasswordPolicy(newPassword, user.nickname);
    if (!policy.ok) {
      reply.code(400);
      return { ok: false, code: 'AUTH_WEAK_PASSWORD', message: policy.reason };
    }
    if (newPassword === oldPassword) {
      reply.code(400);
      return { ok: false, code: 'AUTH_WEAK_PASSWORD', message: '新口令不能和旧口令相同' };
    }

    const newHash = await hashPassword(newPassword);
    updatePassword(user.id, newHash); // 同时 token_version + 1
    revokeAllForUser(user.id); // 其它设备的刷新令牌全部作废
    writeAudit({ action: 'change-password', userId: user.id, nickname: user.nickname, ip: clientIp(req), ua: req.headers['user-agent'], ok: true });

    const fresh = findById(user.id);
    return issueSession(fresh);
  });

  /* ---------------- 管理员重置口令（忘记口令时用；也可以走 CLI） ---------------- */
  app.post('/auth/admin/reset-password', async (req, reply) => {
    const admin = requireUser(req, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') {
      writeAudit({ action: 'admin-reset', userId: admin.id, nickname: admin.nickname, ip: clientIp(req), ua: req.headers['user-agent'], ok: false });
      reply.code(403);
      return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以重置口令' };
    }

    const parsed = AdminResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: 'INVALID_PAYLOAD', message: '要指定昵称和新口令' };
    }
    const nickname = String(parsed.data.nickname).trim();
    const target = findByNickname(nickname);
    if (!target) {
      reply.code(404);
      return { ok: false, code: 'USER_NOT_FOUND', message: '没有这个账号' };
    }
    const policy = checkPasswordPolicy(parsed.data.newPassword, target.nickname);
    if (!policy.ok) {
      reply.code(400);
      return { ok: false, code: 'AUTH_WEAK_PASSWORD', message: policy.reason };
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    updatePassword(target.id, newHash); // token_version + 1
    revokeAllForUser(target.id); // 目标账号所有设备立即失效
    writeAudit({
      action: 'admin-reset',
      userId: admin.id,
      nickname: target.nickname,
      ip: clientIp(req),
      ua: req.headers['user-agent'],
      ok: true,
    });
    return { ok: true };
  });
}
