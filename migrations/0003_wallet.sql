-- migrations/0003_wallet.sql — COM-003 钱包
-- 幂等重放需要落一个稳定的结果引用（如 jobId/reservationId），供同键重复请求返回同一结果。
-- 列加在冻结表 idempotency_keys 上（与 0002 同模式：冻结表集合不变，字段合理最小补充）。
ALTER TABLE idempotency_keys ADD COLUMN result_ref TEXT;
