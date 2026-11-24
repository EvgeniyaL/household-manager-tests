import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { filterTransactions, transactionMembers } from '../mobile/src/transactions.ts';
test('filters combine, use calendar months and author IDs, sort newest first without mutating input', () => {
  const entry = (id, occurredOn, authorAccountId, category) => ({ id, occurredOn, authorAccountId, category, authorName: 'Same name', amountMinor: -100, description: '' });
  const entries = [entry('b', '2026-11-01', 'one', 'Groceries'), entry('a', '2026-11-30', 'two', 'Groceries'), entry('c', '2026-10-31', 'two', 'Salary'), entry('d', '2025-11-30', 'one', null), entry('e', '2026-12-01', 'one', 'Groceries')];
  const original = structuredClone(entries);
  assert.deepEqual(filterTransactions(entries, { month: '2026-11', category: '', member: '' }).map(e => e.id), ['a', 'b']);
  assert.deepEqual(filterTransactions(entries, { month: '2026-11', category: 'Groceries', member: 'one' }).map(e => e.id), ['b']);
  assert.equal(filterTransactions(entries, { month: '2026-11', category: 'Salary', member: '' }).length, 0);
  assert.deepEqual(filterTransactions(entries, { month: '', category: 'Uncategorized', member: '' }).map(e => e.id), ['d']);
  assert.equal(filterTransactions(entries, { month: '', category: '', member: '' }).length, 5);
  assert.equal(transactionMembers(entries).length, 2);
  assert.deepEqual(entries, original);
  assert.deepEqual(filterTransactions([entries[0], { ...entries[0], id: 'a' }], { month: '', category: '', member: '' }).map(e => e.id), ['a', 'b']);
});
test('household members filter shared transactions with original authors including former members', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('member@example.com'), outsider = await reg('outsider@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const base = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    for (const [person, date, category, income] of [[owner, '2026-11-01', 'Salary', true], [member, '2026-11-30', 'Groceries', false], [owner, '2026-10-31', 'Groceries', false], [member, '2026-12-01', 'Other', false]]) {
      assert.equal((await api.call(`${base}/${income ? 'incomes' : 'expenses'}`, { id: randomUUID(), amountMinor: 100, category, occurredOn: date, authorName: person === owner ? 'Owner name' : 'Member name' }, person.token)).status, 201);
    }
    const current = async person => (await (await api.call('households/current', undefined, person.token)).json()).household;
    const shared = (await current(member)).budget.entries;
    assert.deepEqual(shared, (await current(owner)).budget.entries);
    const november = filterTransactions(shared, { month: '2026-11', category: '', member: '' });
    assert.deepEqual(november.map(e => e.occurredOn), ['2026-11-30', '2026-11-01']);
    assert.deepEqual(november.map(e => e.authorName), ['Member name', 'Owner name']);
    assert.equal(filterTransactions(shared, { month: '2026-11', category: 'Groceries', member: member.user.id }).length, 1);
    assert.equal(await current(outsider), null);
    await api.call(`${base}/members/${member.user.id}/remove`, {}, owner.token);
    const afterRemoval = (await current(owner)).budget.entries;
    assert.equal(filterTransactions(afterRemoval, { month: '', category: '', member: member.user.id }).length, 2);
    assert.ok(transactionMembers(afterRemoval).some(person => person.name === 'Member name'));
  } finally { await api.dispose(); }
});
