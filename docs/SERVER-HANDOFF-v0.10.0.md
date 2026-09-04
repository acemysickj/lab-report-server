# Server Handoff — lab-report-server / v0.10.0 Commercial Core

> 目标：将本轮服务器初始化与当前生产基础设施状态交接给下一位 agent。
> 本文只记录服务器现场、已完成操作、当前约束、待办与已踩坑；商业架构正文以项目架构文档为准，不在此重复。

> ⚠️ **SYNC 注记（2026-09-04 晚，主会话同步）**：代码侧（Windows 本地 lab-report-server）已推进到 **COM-001 骨架 ✅（70eb63a）→ COM-002-A 隐私 ✅ → COM-002 Auth ✅（15f542d + repair 0f48b37，19/19）→ COM-003 钱包 ✅（bd36dc0，28/28）→ COM-004 Gateway ⏸ 中途停摆（3 待决点见 docs/COM-004-PENDING-DECISIONS.md）**。本文件 §11/§14/§15 中『COM-001 NOT STARTED / 开始 COM-001』现指 **代码尚未部署上服务器**（部署动作未做），不是代码缺失。队伍 lab-report-commercial 已解散；下次组队按路由铁律：glm-5.3-flash=干活、glm-5.3=大脑、mimo=机械、禁 DeepSeek。合并状态权威 = **docs/SERVER-STATE-SYNC-v0.10.0.md**（本仓库 docs/ 内已同步版）。

## 0. Source of truth / 参考文档

- Commercial Core 架构基线：`COMMERCIAL-CORE-ARCHITECTURE-v1.md`
- 商业化方案：`商业化方案.md`
- 商业化网络架构：`商业化网络架构.md`
- 服务端仓库：GitHub 私有仓 `acemysickj/lab-report-server`
- Windows 本地服务端工作目录：`D:\Claude Program\开发\lab-report-server`

本交接文档不是架构决策文件；若与架构文档冲突，以最新冻结的 Commercial Core 决策为准。

## 1. 已冻结的服务器技术栈

- 云：阿里云深圳
- OS：Ubuntu 24.04 LTS
- 规格：2 vCPU / 2 GiB / 40 GiB 系统盘 / 1 IPv4 / 200 Mbps 峰值 BGP / 不限流量
- Runtime：Node.js 24 LTS
- Web：Fastify 5
- DB：better-sqlite3 / SQLite
- Process manager：PM2，单进程 fork
- Reverse proxy：Nginx
- TLS：acme.sh（尚未正式配置）
- Auth：Argon2id + JWT access/refresh 双 token
- Module：ESM

## 2. 当前服务器状态

已验证：

- SSH 服务正常
- `labreport` Linux 用户可 SSH 登录
- root SSH 直登已关闭：`PermitRootLogin no`
- SSH 密码登录已关闭：`PasswordAuthentication no`
- 公钥认证开启：`PubkeyAuthentication yes`
- UFW 已启用
- UFW 当前允许：22/tcp、80/tcp、443/tcp
- 未开放 Fastify 端口 3000
- Node：`v24.20.0`
- npm：`11.19.0`
- PM2：`7.0.4`
- Git：`2.43.0`
- Nginx：`1.24.0 (Ubuntu)`
- Swap：2 GiB，已写入 `/etc/fstab`
- 根盘约 40 GiB，初始化后约 32 GiB 可用
- CPU：2 核
- GitHub Deploy Key 已验证可访问私有仓
- GitHub `git ls-remote git@github.com:acemysickj/lab-report-server.git` 成功

## 3. Linux 用户与权限模型

### root
- 仍然存在，UID 0。
- 不允许公网 SSH 直接登录。
- 需要管理员操作时，由 `labreport` 通过 `sudo` 提权。
- 不要删除 root，也不要为了方便恢复 root SSH。

