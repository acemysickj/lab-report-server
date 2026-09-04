# 实验报告助手 · Commercial Core Architecture v1.0

日期：2026-09-04
基线：Electron v0.9.6
目标：把现有本地优先桌面应用安全迁移为“可登录、可计费、可收钱”的最小商业版本。

---

## 0. 架构拍板

### 0.1 商业模式

- v1 不做月订阅、自动续费。
- 采用预充值额度制。
- 初始价格作为配置项，不写死在客户端；默认沿用当前方案的低价学生档：9.9 / 24.9 / 49.9。
- v1 暂不做“双货币”积分系统；只做付费额度。
- 额度长期有效。
- 首个目标不是规模，而是完成 20 个真实付费用户验证。

### 0.2 技术架构

```text
Electron Client
    │
    │ HTTPS + Bearer + SSE(fetch streaming)
    ▼
Nginx
    │
    ▼
Node.js Commercial API
    ├── Auth
    ├── Wallet / Ledger / Reservation
    ├── AI Gateway
    ├── Orders / Manual Recharge
    ├── Rate Limit / Risk
    └── Admin
          │
          ├── SQLite
          └── DeepSeek API

本地继续保留：
- Report/Course 数据
- LaTeX 预览
- TinyTeX PDF 编译
- Python / matplotlib 图表执行
- 本地备份与导出
```

### 0.3 明确不做

第一阶段不引入：

- Cloudflare KV 作为钱包
- Redis
- PostgreSQL
- 微服务
- Kubernetes
- 对象存储
- 云端报告永久存储
- 云同步
- 自动支付回调
- 机器码绑定

这些都属于后续扩展，而不是 Commercial Core。

---

# 1. 系统边界

## 1.1 Server 是唯一权威的内容

服务端唯一决定：

- 用户是否登录有效
- 账号是否冻结
- 请求是否允许
- 当前余额
- 本次操作需要多少额度
- 使用哪个模型
- 使用哪个 system prompt
- 实际消耗多少 token
- 是否扣费
- 是否退款
- 订单是否已确认
- 风控是否拦截

客户端不得提交：

- API Key
- 实际扣费额度
- 商品价格
- 模型名称作为权威参数
- 钱包余额

客户端可以提交 operation 和业务 payload，但服务器重新计算费用。

## 1.2 Client 是本地能力权威

继续留在客户端：

- 课程/报告本地数据
- 模板文件管理
- LaTeX HTML 预览
- MathJax
- TinyTeX 编译
- PDF 导出
- matplotlib 本地执行
- 图片落盘
- 本地备份/恢复

这样服务器不需要承载 PDF 编译和 Python 算力。

---

# 2. Electron 改造原则

## 2.1 不直接重写现有报告业务

现有报告生成逻辑已经稳定，商业化只改“AI 交通层”和“账号/余额层”。

推荐新增统一抽象：

```text
app/ai-client.js
```

接口：

```js
login(...)
refresh(...)
getMe(...)
getWallet(...)
generatePart(payload, callbacks)
generateFigureScript(payload)
fixFigureScript(payload)
parseTemplateStructure(payload)
rebuildTemplate(payload)
```

生产模式所有 AI 均由 `ai-client.js` 走远程 API。

## 2.2 保留本地 LLM 代码，但标为开发/测试通道

现有：

```text
llm-client.js
```

不立即删除，以避免一次迁移导致回归。

新增环境开关：

```text
AI_TRANSPORT=remote   # release 默认
AI_TRANSPORT=local    # development/test only
```

release 构建不得把用户可编辑的 API Key 配置暴露出来。

## 2.3 配置迁移

现有 config-store 保留，用于：

- serverBaseURL
- refreshTokenEnc
- deviceId
- defaultExportDir
- update 配置

删除生产 UI 中：

- baseURL
- model
- apiKey

refresh token 继续加密存储；access token 只保存在内存。

