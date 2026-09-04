// src/routes/admin.js — 极简 Admin（COM-005）
// 守卫：buildApp 未注入 adminToken（env ADMIN_TOKEN 未配置）→ 本路由全部 404（整体隐藏）；
// 已配置 → Bearer 令牌比对（timingSafeEqual 防时序侧信道）。
// 只读聚合 + 额度发放（生产发放路径，走 wallet 既有事务与台账审计）；不做任何改价/删户入口。
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { httpError } from '../lib/http-error.js';
import * as adminRepo from '../repositories/admin.repository.js';
import { createOrder } from '../repositories/wallet.repository.js';
import { grantCredits } from '../services/wallet.service.js';
import { findTier } from '../wallet/pricing.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false; // 长度不同直接否（timingSafeEqual 要求等长）
  return timingSafeEqual(ab, bb);
}

export default async function adminRoutes(app, { adminToken }) {
  if (!adminToken) {
    // 极简口径：未配置令牌 = Admin 功能整体不存在（404，不泄露端点存在性）
    app.all('/admin/*', async (request, reply) => {
      reply.code(404).send({ error: { code: 'not_found', message: 'Not Found', requestId: request.id } });
    });
    return;
  }

  const guard = async (request) => {
    const header = request.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !safeEqual(provided, adminToken)) {
      throw httpError(401, 'invalid_admin_token', 'Admin 令牌无效');
    }
  };

  app.get('/admin/overview', { preHandler: [guard] }, async (request) => {
    return adminRepo.overview(app.db);
  });

  app.get(
    '/admin/users',
    {
      preHandler: [guard],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            beforeId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      return { users: adminRepo.listUsers(app.db, { limit: request.query.limit, beforeId: request.query.beforeId }) };
    }
  );

  app.post(
    '/admin/grant',
    {
      preHandler: [guard],
      schema: {
        body: {
          type: 'object',
          required: ['email', 'tier'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            tier: { type: 'string', minLength: 3, maxLength: 32 },
            note: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const { email, tier, note } = request.body;
      const user = adminRepo.findUserByEmail(app.db, String(email).trim().toLowerCase());
      if (!user) throw httpError(404, 'user_not_found', '用户不存在');
      const tierInfo = findTier(tier);
      if (!tierInfo) throw httpError(400, 'unknown_tier', `未知档位：${tier}`);
      // 复用钱包履约事务（原子：ledger + balance + order delivered），note 带 admin 标记便于审计
      const orderId = createOrder(app.db, {
        userId: user.id,
        tier: tierInfo.tier,
        priceCents: tierInfo.priceCents,
        credits: tierInfo.credits,
      });
      const out = grantCredits(app.db, {
        userId: user.id,
        orderId,
        note: `admin grant ${tierInfo.tier}${note ? ': ' + note : ''}`,
      });
      return { userId: user.id, email: user.email, credits: tierInfo.credits, balance: out.balance };
    }
  );

  app.get('/admin/usage', { preHandler: [guard] }, async () => {
    return {
      meter: app.aiUsageMeter.snapshot(),
      rateLimiter: app.aiRateLimiter.snapshot(),
      generatedAt: new Date().toISOString(),
      meta: { requestIdHint: 'usage 为进程内环形观测（非计费权威），重启清零' },
    };
  });
}
