// src/ai/usage-meter.js — 成本计量（COM-005，极简）
// 记录每任务上游 token 用量与扣费（仅元数据——正文绝不入内存环之外任何位置，P-005/P-006）。
// 有界环形（默认 500 条，2C2G 内存有界）+ 累计聚合；重启清零（成本权威=DeepSeek 控制台账，
// 本模块用于运营观测与毛利估算，非计费依据）。
// 单价参考（USD / 1M tokens，V4 迁移后常态价；峰值计价时段实际成本可能上浮，仅估算用）。
const MODEL_UNIT_COST_USD = {
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
};
const MAX_RECORDS_DEFAULT = 500;

export function createUsageMeter(options = {}) {
  const maxRecords = options.maxRecords ?? MAX_RECORDS_DEFAULT;
  const now = options.now ?? Date.now;
  const recent = [];
  const totals = { jobs: 0, promptTokens: 0, completionTokens: 0, credits: 0, estCostUsd: 0 };

  return {
    /** 记录一条任务用量（settle 成功后调用；tokens 缺失时记 0 但仍计次数）。 */
    record({ jobId, userId, operation, model, promptTokens, completionTokens, durationMs, credits }) {
      const p = Number.isFinite(promptTokens) ? promptTokens : 0;
      const c = Number.isFinite(completionTokens) ? completionTokens : 0;
      const unit = MODEL_UNIT_COST_USD[model] ?? { input: 0, output: 0 };
      const estCostUsd = (p * unit.input + c * unit.output) / 1_000_000;
      const entry = {
        jobId,
        userId,
        operation,
        model,
        promptTokens: p,
        completionTokens: c,
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        credits: credits ?? 0,
        estCostUsd: Number(estCostUsd.toFixed(6)),
        ts: new Date(now()).toISOString(),
      };
      recent.push(entry);
      if (recent.length > maxRecords) recent.shift();
      totals.jobs += 1;
      totals.promptTokens += p;
      totals.completionTokens += c;
      totals.credits += entry.credits;
      totals.estCostUsd = Number((totals.estCostUsd + estCostUsd).toFixed(6));
      return entry;
    },

    /** Admin 快照：累计 + 近期明细（最新在后）。 */
    snapshot() {
      return { totals, recent: recent.slice() };
    },
  };
}
