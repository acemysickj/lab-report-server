// scripts/admin-gui.mjs — 运营者本地管理页（COM-005 极简 Admin 的图形壳）
// 用法：node scripts/admin-gui.mjs [server-url]  → 自动打开浏览器（建议配合 发额度.bat 双击使用）
// 安全口径：本地服务只绑 127.0.0.1；ADMIN_TOKEN 存在运营者浏览器 localStorage，不出本机；
// 页面 → 本地服务 → 平台 admin API 的纯转发，无任何持久化。
import http from 'node:http';
import { exec } from 'node:child_process';
import { grantRemote } from './admin-grant.mjs';

function page(serverUrl) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>发额度 · 实验报告助手</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; background:#f5f6fa; margin:0; padding:32px; }
  .card { max-width:520px; margin:0 auto; background:#fff; border:1px solid #d9dbe4; border-radius:12px; padding:24px 28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#6b7280; font-size:12px; margin-bottom:16px; }
  label { display:block; font-size:13px; margin:12px 0 4px; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:9px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; }
  .tiers { display:flex; gap:8px; margin-top:4px; }
  .tiers label { flex:1; border:1px solid #d1d5db; border-radius:8px; padding:10px; text-align:center; cursor:pointer; margin:0; }
  .tiers input { margin-right:4px; }
  .tiers b { display:block; }
  .tiers span { color:#6b7280; font-size:12px; }
  button { width:100%; margin-top:16px; padding:11px; background:#2563eb; border:0; border-radius:8px; color:#fff; font-size:15px; cursor:pointer; }
  button:disabled { background:#9ca3af; cursor:default; }
  .result { margin-top:14px; padding:10px 12px; border-radius:8px; font-size:14px; display:none; }
  .result.ok { background:#ecfdf5; color:#065f46; }
  .result.err { background:#fef2f2; color:#991b1b; }
  .hint { color:#9ca3af; font-size:12px; margin-top:14px; }
</style>
</head>
<body>
<div class="card">
  <h1>发额度</h1>
  <div class="sub">目标服务器：${serverUrl}（人工确认微信到账后再发放）</div>
  <label>ADMIN_TOKEN（保存在本浏览器，不清除）</label>
  <input type="password" id="token" placeholder="只存本机 localStorage">
  <label>用户注册邮箱</label>
  <input type="text" id="email" list="knownEmails" placeholder="用户注册时使用的邮箱">
  <datalist id="knownEmails"></datalist>
  <label>档位</label>
  <div class="tiers">
    <label><input type="radio" name="tier" value="tier_9_9"><b>¥9.9</b><span>100 额度</span></label>
    <label><input type="radio" name="tier" value="tier_29_9"><b>¥29.9</b><span>350 额度</span></label>
    <label><input type="radio" name="tier" value="tier_49_9" checked><b>¥49.9（主推）</b><span>700 额度</span></label>
  </div>
  <button id="grantBtn">确认发放</button>
  <div class="result" id="result"></div>
  <div class="hint">发放前请已在微信确认到账。本页面只在本机 127.0.0.1 运行，用完关闭窗口即可。</div>
</div>
<script>
  const tokenEl = document.getElementById("token");
  tokenEl.value = localStorage.getItem("adminToken") || "";
  tokenEl.addEventListener("change", function () { localStorage.setItem("adminToken", tokenEl.value); });
  fetch("/api/users?token=" + encodeURIComponent(tokenEl.value)).then(r => r.json()).then(function (d) {
    if (!d.users) return;
    const dl = document.getElementById("knownEmails");
    d.users.forEach(function (u) {
      const o = document.createElement("option");
      o.value = u.email;
      o.label = u.email + "（余额 " + u.balance + "）";
      dl.appendChild(o);
    });
  }).catch(function () {});
  document.getElementById("grantBtn").addEventListener("click", async function () {
    const btn = this, box = document.getElementById("result");
    box.className = "result"; box.style.display = "block";
    box.textContent = "发放中…";
    btn.disabled = true;
    try {
      localStorage.setItem("adminToken", tokenEl.value);
      const res = await fetch("/api/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: tokenEl.value,
          email: document.getElementById("email").value.trim(),
          tier: document.querySelector('input[name=tier]:checked').value
        })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "HTTP " + res.status);
      box.className = "result ok";
      box.textContent = "✔ 已发放 " + d.credits + " 额度，" + d.email + " 当前余额 " + d.balance + (d.replayed ? "（重复请求，未重复发放）" : "");
    } catch (e) {
      box.className = "result err";
      box.textContent = "✗ " + (e.message || "发放失败");
    } finally { btn.disabled = false; }
  });
</script>
</body>
</html>`;
}

/** 创建本地管理服务。返回 http.Server（测试用）。 */
export function createGuiServer({ serverUrl, port = 8765, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(serverUrl));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/users')) {
        // 最近注册用户（便于选择邮箱）——令牌由页面从 localStorage 随查询参数提供
        const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
        const r = await fetch(serverUrl.replace(/\/+$/, '') + '/api/v1/admin/users?limit=10', {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await r.json().catch(() => ({}));
        return json(r.ok ? 200 : 502, r.ok ? body : { error: body?.error?.message || '获取失败' });
      }
      if (req.method === 'POST' && req.url === '/api/grant') {
        let body = '';
        for await (const c of req) body += c;
        const { token, email, tier } = JSON.parse(body || '{}');
        const out = await grantRemote({ serverUrl, token, email, tier });
        return json(200, out);
      }
      json(404, { error: 'not found' });
    } catch (e) {
      json(502, { error: e.message || '转发失败' });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  (async () => {
    const serverUrl = (process.argv[2] || 'http://120.79.10.96').trim().replace(/\/+$/, '');
    const server = await createGuiServer({ serverUrl, port: 8765, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const open = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(open);
    console.log('管理页已打开：' + url + '（目标服务器 ' + serverUrl + '）');
    console.log('用完直接关闭本窗口即可。');
  })();
}
