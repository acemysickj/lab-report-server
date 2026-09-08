// test/env-file.test.js — BK-006：.env 文件原子更新（upsertEnvFile）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertEnvFile } from '../src/lib/env-file.js';

function tmpEnv(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-envfile-'));
  return path.join(dir, name);
}

test('upsertEnvFile：文件不存在时创建并写入 key', () => {
  const p = tmpEnv('.env.test');
  upsertEnvFile(p, { RATE_MAX_CONCURRENT: 3, FOO: 'bar' });
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('RATE_MAX_CONCURRENT=3'));
  assert.ok(content.includes('FOO=bar'));
});

test('upsertEnvFile：已存在 key 替换值，其余行原样保留', () => {
  const p = tmpEnv('.env.test');
  fs.writeFileSync(p, 'AUTH_JWT_SECRET=abc123\nRATE_MAX_CONCURRENT=2\nRATE_PER_MINUTE=10\n# comment\n', 'utf8');
  upsertEnvFile(p, { RATE_MAX_CONCURRENT: 5 });
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('AUTH_JWT_SECRET=abc123'), 'secret 行保留');
  assert.ok(content.includes('RATE_MAX_CONCURRENT=5'), '值已替换');
  assert.ok(content.includes('RATE_PER_MINUTE=10'), '未更新 key 保留');
  assert.ok(content.includes('# comment'), '注释行保留');
  assert.ok(!content.includes('RATE_MAX_CONCURRENT=2\n'), '旧值已替换');
});

test('upsertEnvFile：新 key 追加到末尾', () => {
  const p = tmpEnv('.env.test');
  fs.writeFileSync(p, 'EXISTING=1\n', 'utf8');
  upsertEnvFile(p, { NEW_KEY: 'hello' });
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('EXISTING=1'));
  assert.ok(content.trim().endsWith('NEW_KEY=hello'), '新 key 在末尾');
});

test('upsertEnvFile：含空格值不加引号（与 ecosystem 解析口径一致——值原样）', () => {
  const p = tmpEnv('.env.test');
  upsertEnvFile(p, { BYOK_ALLOWLIST: 'a@b.com,c@d.com' });
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('BYOK_ALLOWLIST=a@b.com,c@d.com'));
});

test('upsertEnvFile：多次调用幂等（同 key 重复写入结果一致）', () => {
  const p = tmpEnv('.env.test');
  upsertEnvFile(p, { RATE_MAX_CONCURRENT: 3 });
  upsertEnvFile(p, { RATE_MAX_CONCURRENT: 3 });
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('RATE_MAX_CONCURRENT='));
  assert.equal(lines.length, 1, '只有一行 RATE_MAX_CONCURRENT');
});

test('upsertEnvFile：CRLF 文件正常处理', () => {
  const p = tmpEnv('.env.test');
  fs.writeFileSync(p, 'A=1\r\nB=2\r\n', 'utf8');
  upsertEnvFile(p, { A: '99' });
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('A=99'));
  assert.ok(content.includes('B=2'));
});
