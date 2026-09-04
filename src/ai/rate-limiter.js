// src/ai/rate-limiter.js — AI 网关限流（COM-005）
// 契约「风控」：并发 2 / 每分钟 10 / 每小时 50，后台可调（env: RATE_MAX_CONCURRENT /
// RATE_PER_MINUTE / RATE_PER_HOUR，重启生效；数值经 config.js 注入，不绑机器码）。
// 纯内存实现：单进程 PM2 fork 部署下即全局口径；重启清零（断电型宽容，不做持久化）。
// 窗口语义：锚定首请求的固定窗口（非滑动窗口）——边界处理论上可突发近 2 倍配额；
// 风控粗口径下可接受，如需精确滑动窗口属新提案。
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PRUNE_THRESHOLD = 5000; // Map 超过该用户数时清理 1 小时无活动的条目（2C2G 内存有界）

/** 创建限流器。options: { maxConcurrent, perMinute, perHour, now? }。 */
export function createRateLimiter(options = {}) {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const perMinute = options.perMinute ?? 10;
  const perHour = options.perHour ?? 50;
  const now = options.now ?? Date.now;
  /** Map<userId, { concurrent, minuteStart, minuteCount, hourStart, hourCount, lastSeen }> */
  const users = new Map();

  function entry(userId) {
    let e = users.get(userId);
    if (!e) {
      e = { concurrent: 0, minuteStart: 0, minuteCount: 0, hourStart: 0, hourCount: 0, lastSeen: 0 };
      users.set(userId, e);
    }
    return e;
  }

  function roll(e, t) {
    if (t - e.minuteStart >= MINUTE_MS) { e.minuteStart = t; e.minuteCount = 0; }
    if (t - e.hourStart >= HOUR_MS) { e.hourStart = t; e.hourCount = 0; }
  }

  function prune(t) {
    if (users.size <= PRUNE_THRESHOLD) return;
    for (const [key, e] of users) {
      if (t - e.lastSeen > HOUR_MS && e.concurrent === 0) users.delete(key);
    }
  }

  function windowDeny(e, t, scope) {
    const windowMs = scope === 'hour' ? HOUR_MS : MINUTE_MS;
    const start = scope === 'hour' ? e.hourStart : e.minuteStart;
    const elapsed = t - start;
    return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
  }

  return {
    /**
     * 尝试获取一个执行槽。返回 { ok: true } 或
     * { ok: false, scope: 'concurrent'|'minute'|'hour', retryAfterSeconds }。
     */
    tryAcquire(userId) {
      const t = now();
      prune(t);
      const e = entry(userId);
      roll(e, t);
      e.lastSeen = t;
      if (e.concurrent >= maxConcurrent) {
        // 并发等待时长未知（取决于上游流），按 5s 起步的重试提示
        return { ok: false, scope: 'concurrent', retryAfterSeconds: 5 };
      }
      if (e.minuteCount >= perMinute) {
        return { ok: false, scope: 'minute', retryAfterSeconds: windowDeny(e, t, 'minute') };
      }
      if (e.hourCount >= perHour) {
        return { ok: false, scope: 'hour', retryAfterSeconds: windowDeny(e, t, 'hour') };
      }
      e.concurrent += 1;
      e.minuteCount += 1;
      e.hourCount += 1;
      return { ok: true };
    },

    /** 释放并发槽（幂等：并发数不会低于 0）。 */
    release(userId) {
      const e = users.get(userId);
      if (e && e.concurrent > 0) e.concurrent -= 1;
    },

    /** 观测快照（Admin 用）。 */
    snapshot() {
      const t = now();
      const usersView = [];
      for (const [userId, e] of users) {
        if (t - e.lastSeen > HOUR_MS && e.concurrent === 0) continue;
        usersView.push({
          userId,
          concurrent: e.concurrent,
          minuteCount: e.minuteCount,
          hourCount: e.hourCount,
        });
      }
      return { activeUsers: usersView.length, users: usersView, limits: { maxConcurrent, perMinute, perHour } };
    },
  };
}
