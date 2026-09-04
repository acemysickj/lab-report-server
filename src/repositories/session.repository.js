// src/repositories/session.repository.js — auth_sessions 表访问（COM-002 Auth）
// 契约字段：token_hash / device_id / replaced_by / revoked_at / last_used_at；
// family_id 标识 Refresh Token 族（Rotation + 复用检测 → 整族作废）。

export function createSession(db, { userId, familyId, tokenHash, deviceId, expiresAt }) {
  const info = db
    .prepare(
      `INSERT INTO auth_sessions (user_id, family_id, token_hash, device_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, familyId, tokenHash, deviceId ?? null, expiresAt);
  return Number(info.lastInsertRowid);
}

export function findSessionByTokenHash(db, tokenHash) {
  return db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash);
}

export function findSessionById(db, id) {
  return db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id);
}

/** 轮换：旧 refresh 标记 replaced_by + last_used_at（同步事务内调用）。 */
export function markSessionReplaced(db, { id, replacedBy }) {
  return db
    .prepare(
      `UPDATE auth_sessions
         SET replaced_by = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
    .run(replacedBy, id);
}

/** 整族作废（复用检测 / logout）。返回受影响行数。 */
export function revokeFamily(db, familyId) {
  return db
    .prepare(
      `UPDATE auth_sessions
         SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE family_id = ? AND revoked_at IS NULL`
    )
    .run(familyId);
}

/** 注销（P-007）：删除用户全部会话行。 */
export function deleteSessionsForUser(db, userId) {
  return db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}
