import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlySummary } from '../mobile/src/monthlyBalance.ts';

test('monthly summary totals income and positive expenses in base minor units within calendar month', () => {
  const entries = [
    { occurredOn: '2026-11-01', amountMinor: 250001 },
    { occurredOn: '2026-11-30', amountMinor: 1299 },
    { occurredOn: '2026-11-02', amountMinor: -50101 },
    // Converted recurring expense: use saved base value, not its original USD amount.
    { occurredOn: '2026-11-28', amountMinor: -93, originalAmountMinor: 101, originalCurrency: 'USD' },
    { occurredOn: '2026-10-31', amountMinor: -90000 },
    { occurredOn: '2026-12-01', amountMinor: 999999 },
    { occurredOn: '2025-11-16', amountMinor: 8888 },
  ];
  assert.deepEqual(monthlySummary(entries, '2026-11'), { incomeMinor: 251300, expensesMinor: 50194, balanceMinor: 201106 });
  assert.deepEqual(monthlySummary(entries, '2026-10'), { incomeMinor: 0, expensesMinor: 90000, balanceMinor: -90000 });
  assert.deepEqual(monthlySummary(entries, '2027-01'), { incomeMinor: 0, expensesMinor: 0, balanceMinor: 0 });
  assert.deepEqual(monthlySummary([], '2026-11'), { incomeMinor: 0, expensesMinor: 0, balanceMinor: 0 });
});

test('monthly summary reflects edits, deletes and pending entries without mutating input', () => {
  const entries = Object.freeze([
    Object.freeze({ occurredOn: '2026-11-16', amountMinor: 10001 }),
    Object.freeze({ occurredOn: '2026-11-16', amountMinor: -12002, pending: true }),
  ]);
  assert.deepEqual(monthlySummary(entries, '2026-11'), { incomeMinor: 10001, expensesMinor: 12002, balanceMinor: -2001 });
  assert.equal(monthlySummary([entries[0], { ...entries[1], amountMinor: -1 }], '2026-11').balanceMinor, 10000);
  assert.equal(monthlySummary(entries.slice(0, 1), '2026-11').expensesMinor, 0);
});
