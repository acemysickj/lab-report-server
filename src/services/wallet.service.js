// src/services/wallet.service.js — 钱包业务（COM-003）
// 契约：账本 append-only、两段式原子消费（reserve→settle/release）、退款、幂等、定价服务端权威。
// 铁律：一切余额/预扣状态变更都在 better-sqlite3 同步事务内；客户端只提交 operation，金额由 PRICING 决定。
import { httpError } from '../lib/http-error.js';
import { priceOf } from '../wallet/pricing.js';
import * as repo from '../repositories/wallet.repository.js';

const plusSeconds = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/** 钱包状态：balance（账面）/ openReservations（未结预扣）/ available（可用=balance−未结预扣）。 */
export function getWalletState(db, userId) {
  const account = repo.getAccount(db, userId);
  if (!account) throw httpError(404, 'account_not_found', '账户不存在');
  const openReservations = repo.sumOpenReservations(db, userId);
  return {
    balance: account.balance,
    openReservations,
    available: account.balance - openReservations,
  };
}

export function listLedger(db, { userId, limit = 20, beforeId }) {
  return repo.listLedger(db, { userId, limit, beforeId });
}

/** 充值履约（支付渠道后置，COM-005 Admin/回调调用）：pending 订单→delivered，入账 purchase 流水。 */
export function grantCredits(db, { userId, orderId, note }) {
  const order = repo.getOrder(db, orderId);
  if (!order || order.user_id !== userId) {
    throw httpError(404, 'order_not_found', '订单不存在');
  }
  if (order.status !== 'pending') {
    throw httpError(409, 'order_not_pending', `订单状态为 ${order.status}，不能重复履约`);
  }
  const tx = db.transaction(() => {
    const { balance } = repo.getAccount(db, userId);
    const balanceAfter = balance + order.credits;
    const ledgerId = repo.insertLedgerEntry(db, {
      userId,
      type: 'purchase',
      delta: order.credits,
      balanceAfter,
      orderId,
      note: note ?? `tier ${order.tier}`,
    });
    repo.setBalance(db, { userId, balance: balanceAfter });
    repo.markOrderDelivered(db, orderId);
    return { ledgerId, balance: balanceAfter, credits: order.credits };
  });
  return tx();
}

/** 预扣（两段式第一步）。只认 operation 定价，无任何客户端金额入口。 */
export function reserveCredits(db, { userId, operation, jobId }) {
  const credits = priceOf(operation);
  if (credits === null) {
    throw httpError(400, 'unknown_operation', `未知计费操作：${operation}`);
  }
  if (credits === 0) {
    throw httpError(400, 'operation_free', '免费操作无需预扣');
  }
  const tx = db.transaction(() => {
    const account = repo.getAccount(db, userId);
    if (!account) throw httpError(404, 'account_not_found', '账户不存在');
    const open = repo.sumOpenReservations(db, userId);
    const available = account.balance - open;
    if (available < credits) {
      throw httpError(402, 'insufficient_credits', `可用额度不足（需 ${credits}，可用 ${available}）`);
    }
    const reservationId = repo.createReservation(db, { userId, amount: credits, jobId });
    return { reservationId, amount: credits, available: available - credits };
  });
  return tx();
}

/** 核销（两段式第二步）：扣减余额 + consume 流水 + 预扣置 settled。 */
export function settleReservation(db, { reservationId, jobId }) {
  const tx = db.transaction(() => {
    const reservation = repo.getReservation(db, reservationId);
    if (!reservation) throw httpError(404, 'reservation_not_found', '预扣不存在');
    if (reservation.status !== 'reserved') {
      throw httpError(409, 'reservation_not_open', `预扣状态为 ${reservation.status}，不能核销`);
    }
    const { balance } = repo.getAccount(db, reservation.user_id);
    const balanceAfter = balance - reservation.amount;
    const ledgerId = repo.insertLedgerEntry(db, {
      userId: reservation.user_id,
      type: 'consume',
      delta: -reservation.amount,
      balanceAfter,
      reservationId,
      jobId: jobId ?? reservation.job_id,
    });
    repo.setBalance(db, { userId: reservation.user_id, balance: balanceAfter });
    repo.markReservationSettled(db, { id: reservationId, settleLedgerId: ledgerId });
    return { ledgerId, balance: balanceAfter, amount: reservation.amount };
  });
  return tx();
}

