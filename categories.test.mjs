import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { categoryName, resolveLanguage, categoryTranslations } from '../mobile/src/categoryNames.ts';
const expenses = ['Groceries', 'Housing', 'Transport', 'Utilities', 'Kids', 'Health', 'Entertainment', 'Other'];
const income = ['Salary', 'Gift', 'Refund', 'Other income'];
test('all defaults have English and Bulgarian labels without changing stored keys', () => {
  for (const key of [...expenses, ...income]) {
    assert.equal(categoryName(key, 'en'), key);
    assert.ok(categoryName(key, 'bg'));
    assert.notEqual(categoryName(key, 'bg'), key);
    assert.ok(categoryTranslations[key]);
  }
  assert.equal(categoryName('Groceries', 'bg'), 'Хранителни стоки');
  assert.equal(categoryName('Kids', 'bg'), 'Деца');
  assert.equal(categoryName('Salary', 'bg'), 'Заплата');
  assert.equal(resolveLanguage('bg-BG'), 'bg');
  assert.equal(resolveLanguage('bg_BG'), 'bg');
  assert.equal(resolveLanguage('en-US'), 'en');
  assert.equal(resolveLanguage('fr-FR'), 'en');
  assert.equal(resolveLanguage(null), 'en');
  assert.equal(categoryName('Future custom category', 'bg'), 'Future custom category');
});
test('households atomically receive unique defaults before first category read, shared and persistent', async () => {
  const api = await createApi();
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('member@example.com'), other = await reg('other@example.com');
    const household = await (await api.call('households', { name: 'New family' }, owner.token)).json();
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Categories')[0].count, 12);
    const base = `households/${household.id}`;
    const read = async (type, person) => (await api.call(`${base}/${type}-categories`, undefined, person.token)).json();
    assert.equal((await api.call(`${base}/expense-categories`)).status, 401);
    assert.equal((await api.call(`${base}/expense-categories`, undefined, other.token)).status, 403);
    assert.deepEqual(await read('expense', owner), expenses);
    assert.deepEqual(await read('income', owner), income);
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    assert.deepEqual(await read('expense', member), expenses);
    assert.deepEqual(await read('income', member), income);
    const id = randomUUID();
    assert.equal((await api.call(`${base}/expenses`, { id, amountMinor: 500, category: 'Kids', occurredOn: '2026-11-16', authorName: 'Parent' }, member.token)).status, 201);
    const second = await api.call('households', { name: 'Another' }, other.token);
    assert.equal(second.status, 201);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Categories')[0].count, 24);
    await api.stop(); await api.start();
    assert.deepEqual(await read('expense', owner), expenses);
    assert.deepEqual(await read('expense', owner), expenses);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Categories')[0].count, 24);
    const current = await (await api.call('households/current', undefined, member.token)).json();
    assert.deepEqual(current.categories, { expense: expenses, income });
    assert.equal(current.household.budget.entries[0].category, 'Kids');
    assert.equal(categoryName(current.household.budget.entries[0].category, 'bg'), 'Деца');
  } finally { await api.dispose(); }
});
test('migration seeds existing households without replacing budget, session, or invites', async () => {
  const api = await createApi({ legacy: true, legacyHousehold: true });
  try {
    await api.start();
    const current = await (await api.call('households/current', undefined, api.legacyAccount.token)).json();
    assert.equal(current.household.name, 'Existing family');
    assert.deepEqual(current.categories, { expense: expenses, income });
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Categories')[0].count, 12);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Invites')[0].count, 1);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Budgets')[0].count, 1);
    await api.stop(); await api.start();
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Categories')[0].count, 12);
  } finally { await api.dispose(); }
});
