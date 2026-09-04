// test/migrate.test.js — 8 张冻结表存在；重复执行幂等；_migrations 台账记录正确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { migrate, MIGRATIONS_DIR } from '../scripts/migrate.js';

const FROZEN_TABLES = [
  'users',
  'accounts',
  'credit_ledger',
  'credit_reservations',
  'auth_sessions',
  'orders',
  'ai_jobs',
  'idempotency_keys',
];

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

test('migrate creates all 8 frozen tables and is idempotent on re-run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-migrate-'));
  const db = openDatabase({ dataDir: tmp });
  try {
    const first = migrate(db, MIGRATIONS_DIR);
    assert.deepEqual(first.applied, ['0001_init.sql']);

    const tables = tableNames(db);
    for (const t of FROZEN_TABLES) {
      assert.ok(tables.includes(t), `table ${t} should exist, got: ${tables.join(', ')}`);
    }

    const second = migrate(db, MIGRATIONS_DIR);
    assert.deepEqual(second.applied, [], 'second run should apply nothing');

    const ledger = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].name, '0001_init.sql');

    // 幂等重跑后表仍然完整
    const tablesAfter = tableNames(db);
    for (const t of FROZEN_TABLES) assert.ok(tablesAfter.includes(t));
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('foreign keys are enforced on the migrated schema (users→accounts)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-fk-'));
  const db = openDatabase({ dataDir: tmp });
  try {
    migrate(db, MIGRATIONS_DIR);
    assert.throws(
      () => db.prepare('INSERT INTO accounts (user_id) VALUES (999999)').run(),
      /FOREIGN KEY constraint failed/,
      'inserting an account for a nonexistent user must violate the FK'
    );
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
