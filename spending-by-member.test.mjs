import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendingByMember } from '../mobile/src/spendingByMember.ts';

const entry = (id, authorAccountId, authorName, amountMinor, occurredOn = '2026-11-16') => ({ id, authorAccountId, authorName, amountMinor, occurredOn });

test('member report groups by author identity, retains former authors and excludes income and other months', () => {
  const entries = Object.freeze([
    entry('1', 'a', 'Alex', -100), entry('2', 'a', 'Alex', -200),
    entry('3', 'b', 'Alex', -600),
    { ...entry('4', 'former', 'Former member', -100), originalAmountMinor: 200, originalCurrency: 'USD' },
    entry('5', 'a', 'Alex', 100000),
    entry('6', 'b', 'Alex', -100000, '2026-10-31'),
    entry('7', 'b', 'Alex', -100000, '2026-12-01'),
    entry('8', 'b', 'Alex', -100000, '2025-11-16'),
  ].map(Object.freeze));
  assert.deepEqual(spendingByMember(entries, '2026-11'), { totalMinor: 1000, members: [
    { memberId: 'b', name: 'Alex', amountMinor: 600, percentage: 60 },
    { memberId: 'a', name: 'Alex', amountMinor: 300, percentage: 30 },
    { memberId: 'former', name: 'Former member', amountMinor: 100, percentage: 10 },
  ] });
});

test('member report handles empty months, pending records, edits and deletes', () => {
  assert.deepEqual(spendingByMember([], '2026-11'), { totalMinor: 0, members: [] });
  assert.deepEqual(spendingByMember([entry('1', 'a', 'A', 100)], '2026-11'), { totalMinor: 0, members: [] });
  const pending = { ...entry('1', 'a', 'A', -101), pending: true };
  assert.equal(spendingByMember([pending], '2026-11').totalMinor, 101);
  assert.equal(spendingByMember([{ ...pending, amountMinor: -55 }], '2026-11').totalMinor, 55);
  assert.deepEqual(spendingByMember([pending], '2027-01'), { totalMinor: 0, members: [] });
});

test('latest expense attribution name and equal totals are deterministic without mutating entries', () => {
  const entries = [entry('2', 'b', 'B', -100), entry('1', 'a', 'Old', -50, '2026-11-01'), entry('3', 'a', 'New', -50, '2026-11-30')];
  const report = spendingByMember(entries, '2026-11');
  assert.deepEqual(report.members.map(m => [m.memberId, m.name, m.amountMinor]), [['a', 'New', 100], ['b', 'B', 100]]);
  assert.deepEqual(spendingByMember([...entries].reverse(), '2026-11'), report);
  assert.equal(report.members.reduce((sum, m) => sum + m.percentage, 0), 100);
  assert.equal(entries[0].id, '2');
});
