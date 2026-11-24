import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createApi } from './helpers/api.mjs';
import { upcomingForToday } from '../mobile/src/upcoming.ts';
const harness = resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll');
const today = () => new Date().toISOString().slice(0,10);
const shift = (value, days) => { const date = new Date(value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); };
const preview = (api, householdId, date) => JSON.parse(execFileSync('dotnet', [harness, api.databasePath, date, 'upcoming', householdId], { windowsHide: true, timeout: 30000 }).toString());
async function setup(api) {
  await api.start();
  const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
  const owner = await reg('owner@example.com'), member = await reg('member@example.com'), other = await reg('other@example.com');
  const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
  const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
  await api.call('invites/redeem', { code: invite.code }, member.token);
  const create = async (date, extras = {}) => {
    const input = { id: randomUUID(), amountMinor: 12345, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: date, dayOfMonth: Number(date.slice(8)), ...extras };
    const response = await api.call(`households/${household.id}/recurring`, input, owner.token);
    assert.equal(response.status, 201); return (await response.json()).rule;
  };
  const change = async (rule, action, amountMinor) => {
    const response = await api.call(`households/${household.id}/recurring/${rule.id}/change`, { operationId: randomUUID(), revision: rule.revision, action, ...(amountMinor ? { amountMinor } : {}) }, owner.token);
    assert.equal(response.status, 200); return (await response.json()).rule;
  };
  return { owner, member, other, household, create, change };
}
test('home upcoming expenses include today and day seven, respect prices, exclude income/paused/stopped, and are shared only within the household', async () => {
  const api = await createApi();
  try {
    const { owner, member, other, create, change } = await setup(api);
    const date = today();
    const dueToday = await create(date);
    const daySeven = await create(shift(date,7), { currency: 'USD' });
    await change(daySeven, 'amount', 5555);
    await create(shift(date,8));
    await create(shift(date,3), { type: 'Income', category: 'Salary' });
    const paused = await create(shift(date,2)); await change(paused, 'pause');
    const stopped = await create(shift(date,1)); await change(stopped, 'stop');
    assert.equal((await api.call('households/current')).status, 401);
    const current = async user => (await (await api.call('households/current', undefined, user.token)).json());
    const state = await current(member);
    assert.equal(state.upcoming.from, date); assert.equal(state.upcoming.through, shift(date,7));
    assert.deepEqual(state.upcoming.items.map(i => i.ruleId), [dueToday.id, daySeven.id]);
    assert.equal(state.upcoming.items[1].currency, 'USD'); assert.equal(state.upcoming.items[1].amountMinor, 5555);
    assert.equal(state.upcoming.items[0].category, 'Housing'); assert.equal(state.upcoming.items[0].amountMinor, 12345);
    assert.deepEqual((await current(owner)).upcoming, state.upcoming);
    assert.deepEqual((await current(other)).upcoming.items, []);
    assert.equal(state.household.budget.entries.length, 0, 'preview does not generate entries or alter totals');
    await change(dueToday, 'amount', 9999);
    assert.equal((await current(member)).upcoming.items[0].amountMinor, 12345, 'today retains its old price');
    await api.stop(); await api.start();
    assert.deepEqual((await current(member)).upcoming, state.upcoming);
  } finally { await api.dispose(); }
});
test('upcoming handles leap/month/year boundaries, overdue cursors, advanced cursors and durable occurrence receipts', async () => {
  const api = await createApi();
  try {
    const { household, create } = await setup(api);
    const leap = await create('2028-01-31');
    await create('2028-03-05');
    let window = preview(api, household.id, '2028-02-25');
    assert.equal(window.through, '2028-03-03');
    assert.deepEqual(window.items.map(i => [i.ruleId,i.dueDate]), [[leap.id,'2028-02-29']]);
    api.execute('UPDATE RecurringRules SET NextDueDate = ? WHERE Id = ?', '2028-03-31', leap.id.toUpperCase());
    assert.deepEqual(preview(api, household.id, '2028-02-25').items, [], 'advanced cursor excludes already processed schedule');
    api.execute('UPDATE RecurringRules SET NextDueDate = NULL WHERE Id = ?', leap.id.toUpperCase());
    api.execute('INSERT INTO RecurringOccurrences (RuleId, DueDate, EntryId) VALUES (?, ?, ?)', leap.id.toUpperCase(), '2028-02-29', randomUUID().toUpperCase());
    assert.deepEqual(preview(api, household.id, '2028-02-25').items, [], 'deleted entry receipt still suppresses reminder');
    const newYear = await create('2028-12-31', { dayOfMonth: 1 });
    window = preview(api, household.id, '2028-12-28');
    assert.ok(window.items.some(i => i.ruleId === newYear.id && i.dueDate === '2029-01-01'));
    const nonLeap = await create('2029-01-31');
    window = preview(api, household.id, '2029-02-25');
    assert.ok(window.items.some(i => i.ruleId === nonLeap.id && i.dueDate === '2029-02-28'));
  } finally { await api.dispose(); }
});
test('cached upcoming display removes expired dates, includes boundaries and leaves cached data unchanged', () => {
  const items = ['2028-12-31','2029-01-01','2029-01-08','2029-01-09'].map((dueDate,i) => ({ ruleId: String(i), dueDate, category: 'Housing', amountMinor: 100, currency: 'EUR' }));
  const window = { from: '2028-12-31', through: '2029-01-09', items };
  assert.deepEqual(upcomingForToday(window,'2029-01-01').map(i => i.dueDate), ['2029-01-01','2029-01-08']);
  assert.equal(window.items.length, 4);
  assert.deepEqual(upcomingForToday(null,'2029-01-01'), []);
});
