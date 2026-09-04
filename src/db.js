// src/db.js — better-sqlite3 initialization (COM-001 skeleton)
// 契约 docs/COM-CONTRACT.md「基础设施」：SQLite WAL 四 PRAGMA 初始化第一天配死：
//   journal_mode=WAL / synchronous=NORMAL / foreign_keys=ON / busy_timeout=5000
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DATA_DIR = './data';
export const DB_FILENAME = 'app.db';

/** Resolve the data directory: explicit arg > DATA_DIR env > ./data (project-relative cwd). */
export function resolveDataDir(override) {
  const dir = override ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
  return path.resolve(dir);
}

/** Apply the four frozen PRAGMAs. WAL is persistent in the db file; the other three are per-connection. */
export function configurePragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open (and auto-create) the SQLite database inside the data dir, with contract PRAGMAs applied. */
export function openDatabase({ dataDir } = {}) {
  const dir = resolveDataDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, DB_FILENAME));
  configurePragmas(db);
  return db;
}
