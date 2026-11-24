import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createApi } from './helpers/api.mjs';
import { budgetRetention } from '../mobile/src/budgetAccess.ts';
import { transactionCsv } from '../mobile/src/transactionCsv.ts';
const password = 'correct horse battery staple';
const day = 86400000, now = () => new Date().toISOString(), ago = n => new Date(Date.now() - n * day).toISOString();
const runner = resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll');
const policy = (row, date, trial = 30, paid = 90) => JSON.parse(execFileSync('dotnet', [runner, 'retention-policy', JSON.stringify(row), date, String(trial), String(paid)], { windowsHide: true, timeout: 30000 }).toString());
async function register(api, name) { const r = await api.call('auth/register', { email: `${name}@example.com`, password }); assert.equal(r.status, 201); return r.json(); }
async function setup(api) {
  await api.start(); const owner = await register(api, 'owner'), member = await register(api, 'member'), guest = await register(api, 'guest');
  const family = await (await api.call('households', { name: 'Family' }, owner.token)).json();
  const invitation = async () => (await (await api.call('households/current/invites', {}, owner.token)).json());
  await api.call('invites/redeem', { code: (await invitation()).code }, member.token);
  const unused = await invitation(), route = `households/${family.id}`;
  const input = { id: randomUUID(), amountMinor: 1000, category: 'Groceries', occurredOn: new Date().toISOString().slice(0,10), authorName: 'Private Name', note: 'Private note' };
  const entry = await (await api.call(`${route}/expenses`, input, member.token)).json();
  const ruleId = randomUUID();
  const rule = await (await api.call(`${route}/recurring`, { id: ruleId, amountMinor: 100, type: 'Expense', category: 'Housing', currency: 'EUR', frequency: 'Monthly', startDate: '2020-01-01', dayOfMonth: 1 }, owner.token)).json();
  const change = { operationId: randomUUID(), revision: rule.rule.revision, action: 'amount', amountMinor: 200 };
  const changed = await (await api.call(`${route}/recurring/${ruleId}/change`, change, owner.token)).json();
  return { owner, member, guest, family, route, unused, input, entry, rule: changed.rule };
}

test('trial expiry shows 30-day countdown to every member and blocks invites and all household mutations', async () => {
  const api = await createApi();
  try {
    const { owner, member, guest, route, unused, rule } = await setup(api);
    const end = ago(1); api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?', end);
    for (const actor of [owner, member]) {
      const state = await (await api.call('households/current', undefined, actor.token)).json();
      assert.equal(state.access.canWrite, false); assert.equal(state.access.retention.kind, 'Trial');
      assert.equal(state.access.retention.daysUntilDeletion, 29);
      assert.equal(Date.parse(state.access.retention.deletionAt), Date.parse(end) + 30 * day);
      assert.equal(transactionCsv(state.household.budget.entries, state.household.budget.entries[0].occurredOn.slice(0,7), 'EUR', k => k).count, 1);
      const members = await (await api.call('households/current/members', undefined, actor.token)).json();
      assert.equal(members.readOnly, true); assert.equal(members.canInvite, false);
    }
    const exported = await api.call('households/current/export', undefined, owner.token);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    const snapshot = await exported.json();
    assert.equal(snapshot.budget.entries.length, 1);
    assert.equal(snapshot.budget.entries[0].description, 'Private note');
    for (const actor of [member, guest]) assert.equal((await api.call('households/current/export', undefined, actor.token)).status, 403);
    assert.equal((await api.call('households/current/export')).status, 401);
    const invitesBefore = api.query('SELECT count(*) AS n FROM Invites')[0].n;
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 402);
    assert.equal((await api.call('invites/redeem', { code: unused.code }, guest.token)).status, 402);
    assert.equal(api.query('SELECT count(*) AS n FROM Invites')[0].n, invitesBefore);
    assert.equal((await api.call('households/current/member-limit', { limit: 3 }, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/members/${member.user.id}/remove`, {}, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/leave`, {}, member.token)).status, 402);
    for (const action of ['pause','stop','resume','amount']) assert.equal((await api.call(`${route}/recurring/${rule.id}/change`, { operationId: randomUUID(), revision: rule.revision, action, ...(action === 'amount' ? { amountMinor: 300 } : {}) }, owner.token)).status, 402);
    assert.equal((await api.call('account/data', { password }, member.token)).status, 200);
    await api.stop(); await api.start();
    const restored = await (await api.call('households/current', undefined, owner.token)).json();
    assert.equal(Date.parse(restored.access.retention.readOnlySince), Date.parse(end));
  } finally { await api.dispose(); }
});

