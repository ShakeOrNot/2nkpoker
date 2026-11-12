#!/usr/bin/env node
/**
 * 打印当前生效的共享行为配置（不打印 JWT_SECRET）。
 * 用法：node scripts/check-env.mjs
 */
import { envFilePath } from '../apps/game-server/src/env.js';

const keys = [
  'PORT',
  'ACTION_TIMEOUT_MS',
  'RECONNECT_GRACE_MS',
  'SETTLE_HOLD_MS',
  'STREET_DELAY_MS',
  'RUNOUT_BOARD_MS',
  'RUNOUT_TIMEOUT_MS',
  'SHOW_CARDS_MS',
  'ACCESS_TTL_MS',
  'REFRESH_TTL_MS',
  'AUTH_MAX_ATTEMPTS',
  'AUTH_LOCK_MS',
  'AUTH_WINDOW_MS',
  'AUTH_IP_MAX_ATTEMPTS',
  'TRUST_PROXY',
  'ALLOW_DEV_TOKEN',
  'AUTH_DB_PATH',
];

console.log(`env 文件：${envFilePath}`);
for (const key of keys) {
  const value = process.env[key];
  console.log(`  ${key}=${value === undefined ? '(未设置，用代码默认)' : value}`);
}
