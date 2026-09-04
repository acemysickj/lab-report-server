// src/ai/model-map.js — AI 模型池（COM-004）
// 契约「AI 模型池」：主 deepseek-v4-flash；备 deepseek-v4-pro（主不可用自动 fallback）。
// 生产客户端不可自选模型——本文件是唯一模型来源，路由层不接受任何 model 字段。
export const MODEL_MAP = Object.freeze({
  primary: 'deepseek-v4-flash',
  fallback: 'deepseek-v4-pro',
});

/** 按序尝试的模型链（主→备）。 */
export function modelChain() {
  return [MODEL_MAP.primary, MODEL_MAP.fallback];
}
