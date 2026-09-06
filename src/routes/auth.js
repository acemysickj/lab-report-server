// src/routes/auth.js — 认证路由（COM-002 Auth）
// 分层：route(JSON Schema 校验) → handler → service → repository。
// 注意：限流（并发 2/每分钟 10/每小时 50）由 COM-005 统一挂载，本文件不实现，仅留挂载点。
import * as authService from '../services/auth.service.js';
import {
  PRIVACY_POLICY_VERSION,
  TERMS_VERSION,
} from '../config.js';

const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

const emailSchema = {
  type: 'string',
  minLength: 3,
  maxLength: 254,
  pattern: EMAIL_PATTERN,
};
const passwordSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
};
const deviceIdSchema = { type: 'string', minLength: 1, maxLength: 128 };

export default async function authRoutes(app) {
  // ---- COM-005 扩展：认证端点防爆破（按 IP 窗口限流，login/register/refresh 共享预算）----
  // 只统计尝试本身、不区分邮箱存在性——429 与 401 的暴露面一致，保住防枚举口径。
  // acquire 后立即 release：认证是短请求，只按分钟/小时窗口限，不做并发占坑。
  const authGate = (request, reply, done) => {
    const acquire = app.authRateLimiter.tryAcquire(request.ip);
    if (!acquire.ok) {
      reply
        .code(429)
        .header('retry-after', String(acquire.retryAfterSeconds))
        .send({
          error: {
            code: 'rate_limited',
            message: `尝试过于频繁，请 ${acquire.retryAfterSeconds} 秒后重试`,
            retryAfter: acquire.retryAfterSeconds,
            requestId: request.id,
          },
        });
      return;
    }
    app.authRateLimiter.release(request.ip);
    done();
  };
  // ---- POST /api/v1/auth/register（P-001/P-002：两层告知 + 勾选可追溯） ----
  app.post('/auth/register', {
    preHandler: [authGate],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'consent'],
        additionalProperties: false,
        properties: {
          email: emailSchema,
          password: passwordSchema,
          deviceId: deviceIdSchema,
          consent: {
            type: 'object',
            required: [
              'acceptedPrivacyPolicy',
              'acceptedTermsOfService',
              'privacyPolicyVersion',
              'termsVersion',
            ],
            additionalProperties: false,
            properties: {
              acceptedPrivacyPolicy: { type: 'boolean', const: true }, // 未勾选 → 400（P-002）
              acceptedTermsOfService: { type: 'boolean', const: true },
              privacyPolicyVersion: { type: 'string', minLength: 1, maxLength: 32 },
              termsVersion: { type: 'string', minLength: 1, maxLength: 32 },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          required: ['userId', 'email'],
          properties: {
            userId: { type: 'integer' },
            email: { type: 'string' },
            byokAllowed: { type: 'boolean' }, // BK-008（ADR-003）
          },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.register(app.db, request.body, app.byokAllowlist);
      reply.code(201).send(result);
    },
  });

  // ---- POST /api/v1/auth/login ----
  app.post('/auth/login', {
    preHandler: [authGate],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: {
          email: emailSchema,
          password: { type: 'string', minLength: 1, maxLength: 128 },
          deviceId: deviceIdSchema,
        },
      },
    },
    handler: async (request) => authService.login(app.db, request.body, app.byokAllowlist),
  });

  // ---- POST /api/v1/auth/refresh（Rotation + 复用检测） ----
  app.post('/auth/refresh', {
    preHandler: [authGate],
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        additionalProperties: false,
        properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 128 } },
      },
    },
    handler: async (request) => authService.refresh(app.db, request.body, app.byokAllowlist),
  });

  // ---- POST /api/v1/auth/logout（需 Access Token） ----
  app.post('/auth/logout', {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      authService.logout(app.db, request.session);
      reply.code(204).send();
    },
  });

  // ---- DELETE /api/v1/account（注销，P-007；需 Access Token + 密码确认） ----
  app.delete('/account', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        additionalProperties: false,
        properties: { password: { type: 'string', minLength: 1, maxLength: 128 } },
      },
    },
    handler: async (request, reply) => {
      await authService.deleteAccount(app.db, { user: request.user, password: request.body.password });
      reply.code(204).send();
    },
  });

  // ---- 注册告知所需的当前文档版本（客户端第二层文档可达：GET /legal/*） ----
  app.get('/auth/consent-versions', {
    handler: async () => ({
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      termsVersion: TERMS_VERSION,
      documents: { privacy: '/legal/privacy', terms: '/legal/terms' },
    }),
  });
}
