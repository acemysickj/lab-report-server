// src/config.js — 环境配置（COM-002 Auth）
// 契约：JWT Access 15min / Refresh 30d；密钥只存服务器环境；版本号服务端权威。
import path from 'node:path';
import crypto from 'node:crypto';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;        // 15 min（契约）
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 d（契约）

// 法务文档版本（P-002 勾选追溯锚点；文档修订时同步递增，见 docs/legal/registration-summary.md 第三节）
export const PRIVACY_POLICY_VERSION = 'v1.0';
export const TERMS_VERSION = 'v1.0';

export const LEGAL_DOCS_DIR = process.env.LEGAL_DOCS_DIR
  ? path.resolve(process.env.LEGAL_DOCS_DIR)
  : path.resolve('./docs/legal');

function resolveJwtSecret() {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret !== undefined && secret.length > 0) {
    if (secret.length < 32) {
      throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
    }
    return secret;
  }
  if ((process.env.NODE_ENV || 'development') === 'production') {
    throw new Error('AUTH_JWT_SECRET is required in production (>= 32 chars, server env only)');
  }
  console.warn(
    '[config] AUTH_JWT_SECRET not set — using an ephemeral dev secret; all tokens invalidate on restart'
  );
  return crypto.randomBytes(48).toString('base64url');
}

export const AUTH_JWT_SECRET = resolveJwtSecret();

// ---- COM-005：限流口径（契约风控：并发 2 / 每分钟 10 / 每小时 50，后台可调=env 重启生效） ----
function positiveIntEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}
export const RATE_LIMITS = {
  maxConcurrent: positiveIntEnv('RATE_MAX_CONCURRENT', 2),
  perMinute: positiveIntEnv('RATE_PER_MINUTE', 10),
  perHour: positiveIntEnv('RATE_PER_HOUR', 50),
};

// ---- COM-005 扩展：认证端点防爆破（按 IP，login/register/refresh 共享预算）----
// 只统计尝试本身、不区分邮箱存在性 → 与 login 的防枚举口径（401 无差别）兼容。
// IP 来自 X-Forwarded-For（生产由 Nginx 覆写为 $remote_addr；app 只听 127.0.0.1，链路可信）。
export const AUTH_RATE_LIMITS = {
  maxConcurrent: 9999, // 无并发约束——认证是短请求，只按窗口限
  perMinute: positiveIntEnv('AUTH_RATE_PER_MINUTE', 5),
  perHour: positiveIntEnv('AUTH_RATE_PER_HOUR', 30),
};

// ---- COM-005：极简 Admin（未配置即整体隐藏；只存服务器环境，不入 git） ----
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 16
  ? process.env.ADMIN_TOKEN
  : null;

// ---- COM-004：上游传输超时（毫秒）。长提示词+思考模式下出首字可达分钟级，默认放宽到 5 分钟 ----
export const AI_UPSTREAM_TIMEOUT_MS = positiveIntEnv('AI_UPSTREAM_TIMEOUT_MS', 300000);

// ---- BK-008（ADR-003）：BYOK 白名单（env 逗号分隔邮箱；测试/内测紧急自救通道） ----
// 语义：名单内 = byokAllowed true；未配置/空名单 = 全员 false（ADR-003「默认全员不可用」）。
// 邮箱归一化：trim + 小写比对。仅软控制（UI 显隐），硬门（403 byok_not_approved）留正式版。
export function parseByokAllowlist(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const set = new Set();
  for (const item of list) {
    const email = String(item).trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

export const BYOK_ALLOWLIST = parseByokAllowlist(process.env.BYOK_ALLOWLIST);

export function byokAllowedFor(allowlist, email) {
  if (!allowlist || typeof email !== 'string') return false;
  return allowlist.has(email.trim().toLowerCase());
}

// ---- COM-004：V4 思考模式（deepseek-v4-* 默认开启思考，思考 token 计费且首字延迟分钟级）。
// 报告写作为直出任务，默认 disabled（快且省）；需要深度推理时设 DEEPSEEK_THINKING_TYPE=enabled ----
export const DEEPSEEK_THINKING_TYPE = process.env.DEEPSEEK_THINKING_TYPE === 'enabled' ? 'enabled' : 'disabled';
