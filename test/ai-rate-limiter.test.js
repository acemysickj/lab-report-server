// test/ai-rate-limiter.test.js — COM-005 限流器：并发 2 / 每分钟 10 / 每小时 50（env 可调）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ai/rate-limiter.js';

test('契约默认口径：并发 2 / 每分钟 10 / 每小时 50', () => {
  const rl = createRateLimiter({ maxConcurrent: 2, perMinute: 10, perHour: 50 });
  assert.equal(rl.tryAcquire(1).ok, true);
  assert.equal(rl.tryAcquire(1).ok, true);
  const third = rl.tryAcquire(1);
  assert.equal(third.ok, false, '第 3 个并发被拒');
  assert.equal(third.scope, 'concurrent');
  assert.ok(third.retryAfterSeconds >= 1);
  rl.release(1);
  assert.equal(rl.tryAcquire(1).ok, true, 'release 后可再获取');
});

test('分钟窗口：超过 perMinute 拒绝，窗口滚动后恢复', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ maxConcurrent: 99, perMinute: 3, perHour: 99, now: () => now });
  for (let i = 0; i < 3; i++) {
    const r = rl.tryAcquire(7);
    assert.equal(r.ok, true);
    rl.release(7);
  }
  const denied = rl.tryAcquire(7);
  assert.equal(denied.ok, false, '分钟窗口第 4 次被拒');
  assert.equal(denied.scope, 'minute');
  now += 60 * 1000; // 窗口滚动
  assert.equal(rl.tryAcquire(7).ok, true, '下一分钟恢复');
});

test('小时窗口：超过 perHour 拒绝，scope=hour', () => {
  let now = 2_000_000;
  const rl = createRateLimiter({ maxConcurrent: 99, perMinute: 99, perHour: 5, now: () => now });
  for (let i = 0; i < 5; i++) { rl.tryAcquire(9); rl.release(9); now += 61 * 1000; } // 每次跨分钟，只累计小时
  const denied = rl.tryAcquire(9);
  assert.equal(denied.ok, false);
  assert.equal(denied.scope, 'hour');
});

test('用户间隔离：A 限额不影响 B', () => {
  let now = 3_000_000;
  const rl = createRateLimiter({ maxConcurrent: 1, perMinute: 1, perHour: 99, now: () => now });
  assert.equal(rl.tryAcquire(1).ok, true);
  assert.equal(rl.tryAcquire(2).ok, true, '另一用户不受影响');
  rl.release(1); rl.release(2);
});

test('release 幂等：多放不产生负并发', () => {
  const rl = createRateLimiter({ maxConcurrent: 2, perMinute: 99, perHour: 99 });
  rl.tryAcquire(5);
  rl.release(5); rl.release(5); rl.release(5);
  assert.equal(rl.tryAcquire(5).ok, true);
  assert.equal(rl.tryAcquire(5).ok, true);
  assert.equal(rl.tryAcquire(5).ok, false, '并发上限仍为 2，未因多放而放大');
});

test('retryAfterSeconds：分钟/小时窗口给出剩余秒数', () => {
  let now = 4_000_000;
  const rl = createRateLimiter({ maxConcurrent: 99, perMinute: 1, perHour: 99, now: () => now });
  rl.tryAcquire(3); rl.release(3);
  const m = rl.tryAcquire(3);
  assert.ok(m.retryAfterSeconds > 0 && m.retryAfterSeconds <= 60);
  now += 60 * 1000;
  const h = createRateLimiter({ maxConcurrent: 99, perMinute: 1, perHour: 1, now: () => now });
  h.tryAcquire(4); h.release(4); now += 60 * 1000;
  const deniedHour = h.tryAcquire(4);
  assert.ok(deniedHour.retryAfterSeconds > 60, '小时窗口剩余 > 60s');
});

test('snapshot：供 Admin 用量/限流观测', () => {
  let now = 5_000_000;
  const rl = createRateLimiter({ maxConcurrent: 2, perMinute: 10, perHour: 50, now: () => now });
  rl.tryAcquire(1); rl.tryAcquire(1); rl.release(1);
  const snap = rl.snapshot();
  assert.equal(snap.activeUsers >= 1, true);
  const u = snap.users.find((x) => x.userId === 1);
  assert.equal(u.concurrent, 1);
  assert.equal(u.minuteCount, 2);
  assert.equal(u.hourCount, 2);
});
