// src/repositories/ai-job.repository.js — ai_jobs 表访问（COM-004）
// 契约：AI 任务元数据表——只存 jobId/状态/模型/计费引用/错误码，绝不存请求或响应正文（P-006）。

export function insertJob(db, { jobId, userId, operation, model, status = 'running', reservationId, requestId, creditsCharged = 0 }) {
  const info = db
    .prepare(
      `INSERT INTO ai_jobs (job_id, user_id, operation, model, status, credits_charged, reservation_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, userId, operation, model, status, creditsCharged, reservationId ?? null, requestId ?? null);
  return Number(info.lastInsertRowid);
}

export function findJobByJobId(db, jobId) {
  return db.prepare('SELECT * FROM ai_jobs WHERE job_id = ?').get(jobId);
}

export function updateJobModel(db, { jobId, model }) {
  return db
    .prepare(
      `UPDATE ai_jobs SET model = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE job_id = ?`
    )
    .run(model, jobId);
}

/** 终态转移（completed/failed/refunded），只记录错误码——绝不记录上游错误文本（P-005）。 */
export function markJobStatus(db, { jobId, status, errorCode, creditsCharged }) {
  return db
    .prepare(
      `UPDATE ai_jobs
         SET status = ?,
             error_code = ?,
             credits_charged = COALESCE(?, credits_charged),
             completed_at = CASE WHEN ? IN ('completed', 'failed', 'refunded')
                                 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE job_id = ?`
    )
    .run(status, errorCode ?? null, creditsCharged ?? null, status, jobId);
}

/** 对外状态视图（无正文——表里本来就没有）。 */
export function toJobView(job) {
  if (!job) return null;
  return {
    jobId: job.job_id,
    status: job.status,
    operation: job.operation,
    model: job.model,
    creditsCharged: job.credits_charged,
    errorCode: job.error_code,
    createdAt: job.created_at,
    completedAt: job.completed_at,
  };
}