test('retention policy has exact boundaries, paid/grace/cancellation semantics and configurable durations', () => {
  const row = { trialStartedAt: '2026-01-01T00:00:00Z', trialEndsAt: '2026-01-08T00:00:00Z' };
  assert.equal(policy(row, '2026-01-07T23:59:59Z'), null);
  const expired = policy(row, '2026-01-08T00:00:00Z');
  assert.equal(expired.daysUntilDeletion, 30); assert.equal(Date.parse(expired.deletionAt), Date.parse('2026-02-07T00:00:00Z'));
  assert.equal(policy(row, '2026-02-06T23:59:59Z').daysUntilDeletion, 1);
  assert.equal(policy(row, '2026-02-07T00:00:00Z').daysUntilDeletion, 0);
  const paid = { ...row, purchaseHash: 'verified', paidThrough: '2026-02-28T00:00:00Z', willRenew: false };
  assert.equal(policy(paid, '2026-02-27T00:00:00Z'), null, 'cancellation preserves remaining paid access');
  assert.equal(policy(paid, '2026-02-28T00:00:00Z').daysUntilDeletion, 90);
  const grace = { ...paid, graceThrough: '2026-03-05T00:00:00Z' };
  assert.equal(policy(grace, '2026-03-04T00:00:00Z'), null);
  assert.equal(policy(grace, '2026-03-05T00:00:00Z').daysUntilDeletion, 90);
  assert.equal(policy({ ...paid, paidThrough: '2027-01-01T00:00:00Z', revoked: true, accessRevokedAt: '2026-02-01T00:00:00Z' }, '2026-02-02T00:00:00Z').daysUntilDeletion, 89);
  assert.equal(policy(row, '2026-01-08T00:00:00Z', 2, 5).daysUntilDeletion, 2);
  assert.equal(policy(paid, '2026-02-28T00:00:00Z', 2, 5).daysUntilDeletion, 5);
});

test('offline countdown advances from cached verified dates without extending the deadline', () => {
  const access = { canWrite: true, trialEndsAt: '2026-01-08T00:00:00Z', paidThrough: null, graceThrough: null, revoked: false, hasPaid: false, retentionPolicy: { trialDays: 30, paidDays: 90 } };
  assert.equal(budgetRetention(access, Date.parse('2026-01-07T00:00:00Z')), null);
  assert.equal(budgetRetention(access, Date.parse('2026-01-08T00:00:00Z')).daysUntilDeletion, 30);
  assert.equal(budgetRetention(access, Date.parse('2026-02-07T00:00:00Z')).daysUntilDeletion, 0);
  assert.equal(budgetRetention({ ...access, retentionPolicy: { trialDays: 2, paidDays: 5 } }, Date.parse('2026-01-08T00:00:00Z')).daysUntilDeletion, 2);
});