### labreport
- 应用运行用户 / 日常服务器管理入口。
- 具备 sudo 权限。
- 以后 Fastify / PM2 / Git 拉代码都使用此用户。
- 不要用 root 运行应用。

## 4. SSH：已完成且易踩坑

### 本机 → 阿里云服务器
- Windows 客户端私钥：`C:\Users\<user>\.ssh\id_ed25519`
- 对应公钥已放入：`/home/labreport/.ssh/authorized_keys`
- 当前 PowerShell 已验证可登录 `labreport`。
- `authorized_keys` 必须存真正的 OpenSSH 公钥行，例如 `ssh-ed25519 AAAA...`，不能存 `SHA256:...` 指纹。

### 服务器 → GitHub
- 服务器为 GitHub 私有仓使用独立 deploy key：`~/.ssh/github_deploy`
- 对应公钥已添加到 GitHub repo 的 Deploy Keys
- GitHub deploy key 仅需要读权限，**不要开启 Allow write access**。
- `~/.ssh/config` 应指向该 deploy key，并使用 `IdentitiesOnly yes`。

## 5. 目录约定

服务器已创建：

```text
/srv/lab-report-server
/var/lib/lab-report-server
/var/log/lab-report-server
```

权限已设置为：

```text
/srv/lab-report-server        labreport:labreport
/var/lib/lab-report-server    labreport:labreport
/var/log/lab-report-server    labreport:adm
```

约定：

- `/srv/lab-report-server`：Git 工作树 / 应用代码
- `/var/lib/lab-report-server`：SQLite / 业务持久化数据
- `/var/log/lab-report-server`：应用日志
- SQLite 数据库绝不能进入 Git 仓库

## 6. Nginx / 网络状态

Nginx 已安装并启用，当前仅作为公网 Web 入口的基础设施；业务反向代理尚未配置。

当前预期拓扑：

```text
Internet
  -> :443 Nginx
  -> 127.0.0.1:3000 Fastify
```

约束：

- Fastify 不直接暴露公网。
- 3000 不应加入 UFW 或阿里云安全组。
- 80/443 供 Nginx 使用。
- acme.sh/正式 HTTPS 等待域名与 Fastify 就绪后再做。

## 7. Swap

已创建 2 GiB `/swapfile`：

```text
/swapfile none swap sw 0 0
```

已启用，当前目标 swappiness=10。

## 8. PM2

- 已安装 PM2 7.0.4。
- 已执行 `pm2 startup systemd`，systemd unit 为：`pm2-labreport.service`
- 目前显示 `inactive (dead)` 是因为还没有启动任何 PM2 应用；这不视为故障。
- 在 COM-001 产生真实 Fastify 应用后：
  1. `pm2 start ecosystem.config.cjs`
  2. `pm2 save`
  3. 确认 `pm2-labreport.service` 能在重启后恢复应用

冻结要求：
- 单进程 fork
- `max_memory_restart: 512M`

## 9. 防火墙 / 云安全组

服务器 UFW 当前：

```text
Default: deny (incoming), allow (outgoing)
Allowed: 22/tcp, 80/tcp, 443/tcp
```

阿里云安全组也应保持最小开放面：

```text
22/tcp   SSH
80/tcp   HTTP
443/tcp  HTTPS
```

不要开放：3000、3306、6379、8080 等非必要端口。

当前还需要人工确认/记录：阿里云安全组实际规则是否与上述最小集合完全一致。

## 10. 尚待确认的基础运维项

在 COM-001 正式开始前，检查：

```bash
timedatectl
sudo systemctl status fail2ban --no-pager
sudo fail2ban-client status
sudo systemctl status unattended-upgrades --no-pager
```

目标：
- NTP 时间同步正常
- fail2ban 正常运行并保护 sshd
- unattended-upgrades 正常运行

日志轮转、SQLite 异地备份等属于后续 COM-001/COM-003/COM-005 范畴，不要提前做复杂化。

## 11. 尚未完成的服务器工作

