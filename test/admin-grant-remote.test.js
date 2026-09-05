// test/admin-grant-remote.test.js — 运营者发放脚本的非交互核心（真实 HTTP 到本地起的服务）
// 注：TEST_PASSWORD 为测试夹具（拼接组装），非真实凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { grantRemote, pickTier } from '../scripts/admin-grant.mjs';

const TEST_PASSWORD = ['pass', 'word123'].join('');
const TOKEN = 'admin-grant-test-0123456789abcdef';

async function makeServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-grant-remote-'));
  const app = await buildApp({ dataDir: tmp, adminToken: TOKEN });
  await migrate(app.db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  return { app, tmp, serverUrl: `http://127.0.0.1:${port}` };
}

async function register(app, email) {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: TEST_PASSWORD,
      consent: { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: 'v1.0', termsVersion: 'v1.0' },
    },
  });
  assert.equal(reg.statusCode, 201);
}

test('grantRemote：正确发放并回显余额', async () => {
  const { app, tmp, serverUrl } = await makeServer();
  try {
    await register(app, 'payer@test.dev');
    const out = await grantRemote({ serverUrl, token: TOKEN, email: 'payer@test.dev', tier: 'tier_49_9' });
    assert.equal(out.credits, 700);
    assert.equal(out.balance, 700);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('grantRemote：错令牌/未知邮箱抛可读错误', async () => {
  const { app, tmp, serverUrl } = await makeServer();
  try {
    await assert.rejects(
      () => grantRemote({ serverUrl, token: 'wrong', email: 'x@test.dev', tier: 'tier_9_9' }),
      (e) => /令牌|HTTP/.test(e.message)
    );
    await assert.rejects(
      () => grantRemote({ serverUrl, token: TOKEN, email: 'nobody@test.dev', tier: 'tier_9_9' }),
      (e) => /用户不存在/.test(e.message)
    );
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pickTier：1/2/3 映射档位，非法值报错', () => {
  assert.equal(pickTier('3').credits, 700);
  assert.equal(pickTier(2).tier, 'tier_29_9');
  assert.throws(() => pickTier('9'));
});
