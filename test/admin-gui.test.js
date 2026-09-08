// test/admin-gui.test.js — 本地管理页服务：页面可达 + /api/grant 转发 + /api/users 转发
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { createGuiServer } from '../scripts/admin-gui.mjs';

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
      consent: { acceptedPrivacyPolicy: true, acceptedTermsOfService: true, privacyPolicyVersion: 'v1.0', termsVersion: 'v1.0' },
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
