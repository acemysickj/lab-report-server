// src/server.js — process entry (npm start / PM2)
// 契约：Fastify 只监听 127.0.0.1，不暴露公网（Nginx 反向代理 + acme.sh HTTPS 在前）。
import { buildApp } from './app.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0)).catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
  });
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
