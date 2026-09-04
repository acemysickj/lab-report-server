// test/auth.test.js — COM-002 Auth：注册(consent P-002)/登录/轮换/复用检测整族作废/注销(P-007)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeJwt } from 'jose';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { PRIVACY_POLICY_VERSION, TERMS_VERSION } from '../src/config.js';

const VALID_CONSENT = {
  acceptedPrivacyPolicy: true,
  acceptedTermsOfService: true,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
  termsVersion: TERMS_VERSION,
};

async function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-auth-'));
  const app = await buildApp({ dataDir: tmp });
  await migrate(app.db);
  return { app, tmp };
}

async function register(app, email = 'user1@test.dev', password = 'password123', consent = VALID_CONSENT) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password, consent } });
}

async function login(app, email = 'user1@test.dev', password = 'password123', deviceId = 'device-abc') {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password, deviceId } });
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

test('register: 201 + consent traceable in DB (P-002)', async () => {
  const { app, tmp } = await makeApp();
  try {
    const res = await register(app);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().email, 'user1@test.dev');

    const row = app.db.prepare('SELECT * FROM users WHERE email = ?').get('user1@test.dev');
    assert.ok(row, 'user row exists');
    assert.ok(row.privacy_consented_at, 'privacy consent timestamp persisted');
    assert.ok(row.terms_consented_at, 'terms consent timestamp persisted');
    assert.equal(row.privacy_policy_version, PRIVACY_POLICY_VERSION);
    assert.equal(row.terms_version, TERMS_VERSION);
    assert.match(row.password_hash, /^\$argon2id\$/, 'Argon2id hash stored');

    const account = app.db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(row.id);
    assert.ok(account, 'account auto-created');
    assert.equal(account.balance, 0);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('register: rejected without consent or with version mismatch (P-001/P-002)', async () => {
  const { app, tmp } = await makeApp();
  try {
    const noConsent = await register(app, 'nc@test.dev', 'password123', {
      ...VALID_CONSENT,
      acceptedPrivacyPolicy: false,
    });
    assert.equal(noConsent.statusCode, 400);

    const badVersion = await register(app, 'bv@test.dev', 'password123', {
      ...VALID_CONSENT,
      privacyPolicyVersion: 'v0.0-ancient',
    });
    assert.equal(badVersion.statusCode, 400);
    assert.equal(badVersion.json().error.code, 'consent_version_mismatch');

    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('register: duplicate email → 409', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const dup = await register(app);
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error.code, 'email_already_registered');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('login: 200, JWT payload minimal (sub/sid/iat/exp only)', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const res = await login(app);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.accessToken && body.refreshToken);
    assert.equal(body.expiresIn, 900);

    const claims = decodeJwt(body.accessToken);
    assert.deepEqual(
      Object.keys(claims).sort(),
      ['exp', 'iat', 'sid', 'sub'],
      'JWT payload must contain exactly sub/sid/iat/exp'
    );

    const session = app.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(claims.sid);
    assert.ok(session, 'session row exists for sid');
    assert.equal(session.device_id, 'device-abc');
    assert.equal(session.token_hash.length, 64, 'sha256 hex hash stored, not raw token');
    assert.notEqual(session.token_hash, body.refreshToken, 'raw refresh token never stored');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('login: wrong password / unknown email → same 401 (no enumeration)', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const wrong = await login(app, 'user1@test.dev', 'wrongpassword');
    const unknown = await login(app, 'ghost@test.dev', 'password123');
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(wrong.json().error.code, unknown.json().error.code);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('refresh rotation works; reuse of an old refresh revokes the whole family', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const loginBody = (await login(app)).json();

    // 第一次轮换：旧 refresh 换新对
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    });
    assert.equal(r1.statusCode, 200);
    const rotated = r1.json();
    assert.notEqual(rotated.refreshToken, loginBody.refreshToken);

    // 旧 refresh 重放 → 401 token_reused，整族作废
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, 'token_reused');

    // 轮换后的新 refresh 也随 family 作废
    const afterReuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    assert.equal(afterReuse.statusCode, 401);

    const familyRows = app.db
      .prepare('SELECT revoked_at FROM auth_sessions WHERE revoked_at IS NULL')
      .all();
    assert.equal(familyRows.length, 0, 'no live session remains in the family');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('logout revokes the family: refresh and access both die', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const body = (await login(app)).json();

    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth(body.accessToken) });
    assert.equal(out.statusCode, 204);

    const refreshAfterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: body.refreshToken },
    });
    assert.equal(refreshAfterLogout.statusCode, 401);

    const logoutAgain = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth(body.accessToken) });
    assert.equal(logoutAgain.statusCode, 401);
    assert.equal(logoutAgain.json().error.code, 'session_revoked');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('delete account (P-007): sessions/user data removed, accounting kept, login impossible', async () => {
  const { app, tmp } = await makeApp();
  try {
    await register(app);
    const body = (await login(app)).json();
    const userId = decodeJwt(body.accessToken).sub;

    // 预置账务数据（模拟 COM-003 之后的状态）
    app.db
      .prepare("INSERT INTO credit_ledger (user_id, type, delta, balance_after, note) VALUES (?, 'purchase', 100, 100, 'test')")
      .run(Number(userId));
    app.db
      .prepare("INSERT INTO orders (user_id, tier, price_cents, credits, status) VALUES (?, 'tier_9_9', 990, 100, 'delivered')")
      .run(Number(userId));
    app.db
      .prepare("INSERT INTO idempotency_keys (user_id, operation, idem_key, request_hash, expires_at) VALUES (?, 'generate', 'k1', 'h1', '2099-01-01T00:00:00.000Z')")
      .run(Number(userId));

    // 密码错误 → 401，不删
    const wrong = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: auth(body.accessToken),
      payload: { password: 'wrongpassword' },
    });
    assert.equal(wrong.statusCode, 401);

    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: auth(body.accessToken),
      payload: { password: 'password123' },
    });
    assert.equal(ok.statusCode, 204);

    const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    assert.ok(user, 'users row kept (FK/accounting anchor)');
    assert.equal(user.status, 'deleted');
    assert.notEqual(user.email, 'user1@test.dev', 'email anonymized');
    assert.equal(user.password_hash, '', 'password hash scrubbed');
    assert.ok(user.privacy_consented_at, 'consent trace retained for compliance (P-002/P-007)');

    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(Number(userId)).n, 0, 'sessions deleted');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id = ?').get(Number(userId)).n, 0, 'user-scoped data deleted');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?').get(Number(userId)).n, 1, 'ledger kept');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(Number(userId)).n, 1, 'orders kept');

    const relogin = await login(app);
    assert.equal(relogin.statusCode, 401, 'old credentials no longer work');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('x-request-id: echoed when provided, generated when missing', async () => {
  const { app, tmp } = await makeApp();
  try {
    const withId = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'req-12345678' } });
    assert.equal(withId.statusCode, 200);
    assert.equal(withId.headers['x-request-id'], 'req-12345678');

    const without = await app.inject({ method: 'GET', url: '/health' });
    assert.ok(without.headers['x-request-id'], 'server generates a request id');

    const errBody = (await login(app, 'ghost@test.dev', 'password123')).json();
    assert.ok(errBody.error.requestId, 'error payload carries requestId');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
