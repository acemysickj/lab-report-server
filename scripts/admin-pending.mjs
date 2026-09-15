// scripts/admin-pending.mjs — 收款对账辅助名单（PROMO-001，跑在运营者自己的电脑上）
// 用法：node scripts/admin-pending.mjs [server-url]
//   交互输入 ADMIN_TOKEN → 拉取 /admin/users（分页全量）→ 打两张名单：
//   ①注册未付费（余额=0 且无发放流水）——对微信账单核「谁该付还没付」；
//   ②付费在用（有发放流水，按最近台账活动排序）——核对「谁付了在用」。
// 口径与 /admin/stats 一致（purchaseCount 来自服务端 listUsers 扩展字段）。
// 安全口径同 admin-grant.mjs：ADMIN_TOKEN 只在本机交互输入，不持久化。
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** 非交互核心（可测试）：单页拉取。 */
export async function fetchUsersPage({ serverUrl, token, limit = 100, beforeId }) {
  const url = new URL('/api/v1/admin/users', serverUrl.replace(/\/+$/, ''));
  url.searchParams.set('limit', String(limit));
  if (beforeId) url.searchParams.set('beforeId', String(beforeId));
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
  return body.users || [];
}

/** 非交互核心（可测试）：分页拉全量。 */
export async function fetchAllUsers({ serverUrl, token }) {
  const all = [];
  let beforeId;
  for (;;) {
    const page = await fetchUsersPage({ serverUrl, token, beforeId });
    all.push(...page);
    if (page.length < 100) return all;
    beforeId = page[page.length - 1].id;
  }
}

/** 名单划分（纯函数）：注册未付费 / 付费在用。 */
export function classifyUsers(users) {
  const pendingPay = users
    .filter((u) => u.balance === 0 && u.purchaseCount === 0)
    .map((u) => ({ id: u.id, email: u.email, registeredAt: String(u.created_at || '').replace('T', ' ').slice(0, 16) }));
  const paying = users
    .filter((u) => u.purchaseCount > 0)
    .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
    .map((u) => ({
      id: u.id,
      email: u.email,
      balance: u.balance,
      purchases: u.purchaseCount,
      lastActivity: String(u.lastActivityAt || '').replace('T', ' ').slice(0, 16),
    }));
  return { pendingPay, paying };
}

function printList(title, rows, cols) {
  console.log(`\n== ${title}（${rows.length} 人）==`);
  if (!rows.length) {
    console.log('  （无）');
    return;
  }
  for (const r of rows) {
    console.log('  ' + cols.map((c) => `${c.label}${r[c.key] ?? '-'}`).join('  '));
  }
}

// CLI 入口（被 import 测试时不执行）
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('admin-pending.mjs')) {
  const serverUrl = process.argv[2] || 'https://lab-report.top';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const token = await rl.question('ADMIN_TOKEN: ');
  rl.close();
  try {
    const users = await fetchAllUsers({ serverUrl, token });
    const { pendingPay, paying } = classifyUsers(users);
    console.log(`共 ${users.length} 个用户`);
    printList('注册未付费（对账：谁该付还没付）', pendingPay, [
      { key: 'id', label: '#' },
      { key: 'email', label: '邮箱 ' },
      { key: 'registeredAt', label: '注册于 ' },
    ]);
    printList('付费在用（按最近活动排序）', paying, [
      { key: 'id', label: '#' },
      { key: 'email', label: '邮箱 ' },
      { key: 'balance', label: '余额 ' },
      { key: 'purchases', label: '发放次数 ' },
      { key: 'lastActivity', label: '最近活动 ' },
    ]);
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  }
}
