# INCIDENT-RUNBOOK.md — 首批用户故障应急预案（OPS）

> 一人维护模式。核心原则：**先止损，再定位；服务器优先热修；客户端必须修时，先保证用户报告可恢复。**
> 配套：docs/DEPLOY.md（部署与运维）、docs/COM-004-INTEGRATION.md（错误码表）、运营手册-内部.md（客服口径）。

## 0. 报障第一句话（对用户的标准开场）

> 「先别重装、别删报告。打开应用 → 我的 → 把页面上显示的【服务状态】和【最近错误】发我，或描述一下点了哪个按钮、提示了什么文字、大概几点操作的。」

禁止说：「你重装一下试试」「你删了重新来」。

## 1. 故障分级

| 级别 | 定义 | 典型例子 | 响应 |
|---|---|---|---|
| **S0 重大事故** | 大面积登录失败、错误扣费、数据/账号风险、密钥泄露、安全事件 | 扣费翻倍、`.env.production` 泄露、注入攻击得手 | **立即止损**：kill switch / 停服；保护钱包与数据；群公告；修复+人工冒烟后再恢复 |
| **S1 核心功能大面积不可用** | 生成全面失败、SSE 全面卡死、AI 上游兼容性变化 | DeepSeek 改参数、网关全 502 | 看 status/errorCode → 优先修服务端/Gateway → `pm2 reload` → 人工冒烟 → 恢复 |
| **S2 局部用户问题** | 单账号、某类报告、个别任务失败 | 某用户额度没到账、特定模板解析失败 | 拿 requestId/jobId → 查 `ai_jobs`/ledger → 退款/补偿 → 判断是否需要 hotfix |
| **S3 非阻塞** | UI、文案、边角功能 | 错别字、布局小问题 | 记入 ISSUES.md，普通批次修复，不打断生产 |

## 2. 定位路径（第一分钟做什么）

```
用户报障
  → 应用「我的」页看【服务状态】灯（绿=平台正常，用户侧/网络问题）
  → 不绿，或用户已给 requestId/jobId：
      ① 服务器：curl -s http://127.0.0.1:3000/health
      ② 任务表：node -e "..."（命令见 §5）
      ③ 计量：curl -s http://127.0.0.1:3000/api/v1/admin/usage -H "Authorization: Bearer $ADMIN_TOKEN"
  → 分类处理（§3）
```

判定优先级：**服务器通不通 → 网关/上游错没错 → 账号/额度对不对 → 客户端/本地能力**。

## 3. 处理剧本

### 3.1 能只修服务器的（用户不更新客户端）
- AI 上游参数变化 → 改 `src/ai/transport.js`（adapter 层）→ push → 服务器 pull + reload
- 限流误伤 → 调 `RATE_*` env → reload
- 功能异常但根因未明 → 先 kill switch（下文 §4）止血，再慢慢修

### 3.2 账号/额度类
- 先查 `credit_ledger` / `credit_reservations`，**不凭感觉补钱**
- 确认多扣 → `refundCredits` 补偿（走 admin grant 或直接 SQL + ledger 记账，必须留痕）
- 密码/登录类：本产品无找回功能，口径=重新注册（先提醒旧额度作废）

### 3.3 必须修客户端的
- 先确认用户报告仍可打开/导出（本地 canonical 数据与 PDF 解耦，TinyTeX 崩了报告也不丢）
- hotfix → 升版本号 → zip 重打 → Release（正式 release，latest 自动指向）
- 期间告知用户「你的报告都在本地，不会丢；修复版今天内出」

### 3.4 服务端重启遗留
- 单进程 fork 下重启：启动清扫自动把 running 任务标 `orphaned_by_restart` 并释放预扣（v0.10.5+）
- 若用户报「任务卡 running」：确认服务器版本 ≥ v0.10.5，重启一次即清

## 4. Kill Switch（临时关功能）

当前实现：密钥门。`DEEPSEEK_API_KEY` 置空 + `pm2 reload` → 全部 AI 任务立即 503（客户端显示「平台 AI 暂不可用」），编辑/导出/本地功能不受影响。这是 S1 时最快的止血手段。

计划中（COM 后续）：按 operation 粒度的 feature flag（`generate_chart` 单独关闭），见 ISSUES.md 遗留池。

## 5. 常用诊断命令（服务器上）

```bash
# 健康与健康细节
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/api/v1/status | python3 -m json.tool

# 最近 10 个任务（谁、什么错、什么时候）
node -e "const D=require('better-sqlite3');const db=new D('/var/lib/lab-report-server/app.db',{readonly:true});console.table(db.prepare('SELECT u.email,j.status,j.error_code,j.model,j.created_at FROM ai_jobs j JOIN users u ON u.id=j.user_id ORDER BY j.id DESC LIMIT 10').all())"

# 最近账本（对账/退费依据）
node -e "const D=require('better-sqlite3');const db=new D('/var/lib/lab-report-server/app.db',{readonly:true});console.table(db.prepare('SELECT l.type,l.delta,l.balance_after,l.created_at,u.email FROM credit_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 10').all())"

# 用量与限流快照
curl -s http://127.0.0.1:3000/api/v1/admin/usage -H "Authorization: Bearer $(grep ADMIN_TOKEN /srv/lab-report-server/.env.production | cut -d= -f2)"

# 实时日志
pm2 logs lab-report-server --lines 50
```

## 6. 上线前强制演练清单（每项记录：现象 → errorCode → 修复层级 → 用户恢复路径）

- [ ] DeepSeek 429 / 500 / 超时（fake transport 或改 key 制造）
- [ ] SSE 中途断开（生成中杀服务器）
- [ ] Fastify 500（构造 invalid payload）
- [ ] Nginx 不可达（`systemctl stop nginx`，验证客户端报错文案）
- [ ] 余额不足 / 同幂等键重复请求
- [ ] 客户端进程被杀后重开，报告仍在
- [ ] 服务端重启后的 running/reserved 孤儿清扫（启动日志出现 swept 行）
- [ ] 客户端 0.10.1 ↔ 服务端 v0.10.5 轻微版本差异下全流程可用

## 7. 复盘

S0/S1 处理完 24h 内：现象时间线 → 根因 → 修复层级 → 预防措施 → 需要的测试/监控，补进 ISSUES.md。
