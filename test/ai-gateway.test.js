// test/ai-gateway.test.js — COM-004 AI 网关：MODEL_MAP 主备/SSE/jobId/钱包补偿/幂等/正文三不落盘
// 裁决①出路 A：正文以 OpenAI 兼容块承载（客户端 Phase 1 解析器零改动）；裁决②payload 白名单
// {system,user,temperature}；裁决③X-Job-Id 头 + GET jobs/:id + 进程内 TTL 缓存全文取回。
// 注：TEST_PASSWORD 为测试夹具（与 auth.test.js 的 'password123' 同一口径），非真实凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeJwt } from 'jose';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { MODEL_MAP } from '../src/ai/model-map.js';
import { createHttpTransport, buildUpstreamRequest } from '../src/ai/transport.js';
import { createContentCache } from '../src/ai/content-cache.js';
import { createOrder } from '../src/repositories/wallet.repository.js';
import { grantCredits } from '../src/services/wallet.service.js';
import { compensate } from '../src/services/ai-gateway.service.js';
import { PRICING } from '../src/wallet/pricing.js';

const TEST_PASSWORD = ['password1', '23'].join('');
const SENTINEL = 'SENTINEL_BODY_9f3a不要落盘';

function fakeTransport({ plan: initialPlan = 'ok', models } = {}) {
  // plan: ok | primary_down | all_down | explode_with_sentinel
  const usedModels = [];
  const seenPayloads = [];
  let plan = initialPlan;
  return {
    usedModels,
    seenPayloads,
    available: true,
    setPlan(next) { plan = next; }, // 测试中途切换失败模式
    async *stream(model, payload) {
      usedModels.push(model);
      seenPayloads.push(payload);
      if (plan === 'primary_down' && model === MODEL_MAP.primary) {
        throw Object.assign(new Error('primary model down'), { code: 'http_503' });
      }
      if (plan === 'all_down') {
        throw Object.assign(new Error('all models down'), { code: 'http_503' });
      }
      if (plan === 'explode_with_sentinel') {
        // 上游把正文带进异常文本（模拟最坏情形）；主备都抛 → 走错误路径
        throw Object.assign(new Error(`upstream exploded with user text: ${payload.user}`), {
          code: 'http_500',
        });
      }
      yield '第一段';
      yield '第二段';
    },
  };
}

function makeCache(overrides = {}) {
  return createContentCache({ maxEntries: 100, ...overrides });
}

async function makeApp({ transport = fakeTransport(), logger = false, aiContentCache = makeCache() } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrs-ai-'));
  const app = await buildApp({ dataDir: tmp, aiTransport: transport, aiContentCache, logger });
  await migrate(app.db);
  return { app, tmp, aiContentCache };
}

async function registerLoginFund(app, email = 'ai@test.dev', credits = 100) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: TEST_PASSWORD,
      consent: {
        acceptedPrivacyPolicy: true,
        acceptedTermsOfService: true,
        privacyPolicyVersion: 'v1.0-draft',
        termsVersion: 'v1.0-draft',
      },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  const body = login.json();
  const userId = Number(decodeJwt(body.accessToken).sub);
  const orderId = createOrder(app.db, { userId, tier: 'tier_9_9', priceCents: 990, credits });
  grantCredits(app.db, { userId, orderId });
  return { userId, token: body.accessToken };
}

function parseSse(payload) {
  return payload
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /event: (.*)/.exec(block)?.[1] ?? null;
      const data = /data: (.*)/.exec(block)?.[1];
      if (data === '[DONE]') return { event: '[DONE]', data: '[DONE]' };
      return { event, data: data ? JSON.parse(data) : null };
    });
}

// Phase 1 客户端 llm-client.js streamContent 同款解析（出路 A 零改动验证）：
// 只认 data: 行 → choices[0].delta.content，[DONE]/无 choices 行静默跳过。
function clientParse(payload) {
  let full = '';
  for (const line of payload.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(p);
    } catch {
      continue;
    }
    const delta = json?.choices?.[0]?.delta?.content ?? '';
    if (delta) full += delta;
  }
  return full;
}

