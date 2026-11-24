import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { monthlySummary } from '../mobile/src/monthlyBalance.ts';

const password = 'correct horse battery staple';
const former = '00000000-0000-0000-0000-000000000001';
async function register(api, email) {
  const response = await api.call('auth/register', { email, password }); assert.equal(response.status, 201); return response.json();
}
async function household(api, owner, name) { return (await api.call('households', { name }, owner.token)).json(); }
async function join(api, owner, member) {
  const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
  assert.equal((await api.call('invites/redeem', { code: invite.code }, member.token)).status, 200);
}
async function expense(api, family, actor, note = 'Private note for erasure') {
  const response = await api.call(`households/${family.id}/expenses`, { id: randomUUID(), amountMinor: 1234, category: 'Groceries', occurredOn: '2026-11-16', note, authorName: 'Private person name' }, actor.token);
  assert.equal(response.status, 201); return response.json();
}

test('password-confirmed member deletion erases account/sessions, anonymizes all household history and retry snapshots', async () => {
  const api = await createApi();
  try {
    await api.start();
    const ownerA = await register(api, 'owner-a@example.com'), ownerB = await register(api, 'owner-b@example.com'), member = await register(api, 'private-person@example.com');
    const secondSession = await (await api.call('auth/login', { email: member.user.email, password })).json();
    const a = await household(api, ownerA, 'A'), b = await household(api, ownerB, 'B');
    await join(api, ownerA, member);
    const historic = await expense(api, a, member), deletedEntry = await expense(api, a, member);
    assert.equal((await api.call(`households/${a.id}/transactions/${deletedEntry.id}/delete`, { revision: deletedEntry.revision }, member.token)).status, 204);
    await api.call(`households/${a.id}/members/${member.user.id}/remove`, {}, ownerA.token);
    await join(api, ownerB, member);
    const current = await expense(api, b, member);
    const otherEntry = await expense(api, b, ownerB, 'Owner note stays');
    assert.equal((await api.call('account/delete', { password })).status, 401);
    assert.equal((await api.call('account/data', { password })).status, 401);
    assert.equal((await api.call('account/delete', { password: 'wrong' }, member.token)).status, 403);
    assert.equal((await api.call('account/data', { password: '' }, member.token)).status, 403);
    assert.equal((await api.call('account/delete', { password, accountId: ownerA.user.id }, member.token)).status, 409, 'stale settings must not delete a different signed-in account');
    const response = await api.call('account/data', { password }, member.token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const personal = await response.json();
    assert.equal(personal.account.email, member.user.email);
    assert.deepEqual(personal.transactions.map(e => e.id).sort(), [historic.id, current.id].sort());
    assert.equal(personal.transactionCreationSnapshots.length, 3); assert.equal(personal.sessionExpirations.length, 2);
    assert.equal(personal.budgets.length, 2); assert.ok(!JSON.stringify(personal).includes(otherEntry.id));
    assert.ok(!/passwordHash|tokenHash|codeHash|normalizedEmail/i.test(JSON.stringify(personal)));
    assert.equal((await api.call('account/delete', { password }, member.token)).status, 204);
    for (const token of [member.token, secondSession.token]) {
      assert.equal((await api.call('auth/me', undefined, token)).status, 401);
      assert.equal((await api.call('account/data', { password }, token)).status, 401);
    }
    assert.equal(api.query(`SELECT count(*) AS n FROM Accounts WHERE Id = '${member.user.id.toUpperCase()}'`)[0].n, 0);
    assert.equal(api.query(`SELECT count(*) AS n FROM Memberships WHERE AccountId = '${member.user.id.toUpperCase()}'`)[0].n, 0);
    assert.equal(api.query(`SELECT count(*) AS n FROM Sessions WHERE AccountId = '${member.user.id.toUpperCase()}'`)[0].n, 0);
    for (const [owner, expectedId] of [[ownerA, historic.id], [ownerB, current.id]]) {
      const state = await (await api.call('households/current', undefined, owner.token)).json();
      const row = state.household.budget.entries.find(e => e.id === expectedId);
      assert.equal(row.authorName, 'Former member'); assert.equal(row.authorAccountId, former); assert.equal(row.description, ''); assert.equal(row.amountMinor, -1234);
    }
    const state = await (await api.call('households/current', undefined, ownerB.token)).json();
    assert.equal(monthlySummary(state.household.budget.entries, '2026-11').expensesMinor, 2468);
    assert.equal(state.household.budget.entries.find(e => e.id === otherEntry.id).description, 'Owner note stays');
    const receipts = api.query('SELECT * FROM CreationReceipts');
    for (const id of [historic.id, current.id, deletedEntry.id]) {
      const receipt = receipts.find(r => r.Id.toLowerCase() === id), data = JSON.parse(receipt.Response);
      assert.equal(data.authorName, 'Former member'); assert.equal(data.description, ''); assert.equal(data.authorAccountId, former);
      assert.ok(!receipt.Response.includes(member.user.id));
    }
    assert.ok(!api.query('SELECT * FROM Invites').some(invite => invite.ConsumedByAccountId === member.user.id.toUpperCase()));
    await api.stop(); await api.start();
    assert.equal((await api.call('auth/login', { email: member.user.email, password })).status, 401);
    const recreated = await register(api, member.user.email);
    assert.notEqual(recreated.user.id, member.user.id);
    assert.equal((await (await api.call('households/current', undefined, recreated.token)).json()).household, null);
  } finally { await api.dispose(); }
});

test('owner must choose an actual successor; handover preserves shared budget and transfers recurring generation', async () => {
  const api = await createApi();
  try {
    await api.start();
    const owner = await register(api, 'owner@example.com'), member = await register(api, 'member@example.com'), outsider = await register(api, 'outsider@example.com');
    const family = await household(api, owner, 'Family'); await join(api, owner, member);
    await expense(api, family, owner);
    const today = new Date().toISOString().slice(0, 10), ruleId = randomUUID();
    const route = `households/${family.id}/recurring`;
    const rule = await (await api.call(route, { id: ruleId, amountMinor: 100, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: today, dayOfMonth: Number(today.slice(8)) }, owner.token)).json();
    assert.equal((await api.call(`${route}/${ruleId}/change`, { operationId: randomUUID(), revision: rule.rule.revision, action: 'amount', amountMinor: 200 }, owner.token)).status, 200);
    for (const successorId of [null, owner.user.id, outsider.user.id, randomUUID()]) {
      const response = await api.call('account/delete', { password, successorId }, owner.token);
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'successor_required');
      assert.equal((await api.call('auth/me', undefined, owner.token)).status, 200);
    }
    assert.equal((await api.call('account/delete', { password, successorId: member.user.id }, owner.token)).status, 204);
    const state = await (await api.call('households/current', undefined, member.token)).json();
    assert.equal(state.household.role, 'Owner'); assert.equal(state.household.budget.entries[0].authorName, 'Former member');
    const list = await (await api.call(route, undefined, member.token)).json();
    assert.equal(list[0].rule.createdByAccountId, member.user.id); assert.equal(list[0].rule.active, true);
    for (const receipt of api.query('SELECT Response FROM RecurringChanges')) {
      assert.ok(!receipt.Response.toLowerCase().includes(owner.user.id));
      assert.equal(JSON.parse(receipt.Response).rule.createdByAccountId, former);
    }
    await api.stop(); await api.start({ Recurring__Enabled: 'true', Recurring__PollSeconds: '1' });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !api.query('SELECT * FROM RecurringOccurrences').length) await new Promise(resolve => setTimeout(resolve, 100));
    const generated = api.query('SELECT * FROM Entries WHERE RecurringRuleId IS NOT NULL');
    assert.equal(generated.length, 1); assert.equal(generated[0].AuthorAccountId, member.user.id.toUpperCase());
    assert.equal(generated[0].AuthorName, member.user.email);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});