test('cleanup removes expired household data and retry snapshots while retaining accounts and unrelated households', async () => {
  const api = await createApi({ env: { Retention__TrialDays: '2', Retention__PollSeconds: '1' } });
  try {
    const { owner, member, guest, family, route, input, rule } = await setup(api);
    const removed = await (await api.call(`${route}/expenses`, { ...input, id: randomUUID() }, owner.token)).json();
    await api.call(`${route}/transactions/${removed.id}/delete`, { revision: removed.revision }, owner.token);
    const other = await (await api.call('households', { name: 'Unrelated' }, guest.token)).json();
    api.execute('INSERT INTO RecurringOccurrences (RuleId,DueDate,EntryId) VALUES (?,?,?)',rule.id.toUpperCase(),input.occurredOn,input.id.toUpperCase());
    for (const stage of ['started','seven-days','one-day']) api.execute('INSERT INTO DeletionReminders (Id,HouseholdId,AccountId,DeletionAt,Stage,SentAt,RetryAt,Attempts) VALUES (?,?,?,?,?,?,?,?)', `sent-${stage}`,family.id.toUpperCase(),owner.user.id.toUpperCase(),ago(1),stage,now(),now(),1);
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ? WHERE HouseholdId = ?', ago(3), family.id.toUpperCase());
    await api.stop(); await api.start({ Retention__Enabled: 'true' });
    for (let i = 0; i < 100 && api.query(`SELECT count(*) AS n FROM Households WHERE Id = '${family.id.toUpperCase()}'`)[0].n; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await (await api.call('households/current', undefined, owner.token)).json()).household, null);
    assert.equal((await (await api.call('households/current', undefined, guest.token)).json()).household.id, other.id);
    for (const table of ['CreationReceipts','RecurringChanges','Invites','Memberships','Budgets','Categories','HouseholdSubscriptions','DeletionReminders']) assert.equal(api.query(`SELECT count(*) AS n FROM ${table} WHERE HouseholdId = '${family.id.toUpperCase()}'`)[0].n, 0, table);
    for (const table of ['Entries','RecurringRules','RecurringAmounts','RecurringOccurrences']) assert.equal(api.query(`SELECT count(*) AS n FROM ${table}`)[0].n, 0, table);
    assert.equal((await api.call('auth/me', undefined, owner.token)).status, 200, 'account deletion is a separate privacy action');
    assert.equal((await api.call('auth/me', undefined, member.token)).status, 200);
    const audit = api.query('SELECT * FROM RetentionAudits');
    assert.equal(audit.length, 1);
    assert.deepEqual(Object.keys(audit[0]).sort(), ['DayUtc','DeletedHouseholds']);
    assert.equal(audit[0].DeletedHouseholds, 1);
    assert.equal(audit[0].DayUtc, new Date().toISOString().slice(0,10));
    assert.equal((await api.call('households/current/export', undefined, owner.token)).status, 403);
    assert.equal((await api.call(`${route}/expenses`, input, member.token)).status, 403);
    // Cleanup is idempotent on restart, with no duplicate audit count.
    await api.stop(); await api.start({ Retention__Enabled: 'true' });
    assert.equal(api.query('SELECT DeletedHouseholds FROM RetentionAudits')[0].DeletedHouseholds, 1);
    const fresh = await api.call('households', { name: 'New start' }, owner.token);
    assert.equal(fresh.status, 201);
    const invitation = await (await api.call('households/current/invites', {}, guest.token)).json();
    assert.equal((await api.call('invites/redeem', { code: invitation.code }, member.token)).status, 200);
    // Later deletions aggregate into the same anonymous day row.
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',ago(3));
    for(let i=0;i<100 && api.query('SELECT count(*) n FROM Households')[0].n;i++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(api.query('SELECT count(*) n FROM Households')[0].n,0);
    assert.equal(api.query('SELECT count(*) n FROM RetentionAudits')[0].n,1);
    assert.equal(api.query('SELECT DeletedHouseholds FROM RetentionAudits')[0].DeletedHouseholds,3);


    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});

test('paid households retain 90 days and custom paid retention is exposed by the back end', async () => {
  const api = await createApi({ env: { Retention__PaidDays: '5' } });
  try {
    const { owner, family } = await setup(api);
    const ended = ago(2);
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?, PaidThrough = ?, PurchaseHash = ?, VerifiedAt = ?, WillRenew = 0 WHERE HouseholdId = ?', ago(30), ended, 'verified-purchase', now(), family.id.toUpperCase());
    const state = await (await api.call('households/current', undefined, owner.token)).json();
    assert.equal(state.access.retention.kind, 'Paid'); assert.equal(state.access.retention.daysUntilDeletion, 3);
    assert.equal(Date.parse(state.access.retention.deletionAt), Date.parse(ended) + 5 * day);
  } finally { await api.dispose(); }
});

test('retention migration scopes existing snapshots and minimizes legacy deleted-entry acknowledgments', async () => {
  const api = await createApi();
  try {
    const { owner, member, family, route, input, entry } = await setup(api);
    const deletedInput = { ...input, id: randomUUID() };
    const deleted = await (await api.call(`${route}/expenses`, deletedInput, member.token)).json();
    assert.equal((await api.call(`${route}/transactions/${deleted.id}/delete`, { revision: deleted.revision }, member.token)).status, 204);
    await api.stop();
    for (const table of ['CreationReceipts','RecurringChanges']) {
      api.execute(`ALTER TABLE ${table} RENAME TO Prior${table}`);
      api.execute(`CREATE TABLE ${table} (Id TEXT NOT NULL PRIMARY KEY, PayloadHash TEXT NOT NULL, Response TEXT NOT NULL)`);
      api.execute(`INSERT INTO ${table} SELECT Id,PayloadHash,Response FROM Prior${table}`);
      api.execute(`DROP TABLE Prior${table}`);
    }
    // Rewind the later receipt/index migration as well: the recreated receipt
    // table deliberately has the historical shape without an author column.
    api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%_QueryIndexesAndReceiptAuthors'");
    api.execute('DROP INDEX IX_Entries_AuthorAccountId_OccurredOn');
    api.execute('DROP INDEX IX_Entries_BudgetId_OccurredOn_Id');
    api.execute('CREATE INDEX IX_Entries_AuthorAccountId ON Entries(AuthorAccountId)');
    api.execute('CREATE INDEX IX_Entries_BudgetId ON Entries(BudgetId)');
    api.execute('ALTER TABLE HouseholdSubscriptions DROP COLUMN AccessRevokedAt');
    api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%_HouseholdRetention'");
    await api.start();
    const scoped = api.query(`SELECT * FROM CreationReceipts WHERE Id = '${entry.id.toUpperCase()}'`)[0];
    assert.equal(scoped.HouseholdId, family.id.toUpperCase());
    const orphan = api.query(`SELECT * FROM CreationReceipts WHERE Id = '${deleted.id.toUpperCase()}'`)[0];
    assert.equal(orphan.HouseholdId, null); assert.deepEqual(JSON.parse(orphan.Response), { id: deleted.id, deleted: true });
    assert.ok(api.query('SELECT * FROM RecurringChanges').every(row => row.HouseholdId === family.id.toUpperCase()));
    assert.equal((await api.call(`${route}/expenses`, deletedInput, member.token)).status, 200);
    assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, 1, 'legacy acknowledgment cannot recreate a deleted entry');
    assert.equal((await api.call('account/data', { password }, owner.token)).status, 200);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});


test('deletion and anonymous audit commit together, and failed reminders do not postpone cleanup', async () => {
  const api = await createApi({ env: { Retention__TrialDays:'2', Retention__PollSeconds:'1' } });
  try {
    const { owner, family } = await setup(api);
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?', ago(3));
    api.execute("CREATE TRIGGER BlockAudit BEFORE INSERT ON RetentionAudits BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    await api.stop(); await api.start({ Retention__Enabled:'true' });
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(api.query('SELECT count(*) n FROM Households')[0].n,1,'audit failure rolls back the cascade');
    assert.equal(api.query('SELECT count(*) n FROM Entries')[0].n,1);
    assert.equal(api.query('SELECT count(*) n FROM RetentionAudits')[0].n,0);
    // A failed email is deliberately not a prerequisite for expiry.
    api.execute('INSERT INTO DeletionReminders (Id,HouseholdId,AccountId,DeletionAt,Stage,SentAt,RetryAt,Attempts) VALUES (?,?,?,?,?,NULL,?,?)', 'failed-fixture', family.id.toUpperCase(), owner.user.id.toUpperCase(), ago(1), 'one-day', ago(1), 3);
    api.execute('DROP TRIGGER BlockAudit');
    for(let i=0;i<100 && api.query('SELECT count(*) n FROM Households')[0].n;i++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(api.query('SELECT count(*) n FROM Households')[0].n,0);
    assert.equal(api.query('SELECT count(*) n FROM DeletionReminders')[0].n,0);
    assert.equal(api.query('SELECT DeletedHouseholds FROM RetentionAudits')[0].DeletedHouseholds,1);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
  } finally { await api.dispose(); }
});

test('public privacy policy reflects configured trial and paid periods and a 35-day backup maximum', async()=>{
  const api=await createApi({env:{Retention__TrialDays:'12',Retention__PaidDays:'48'}});
  try { await api.start(); const response=await api.call('privacy-policy'); assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{version:'2026-11-17',trialRetentionDays:12,paidRetentionDays:48,backupMaximumDays:35});
  } finally {await api.dispose();}
});
