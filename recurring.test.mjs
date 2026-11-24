import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';

test('monthly recurring rules validate, enforce owner access, persist and calculate calendar due dates', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('member@example.com'), other = await reg('other@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const route = `households/${household.id}/recurring`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    const input = { id: randomUUID(), amountMinor: 125099, currency: 'USD', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: '2096-02-01', dayOfMonth: 31 };
    assert.equal((await api.call(route, input)).status, 401);
    for (const user of [member, other]) assert.equal((await api.call(route, input, user.token)).status, 403);
    assert.equal((await api.call(route, undefined, other.token)).status, 403);
    for (const bad of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 100000000000 }, { amountMinor: 1.5 }, { currency: 'BGN' }, { type: 'Other' }, { category: 'Salary' }, { frequency: 'Weekly' }, { dayOfMonth: 0 }, { dayOfMonth: 32 }, { startDate: null }, { startDate: '2096-02-30' }, { startDate: '9999-01-01' }, { id: '00000000-0000-0000-0000-000000000000' }]) {
      assert.equal((await api.call(route, { ...input, ...bad }, owner.token)).status, 400, JSON.stringify(bad));
    }
    const saved = await api.call(route, input, owner.token);
    assert.equal(saved.status, 201);
    const result = await saved.json();
    assert.equal(result.nextDueDate, '2096-02-29');
    assert.equal(result.rule.currency, 'USD'); assert.equal(result.rule.amountMinor, 125099);
    assert.equal((await api.call(route, input, owner.token)).status, 200);
    assert.equal((await api.call(route, { ...input, amountMinor: 5 }, owner.token)).status, 409);
    const dates = [
      ['2097-02-01', 31, '2097-02-28'],
      ['2097-04-01', 31, '2097-04-30'],
      ['2097-01-20', 15, '2097-02-15'],
      ['2097-01-15', 15, '2097-01-15'],
      ['2097-12-31', 1, '2098-01-01'],
    ];
    for (const [startDate, dayOfMonth, due] of dates) {
      const response = await api.call(route, { ...input, id: randomUUID(), startDate, dayOfMonth, type: 'Income', category: 'Salary', currency: 'EUR' }, owner.token);
      assert.equal(response.status, 201); assert.equal((await response.json()).nextDueDate, due);
    }
    const past = await (await api.call(route, { ...input, id: randomUUID(), startDate: '2000-01-01', dayOfMonth: 1 }, owner.token)).json();
    assert.equal(past.nextDueDate, '2000-01-01', 'old start dates remain due for scheduler catch-up');
    await api.stop(); await api.start();
    const list = await (await api.call(route, undefined, member.token)).json();
    assert.equal(list.length, 7);
    assert.deepEqual(list.map(r => r.nextDueDate), list.map(r => r.nextDueDate).sort());
    const current = await (await api.call('households/current', undefined, owner.token)).json();
    assert.equal(current.household.budget.entries.length, 0, 'rules do not post transactions in US-15');
    await api.call(`households/${household.id}/categories/archive`, { key: 'Housing', type: 'Expense' }, owner.token);
    assert.equal((await api.call(route, { ...input, id: randomUUID() }, owner.token)).status, 400);
    assert.equal((await api.call(route, input, owner.token)).status, 200, 'accepted rule can be retried after archive');
    const concurrentInput = { ...input, id: randomUUID(), type: 'Income', category: 'Salary' };
    const concurrent = await Promise.all([1,2].map(() => api.call(route, concurrentInput, owner.token)));
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200,201]);
  } finally { await api.dispose(); }
});
