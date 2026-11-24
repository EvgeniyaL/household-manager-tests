import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { amountToMinor, validDate } from '../mobile/src/expense.ts';
test('expense input validates cents and calendar dates', () => {
  assert.equal(amountToMinor('12,34'), 1234);
  assert.equal(amountToMinor('0.01'), 1);
  for (const v of ['0', '-1', '1.001', '1e2', '', '1000000000']) assert.equal(amountToMinor(v), null);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2025-02-29'), false);
});
test('shared expense validates, retries once, persists and keeps attribution after removal', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('maya@example.com'), other = await reg('other@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const path = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    assert.ok((await (await api.call(`${path}/expense-categories`, undefined, member.token)).json()).includes('Groceries'));
    const payload = { id: randomUUID(), amountMinor: 1299, category: 'Groceries', occurredOn: '2026-11-16', note: ' Milk ', authorName: ' Maya Taylor ' };
    assert.equal((await api.call(`${path}/expenses`, payload)).status, 401);
    assert.equal((await api.call(`${path}/expenses`, payload, other.token)).status, 403);
    for (const invalid of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { category: 'Unknown' }, { occurredOn: '2025-02-29' }, { authorName: '' }, { note: 'x'.repeat(501) }])
      assert.equal((await api.call(`${path}/expenses`, { ...payload, ...invalid }, member.token)).status, 400);
    const results = await Promise.all([api.call(`${path}/expenses`, payload, member.token), api.call(`${path}/expenses`, payload, member.token)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    assert.equal((await api.call(`${path}/expenses`, { ...payload, amountMinor: 1300 }, member.token)).status, 409);
    const entries = async () => (await (await api.call('households/current', undefined, owner.token)).json()).household.budget.entries;
    const saved = await entries();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].amountMinor, -1299);
    assert.equal(saved[0].authorName, 'Maya Taylor');
    assert.equal(saved[0].authorAccountId, member.user.id);
    assert.equal(saved[0].description, 'Milk');
    assert.equal(saved[0].category, 'Groceries');
    await api.call(`${path}/members/${member.user.id}/remove`, {}, owner.token);
    assert.equal((await api.call(`${path}/expenses`, { ...payload, id: randomUUID() }, member.token)).status, 403);
    await api.stop(); await api.start();
    assert.deepEqual(await entries(), saved);
  } finally { await api.dispose(); }
});