### COM-001 前置
- 检查 NTP
- 检查 fail2ban
- 检查 unattended-upgrades
- 最终确认阿里云安全组

### COM-001
服务器仓库从零建立：
- Fastify 5
- better-sqlite3
- SQLite WAL
- `/health`
- tests
- `ecosystem.config.cjs`

COM-001 明确不碰：
- Auth
- Wallet
- AI Gateway
- Payment
- Electron

### 后续
- COM-002-A：Privacy Foundation
- COM-002：Auth
- COM-003：Wallet / ledger / reservation / idempotency / refund
- COM-004：AI Gateway + SSE + jobId
- COM-005：rate limit + cost metrics + admin
- 最后才接 Electron

## 12. 数据 / Secret 红线

GitHub 私仓严禁提交：
- DeepSeek API Key
- JWT secret
- refresh secret
- `.env`
- SQLite 数据库
- 用户数据

生产 Secret 以后应只存在服务器环境中；具体路径/权限等在 COM-002/COM-004 实施时按架构契约确定。

AI 请求正文严格不得进入：
- application logs
- SQLite
- crash dump / debug dump

## 13. 已知操作事故 / 教训

1. `authorized_keys` 曾误写成公钥指纹 `SHA256:...`，导致 `Permission denied (publickey)`；已修复。以后必须复制完整 `ssh-ed25519 ...` 公钥。
2. 系统升级 openssh-server 时出现 `sshd_config` 配置冲突提示，选择了“keep the local version currently installed”。之后的 SSH 加固通过 `/etc/ssh/sshd_config.d/99-lab-report-hardening.conf` 管理，避免直接覆盖主配置。
3. PM2 systemd unit 当前 `inactive (dead)` 不代表故障；因为暂时没有 PM2 application。
4. 服务器上不要直接用 root 开发/运行应用。

## 14. 当前状态判定

```text
SERVER FOUNDATION
=================
OS / instance          READY
SSH security           READY
labreport user         READY
UFW                    READY
Swap                   READY
Node 24                READY
Git                    READY
GitHub Deploy Key      READY
Nginx                  READY
Production dirs        READY

Operational checks     PENDING
COM-001~003 code (local)  READY（70eb63a/15f542d+0f48b37/bd36dc0）
COM-004 code (local)     MID-FLIGHT（t12 停摆）
Deployment to server    NOT DONE（下一步）
```

## 15. 下一位 agent 的第一动作

不要修改现有 Electron 项目。

先在服务器补做：

```bash
timedatectl
sudo systemctl status fail2ban --no-pager
sudo fail2ban-client status
sudo systemctl status unattended-upgrades --no-pager
```

确认这些后，**部署本地已完成的代码**（非从零建 COM-001）：

```text
1. 本地 D:\Claude Program\开发\lab-report-server git push → acemysickj/lab-report-server（需用户 GitHub 凭据；deploy key 只读仅服务器拉取用）
2. 服务器 labreport@<IP>：git clone/pull 到 /srv/lab-report-server → npm ci --omit=dev
3. DATA_DIR=/var/lib/lab-report-server npm run migrate → pm2 start ecosystem.config.cjs → pm2 save → 验证 pm2-labreport.service 重启恢复
4. 部署对象应为『审过的 COM-004 Gateway』——故代码部署须等 COM-004 完成并过审（t12→t14），先只做 §10 运维检查与 §11 COM-001 前置的服务器侧准备
```

（若接手时 COM-004 已完成：跳过等待，直接按上序部署全套。服务器 IP 未写入本文档，向用户索取。）

---

## suggested skills

如下一位 agent 具有 Skill 调用能力，建议按任务需要调用：

- `deep-research-work`：只有需要核验当前外部文档/官方规格/法律条款时调用。
- 本项目现有 `handoff` skill：用于后续跨 agent 交接时压缩当前进度。
- 若仓库另有项目级 coding/test skill，应优先按 `lab-report-server` 仓库内现有说明调用。