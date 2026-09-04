// ecosystem.config.cjs — PM2 进程定义（契约：单进程 fork / max_memory_restart 512M / autorestart）
// 注意：package.json 为 ESM（type: module），故 PM2 配置使用 .cjs 扩展名。
module.exports = {
  apps: [
    {
      name: 'lab-report-server',
      script: 'src/server.js',
      exec_mode: 'fork',   // 单实例 fork，禁止 cluster（SQLite 单写者 + 契约要求）
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',   // 契约：只监听 127.0.0.1，不暴露公网（Nginx 在前）
        PORT: '3000',
        DATA_DIR: './data',
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
