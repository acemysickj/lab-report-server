// src/routes/ai.js — AI 网关路由（COM-004）
// 线上格式（裁决①出路 A）：正文走 OpenAI 兼容块 data:{"choices":[{"delta":{"content":...}}]}
// 与终止行 data:[DONE]——Phase 1 客户端 llm-client.js 解析器零改动即可消费；
// 平台元数据走独立具名事件（event: job/done/error，客户端静默跳过，互不破坏）+ X-Job-Id 响应头（裁决③）。
// payload 白名单（裁决②）：{system,user,temperature}，其余字段 400；model/credits/price 服务端权威，
// 顶层 additionalProperties:false——服务端无任何接受它们的入口。
// GET /ai/jobs/:jobId：断线续存状态查询（无正文）；GET /ai/jobs/:jobId/content：已完成任务
// 全文取回（进程内 TTL 缓存，非持久化，P-006 边界见 content-cache.js）。
// 正文不落日志/库/dump（P-005/P-006）。限流（2/10/50）由 COM-005 统一挂载。
import * as gateway from '../services/ai-gateway.service.js';

const PAYLOAD_MAX = { system: 8000, user: 32000 }; // 字符上限（防御性，超出 400）

function sseSend(raw, event, data) {
  if (raw.destroyed || raw.writableEnded) return; // 断线：停止发送，但计费继续走完（job 续存）
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** OpenAI 兼容 chunk：Phase 1 客户端解析器只认 choices[0].delta.content，其余字段可为空壳。 */
function sseContentChunk(raw, jobId, content) {
  if (raw.destroyed || raw.writableEnded) return;
  raw.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${jobId}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`
  );
}

function sseDone(raw) {
  if (raw.destroyed || raw.writableEnded) return;
  raw.write('data: [DONE]\n\n');
}

export default async function aiRoutes(app) {
  app.post('/ai/jobs', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['operation', 'payload'],
        additionalProperties: false,
        properties: {
          // operation 合法性由网关按 PRICING 分类（unknown_operation/operation_free 语义错误码），
          // 不在 schema 用 enum 拦截，避免语义码被 FST_ERR_VALIDATION 覆盖
          operation: { type: 'string', maxLength: 64 },
          payload: {
            type: 'object',
            required: ['user'],
            additionalProperties: false, // 裁决②：白名单外一律 400
            properties: {
              system: { type: 'string', maxLength: PAYLOAD_MAX.system },
              user: { type: 'string', minLength: 1, maxLength: PAYLOAD_MAX.user },
              temperature: { type: 'number', minimum: 0, maximum: 2 },
            },
          },
          idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
    },
    handler: async (request, reply) => {
      // 预检：密钥未配置直接 503（hijack 之前，保留统一错误整形）
      if (!app.aiTransport || app.aiTransport.available === false) {
        return reply.code(503).send({
          error: { code: 'ai_not_configured', message: 'AI 服务未配置（DEEPSEEK_API_KEY 缺失）', requestId: request.id },
        });
      }

      // COM-005 限流（契约风控：并发 2 / 每分钟 10 / 每小时 50）——hijack 前 429 JSON 整形
      const acquire = app.aiRateLimiter.tryAcquire(request.user.id);
      if (!acquire.ok) {
        const scopeText = acquire.scope === 'concurrent' ? '并发任务数达上限' : acquire.scope === 'minute' ? '每分钟请求数达上限' : '每小时请求数达上限';
        return reply
          .code(429)
          .header('retry-after', String(acquire.retryAfterSeconds))
          .send({
            error: { code: 'rate_limited', message: `${scopeText}，请 ${acquire.retryAfterSeconds} 秒后重试`, scope: acquire.scope, retryAfter: acquire.retryAfterSeconds, requestId: request.id },
          });
      }

      try {
        const { operation, payload, idempotencyKey } = request.body;
        const { replayed, job } = gateway.createJob(app.db, {
          userId: request.user.id,
          operation,
          payload,
          idempotencyKey,
          requestId: request.id,
        });

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': request.id,
        'x-job-id': job.jobId, // 裁决③：jobId 首字节前即可得（客户端断线续存用）
      });
      // SSE 流式帧极小且密集——禁用 Nagle，避免与对端延迟 ACK 相互作用造成逐帧 40ms 级卡顿
      if (raw.socket && typeof raw.socket.setNoDelay === 'function') raw.socket.setNoDelay(true);

        sseSend(raw, 'job', { jobId: job.jobId, replayed: Boolean(replayed) });

        if (replayed) {
          // 幂等重放：不重新执行（正文从不落盘，无法重放内容）；回执原 jobId 与其终态。
          // done 事件带 model/credits（来自任务行），无 textLength——正文从不落盘，无从统计
          sseSend(raw, 'done', {
            jobId: job.jobId,
            replayed: true,
            status: job.status,
            model: job.model ?? null,
            credits: job.creditsCharged ?? null,
          });
          sseDone(raw);
          raw.end();
          return;
        }

        await gateway.executeJob(app.db, {
          job,
          payload,
          transport: app.aiTransport,
          contentCache: app.aiContentCache,
          usageMeter: app.aiUsageMeter,
          onEvent: (event, data) => {
            if (event === 'part') sseContentChunk(raw, job.jobId, data.text);
            else sseSend(raw, event, data);
          },
        });
        sseDone(raw);
        raw.end();
      } finally {
        app.aiRateLimiter.release(request.user.id); // 并发槽必释（成功/失败/断线）
      }
    },
  });

  app.get('/ai/jobs/:jobId', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', minLength: 8, maxLength: 64 } },
      },
    },
    handler: async (request, reply) => {
      const view = gateway.getJobStatus(app.db, { userId: request.user.id, jobId: request.params.jobId });
      if (!view) {
        return reply.code(404).send({
          error: { code: 'job_not_found', message: '任务不存在', requestId: request.id },
        });
      }
      return view;
    },
  });

  // 裁决③：已完成任务全文取回——只从进程内 TTL 缓存出（缓存未命中/非 completed → 404，
  // 不区分「过期」与「从未有」以防状态探测；正文不因此落任何持久化）
  app.get('/ai/jobs/:jobId/content', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', minLength: 8, maxLength: 64 } },
      },
    },
    handler: async (request, reply) => {
      const job = gateway.getJobStatus(app.db, { userId: request.user.id, jobId: request.params.jobId });
      if (!job) {
        return reply.code(404).send({
          error: { code: 'job_not_found', message: '任务不存在', requestId: request.id },
        });
      }
      const text = job.status === 'completed' ? app.aiContentCache.get(job.jobId) : null;
      if (typeof text !== 'string') {
        return reply.code(404).send({
          error: { code: 'job_content_unavailable', message: '任务内容不可取回（已过取回窗口或任务未完成）', requestId: request.id },
        });
      }
      return { jobId: job.jobId, status: job.status, textLength: text.length, text };
    },
  });
}
