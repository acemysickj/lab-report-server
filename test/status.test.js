// test/status.test.js — OPS-002：公开服务状态端点（无鉴权、零敏感信息）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';

async function makeApp(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-status-'));
  const app = await buildApp(Object.assign({ dataDir: tmp }, overrides));
  await migrate(app.db);
  return { app, tmp };
}

test('GET /api/v1/status：api=ok，ai 按密钥门与 transport 状态，含 version/serverTime；无鉴权', async () => {
  const fake = { available: true, probe: async () => {} }; // probe 正常返回 = 上游可达
  const { app, tmp } = await makeApp({ aiTransport: fake });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.api, 'ok');
    assert.equal(body.ai, 'ok', 'transport 可用 → ai ok');
    assert.ok(body.version, '含服务端版本');
    assert.ok(body.serverTime, '含服务器时间');
    // 无敏感信息
    const raw = res.body;
    assert.ok(!/token|secret|password|Bearer/i.test(raw), '不含凭据类字段');
    assert.ok(!('db' in body) && !('env' in body) && !('users' in body), '不暴露内部细节');
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ai 状态三态：ok / degraded(降级=不可达或限流满) / not_configured(密钥缺失)', async () => {
  // not_configured：available=false
  const a = await makeApp({ aiTransport: { available: false } });
  try {
    const r1 = await a.app.inject({ method: 'GET', url: '/api/v1/status' });
    assert.equal(r1.json().ai, 'not_configured');
  } finally { await a.app.close(); fs.rmSync(a.tmp, { recursive: true, force: true }); }

  // degraded：transport 抛错（上游不可达探测失败）
  const failing = { available: true, async *stream() { throw Object.assign(new Error('down'), { code: 'http_503' }); } };
  const b = await makeApp({ aiTransport: failing });
  try {
    const r2 = await b.app.inject({ method: 'GET', url: '/api/v1/status' });
    assert.equal(r2.json().ai, 'degraded');
  } finally { await b.app.close(); fs.rmSync(b.tmp, { recursive: true, force: true }); }
});

test('status 不做任何写操作、不消耗限流预算，可匿名高频轮询', async () => {
  const { app, tmp } = await makeApp();
  try {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/status' });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 0);
  } finally { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
