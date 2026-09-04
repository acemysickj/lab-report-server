-- migrations/0001_init.sql — COM-001 skeleton schema
-- 契约 docs/COM-CONTRACT.md「数据库 8 表（v1 冻结）」：
--   users / accounts / credit_ledger / credit_reservations / auth_sessions /
--   orders / ai_jobs / idempotency_keys
-- 隐私铁律（P-005/P-006）：AI 请求正文/响应正文一律不得入库——本 schema 只存元数据，
-- 任何后续迁移也不得添加存储 AI 正文的列。

-- 1. users —— 邮箱即用户名（首版不做邮箱验证），Argon2id 密码哈希由 COM-002 写入
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,                    -- Argon2id encoded string
  status        TEXT    NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. accounts —— 每用户唯一积分账户（credits 为整数：100/350/700 档）
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users (id),
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. orders —— 充值订单（9.9/100、29.9/350、49.9/700；价格以分为单位）
CREATE TABLE orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users (id),
  tier             TEXT    NOT NULL CHECK (tier IN ('tier_9_9', 'tier_29_9', 'tier_49_9')),
  price_cents      INTEGER NOT NULL CHECK (price_cents > 0),
  credits          INTEGER NOT NULL CHECK (credits > 0),
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'delivered', 'failed', 'closed', 'refunded')),
  channel          TEXT,                             -- 支付渠道（COM-003 接入时填）
  external_order_no TEXT,
  paid_at          TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);

-- 4. credit_reservations —— 预扣（原子消费两段式第一步：reserve → settle/release）
CREATE TABLE credit_reservations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users (id),
  job_id            TEXT,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  status            TEXT    NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  settle_ledger_id  INTEGER REFERENCES credit_ledger (id),
  release_ledger_id INTEGER REFERENCES credit_ledger (id),
  expires_at        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_reservations_user_status ON credit_reservations (user_id, status);

-- 5. credit_ledger —— 积分流水（append-only；balance_after 保证可审计）
CREATE TABLE credit_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users (id),
  type           TEXT    NOT NULL CHECK (type IN ('purchase', 'consume', 'refund', 'adjust')),
  delta          INTEGER NOT NULL CHECK (delta <> 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  order_id       INTEGER REFERENCES orders (id),
  reservation_id INTEGER REFERENCES credit_reservations (id),
  job_id         TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_credit_ledger_user_created ON credit_ledger (user_id, created_at);

-- 6. auth_sessions —— Refresh token 族（契约字段：token_hash/device_id/replaced_by/
--    revoked_at/last_used_at；Rotation + 复用检测 → 整 family 作废由 COM-002 实现）
CREATE TABLE auth_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id),
  family_id    TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  device_id    TEXT,
  replaced_by  INTEGER REFERENCES auth_sessions (id),
  revoked_at  TEXT,
  last_used_at TEXT,
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_auth_sessions_user   ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_family ON auth_sessions (family_id);

-- 7. ai_jobs —— AI 任务元数据（jobId + running/completed/failed/refunded；
--    绝不存请求/响应正文；model 为服务端 MODEL_MAP 实际使用值，客户端不可传）
CREATE TABLE ai_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users (id),
  operation       TEXT    NOT NULL,
  model           TEXT,
  status          TEXT    NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'refunded')),
  credits_charged INTEGER NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  reservation_id  INTEGER REFERENCES credit_reservations (id),
  request_id      TEXT,
  error_code      TEXT,
  completed_at    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ai_jobs_user_created ON ai_jobs (user_id, created_at);

-- 8. idempotency_keys —— 幂等键（只存哈希，不存业务正文）
CREATE TABLE idempotency_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id),
  operation    TEXT    NOT NULL,
  idem_key     TEXT    NOT NULL,
  request_hash TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'completed', 'failed')),
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, operation, idem_key)
);
CREATE INDEX idx_idempotency_keys_expiry ON idempotency_keys (expires_at);
