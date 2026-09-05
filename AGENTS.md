# AGENTS.md — lab-report-server agent 操作规程

> 共享规程（双端铁律/平台坑/事故记录/发版 checklist）见客户端同款文件：
> `D:\obsidian\obsidian vault	est\学习记录\实战\实验报告助手pp\AGENTS.md`
> —— 其中「服务端」「GitHub 平台坑」「通用」「事故记录」「服务端发版 checklist」各节对本仓库生效。

## 本仓库特有

- 分层：route(schema 校验) → handler → service → repository；错误统一 `httpError(status, code, message)`。
- 数据库 8 表冻结；改表 = 契约变更，须报用户裁决。
- 铁律引用：P-005（正文不入日志）、P-006（正文不入库/摘要除外）、错误码表见 `docs/COM-004-INTEGRATION.md`。
- 排障入口：`ai_jobs.error_code` → `/api/v1/admin/usage` → `credit_ledger`（顺序见 `docs/INCIDENT-RUNBOOK.md`）。
- 测试：`npm test`（node --test）；绿了才允许 commit；Mimosa 拦截走手动提交（见共享规程铁律 4）。
