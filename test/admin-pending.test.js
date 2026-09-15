// test/admin-pending.test.js — PROMO-001 对账名单划分逻辑（纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUsers } from '../scripts/admin-pending.mjs';

test('classifyUsers：注册未付费 / 付费在用 两侧划分正确', () => {
  const users = [
    { id: 3, email: 'new@test.dev', balance: 0, purchaseCount: 0, created_at: '2026-09-14T10:00:00Z', lastActivityAt: null },
    { id: 2, email: 'used@test.dev', balance: 35, purchaseCount: 2, created_at: '2026-09-10T08:00:00Z', lastActivityAt: '2026-09-14T09:00:00Z' },
    { id: 1, email: 'spent@test.dev', balance: 0, purchaseCount: 1, created_at: '2026-09-09T08:00:00Z', lastActivityAt: '2026-09-13T09:00:00Z' },
  ];
  const { pendingPay, paying } = classifyUsers(users);
  assert.equal(pendingPay.length, 1);
  assert.equal(pendingPay[0].email, 'new@test.dev');
  assert.equal(paying.length, 2, '余额 0 但有流水 = 付了在用（花完了）');
  assert.equal(paying[0].email, 'used@test.dev', '按最近活动倒序');
  assert.equal(paying[1].balance, 0);
});
