#!/usr/bin/env node
// scripts/migrate.js — apply migrations/*.sql with an append-only _migrations ledger.
// 幂等：已应用的迁移按名字跳过；已应用文件内容变化（checksum 不符）→ 立即报错。
// 每个迁移在单事务中执行（better-sqlite3 同步事务），失败即 ROLLBACK。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

function ensureLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      checksum   TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

/** Apply pending migrations to an open db. Returns { applied: string[], total: number }. */
export function migrate(db, dir = MIGRATIONS_DIR) {
  ensureLedger(db);
  const appliedRows = db.prepare('SELECT name, checksum FROM _migrations').all();
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));
  const files = listMigrations(dir);
  const newlyApplied = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    const prev = applied.get(file);
    if (prev !== undefined) {
      if (prev !== checksum) {
        throw new Error(`migration "${file}" already applied but its content changed (checksum mismatch)`);
      }
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(file, checksum);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    newlyApplied.push(file);
  }
  return { applied: newlyApplied, total: files.length };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const db = openDatabase();
  try {
    const { applied, total } = migrate(db);
    if (applied.length === 0) {
      console.log(`migrate: up to date (${total} migration file(s), nothing to apply)`);
    } else {
      console.log(`migrate: applied ${applied.join(', ')}`);
    }
  } catch (err) {
    console.error(`migrate: FAILED — ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
