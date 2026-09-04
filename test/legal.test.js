// test/legal.test.js — GET /legal/privacy 与 /legal/terms 服务 t2 文案（COM-002）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('GET /legal/privacy serves the privacy policy markdown', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/privacy' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/markdown/);
    assert.ok(res.body.includes('隐私政策'));
    assert.ok(res.body.includes('DeepSeek'), 'P-004 third-party AI disclosure present');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /legal/terms serves the terms of service markdown', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal2-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/terms' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('服务协议'));
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown legal path → 404 shaped error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal3-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/unknown' });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
