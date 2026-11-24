import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createApi } from './helpers/api.mjs';
async function until(check, message) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(100); }
  assert.fail(message);
}
const today = () => new Date().toISOString().slice(0,10);
function expectedDates(start, day) {
  const dates = [];
  for (let year = Number(start.slice(0,4)), month = Number(start.slice(5,7)); ; ) {
    const date = `${year}-${String(month).padStart(2,'0')}-${String(Math.min(day,new Date(Date.UTC(year, month,0)).getUTCDate())).padStart(2,'0')}`;
    if (date > today()) break;
    if (date >= start) dates.push(date);
    if (++month === 13) { month = 1; year++; }
  }
  return dates;
}
async function setup(api) {
  await api.start();
  const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
  const owner = await reg('owner@example.com'), member = await reg('member@example.com');
  const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
  const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
  await api.call('invites/redeem', { code: invite.code }, member.token);
  return { owner, member, household, route: `households/${household.id}/recurring` };
}
const input = () => ({ id: randomUUID(), amountMinor: 12345, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: '2024-01-01', dayOfMonth: 31 });
test('background scheduler catches up without an app, clamps dates, skips inactive rules, and never recreates edited/deleted entries', async () => {
  const api = await createApi();
  try {
    const { owner, member, household, route } = await setup(api);
    const rule = input(), inactive = input();
    assert.equal((await api.call(route, rule, owner.token)).status, 201);
    await api.call(route, inactive, owner.token);
    const current = { ...input(), id: randomUUID(), startDate: today(), dayOfMonth: new Date().getUTCDate(), type: 'Income', category: 'Salary' };
    await api.call(route, current, owner.token);
    await api.call(`households/${household.id}/categories/archive`, { key: 'Housing', type: 'Expense' }, owner.token);
    await api.stop();
    api.execute('UPDATE RecurringRules SET Active = 0 WHERE Id = ?', inactive.id.toUpperCase());
    // Emulate a pre-US-16 rule: a null cursor must start at its original date.
    api.execute('UPDATE RecurringRules SET NextDueDate = NULL WHERE Id = ?', rule.id.toUpperCase());
    await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    await api.startReplica();
    const due = expectedDates(rule.startDate, rule.dayOfMonth);
    // Inspect database only: no member opens the app or calls a household endpoint to trigger generation.
    await until(() => api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n === due.length + 1, 'scheduler did not finish catch-up');
    const rows = api.query('SELECT * FROM Entries ORDER BY OccurredOn');
    assert.equal(rows.length, due.length + 1);
    assert.deepEqual(rows.filter(r => r.RecurringRuleId === rule.id.toUpperCase()).map(r => r.OccurredOn), due);
    assert.ok(due.includes('2024-02-29')); assert.ok(due.includes('2025-02-28')); assert.ok(due.includes('2024-04-30'));
    assert.ok(rows.every(r => r.AuthorAccountId === owner.user.id.toUpperCase()));
    const state = await (await api.call('households/current', undefined, member.token)).json();
    assert.equal(state.household.budget.entries.length, rows.length);
    assert.ok(state.household.budget.entries.every(r => r.recurringRuleId && r.recurringDueDate));
    assert.equal(state.household.budget.entries.find(r => r.recurringRuleId === current.id).amountMinor, 12345);
    const entry = state.household.budget.entries.find(r => r.recurringRuleId === rule.id);
    const path = `households/${household.id}/transactions/${entry.id}`;
    const edited = await (await api.call(`${path}/edit`, { revision: entry.revision, amountMinor: 333, category: entry.category, occurredOn: entry.occurredOn, note: 'Corrected' }, owner.token)).json();
    assert.equal(edited.recurringRuleId, rule.id);
    assert.equal((await api.call(`${path}/delete`, { revision: edited.revision }, owner.token)).status, 204);
    await delay(2200);
    assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, rows.length - 1);
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, rows.length);
    // Even rewinding the cursor must honor the durable occurrence receipt after deletion.
    api.execute('UPDATE RecurringRules SET NextDueDate = ? WHERE Id = ?', entry.recurringDueDate, rule.id.toUpperCase());
    await delay(2200);
    assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, rows.length - 1);
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    await delay(1200);
    assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, rows.length - 1);
  } finally { await api.dispose(); }
});

