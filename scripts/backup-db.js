// scripts/backup-db.js — SQLite 在线热备 + 轮转（COM-005 运维）
// 用法：
//   node scripts/backup-db.js [--out <目录>] [--keep <份数>]
// 默认：DATA_DIR 取运行环境（生产 /var/lib/lab-report-server），输出 /var/backups/lab-report-server，
// 保留最近 7 份。cron 建议：每天一次（见 docs/DEPLOY.md §6）。
// 使用 better-sqlite3 在线 backup API：WAL 库不锁库、备份即一致性快照。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDataDir, DB_FILENAME } from '../src/db.js';

const BACKUP_FILENAME_PREFIX = 'lab-report-server-';

export async function backupDatabase({ dataDir, outDir, keep = 7, now = new Date() } = {}) {
  const srcPath = path.join(resolveDataDir(dataDir), DB_FILENAME);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`源数据库不存在：${srcPath}`);
  }
  const destDir = outDir ?? process.env.BACKUP_DIR ?? '/var/lib/lab-report-server/backups';  // labreport 可写，无需 sudo
  fs.mkdirSync(destDir, { recursive: true });

  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS（UTC）
  const dest = path.join(destDir, `${BACKUP_FILENAME_PREFIX}${stamp}.db`);

  const src = new Database(srcPath, { readonly: true });
  try {
    await src.backup(dest); // 在线备份：一致性快照，不阻塞生产连接
  } finally {
    src.close();
  }

  const rotated = rotateOld(destDir, keep);
  return { dest, size: fs.statSync(dest).size, removed: rotated };
}

/** 按 mtime 保留最新 keep 份（含本次），更旧的删除。返回删除数。 */
function rotateOld(destDir, keep) {
  const backups = fs
    .readdirSync(destDir)
    .filter((f) => f.startsWith(BACKUP_FILENAME_PREFIX) && f.endsWith('.db'))
    .map((f) => ({ f, m: fs.statSync(path.join(destDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  let removed = 0;
  for (let i = keep; i < backups.length; i++) {
    fs.unlinkSync(path.join(destDir, backups[i].f));
    removed += 1;
  }
  return removed;
}

// CLI 入口（被 import 时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const keepIdx = args.indexOf('--keep');
  backupDatabase({
    outDir: outIdx >= 0 ? args[outIdx + 1] : undefined,
    keep: keepIdx >= 0 ? Number.parseInt(args[keepIdx + 1], 10) : 7,
  })
    .then((r) => {
      console.log(`备份完成: ${r.dest}（${(r.size / 1024).toFixed(1)} KiB），轮转删除 ${r.removed} 份旧备份`);
    })
    .catch((e) => {
      console.error('备份失败:', e.message);
      process.exit(1);
    });
}