/** 释放预扣（任务未执行/取消）：不扣减余额，恢复可用额度。 */
export function releaseReservation(db, { reservationId }) {
  const reservation = repo.getReservation(db, reservationId);
  if (!reservation) throw httpError(404, 'reservation_not_found', '预扣不存在');
  if (reservation.status !== 'reserved') {
    throw httpError(409, 'reservation_not_open', `预扣状态为 ${reservation.status}，不能释放`);
  }
  repo.markReservationReleased(db, reservationId);
  return { reservationId, released: true, amount: reservation.amount };
}

/** 退款（AI 失败等）：余额回增 + refund 流水（原子）。 */
export function refundCredits(db, { userId, amount, jobId, note }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'invalid_amount', '退款额度必须为正整数');
  }
  const tx = db.transaction(() => {
    const account = repo.getAccount(db, userId);
    if (!account) throw httpError(404, 'account_not_found', '账户不存在');
    const balanceAfter = account.balance + amount;
    const ledgerId = repo.insertLedgerEntry(db, {
      userId,
      type: 'refund',
      delta: amount,
      balanceAfter,
      jobId,
      note,
    });
    repo.setBalance(db, { userId, balance: balanceAfter });
    return { ledgerId, balance: balanceAfter };
  });
  return tx();
}

/**
 * 幂等执行包装：同一 (user, operation, idemKey) 只执行一次 fn。
 * 重复请求 → { replayed: true, status, resultRef }（不二次扣费；调用方按 resultRef 复原响应）。
 * fn 必须同步返回 { resultRef, ... }，其内部可自行开事务（better-sqlite3 支持嵌套声明）。
 */
export function runIdempotent(db, { userId, operation, idemKey, requestHash, expiresInSeconds = 24 * 60 * 60, fn }) {
  const existing = repo.findIdempotencyKey(db, { userId, operation, idemKey });
  if (existing) {
    if (existing.status === 'processing') {
      throw httpError(409, 'request_in_progress', '同幂等键请求处理中');
    }
    return { replayed: true, status: existing.status, resultRef: existing.result_ref };
  }
  const keyId = repo.insertIdempotencyKey(db, {
    userId,
    operation,
    idemKey,
    requestHash,
    expiresAt: plusSeconds(expiresInSeconds),
  });
  try {
    const outcome = fn();
    repo.markIdempotencyKey(db, { id: keyId, status: 'completed', resultRef: outcome.resultRef });
    return { replayed: false, status: 'completed', resultRef: outcome.resultRef, outcome };
  } catch (err) {
    repo.markIdempotencyKey(db, { id: keyId, status: 'failed' });
    throw err;
  }
}

/**
 * 注销收尾（P-007/reviewer 必做项）：释放全部未结预扣 + 余额清零 + adjust 流水。
 * 必须在 deleteAccount 的删除事务【内】调用——与删会话/删用户数据同事务原子提交。
 */
export function closeoutForDeletion(db, userId) {
  repo.releaseAllOpenReservations(db, userId); // 释放/核销清理：未结预扣全部置 released（不扣减）
  const account = repo.getAccount(db, userId);
  if (account && account.balance > 0) {
    const ledgerId = repo.insertLedgerEntry(db, {
      userId,
      type: 'adjust',
      delta: -account.balance,
      balanceAfter: 0,
      note: 'account deletion closeout',
    });
    repo.setBalance(db, { userId, balance: 0 });
    return { adjustLedgerId: ledgerId, zeroed: account.balance };
  }
  return { adjustLedgerId: null, zeroed: 0 };
}
