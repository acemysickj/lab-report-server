// src/routes/legal.js — 法务文档路由（COM-002，服务 t2 产出的 docs/legal/*）
// GET /legal/privacy → docs/legal/privacy-policy.md（text/markdown; charset=utf-8）
// GET /legal/terms  → docs/legal/terms-of-service.md
// 原文直出、不做拼装，保证与 P-002 勾选追溯的版本口径同源。
import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_DOCS_DIR } from '../config.js';
import { httpError } from '../lib/http-error.js';

function serveLegalDoc(filename) {
  return (_request, reply) => {
    const file = path.join(LEGAL_DOCS_DIR, filename);
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      throw httpError(404, 'document_not_found', `legal document missing on server: ${filename}`);
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.send(content);
  };
}

export default async function legalRoutes(app) {
  app.get('/legal/privacy', { handler: serveLegalDoc('privacy-policy.md') });
  app.get('/legal/terms', { handler: serveLegalDoc('terms-of-service.md') });
}
