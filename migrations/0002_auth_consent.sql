-- migrations/0002_auth_consent.sql — COM-002 Auth
-- P-002（契约 docs/COM-CONTRACT.md + docs/legal/registration-summary.md）：
--   注册勾选状态服务器可追溯——所同意的政策版本与勾选时间持久化。
--   列加在冻结表 users 上（8 张冻结表集合不变，属「契约要点+合理最小集」的字段补充）。
--   注销（P-007）时这些列【保留】作为合规留痕，仅脱敏身份字段。
ALTER TABLE users ADD COLUMN privacy_consented_at   TEXT;
ALTER TABLE users ADD COLUMN terms_consented_at     TEXT;
ALTER TABLE users ADD COLUMN privacy_policy_version TEXT;
ALTER TABLE users ADD COLUMN terms_version          TEXT;
