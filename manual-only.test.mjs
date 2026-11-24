import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from './helpers/api.mjs';
import { monthlySummary, monthlyTrends, shiftMonth } from '../mobile/src/monthlyBalance.ts';
import { spendingByCategory } from '../mobile/src/spendingByCategory.ts';
import { spendingByMember } from '../mobile/src/spendingByMember.ts';
import { transactionCsv } from '../mobile/src/transactionCsv.ts';

// The only configured external integration is public FX. It is deliberately
// unavailable here: same-currency manual budgets must work without it, too.
test('new EUR and USD households use manual transactions, reports and recurring entries with no external data', async () => {
  let externalCalls = 0;
  const external = createServer((_, response) => { externalCalls++; response.writeHead(503); response.end(); });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const api = await createApi({ env: { ExchangeRates__BaseUrl: `http://127.0.0.1:${external.address().port}/` } });
  try {
    await api.start();
    const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7), previous = shiftMonth(month, -1);
    const future = new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    const setups = [];
    for (const currency of ['EUR', 'USD']) {
      const register = async name => {
        const response = await api.call('auth/register', { email: `${name}-${currency}@example.com`, password: 'correct horse battery staple' });
        assert.equal(response.status, 201); return response.json();
      };
      const owner = await register('owner'), member = await register('member');
      const response = await api.call('households', { name: `Manual ${currency}`, baseCurrency: currency }, owner.token);
      assert.equal(response.status, 201);
      const household = await response.json(), path = `households/${household.id}`;
      assert.equal(household.budget.entries.length, 0);
      const invitation = await (await api.call('households/current/invites', {}, owner.token)).json();
      assert.equal((await api.call('invites/redeem', { code: invitation.code }, member.token)).status, 200);
      // These are exactly the manual-entry fields; no account balances, bank
      // identifiers, bank tokens or banking configuration have been supplied.
      for (const [type, amountMinor, category, occurredOn, actor] of [
        ['incomes', 100000, 'Salary', today, owner], ['expenses', 12500, 'Groceries', today, member],
        ['incomes', 5000, 'Gift', `${previous}-01`, owner], ['expenses', 1000, 'Transport', `${previous}-01`, member],
      ]) {
        const saved = await api.call(`${path}/${type}`, { id: randomUUID(), amountMinor, category, occurredOn, authorName: actor === owner ? 'Owner' : 'Member', note: 'Entered by hand' }, actor.token);
        assert.equal(saved.status, 201);
      }
      for (const [type, amountMinor, category] of [['Expense', 2500, 'Housing'], ['Income', 7000, 'Salary']]) {
        const rule = await api.call(`${path}/recurring`, { id: randomUUID(), amountMinor, currency, type, category, frequency: 'Monthly', startDate: today, dayOfMonth: Number(today.slice(8)) }, owner.token);
        assert.equal(rule.status, 201);
      }
      const upcomingId = randomUUID();
      assert.equal((await api.call(`${path}/recurring`, { id: upcomingId, amountMinor: 999, currency, type: 'Expense', category: 'Utilities', frequency: 'Monthly', startDate: future, dayOfMonth: Number(future.slice(8)) }, owner.token)).status, 201);
      setups.push({ owner, member, household, upcomingId, currency });
    }
    // Restart with the scheduler enabled; nobody needs to open the app to post due rules.
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    for (let attempt = 0; attempt < 100 && api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n < 4; attempt++) await delay(100);
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, 4);
    for (const { owner, member, household, upcomingId, currency } of setups) {
      const ownerState = await (await api.call('households/current', undefined, owner.token)).json();
      const memberState = await (await api.call('households/current', undefined, member.token)).json();
      assert.equal(ownerState.household.id, household.id);
      assert.equal(ownerState.household.baseCurrency, currency);
      const entries = ownerState.household.budget.entries;
      assert.deepEqual(memberState.household.budget.entries, entries);
      assert.equal(entries.length, 6);
      assert.deepEqual(monthlySummary(entries, month), { incomeMinor: 107000, expensesMinor: 15000, balanceMinor: 92000 });
      assert.deepEqual(monthlySummary(entries, previous), { incomeMinor: 5000, expensesMinor: 1000, balanceMinor: 4000 });
      assert.deepEqual(spendingByCategory(entries, month).categories.map(row => [row.category, row.amountMinor]), [['Groceries', 12500], ['Housing', 2500]]);
      assert.deepEqual(spendingByMember(entries, month).members.map(row => [row.memberId, row.amountMinor]), [[member.user.id, 12500], [owner.user.id, 2500]]);
      const trends = monthlyTrends(entries, month);
      assert.equal(trends.length, 12); assert.equal(trends[11].incomeMinor, 107000); assert.equal(trends[10].expensesMinor, 1000);
      const upcoming = ownerState.upcoming.items.find(item => item.ruleId === upcomingId);
      assert.equal(upcoming.dueDate, future); assert.equal(upcoming.amountMinor, 999);
      const csv = transactionCsv(entries, month, currency, key => key);
      assert.equal(csv.count, 4); assert.ok(csv.csv.includes(`"${currency}"`));
      assert.ok(entries.filter(entry => entry.recurringRuleId).every(entry => entry.originalCurrency === currency && entry.exchangeRate === 1));
    }
    assert.equal(externalCalls, 0, 'manual budgets and same-currency recurring rules must not call an external data service');
  } finally { await api.dispose(); await new Promise(resolve => external.close(resolve)); }
});

test('onboarding/settings expose no bank-linking flow or direct banking SDK dependency', () => {
  const files = ['mobile/App.tsx', ...readdirSync('mobile/src', { recursive: true }).filter(name => name.endsWith('.tsx')).map(name => `mobile/src/${name}`)];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:connect|link|import|sync)\s+(?:a\s+|your\s+)?bank(?:\s+account)?/i, file);
  }
  const manifest = JSON.parse(readFileSync('mobile/package.json', 'utf8'));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    assert.doesNotMatch(dependency, /plaid|truelayer|yapily|saltedge|nordigen|gocardless|(?:^|[-/])tink(?:$|[-/])/i);
  assert.doesNotMatch(readFileSync('backend/FamilyBudget.Api/FamilyBudget.Api.csproj', 'utf8'), /plaid|truelayer|yapily|saltedge|nordigen|gocardless/i);
});
