// test/backup-db.test.js — SQLite 热备脚本：快照含数据 + 轮转保留 N 份 + 缺源报错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase } from '../scripts/backup-db.js';
import { DB_FILENAME } from '../src/db.js';

function makeSrcDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-bak-src-'));
  const db = new Database(path.join(dir, DB_FILENAME));
  db.prepare("CREATE TABLE demo (id INTEGER PRIMARY KEY, note TEXT)").run();
  db.prepare("INSERT INTO demo (note) VALUES ('prod-data-marker')").run();
  db.close();
  return dir;
}

test('backup：快照文件可读且包含生产数据', async () => {
  const srcDir = makeSrcDb();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-bak-out-'));
  const r = await backupDatabase({ dataDir: srcDir, outDir, keep: 7, now: new Date('2026-09-05T08:00:00Z') });
  assert.ok(fs.existsSync(r.dest));
  assert.match(path.basename(r.dest), /lab-report-server-\d{14}\.db/);
  const restored = new Database(r.dest, { readonly: true });
  const row = restored.prepare('SELECT note FROM demo').get();
  restored.close();
  assert.equal(row.note, 'prod-data-marker');
});

test('轮转：超过 keep 份数时删除最旧', async () => {
  const srcDir = makeSrcDb();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-bak-rot-'));
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(outDir, `lab-report-server-2026090100000${i}.db`), 'old');
  }
  const r = await backupDatabase({ dataDir: srcDir, outDir, keep: 3, now: new Date('2026-09-05T08:00:00Z') });
  const left = fs.readdirSync(outDir).filter((f) => f.endsWith('.db'));
  assert.equal(left.length, 3, '总数保持 keep 份');
  assert.ok(left.includes(path.basename(r.dest)), '新备份在列');
  assert.ok(!left.some((f) => f.includes('20260901000001')), '最旧的被删除');
});

test('源库不存在：明确报错', async () => {
  await assert.rejects(
    () => backupDatabase({ dataDir: path.join(os.tmpdir(), 'lrs-bak-missing-xyz'), outDir: os.tmpdir(), keep: 1 }),
    (e) => /源数据库不存在/.test(e.message)
  );
});
