// test/admin-adjust.test.js — 运营者额度调整：admin/adjust（正负均可，幂等，可审计）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';

const TOKEN = 'admin-adjust-test-0123456789ab';

async function makeServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-adjust-'));
  const app = await buildApp({ dataDir: tmp, adminToken: TOKEN });
  await migrate(app.db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, tmp, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(app, email) {
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { email, password: 'password123', consent: { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: 'v1.0', termsVersion: 'v1.0' } },
  });
  assert.equal(reg.statusCode, 201);
}

test('adjust 正值：余额增加，流水 type=adjust 可审计', async () => {
  const { app, tmp, base } = await makeServer();
  try {
    await register(app, 'a@test.dev');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'a@test.dev', delta: 5, note: '发放失误补偿' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.balance, 5);
    assert.equal(body.delta, 5);
    const row = app.db.prepare("SELECT type, delta, note FROM credit_ledger WHERE user_id=(SELECT id FROM users WHERE email='a@test.dev')").get();
    assert.equal(row.type, 'adjust');
    assert.equal(row.delta, 5);
    assert.ok(row.note.includes('发放失误补偿'));
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('adjust 负值：余额扣减但不可为负（不足时 409）', async () => {
  const { app, tmp, base } = await makeServer();
  try {
    await register(app, 'b@test.dev');
    // 先给 10
    await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'b@test.dev', delta: 10, note: '初始' } });
    // 扣 3 → 7
    const sub = await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'b@test.dev', delta: -3, note: '扣回' } });
    assert.equal(sub.statusCode, 200);
    assert.equal(sub.json().balance, 7);
    // 扣 100 → 409（余额不可为负）
    const over = await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'b@test.dev', delta: -100, note: '超扣测试' } });
    assert.equal(over.statusCode, 409);
    assert.equal(over.json().error.code, 'insufficient_balance');
    // 余额仍是 7
    assert.equal(app.db.prepare("SELECT balance FROM accounts WHERE user_id=(SELECT id FROM users WHERE email='b@test.dev')").get().balance, 7);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('adjust 零值/未知用户/错令牌拒绝', async () => {
  const { app, tmp, base } = await makeServer();
  try {
    await register(app, 'c@test.dev');
    const zero = await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'c@test.dev', delta: 0 } });
    assert.equal(zero.statusCode, 400);
    const nobody = await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { email: 'nobody@test.dev', delta: 5, note: '测试' } });
    assert.equal(nobody.statusCode, 404);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/admin/adjust',
      headers: { authorization: `Bearer wrong`, 'content-type': 'application/json' },
      payload: { email: 'c@test.dev', delta: 5, note: '测试' } });
    assert.equal(bad.statusCode, 401);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