不存用户密码。

---

# 3. Server Repository

建议新建与 Electron 并列的独立目录：

```text
commercial-server/
├── package.json
├── .env.example
├── README.md
├── migrations/
│   ├── 001_init.sql
│   ├── 002_wallet.sql
│   └── 003_orders.sql
├── src/
│   ├── index.js
│   ├── config.js
│   ├── http.js
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── rate-limit.js
│   │   └── request-id.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── wallet.js
│   │   ├── ai.js
│   │   ├── orders.js
│   │   └── admin.js
│   ├── services/
│   │   ├── auth-service.js
│   │   ├── wallet-service.js
│   │   ├── ai-service.js
│   │   ├── order-service.js
│   │   └── risk-service.js
│   ├── llm/
│   │   ├── deepseek.js
│   │   └── prompts/
│   ├── db/
│   │   ├── db.js
│   │   ├── migrations.js
│   │   └── backup.js
│   └── util/
│       ├── crypto.js
│       ├── ids.js
│       └── errors.js
└── test/
    ├── auth.test.js
    ├── wallet-concurrency.test.js
    ├── ai-billing.test.js
    └── api.test.js
```

技术选型：

- Node.js
- Express
- SQLite + better-sqlite3
- Nginx
- 原生 `crypto.scrypt` 做密码哈希
- access/refresh session，不强制 JWT

采用普通 session/token 而不是 JWT 的原因：商业 MVP 更容易撤销、踢设备、封号、审计，也减少 JWT 配置复杂度。

---

# 4. 数据模型

## 4.1 users

```sql
users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

## 4.2 sessions

```sql
sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

单账号默认最多 3 个活跃设备，不做机器码绑定。

## 4.3 accounts

