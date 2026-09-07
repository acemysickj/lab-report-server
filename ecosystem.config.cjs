// ecosystem.config.cjs — PM2 进程定义（契约：单进程 fork / max_memory_restart 512M / autorestart）
// 注意：package.json 为 ESM（type: module），故 PM2 配置使用 .cjs 扩展名。
//
// .env.production 加载：PM2 reload --update-env 只继承当前 shell 的 env，不会读 .env.production。
// 此处在配置求值时主动解析该文件（KEY=VALUE 行），注入 env 块——文件不存在则跳过（本地开发）。
const fs = require('fs');
const path = require('path');
function loadEnvProduction() {
  // 绝对路径：PM2 daemon 求值配置时的 cwd 不可靠，禁止依赖相对路径
  const envFile = '/srv/lab-report-server/.env.production';
  const env = {};
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    console.log('[ecosystem] .env.production loaded:', Object.keys(env).join(', '));
  } catch (e) {
    console.log('[ecosystem] .env.production not readable:', e.message);
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: 'lab-report-server',
      script: 'src/server.js',
      exec_mode: 'fork',   // 单实例 fork，禁止 cluster（SQLite 单写者 + 契约要求）
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: Object.assign({
        NODE_ENV: 'production',
        HOST: '127.0.0.1',   // 契约：只监听 127.0.0.1，不暴露公网（Nginx 在前）
        PORT: '3000',
        DATA_DIR: './data',
        // AUTH_JWT_SECRET / DEEPSEEK_API_KEY / ADMIN_TOKEN / BYOK_ALLOWLIST 等
        // 由 .env.production 注入（本文件上方 loadEnvProduction() 读取）
      }, loadEnvProduction()),
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