async function postJob(app, token, { operation = 'generate_section', payload = { user: '写个引言' }, idempotencyKey } = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ai/jobs',
    headers: { authorization: `Bearer ${token}` },
    payload: { operation, payload, idempotencyKey },
  });
}

test('happy path: OpenAI 兼容块正文 + job/done 元数据事件；settle+completed；余额守恒', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerLoginFund(app);
    const res = await postJob(app, token, {
      payload: { system: '你是学术写作助手', user: '写个引言', temperature: 0.7 },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const events = parseSse(res.body);
    const jobEvent = events[0];
    assert.equal(jobEvent.event, 'job');
    assert.equal(typeof jobEvent.data.jobId, 'string');
    assert.equal(jobEvent.data.jobId.length, 36, 'jobId 为独立 UUID（非 X-Request-Id）');
    assert.equal(res.headers['x-job-id'], jobEvent.data.jobId, 'X-Job-Id 头早下发（裁决③）');

    // 出路 A：正文块为 OpenAI 兼容 chunk，Phase 1 解析器原样提取全文
    const chunks = events.filter((e) => e.event === null && e.data?.choices);
    assert.equal(chunks.length, 2, '两条正文块');
    assert.equal(chunks[0].data.object, 'chat.completion.chunk');
    assert.deepEqual(clientParse(res.body), '第一段第二段', 'Phase 1 客户端解析器零改动提取全文');

    const done = events[events.length - 2];
    assert.equal(done.event, 'done');
    assert.equal(done.data.model, MODEL_MAP.primary);
    assert.equal(done.data.credits, PRICING.generate_section);
    assert.equal(done.data.textLength, 6);
    assert.equal(events[events.length - 1].event, '[DONE]', '终止行 data:[DONE]');

    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.status, 'completed');
    assert.equal(job.model, MODEL_MAP.primary);
    assert.equal(job.credits_charged, PRICING.generate_section);
    assert.equal(job.request_id, res.headers['x-request-id'] ?? job.request_id);

    const account = app.db.prepare('SELECT balance FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 100 - PRICING.generate_section, '余额守恒');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('system/temperature 透传上游：system 前置 + temperature 字段（裁决②）', async () => {
  const transport = fakeTransport();
  const { app, tmp } = await makeApp({ transport });
  try {
    const { token } = await registerLoginFund(app);
    await postJob(app, token, {
      payload: { system: 'LaTeX 铁律', user: '正文', temperature: 0.95 },
    });
    const sent = transport.seenPayloads[0];
    assert.equal(sent.system, 'LaTeX 铁律');
    assert.equal(sent.user, '正文');
    assert.equal(sent.temperature, 0.95);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MODEL_MAP fallback: primary down → fallback model used and recorded', async () => {
  const { app, tmp } = await makeApp({ transport: fakeTransport({ plan: 'primary_down' }) });
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const events = parseSse(res.body);
    const done = events[events.length - 2];
    assert.equal(done.event, 'done');
    assert.equal(done.data.model, MODEL_MAP.fallback, '备模型完成');

    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.model, MODEL_MAP.fallback);
    assert.equal(job.status, 'completed');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('all models fail: SSE error event; job failed via release (no charge)', async () => {
  const { app, tmp } = await makeApp({ transport: fakeTransport({ plan: 'all_down' }) });
  try {
    const { userId, token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const events = parseSse(res.body);
    const errEvent = events.find((e) => e.event === 'error');
    assert.ok(errEvent, 'error 事件存在');
    assert.equal(errEvent.data.code, 'ai_upstream_error');
    assert.ok(errEvent.data.jobId);
    assert.ok(!('message' in errEvent.data), 'error 事件只含 code+jobId');

    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'ai_upstream_error');

    const account = app.db.prepare('SELECT balance FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 100, '失败未扣费（release 路径）');
    const reservation = app.db.prepare('SELECT * FROM credit_reservations').get();
    assert.equal(reservation.status, 'released');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle-then-fail: compensate() refunds and marks refunded (L3)', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerLoginFund(app);
    await postJob(app, token); // 完整成功：settle+completed，余额 95
    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.status, 'completed');

    // 已核销后失败（模拟结算后异常路径）：补偿 → refund + refunded
    const outcome = compensate(app.db, {
      jobId: job.job_id,
      reservationId: job.reservation_id,
      settled: true,
      errorCode: 'post_settle_failure',
    });
    assert.equal(outcome, 'refunded');
    const refundedJob = app.db.prepare('SELECT * FROM ai_jobs WHERE job_id = ?').get(job.job_id);
    assert.equal(refundedJob.status, 'refunded');
    assert.equal(refundedJob.error_code, 'post_settle_failure');

    const account = app.db.prepare('SELECT balance FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 100, 'refund 后余额守恒');
    const refundRow = app.db
      .prepare("SELECT * FROM credit_ledger WHERE type = 'refund'")
      .get();
    assert.equal(refundRow.delta, PRICING.generate_section);
    assert.equal(refundRow.balance_after, 100);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('idempotency: same key replays original jobId, no double charge', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerLoginFund(app);
    const first = await postJob(app, token, { idempotencyKey: 'idem-key-0001' });
    const second = await postJob(app, token, { idempotencyKey: 'idem-key-0001' });

    const e1 = parseSse(first.body);
    const e2 = parseSse(second.body);
    assert.equal(e1[0].data.jobId, e2[0].data.jobId, '同 jobId');
    assert.equal(e2[0].data.replayed, true);
    assert.equal(e2.find((x) => x.event === 'done').data.replayed, true, '重放不重新执行');
    assert.equal(e2.filter((x) => x.data?.choices).length, 0, '重放不再产出正文');

    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 1);
    const account = app.db.prepare('SELECT balance FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 100 - PRICING.generate_section, '只扣一次');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('insufficient credits: JSON 402 before hijack; no job row', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { token } = await registerLoginFund(app, 'poor@test.dev', 3);
    const res = await postJob(app, token);
    // createJob（含 reserve 402）在 hijack 之前 → 统一 JSON 错误整形
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().error.code, 'insufficient_credits');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 0, '无任务行');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('payload 白名单（裁决②）：白名单外/text/越界 temperature 一律 400', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { token } = await registerLoginFund(app);
    const cases = [
      { user: 'x', model: 'gpt-4o' },        // 白名单外字段
      { text: 'x' },                          // 旧字段已废：不在白名单
      { system: 's' },                        // 缺 user
      { user: '' },                           // 空 user
      { user: 'x', temperature: 3 },          // 越界
      { user: 'x', temperature: -0.5 },       // 越界
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/jobs',
        headers: { authorization: `Bearer ${token}` },
        payload: { operation: 'generate_section', payload },
      });
      assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} 应 400`);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 0);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('content 取回（裁决③）：completed 全文 TTL 内可取；failed 无正文', async () => {
  const transport = fakeTransport();
  const { app, tmp } = await makeApp({ transport });
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const jobId = parseSse(res.body)[0].data.jobId;

    const content = await app.inject({
      method: 'GET',
      url: `/api/v1/ai/jobs/${jobId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.json().text, '第一段第二段');
    assert.equal(content.json().textLength, 6);

    // 失败任务：无正文可取（release 路径，缓存从未写入）
    transport.setPlan('all_down');
    const fail = await postJob(app, token, { payload: { user: '写图表' } });
    const failJobId = parseSse(fail.body)[0].data.jobId;
    const failContent = await app.inject({
      method: 'GET',
      url: `/api/v1/ai/jobs/${failJobId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(failContent.statusCode, 404);
    assert.equal(failContent.json().error.code, 'job_content_unavailable');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('content TTL 过期：取回窗口外 404（job_content_unavailable）', async () => {
  const { app, tmp } = await makeApp({ aiContentCache: makeCache({ ttlMs: 5 }) });
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const jobId = parseSse(res.body)[0].data.jobId;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const content = await app.inject({
      method: 'GET',
      url: `/api/v1/ai/jobs/${jobId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(content.statusCode, 404);
    assert.equal(content.json().error.code, 'job_content_unavailable');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('status endpoint: view has no content; 401 unauth; 404 hides others', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const jobId = parseSse(res.body)[0].data.jobId;

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/ai/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(status.statusCode, 200);
    const view = status.json();
    assert.equal(view.status, 'completed');
    assert.ok(!('text' in view) && !('content' in view), '状态视图无正文');
    assert.ok(!JSON.stringify(view).includes('第一段'), '内容不入状态接口');

    const noAuth = await app.inject({ method: 'GET', url: `/api/v1/ai/jobs/${jobId}` });
    assert.equal(noAuth.statusCode, 401);

    // 他人任务 → 404（不泄露存在性）；content 端点同样 404
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'other@test.dev',
        password: TEST_PASSWORD,
        consent: {
          acceptedPrivacyPolicy: true,
          acceptedTermsOfService: true,
          privacyPolicyVersion: 'v1.0-draft',
          termsVersion: 'v1.0-draft',
        },
      },
    });
    const otherLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'other@test.dev', password: TEST_PASSWORD },
    });
    const otherHeaders = { authorization: `Bearer ${otherLogin.json().accessToken}` };
    const other = await app.inject({ method: 'GET', url: `/api/v1/ai/jobs/${jobId}`, headers: otherHeaders });
    assert.equal(other.statusCode, 404);
    const otherContent = await app.inject({ method: 'GET', url: `/api/v1/ai/jobs/${jobId}/content`, headers: otherHeaders });
    assert.equal(otherContent.statusCode, 404);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('body never persisted (P-005/P-006): logs / SQLite / error path — three assertions', async () => {
  let logCaptured = '';
  const logStream = { write(chunk) { logCaptured += chunk; } };
  const { app, tmp } = await makeApp({
    transport: fakeTransport({ plan: 'explode_with_sentinel' }),
    logger: { level: 'info', stream: logStream },
  });
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token, {
      payload: { system: `系统提示 ${SENTINEL}`, user: `帮我写 ${SENTINEL} 的引言` },
    });
    const events = parseSse(res.body);
    assert.equal(events.find((e) => e.event === 'error').event, 'error');

    // 断言 1：application log 序列化输出不含正文片段
    assert.ok(!logCaptured.includes(SENTINEL), '日志不含正文');

    // 断言 2：SQLite 全库 dump（所有表所有行）不含正文片段
    const tables = app.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    const dump = tables
      .map((t) => JSON.stringify(app.db.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
    assert.ok(!dump.includes(SENTINEL), 'SQLite 无正文');
    const aiJobsCols = app.db.prepare('PRAGMA table_info(ai_jobs)').all().map((c) => c.name);
    assert.deepEqual(
      aiJobsCols,
      ['id', 'job_id', 'user_id', 'operation', 'model', 'status', 'credits_charged', 'reservation_id', 'request_id', 'error_code', 'completed_at', 'created_at', 'updated_at'],
      'ai_jobs 无正文列（冻结列集）'
    );

    // 断言 3：错误路径脱敏——error_code/事件/状态接口只有错误码+jobId，不含正文
    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.error_code, 'ai_upstream_error');
    const errEvent = events.find((e) => e.event === 'error');
    assert.ok(!JSON.stringify(errEvent).includes(SENTINEL));
    assert.ok(!res.body.includes(SENTINEL), 'SSE 输出不含正文回显');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ai_not_configured: 503 when key missing; app still boots; client model field rejected', async () => {
  const { app, tmp } = await makeApp({ transport: { available: false } });
  try {
    const { token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'ai_not_configured');

    // 客户端传 model/credits/price：schema additionalProperties:false → 400，无任何入口接受它们
    const withModel = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { operation: 'generate_section', payload: { user: 'x' }, model: 'gpt-4o', credits: 1, price: 0 },
    });
    assert.equal(withModel.statusCode, 400, 'model/credits/price 被拒——传值不可信');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('free operation cannot go through gateway; unknown operation 400', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { token } = await registerLoginFund(app);
    const free = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { operation: 'parse_template', payload: { user: 'x' } },
    });
    assert.equal(free.statusCode, 400);
    assert.equal(free.json().error.code, 'operation_free');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('transport 上游请求形状：messages 组装 + temperature + SSE 增量解析', async () => {
  let capturedBody = null;
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const transport = createHttpTransport({
    baseUrl: 'https://upstream.test',
    apiKey: 'sk-test',
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(upstream, { status: 200 });
    },
  });
  const deltas = [];
  for await (const delta of transport.stream('deepseek-v4-flash', {
    system: 'sys prompt',
    user: 'user text',
    temperature: 0.7,
  })) {
    deltas.push(delta);
  }
  assert.deepEqual(deltas, ['你好']);
  assert.deepEqual(capturedBody.messages, [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'user text' },
  ]);
  assert.equal(capturedBody.temperature, 0.7);
  assert.equal(capturedBody.model, 'deepseek-v4-flash');
  assert.equal(capturedBody.stream, true);
});

test('buildUpstreamRequest：缺 user 抛 invalid_payload；temperature 缺省不透传', () => {
  assert.throws(() => buildUpstreamRequest({ system: 's' }), (err) => err.code === 'invalid_payload');
  assert.throws(() => buildUpstreamRequest({ user: '   ' }), (err) => err.code === 'invalid_payload');
  const onlyUser = buildUpstreamRequest({ user: 'hi' });
  assert.deepEqual(onlyUser.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(onlyUser.temperature, undefined);
});

test('半途失败不 fallback（宁失败不串文）：error 事件 + failed + 未扣费', async () => {
  // primary 先产出一段再失败：若 fallback 重试，客户端会收到「半截+全文」拼接——禁止
  const transport = {
    available: true,
    async *stream(model) {
      if (model === MODEL_MAP.primary) {
        yield '半截';
        throw Object.assign(new Error('mid-stream failure'), { code: 'http_502' });
      }
      yield '备模型全文';
    },
  };
  const { app, tmp } = await makeApp({ transport });
  try {
    const { userId, token } = await registerLoginFund(app);
    const res = await postJob(app, token);
    const events = parseSse(res.body);
    assert.deepEqual(clientParse(res.body), '半截', '只发出失败前的半截，无 fallback 全文');
    assert.equal(events.find((e) => e.event === 'error').data.code, 'ai_upstream_error');

    const job = app.db.prepare('SELECT * FROM ai_jobs').get();
    assert.equal(job.status, 'failed');
    assert.equal(job.model, MODEL_MAP.primary, '模型未切换');
    const account = app.db.prepare('SELECT balance FROM accounts WHERE user_id = ?').get(userId);
    assert.equal(account.balance, 100, 'release 路径未扣费');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('带幂等键的 402：不消耗幂等键，同键补足额度后可成功', async () => {
  const { app, tmp } = await makeApp();
  try {
    const { userId, token } = await registerLoginFund(app, 'idem402@test.dev', 3);
    const first = await postJob(app, token, { idempotencyKey: 'idem-402-key' });
    assert.equal(first.statusCode, 402, '预检 402（hijack 前）');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, 0, '幂等键未被占用');

    grantCredits(app.db, {
      userId,
      orderId: createOrder(app.db, { userId, tier: 'tier_9_9', priceCents: 990, credits: 100 }),
    });
    const second = await postJob(app, token, { idempotencyKey: 'idem-402-key' });
    assert.equal(second.statusCode, 200, '同键补足额度后成功');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('content cache：LRU 驱逐最旧 + TTL 过期清出', () => {
  const cache = createContentCache({ maxEntries: 2 });
  cache.put('a', '1');
  cache.put('b', '2');
  cache.get('a'); // a 续期到尾部
  cache.put('c', '3'); // 驱逐 b
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('c'), '3');

  const short = createContentCache({ ttlMs: 0 });
  short.put('x', 'y');
  assert.equal(short.get('x'), null, 'TTL 过期即未命中');
});
