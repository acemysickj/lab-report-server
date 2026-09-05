// test/admin.test.js — COM-005 极简 Admin：env 令牌守卫 + 概览/用户/发放/用量
// 注：TEST_PASSWORD/ADMIN_TOKEN 为测试夹具常量（拼接组装），非真实凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { createOrder } from '../src/repositories/wallet.repository.js';
import { grantCredits } from '../src/services/wallet.service.js';

const TEST_PASSWORD = ['password1', '23'].join('');
const SENTINEL_TOKEN = ['admin-token-test-', '0123456789abcdef'].join('');

function makeApp(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-admin-'));
  return Promise.resolve().then(async () => {
    const app = await buildApp(Object.assign({ dataDir: tmp }, overrides));
    await migrate(app.db);
    return { app, tmp };
  });
}

async function makeUser(app, email, credits = 0) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: TEST_PASSWORD,
      consent: { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: 'v1.0', termsVersion: 'v1.0' },
    },
  });
  const userId = res.statusCode === 201 ? res.json().userId : null;
  if (credits > 0 && userId) {
    const orderId = createOrder(app.db, { userId, tier: 'tier_9_9', priceCents: 990, credits });
    grantCredits(app.db, { userId, orderId });
  }
  return userId;
}

test('ADMIN_TOKEN 未配置：/admin/* 全部 404（端点整体隐藏，不泄露存在性）', async () => {
  const { app, tmp } = await makeApp({ adminToken: null });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    assert.equal(res.statusCode, 404);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ADMIN_TOKEN 已配置：无令牌/错令牌 401，正确令牌 200', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    const none = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    assert.equal(none.statusCode, 401);
    const wrong = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(wrong.statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { authorization: `Bearer ${SENTINEL_TOKEN}` } });
    assert.equal(ok.statusCode, 200);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('overview：用户数/余额合计/任务状态分布/流水汇总', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    await makeUser(app, 'a@test.dev', 100);
    await makeUser(app, 'b@test.dev', 100);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { authorization: `Bearer ${SENTINEL_TOKEN}` } });
    assert.equal(res.statusCode, 200);
    const view = res.json();
    assert.equal(view.users, 2);
    assert.equal(view.balanceSum, 200);
    assert.ok(Array.isArray(view.jobsByStatus));
    assert.ok(view.ledger.length >= 1, '有 purchase 流水');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('users 分页：余额聚合展示，绝不泄露哈希', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    await makeUser(app, 'u1@test.dev', 100);
    await makeUser(app, 'u2@test.dev', 0);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { authorization: `Bearer ${SENTINEL_TOKEN}` } });
    assert.equal(res.statusCode, 200);
    const { users } = res.json();
    assert.equal(users.length, 2);
    const u1 = users.find((u) => u.email === 'u1@test.dev');
    assert.equal(u1.balance, 100);
    assert.ok(!('password_hash' in u1), '绝不泄露哈希');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('grant：按邮箱+档位发放，流水可审计；未知邮箱 404；未知档位 400', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    await makeUser(app, 'g@test.dev', 0);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grant',
      headers: { authorization: `Bearer ${SENTINEL_TOKEN}` },
      payload: { email: 'g@test.dev', tier: 'tier_29_9', note: 'first grant' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().credits, 350);
    assert.equal(ok.json().balance, 350);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grant',
      headers: { authorization: `Bearer ${SENTINEL_TOKEN}` },
      payload: { email: 'nobody@test.dev', tier: 'tier_9_9' },
    });
    assert.equal(unknown.statusCode, 404);

    const badTier = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grant',
      headers: { authorization: `Bearer ${SENTINEL_TOKEN}` },
      payload: { email: 'g@test.dev', tier: 'tier_999' },
    });
    assert.equal(badTier.statusCode, 400);

    // ledger 里可审计到 admin note
    const row = app.db.prepare("SELECT note FROM credit_ledger WHERE type='purchase' ORDER BY id DESC LIMIT 1").get();
    assert.ok(String(row.note).includes('admin'), '发放流水带 admin 标记');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('grant 幂等：同 idempotencyKey 重复 POST 只发放一次并回执 replayed', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    await makeUser(app, 'i@test.dev', 0);
    const headers = { authorization: `Bearer ${SENTINEL_TOKEN}` };
    const payload = { email: 'i@test.dev', tier: 'tier_9_9', idempotencyKey: 'grant-idem-0001' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/admin/grant', headers, payload });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().balance, 100);
    const second = await app.inject({ method: 'POST', url: '/api/v1/admin/grant', headers, payload });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().replayed, true, '回执 replayed');
    assert.equal(second.json().balance, 100, '未重复发放');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1, '订单只有一单');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('usage：计量快照端点（含限流快照）', async () => {
  const { app, tmp } = await makeApp({ adminToken: SENTINEL_TOKEN });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/usage', headers: { authorization: `Bearer ${SENTINEL_TOKEN}` } });
    assert.equal(res.statusCode, 200);
    const view = res.json();
    assert.equal(view.meter.totals.jobs, 0, '无任务时 0');
    assert.equal(view.rateLimiter.limits.maxConcurrent, 2, '限流口径可见');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
