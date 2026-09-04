// src/lib/argon.js — 密码哈希（COM-002 Auth）
// 选型说明（契约要求 Argon2id，禁 SHA256/MD5/bcrypt）：
//   @node-rs/argon2 = Rust argon2 的 napi-rs 绑定，npm 包经 optionalDependencies
//   分发全平台预编译二进制（win32-x64 含在内），无 install 脚本，与本仓库
//   .npmrc ignore-scripts=true 兼容，也不需要 MSVC 工具链；算法实现为成熟的
//   rustcrypto/argon2。参数取 OWASP argon2id 基线：m=19456 KiB, t=2, p=1。
import { hash, verify, Algorithm } from '@node-rs/argon2';

const ARGON2ID_OPTIONS = {
  algorithm: Algorithm.Argon2id, // 契约指定；显式固定，不随库默认漂移
  memoryCost: 19456,             // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password) {
  return hash(password, ARGON2ID_OPTIONS);
}

/** Verify a password against a stored hash. Invalid/unusable stored hashes (e.g. 已注销用户) → false. */
export async function verifyPassword(storedHash, password) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    return false; // 损坏/非 argon2 串一律按不匹配处理
  }
}
