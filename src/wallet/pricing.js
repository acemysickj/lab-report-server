// src/wallet/pricing.js — 服务端权威定价与档位目录（COM-003）
// 契约 docs/COM-CONTRACT.md「商业模式」：档位 9.9(100 额度)/29.9(350)/49.9(700 主推)；
// 首版计费操作：生成部分/生成图表；免费：模板解析、讲义检索。
// 安全铁律：credits/model/price 一律服务端决定——本文件是唯一价格来源，客户端传值一律忽略。
// 注：单价为 v1 服务端常量（契约未定具体单价），调整须经版本化变更（COM-005 Admin 只读展示，不改价）。

export const OPERATIONS = Object.freeze({
  GENERATE_SECTION: 'generate_section', // 生成部分（计费）
  GENERATE_CHART: 'generate_chart',     // 生成图表（计费）
  PARSE_TEMPLATE: 'parse_template',     // 模板解析（免费）
  SEARCH_LECTURE: 'search_lecture',     // 讲义检索（免费）
});

export const PRICING = Object.freeze({
  [OPERATIONS.GENERATE_SECTION]: 5,
  [OPERATIONS.GENERATE_CHART]: 3,
  [OPERATIONS.PARSE_TEMPLATE]: 0,
  [OPERATIONS.SEARCH_LECTURE]: 0,
});

export function priceOf(operation) {
  const credits = PRICING[operation];
  if (credits === undefined) {
    return null; // 未知操作：拒绝，而非默认计费
  }
  return credits;
}

export function isBillable(operation) {
  const credits = PRICING[operation];
  return typeof credits === 'number' && credits > 0;
}

// 档位目录（与 orders.tier CHECK 约束、契约价格一一对应）
export const TIERS = Object.freeze([
  Object.freeze({ tier: 'tier_9_9', priceCents: 990, credits: 100, recommended: false }),
  Object.freeze({ tier: 'tier_29_9', priceCents: 2990, credits: 350, recommended: false }),
  Object.freeze({ tier: 'tier_49_9', priceCents: 4990, credits: 700, recommended: true }), // 主推
]);

export function findTier(tierId) {
  return TIERS.find((t) => t.tier === tierId) ?? null;
}
