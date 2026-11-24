import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from './helpers/api.mjs';
import { filterTransactions, TRANSACTION_SYNC_INTERVAL_MS } from '../mobile/src/transactions.ts';

test('another device session sees new expense at the next sync interval and on explicit refresh', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), partner = await reg('partner@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const base = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, partner.token);
    const read = async () => {
      const response = await api.call('households/current', undefined, owner.token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await response.json()).household.budget.entries;
    };
    assert.equal((await read()).length, 0);
    const save = async id => {
      assert.equal((await api.call(`${base}/expenses`, { id, amountMinor: 1234, category: 'Groceries', occurredOn: '2026-11-16', authorName: 'Partner' }, partner.token)).status, 201);
    };
    const first = randomUUID();
    await save(first);
    const savedAt = performance.now();
    // Same polling interval used by the foreground Transactions screen.
    await delay(TRANSACTION_SYNC_INTERVAL_MS);
    const entries = await read();
    assert.ok(performance.now() - savedAt < 10000, 'expense should be visible before ten seconds');
    const visible = filterTransactions(entries, { month: '2026-11', category: '', member: '' });
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, first);
    assert.equal(visible[0].authorName, 'Partner');
    const second = randomUUID();
    await save(second);
    // Pull-to-refresh requests current state without waiting for the next tick.
    assert.equal((await read()).length, 2);
    await api.call(`${base}/members/${partner.user.id}/remove`, {}, owner.token);
    assert.equal((await (await api.call('households/current', undefined, partner.token)).json()).household, null);
  } finally { await api.dispose(); }
});
