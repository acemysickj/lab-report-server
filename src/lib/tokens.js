// src/lib/tokens.js — 双 Token（COM-002 Auth）
// Access：JWT HS256，payload 只含 sub/sid/iat/exp（契约：余额/用户名/角色/额度一律不入 payload）。
// Refresh：32 字节随机串（opaque，非 JWT）；库中只存 SHA-256 摘要（auth_sessions.token_hash）。
//   注：SHA-256 仅用于令牌摘要索引，不用于密码哈希（密码一律 Argon2id，见 src/lib/argon.js）。
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS, AUTH_JWT_SECRET } from '../config.js';

const jwtKey = new TextEncoder().encode(AUTH_JWT_SECRET);

/** Sign an access token for (userId, sessionId). Payload is exactly { sub, sid, iat, exp }. */
export async function signAccessToken({ userId, sessionId }) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(jwtKey);
}

/** Verify + decode an access token. Throws on invalid/expired. Returns { userId, sessionId, exp }. */
export async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, jwtKey, { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'number') {
    throw new Error('unexpected token payload shape');
  }
  return { userId: Number(payload.sub), sessionId: payload.sid, exp: payload.exp };
}

/** New refresh token: { raw (给客户端), hash (入库) }. */
export function generateRefreshToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
