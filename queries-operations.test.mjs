import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';

const password = 'Family-budget-123!';
test('filtered transaction pages and database reports preserve the shared snapshot contract', async () => {
  const api = await createApi();
  try {
    await api.start();
    const register = async name => (await api.call('auth/register', {email: `${name}@example.com`, password})).json();
    const owner = await register('owner'), other = await register('other');
    const house = await (await api.call('households', {name:'Family'}, owner.token)).json();
    const root = `households/${house.id}`;
    for (const [kind, amount, category, date] of [['incomes',10000,'Salary','2026-11-01'],['expenses',3000,'Groceries','2026-11-12'],['expenses',1000,'Transport','2026-11-12'],['expenses',99,'Groceries','2026-10-31']]) {
      assert.equal((await api.call(`${root}/${kind}`, {id:randomUUID(),amountMinor:amount,category,occurredOn:date,authorName:'Owner'},owner.token)).status,201);
    }
    assert.equal((await api.call(`${root}/transactions`)).status,401);
    assert.equal((await api.call(`${root}/transactions`,undefined,other.token)).status,403);
    const get = async path => { const r=await api.call(`${root}/${path}`,undefined,owner.token); assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store'); return r.json(); };
    const first = await get('transactions?month=2026-11&limit=2');
    const second = await get('transactions?month=2026-11&limit=2&offset=2');
    assert.equal(first.items.length,2); assert.equal(first.hasMore,true); assert.equal(second.items.length,1); assert.equal(second.hasMore,false);
    assert.equal(new Set([...first.items,...second.items].map(e=>e.id)).size,3);
    assert.equal(first.items[0].occurredOn,'2026-11-12');
    assert.equal((await get(`transactions?month=2026-11&category=Groceries&member=${owner.user.id}`)).items.length,1);
    const report=await get('reports/monthly?month=2026-11');
    assert.deepEqual([report.incomeMinor,report.expensesMinor,report.balanceMinor],[10000,4000,6000]);
    assert.deepEqual(report.categories.map(c=>[c.category,c.amountMinor,c.percentage]),[['Groceries',3000,75],['Transport',1000,25]]);
    const empty=await get('reports/monthly?month=2026-09'); assert.equal(empty.balanceMinor,0); assert.deepEqual(empty.categories,[]);
    for (const query of ['transactions?limit=201','transactions?offset=-1','transactions?month=bad','reports/monthly?month=9999-12']) {
      const r=await api.call(`${root}/${query}`,undefined,owner.token); assert.equal(r.status,400); assert.ok((await r.json()).errors);
    }
    const legacy=await (await api.call('households/current',undefined,owner.token)).json(); assert.equal(legacy.household.budget.entries.length,4);
    const exported=await (await api.call('account/data',{password},owner.token)).json(); assert.equal(exported.transactionCreationSnapshots.length,4);
    assert.ok(api.query('SELECT AuthorAccountId FROM CreationReceipts').every(r=>r.AuthorAccountId.toLowerCase()===owner.user.id.toLowerCase()));
    for(const endpoint of ['../health/live','../health/ready']) assert.equal((await api.call(endpoint)).status,200);
    const spec=await (await api.call('../openapi/v1.json')).json();
    assert.ok(spec.paths['/api/households/{householdId}/transactions'].get.responses['200'].content['application/json']);
    assert.ok(spec.components.schemas.TransactionPage);
    assert.ok(!api.logs().includes('Job backlog-metrics item'), api.logs());
    const budget=api.query('SELECT Id FROM Budgets')[0].Id;
    const plan=api.query(`EXPLAIN QUERY PLAN SELECT Id FROM Entries WHERE BudgetId = '${budget}' AND OccurredOn >= '2026-11-01' AND OccurredOn < '2026-12-01'`);
    assert.ok(plan.some(row=>row.detail.includes('IX_Entries_BudgetId_OccurredOn_Id')));
  } finally { await api.dispose(); }
});

test('receipt author migration backfills deleted transaction snapshots and readiness detects schema drift', async () => {
 const api=await createApi();
 try {
  await api.start(); await api.stop();
  // Recreate the exact pre-Phase-5 receipt table and remove only the new migrations.
  api.execute('DROP TABLE CreationReceipts');
  api.execute('CREATE TABLE CreationReceipts (Id TEXT NOT NULL PRIMARY KEY, HouseholdId TEXT NULL REFERENCES Households(Id) ON DELETE CASCADE, PayloadHash TEXT NOT NULL, Response TEXT NOT NULL)');
  api.execute('CREATE INDEX IX_CreationReceipts_HouseholdId ON CreationReceipts(HouseholdId)');
  const author=randomUUID(), id=randomUUID();
  api.execute('INSERT INTO CreationReceipts VALUES (?,NULL,?,?)',id.toUpperCase(),'hash',JSON.stringify({authorAccountId:author,authorName:'Deleted entry'}));
  api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%QueryIndexesAndReceiptAuthors'");
  // Only reapply receipt migration; push migration remains applied.
  api.execute('DROP INDEX IX_Entries_AuthorAccountId_OccurredOn'); api.execute('DROP INDEX IX_Entries_BudgetId_OccurredOn_Id');
  api.execute('CREATE INDEX IX_Entries_AuthorAccountId ON Entries(AuthorAccountId)'); api.execute('CREATE INDEX IX_Entries_BudgetId ON Entries(BudgetId)');
  await api.start(); assert.equal(api.query('SELECT AuthorAccountId FROM CreationReceipts')[0].AuthorAccountId,author.toUpperCase());
  api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%IndexedPushRetryTimes'");
  assert.equal((await api.call('../health/ready')).status,503); assert.equal((await api.call('../health/live')).status,200);
 } finally { await api.dispose(); }
});


test('controlled migrations reject a pending schema and allow a pre-migrated database', async () => {
 const fresh=await createApi({env:{Operations__MigrateOnStartup:'false'}});
 try { await assert.rejects(fresh.start(), /migrations must be applied/); } finally { await fresh.dispose(); }
 const ready=await createApi();
 try { await ready.start(); await ready.stop(); await ready.start({Operations__MigrateOnStartup:'false'}); assert.equal((await ready.call('../health/ready')).status,200); }
 finally { await ready.dispose(); }
});


test('request binding errors stay 400 and unexpected failures return safe ProblemDetails', async () => {
 const api=await createApi();
 try {
  await api.start(); const owner=await (await api.call('auth/register',{email:'owner@example.com',password})).json();
  const house=await (await api.call('households',{name:'Family'},owner.token)).json();
  const invalid=await api.call(`households/${house.id}/expenses`,{id:randomUUID(),amountMinor:1.5,category:'Groceries',occurredOn:'2026-11-01',authorName:'Owner',note:'Private note'},owner.token);
  assert.equal(invalid.status,400); assert.match(invalid.headers.get('content-type'),/application\/problem\+json/);
  assert.ok(!(await invalid.text()).includes('Private note'));
  api.execute('DROP TABLE Entries');
  const failed=await api.call(`households/${house.id}/transactions`,undefined,owner.token);
  assert.equal(failed.status,500); const problem=await failed.json(); assert.equal(problem.status,500); assert.ok(problem.traceId); assert.ok(!JSON.stringify(problem).includes('SQLite'));
 } finally { await api.dispose(); }
});
