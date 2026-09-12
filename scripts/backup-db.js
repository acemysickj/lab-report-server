// scripts/backup-db.js — SQLite 在线热备 + 轮转 + 完整性校验（COM-005 运维 / BKP-001）
// 用法：
//   node scripts/backup-db.js [--out <目录>] [--keep <份数>]
// 默认：DATA_DIR 取运行环境（生产 /srv/lab-report-server/data），输出 /var/lib/lab-report-server/backups，
// 保留最近 14 份（BKP-001：≥14 天滚动）。cron 建议：每天一次（见 docs/DEPLOY.md §6）。
// 使用 better-sqlite3 在线 backup API：WAL 库不锁库、备份即一致性快照。
// BKP-001：备份后立即 PRAGMA integrity_check + 表计数——坏档当场发现、以非零码告警，不静默堆积。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDataDir, DB_FILENAME } from '../src/db.js';

const BACKUP_FILENAME_PREFIX = 'lab-report-server-';
export const BACKUP_KEEP_DEFAULT = 14; // BKP-001：≥14 天滚动

/** 备份文件可用性验证：integrity_check 必须为 ok + sqlite_master 可读。返回表清单。 */
export function verifyBackupFile(destPath) {
  const db = new Database(destPath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true }); // 'ok' 或错误行
    if (integrity !== 'ok') {
      throw new Error(`integrity_check 失败：${integrity}`);
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    return { integrity, tableCount: tables.length, tables };
  } finally {
    db.close();
  }
}

export async function backupDatabase({ dataDir, outDir, keep = BACKUP_KEEP_DEFAULT, now = new Date() } = {}) {
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

  const verification = verifyBackupFile(dest); // 坏档当场发现（integrity_check 非 ok 抛错）
  const rotated = rotateOld(destDir, keep);
  return { dest, size: fs.statSync(dest).size, removed: rotated, verification };
}

/** 按 mtime 保留最新 keep 份（含本次），更旧的删除。返回删除数。 */
function rotateOld(destDir, keep) {
  // 文件名含 UTC 时间戳（字典序即时间序），按名排序避免 mtime 精度抖动
  const backups = fs
    .readdirSync(destDir)
    .filter((f) => f.startsWith(BACKUP_FILENAME_PREFIX) && f.endsWith('.db'))
    .sort()
    .reverse();
  let removed = 0;
  for (let i = keep; i < backups.length; i++) {
    fs.unlinkSync(path.join(destDir, backups[i]));
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
    keep: keepIdx >= 0 ? Number.parseInt(args[keepIdx + 1], 10) : BACKUP_KEEP_DEFAULT,
  })
    .then((r) => {
      console.log(
        `备份完成: ${r.dest}（${(r.size / 1024).toFixed(1)} KiB），完整性 ok（${r.verification.tableCount} 张表），轮转删除 ${r.removed} 份旧备份`
      );
    })
    .catch((e) => {
      console.error('备份失败:', e.message);
      process.exit(1);
    });
}
