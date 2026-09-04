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
  // ---- POST /api/v1/auth/register（P-001/P-002：两层告知 + 勾选可追溯） ----
  app.post('/auth/register', {
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
          properties: { userId: { type: 'integer' }, email: { type: 'string' } },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.register(app.db, request.body);
      reply.code(201).send(result);
    },
  });

  // ---- POST /api/v1/auth/login ----
  app.post('/auth/login', {
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
    handler: async (request) => authService.login(app.db, request.body),
  });

  // ---- POST /api/v1/auth/refresh（Rotation + 复用检测） ----
  app.post('/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        additionalProperties: false,
        properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 128 } },
      },
    },
    handler: async (request) => authService.refresh(app.db, request.body),
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
