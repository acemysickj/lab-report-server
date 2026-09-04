# COM-004 待决点存档（2026-09-04 停摆前，client-engineer 对表分析）

> **✅ 三点已于 2026-09-05 裁决并实现（用户确认）**：①出路 A；②放行 `{system,user,temperature}`
> 白名单（temperature 钳制 0–2，白名单外 400）；③jobId 经首事件 + `X-Job-Id` 头早下发 +
> `GET /jobs/:jobId` 状态 + `GET /jobs/:jobId/content` 全文取回（进程内有界 TTL 缓存，
> 非持久化，P-006 边界）。定稿口径见 **docs/COM-004-INTEGRATION.md**。以下为停摆前存档原文。

> 背景：SSE 线上格式与客户端 Phase 1 解析协议对表发现 3 个出入点，恢复开发时需逐条裁决。
> 事实基础：客户端 part-chunk 是 Electron 主→渲染内部 IPC（main.js:275 发 {reportId,partIndex,delta}；renderer.js:2006 消费，仅进度显示，权威内容走 invoke contentOverride）——不是线上协议。
> 真正约束 Gateway SSE 线上格式的是 app/llm-client.js:43-78：OpenAI 兼容 data: 行 + choices[0].delta.content + [DONE]，无该路径的行全部静默跳过（自有元数据事件可共存不破坏）。

## ① 事件词汇不兼容（ai-gateway.service.js:91/97/109 onEvent('part'/'done'/'error')）
- 现状风险：直接输出为 data:{"text":...} 会被 Phase 1 客户端解析为空 → "AI 生成内容为空"。
- 出路 A（client-engineer 与 server-engineer 一致推荐）：正文用 OpenAI 兼容块承载 + 平台元数据（jobId/credits/error）独立事件/响应头 → Phase 1 线上零改动。
- 出路 B：冻结原生事件集，Phase 2 写 Gateway 专用解析器（BYOK 仍走 llm-client）。
- 状态：**推荐 A，待恢复后裁决**。

## ② payload schema 白名单
- transport.js:54-63 只收 payload.text 且上游仅单条 user message；客户端依赖 system 提示词（main.js:255 LaTeX 铁律）与 temperature（0.7/0.95/0.9）。
- 待决：generate-* 是否接受 {system,user,temperature} 白名单（model/credits 仍服务端定，不违契约"客户端只提交 operation+business payload"）。
- 状态：**待裁决**。

## ③ 断线续存硬依赖
- 契约要求 SSE 断线 job 续存，但 ai_jobs 只存 textLength 不存正文（P-006）——重连时"已完成"任务全文取回机制未定义。
- 客户端需尽早拿 jobId（首事件或 X-Job-Id 头）+ GET jobs/:jobId 状态查询端点。
- 状态：**随 COM-004 路由一并定稿进对接文档**。

## 附：预算压缩模式下的已完成状态
- t12 COM-004 实现在停摆时为 mid-flight（server-engineer 落盘中）；t13+t14 合并轮、t15 客户端、t16 合并轮、t17 集成、t18 搬运均已建待命。
