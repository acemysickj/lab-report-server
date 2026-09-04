// src/services/ai-gateway.service.js — AI 网关业务（COM-004）
// 契约：MODEL_MAP 主备 fallback；jobId 任务模型（SSE 断线 job 续存）；
// 钱包两段式计费 + L3 补偿纪律：runIdempotent 不回滚 fn 已提交的内部事务——
// 失败路径必须先自行补偿（未核销→releaseReservation；已核销→refundCredits）再抛错，
// 任何 exit path 不得留下「已扣款无凭据」状态。
// P-005/P-006：正文只在内存与 SSE 通道流转，不入日志/库/错误信息。
import { randomUUID, createHash } from 'node:crypto';
import { httpError } from '../lib/http-error.js';
import { priceOf } from '../wallet/pricing.js';
import { modelChain } from '../ai/model-map.js';
import * as jobRepo from '../repositories/ai-job.repository.js';
import {
  reserveCredits,
  settleReservation,
  releaseReservation,
  refundCredits,
  runIdempotent,
  getWalletState,
} from './wallet.service.js';

/** 创建任务（幂等）：reserve + ai_jobs(running)，统一返回 { replayed, job }。 */
export function createJob(db, { userId, operation, payload, idempotencyKey, requestId }) {
  const credits = priceOf(operation);
  if (credits === null) {
    throw httpError(400, 'unknown_operation', `未知计费操作：${operation}`);
  }
  if (credits === 0) {
    throw httpError(400, 'operation_free', '免费操作不经 AI 网关计费（本地/免费接口处理）');
  }
  if (!idempotencyKey) {
    // 无幂等键：每请求独立任务（jobId 天然唯一）
    return { replayed: false, job: createJobOnce(db, { userId, operation, payload, requestId }) };
  }
  // 余额预检（最佳努力，TOCTOU 由 reserve 原子性兜底）：避免 402 消耗掉幂等键
  const wallet = getWalletState(db, userId);
  if (wallet.available < credits) {
    throw httpError(402, 'insufficient_credits', `可用额度不足（需 ${credits}，可用 ${wallet.available}）`);
  }
  const requestHash = hashRequest({ userId, operation, payload });
  const result = runIdempotent(db, {
    userId,
    operation,
    idemKey: idempotencyKey,
    requestHash,
    fn: () => {
      const job = createJobOnce(db, { userId, operation, payload, requestId });
      return { resultRef: job.jobId, job };
    },
  });
  if (result.replayed) {
    const existing = result.resultRef ? jobRepo.findJobByJobId(db, result.resultRef) : null;
    if (!existing) {
      // 首次执行已失败（fn 抛错被 runIdempotent 标 failed）——无任务可回执，让调用方重试
      throw httpError(409, 'idempotency_retry', '同幂等键首次执行未成功，请更换幂等键重试');
    }
    return { replayed: true, job: jobRepo.toJobView(existing) }; // 归一 camelCase（路由读 jobId/status）
  }
  return { replayed: false, job: result.outcome.job };
}

function createJobOnce(db, { userId, operation, payload, requestId }) {
  // L3：reserve 是已提交事务——此后任何失败路径必须补偿（release/refund）再抛错
  const { reservationId } = reserveCredits(db, { userId, operation });
  const jobId = randomUUID(); // 独立于 X-Request-Id
  try {
    jobRepo.insertJob(db, {
      jobId,
      userId,
      operation,
      model: modelChain()[0],
      status: 'running',
      reservationId,
      requestId,
    });
  } catch (err) {
    releaseReservation(db, { reservationId }); // 补偿后再抛
    throw err;
  }
  return { jobId, reservationId, userId, operation, status: 'running' };
}

/**
 * 执行任务：主备 fallback 流式调用；成功 settle+completed（全文入进程内 TTL 缓存，裁决③）；
 * 失败按 L3 补偿（未核销→release+failed；已核销→refund+refunded）。
 * onEvent(type, data) 只收元数据与文本增量（SSE 通道，不落盘）。
 */
