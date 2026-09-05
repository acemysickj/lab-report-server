// src/services/orphan-sweep.js — 孤儿任务启动清扫（COM-005 运维）
// 背景：单进程 fork 下，进程被 kill/重启时 in-flight 任务会残留 running 态、预扣残留 reserved，
// 占住用户可用额度且永远不会结算。本模块在进程启动时（server.js listen 前）执行：
// 上一进程遗留的 running 任务必然是孤儿 → 统一标 failed（orphaned_by_restart）并释放其预扣。
// 幂等：只处理 running 态，重复执行为 0 计数。completed/failed/refunded 不触碰。
import * as jobRepo from '../repositories/ai-job.repository.js';
import * as repo from '../repositories/wallet.repository.js';

/** 清扫孤儿任务。返回 { jobs: 标记数, released: 释放预扣数 }。 */
export function sweepOrphanedJobs(db) {
  const orphans = db
    .prepare("SELECT job_id, reservation_id FROM ai_jobs WHERE status = 'running'")
    .all();
  let released = 0;
  for (const orphan of orphans) {
    jobRepo.markJobStatus(db, { jobId: orphan.job_id, status: 'failed', errorCode: 'orphaned_by_restart' });
    // 预扣可能已被关闭/注销流程释放或结算——只释放仍处 reserved 的，其余不抛错
    if (orphan.reservation_id) {
      const reservation = repo.getReservation(db, orphan.reservation_id);
      if (reservation && reservation.status === 'reserved') {
        repo.markReservationReleased(db, orphan.reservation_id);
        released += 1;
      }
    }
  }
  return { jobs: orphans.length, released };
}
