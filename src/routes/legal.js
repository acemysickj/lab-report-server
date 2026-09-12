// src/routes/legal.js — 法务文档路由（COM-002，服务 docs/legal/*）
// DOM-003：浏览器渲染 HTML（内置极简转换器，风格与下载页统一，页脚备案号）。
// 前置已确认：客户端消费路径仅 renderer.js openExternal（系统浏览器打开），
// 无 fetch /legal 解析 raw markdown 的代码路径（product 指示下排查，2026-09-13）。
// ?format=raw 保留 markdown 直出（调试/比对用；Content-Type text/markdown）。
import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_DOCS_DIR } from '../config.js';
import { httpError } from '../lib/http-error.js';
import { markdownToHtml } from '../lib/markdown-lite.js';

const ICP_NUMBER = '粤ICP备2026135392号';

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "SF Pro SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1d1d1f; background: #fbfbfd; -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  main { flex: 1; max-width: 720px; margin: 0 auto; padding: 56px 24px 48px; line-height: 1.8; font-size: 15px; }
  h1 { font-size: 30px; letter-spacing: -0.01em; margin: 8px 0 24px; }
  h2 { font-size: 20px; margin: 36px 0 12px; }
  h3 { font-size: 17px; margin: 28px 0 10px; }
  p { margin: 10px 0; }
  ul, ol { margin: 10px 0 10px 22px; }
  li { margin: 4px 0; }
  blockquote { border-left: 3px solid #d2d2d7; padding: 4px 14px; margin: 14px 0; color: #6e6e73; background: #f5f5f7; border-radius: 0 8px 8px 0; }
  code { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; background: #f5f5f7; padding: 2px 6px; border-radius: 6px; }
  a { color: #06c; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid #e8e8ed; margin: 24px 0; }
  footer { border-top: 1px solid #e8e8ed; padding: 20px 24px; text-align: center; font-size: 12px; color: #86868b; }
  footer a { color: #86868b; }
  footer a:hover { text-decoration: underline; }
`;

function renderPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${bodyHtml}
</main>
<footer>© 2026 实验报告助手 · <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${ICP_NUMBER}</a></footer>
</body>
</html>
`;
}

function readLegalDoc(filename) {
  const file = path.join(LEGAL_DOCS_DIR, filename);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw httpError(404, 'document_not_found', `legal document missing on server: ${filename}`);
  }
}

function serveLegalDoc(filename, title) {
  return (request, reply) => {
    const markdown = readLegalDoc(filename);
    if (request.query?.format === 'raw') {
      reply.header('content-type', 'text/markdown; charset=utf-8');
      return reply.send(markdown);
    }
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(renderPage(title, markdownToHtml(markdown)));
  };
}

export default async function legalRoutes(app) {
  app.get('/legal/privacy', { handler: serveLegalDoc('privacy-policy.md', '隐私政策 — 实验报告助手') });
  app.get('/legal/terms', { handler: serveLegalDoc('terms-of-service.md', '服务协议 — 实验报告助手') });
  app.get('/legal/account-deletion', { handler: serveLegalDoc('account-deletion.md', '删除账号机制说明 — 实验报告助手') });
}
