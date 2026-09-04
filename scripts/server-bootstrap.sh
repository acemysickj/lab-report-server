#!/usr/bin/env bash
# scripts/server-bootstrap.sh — 服务器侧一键部署/升级（在【服务器】上以 labreport 用户执行）
# 用法：
#   TAG=v0.10.1 bash scripts/server-bootstrap.sh
# 前置（一次性，见 docs/SERVER-HANDOFF-v0.10.0.md）：
#   /srv/lab-report-server 工作树 + deploy key（只读）+ Node 24 + PM2 + Nginx 已就绪。
# 环境变量：本脚本读取 /srv/lab-report-server/.env.production（不存在则生成骨架后退出，
#   由操作者填入 AUTH_JWT_SECRET / DEEPSEEK_API_KEY / ADMIN_TOKEN 后重跑）。
#   该文件只存服务器，绝不入库（.gitignore 已含 .env*）。
set -euo pipefail

TAG="${TAG:-v0.10.1}"
ROOT="/srv/lab-report-server"
ENV_FILE="$ROOT/.env.production"

cd "$ROOT"

# ---- 1. 环境变量文件（首次生成骨架）----
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# 生产环境变量（本文件不入 git；权限 600）
AUTH_JWT_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 24)
DEEPSEEK_API_KEY=sk-在这里填入服务器专用key
DATA_DIR=$ROOT/data
EOF
  chmod 600 "$ENV_FILE"
  echo "==> 已生成 $ENV_FILE 骨架。请填入真实 DEEPSEEK_API_KEY 后重新执行本脚本。"
  exit 1
fi
echo "==> 1/6 环境变量文件 OK（DATA_DIR/AUTH_JWT_SECRET/ADMIN_TOKEN/DEEPSEEK_API_KEY）"

# ---- 2. 拉取并检出 tag（部署纪律：生产必须打 tag）----
git fetch --tags origin
git checkout "$TAG"
echo "==> 2/6 代码检出 $TAG（$(git rev-parse --short HEAD)）"

# ---- 3. 依赖 ----
npm ci --omit=dev
echo "==> 3/6 依赖安装 OK（ignore-scripts，better-sqlite3 prebuild）"

# ---- 4. 测试（全绿才继续）----
npm test
echo "==> 4/6 测试全绿"

# ---- 5. 迁移 ----
set -a; source "$ENV_FILE"; set +a
npm run migrate
echo "==> 5/6 迁移完成（_migrations 台账幂等）"

# ---- 6. PM2 启动/重载 + 健康检查 ----
if pm2 describe lab-report-server > /dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
  pm2 save
fi
sleep 2
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
if [ "$HEALTH" = "200" ]; then
  echo "==> 6/6 /health 200 — 部署成功 ✔"
  echo "    后续：Nginx 反代见 docs/DEPLOY.md §2；验收清单见 §4"
else
  echo "!! /health 返回 $HEALTH — 检查 pm2 logs lab-report-server"
  exit 1
fi
