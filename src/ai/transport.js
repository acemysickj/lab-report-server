// src/ai/transport.js — DeepSeek 上游传输层（COM-004）
// 契约：DeepSeek API Key 只存服务器环境（专用 key）；AI 请求正文不落任何持久化（P-005/P-006）。
// fetch 可注入（测试用假 transport 覆盖 fallback/失败路径，不打真实上游）。
import { AI_UPSTREAM_TIMEOUT_MS, DEEPSEEK_THINKING_TYPE } from '../config.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * 建立传输器。options: { baseUrl?, apiKey?, fetchImpl? }。
 * 未配置 key 时 transport.available=false——网关返回 503 ai_not_configured，服务启动不崩。
 */
export function createHttpTransport(options = {}) {
  const baseUrl = options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return {
    available: typeof apiKey === 'string' && apiKey.length > 0 && typeof fetchImpl === 'function',
    /**
     * 对指定 model 发起流式补全，产出文本增量（async iterable of string）。
     * 失败（网络/非 2xx/流中断）抛 Error（statusCode 分类用 err.code：network / http_<status>）。
     * 正文只在此层内存流转，绝不写日志/库/dump。
     */
    async *stream(model, payload, { onUsage, onThinking } = {}) {
      if (!this.available) {
        const err = new Error('AI upstream not configured');
        err.code = 'ai_not_configured';
        throw err;
      }
      const { messages, temperature } = buildUpstreamRequest(payload);
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages,
          // V4 思考模式控制（默认 disabled：报告写作为直出任务，思考 token 计费且首字延迟分钟级）
          thinking: { type: DEEPSEEK_THINKING_TYPE },
          // COM-005 成本计量：上游在终止前回传 usage 块（choices 为空的附加 chunk）
          stream_options: { include_usage: true },
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: AbortSignal.timeout(AI_UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        const err = new Error(`upstream http ${response.status}`);
        err.code = `http_${response.status}`;
        throw err;
      }
      for await (const delta of parseUpstreamSse(response.body, { onUsage, onThinking })) {
        yield delta; // 仅内存/SSE 转发，不落盘
      }
    },
  };
}

/**
 * 业务 payload → 上游请求体（裁决②白名单：{system,user,temperature}，路由 schema 已先校验，
 * 此处只做防御性再校验）。system 可选（前置 system message）；temperature 可选（缺省走上游默认）。
 * 正文只在此层内存流转，绝不写日志/库/dump（P-005/P-006）。
 */
export function buildUpstreamRequest(payload) {
  const user = typeof payload?.user === 'string' ? payload.user : '';
  if (user.trim().length === 0) {
    const err = new Error('payload.user required');
    err.code = 'invalid_payload';
    throw err;
  }
  const messages = [];
  if (typeof payload?.system === 'string' && payload.system.length > 0) {
    messages.push({ role: 'system', content: payload.system });
  }
  messages.push({ role: 'user', content: user });
  const temperature =
    typeof payload?.temperature === 'number' && Number.isFinite(payload.temperature)
      ? payload.temperature
      : undefined;
  return { messages, temperature };
}

/** 解析上游 OpenAI 兼容 SSE：正文/思考增量 + usage 块 + data: [DONE]。 */
async function* parseUpstreamSse(body, { onUsage, onThinking } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        break;
      }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta;
        // 思考增量（reasoning_content）：只回调信号，不当正文（正文=delta.content，出路 A）
        if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content && typeof onThinking === 'function') {
          onThinking(delta.reasoning_content);
        }
        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) yield content;
        // usage 块（stream_options.include_usage）：可能在独立空 choices chunk，也可能伴随最后
        // 一个正文 chunk——先取正文再回调 usage，绝不因 usage 丢弃正文（出路 A）
        if (parsed && parsed.usage && typeof onUsage === 'function') {
          onUsage(parsed.usage);
        }
      } catch {
        // 跳过无法解析的心跳/注释行——不记录任何行内容（P-005）
      }
    }
    if (done) break;
  }
}