```sql
accounts(
  user_id TEXT PRIMARY KEY,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

额度必须用整数，禁止浮点。

## 4.4 credit_ledger

```sql
credit_ledger(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL,
  operation TEXT,
  reference_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

type：

```text
purchase
consume
refund
grant
admin_adjust
```

## 4.5 credit_reservations

```sql
credit_reservations(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT UNIQUE NOT NULL,
  operation TEXT NOT NULL,
  reserved_amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

status：

```text
reserved
committed
refunded
```

## 4.6 ai_jobs

```sql
ai_jobs(
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  credit_reserved INTEGER NOT NULL,
  credit_charged INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

## 4.7 orders

```sql
orders(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  confirmed_at INTEGER,
  confirmed_by TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
)
```

v1 status：

```text
pending
paid_pending_confirm
confirmed
cancelled
```

## 4.8 admin_audit

所有人工充值、退款、封禁、余额调整必须有审计记录。

---

# 5. API v1

## 5.1 Auth

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/me
```

register：

```json
{
  "username": "demo",
  "password": "...",
  "deviceId": "uuid"
}
```

login 返回：

```json
{
  "accessToken": "...",
  "expiresIn": 900,
  "refreshToken": "...",
  "user": {
    "id": "...",
    "username": "demo"
  }
}
```

## 5.2 Wallet

```text
GET /api/v1/wallet
GET /api/v1/wallet/transactions?limit=50&cursor=...
```

返回：

```json
{
  "creditBalance": 693
}
```

## 5.3 AI

```text
POST /api/v1/ai/report/generate-part
POST /api/v1/ai/figure/generate-script
POST /api/v1/ai/figure/fix-script
POST /api/v1/ai/template/parse
POST /api/v1/ai/template/rebuild
```

### generate-part 请求

```json
{
  "requestId": "uuid",
  "reportId": "local-report-id",
  "partIndex": 3,
  "title": "实验原理",
  "structure": ["实验目的", "实验原理", "实验步骤"],
  "context": "...",
  "dataText": "...",
  "previousParts": ["..."],
  "instruction": "...",
  "tableForm": false
}
```

客户端不得发送 `credits` 作为计费依据。

### SSE

HTTP：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Request-Id: <requestId>
```

事件：

```text
event: chunk
data: {"delta":"..."}


event: usage
data: {"inputTokens":123,"outputTokens":456}


event: done
data: {"jobId":"...","creditsCharged":7}
```

失败：

```text
event: error
data: {"code":"AI_TIMEOUT","message":"AI 请求超时，请重试"}
```

客户端继续复用现有 `onPartChunk` 语义。

---

# 6. 计费引擎

## 6.1 v1 计费原则

为了让学生感知简单，前台只显示“预计消耗”。

后台按 operation + 复杂度计算。

默认：

```text
generate_part = 5
+ long_text(>1500 chars) = +2
+ latex_complexity = +1

最低 5，典型 7，复杂 8。
```

但内部自动重试不额外向用户收费；服务器应为内部 retry 在预算里留余量。

figure：

```text
generate_figure_script = 4
```

一次自动修正包含在这次 operation 内。

parse-template：

```text
0
```

rebuild-template：

```text
v1-beta 默认 0 或通过后台价格配置开启收费。
```

## 6.2 钱包事务

所有扣费必须是 SQLite transaction。

```text
BEGIN
  1. 找到 accounts
  2. 校验 balance >= reserve
  3. 检查 requestId 是否已存在
  4. account balance -= reserve
  5. 写 credit_ledger(-reserve)
  6. 写 credit_reservation(reserved)
  7. 写 ai_job
COMMIT
```

之后才调用 LLM。

## 6.3 成功

```text
LLM 完整返回
→ ai_job completed
→ reservation committed
```

如果实际最终成本低于 reserve：

```text
差额退款
→ credit_ledger(refund)
```

## 6.4 失败

如果上游请求未完成：

```text
reservation refunded
→ 钱包恢复
```

只允许一次 refund，靠 reservation status 保证幂等。

如果客户端主动断开，但服务端已经从上游拿到完整结果：

```text
仍视为成功并扣费
```

因为结果已经由服务器完整生成；否则客户端可通过主动断连接逃避扣费。

---

# 7. AI Gateway

## 7.1 客户端永远看不到上游 Key

服务器环境变量：

```text
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=...
DEEPSEEK_MODEL=...
```

不得通过：

- API 响应
- 日志
- 错误栈
- SSE
- client config

泄漏。

## 7.2 模型路由

客户端不决定 model。

服务器根据 operation 配置：

```text
generate_part            → 主模型
figure_script            → 主模型
template_parse           → 主模型
template_rebuild         → 主模型
```

以后可以只改服务器配置，不发布客户端。

## 7.3 Prompt 管理

Prompt 从 Electron 迁移到 server。

建议：

```text
src/llm/prompts/report-part.js
src/llm/prompts/figure.js
src/llm/prompts/template.js
```

客户端只发送业务上下文，不发送 system prompt。

---

# 8. 请求限制

单次请求最大 body：1 MB。

输入长度建议硬上限：

```text
context       <= 40000 chars
previousParts <= 40000 chars
dataText      <= 20000 chars
instruction   <= 5000 chars
```

账号限制：

```text
AI 并发：2
AI 请求：10 / min
认证请求：5 / min / IP
```

额外：

- requestId 幂等
- IP + user 双维度限流
- 单账号活跃设备 <= 3
- 异常切换设备提高验证等级
- 每日最大 AI 消费可配置

---

# 9. 支付 MVP

第一阶段不要接自动支付。

流程：

```text
客户端选择套餐
↓
POST /orders
↓
服务端创建订单
↓
用户付款
↓
用户提交付款凭据/订单号
↓
管理员后台确认
↓
SQLite transaction
↓
orders = confirmed
↓
accounts.balance += credits
↓
credit_ledger type=purchase
```

管理员确认必须幂等。

禁止直接改 balance 而不写 ledger。

后续正式支付接入只替换“支付确认”这一段，不改钱包模型。

---

# 10. Admin MVP

必须有最小后台，哪怕先是服务端保护的 HTML 页面。

功能：

```text
1. 登录
2. 用户搜索
3. 查看余额
4. 查看流水
5. 创建订单/查看订单
6. 手动确认充值
7. 手动退款
8. 封禁/解封
9. 查看 AI job
10. 查看成本统计
```

关键指标：

```text
今日请求数
今日 AI 成本
今日充值金额
人均消耗额度
退款数
失败率
P50/P90/P99 AI 请求耗时
```

---

# 11. Electron 迁移序列

## C-001：新增 remote-ai-client

新增：

```text
app/ai-client.js
```

职责：

- server URL
- access token
- refresh token
- REST 请求
- POST streaming SSE parser
- 自动 refresh
- 统一错误码

验收：

```text
node --check
单元测试全部通过
```

## C-002：新增 auth IPC

preload 增加：

```text
register
login
logout
getMe
refreshSession
getWallet
getWalletTransactions
```

main.js 不把 token 暴露给 renderer。

## C-003：改 generate-part

原路径：

```text
renderer → IPC → main.js → callLLM → DeepSeek
```

新路径：

```text
renderer → IPC → main.js → ai-client → server → DeepSeek
                                         ↓ SSE
renderer ← IPC ← main.js ← ai-client ←───
```

保持现有：

```text
part-chunk
contentOverride
```

语义不变。

## C-004：改 generate-figure

server：

```text
generate script
fix script
```

client：

```text
run Python
save PNG
```

这样继续利用现有 python sandbox 和路径安全代码。

## C-005：改 parse-template-structure

模板文件仍由本地读取。

客户端只把必要文本发送到 server。

## C-006：改 template-convert

保留：

```text
Word → PDF
PDF text extraction
cover detection
```

迁移：

```text
PDF extracted text → server → LLM → tex
```

## C-007：重做 Settings

删除生产 UI：

```text
API Base URL
Model
API Key
```

增加：

```text
账号
剩余额度
充值
消费记录
服务器状态
```

## C-008：生成前余额检查

前台：

```text
本次预计消耗：7 额度
当前余额：693
```

不足：

```text
余额不足
[去充值]
```

服务端仍需再次检查，UI 检查不能代替服务器检查。

---

# 12. 测试门禁

## T0：原有回归

必须保持：

- unit
- integration
- e2e
- ui
- smoke

不允许商业化迁移破坏本地 PDF / Python / 模板功能。

## T1：钱包并发

测试：

```text
余额 = 7
同时发起 20 个 generate_part
```

预期：

```text
最多 1 个成功扣款
其余全部余额不足
最终余额 = 0
```

## T2：幂等

相同 requestId 重放 10 次：

```text
只能产生一次 reservation
只能产生一次扣费
```

## T3：失败退款

模拟：

- 401
- 429
- 500
- timeout
- stream interrupted
- empty response

每种只允许产生一次 refund。

## T4：SSE

验证：

- 中文不乱码
- 跨 chunk 行可正确解析
- 长文本不丢 delta
- done 之后不再写 chunk
- upstream error 能转换成稳定中文错误码

## T5：密钥隔离

release 包和 renderer：

- 不存在 API key 输入框
- 不存在 DeepSeek key
- 不存在可直接调用 DeepSeek 的生产路径

## T6：安全

- 路径安全测试继续全部通过
- Python sandbox 全部通过
- sandbox=true 不回退
- Nginx HTTPS
- 数据库文件不允许公网访问

---

# 13. 部署

起步服务器：

```text
香港 VPS
1C1G
```

部署：

```text
Nginx :443
   ↓
Node :3000 localhost
   ↓
SQLite /data/app.db
```

目录：

```text
/opt/lra-server/
├── current/
├── releases/
├── data/
│   ├── app.db
│   └── backups/
└── logs/
```

SQLite：

- WAL
- 每日备份
- 保留 7~14 天
- 每周做一次恢复演练

禁止：

```text
0.0.0.0:3000
```

Node 只监听：

```text
127.0.0.1:3000
```

---

# 14. 发布顺序

## Phase A：Commercial Core

```text
A1 Server skeleton
A2 SQLite + migrations
A3 Auth
A4 Wallet + ledger + reservation
A5 AI Gateway
A6 SSE
A7 Rate limit
A8 Admin MVP
```

## Phase B：Electron 接入

```text
B1 remote-ai-client
B2 Auth IPC/UI
B3 Wallet UI
B4 generate-part migration
B5 figure migration
B6 template migration
B7 settings cleanup
```

## Phase C：人工充值

```text
C1 plans
C2 orders
C3 admin confirm
C4 recharge UI
C5 consumption history
```

## Phase D：Beta

```text
D1 internal 5 users
D2 20 users
D3 50 users
D4 cost analysis
D5 adjust pricing
```

只有 D 阶段验证付费后，才考虑：

```text
签到
邀请
自动支付
模板生态
云同步
```

---

# 15. 开发执行规则

每个任务必须做到：

```text
代码
→ 单元测试
→ 集成测试
→ 关键路径回归
→ changelog
```

禁止一次同时改：

```text
钱包 + AI + UI + 支付
```

每轮只允许一个业务边界变化。

每个任务输出：

```text
TASK ID
Changed files
Behavior change
Tests added
Tests run
Risk
Rollback
```

---

# 16. 第一批任务（立即执行顺序）

### TASK-COM-001
Commercial server skeleton + health endpoint + config + SQLite migration runner。

验收：

```text
GET /health → 200
SQLite 自动创建
migration 可重复执行
server 可在 VPS 本机启动
```

### TASK-COM-002
Auth：register/login/refresh/logout + session store。

验收：

```text
注册一次
登录成功
刷新成功
注销后 token 不可用
```

### TASK-COM-003
Wallet：accounts + ledger + reservation + atomic consume/refund。

验收：

```text
20 并发请求无双花
重复 requestId 无重复扣费
失败只退款一次
```

### TASK-COM-004
DeepSeek adapter + SSE relay + usage capture。

验收：

```text
客户端永远拿不到 key
stream 不丢字
成功生成 ai_job
失败能稳定归一化
```

### TASK-COM-005
Electron remote-ai-client + auth/wallet IPC。

验收：

```text
release 模式不需要 API key
登录后可看到余额
access token 只在内存
```

### TASK-COM-006
迁移 generate-part。

验收：

```text
已有 renderer 逻辑基本不变
part-chunk 继续工作
contentOverride 继续工作
扣费成功 / 失败退款正确
```

### TASK-COM-007
迁移 figure + template。

验收：

```text
生图脚本仍在本地执行
PNG 落盘不回归
模板解析正常
PDF/Word 模板流程正常
```

### TASK-COM-008
Orders + plans + admin manual recharge。

验收：

```text
用户下单
管理员确认
额度自动到账
ledger 留痕
```

---

# 17. 架构完成定义

Commercial Core 只有满足下面全部条件才算完成：

```text
□ 客户端无 DeepSeek API key
□ Server 能独立运行
□ 注册/登录/注销完成
□ 余额是 server authoritative
□ 钱包具备 transaction + ledger + reservation
□ 20 并发测试无双花
□ requestId 幂等
□ AI 失败自动退款
□ SSE 稳定
□ generate-part 完整迁移
□ figure/template AI 调用完成迁移
□ PDF/LaTeX/Python 本地能力无回归
□ 有最小后台充值能力
□ 每日 SQLite 备份
□ release 包不存在用户可编辑 API key
□ 现有测试门禁保持绿色
```

达到这一状态，才进入真实付费用户阶段。
