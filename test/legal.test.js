// test/legal.test.js — GET /legal/* 法务文档路由（DOM-003：渲染 HTML + ?format=raw 保留）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('GET /legal/privacy renders HTML with P-004 third-party disclosure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/privacy' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.body.includes('<h1>'), '标题渲染为 HTML');
    assert.ok(res.body.includes('隐私政策'));
    assert.ok(res.body.includes('DeepSeek'), 'P-004 third-party AI disclosure present');
    assert.ok(!/[«]|(^|\n)#{1,3}\s/.test(res.body.replace(/<[^>]+>/g, '')), '无裸 md 标题符号残留');
    assert.ok(res.body.includes('粤ICP备2026135392号'), '备案号页脚（DOM-001 口径）');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /legal/terms renders v1.1 HTML: no bare md symbols, raw escape hatch kept', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal2-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/terms' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.body.includes('<h1>'));
    assert.ok(res.body.includes('<strong>'), '粗体渲染');
    assert.ok(res.body.includes('v1.1'), 'DOM-003：v1.1 生效');
    assert.ok(res.body.includes('理解并同意'), '用户权威文本对齐（product 比对点）');
    const visible = res.body.replace(/<[^>]+>/g, '');
    assert.ok(!/\*\*|^#{1,3}\s/m.test(visible), '无裸 **/## md 源码符号');

    const raw = await app.inject({ method: 'GET', url: '/legal/terms?format=raw' });
    assert.equal(raw.statusCode, 200);
    assert.match(raw.headers['content-type'], /text\/markdown/);
    assert.ok(raw.body.startsWith('# '));
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /legal/account-deletion renders HTML（DOM-003 三份全覆盖）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-legal4-'));
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/legal/account-deletion' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.body.includes('<h1>'));
    assert.ok(res.body.includes('删除账号'));
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
