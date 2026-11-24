import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createApi } from './helpers/api.mjs';
const today = () => new Date().toISOString().slice(0,10);
const runner = resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll');
const generate = (api, date) => execFileSync('dotnet', [runner, api.databasePath, date], { windowsHide: true, timeout: 30000 });
async function setup(api) {
  await api.start();
  const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
  const owner = await reg('owner@example.com'), member = await reg('member@example.com'), other = await reg('other@example.com');
  const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
  const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
  await api.call('invites/redeem', { code: invite.code }, member.token);
  const input = { id: randomUUID(), amountMinor: 1000, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: '2024-01-01', dayOfMonth: 31 };
  const saved = await (await api.call(`households/${household.id}/recurring`, input, owner.token)).json();
  const path = `households/${household.id}/recurring/${input.id}/change`;
  const operation = (revision, action, amountMinor) => ({ operationId: randomUUID(), revision, action, ...(amountMinor !== undefined ? { amountMinor } : {}) });
  const list = async () => (await (await api.call(`households/${household.id}/recurring`, undefined, owner.token)).json());
  const entries = async () => (await (await api.call('households/current', undefined, member.token)).json()).household.budget.entries;
  return { owner, member, other, household, input, saved, path, operation, list, entries };
}
test('owner edits future amounts, keeps past and overdue amounts, pauses/resumes and permanently stops without losing history', async () => {
  const api = await createApi();
  try {
    const { owner, member, other, household, input, saved, path, operation, list, entries } = await setup(api);
    const change = operation(saved.rule.revision, 'amount', 2500);
    assert.equal((await api.call(path, change)).status, 401);
    for (const user of [member, other]) assert.equal((await api.call(path, change, user.token)).status, 403);
    for (const amountMinor of [0,-1,1.5,100000000000,null]) assert.equal((await api.call(path, { ...change, amountMinor }, owner.token)).status, 400);
    assert.equal((await api.call(path, { ...change, action: 'rename' }, owner.token)).status, 400);
    assert.equal((await api.call(path, { ...change, revision: null }, owner.token)).status, 400);
    assert.equal((await api.call(`households/${household.id}/recurring/${randomUUID()}/change`, change, owner.token)).status, 404);
    generate(api, '2024-02-29');
    const past = await entries(); assert.equal(past.length, 2);
    const response = await api.call(path, change, owner.token); assert.equal(response.status, 200);
    let changed = await response.json();
    assert.equal(changed.rule.amountMinor, 2500);
    assert.ok(changed.rule.amountEffectiveFrom > today());
    assert.deepEqual(await entries(), past, 'saving a rule never rewrites existing entries');
    assert.deepEqual(await (await api.call(path, change, owner.token)).json(), changed, 'lost-response retry is acknowledged');
    assert.equal((await api.call(path, { ...change, amountMinor: 3333 }, owner.token)).status, 409);
    assert.equal((await api.call(path, operation(saved.rule.revision, 'pause'), owner.token)).status, 409);
    generate(api, today());
    const overdue = await entries();
    assert.ok(overdue.every(e => e.amountMinor === -1000), 'all past/today due dates retain the previous amount');
    const next = (await list())[0].rule.nextDueDate;
    generate(api, next);
    const after = await entries();
    const futureEntry = after.find(e => e.occurredOn === next);
    assert.equal(futureEntry.amountMinor, -2500); assert.equal(futureEntry.originalAmountMinor, 2500);
    assert.deepEqual(after.filter(e => e.occurredOn !== next), overdue);
    let rule = (await list())[0].rule;
    changed = await (await api.call(path, operation(rule.revision, 'pause'), owner.token)).json();
    assert.equal(changed.rule.active, false);
    const following = changed.rule.nextDueDate;
    generate(api, following); assert.deepEqual(await entries(), after, 'paused rule never generates');
    changed = await (await api.call(path, operation(changed.rule.revision, 'resume'), owner.token)).json();
    assert.equal(changed.rule.active, true);
    generate(api, following); assert.equal((await entries()).length, after.length + 1);
    const stop = operation(changed.rule.revision, 'stop');
    const stopped = await (await api.call(path, stop, owner.token)).json();
    assert.equal(stopped.rule.active, false); assert.equal(stopped.rule.stopped, true);
    assert.deepEqual(await list(), []);
    const retained = await entries();
    generate(api, '2099-12-31'); assert.deepEqual(await entries(), retained);
    assert.equal((await api.call(path, operation(stopped.rule.revision, 'resume'), owner.token)).status, 410);
    assert.equal((await api.call(`households/${household.id}/recurring`, input, owner.token)).status, 410, 'creation retry cannot resurrect stopped rule');
    // An older successful change receipt remains an acknowledgement, never another mutation.
    await api.call(path, change, owner.token); assert.deepEqual(await list(), []);
    await api.stop(); await api.start();
    assert.deepEqual(await (await api.call(path, stop, owner.token)).json(), stopped);
    assert.deepEqual(await entries(), retained);
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, retained.length);
  } finally { await api.dispose(); }
});

