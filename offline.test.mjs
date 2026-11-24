import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { initOffline, enqueue, pendingEntries, mergePending, createUploader } from '../mobile/src/outbox.ts';
function adapter(raw) {
  return { execSync: sql => raw.exec(sql), runSync: (sql, ...p) => raw.prepare(sql).run(...p), getAllSync: (sql, ...p) => raw.prepare(sql).all(...p), getFirstSync: (sql, ...p) => raw.prepare(sql).get(...p) ?? null };
}
const payload = () => ({ id: randomUUID(), amountMinor: 1234, category: 'Groceries', occurredOn: '2026-11-16', note: 'Offline shop', authorName: 'Maya' });
test('persistent queue survives restart, isolates accounts, retains rejection, and serializes upload', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'offline-budget-'));
  let raw = new DatabaseSync(join(folder, 'offline.db'));
  try {
    let db = adapter(raw); initOffline(db);
    const first = payload(), other = payload();
    enqueue(db, 'one', 'family', 'Expense', first);
    enqueue(db, 'one', 'family', 'Expense', first);
    assert.throws(() => enqueue(db, 'one', 'family', 'Expense', { ...first, amountMinor: 999 }), /different values/);
    enqueue(db, 'two', 'family', 'Expense', other);
    raw.close(); raw = new DatabaseSync(join(folder, 'offline.db')); db = adapter(raw); initOffline(db);
    assert.equal(pendingEntries(db, 'one', 'family').length, 1);
    assert.equal(pendingEntries(db, 'one', 'family')[0].amountMinor, -1234);
    assert.equal(pendingEntries(db, 'one', 'other').length, 0);
    const upload = createUploader(db);
    await upload('one', async () => { throw new Error('Offline'); }, async () => true);
    assert.equal(pendingEntries(db, 'one', 'family').length, 1);
    let requests = 0;
    await Promise.all([upload('one', async () => { requests++; await Promise.resolve(); }, async () => true), upload('one', async () => { requests++; }, async () => true)]);
    assert.equal(requests, 1);
    assert.equal(pendingEntries(db, 'one', 'family').length, 0);
    assert.equal(pendingEntries(db, 'two', 'family').length, 1);
    await upload('two', async () => { throw Object.assign(new Error('Household access removed'), { status: 403 }); }, async () => true);
    assert.match(pendingEntries(db, 'two', 'family')[0].syncError, /access removed/);
    await upload('two', async () => { throw new Error('should not retry permanent failure'); }, async () => true);
    enqueue(db, 'one', 'family', 'Income', { ...payload(), category: 'Salary' });
    assert.equal(pendingEntries(db, 'one', 'family')[0].amountMinor, 1234);
    assert.equal(mergePending([{ id: first.id }], [{ id: first.id }]).length, 1);
    await upload('one', async () => { throw new Error('must not upload after logout'); }, async () => false);
    assert.equal(pendingEntries(db, 'one', 'family').length, 1);
  } finally { raw.close(); await rm(folder, { recursive: true, force: true }); }
});
test('lost upload response retries exactly once in budget, even after server edit or deletion', async () => {
  const api = await createApi();
  const raw = new DatabaseSync(':memory:'); const db = adapter(raw); initOffline(db);
  try {
    await api.start();
    const reg = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await reg('owner@example.com'), member = await reg('member@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const base = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    const current = async () => (await (await api.call('households/current', undefined, owner.token)).json()).household.budget.entries;
    const upload = createUploader(db);
    for (const income of [false, true]) {
      const p = { ...payload(), category: income ? 'Salary' : 'Groceries' };
      enqueue(db, member.user.id, household.id, income ? 'Income' : 'Expense', p);
      const send = async row => {
        const response = await api.call(`${base}/${income ? 'incomes' : 'expenses'}`, JSON.parse(row.payload), member.token);
        if (!response.ok) throw Object.assign(new Error('Rejected'), { status: response.status });
        return response.json();
      };
      await upload(member.user.id, async row => { await send(row); throw new Error('Response lost'); }, async () => true);
      assert.equal(pendingEntries(db, member.user.id, household.id).length, 1);
      let entries = await current();
      const entry = entries.find(e => e.id === p.id);
      assert.ok(entry);
      const path = `${base}/transactions/${p.id}`;
      if (income) assert.equal((await api.call(`${path}/delete`, { revision: entry.revision }, owner.token)).status, 204);
      else assert.equal((await api.call(`${path}/edit`, { revision: entry.revision, amountMinor: 2000, category: p.category, occurredOn: p.occurredOn, note: p.note }, owner.token)).status, 200);
      await api.stop(); await api.start();
      await upload(member.user.id, async row => { await send(row); }, async () => true);
      assert.equal(pendingEntries(db, member.user.id, household.id).length, 0);
      entries = await current();
      if (income) assert.equal(entries.some(e => e.id === p.id), false, 'retry must not recreate deleted entry');
      else { assert.equal(entries.filter(e => e.id === p.id).length, 1); assert.equal(entries.find(e => e.id === p.id).amountMinor, -2000); }
      assert.equal((await api.call(`${base}/${income ? 'incomes' : 'expenses'}`, { ...p, amountMinor: 999 }, member.token)).status, 409);
    }
  } finally { raw.close(); await api.dispose(); }
});
