// src/lib/env-file.js — .env 文件原子更新（KEY=VALUE 行级 upsert）
// 用于 BK-006 限流热配置持久化到 .env.production。
// 安全：只修改指定 key，其余行原样保留；tmp + rename 原子写入；文件权限 0600（含 secret）。
import fs from 'node:fs';
import path from 'node:path';

const ENV_LINE_RE = /^\s*([A-Z_][A-Z0-9_]*)\s*=/;

/**
 * 原子更新 .env 文件中的 KEY=VALUE 行。
 * - 已存在的 key → 替换值（保留行内注释？不保留——KEY=VALUE 行整体替换，避免值歧义）
 * - 不存在的 key → 追加到文件末尾（前补空行分隔）
 * - 文件不存在 → 创建
 * - 写入用 tmp + rename 保证原子性；tmp 权限 0600（与 .env.production 含 secret 的安全口径一致）
 * @param {string} filePath - .env 文件绝对路径
 * @param {Record<string, string|number>} updates - key→value 映射
 * @returns {{ ok: true }} 成功
 * @throws 写入/重命名失败时抛出（调用方决定降级策略）
 */
export function upsertEnvFile(filePath, updates) {
  const lines = [];
  const seen = new Set();
  let hadTrailingNewline = true;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    hadTrailingNewline = content.length === 0 || content.endsWith('\n');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(ENV_LINE_RE);
      if (m && updates[m[1]] !== undefined) {
        lines.push(`${m[1]}=${updates[m[1]]}`);
        seen.add(m[1]);
      } else {
        lines.push(line);
      }
    }
  } catch {
    // 文件不存在或不可读 → 从空文件开始（后续创建）
  }

  // 追加新 key
  const appended = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) appended.push(`${key}=${value}`);
  }
  if (appended.length > 0) {
    // 去掉末尾空行后加一个空行分隔，再追加
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('');
    lines.push(...appended);
  }

  const out = lines.join('\n').replace(/\n+$/, '') + '\n';

  // 原子写入：tmp（0600）→ rename
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, out, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return { ok: true };
}
