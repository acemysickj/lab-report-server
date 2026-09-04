// src/config.js — 环境配置（COM-002 Auth）
// 契约：JWT Access 15min / Refresh 30d；密钥只存服务器环境；版本号服务端权威。
import path from 'node:path';
import crypto from 'node:crypto';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;        // 15 min（契约）
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 d（契约）

// 法务文档版本（P-002 勾选追溯锚点；文档修订时同步递增，见 docs/legal/registration-summary.md 第三节）
export const PRIVACY_POLICY_VERSION = 'v1.0-draft';
export const TERMS_VERSION = 'v1.0-draft';

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
