// test/admin-gui.test.js — 本地管理页服务：页面可达 + /api/grant 转发 + /api/users 转发
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { createGuiServer } from '../scripts/admin-gui.mjs';
import { PRIVACY_POLICY_VERSION, TERMS_VERSION } from '../src/config.js';

const TOKEN = 'admin-gui-test-0123456789abcdef';
const TEST_PASSWORD = ['pass', 'word123'].join('');

async function makeStack() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-gui-'));
  const app = await buildApp({ dataDir: tmp, adminToken: TOKEN });
  await migrate(app.db);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: 'buyer@test.dev',
      password: TEST_PASSWORD,
      consent: { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION, termsVersion: TERMS_VERSION },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const appPort = app.server.address().port;
  const gui = await createGuiServer({ serverUrl: `http://127.0.0.1:${appPort}`, port: 0 });
  const guiPort = gui.address().port;
  return { app, tmp, gui, base: `http://127.0.0.1:${guiPort}` };
}

test('GET /：管理页可达且包含档位', async () => {
  const { app, tmp, gui, base } = await makeStack();
  try {
    const res = await fetch(base + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('tier_49_9') && html.includes('确认发放'));
    assert.ok(html.includes('扣/调额度') && html.includes('确认调整'), 'BK-009：双操作入口');
  } finally {
    gui.close(); await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/adjust：加/扣回显余额；超扣透传服务端 409 文案；幂等回执 replayed；未知邮箱透传 404 文案', async () => {
  const { app, tmp, gui, base } = await makeStack();
  const post = (payload) =>
    fetch(base + '/api/adjust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, email: 'buyer@test.dev', ...payload }),
    });
  try {
    // 正值补发 → 余额增加
    const add = await (await post({ delta: 700, note: '测试补发' })).json();
    assert.equal(add.balance, 700);
    // 负值扣减 → 余额减少（A2 正路）
    const sub = await (await post({ delta: -30, note: '测试扣减' })).json();
    assert.equal(sub.balance, 670);
    // 超扣 → 服务端 409 文案透传（A2）
    const over = await post({ delta: -1000, note: '超扣测试' });
    const overBody = await over.json();
    assert.notEqual(over.status, 200);
    assert.ok(overBody.error.includes('余额不足'), '透传服务端余额不足文案：' + overBody.error);
    // 幂等：同键第二次 → replayed:true（A3 的 GUI 面口径）
    const first = await (await post({ delta: 10, note: '幂等测试', idempotencyKey: 'gui-test-key-0001' })).json();
    const second = await (await post({ delta: 10, note: '幂等测试', idempotencyKey: 'gui-test-key-0001' })).json();
    assert.equal(first.replayed, undefined);
    assert.equal(second.replayed, true);
    assert.equal(second.balance, first.balance, '重放回执当前余额且不重复加');
    // 未知邮箱 → 服务端 404 文案透传（A4 的 GUI 面）
    const missing = await post({ email: 'nobody@test.dev', delta: 10, note: '不存在用户' });
    const missingBody = await missing.json();
    assert.notEqual(missing.status, 200);
    assert.ok(missingBody.error.includes('用户不存在'), '透传用户不存在文案');
  } finally {
    gui.close(); await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/grant：正确发放回显余额；错令牌 502 带错误信息', async () => {
  const { app, tmp, gui, base } = await makeStack();
  try {
    const ok = await fetch(base + '/api/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, email: 'buyer@test.dev', tier: 'tier_49_9' }),
    });
    const okBody = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(okBody.balance, 700);

    const bad = await fetch(base + '/api/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token', email: 'buyer@test.dev', tier: 'tier_9_9' }),
    });
    const badBody = await bad.json();
    assert.notEqual(bad.status, 200);
    assert.ok(badBody.error, '错误信息透传');
  } finally {
    gui.close(); await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/users：转发最近注册用户（供选邮箱）', async () => {
  const { app, tmp, gui, base } = await makeStack();
  try {
    const res = await fetch(base + '/api/users?token=' + encodeURIComponent(TOKEN));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.users.some((u) => u.email === 'buyer@test.dev'));
  } finally {
    gui.close(); await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
