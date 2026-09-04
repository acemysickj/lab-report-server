// src/repositories/wallet.repository.js — accounts/credit_ledger/credit_reservations/orders 访问（COM-003）
// 全部纯 SQL 访问；状态变更由 service 层在 better-sqlite3 同步事务内编排。

export function getAccount(db, userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
}

export function setBalance(db, { userId, balance }) {
  return db
    .prepare(
      `UPDATE accounts
         SET balance = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE user_id = ?`
    )
    .run(balance, userId);
}

/** 未结预扣合计（status='reserved'）。 */
export function sumOpenReservations(db, userId) {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM credit_reservations WHERE user_id = ? AND status = 'reserved'")
    .get(userId);
  return Number(row.total);
}

export function insertLedgerEntry(db, entry) {
  const info = db
    .prepare(
      `INSERT INTO credit_ledger (user_id, type, delta, balance_after, order_id, reservation_id, job_id, note)
       VALUES (@userId, @type, @delta, @balanceAfter, @orderId, @reservationId, @jobId, @note)`
    )
    .run({
      orderId: null,
      reservationId: null,
      jobId: null,
      note: null,
      ...entry,
    });
  return Number(info.lastInsertRowid);
}

export function listLedger(db, { userId, limit, beforeId }) {
  return db
    .prepare(
      `SELECT id, type, delta, balance_after AS balanceAfter, job_id AS jobId, note, created_at AS createdAt
         FROM credit_ledger
        WHERE user_id = ? AND (? IS NULL OR id < ?)
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(userId, beforeId ?? null, beforeId ?? null, limit);
}

export function countLedger(db, userId) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?').get(userId).n);
}

// ---- reservations ----

export function createReservation(db, { userId, amount, jobId }) {
  const info = db
    .prepare(
      `INSERT INTO credit_reservations (user_id, job_id, amount, status)
       VALUES (?, ?, ?, 'reserved')`
    )
    .run(userId, jobId ?? null, amount);
  return Number(info.lastInsertRowid);
}

export function getReservation(db, id) {
  return db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id);
}

export function markReservationSettled(db, { id, settleLedgerId }) {
  return db
    .prepare(
      `UPDATE credit_reservations
         SET status = 'settled', settle_ledger_id = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'reserved'`
    )
    .run(settleLedgerId, id);
}

export function markReservationReleased(db, id) {
  return db
    .prepare(
      `UPDATE credit_reservations
         SET status = 'released',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'reserved'`
    )
    .run(id);
}

/** 注销收尾：把用户所有未结预扣置为 released（不扣减余额）。 */
export function releaseAllOpenReservations(db, userId) {
  return db
    .prepare(
      `UPDATE credit_reservations
         SET status = 'released',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE user_id = ? AND status = 'reserved'`
    )
    .run(userId);
}

// ---- orders ----

export function createOrder(db, { userId, tier, priceCents, credits }) {
  const info = db
    .prepare(
      `INSERT INTO orders (user_id, tier, price_cents, credits, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(userId, tier, priceCents, credits);
  return Number(info.lastInsertRowid);
}

export function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

export function markOrderDelivered(db, id) {
  return db
    .prepare(
      `UPDATE orders
         SET status = 'delivered', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending'`
    )
    .run(id);
}

// ---- idempotency ----

export function findIdempotencyKey(db, { userId, operation, idemKey }) {
  return db
    .prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND operation = ? AND idem_key = ?')
    .get(userId, operation, idemKey);
}

export function insertIdempotencyKey(db, { userId, operation, idemKey, requestHash, expiresAt }) {
  const info = db
    .prepare(
      `INSERT INTO idempotency_keys (user_id, operation, idem_key, request_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, operation, idemKey, requestHash, expiresAt);
  return Number(info.lastInsertRowid);
}

export function markIdempotencyKey(db, { id, status, resultRef }) {
  return db
    .prepare('UPDATE idempotency_keys SET status = ?, result_ref = ? WHERE id = ?')
    .run(status, resultRef ?? null, id);
}
