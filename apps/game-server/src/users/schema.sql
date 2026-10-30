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

-- 每手牌里每个参与者的战绩（一行一手一人）
-- vpip = 翻牌前主动投钱（跟注/下注/加注/全下，盲注不算）
-- showdown = 这手进了摊牌（有亮牌）；won = 净赢筹码 > 0
CREATE TABLE IF NOT EXISTS player_hands (
  hand_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  table_id      TEXT NOT NULL,
  played_at     INTEGER NOT NULL,
  vpip          INTEGER NOT NULL DEFAULT 0,
  showdown      INTEGER NOT NULL DEFAULT 0,
  won           INTEGER NOT NULL DEFAULT 0,
  showdown_won  INTEGER NOT NULL DEFAULT 0,
  net           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hand_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_player_hands_user ON player_hands(user_id);
CREATE INDEX IF NOT EXISTS idx_player_hands_at ON player_hands(played_at);