test('concurrent owner changes reject stale revisions and resume skips missed pause dates', async () => {
  const api = await createApi();
  try {
    const { owner, input, saved, path, operation, list, entries } = await setup(api);
    const requests = [operation(saved.rule.revision, 'amount', 2000), operation(saved.rule.revision, 'amount', 3000)];
    const results = await Promise.all(requests.map(body => api.call(path, body, owner.token)));
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    let rule = (await list())[0].rule;
    const repeat = operation(rule.revision, 'amount', 4000);
    const retries = await Promise.all([1,2].map(() => api.call(path, repeat, owner.token)));
    assert.deepEqual(retries.map(r => r.status), [200,200]);
    assert.deepEqual(await retries[0].json(), await retries[1].json());
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringAmounts')[0].n, 2, 'same-day edits share one future effective version');
    rule = (await list())[0].rule;
    const paused = await (await api.call(path, operation(rule.revision, 'pause'), owner.token)).json();
    generate(api, today()); assert.deepEqual(await entries(), []);
    const resume = operation(paused.rule.revision, 'resume');
    const resumed = await (await api.call(path, resume, owner.token)).json();
    assert.ok(resumed.rule.nextDueDate >= today());
    generate(api, today());
    assert.ok((await entries()).every(e => e.occurredOn >= today()), 'no historical paused dates are backfilled');
    const next = (await list())[0].rule.nextDueDate;
    generate(api, next);
    const rows = await entries(); assert.ok(rows.some(e => e.occurredOn === next && e.amountMinor === -4000));
    const cursor = (await list())[0].rule.nextDueDate;
    await api.call(path, resume, owner.token);
    assert.equal((await list())[0].rule.nextDueDate, cursor, 'old resume receipt cannot rewind the cursor');
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringRules')[0].n, 1);
  } finally { await api.dispose(); }
});

test('migration preserves existing rules, original amount history and generated entries', async () => {
  const api = await createApi();
  try {
    const { owner, input, path, list, operation, entries } = await setup(api);
    generate(api, '2024-02-29');
    const original = await entries();
    await api.stop();
    // Recreate the exact pre-US-17 shape inside this isolated test database.
    api.execute('DROP TABLE RecurringAmounts');
    api.execute('DROP TABLE RecurringChanges');
    for (const column of ['AmountEffectiveFrom','Revision','Stopped']) api.execute(`ALTER TABLE RecurringRules DROP COLUMN ${column}`);
    api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%_ManageRecurringRules'");
    await api.start();
    // This fixture replays only the pre-US-17 rule migration; restore the
    // later retention-scoping column on the recreated receipt table.
    api.execute('ALTER TABLE RecurringChanges ADD COLUMN HouseholdId TEXT NULL REFERENCES Households(Id) ON DELETE CASCADE');
    const rule = (await list())[0].rule;
    assert.match(rule.revision, /^[a-f0-9]{32}$/); assert.equal(rule.stopped, false); assert.equal(rule.active, true);
    const versions = api.query('SELECT * FROM RecurringAmounts');
    assert.equal(versions.length, 1); assert.equal(versions[0].AmountMinor, input.amountMinor); assert.equal(versions[0].EffectiveFrom, '0001-01-01');
    assert.deepEqual(await entries(), original);
    assert.equal((await api.call(path, operation(rule.revision, 'amount', 2700), owner.token)).status, 200);
    generate(api, today());
    assert.ok((await entries()).every(e => e.amountMinor === -input.amountMinor));
    generate(api, (await list())[0].rule.nextDueDate);
    assert.ok((await entries()).some(e => e.amountMinor === -2700));
  } finally { await api.dispose(); }
});