test('sole owner deletion removes the household and rules; an account without a household can delete too', async () => {
  const api = await createApi();
  try {
    await api.start();
    const owner = await register(api, 'solo@example.com'), independent = await register(api, 'independent@example.com');
    const family = await household(api, owner, 'Solo'); const ownEntry = await expense(api, family, owner);
    assert.equal((await api.call(`households/${family.id}/recurring`, { id: randomUUID(), amountMinor: 100, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: '2099-01-01', dayOfMonth: 1 }, owner.token)).status, 201);
    assert.equal((await api.call('account/delete', { password }, owner.token)).status, 409, 'sole owner must explicitly acknowledge household deletion');
    assert.equal((await api.call('account/delete', { password, deleteHousehold: true }, owner.token)).status, 204);
    for (const table of ['Households', 'Budgets', 'Entries', 'RecurringRules', 'Memberships']) assert.equal(api.query(`SELECT count(*) AS n FROM ${table}`)[0].n, 0, table);
    const receipt = api.query('SELECT * FROM CreationReceipts').find(r => r.Id.toLowerCase() === ownEntry.id);
    assert.equal(receipt, undefined, 'household deletion also removes its retry snapshots');
    assert.equal((await api.call('account/delete', { password }, independent.token)).status, 204);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});
import { DatabaseSync } from 'node:sqlite';
import { initOffline, eraseLocalAccount, enqueue } from '../mobile/src/outbox.ts';

test('device erasure clears shared caches and only the deleting account pending entries', () => {
  const raw = new DatabaseSync(':memory:');
  const db = { execSync: sql => raw.exec(sql), runSync: (sql, ...p) => raw.prepare(sql).run(...p), getAllSync: (sql, ...p) => raw.prepare(sql).all(...p), getFirstSync: (sql, ...p) => raw.prepare(sql).get(...p) ?? null };
  try {
    initOffline(db);
    for (const account of ['deleting', 'other']) {
      db.runSync('INSERT INTO cache VALUES (?,?,?)', account, 'households/current', JSON.stringify({ privateName: 'cached deleted member' }));
      enqueue(db, account, 'household', 'Expense', { id: randomUUID(), amountMinor: 100, category: 'Groceries', occurredOn: '2026-11-16', authorName: account, note: 'Pending private note' });
    }
    eraseLocalAccount(db, 'deleting');
    assert.equal(db.getAllSync('SELECT * FROM cache').length, 0);
    const remaining = db.getAllSync('SELECT * FROM outbox');
    assert.equal(remaining.length, 1); assert.equal(remaining[0].accountId, 'other');
    eraseLocalAccount(db, 'deleting');
    assert.equal(db.getAllSync('SELECT * FROM outbox').length, 1, 'cleanup is safe to retry');
  } finally { raw.close(); }
});

test('deletion racing a manual upload cannot retain or recreate deleted identity', async () => {
  const api = await createApi();
  try {
    await api.start();
    const owner = await register(api, 'owner@example.com'), member = await register(api, 'member@example.com');
    const family = await household(api, owner, 'Family'); await join(api, owner, member);
    const payload = { id: randomUUID(), amountMinor: 100, category: 'Groceries', occurredOn: '2026-11-16', authorName: 'Erase this name', note: 'Erase this note' };
    const [deletion, upload] = await Promise.all([
      api.call('account/delete', { password }, member.token),
      api.call(`households/${family.id}/expenses`, payload, member.token),
    ]);
    assert.equal(deletion.status, 204); assert.ok([201, 401, 403].includes(upload.status));
    assert.equal((await api.call(`households/${family.id}/expenses`, payload, member.token)).status, 401);
    for (const entry of api.query('SELECT * FROM Entries')) {
      assert.notEqual(entry.AuthorAccountId, member.user.id.toUpperCase());
      assert.equal(entry.AuthorName, 'Former member'); assert.equal(entry.Description, '');
    }
    assert.ok(!JSON.stringify(api.query('SELECT * FROM CreationReceipts')).includes('Erase this'));
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});

test('successor departure racing deletion never leaves an ownerless household', async () => {
  const api = await createApi();
  try {
    await api.start();
    const owner = await register(api, 'owner@example.com'), member = await register(api, 'member@example.com');
    const family = await household(api, owner, 'Family'); await join(api, owner, member);
    const [deletion, departure] = await Promise.all([
      api.call('account/delete', { password, successorId: member.user.id }, owner.token),
      api.call(`households/${family.id}/leave`, {}, member.token),
    ]);
    assert.ok([204, 409].includes(deletion.status));
    assert.ok([200, 204, 409].includes(departure.status));
    const memberships = api.query('SELECT * FROM Memberships');
    assert.equal(memberships.filter(m => m.Role === 'Owner').length, 1);
    if (deletion.status === 204) {
      assert.equal(memberships[0].AccountId, member.user.id.toUpperCase()); assert.equal(departure.status, 409);
    } else assert.ok(memberships.some(m => m.AccountId === owner.user.id.toUpperCase() && m.Role === 'Owner'));
  } finally { await api.dispose(); }
});

test('two accounts deleting concurrently cannot silently delete the shared budget after promotion', async () => {
  const api = await createApi();
  try {
    await api.start();
    const owner = await register(api, 'owner@example.com'), member = await register(api, 'member@example.com');
    const family = await household(api, owner, 'Family'); await join(api, owner, member);
    const [ownerDelete, memberDelete] = await Promise.all([
      api.call('account/delete', { password, successorId: member.user.id }, owner.token),
      api.call('account/delete', { password }, member.token),
    ]);
    assert.deepEqual([ownerDelete.status, memberDelete.status].sort(), [204, 409]);
    assert.equal(api.query('SELECT count(*) AS n FROM Households')[0].n, 1);
    assert.equal(api.query("SELECT count(*) AS n FROM Memberships WHERE Role = 'Owner'")[0].n, 1);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});