test('dated ECB conversion retries failures, snapshots original USD and rounded EUR, and preserves totals and rates across restart', async () => {
  let fail = true;
  const requested = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requested.push(url);
    if (fail) { res.writeHead(503).end(); return; }
    const date = new Date(url.searchParams.get('date') + 'T12:00:00Z');
    while ([0,6].includes(date.getUTCDay()) || date.toISOString().slice(0,10) === '2024-03-29') date.setUTCDate(date.getUTCDate()-1);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ date: date.toISOString().slice(0,10), base: 'USD', quote: 'EUR', rate: 0.925 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = await createApi({ env: { ExchangeRates__BaseUrl: `http://127.0.0.1:${server.address().port}/` } });
  try {
    const { owner, member, household, route } = await setup(api);
    const rule = { ...input(), currency: 'USD', amountMinor: 101, startDate: '2024-01-01' };
    await api.call(route, rule, owner.token);
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    await until(() => requested.length > 0, 'no rate request');
    assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, 0);
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, 0);
    fail = false;
    const due = expectedDates(rule.startDate, 31);
    await until(() => api.query('SELECT count(*) AS n FROM Entries')[0].n === due.length, 'FX retry did not generate catch-up');
    const state = await (await api.call('households/current', undefined, member.token)).json();
    const entries = state.household.budget.entries;
    assert.ok(entries.every(e => e.amountMinor === -93 && e.originalAmountMinor === 101 && e.originalCurrency === 'USD' && e.exchangeRate === 0.925 && e.rateSource === 'ECB via Frankfurter'));
    assert.equal(entries.find(e => e.occurredOn === '2024-03-31').rateDate, '2024-03-28');
    assert.ok(requested.every(u => u.pathname === '/rate/usd/eur' && u.searchParams.get('date')));
    assert.equal(api.query('SELECT count(*) AS n FROM ExchangeRates')[0].n, due.length);
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    await delay(1200);
    const after = await (await api.call('households/current', undefined, owner.token)).json();
    assert.deepEqual(after.household.budget.entries, entries);
    assert.equal(entries.reduce((sum,e) => sum + e.amountMinor,0), -93 * due.length);
  } finally { await api.dispose(); await new Promise(resolve => server.close(resolve)); }
});

test('invalid rate data stays pending while unrelated rules generate, then recovers', async () => {
  let mode = 'future';
  const hits = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.set(mode, (hits.get(mode) ?? 0) + 1);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ date: mode === 'future' ? '9999-01-01' : url.searchParams.get('date'), base: mode === 'wrong-pair' ? 'EUR' : 'USD', quote: 'EUR', rate: mode === 'negative' ? -1 : 0.5 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = await createApi({ env: { ExchangeRates__BaseUrl: `http://127.0.0.1:${server.address().port}/` } });
  try {
    const { owner, route } = await setup(api);
    const year = new Date().getUTCFullYear(), month = new Date().getUTCMonth();
    const previous = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0,10);
    const fx = { ...input(), currency: 'USD', amountMinor: 101, startDate: previous };
    const valid = { ...input(), startDate: today(), dayOfMonth: new Date().getUTCDate() };
    await api.call(route, fx, owner.token); await api.call(route, valid, owner.token);
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    await until(() => api.query('SELECT count(*) AS n FROM Entries')[0].n === 1, 'unrelated rule blocked by rate error');
    for (const value of ['future','negative','wrong-pair']) {
      mode = value;
      await until(() => (hits.get(value) ?? 0) > 0, `${value} not requested`);
      await delay(200);
      assert.equal(api.query('SELECT count(*) AS n FROM Entries')[0].n, 1);
      assert.equal(api.query('SELECT count(*) AS n FROM ExchangeRates')[0].n, 0);
    }
    mode = 'valid';
    await until(() => api.query('SELECT count(*) AS n FROM Entries')[0].n >= 2, 'valid quote did not recover');
    const entry = api.query(`SELECT * FROM Entries WHERE OriginalCurrency = 'USD'`)[0];
    assert.equal(entry.AmountMinor, -51, 'round half cents away from zero');
  } finally { await api.dispose(); await new Promise(resolve => server.close(resolve)); }
});
