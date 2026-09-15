// src/repositories/admin.repository.js — Admin 只读聚合查询（COM-005 / PROMO-001）
// 全部参数化查询（无字符串拼接）；只读，写路径仅 grant/adjust（走 wallet.service 既有事务）。

// ---- 时区口径（PROMO-001）：运营/推广数据按中国标准时间 CST=UTC+8 划日（无夏令时） ----
const CST_OFFSET_MS = 8 * 3600 * 1000;

export function cstDayRange(date) {
  const shifted = new Date(date.getTime() + CST_OFFSET_MS);
  const startUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - CST_OFFSET_MS;
  return { start: new Date(startUtc).toISOString(), end: new Date(startUtc + 24 * 3600 * 1000).toISOString() };
}

export function cstDateLabel(dayStartIso) {
  return new Date(new Date(dayStartIso).getTime() + CST_OFFSET_MS).toISOString().slice(0, 10);
}

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

// PROMO-001 对账辅助字段：purchaseCount（发放流水数，0=注册未付费）+ lastActivityAt（最近任何台账活动）。
const LIST_USERS_SELECT = `
  SELECT u.id, u.email, u.status, u.created_at,
         COALESCE(a.balance, 0) AS balance,
         COALESCE(l.purchase_count, 0) AS purchaseCount,
         l.last_activity_at AS lastActivityAt
    FROM users u
    LEFT JOIN accounts a ON a.user_id = u.id
    LEFT JOIN (
      SELECT user_id,
             SUM(type = 'purchase') AS purchase_count,
             MAX(created_at) AS last_activity_at
        FROM credit_ledger
       GROUP BY user_id
    ) l ON l.user_id = u.id`;

export function listUsers(db, { limit = 20, beforeId } = {}) {
  if (beforeId) {
    return db
      .prepare(`${LIST_USERS_SELECT} WHERE u.id < ? ORDER BY u.id DESC LIMIT ?`)
      .all(beforeId, limit);
  }
  return db.prepare(`${LIST_USERS_SELECT} ORDER BY u.id DESC LIMIT ?`).all(limit);
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

// ---- PROMO-001：推广数据观测 ----

/** 注册观测：今日/昨日/累计 + 近 7 日趋势（CST 划日；now 可注入以便测试跨日边界）。 */
export function registrationStats(db, now = new Date()) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const countBetween = db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?'
  );
  const countIn = (range) => countBetween.get(range.start, range.end).n;
  const trend7d = [];
  for (let i = 6; i >= 0; i--) {
    const range = cstDayRange(new Date(now.getTime() - i * 24 * 3600 * 1000));
    trend7d.push({ date: cstDateLabel(range.start), count: countIn(range) });
  }
  return {
    today: countIn(cstDayRange(now)),
    yesterday: countIn(cstDayRange(new Date(now.getTime() - 24 * 3600 * 1000))),
    total,
    trend7d,
  };
}

/** 发放观测（口径：credit_ledger type=purchase 联 orders.price_cents——只计已履约发放的真实档位金额）。 */
export function grantStats(db, now = new Date()) {
  const today = cstDayRange(now);
  const base = `SELECT COUNT(*) AS count, COALESCE(SUM(o.price_cents), 0) AS amountCents
                  FROM credit_ledger l JOIN orders o ON o.id = l.order_id
                 WHERE l.type = 'purchase'`;
  const todayRow = db.prepare(`${base} AND l.created_at >= ? AND l.created_at < ?`).get(today.start, today.end);
  const totalRow = db.prepare(base).get();
  return {
    today: { count: todayRow.count, amountCents: todayRow.amountCents },
    total: { count: totalRow.count, amountCents: totalRow.amountCents },
  };
}

export function stats(db, now = new Date()) {
  return {
    registrations: registrationStats(db, now),
    grants: grantStats(db, now),
    tz: 'UTC+8',
    generatedAt: now.toISOString(),
  };
}
