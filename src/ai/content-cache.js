// src/ai/content-cache.js — 已完成任务全文取回的进程内缓存（COM-004 裁决③）
// 契约边界：P-006 禁止正文入 SQLite/日志/dump 等任何【持久化】——本缓存只存在于
// 进程内存、有 TTL 与条数上限（2C2G 内存有界），重启即失。TTL 外/未完成任务取回
// 走 failed/refunded 补偿路径，不在此处兜底。
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟：覆盖断线重连的合理窗口
const DEFAULT_MAX_ENTRIES = 100;       // 有界 LRU：超限驱逐最旧

/** 创建缓存。options: { ttlMs?, maxEntries? }。put(jobId, text) / get(jobId)（过期视为未命中）。 */
export function createContentCache(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  /** Map<jobId, { text, expiresAt }>——利用 Map 插入序做 LRU（get 命中即重插到尾部）。 */
  const entries = new Map();

  function prune(now) {
    for (const [key, value] of entries) {
      if (value.expiresAt <= now) entries.delete(key); // 全量扫（≤maxEntries 条），不依赖插入序=过期序
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    put(jobId, text) {
      if (typeof jobId !== 'string' || typeof text !== 'string') return;
      const now = Date.now();
      entries.delete(jobId); // 重插实现 LRU 触顶
      entries.set(jobId, { text, expiresAt: now + ttlMs });
      prune(now);
    },
    get(jobId) {
      const entry = entries.get(jobId);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(jobId);
        return null;
      }
      entries.delete(jobId);
      entries.set(jobId, entry); // 命中续期到尾部（LRU）
      return entry.text;
    },
    /** 测试与运维口径：当前驻留条数（不含过期未清）。 */
    get size() {
      return entries.size;
    },
  };
}
