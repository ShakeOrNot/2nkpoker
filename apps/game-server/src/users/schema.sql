-- 账密系统 v1（SQLite）
-- 昵称即登录名：nickname 唯一（ASCII 大小写不敏感），同时作为牌桌显示名。

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',
  token_version  INTEGER NOT NULL DEFAULT 0,
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL,
  rotated_from  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  at       INTEGER NOT NULL,
  action   TEXT NOT NULL,
  user_id  TEXT,
  nickname TEXT,
  ip       TEXT,
  ua       TEXT,
  ok       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
