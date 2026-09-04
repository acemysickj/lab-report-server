# v0.10.0 Commercial Core — 冻结契约（FROZEN / APPROVED 2026-09-04）

> 本文件是 lab-report-server 与客户端商业化改造的唯一权威契约。执行模型只能在契约内实现；
> 提出 PostgreSQL/Redis/Workers/WebSocket/微服务/云端报告/客户端传 model/客户端传 credits
> 均视为架构变更提案，须报队长裁决，不得自行实施。

## 基础设施
阿里云深圳轻量 2C2G；Ubuntu 24.04 LTS；Nginx；Node.js 24 LTS；Fastify 5；
better-sqlite3 13.x；SQLite WAL（journal_mode=WAL / synchronous=NORMAL / foreign_keys=ON /
busy_timeout=5000，初始化第一天配死）；PM2 单进程 fork（max_memory_restart 512M）；
acme.sh 自动 HTTPS；ESM；npm + package-lock.json。Fastify 只监听 127.0.0.1，不暴露公网。

## 身份认证
Argon2id 密码哈希（禁 SHA256/MD5/bcrypt 新项目首选）；JWT Access 15min / Refresh 30d；
Refresh Rotation + 复用检测（复用 → 整 token family 作废）；auth_sessions 表存
token_hash/device_id/replaced_by/revoked_at/last_used_at；JWT payload 只放 sub/sid/iat/exp
（余额/用户名/角色/额度一律不入 payload，运行时从库读）。

## 数据库 8 表（v1 冻结）
users / accounts / credit_ledger / credit_reservations / auth_sessions / orders / ai_jobs / idempotency_keys

## 安全铁律
- 客户端只提交 operation + business payload；credits/model/price 一律服务端决定，客户端传值不可信
- DeepSeek API Key 只存服务器环境（专用 key，非日常开发 key）
- X-Request-Id 所有请求必备；AI 业务任务独立 jobId（SSE 断线 job 续存 running/completed/failed/refunded）
- AI 请求正文不得进入：application log / SQLite / error dump / 任何持久化
- Nginx 不记录 request body；Fastify logger redact body

## AI 模型池
主：deepseek-v4-flash；备：deepseek-v4-pro（主不可用自动 fallback）。生产客户端不可自选模型。

## 商业模式
档位：9.9(100 额度) / 29.9(350) / 49.9(700 主推)；首版计费操作：生成部分 / 生成图表；
免费：模板解析、讲义检索；后置：129 档、双货币、签到、邀请、10 分钟免费重生成、交卷检查。

## 风控
并发 2 / 每分钟 10 / 每小时 50，后台可调；不绑机器码。

## 注册
邮箱即用户名 + 密码（Argon2id）；首版不做邮箱验证（不能承担找回密码/账号归属证明，
首版提供人工账号恢复路径）；注册页两层告知（简明 + 完整隐私政策/服务协议链接 + 勾选，
勾选状态服务器可追溯）。

## BYOK（自带 key）
高级/开发者模式旁路：用户自己的 key → 本地直连 → 不经平台钱包、不消耗 credits。
生产 UI 明确区分「平台 AI / 自己的 API Key」；BYOK 不得成为绕过计费的后门。

## 隐私（COM-002-A 前置于 Auth，P-001~P-008）
四件套：注册页简明告知 + 完整隐私政策 + 服务协议 + 删除账号机制。
P-001 注册页双文档与勾选；P-002 勾选状态服务器可追溯；P-003 政策含处理者身份/联系方式/
数据类别/目的/方式/保存期限/用户权利/删除方式；P-004 明确披露 AI 第三方服务商（DeepSeek）；
P-005 AI 请求正文不入应用日志；P-006 不入 SQLite；P-007 注销执行数据删除
（删资料/会话/用户数据，保留交易必要账务记录）；P-008 数据处理地域与传输口径单独成节。
措辞规范：「讲义/报告/图片不在本服务服务器持久化存储；为完成 AI 服务，请求中的必要文本
会经服务器转发至 AI 服务提供商（DeepSeek），其按其适用条款与隐私政策处理」——不替
DeepSeek 作额外承诺；不对外使用「H3 合规」作为认证口径。
跨境口径（GPT 精修采纳）：当前生产架构为中国大陆服务器 + DeepSeek API，按现有数据流设计
不向境外提供个人信息；若未来引入境外服务器/AI 服务商/存储/日志/CDN 等组件，须重新做
跨境个人信息处理评估并更新隐私政策。

## 客户端发布
GitHub：acemysickj/lab-report-assistant；v0.10.0 起烧入 app-update.yml（L5 关闭）。

## 部署纪律
git pull --ff-only → npm ci --omit=dev → npm test → migrate → pm2 reload → GET /health。
生产必须打 Git Tag。releases/ + current 软链方案后置（不进 COM 第一阶段）。

## 发行前置（硬检查项）
H1：正式发行前 tinytex-provenance.json 必须 pin 真实 SHA-256（ISS-18：发行 pin 后
H1 拒绝用例需注入 manifest 保拒绝分支覆盖）；M2：代码签名证书（商业化前）。

## 实施序列
COM-001 服务器骨架（health/WAL/migrations 8 表/tests/PM2 配置；本地先绿，不碰钱包/AI/Electron）
→ COM-002-A 隐私基础（文档 + 契约文本）→ COM-002 Auth → COM-003 Wallet（账本/reservation/
原子消费/退款/幂等）→ COM-004 AI Gateway（DeepSeek/MODEL_MAP/SSE/jobId）→ COM-005
限流 + 成本计量 + 极简 Admin → Phase 2 客户端接入（登录/余额/预计消耗/套餐/消费记录/
Gateway 改造/BYOK）→ v0.10.0 Release（客户端 zip + 安装版三件套 + 服务器 git tag 部署）。

## 已裁决事实基线
Node 24 LTS（Node 20 已 EOL）；服务器 = 阿里云深圳（境内），按当前数据流不触发 PIPL 39
跨境提供；DeepSeek 平台 key 采用个人账户（用户体量决策），服务器专用 key、只存服务器环境。
