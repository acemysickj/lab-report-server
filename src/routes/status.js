// src/routes/status.js — OPS-002 公开服务状态（无鉴权）
// 返回最小状态元数据：api / ai（三态） / version / serverTime。
// ai 探测 = 真实上游最小调用（max_tokens=1），失败/超时 → degraded；密钥缺失 → not_configured。
// 设计边界：无敏感字段（无 token/key/db/env 统计）；不写库；不消耗 AI 限流预算（独立于网关路由）。
import { readFileSync } from 'node:fs';

let cachedPkgVersion = null;
function serverVersion() {
  if (!cachedPkgVersion) {
    try {
      cachedPkgVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null;
    } catch {
      cachedPkgVersion = null;
    }
  }
  return cachedPkgVersion;
}

/** 探测上游可用性：最小补全调用（stream:false, max_tokens:1），5s 超时。返回 'ok' | 'degraded'。 */
async function probeUpstream(transport) {
  try {
    await transport.probe();
    return 'ok';
  } catch {
    return 'degraded';
  }
}

export default async function statusRoutes(app) {
  app.get('/status', {
    handler: async () => {
      let ai = 'ok';
      if (!app.aiTransport || app.aiTransport.available === false) {
        ai = 'not_configured';
      } else {
        // 并发探测加 8s 上限：status 端点自身必须快速返回
        ai = await Promise.race([
          probeUpstream(app.aiTransport),
          new Promise((resolve) => setTimeout(() => resolve('degraded'), 8000)),
        ]);
      }
      return {
        api: 'ok',
        ai,
        version: serverVersion(),
        serverTime: new Date().toISOString(),
      };
    },
  });
}
