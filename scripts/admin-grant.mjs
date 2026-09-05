// scripts/admin-grant.mjs — 运营者人工发放额度（交互式，跑在运营者自己的电脑上）
// 用法：node scripts/admin-grant.mjs [server-url]
//   交互输入：ADMIN_TOKEN → 注册邮箱 → 档位（1=100 / 2=350 / 3=700）→ 确认 → 发放并回显余额。
// 安全口径：ADMIN_TOKEN 只存运营者本机输入，不经本脚本持久化；服务器端已有 IP 限流与令牌守卫。
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const TIERS = {
  1: { tier: 'tier_9_9', credits: 100, price: '¥9.9' },
  2: { tier: 'tier_29_9', credits: 350, price: '¥29.9' },
  3: { tier: 'tier_49_9', credits: 700, price: '¥49.9（主推）' },
};

/** 非交互核心（可测试）：调用 admin API 发放。 */
export async function grantRemote({ serverUrl, token, email, tier }) {
  const res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/v1/admin/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, tier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
  }
  return body; // { userId, email, credits, balance, replayed? }
}

export function pickTier(choice) {
  const t = TIERS[String(choice).trim()];
  if (!t) throw new Error(`无效档位：${choice}（可选 1/2/3）`);
  return t;
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  (async () => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const serverUrl = (process.argv[2] || (await rl.question('服务器地址（默认 https://120.79.10.96）: ')) || 'https://120.79.10.96').trim().replace(/\/+$/, '');
    const token = (await rl.question('ADMIN_TOKEN: ')).trim();
    const email = (await rl.question('注册邮箱: ')).trim();
    const choice = await rl.question('档位（1=¥9.9/100额度  2=¥29.9/350  3=¥49.9/700）: ');
    let tier;
    try { tier = pickTier(choice); } catch (e) { console.error(e.message); process.exit(1); }
    const confirm = await rl.question(`确认：向 ${email} 发放 ${tier.credits} 额度（${tier.price}）？(yes/no) `);
    if (confirm.trim().toLowerCase() !== 'yes') { console.log('已取消'); process.exit(0); }
    try {
      const out = await grantRemote({ serverUrl, token, email, tier: tier.tier });
      console.log(`✔ 已发放：${out.email} +${out.credits} 额度，余额 ${out.balance}${out.replayed ? '（重复请求，未重复发放）' : ''}`);
    } catch (e) {
      console.error('✗ 发放失败:', e.message);
      process.exit(1);
    }
    rl.close();
    process.exit(0);
  })();
}