export async function executeJob(db, { job, payload, transport, onEvent, contentCache, usageMeter }) {
  const { jobId, reservationId } = job;
  let settled = false;
  let settledAmount = null;
  const startedAt = Date.now();
  const usageAcc = { promptTokens: 0, completionTokens: 0 }; // COM-005：跨主备尝试累计（失败尝试的 token 同样产生成本）
  let lastModel = null;
  let metered = false; // 防双计：成功路径与外层 catch 各只有一个入口真正落账
  const recordUsage = (model, credits) => {
    if (!usageMeter || metered) return;
    metered = true;
    usageMeter.record({
      jobId,
      userId: job.userId ?? job.user_id,
      operation: job.operation,
      model,
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      durationMs: Date.now() - startedAt,
      credits,
    });
  };
  try {
    if (transport && transport.available === false) {
      throw httpError(503, 'ai_not_configured', 'AI 服务未配置（DEEPSEEK_API_KEY 缺失）');
    }
    let lastError = null;
    for (const model of modelChain()) {
      let emitted = false; // 本模型是否已向客户端发出过正文增量（try/catch 块外声明，catch 可见）
      lastModel = model;
      const attemptUsage = { promptTokens: 0, completionTokens: 0 };
      try {
        let text = '';
        jobRepo.updateJobModel(db, { jobId, model });
        for await (const delta of transport.stream(model, payload, {
          onUsage: (u) => {
            attemptUsage.promptTokens += Number(u?.prompt_tokens) || 0;
            attemptUsage.completionTokens += Number(u?.completion_tokens) || 0;
          },
        })) {
          text += delta;
          emitted = true;
          onEvent('part', { text: delta }); // 正文仅进 SSE
        }
        usageAcc.promptTokens += attemptUsage.promptTokens;
        usageAcc.completionTokens += attemptUsage.completionTokens;
        // 流完整结束 → 核销扣费（此后失败走 refund 补偿）
        const settle = settleReservation(db, { reservationId, jobId });
        settled = true;
        settledAmount = settle.amount;
        jobRepo.markJobStatus(db, { jobId, status: 'completed', creditsCharged: settle.amount });
        // 裁决③：全文只进进程内存缓存（有界 TTL），供断线后 GET /jobs/:id/content 取回
        if (contentCache) contentCache.put(jobId, text);
        // COM-005 成本计量：仅元数据进内存环（token/时长/扣费），正文绝不入计量（P-005/P-006）
        recordUsage(model, settle.amount);
        onEvent('done', { jobId, model, credits: settle.amount, textLength: text.length });
        return { status: 'completed', model, credits: settle.amount, textLength: text.length };
      } catch (err) {
        lastError = err;
        // 失败尝试同样产生上游成本——计入累计后再决定重试/失败
        usageAcc.promptTokens += attemptUsage.promptTokens;
        usageAcc.completionTokens += attemptUsage.completionTokens;
        if (emitted) {
          // 半途失败：fallback 会重跑全量造成「半截+全文」拼接污染，正文只能不重试——
          // 直接走失败路径（release），宁失败不串文
          break;
        }
        continue; // 零增量失败 → 换备模型重试
      }
    }
    throw classifyUpstreamError(lastError);
  } catch (err) {
    // COM-005：失败任务同样计入成本观测（credits 记已结算额——若 settled 后补偿，用户侧已退）
    recordUsage(lastModel, settledAmount ?? 0);
    // L3 补偿：先补偿再抛错/上报（refundAmount 用内存中的结算金额，不依赖回库读值）
    compensate(db, { jobId, reservationId, settled, refundAmount: settledAmount, errorCode: err.code ?? 'ai_failed' });
    onEvent('error', { code: err.code ?? 'ai_failed', jobId }); // 只含错误码+jobId（P-005）
    return { status: settled ? 'refunded' : 'failed', errorCode: err.code ?? 'ai_failed' };
  }
}

/** L3 补偿：未核销→release+failed；已核销→refund+refunded。refundAmount 优先于回库读值（markJobStatus 失败窗口内表值可能为 0）。 */
export function compensate(db, { jobId, reservationId, settled, refundAmount, errorCode }) {
  if (settled) {
    const job = jobRepo.findJobByJobId(db, jobId);
    const amount = refundAmount ?? job?.credits_charged;
    refundCredits(db, {
      userId: job.user_id,
      amount,
      jobId,
      note: 'ai failed after settle',
    });
    jobRepo.markJobStatus(db, { jobId, status: 'refunded', errorCode });
    return 'refunded';
  }
  releaseReservation(db, { reservationId });
  jobRepo.markJobStatus(db, { jobId, status: 'failed', errorCode });
  return 'failed';
}

export function getJobStatus(db, { userId, jobId }) {
  const job = jobRepo.findJobByJobId(db, jobId);
  if (!job || job.user_id !== userId) return null; // 他人任务一律 404（不泄露存在性）
  return jobRepo.toJobView(job);
}

function classifyUpstreamError(err) {
  if (!err) return httpError(502, 'ai_upstream_error', 'AI 上游不可用');
  if (err.code === 'ai_not_configured') {
    return httpError(503, 'ai_not_configured', 'AI 服务未配置（DEEPSEEK_API_KEY 缺失）');
  }
  if (err.code === 'invalid_payload') {
    return httpError(400, 'invalid_payload', '业务负载无效');
  }
  const status = Number.parseInt(String(err.code ?? '').replace('http_', ''), 10);
  if (Number.isInteger(status) && status === 401) {
    return httpError(502, 'ai_auth_error', 'AI 上游认证失败（服务端密钥问题）');
  }
  return httpError(502, 'ai_upstream_error', `AI 上游错误（${err.code ?? 'unknown'}）`);
}

function hashRequest({ userId, operation, payload }) {
  // 只哈希不存正文：幂等键表存 SHA-256 摘要（P-006）
  return createHash('sha256')
    .update(JSON.stringify([userId, operation, payload]))
    .digest('hex');
}
