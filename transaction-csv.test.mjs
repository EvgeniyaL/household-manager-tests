import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transactionCsv, allTransactionCsv } from '../mobile/src/transactionCsv.ts';

// Independent RFC-style CSV reader verifies quoted commas, newlines and quotes.
function parse(csv) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 1; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if (c === '\r' && csv[i + 1] === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; i++; }
    else value += c;
  }
  return rows;
}
const entry = { id: 'id-1', occurredOn: '2026-11-16', amountMinor: -1299, category: 'Groceries', authorAccountId: 'owner-id', authorName: 'Мая, "Тест"', description: 'Milk, eggs\nSecond line' };

test('month CSV preserves Unicode and quoted text with signed decimal base-currency amounts', () => {
  const exported = transactionCsv([
    entry, { ...entry, id: 'id-2', amountMinor: 10001, category: 'Salary', occurredOn: '2026-11-30' },
    { ...entry, id: 'outside', occurredOn: '2026-10-31' }, { ...entry, id: 'outside2', occurredOn: '2025-11-16' },
  ], '2026-11', 'EUR', key => key === 'Groceries' ? 'Храна' : key);
  assert.equal(exported.count, 2);
  assert.ok(exported.csv.startsWith('\uFEFF'));
  assert.ok(exported.csv.endsWith('\r\n'));
  const [header, income, expense] = parse(exported.csv);
  assert.equal(header.length, 23);
  assert.equal(income.length, header.length);
  assert.equal(income[2], 'Income'); assert.equal(income[3], '100.01');
  assert.equal(expense[3], '-12.99'); assert.equal(expense[4], 'EUR'); assert.equal(expense[5], 'Храна');
  assert.equal(expense[7], entry.authorName); assert.equal(expense[9], entry.description);
  assert.equal(expense[18], 'Online snapshot');
});

test('CSV neutralizes spreadsheet formulas in text while keeping amounts numeric', () => {
  for (const text of ['=HYPERLINK("bad")', '+123', '-1+2', '@SUM(A1)', ' \t=1+1', '\r\n=1']) {
    const [, row] = parse(transactionCsv([{ ...entry, description: text, authorName: text }], '2026-11', 'USD', () => text).csv);
    for (const index of [5, 7, 9]) assert.equal(row[index], "'" + text);
    assert.equal(row[3], '-12.99');
  }
});

test('CSV identifies pending/offline snapshots and preserves recurring generation provenance', () => {
  const record = { ...entry, pending: true, amountMinor: -93, recurringRuleId: 'rule-id', recurringDueDate: '2026-11-16', originalAmountMinor: 101, originalCurrency: 'USD', exchangeRate: 0.92498, rateDate: '2026-11-13', rateSource: 'ECB via Frankfurter' };
  const [, row] = parse(transactionCsv([record], '2026-11', 'EUR', k => k, true).csv);
  assert.equal(row[3], '-0.93'); assert.equal(row[10], 'Pending sync');
  assert.deepEqual(row.slice(11), ['rule-id', '2026-11-16', '1.01', 'USD', '0.92498', '2026-11-13', 'ECB via Frankfurter', 'Offline cache', 'No', '', '', '']);
  assert.equal(parse(transactionCsv([{ ...record, syncError: 'Rejected' }], '2026-11', 'EUR', k => k).csv)[1][10], 'Sync failed');
});

test('empty exports have headers only and invalid months are rejected', () => {
  const result = transactionCsv([], '2026-11', 'EUR', k => k);
  assert.equal(result.count, 0); assert.equal(parse(result.csv).length, 1);
  for (const month of ['2026-00', '2026-13', '../x', '2026-1']) assert.throws(() => transactionCsv([], month, 'EUR', k => k));
});

test('all-data export spans every month and retains original and base amounts and rates', () => {
  const result = allTransactionCsv([entry, { ...entry, id: 'usd', occurredOn: '2024-01-01', amountMinor: -92, originalAmountMinor: 100, originalCurrency: 'USD', exchangeRate: 0.92, rateDate: '2024-01-01' }], 'EUR', k => k);
  const [headers, manual, converted] = parse(result.csv);
  assert.equal(result.count, 2);
  assert.equal(headers[3], 'Base amount');
  assert.deepEqual(manual.slice(13,16), ['12.99','EUR','1']);
  assert.deepEqual(converted.slice(13,16), ['1.00','USD','0.92']);
  assert.equal(converted[3], '-0.92');
  assert.equal(parse(allTransactionCsv([], 'EUR', k => k).csv).length, 1);
});
