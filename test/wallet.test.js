// test/wallet.test.js — COM-003 钱包：账本/两段式原子消费/退款/幂等/定价权威/注销收尾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeJwt } from 'jose';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import {
  grantCredits,
  reserveCredits,
  settleReservation,
  releaseReservation,
  refundCredits,
  runIdempotent,
  getWalletState,
} from '../src/services/wallet.service.js';
import { createOrder, getOrder } from '../src/repositories/wallet.repository.js';
import { OPERATIONS, TIERS, PRICING } from '../src/wallet/pricing.js';

async function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-wallet-'));
  const app = await buildApp({ dataDir: tmp });
  await migrate(app.db);
  return { app, tmp };
}

async function registerAndLogin(app, email = 'w@test.dev') {
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: 'password123',
      consent: {
        acceptedPrivacyPolicy: true,
        acceptedTermsOfService: true,
        privacyPolicyVersion: 'v1.0',
        termsVersion: 'v1.0',
      },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'password123', deviceId: 'wallet-test' },
  });
  const body = login.json();
  return { userId: Number(decodeJwt(body.accessToken).sub), token: body.accessToken };
}

/** 直接下单并履约，充值 credits（模拟支付回调/管理员履约）。 */
function fund(db, userId, credits) {
  const tier = TIERS.find((t) => t.credits === credits) ?? { tier: 'tier_49_9', priceCents: 4990, credits };
  const orderId = createOrder(db, { userId, tier: tier.tier, priceCents: tier.priceCents, credits });
  return grantCredits(db, { userId, orderId });
}

const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

