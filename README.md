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
