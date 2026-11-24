import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { monthlyBalance, shiftMonth } from '../mobile/src/monthlyBalance.ts';
test('shared income validates, retries once, persists and keeps attribution after removal', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('maya@example.com'), other = await reg('other@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const path = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    assert.ok((await (await api.call(`${path}/income-categories`, undefined, member.token)).json()).includes('Salary'));
    const payload = { id: randomUUID(), amountMinor: 1299, category: 'Salary', occurredOn: '2026-11-16', note: ' Milk ', authorName: ' Maya Taylor ' };
    assert.equal((await api.call(`${path}/incomes`, payload)).status, 401);
    assert.equal((await api.call(`${path}/incomes`, payload, other.token)).status, 403);
    for (const invalid of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { category: 'Unknown' }, { occurredOn: '2025-02-29' }, { authorName: '' }, { note: 'x'.repeat(501) }])
      assert.equal((await api.call(`${path}/incomes`, { ...payload, ...invalid }, member.token)).status, 400);
    const results = await Promise.all([api.call(`${path}/incomes`, payload, member.token), api.call(`${path}/incomes`, payload, member.token)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    assert.equal((await api.call(`${path}/incomes`, { ...payload, amountMinor: 1300 }, member.token)).status, 409);
    const entries = async () => (await (await api.call('households/current', undefined, owner.token)).json()).household.budget.entries;
    assert.equal((await api.call(`${path}/incomes`, { ...payload, id: randomUUID(), category: 'Groceries' }, member.token)).status, 400);
    assert.equal((await api.call(`${path}/expenses`, { ...payload, id: randomUUID(), category: 'Salary' }, member.token)).status, 400);
    const saved = await entries();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].amountMinor, 1299);
    assert.equal(saved[0].authorName, 'Maya Taylor');
    assert.equal(saved[0].authorAccountId, member.user.id);
    assert.equal(saved[0].description, 'Milk');
    assert.equal(saved[0].category, 'Salary');
    assert.equal(saved[0].type, 'Income');
    const expense = { ...payload, id: randomUUID(), amountMinor: 299, category: 'Groceries' };
    assert.equal((await api.call(`${path}/expenses`, expense, owner.token)).status, 201);
    assert.equal(monthlyBalance(await entries(), '2026-11'), 1000);
    assert.equal(monthlyBalance(await entries(), '2026-10'), 0);
    const beforeRestart = await entries();
    await api.call(`${path}/members/${member.user.id}/remove`, {}, owner.token);
    assert.equal((await api.call(`${path}/incomes`, { ...payload, id: randomUUID() }, member.token)).status, 403);
    await api.stop(); await api.start();
    assert.deepEqual(await entries(), beforeRestart);
  } finally { await api.dispose(); }
});

test('monthly balance separates dates across months and years', () => {
  const entries = [
    { occurredOn: '2026-11-01', amountMinor: 200000 },
    { occurredOn: '2026-11-30', amountMinor: -50000 },
    { occurredOn: '2026-10-31', amountMinor: 1000 },
    { occurredOn: '2026-12-01', amountMinor: 9999 },
    { occurredOn: '2025-11-01', amountMinor: 7777 },
  ];
  assert.equal(monthlyBalance(entries, '2026-11'), 150000);
  assert.equal(monthlyBalance(entries, '2026-10'), 1000);
  assert.equal(monthlyBalance(entries, '2027-01'), 0);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});
