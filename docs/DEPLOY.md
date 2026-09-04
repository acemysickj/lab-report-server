# DEPLOY.md — lab-report-server 部署手册（v0.10.0 Commercial Core）

> 基建现场（Ubuntu 24.04 / 2C2G / Node 24.20 / PM2 7.0.4 / Nginx 1.24 / deploy key）见
> docs/SERVER-HANDOFF-v0.10.0.md。本文是每次发布的执行手册；部署纪律出自
> docs/COM-CONTRACT.md「部署纪律」，与本文冲突时以契约为准。
> 服务器 IP 与域名不入本仓库文档（公网仓库），现场向用户索取。

## 0. 部署前置（首次）

```bash
# 服务器上（labreport 用户）
mkdir -p /srv/lab-report-server && cd /srv/lab-report-server
git init && git remote add origin git@github.com:acemysickj/lab-report-server.git
git fetch --depth 1 origin tag <TAG> && git checkout <TAG>   # 首次直接拉 tag
# deploy key 只读（~/.ssh/github_deploy，IdentitiesOnly yes），见 SERVER-HANDOFF §7
```

生产环境变量（PM2 环境/`~/.bashrc` 注入，**只存服务器环境，不入 git**）：

| 变量 | 要求 |
|---|---|
| `AUTH_JWT_SECRET` | ≥32 字符随机串（`openssl rand -hex 32`），泄露=全体会话可伪造 |
| `DEEPSEEK_API_KEY` | DeepSeek 平台专用 key（非日常开发 key，只存服务器） |
| `DATA_DIR` | `/srv/lab-report-server/data`（默认 `./data` 亦可，二者取一固定） |
| `PORT` / `HOST` | `3000` / `127.0.0.1`（ecosystem.config.cjs 已固化；Fastify 绝不直接暴露公网） |

## 1. 常规发布（每次）

```bash
cd /srv/lab-report-server
git fetch --tags origin
git checkout <TAG>                     # 或：git pull --ff-only master
npm ci --omit=dev                      # .npmrc ignore-scripts=true；better-sqlite3 13 自带 prebuild
npm test                               # 全绿才允许继续
npm run migrate                        # 迁移台账 _migrations；幂等，可重复执行
pm2 reload ecosystem.config.cjs --update-env   # 首次用 pm2 start
curl -s http://127.0.0.1:3000/health   # 期望 {"status":"ok"}
pm2 save                               # 固化进程列表（首次/变更后）
```

失败回滚：`git checkout <上一 TAG>` → `npm ci --omit=dev` → `npm run migrate`（台账幂等，旧库无需回滚迁移）→ `pm2 reload`。

## 2. Nginx 反代（域名+ICP 备案就绪后一次配置）

```nginx
server {
    listen 443 ssl;
    server_name <域名>;
    # 证书：acme.sh 签发后路径
    ssl_certificate     ~/.acme.sh/<域名>_ecc/fullchain.cer;
    ssl_certificate_key ~/.acme.sh/<域名>_ecc/<域名>.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';        # SSE 必需：禁用 keep-alive 头改写
        proxy_set_header X-Request-Id $http_x_request_id;
        proxy_buffering off;                   # SSE 必需：关闭缓冲，正文块实时透传
        proxy_read_timeout 300s;               # AI 长任务流
        access_log off;                        # 契约：Nginx 不记录 request body
    }
}
```

- 备案未下来前的临时联调：`listen 80; server_name <服务器IP>;` 同 location 配置（明文，仅联调期）。
- SSE 三件套（Connection''/proxy_buffering off/read_timeout）缺一客户端会表现为「无流式输出」。

## 3. 客户端发版联动

1. 客户端 `electron-builder.release.js` 构建安装版三件套时以环境变量
   `UPDATE_PUBLISH_URL=https://<域名>/updates/` 烧入 app-update.yml（更新源=本服务器）。
2. 服务器需暴露 `/updates/` 静态目录存放 latest.yml + blockmap + exe（Nginx `location /updates/` 指向目录，autoindex off）。
3. 三件套上传 GitHub Release（历史通道）；0.10.0 起安装版更新源=服务器优先、GitHub 兜底。

## 4. 验收清单（每次发布后）

- [ ] `curl -s http://127.0.0.1:3000/health` → `{"status":"ok"}`
- [ ] 外网 `https://<域名>/health`（或联调 `http://<IP>/health`）→ 200
- [ ] 客户端注册/登录/余额/预计消耗可达
- [ ] SSE 计费生成一单：流式输出 + 余额扣减 + 消费记录一条（无 key 时应 503 ai_not_configured，同样证明链路通）
- [ ] `pm2 logs lab-report-server --lines 50` 无错误堆栈；日志中无任何请求正文（P-005）

## 5. 已知边界

- 首个账号的额度发放：支付渠道后置（COM-005 Admin 未至），本地/测试用 `scripts/grant-dev-credits.js`（仅限开发环境，不得用于生产）。
- `AUTH_JWT_SECRET` 换新 = 全体登录态失效（客户端需重新登录），属预期行为。
