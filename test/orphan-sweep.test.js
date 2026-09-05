// test/orphan-sweep.test.js — COM-005 运维：孤儿任务启动清扫
// 背景：单进程 fork 下，服务器 kill/重启会留下 running 态任务与 reserved 预扣。
// sweepOrphanedJobs(db)：启动时把 running 任务标 failed（orphaned_by_restart）并释放其预扣。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { sweepOrphanedJobs } from '../src/services/orphan-sweep.js';
import * as jobRepo from '../src/repositories/ai-job.repository.js';
import { createOrder } from '../src/repositories/wallet.repository.js';
import { reserveCredits, grantCredits, getWalletState } from '../src/services/wallet.service.js';

function setup() {
  const db = openDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-sweep-')) });
  migrate(db);
  return db;
}
function makeUserWithCredits(db) {  // tier_9_9 固定发 100 额度
  const u = db.prepare("INSERT INTO users (email, password_hash, status) VALUES ('s@t.dev','h','active')").run();
  const uid = Number(u.lastInsertRowid);
  db.prepare('INSERT INTO accounts (user_id, balance) VALUES (?, 0)').run(uid);
  const orderId = createOrder(db, { userId: uid, tier: 'tier_9_9', priceCents: 990, credits: 100 });
  grantCredits(db, { userId: uid, orderId });
  return uid;
}
function makeRunningJob(db, uid, model = 'deepseek-v4-flash') {
  const { reservationId } = reserveCredits(db, { userId: uid, operation: 'generate_section' });
  const jobId = randomUUID();
  jobRepo.insertJob(db, { jobId, userId: uid, operation: 'generate_section', model, status: 'running', reservationId });
  return { jobId, reservationId };
}

test('清扫：running 任务标 failed(orphaned_by_restart)，预扣释放，可用额度恢复', () => {
  const db = setup();
  const uid = makeUserWithCredits(db);
  const { jobId } = makeRunningJob(db, uid);
  assert.equal(getWalletState(db, uid).available, 95, '预扣期间可用=95');

  const out = sweepOrphanedJobs(db);
  assert.equal(out.jobs, 1);
  assert.equal(out.released, 1);

  const job = jobRepo.findJobByJobId(db, jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'orphaned_by_restart');
  assert.equal(getWalletState(db, uid).available, 100, '预扣释放后可用恢复');
});

test('清扫幂等：completed 任务不动；重复清扫 0 计数；无预扣可释放不抛错', () => {
  const db = setup();
  const uid = makeUserWithCredits(db);
  const doneId = randomUUID();
  jobRepo.insertJob(db, { jobId: doneId, userId: uid, operation: 'generate_section', model: 'm', status: 'completed', creditsCharged: 5 });
  makeRunningJob(db, uid);

  const first = sweepOrphanedJobs(db);
  assert.equal(first.jobs, 1);
  const second = sweepOrphanedJobs(db);
  assert.equal(second.jobs, 0, '重复清扫为 0');
  const done = jobRepo.findJobByJobId(db, doneId);
  assert.equal(done.status, 'completed', 'completed 不被触碰');
});

test('空库清扫：0/0，不抛错', () => {
  const db = setup();
  const out = sweepOrphanedJobs(db);
  assert.deepEqual(out, { jobs: 0, released: 0 });
});
