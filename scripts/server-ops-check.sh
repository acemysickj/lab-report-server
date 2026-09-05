#!/usr/bin/env bash
# scripts/server-ops-check.sh — 服务器运维自检（在【服务器】上以 labreport 用户执行）
# 用法：bash scripts/server-ops-check.sh
# 覆盖交接文档「尚需核对」项：NTP / fail2ban / unattended-upgrades / UFW / 磁盘 / 备份 / 配置权限 / 代码版本。
# 每项输出 ✓ / ✗ / !（需人工确认），退出码 0=全部 ✓，1=存在 ✗。
set -uo pipefail
FAIL=0
ok()   { echo "✓ $1"; }
bad()  { echo "✗ $1"; FAIL=1; }
warn() { echo "! $1（需人工确认）"; }

echo "==== lab-report-server 运维自检 $(date '+%F %T %Z') ===="

# 1. 时钟同步（NTP）
if timedatectl show 2>/dev/null | grep -q "NTPSynchronized=yes"; then
  ok "NTP 时钟已同步"
else
  bad "NTP 未同步：sudo timedatectl set-ntp true"
fi

# 2. fail2ban + sshd jail
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  if sudo fail2ban-client status sshd 2>/dev/null | grep -q " Jail "; then
    ok "fail2ban 运行中（含 sshd jail）"
  else
    warn "fail2ban 运行但未见 sshd jail：sudo fail2ban-client status"
  fi
else
  bad "fail2ban 未运行：sudo apt install fail2ban && sudo systemctl enable --now fail2ban"
fi

# 3. unattended-upgrades（自动安全更新）
if dpkg -s unattended-upgrades 2>/dev/null | grep -q "Status: install ok installed"; then
  ok "unattended-upgrades 已安装"
else
  bad "unattended-upgrades 未安装：sudo apt install unattended-upgrades"
fi

# 4. SSH 加固（root 直登 / 密码登录）
if sudo sshd -T 2>/dev/null | grep -qi "permitrootlogin no"; then
  ok "SSH root 直登已禁止"
else
  bad "SSH PermitRootLogin 未禁用"
fi
if sudo sshd -T 2>/dev/null | grep -qi "passwordauthentication no"; then
  ok "SSH 密码登录已关闭"
else
  bad "SSH 密码登录未关闭"
fi

# 5. UFW
if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  ok "UFW active：$(sudo ufw status 2>/dev/null | grep -E 'ALLOW' | tr '\n' ' ')"
else
  bad "UFW 未启用"
fi

# 6. 阿里云安全组（OS 层无法直查——给出提示）
warn "阿里云安全组请在控制台核对：入方向仅 22/80/443"

# 7. 应用状态
if pm2 describe lab-report-server 2>/dev/null | grep -q "online"; then
  ok "PM2 lab-report-server online"
else
  bad "PM2 lab-report-server 非 online：pm2 list"
fi
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/health 2>/dev/null)
if [ "$HEALTH" = "200" ]; then ok "本地 /health 200"; else bad "本地 /health 返回 $HEALTH"; fi

# 8. 数据目录与 .env 权限
if [ -f /srv/lab-report-server/.env.production ]; then
  PERM=$(stat -c '%a' /srv/lab-report-server/.env.production)
  if [ "$PERM" = "600" ]; then ok ".env.production 权限 600"; else bad ".env.production 权限 $PERM（应为 600）"; fi
else
  bad "缺少 /srv/lab-report-server/.env.production"
fi

# 9. 备份
BAK_DIR=${BACKUP_DIR:-/var/backups/lab-report-server}
if [ -d "$BAK_DIR" ] && ls "$BAK_DIR"/lab-report-server-*.db >/dev/null 2>&1; then
  LATEST=$(ls -t "$BAK_DIR"/lab-report-server-*.db | head -1)
  AGE=$(( ($(date +%s) - $(stat -c '%Y' "$LATEST")) / 3600 ))
  ok "最近备份：$LATEST（${AGE} 小时前）"
  if [ "$AGE" -gt 48 ]; then bad "备份超过 48 小时未更新——检查 cron"; fi
else
  bad "无备份（$BAK_DIR）：node scripts/backup-db.js + cron（见 docs/DEPLOY.md §6）"
fi

# 10. 磁盘
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -lt 80 ]; then ok "根分区使用率 ${DISK_PCT}%"; else bad "根分区使用率 ${DISK_PCT}%（≥80%）"; fi

# 11. 代码版本与远端
cd /srv/lab-report-server 2>/dev/null || { bad "/srv/lab-report-server 不存在"; exit 1; }
git fetch --quiet origin 2>/dev/null
LOCAL=$(git rev-parse --short HEAD)
REMOTE=$(git rev-parse --short origin/master 2>/dev/null)
if [ "$LOCAL" = "$REMOTE" ]; then ok "代码与远端同步（$LOCAL）"; else bad "代码落后远端：本地 $LOCAL / 远端 $REMOTE"; fi

echo "==== 自检结束（FAIL=$FAIL）===="
exit $FAIL
