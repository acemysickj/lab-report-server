// scripts/grant-dev-credits.js — 本地/测试环境发放额度（仅开发冒烟用，非生产工具）
// 用法：DATA_DIR=./data-dev node scripts/grant-dev-credits.js <email> [tier]
//   tier ∈ tier_9_9(100) | tier_29_9(350) | tier_49_9(700)，缺省 tier_9_9
// 生产发放走支付回调/COM-005 Admin，本脚本不存在 HTTP 入口。
import { openDatabase, resolveDataDir } from '../src/db.js';
import { createOrder } from '../src/repositories/wallet.repository.js';
import { findUserByEmail } from '../src/repositories/user.repository.js';
import { grantCredits } from '../src/services/wallet.service.js';
import { findTier } from '../src/wallet/pricing.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const tierId = process.argv[3] || 'tier_9_9';
const tier = findTier(tierId);
if (!email || !tier) {
  console.error('用法: node scripts/grant-dev-credits.js <email> [tier_9_9|tier_29_9|tier_49_9]');
  process.exit(1);
}
const dataDir = resolveDataDir();
console.log(`数据目录: ${dataDir}（须与运行中服务端一致，否则会查错库）`);
const db = openDatabase();
const user = findUserByEmail(db, email);
if (!user) {
  console.error(`用户不存在: ${email}（先在客户端注册）`);
  process.exit(1);
}
const orderId = createOrder(db, { userId: user.id, tier: tier.tier, priceCents: tier.priceCents, credits: tier.credits });
const out = grantCredits(db, { userId: user.id, orderId, note: `dev grant ${tier.tier}` });
console.log(`已发放: ${email} +${tier.credits} 额度（${tier.tier}），余额 ${out.balance}`);
