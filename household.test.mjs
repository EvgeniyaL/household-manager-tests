import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './helpers/api.mjs';

async function register(api, email = 'owner@example.com') {
  const response = await api.call('auth/register', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
  return response.json();
}

test('household creation requires authentication and validates input without creating records', async () => {
  const api = await createApi();
  try {
    await api.start();
    assert.equal((await api.call('households', { name: 'Family', baseCurrency: 'EUR' })).status, 401);
    assert.equal((await api.call('households/current')).status, 401);
    assert.equal((await api.call('households/current', undefined, 'forged-token')).status, 401);
    const { token } = await register(api);
    assert.equal((await (await api.call('households/current', undefined, token)).json()).household, null);
    for (const input of [
      {}, { name: null }, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) },
      { name: 'Family', baseCurrency: 'GBP' }, { name: 'Family', baseCurrency: 'eur' },
      { name: 'Family', baseCurrency: '' }, { name: 'Family', baseCurrency: null },
    ]) {
      assert.equal((await api.call('households', input, token)).status, 400, JSON.stringify(input));
    }
    for (const table of ['Households', 'Memberships', 'Budgets'])
      assert.equal(api.query(`SELECT COUNT(*) AS count FROM ${table}`)[0].count, 0);
  } finally { await api.dispose(); }
});

test('EUR is the default; owner membership and an empty budget persist across restart', async () => {
  const api = await createApi();
  try {
    await api.start();
    const session = await register(api);
    const response = await api.call('households', { name: '  Our family  ' }, session.token);
    assert.equal(response.status, 201);
    const household = await response.json();
    assert.equal(household.name, 'Our family');
    assert.equal(household.baseCurrency, 'EUR');
    assert.equal(household.role, 'Owner');
    assert.ok(household.id); assert.ok(household.budget.id);
    assert.deepEqual(household.budget.entries, []);
    const [membership] = api.query('SELECT * FROM Memberships');
    assert.equal(membership.AccountId.toLowerCase(), session.user.id);
    assert.equal(membership.HouseholdId.toLowerCase(), household.id);
    assert.equal(membership.Role, 'Owner');
    await api.stop(); await api.start();
    const restored = await (await api.call('households/current', undefined, session.token)).json();
    assert.deepEqual(restored.household, household);
    assert.ok(restored.categories.expense.includes('Groceries'));
    assert.ok(restored.categories.income.includes('Salary'));
    assert.equal((await api.call('households', { name: 'Second', baseCurrency: 'USD' }, session.token)).status, 409);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Households')[0].count, 1);
  } finally { await api.dispose(); }
});

test('USD is supported and concurrent requests create exactly one household, membership, and budget', async () => {
  const api = await createApi();
  try {
    await api.start();
    const { token } = await register(api);
    const input = { name: 'x'.repeat(80), baseCurrency: 'USD' };
    const responses = await Promise.all([api.call('households', input, token), api.call('households', input, token)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const household = await responses.find(r => r.status === 201).json();
    assert.equal(household.baseCurrency, 'USD');
    assert.equal(household.name, input.name);
    for (const table of ['Households', 'Memberships', 'Budgets'])
      assert.equal(api.query(`SELECT COUNT(*) AS count FROM ${table}`)[0].count, 1, table);
    const other = await register(api, 'other@example.com');
    assert.equal((await (await api.call('households/current', undefined, other.token)).json()).household, null);
    assert.equal((await api.call('households', { name: 'Other family', baseCurrency: 'EUR', ownerAccountId: household.id }, other.token)).status, 201);
    const original = await (await api.call('households/current', undefined, token)).json();
    assert.equal(original.household.id, household.id, 'households remain isolated');
  } finally { await api.dispose(); }
});

test('migrations preserve US-01 accounts and sessions from the old EnsureCreated database', async () => {
  const api = await createApi({ legacy: true });
  try {
    await api.start();
    const { token, email } = api.legacyAccount;
    const me = await api.call('auth/me', undefined, token);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).email, email);
    assert.equal(api.query('SELECT PasswordHash FROM Accounts')[0].PasswordHash, 'preserved-password-hash');
    assert.equal(api.query('SELECT COUNT(*) AS count FROM __EFMigrationsHistory')[0].count, 22);
    assert.equal((await api.call('households', { name: 'Existing family', baseCurrency: 'EUR' }, token)).status, 201);
    await api.stop(); await api.start();
    const result = await (await api.call('households/current', undefined, token)).json();
    assert.equal(result.household.name, 'Existing family');
  } finally { await api.dispose(); }
});
