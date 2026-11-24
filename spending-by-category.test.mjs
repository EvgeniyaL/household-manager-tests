import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendingByCategory } from '../mobile/src/spendingByCategory.ts';
import { monthlySummary } from '../mobile/src/monthlyBalance.ts';

test('category spending groups expenses, sorts descending and uses base values and expense-only shares', () => {
  const entries = Object.freeze([
    { occurredOn: '2026-11-01', amountMinor: -100, category: 'Groceries' },
    { occurredOn: '2026-11-30', amountMinor: -200, category: 'Groceries', pending: true },
    { occurredOn: '2026-11-02', amountMinor: -600, category: 'custom-archived' },
    { occurredOn: '2026-11-03', amountMinor: -100, category: 'Transport', originalAmountMinor: 200, originalCurrency: 'USD' },
    { occurredOn: '2026-11-16', amountMinor: 90000, category: 'Salary' },
    { occurredOn: '2026-10-31', amountMinor: -50000, category: 'Housing' },
    { occurredOn: '2026-12-01', amountMinor: -50000, category: 'Housing' },
    { occurredOn: '2025-11-01', amountMinor: -50000, category: 'Housing' },
  ].map(Object.freeze));
  assert.deepEqual(spendingByCategory(entries, '2026-11'), { totalMinor: 1000, categories: [
    { category: 'custom-archived', amountMinor: 600, percentage: 60 },
    { category: 'Groceries', amountMinor: 300, percentage: 30 },
    { category: 'Transport', amountMinor: 100, percentage: 10 },
  ] });
  assert.equal(spendingByCategory(entries, '2026-11').totalMinor, monthlySummary(entries, '2026-11').expensesMinor);
});

test('empty and income-only months have no chart categories or invalid percentages', () => {
  for (const entries of [[], [{ occurredOn: '2026-11-01', amountMinor: 100, category: 'Salary' }]])
    assert.deepEqual(spendingByCategory(entries, '2026-11'), { totalMinor: 0, categories: [] });
});

test('uncategorized grouping, equal totals and corrections remain deterministic', () => {
  const entries = [
    { occurredOn: '2026-11-01', amountMinor: -1, category: 'B' },
    { occurredOn: '2026-11-01', amountMinor: -1, category: 'A' },
    { occurredOn: '2026-11-01', amountMinor: -1, category: null },
    { occurredOn: '2026-11-01', amountMinor: -1 },
  ];
  const report = spendingByCategory(entries, '2026-11');
  assert.deepEqual(report.categories.map(x => x.category), ['Uncategorized', 'A', 'B']);
  assert.equal(report.categories.reduce((sum, x) => sum + x.percentage, 0), 100);
  assert.equal(spendingByCategory(entries.slice(0, 2), '2026-11').totalMinor, 2);
  assert.equal(spendingByCategory([{ ...entries[0], amountMinor: -7 }], '2026-11').categories[0].percentage, 100);
});
