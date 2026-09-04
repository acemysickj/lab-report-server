# lab-report-server

v0.10.0 Commercial Core 服务端。**唯一权威契约：[docs/COM-CONTRACT.md](docs/COM-CONTRACT.md)（FROZEN）**——一切实现不得越出契约；架构变更（换数据库/中间件等）须报队长裁决。

## 技术栈（契约冻结）

- Node.js **24 LTS**（`engines: >=24`）/ ESM（`"type": "module"`）
- **Fastify 5**（只监听 `127.0.0.1`，不暴露公网；Nginx + acme.sh HTTPS 在前）
- **better-sqlite3 13.x**（同步事务；四 PRAGMA 初始化第一天配死：
  `journal_mode=WAL` / `synchronous=NORMAL` / `foreign_keys=ON` / `busy_timeout=5000`）
- PM2 单进程 fork（`max_memory_restart 512M`）
- 数据库 8 张冻结表：users / accounts / credit_ledger / credit_reservations /
  auth_sessions / orders / ai_jobs / idempotency_keys

## 快速开始（本地）

```bash
# Node 24 环境下
npm ci            # 安装依赖（首次无 package-lock.json 时先 npm install）
npm test          # node --test（health / PRAGMA / 8 表 / migrate 幂等）
npm run migrate   # 应用 migrations/*.sql → data/app.db（幂等，可重复执行）
npm start         # 启动，默认 127.0.0.1:3000
curl -s http://127.0.0.1:3000/health   # → {"status":"ok"}
```

PM2 方式：`pm2 start ecosystem.config.cjs` → `pm2 reload lab-report-server`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `./data` | SQLite 数据目录（自动创建），db 文件 `app.db` |
| `HOST` | `127.0.0.1` | 监听地址（生产保持 127.0.0.1，由 Nginx 反代） |
| `PORT` | `3000` | 监听端口 |
| `AUTH_JWT_SECRET` | （无） | JWT 签名密钥，≥32 字符；生产必填（只存服务器环境），开发缺省时用临时密钥并告警 |
| `LEGAL_DOCS_DIR` | `./docs/legal` | 法务文档目录（/legal/privacy、/legal/terms 直出） |

## 认证（COM-002）

- `POST /api/v1/auth/register`：邮箱即用户名 + 密码（Argon2id）；body 须含 `consent`
  （两项勾选 true + 所同意的文档版本，P-001/P-002）；未勾选→400，版本不符→400，
  邮箱重复→409；consent 版本与时间落 `users` 表可追溯。
- `POST /api/v1/auth/login`：返回 `accessToken`(JWT 15min，payload 仅 sub/sid/iat/exp) +
  `refreshToken`(32B 随机串，库中只存 SHA-256 摘要) + `expiresIn`。
- `POST /api/v1/auth/refresh`：Rotation；**旧 refresh 重放 → 整 token family 作废**（复用检测）。
- `POST /api/v1/auth/logout`：Bearer；当前 family 整族作废（access 随 session 失效）。
- `DELETE /api/v1/account`：Bearer + 密码确认；P-007 注销——删会话与用户数据、
  脱敏身份字段（consent 留痕保留），`credit_ledger`/`orders` 等账务记录保留。
- `GET /legal/privacy`、`GET /legal/terms`：直出 `docs/legal/*.md`（v1.0-draft）。

## 钱包（COM-003）

- **读接口**：`GET /api/v1/wallet/balance`（auth，返回 balance/openReservations/available，
  可用=balance−未结预扣）；`GET /api/v1/wallet/ledger`（auth，游标分页 limit/beforeId，
  流水含 delta 与 balanceAfter）；`GET /api/v1/wallet/tiers`（9.9→100 / 29.9→350 / 49.9→700
  主推）；`GET /api/v1/wallet/estimate?operation=…`（预计消耗；未知操作 400）。
- **服务层（写路径，仅供 COM-004 AI Gateway / COM-005 Admin 服务端调用，不经客户端）**：
  `grantCredits`（订单履约：pending→delivered + purchase 流水）、`reserveCredits →
  settleReservation / releaseReservation`（两段式原子消费，全程 better-sqlite3 同步事务；
  不足 402 且无部分扣减）、`refundCredits`（refund 流水）、`runIdempotent`
  （idempotency_keys：user+operation+key 唯一，result_ref 重放同结果，不二次扣费）。
- **定价服务端权威**：`src/wallet/pricing.js` 是唯一价格来源（generate_section=5、
  generate_chart=3、parse_template/search_lecture 免费）；客户端传 credits/model/price
  一律无效——服务层签名无金额入口。
- **注销收尾（P-007）**：`deleteAccount` 删除事务内原子执行：未结预扣全部置 released +
  余额清零 + `adjust` 流水（balance_after=0），账务逐笔可对。
- `GET /api/v1/auth/consent-versions`：当前文档版本（客户端注册页引用）。
- 所有响应回显 `x-request-id`（客户端带则沿用，缺失服务端生成）。
- 限流（并发/每分钟/每小时）按契约由 COM-005 统一挂载，本模块未实现。

## 迁移机制

- `migrations/NNNN_*.sql` 按文件名升序应用，每个迁移在**单事务**内执行，失败即回滚。
- `_migrations` 台账记录 `name / checksum(SHA-256) / applied_at`；重复执行自动跳过（幂等）；
  已应用迁移的内容被改动 → checksum 不符 → 立即报错（追加式，不允许篡改历史）。

## 部署纪律（契约冻结）

```
git pull --ff-only → npm ci --omit=dev → npm test → migrate → pm2 reload → GET /health
```

- 生产必须打 **Git Tag**；Fastify 只监听 `127.0.0.1`，公网入口为 Nginx + acme.sh HTTPS。
- AI 请求正文不得进入 application log / SQLite / error dump / 任何持久化（P-005/P-006）。

## 依赖构建说明（Windows / Node 24）

- better-sqlite3 **13.0.3 的 npm 包自带全平台 prebuild**（含 `prebuilds/win32-x64.node`），
  Node 24 下无需任何原生编译，`require` 即用。
- 但 npm 对含 `binding.gyp` 且无 install 脚本的包会**隐式执行 `node-gyp rebuild`**：本机
  VS BuildTools 缺 VC++ 工具链时 `npm ci` 会失败（已实测两次，确定性失败）。因此仓库带
  `.npmrc`（`ignore-scripts=true`）跳过依赖包生命周期脚本；npm 文档保证 `npm start/test/
  run-script` 等显式命令不受影响（pre/post 钩子除外，本仓库未使用）。
- 若未来引入真正需要 install 脚本的依赖，需重新评估 `.npmrc` 并补装 MSVC 工具链。
- 本仓库不因上述问题换用 `node:sqlite`——那是架构变更，须按契约流程提案裁决。

## 目录结构

```
src/app.js          # buildApp() 工厂 + GET /health
src/server.js       # 进程入口（npm start / PM2）
src/db.js           # better-sqlite3 初始化 + 四 PRAGMA + DATA_DIR 解析
migrations/0001_init.sql  # 8 张冻结表
scripts/migrate.js  # 迁移执行器（_migrations 台账 / 事务 / 幂等）
test/               # node --test 测试套件
ecosystem.config.cjs# PM2 配置（fork 单实例 / 512M）
docs/COM-CONTRACT.md# 冻结契约（唯一权威）
```
