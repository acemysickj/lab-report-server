// src/app.js — Fastify 应用工厂（COM-001 骨架 + COM-002 Auth 装配根）
// 契约：只监听 127.0.0.1（src/server.js）；X-Request-Id 所有请求必备（缺失则服务端生成）；
//       Fastify logger redact body——本骨架默认关闭请求日志，任何日志不得输出请求正文（P-005）。
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { openDatabase } from './db.js';
import { verifyAccessToken } from './lib/tokens.js';
import { httpError } from './lib/http-error.js';
import { findUserById } from './repositories/user.repository.js';
import { findSessionById } from './repositories/session.repository.js';
import { RATE_LIMITS, AUTH_RATE_LIMITS, ADMIN_TOKEN } from './config.js';
import authRoutes from './routes/auth.js';
import legalRoutes from './routes/legal.js';
import walletRoutes from './routes/wallet.js';
import aiRoutes from './routes/ai.js';
import adminRoutes from './routes/admin.js';
import { createHttpTransport } from './ai/transport.js';
import { createContentCache } from './ai/content-cache.js';
import { createRateLimiter } from './ai/rate-limiter.js';
import { createUsageMeter } from './ai/usage-meter.js';

/** Build the Fastify app. Options: { dataDir?, db?, logger? }. Pass db to reuse a connection (tests). */
export async function buildApp(options = {}) {
  const db = options.db ?? openDatabase({ dataDir: options.dataDir });
  const app = Fastify({
    logger: options.logger ?? false,
    // 生产位于 Nginx 之后（Nginx 覆写 X-Forwarded-For 为 $remote_addr）：开启信任代理，
    // 认证限流才能按真实客户端 IP 分桶（默认 true；本地直连开发场景 IP 恒 127.0.0.1）
    trustProxy: options.trustProxy ?? true,
    // 契约「Fastify logger redact body」：显式配置，即使开日志也绝不输出请求正文/鉴权头（P-005）
    redact: { paths: ['req.body', 'req.headers.authorization'], censor: '[REDACTED]' },
    // 传值不可信以最强形式落实：additionalProperties:false 必须 400 拒绝，
    // 而非 Fastify 默认 AJV removeAdditional 的静默剥离
    ajv: { customOptions: { removeAdditional: false } },
    // 契约：X-Request-Id 所有请求必备——客户端带则沿用，缺失由服务端生成
    genReqId: (req) => {
      const provided = req.headers['x-request-id'];
      return typeof provided === 'string' && provided.length >= 8 && provided.length <= 128
        ? provided
        : randomUUID();
    },
  });
  app.decorate('db', db);
  app.decorate('aiTransport', options.aiTransport ?? createHttpTransport());
  // COM-004 裁决③：已完成任务全文取回的进程内缓存（非持久化，P-006 边界）
  app.decorate('aiContentCache', options.aiContentCache ?? createContentCache());
  // COM-005：限流（契约风控 2/10/50，env 可调）+ 成本计量（进程内环形，观测用）+ Admin 令牌
  app.decorate('aiRateLimiter', options.aiRateLimiter ?? createRateLimiter(options.rateLimits ?? RATE_LIMITS));
  // COM-005 扩展：认证端点防爆破（按 IP 窗口限流）
  app.decorate('authRateLimiter', options.authRateLimiter ?? createRateLimiter(options.authRateLimits ?? AUTH_RATE_LIMITS));
  app.decorate('aiUsageMeter', options.aiUsageMeter ?? createUsageMeter());
  // 注意：显式传 null = 关闭 Admin（?? 会放过 null，需区分 undefined）
  const adminToken = options.adminToken !== undefined ? options.adminToken : ADMIN_TOKEN;
  app.decorate('adminToken', adminToken);
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  // 回显请求标识（所有响应必备）
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Access Token 校验：JWT 有效 + 会话未作废（登出/复用检测会置 revoked_at → access 立即失效）
  app.decorate('authenticate', async function authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw httpError(401, 'missing_token', '缺少 Access Token');
    }
    let payload;
    try {
      payload = await verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      throw httpError(401, 'invalid_token', 'Access Token 无效或已过期');
    }
    const session = findSessionById(app.db, payload.sessionId);
    if (!session || session.revoked_at !== null) {
      throw httpError(401, 'session_revoked', '会话已作废，请重新登录');
    }
    const user = findUserById(app.db, payload.userId);
    if (!user || user.status !== 'active') {
      throw httpError(401, 'account_unavailable', '账号不可用');
    }
    request.session = session; // 内部使用，勿直接序列化进响应
    request.user = user;       // 同上
  });

  // 统一错误整形；5xx 不回显内部细节，任何情况下不输出请求正文
  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode ?? 500;
    const code = err.code ?? (status >= 500 ? 'internal_error' : 'request_failed');
    if (status >= 500) request.log.error({ err: err.message, code }, 'internal error');
    reply.status(status).send({
      error: {
        code,
        message: status >= 500 ? 'Internal Server Error' : (err.message ?? code),
        requestId: request.id,
      },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(walletRoutes, { prefix: '/api/v1' });
  await app.register(aiRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1', adminToken });
  await app.register(legalRoutes);

  app.addHook('onClose', async () => {
    if (db.open) db.close();
  });
  return app;
}
