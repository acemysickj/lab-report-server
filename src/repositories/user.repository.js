// src/repositories/user.repository.js — users/accounts 表访问（COM-002 Auth）
import { httpError } from '../lib/http-error.js';

const USER_COLUMNS = `
  id, email, password_hash, status,
  privacy_consented_at, terms_consented_at, privacy_policy_version, terms_version,
  created_at, updated_at
`;

/** 注册：users + accounts（余额 0）单事务创建，返回 userId。邮箱冲突 → 409。 */
export function createUserWithAccount(db, input) {
  const tx = db.transaction((data) => {
    let userId;
    try {
      const info = db
        .prepare(
          `INSERT INTO users
             (email, password_hash, privacy_consented_at, terms_consented_at,
              privacy_policy_version, terms_version)
           VALUES (@email, @passwordHash, @privacyConsentedAt, @termsConsentedAt,
                   @privacyPolicyVersion, @termsVersion)`
        )
        .run(data);
      userId = Number(info.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed: users.email')) {
        throw httpError(409, 'email_already_registered', '该邮箱已被注册');
      }
      throw err;
    }
    db.prepare('INSERT INTO accounts (user_id, balance) VALUES (?, 0)').run(userId);
    return userId;
  });
  return tx(input);
}

export function findUserByEmail(db, email) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(email);
}

export function findUserById(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
}

/** 注销脱敏（P-007）：身份字段不可逆替换；consent 列保留作合规留痕；行不删（账务 FK 依赖）。 */
export function anonymizeUser(db, userId, replacementEmail) {
  return db
    .prepare(
      `UPDATE users
         SET email = ?, password_hash = '', status = 'deleted',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
    .run(replacementEmail, userId);
}
