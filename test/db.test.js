// test/db.test.js — 四条冻结 PRAGMA 断言（journal_mode=WAL / synchronous=NORMAL /
// foreign_keys=ON / busy_timeout=5000），DATA_DIR 环境变量覆盖生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resolveDataDir } from '../src/db.js';

test('openDatabase applies the four frozen PRAGMAs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-pragmas-'));
  let db;
  try {
    db = openDatabase({ dataDir: tmp });
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 1); // 1 = NORMAL
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.ok(fs.existsSync(path.join(tmp, 'app.db')));
  } finally {
    if (db) db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DATA_DIR env override is honored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-envdir-'));
  const prev = process.env.DATA_DIR;
  let db;
  try {
    process.env.DATA_DIR = tmp;
    assert.equal(resolveDataDir(), path.resolve(tmp));
    db = openDatabase();
    assert.ok(fs.existsSync(path.join(tmp, 'app.db')));
  } finally {
    if (db) db.close();
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
