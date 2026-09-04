// src/app.js — Fastify application factory (COM-001 skeleton)
// 契约：Fastify 只监听 127.0.0.1（见 src/server.js）；GET /health → 200 {"status":"ok"}。
import Fastify from 'fastify';
import { openDatabase } from './db.js';

/** Build the Fastify app. Options: { dataDir?, db?, logger? }. Pass db to reuse a connection (tests). */
export async function buildApp(options = {}) {
  const db = options.db ?? openDatabase({ dataDir: options.dataDir });
  const app = Fastify({ logger: options.logger ?? false });
  app.decorate('db', db);

  app.get('/health', async () => ({ status: 'ok' }));

  app.addHook('onClose', async () => {
    if (db.open) db.close();
  });
  return app;
}
