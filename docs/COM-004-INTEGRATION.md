# COM-004 AI Gateway 对接文档（v0.10.0，定稿于 2026-09-05）

> 权威契约仍为 docs/COM-CONTRACT.md；本文档是 Gateway 线上协议的定稿口径（Phase 2 客户端接入 t15 以此为准）。
> 三待决点裁决：①出路 A；②payload 白名单 `{system,user,temperature}`；③jobId 早下发 + 状态查询 + TTL 内全文取回。

## 1. 创建任务（唯一计费 AI 入口）

`POST /api/v1/ai/jobs`（Bearer Access Token；`X-Request-Id` 必备）

```jsonc
// 请求体（白名单外字段一律 400，服务端不作静默剥离）
{
  "operation": "generate_section",        // 计费操作，见 PRICING（generate_section/generate_chart）
  "payload": {
    "user": "（必填，1–32000 字符）",
    "system": "（可选，≤8000 字符，前置 system message）",
    "temperature": 0.7                     // 可选，0–2，缺省走上游默认
  },
  "idempotencyKey": "（可选，8–128 字符；同键重放不二次计费不重复执行）"
}
```

**model/credits/price 无任何客户端入口**（服务端 MODEL_MAP 决定模型，PRICING 决定金额）。

## 2. SSE 响应（裁决①出路 A）

`200` + `text/event-stream`；响应头含 `X-Request-Id` 与 **`X-Job-Id`**（jobId 早下发，裁决③）。

事件序列（三类可共存，互不破坏）：

| 通道 | 格式 | 说明 |
|---|---|---|
| jobId | `event: job` + `data: {"jobId":"…","replayed":false}` | 首事件 |
| **正文** | `data: {"id":"chatcmpl-<jobId>","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"…"},"finish_reason":null}]}` | OpenAI 兼容块——Phase 1 llm-client.js 解析器零改动 |
| 完成 | `event: done` + `data: {"jobId","model","credits","textLength"}` | 元数据 |
| 失败 | `event: error` + `data: {"code","jobId"}` | 只含错误码+jobId（P-005） |
| 终止行 | `data: [DONE]` | 流结束标记 |

**幂等重放**的 done 事件为 `{jobId, replayed:true, status, model, credits}`（无 textLength——正文从不落盘，无从统计）。

**fallback 纪律**：模型在**零增量**失败时才切换备模型重试；已产出增量后半途失败**不重试**（fallback 重跑全量会造成「半截+全文」拼接污染），直接走失败路径释放额度——宁失败不串文。

错误码（`event: error` 与 JSON 错误整形共用）：`ai_not_configured`(503 密钥门)、
`insufficient_credits`(402, hijack 前)、`unknown_operation`/`operation_free`/`invalid_payload`(400)、
`idempotency_retry`/`request_in_progress`(409)、`ai_upstream_error`/`ai_auth_error`(502)。

## 3. 断线续存（裁决③）

- 客户端断线后服务端**继续执行并完成计费**（SSE 停发，job 状态机照走）。
- `GET /api/v1/ai/jobs/:jobId` → `{jobId,status,operation,model,creditsCharged,errorCode,createdAt,completedAt}`（无正文）。
  状态机：`running → completed | failed | refunded`。他人任务一律 404（不泄露存在性）。
- **全文取回**：`GET /api/v1/ai/jobs/:jobId/content` → `{jobId,status,textLength,text}`。
  仅 `completed` 且在取回窗口内可得；窗口 = 进程内存缓存（TTL 10 分钟、上限 100 条，LRU 有界，**非持久化**——
  这是 P-006「正文不入任何持久化」的唯一让步边界，重启即失）。窗口外/失败任务 → `404 job_content_unavailable`。
- 预期取回失败率 ≈ 0：正常流式路径正文直接进 SSE，content 端点只兜断线重连场景。

## 4. 安全与计费纪律（实现要点）

- L3 补偿：reserve 提交后任何失败——未核销 release+`failed`，已核销 refund+`refunded`（退款金额取内存中的结算值，不依赖回库读值）；无「已扣款无凭据」出口。
- 带幂等键的请求先做余额预检（最佳努力，TOCTOU 由 reserve 原子性兜底），402 不消耗幂等键，同键可重试。
- 正文三不落盘：ai_jobs 冻结列集无正文列；logger redact 显式配置（req.body/authorization）；错误只透错误码；全库 dump 断言有测试覆盖。`idempotency_keys.request_hash` 仅存 SHA-256 摘要（沿用钱包既有设计，非正文持久化）。
- 请求 schema `additionalProperties:false` 一律 400 拒绝（app 级 AJV `removeAdditional:false`，**全局**生效——auth/wallet 同样不得静默剥离未知字段）。
- 主备 fallback：`deepseek-v4-flash → deepseek-v4-pro`，`ai_jobs.model` 记录实际使用模型。
- 限流（并发 2/分钟 10/小时 50）由 COM-005 统一挂载，本路由预留。
