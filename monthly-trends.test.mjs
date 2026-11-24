import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTrends } from '../mobile/src/monthlyBalance.ts';

test('trends produce twelve chronological months with year rollover and empty gaps', () => {
  const rows = monthlyTrends([], '2026-02');
  assert.equal(rows.length, 12);
  assert.equal(rows[0].month, '2025-03');
  assert.equal(rows[11].month, '2026-02');
  assert.deepEqual(rows[9], { month: '2025-12', incomeMinor: 0, expensesMinor: 0, balanceMinor: 0 });
  assert.ok(rows.every(row => row.incomeMinor === 0 && row.expensesMinor === 0));
});

test('trends compare income and positive expenses using base currency and calendar boundaries', () => {
  const entries = Object.freeze([
    { occurredOn: '2024-02-29', amountMinor: -101 },
    { occurredOn: '2024-03-01', amountMinor: 100001 },
    { occurredOn: '2024-03-31', amountMinor: -999 },
    { occurredOn: '2025-01-01', amountMinor: 50000 },
    { occurredOn: '2025-02-28', amountMinor: -93, originalAmountMinor: 101, originalCurrency: 'USD', pending: true },
    { occurredOn: '2025-03-01', amountMinor: 999999 },
  ].map(Object.freeze));
  const rows = monthlyTrends(entries, '2025-02');
  assert.deepEqual(rows[0], { month: '2024-03', incomeMinor: 100001, expensesMinor: 999, balanceMinor: 99002 });
  assert.deepEqual(rows[10], { month: '2025-01', incomeMinor: 50000, expensesMinor: 0, balanceMinor: 50000 });
  assert.deepEqual(rows[11], { month: '2025-02', incomeMinor: 0, expensesMinor: 93, balanceMinor: -93 });
  assert.equal(rows.reduce((sum, row) => sum + row.expensesMinor, 0), 1092);
  assert.equal(monthlyTrends(entries, '2025-01')[0].expensesMinor, 101);
});

test('trends recompute corrected and deleted entries without mutating input', () => {
  const entries = [{ occurredOn: '2026-11-16', amountMinor: -300 }];
  assert.equal(monthlyTrends(entries, '2026-11')[11].expensesMinor, 300);
  assert.equal(monthlyTrends([{ ...entries[0], amountMinor: -100 }], '2026-11')[11].expensesMinor, 100);
  assert.equal(monthlyTrends([], '2026-11')[11].expensesMinor, 0);
  assert.equal(entries[0].amountMinor, -300);
});
