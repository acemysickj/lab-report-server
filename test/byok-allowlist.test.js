// test/byok-allowlist.test.js — BK-008 step1（ADR-003）：BYOK 白名单标志下发
// 契约（客户端 42add26，fail-open）：byokAllowed 仅 false 才隐藏 BYOK；缺省字段=允许。
// 服务端语义：BYOK_ALLOWLIST 未配置/空 → 全员 false（ADR-003「默认全员不可用」）；
// 名单内（trim+小写归一）→ true。下发通道：login/register/refresh 响应 + /wallet/balance。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { parseByokAllowlist, byokAllowedFor } from '../src/config.js';

const PASSWORD = 'password123';

async function makeApp(byokAllowlist) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-byok-'));
  const app = await buildApp({ dataDir: tmp, byokAllowlist });
  await migrate(app.db);
  return { app, tmp };
}

async function register(app, email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: PASSWORD,
      consent: {
        acceptedPrivacyPolicy: true,
        acceptedTermsOfService: true,
        privacyPolicyVersion: 'v1.0',
        termsVersion: 'v1.0',
      },
    },
  });
  return res.json();
}

async function login(app, email) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return res.json();
}

const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

test('parseByokAllowlist: comma-separated emails, trim + lowercase normalize; empty → empty set', () => {
  const set = parseByokAllowlist(' A@Dev.cn , b@test.dev ,,  ');
  assert.equal(set.size, 2);
  assert.ok(set.has('a@dev.cn'));
  assert.ok(set.has('b@test.dev'));
  assert.equal(parseByokAllowlist(undefined).size, 0);
  assert.equal(parseByokAllowlist('').size, 0);
  assert.equal(byokAllowedFor(set, '  A@DEV.CN '), true); // 大小写/空白归一比对
  assert.equal(byokAllowedFor(set, 'c@test.dev'), false);
  assert.equal(byokAllowedFor(null, 'a@dev.cn'), false); // 名单缺失 → false（非 undefined）
  assert.equal(byokAllowedFor(set, undefined), false);
});

test('BK-008 step1: login/register/refresh/balance 下发 byokAllowed（白名单内 true）', async () => {
  const { app, tmp } = await makeApp(new Set(['vip@test.dev']));
  try {
    const reg = await register(app, 'vip@test.dev');
    assert.equal(reg.byokAllowed, true, '注册响应透传 byokAllowed');

    const loginBody = await login(app, 'vip@test.dev');
    assert.equal(loginBody.byokAllowed, true, '登录响应透传');

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    });
    assert.equal(refresh.json().byokAllowed, true, 'refresh 响应透传');

    const balance = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: authHeaders(loginBody.accessToken),
    });
    assert.equal(balance.json().byokAllowed, true, '状态通道（/wallet/balance）下发');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BK-008 step1: 名单外用户 byokAllowed=false（未配置白名单 → 全员 false，ADR-003 默认不可用）', async () => {
  const { app, tmp } = await makeApp(new Set(['vip@test.dev']));
  try {
    const reg = await register(app, 'outsider@test.dev');
    assert.equal(reg.byokAllowed, false);
    const loginBody = await login(app, 'outsider@test.dev');
    assert.equal(loginBody.byokAllowed, false);
    const balance = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: authHeaders(loginBody.accessToken),
    });
    assert.equal(balance.json().byokAllowed, false);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BK-008 step1: 未配置 BYOK_ALLOWLIST（空名单）→ 所有用户 byokAllowed=false（字段显式下发，非缺省）', async () => {
  const { app, tmp } = await makeApp(undefined); // buildApp 缺省取 env（测试进程未设 → 空集）
  try {
    const loginBody = await login(app, (await register(app, 'anyone@test.dev')).email);
    assert.equal(loginBody.byokAllowed, false);
    const balance = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: authHeaders(loginBody.accessToken),
    });
    assert.equal(balance.json().byokAllowed, false);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
