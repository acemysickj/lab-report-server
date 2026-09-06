// src/services/auth.service.js — 认证业务逻辑（COM-002 Auth）
// 契约（docs/COM-CONTRACT.md「身份认证」「注册」「隐私 P-002/P-007」）：
//   Argon2id；JWT Access 15min / Refresh 30d；Refresh Rotation + 复用检测（复用 → 整族作废）；
//   注册须携勾选状态与文档版本且服务端持久化；注销删资料/会话/用户数据、保留账务。
import { randomUUID } from 'node:crypto';
import { httpError } from '../lib/http-error.js';
import { hashPassword, verifyPassword } from '../lib/argon.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../lib/tokens.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  PRIVACY_POLICY_VERSION,
  TERMS_VERSION,
  byokAllowedFor,
} from '../config.js';
import {
  createUserWithAccount,
  findUserByEmail,
  findUserById,
  anonymizeUser,
} from '../repositories/user.repository.js';
import {
  createSession,
  findSessionByTokenHash,
  markSessionReplaced,
  revokeFamily,
  deleteSessionsForUser,
} from '../repositories/session.repository.js';
import { closeoutForDeletion } from './wallet.service.js';

const nowIso = () => new Date().toISOString();
const plusSeconds = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/** 注册（P-001/P-002）：勾选状态与版本必须与服务器当前文档一致，否则 400。byokAllowlist：BK-008 下发 byokAllowed。 */
export async function register(db, { email, password, consent }, byokAllowlist) {
  if (!consent || consent.acceptedPrivacyPolicy !== true || consent.acceptedTermsOfService !== true) {
    throw httpError(400, 'consent_required', '必须阅读并勾选同意《隐私政策》与《服务协议》后方可注册');
  }
  if (consent.privacyPolicyVersion !== PRIVACY_POLICY_VERSION || consent.termsVersion !== TERMS_VERSION) {
    throw httpError(400, 'consent_version_mismatch', '文档版本已更新，请重新阅读并勾选最新版本', );
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  if (findUserByEmail(db, normalizedEmail)) {
    throw httpError(409, 'email_already_registered', '该邮箱已被注册');
  }

  const passwordHash = await hashPassword(password);
  const consentedAt = nowIso();
  const userId = createUserWithAccount(db, {
    email: normalizedEmail,
    passwordHash,
    privacyConsentedAt: consentedAt,
    termsConsentedAt: consentedAt,
    privacyPolicyVersion: consent.privacyPolicyVersion,
    termsVersion: consent.termsVersion,
  });
  return { userId, email: normalizedEmail, byokAllowed: byokAllowedFor(byokAllowlist, normalizedEmail) };
}

/** 登录：校验 Argon2id；错误统一 invalid_credentials（不区分邮箱不存在/密码错，防枚举）。 */
export async function login(db, { email, password, deviceId }, byokAllowlist) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const user = findUserByEmail(db, normalizedEmail);
  const ok = Boolean(user) && user.status === 'active' && (await verifyPassword(user.password_hash, password));
  if (!ok) {
    throw httpError(401, 'invalid_credentials', '邮箱或密码不正确');
  }
  return issueTokens(db, { userId: user.id, email: normalizedEmail, byokAllowlist, deviceId, familyId: randomUUID() });
}

/** 签发双 Token（login/refresh 共用）。行操作在单个 better-sqlite3 同步事务内完成。 */
async function issueTokens(db, { userId, email, byokAllowlist, deviceId, familyId }) {
  const refresh = generateRefreshToken();
  const rotate = db.transaction(() =>
    createSession(db, {
      userId,
      familyId,
      tokenHash: refresh.hash,
      deviceId,
      expiresAt: plusSeconds(REFRESH_TOKEN_TTL_SECONDS),
    })
  );
  const sessionId = rotate();
  const accessToken = await signAccessToken({ userId, sessionId });
  return {
    accessToken,
    refreshToken: refresh.raw,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: { id: userId },
    // BK-008（ADR-003）：BYOK 白名单标志随登录态下发（客户端 fail-open：仅 false 才隐藏）
    byokAllowed: byokAllowedFor(byokAllowlist, email),
  };
}

/** Refresh Rotation + 复用检测：已轮换/已作废的 refresh 再次出现 → 整族作废。 */
export async function refresh(db, { refreshToken }, byokAllowlist) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw httpError(401, 'invalid_refresh_token', '无效的刷新令牌');
  }
  const session = findSessionByTokenHash(db, hashRefreshToken(refreshToken));
  if (!session) {
    throw httpError(401, 'invalid_refresh_token', '无效的刷新令牌');
  }
  if (session.revoked_at !== null || session.replaced_by !== null) {
    // 复用检测：疑似泄露/重放，整 token family 立即作废
    revokeFamily(db, session.family_id);
    throw httpError(401, 'token_reused', '刷新令牌已使用过，该登录族已全部作废，请重新登录');
  }
  if (session.expires_at <= nowIso()) {
    throw httpError(401, 'refresh_expired', '刷新令牌已过期，请重新登录');
  }
  // 纵深防御：与 login 的 status 检查对齐——注销/禁用账号的会话不得再轮换
  const user = findUserById(db, session.user_id);
  if (!user || user.status !== 'active') {
    throw httpError(401, 'account_unavailable', '账号不可用');
  }

  const next = generateRefreshToken();
  const rotate = db.transaction(() => {
    const newSessionId = createSession(db, {
      userId: session.user_id,
      familyId: session.family_id,
      tokenHash: next.hash,
      deviceId: session.device_id,
      expiresAt: plusSeconds(REFRESH_TOKEN_TTL_SECONDS),
    });
    markSessionReplaced(db, { id: session.id, replacedBy: newSessionId });
    return newSessionId;
  });
  const sessionId = rotate();
  const accessToken = await signAccessToken({ userId: session.user_id, sessionId });
  return {
    accessToken,
    refreshToken: next.raw,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: { id: session.user_id },
    byokAllowed: byokAllowedFor(byokAllowlist, user.email),
  };
}

/** 登出：当前会话所属 family 整族作废（access 也随 session.revoked_at 失效）。 */
export function logout(db, session) {
  revokeFamily(db, session.family_id);
}

/** 注销账号（P-007）：删会话/用户数据，保留账务（credit_ledger/orders/accounts 等），事务内。 */
export async function deleteAccount(db, { user, password }) {
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    throw httpError(401, 'invalid_credentials', '密码不正确');
  }
  const tx = db.transaction((userId) => {
    deleteSessionsForUser(db, userId);                       // 删会话
    db.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').run(userId); // 删用户数据
    db.prepare('DELETE FROM ai_jobs WHERE user_id = ?').run(userId);          // 删 AI 任务元数据（account-deletion.md §3.2）
    closeoutForDeletion(db, userId);                                          // 注销收尾（COM-003）：释放未结预扣 + 余额清零 + adjust 流水——同事务原子
    anonymizeUser(db, userId, `deleted+${randomUUID()}@deleted.invalid`);     // 脱敏资料（consent 留痕）
    // 保留（依法账务留存，P-007「保留交易必要账务记录」，account-deletion.md §3.2）：
    //   accounts（已清零）/ credit_ledger（含注销 adjust 收尾流水）/ credit_reservations（已全部终态）/ orders
  });
  tx(user.id);
}