test('tiers & estimate endpoints: contract catalog and server pricing', async () => {
  const { app, tmp } = await makeApp();
  try {
    const tiers = await app.inject({ method: 'GET', url: '/api/v1/wallet/tiers' });
    assert.equal(tiers.statusCode, 200);
    const body = tiers.json();
    assert.equal(body.tiers.length, 3);
    assert.deepEqual(
      body.tiers.map((t) => [t.tier, t.priceCents, t.credits]),
      [
        ['tier_9_9', 990, 100],
        ['tier_29_9', 2990, 350],
        ['tier_49_9', 4990, 700],
      ]
    );
    assert.equal(body.tiers.filter((t) => t.recommended).length, 1, '49.9 档主推');

    const billable = await app.inject({
      method: 'GET',
      url: `/api/v1/wallet/estimate?operation=${OPERATIONS.GENERATE_SECTION}`,
    });
    assert.equal(billable.statusCode, 200);
    assert.deepEqual(billable.json(), {
      operation: OPERATIONS.GENERATE_SECTION,
      credits: PRICING[OPERATIONS.GENERATE_SECTION],
      billable: true,
    });

    const free = await app.inject({
      method: 'GET',
      url: `/api/v1/wallet/estimate?operation=${OPERATIONS.PARSE_TEMPLATE}`,
    });
    assert.equal(free.json().credits, 0);
    assert.equal(free.json().billable, false);

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/wallet/estimate?operation=steal_credits' });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grantCredits: order delivered once, purchase ledger consistent with balance', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId } = await registerAndLogin(app);
    const orderId = createOrder(app.db, { userId, tier: 'tier_9_9', priceCents: 990, credits: 100 });
    const result = grantCredits(app.db, { userId, orderId });
    assert.equal(result.balance, 100);

    const order = getOrder(app.db, orderId);
    assert.equal(order.status, 'delivered');
    assert.ok(order.paid_at);

    const ledger = app.db.prepare('SELECT * FROM credit_ledger WHERE user_id = ?').get(userId);
    assert.equal(ledger.type, 'purchase');
    assert.equal(ledger.delta, 100);
    assert.equal(ledger.balance_after, 100);
    assert.equal(ledger.order_id, orderId);

    assert.equal(getWalletState(app.db, userId).balance, 100);

    // 重复履约 → 409，不重复入账
    assert.throws(() => grantCredits(app.db, { userId, orderId }), (err) => err.statusCode === 409);
    assert.equal(getWalletState(app.db, userId).balance, 100);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reserve→settle: two-phase atomic consume with ledger balance_after', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerAndLogin(app);
    fund(app.db, userId, 100);

    const { reservationId, amount } = reserveCredits(app.db, {
      userId,
      operation: OPERATIONS.GENERATE_SECTION,
      jobId: 'job-1',
    });
    assert.equal(amount, PRICING[OPERATIONS.GENERATE_SECTION]);

    let state = getWalletState(app.db, userId);
    assert.equal(state.balance, 100, 'reserve does not touch balance');
    assert.equal(state.available, 95, 'available drops by reserved amount');

    // 余额接口（auth）反映同一口径
    const balanceRes = await app.inject({ method: 'GET', url: '/api/v1/wallet/balance', headers: authHeaders(token) });
    assert.equal(balanceRes.statusCode, 200);
    assert.deepEqual(balanceRes.json(), { currency: 'credits', byokAllowed: false, balance: 100, openReservations: 5, available: 95 });

    const settle = settleReservation(app.db, { reservationId, jobId: 'job-1' });
    assert.equal(settle.balance, 95);

    state = getWalletState(app.db, userId);
    assert.equal(state.balance, 95);
    assert.equal(state.available, 95);

    const consume = app.db
      .prepare("SELECT * FROM credit_ledger WHERE user_id = ? AND type = 'consume'")
      .get(userId);
    assert.equal(consume.delta, -5);
    assert.equal(consume.balance_after, 95);
    assert.equal(consume.reservation_id, reservationId);
    assert.equal(consume.job_id, 'job-1');

    const reservation = app.db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(reservationId);
    assert.equal(reservation.status, 'settled');
    assert.equal(reservation.settle_ledger_id, consume.id);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('insufficient credits: rejected atomically, no partial deduction', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId } = await registerAndLogin(app);
    fund(app.db, userId, 3); // 只够 3

    assert.throws(
      () => reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION }),
      (err) => err.statusCode === 402 && err.code === 'insufficient_credits'
    );
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM credit_reservations').get().n, 0, '无残留预扣');
    assert.equal(getWalletState(app.db, userId).balance, 3, '余额不变');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE type = \'consume\'').get().n, 0, '无消费流水');

    // 开放预扣占用可用额度：余额补到 9，占 5 后可用 4 < 5，第二笔被拦
    fund(app.db, userId, 6);
    reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION }); // 占 5，剩 9-5=4 可用
    assert.throws(() => reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION }), (e) => e.statusCode === 402);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release restores availability; settle after release rejected; refund adds ledger', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId } = await registerAndLogin(app);
    fund(app.db, userId, 10);

    const { reservationId } = reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION });
    assert.equal(getWalletState(app.db, userId).available, 5);

    releaseReservation(app.db, { reservationId });
    const state = getWalletState(app.db, userId);
    assert.equal(state.available, 10, 'release 恢复可用额度');
    assert.equal(state.balance, 10, 'release 不动余额');

    assert.throws(
      () => settleReservation(app.db, { reservationId }),
      (err) => err.statusCode === 409 && err.code === 'reservation_not_open'
    );

    // refund：核销后失败返还
    const { reservationId: r2 } = reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION });
    settleReservation(app.db, { reservationId: r2 });
    assert.equal(getWalletState(app.db, userId).balance, 5);
    const refund = refundCredits(app.db, { userId, amount: 5, jobId: 'job-x', note: 'ai failed' });
    assert.equal(refund.balance, 10);
    const refundRow = app.db
      .prepare("SELECT * FROM credit_ledger WHERE user_id = ? AND type = 'refund'")
      .get(userId);
    assert.equal(refundRow.delta, 5);
    assert.equal(refundRow.balance_after, 10);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runIdempotent: same key never double-charges, replay returns same resultRef', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId } = await registerAndLogin(app);
    fund(app.db, userId, 100);

    const chargeOnce = () => {
      const { reservationId } = reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_CHART });
      settleReservation(app.db, { reservationId, jobId: 'idem-job' });
      return { resultRef: 'idem-job' };
    };

    const first = runIdempotent(app.db, {
      userId,
      operation: 'generate_chart',
      idemKey: 'client-key-1',
      requestHash: 'hash-1',
      fn: chargeOnce,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.resultRef, 'idem-job');

    const second = runIdempotent(app.db, {
      userId,
      operation: 'generate_chart',
      idemKey: 'client-key-1',
      requestHash: 'hash-1',
      fn: chargeOnce, // 若被重复执行会二次扣费
    });
    assert.equal(second.replayed, true);
    assert.equal(second.resultRef, 'idem-job');

    assert.equal(getWalletState(app.db, userId).balance, 100 - PRICING[OPERATIONS.GENERATE_CHART], '只扣一次');
    assert.equal(
      app.db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE type = 'consume'").get().n,
      1
    );
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deletion closeout: balance zeroed with adjust ledger, reservations released, all atomic in delete tx', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerAndLogin(app, 'closeout@test.dev');
    fund(app.db, userId, 50);
    const { reservationId } = reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_CHART });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: authHeaders(token),
      payload: { password: 'password123' },
    });
    assert.equal(res.statusCode, 204);

    const account = app.db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 0, '注销后余额清零');

    const reservation = app.db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(reservationId);
    assert.equal(reservation.status, 'released', '未结预扣在删除事务内释放');

    const adjust = app.db
      .prepare("SELECT * FROM credit_ledger WHERE user_id = ? AND type = 'adjust'")
      .get(userId);
    assert.ok(adjust, '注销收尾记 adjust 流水');
    assert.equal(adjust.delta, -50);
    assert.equal(adjust.balance_after, 0);

    // 账务一致性：流水 balance_after 与账户余额逐笔可对
    const rows = app.db
      .prepare('SELECT type, delta, balance_after FROM credit_ledger WHERE user_id = ? ORDER BY id')
      .all(userId);
    assert.deepEqual(
      rows.map((r) => [r.type, r.delta, r.balance_after]),
      [
        ['purchase', 50, 50],
        ['adjust', -50, 0],
      ]
    );
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ledger endpoint: auth required, newest first, cursor pagination', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerAndLogin(app, 'ledger@test.dev');
    fund(app.db, userId, 100);
    const { reservationId } = reserveCredits(app.db, { userId, operation: OPERATIONS.GENERATE_SECTION });
    settleReservation(app.db, { reservationId });

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/wallet/ledger' });
    assert.equal(noAuth.statusCode, 401);

    const res = await app.inject({ method: 'GET', url: '/api/v1/wallet/ledger', headers: authHeaders(token) });
    assert.equal(res.statusCode, 200);
    const entries = res.json().entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'consume', '最新在前');
    assert.equal(entries[0].delta, -5);
    assert.equal(entries[0].balanceAfter, 95);

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/wallet/ledger?limit=1&beforeId=${entries[0].id}`,
      headers: authHeaders(token),
    });
    assert.equal(page2.json().entries.length, 1);
    assert.equal(page2.json().entries[0].type, 'purchase');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pricing authority: unknown operation rejected, free ops cannot reserve', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId } = await registerAndLogin(app);
    fund(app.db, userId, 100);
    assert.throws(
      () => reserveCredits(app.db, { userId, operation: 'generate_everything' }),
      (err) => err.statusCode === 400 && err.code === 'unknown_operation'
    );
    assert.throws(
      () => reserveCredits(app.db, { userId, operation: OPERATIONS.PARSE_TEMPLATE }),
      (err) => err.statusCode === 400 && err.code === 'operation_free'
    );
    // 服务层签名不存在 credits 入口：唯一金额来源是服务端 PRICING（结构性保证，客户端传值无处生效）
    assert.equal(getWalletState(app.db, userId).balance, 100);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
