// test/auth-rate-limit.test.js — COM-005 扩展：认证端点防爆破限流（按 IP）
// 设计约束：①只统计尝试本身（不区分邮箱是否存在）→ 保住 login 的防枚举口径（429/401 无差别暴露）；
// ②IP 取自 X-Forwarded-For（trustProxy，生产由 Nginx 覆写）；③login/register/refresh 共享同一预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { PRIVACY_POLICY_VERSION, TERMS_VERSION } from '../src/config.js';

const CONSENT = { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION, termsVersion: TERMS_VERSION };

async function makeApp(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-authrl-'));
  const app = await buildApp(Object.assign({ dataDir: tmp }, overrides));
  await migrate(app.db);
  return { app, tmp };
}

async function login(app, ip, email = 'victim@test.dev', password = 'wrong-pass') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    payload: { email, password },
  });
}

test('登录爆破：同 IP 第 6 次尝试 429（含改对密码也 429——IP 锁定不认凭据）', async () => {
  const { app, tmp } = await makeApp({ authRateLimits: { maxConcurrent: 9999, perMinute: 5, perHour: 999 } });
  try {
    for (let i = 1; i <= 5; i++) {
      const res = await login(app, '203.0.113.10');
      assert.equal(res.statusCode, 401, `第 ${i} 次应为 401（防枚举口径）`);
    }
    const blocked = await login(app, '203.0.113.10');
    assert.equal(blocked.statusCode, 429, '第 6 次触发限流');
    assert.equal(blocked.json().error.code, 'rate_limited');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);

    // 攻击者试出正确密码也不能在窗口内通过（IP 锁定）
    const correct = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'real@test.dev', password: 'right-pass-123', consent: CONSENT },
    });
    assert.equal(correct.statusCode, 201);
    const bypass = await login(app, '203.0.113.10', 'real@test.dev', 'right-pass-123');
    assert.equal(bypass.statusCode, 429, '正确密码也被 IP 锁定拦下');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('防枚举：不存在的邮箱同样消耗 IP 预算（429/401 无差别）', async () => {
  const { app, tmp } = await makeApp({ authRateLimits: { maxConcurrent: 9999, perMinute: 3, perHour: 999 } });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await login(app, '203.0.113.20', `probe${i}@nonexist.test`);
      assert.equal(res.statusCode, 401);
    }
    const denied = await login(app, '203.0.113.20', 'probe-nonexist@nonexist.test');
    assert.equal(denied.statusCode, 429, '探测不存在邮箱也被限流——无法区分邮箱存在性');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('IP 隔离：不同来源互不影响；窗口滚动后恢复', async () => {
  let now = 1_000_000;
  const { createRateLimiter } = await import('../src/ai/rate-limiter.js');
  const limiter = createRateLimiter({ maxConcurrent: 9999, perMinute: 2, perHour: 999, now: () => now });
  const { app, tmp } = await makeApp({ authRateLimiter: limiter });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await login(app, '198.51.100.1')).statusCode, 401);
    assert.equal((await login(app, '198.51.100.1')).statusCode, 429, 'A IP 第 3 次限流');
    assert.equal((await login(app, '198.51.100.2')).statusCode, 401, 'B IP 不受 A 影响');
    now += 60 * 1000; // A 的分钟窗口滚动
    assert.equal((await login(app, '198.51.100.1')).statusCode, 401, '窗口滚动后恢复');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('register/refresh 与 login 共享同一 IP 预算', async () => {
  const { app, tmp } = await makeApp({ authRateLimits: { maxConcurrent: 9999, perMinute: 2, perHour: 999 } });
  try {
    const ip = '203.0.113.30';
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      payload: { email: 'r1@test.dev', password: 'password123', consent: CONSENT },
    });
    assert.equal(reg.statusCode, 201);
    const badLogin = await login(app, ip, 'r1@test.dev', 'wrong');
    assert.equal(badLogin.statusCode, 401, '第 2 次（login）仍放行');
    const third = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      payload: { refreshToken: 'x'.repeat(20) },
    });
    assert.equal(third.statusCode, 429, '第 3 次（refresh）触发共享预算限流');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
