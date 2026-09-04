// src/repositories/admin.repository.js — Admin 只读聚合查询（COM-005）
// 全部参数化查询（无字符串拼接）；只读，写路径仅 grant（走 wallet.service 既有事务）。

export function overview(db) {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const balanceSum = db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get().s;
  const jobsByStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM ai_jobs GROUP BY status ORDER BY n DESC')
    .all();
  const ledger = db
    .prepare('SELECT type, COUNT(*) AS n, COALESCE(SUM(delta), 0) AS deltaSum FROM credit_ledger GROUP BY type ORDER BY type')
    .all();
  const openReservations = db
    .prepare("SELECT COUNT(*) AS n FROM credit_reservations WHERE status = 'reserved'")
    .get().n;
  return { users, balanceSum, jobsByStatus, ledger, openReservations };
}

export function listUsers(db, { limit = 20, beforeId } = {}) {
  if (beforeId) {
    return db
      .prepare(
        `SELECT u.id, u.email, u.status, u.created_at,
                COALESCE(a.balance, 0) AS balance
           FROM users u LEFT JOIN accounts a ON a.user_id = u.id
          WHERE u.id < ?
          ORDER BY u.id DESC
          LIMIT ?`
      )
      .all(beforeId, limit);
  }
  return db
    .prepare(
      `SELECT u.id, u.email, u.status, u.created_at,
              COALESCE(a.balance, 0) AS balance
         FROM users u LEFT JOIN accounts a ON a.user_id = u.id
        ORDER BY u.id DESC
        LIMIT ?`
    )
    .all(limit);
}

export function findUserByEmail(db, email) {
  return db
    .prepare(
      `SELECT u.id, u.email, u.status, COALESCE(a.balance, 0) AS balance
         FROM users u LEFT JOIN accounts a ON a.user_id = u.id
        WHERE u.email = ?`
    )
    .get(email);
}
