# STATE SYNC — lab-report-server 双会话合并（代码侧 × 服务器侧）

> 生成：分叉会话 2026-09-04｜用途：主会话直接读取，消除两侧信息差
> 输入：SERVER-HANDOFF-v0.10.0.md（服务器基建交接，Downloads）+ 主会话既有状态（AgentTeams lab-report-commercial 全历史）

## 1. 一句话合并结论

**代码侧（本地 Windows）已做到 COM-004 中途；服务器侧（阿里云深圳）基建全部 READY 但代码零部署。** 两侧不冲突——"COM-001 NOT STARTED"（服务器交接文档）指"代码尚未部署上服务器"，不是代码缺失。

## 2. 代码侧状态（本地，D:\Claude Program\开发\lab-report-server）

| COM | 状态 | commit | 证据 |
|---|---|---|---|
| COM-001 骨架 | ✅ | 70eb63a | health/WAL/8 表/PM2 配置，npm test 6/6 |
| COM-002-A 隐私四件套 | ✅ | docs/legal/ 5 文件 | 40/40 校验，占位符 4 项待审定 |
| COM-002 Auth | ✅ | 15f542d + repair 0f48b37 | 19/19，rotation/复用检测/注销 P-007 |
| COM-003 钱包 | ✅ | bd36dc0 | 28/28，账本/幂等/注销收尾 |
| COM-004 Gateway | ⏸ 中途停摆 | t12 in_progress | 3 待决点已存档 docs/COM-004-PENDING-DECISIONS.md |

- 队伍 lab-report-commercial **已于 2026-09-04 解散**（用户拍板，非停摆）；v0.10 进度全部留存于契约与下述引用文件。
- **组队路由铁律（用户拍板，下次组队必须遵守）**：glm-5.3-flash = 主力干活（engineer/实现/执行/验证）；glm-5.3（pro）= 大脑（架构/设计/审查/判断，按需少量）；mimo = 纯机械单步；**禁用 DeepSeek 路由**。教训：本批把 glm-5.3 派到 engineer 实现位浪费额度，实现一律 flash。
- 客户端 app v0.9.6 已交付验收（462 测试），v0.10.0 为下一版本号。

## 3. 服务器侧状态（阿里云深圳，从 SERVER-HANDOFF 吸收）

**全部 READY**：OS Ubuntu 24.04 LTS（2C2G/40GB/2GiB swap）；SSH 加固（labreport 用户 sudo、root 直登关、密码登录关、公钥开）；UFW=22/80/443 only（**3000 不开**）；Node 24.20.0 / npm 11.19.0 / PM2 7.0.4（unit pm2-labreport.service 已装，首次 pm2 start 后 save+验证自启）/ Git 2.43.0 / Nginx 1.24.0；GitHub deploy key（只读）已验证 git ls-remote 私有仓成功；目录约定 /srv/lab-report-server（代码）/var/lib/lab-report-server（SQLite）/var/log/lab-report-server（日志），owner labreport。

**SSH 通道**：Windows 本机私钥 C:\Users\<user>\.ssh\id_ed25519 → labreport@<服务器IP>（IP 未写入交接文档，需向用户索取）。

**PENDING（服务器侧待办，按序）**：
1. 运维检查：timedatectl；systemctl status fail2ban + fail2ban-client status；systemctl status unattended-upgrades；核对阿里云安全组=22/80/443 最小集；
2. 代码部署（= 交接文档所称"COM-001 server-side"）：本地 push 到 acemysickj/lab-report-server（**需用户 GitHub 凭据**，deploy key 是只读的）→ 服务器 labreport 下 clone/pull 到 /srv/lab-report-server → npm ci --omit=dev → npm run migrate（DATA_DIR=/var/lib/lab-report-server）→ pm2 start ecosystem.config.cjs → pm2 save → 验证 pm2-labreport.service 重启恢复；
3. Nginx site 配置 + acme.sh HTTPS：**等域名+ICP 备案**（用户动作）后做；Fastify 只监听 127.0.0.1:3000，不进 UFW/安全组。

## 4. 红线（两侧一致，代码已落实）

- GitHub 私仓禁提交：DeepSeek key/JWT secret/refresh secret/.env/SQLite/用户数据（服务器本地已配 .npmrc ignore-scripts=true 避 node-gyp；deploy key 只读）；
- AI 请求正文永不进 logs/SQLite/dump（代码层三断言已进 COM-004 acceptance，恢复后完成）；
- Fastify 不暴露公网；3000 不进防火墙/安全组。

## 5. 待用户完成的外部动作（主会话催办）

1. 服务器 IP / 域名购买 + ICP 备案（深圳服务器用域名必须备案）；
2. lab-report-server 本地→GitHub push（acemysickj 凭据）；
3. DeepSeek 个人 key（服务器专用）+ 充值；
4. 法律占位符 4 项审定（运营者名称/联系邮箱/生效日期/运营者所在地）+ 3 处〔运营确认〕；
5. v0.9.6 三件套上传 GitHub Release（已 staged）；
6. H1 TinyTeX 真实哈希 pin（发行前）；M2 代码签名证书（商业化前）。

## 6. 引用文件

- 本文件：C:\Users\toby1\Downloads\SERVER-STATE-SYNC-v0.10.0.md
- SERVER-HANDOFF-v0.10.0.md（服务器基建交接全文，Downloads）
- COMMERCIAL-CORE-ARCHITECTURE-v1.md（架构基线，Downloads——与仓库 docs/COM-CONTRACT.md 同源不同文；**冲突时以用户已批准的仓库 COM-CONTRACT.md 为准**，除非用户明确改判）
- 仓库 docs/COM-CONTRACT.md（冻结契约，唯一权威）
- 仓库 docs/COM-004-PENDING-DECISIONS.md（3 待决点）
- 主会话交接：C:\Users\toby1\AppData\Local\Temp\handoff-lab-report-commercial-2026-09-04.md

## 7. 主会话恢复后的首个动作建议

1. **重新组队（按路由铁律：engineer/verifier=glm-5.3-flash、reviewer/designer=glm-5.3、机械位=mimo；不用 DeepSeek）** → 完成 t12（先裁决 COM-004-PENDING-DECISIONS 三点：①SSE 出路 A ②payload 白名单 ③断线续存）→ t13/t14 合并轮 → t15 客户端 → t16 → t17 集成（此时带上服务器部署步骤，DEPLOY.md 可基于本同步文档 §3 写成真实可执行）→ t18；额度紧张，全程压缩模式（报告≤10 行、verify+review 合并单轮、只看增量）。
2. 运维检查与部署前置（§3.1-3.2）可并行推进，但**代码部署须等 t12/t13/t14 之后**（服务器上跑的应是审过的 Gateway）。