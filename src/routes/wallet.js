// src/routes/wallet.js — 钱包读接口（COM-003，Phase 2 客户端：余额/消费记录/档位/预计消耗）
// 写路径（reserve/settle/release/refund/grant）是服务层 API，由 COM-004 AI Gateway 与 COM-005 Admin
// 在服务端调用，不经客户端直发——客户端只提交 operation + business payload（契约安全铁律）。
import * as walletService from '../services/wallet.service.js';
import { TIERS, OPERATIONS, priceOf } from '../wallet/pricing.js';
import { byokAllowedFor } from '../config.js';

const OPERATION_ENUM = Object.values(OPERATIONS);

export default async function walletRoutes(app) {
  // 余额（auth）：balance / openReservations / available
  app.get('/wallet/balance', {
    preHandler: [app.authenticate],
    handler: async (request) => ({
      currency: 'credits',
      // BK-008（ADR-003）：状态通道下发 BYOK 白名单标志（客户端从本响应派生，双通道之一）
      byokAllowed: byokAllowedFor(app.byokAllowlist, request.user.email),
      ...(await walletService.getWalletState(app.db, request.user.id)),
    }),
  });

  // 消费记录（auth，游标分页：limit + beforeId）
  app.get('/wallet/ledger', {
    preHandler: [app.authenticate],
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
    handler: async (request) => ({
      entries: walletService.listLedger(app.db, {
        userId: request.user.id,
        limit: request.query.limit,
        beforeId: request.query.beforeId,
      }),
    }),
  });

  // 档位目录（公开）：9.9→100 / 29.9→350 / 49.9→700 主推
  app.get('/wallet/tiers', {
    handler: async () => ({ tiers: TIERS }),
  });

  // 预计消耗（公开）：operation → credits（计费/免费）；未知 operation → 400
  app.get('/wallet/estimate', {
    schema: {
      querystring: {
        type: 'object',
        required: ['operation'],
        additionalProperties: false,
        properties: { operation: { type: 'string', enum: OPERATION_ENUM } },
      },
    },
    handler: async (request) => {
      const { operation } = request.query;
      const credits = priceOf(operation);
      return { operation, credits, billable: credits > 0 };
    },
  });
}
