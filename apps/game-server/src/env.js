import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * 全项目只有一份 .env（仓库根目录）。
 *
 * 为什么不用 `node --env-file=.env`：
 *   --env-file 的路径是相对**当前工作目录**的，换个目录启动就读不到。
 *   这里按模块自身位置定位仓库根，无论从哪里启动都指向同一份配置。
 *
 * 优先级：真实环境变量 > .env（loadEnvFile 不会覆盖已存在的变量）。
 */
const envFilePath = fileURLToPath(new URL('../../../.env', import.meta.url));
/** 默认用户库：仓库根/var/2nkpoker.db */
const defaultDbPath = fileURLToPath(new URL('../../../var/2nkpoker.db', import.meta.url));

if (existsSync(envFilePath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFilePath);
}

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  JWT_SECRET: z.string().min(1),
  JWT_ISSUER: z.string().default('2nkpoker'),
  JWT_AUDIENCE: z.string().default('2nkpoker-web'),

  /* ---------- 账密系统 ---------- */
  AUTH_DB_PATH: z.string().default(defaultDbPath),
  ACCESS_TTL_MS: z.coerce.number().default(15 * 60 * 1000),
  REFRESH_TTL_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),
  /** 开发用 POST /dev/token 开关（生产环境始终关闭） */
  ALLOW_DEV_TOKEN: z
    .string()
    .default('1')
    .transform((v) => !['0', 'false', 'no', 'off'].includes(v.toLowerCase())),
  AUTH_MAX_ATTEMPTS: z.coerce.number().default(5),
  AUTH_LOCK_MS: z.coerce.number().default(5 * 60 * 1000),
  AUTH_WINDOW_MS: z.coerce.number().default(5 * 60 * 1000),
  AUTH_IP_MAX_ATTEMPTS: z.coerce.number().default(20),

  /**
   * 放在 Nginx/Caddy 等反向代理后面时，需要信任代理传来的 X-Forwarded-For，
   * 否则限流会把所有用户当成同一个 IP。
   * 取值：空/false = 不信任；true/1 = 全信任；'loopback' 或逗号分隔 IP = 只信任这些来源。
   */
  TRUST_PROXY: z
    .string()
    .default('')
    .transform((v) => {
      const s = String(v).trim();
      if (!s || ['0', 'false', 'no', 'off'].includes(s.toLowerCase())) return false;
      if (['1', 'true', 'yes', 'on'].includes(s.toLowerCase())) return true;
      return s;
    }),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(
    `环境变量校验失败（${detail}）。\n` +
      `  期望的配置文件：${envFilePath}\n` +
      '  修法：在仓库根目录执行  cp .env.example .env  后重试。',
  );
}

export const env = parsed.data;
export { envFilePath };
