// test/health.test.js — GET /health must return 200 {"status":"ok"} (contract)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

function tempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('GET /health → 200 {"status":"ok"}', async () => {
  const tmp = tempDataDir('lrs-health-');
  const app = await buildApp({ dataDir: tmp });
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true }); // 临时目录用完即清
  }
});

test('buildApp opens db under the given data dir and closes cleanly', async () => {
  const tmp = tempDataDir('lrs-app-db-');
  const app = await buildApp({ dataDir: tmp });
  try {
    assert.ok(app.db && app.db.open, 'app.db connection should be open');
    assert.ok(fs.existsSync(path.join(tmp, 'app.db')), 'app.db should be auto-created');
  } finally {
    await app.close();
    assert.ok(!app.db.open, 'db should be closed on app close');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
