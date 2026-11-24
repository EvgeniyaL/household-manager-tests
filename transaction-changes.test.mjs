import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { monthlyBalance } from '../mobile/src/monthlyBalance.ts';
test('authors edit/delete their transactions, enforce ownership and reject stale changes', async () => {
  const api = await createApi();
  try {
    await api.start();
    const register = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await register('owner@example.com'), member = await register('maya@example.com'), other = await register('other@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const base = `households/${household.id}`;
    const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
    await api.call('invites/redeem', { code: invite.code }, member.token);
    const current = async token => (await (await api.call('households/current', undefined, token)).json()).household.budget.entries;
    for (const type of ['Expense', 'Income']) {
      const payload = { id: randomUUID(), amountMinor: 10000, category: type === 'Income' ? 'Salary' : 'Groceries', occurredOn: '2026-11-15', authorName: 'Maya', note: 'Original' };
      const created = await (await api.call(`${base}/${type === 'Income' ? 'incomes' : 'expenses'}`, payload, member.token)).json();
      const path = `${base}/transactions/${created.id}`;
      const edit = { revision: created.revision, amountMinor: 20000, category: payload.category, occurredOn: '2026-11-15', note: 'Corrected' };
      assert.equal((await api.call(`${path}/edit`, edit)).status, 401);
      for (const person of [other]) {
        assert.equal((await api.call(`${path}/edit`, edit, person.token)).status, 403);
        assert.equal((await api.call(`${path}/delete`, { revision: created.revision }, person.token)).status, 403);
      }
      const view = await (await api.call(path, undefined, owner.token)).json();
      assert.equal(view.canEdit, true);
      assert.equal((await (await api.call(path, undefined, member.token)).json()).canEdit, true);
      for (const invalid of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: 100000000000 }, { occurredOn: '2026-02-30' }, { category: type === 'Income' ? 'Groceries' : 'Salary' }, { note: 'x'.repeat(501) }])
        assert.equal((await api.call(`${path}/edit`, { ...edit, ...invalid }, member.token)).status, 400);
      const updatedResponse = await api.call(`${path}/edit`, edit, member.token);
      assert.equal(updatedResponse.status, 200);
      const updated = await updatedResponse.json();
      assert.equal(updated.amountMinor, type === 'Income' ? 20000 : -20000);
      assert.equal(updated.authorName, 'Maya');
      assert.equal(updated.authorAccountId, member.user.id);
      assert.equal((await api.call(`${path}/edit`, edit, member.token)).status, 200);
      assert.equal((await api.call(`${path}/edit`, { ...edit, amountMinor: 30000 }, member.token)).status, 409);
      assert.equal((await api.call(`${path}/delete`, { revision: created.revision }, member.token)).status, 409);
      assert.deepEqual(await current(owner.token), await current(member.token));
      assert.equal(monthlyBalance(await current(owner.token), '2026-11'), updated.amountMinor);
      const moved = await (await api.call(`${path}/edit`, { ...edit, revision: updated.revision, occurredOn: '2026-12-01' }, member.token)).json();
      assert.equal(monthlyBalance(await current(owner.token), '2026-11'), 0);
      assert.equal(monthlyBalance(await current(owner.token), '2026-12'), updated.amountMinor);
      await api.stop(); await api.start();
      assert.equal((await (await api.call(path, undefined, member.token)).json()).entry.description, 'Corrected');
      assert.equal((await api.call(`${path}/delete`, { revision: moved.revision }, member.token)).status, 204);
      assert.equal((await api.call(`${path}/delete`, { revision: moved.revision }, member.token)).status, 404);
      assert.equal((await current(owner.token)).length, 0);
      assert.equal((await api.call(`${path}/edit`, edit, member.token)).status, 404);
    }
    const created = await (await api.call(`${base}/expenses`, { id: randomUUID(), amountMinor: 1, category: 'Other', occurredOn: '2026-11-15', authorName: 'Maya' }, member.token)).json();
    const path = `${base}/transactions/${created.id}`;
    await api.call(`${base}/members/${member.user.id}/remove`, {}, owner.token);
    assert.equal((await api.call(`${path}/edit`, { revision: created.revision, amountMinor: 2, category: 'Other', occurredOn: '2026-11-15' }, member.token)).status, 403);
    assert.equal((await api.call(`${path}/delete`, { revision: created.revision }, member.token)).status, 403);
  } finally { await api.dispose(); }
});

test('household owners correct and delete member entries without changing attribution', async () => {
  const api = await createApi();
  try {
    await api.start();
    const register = async email => (await api.call('auth/register', { email, password: 'correct horse battery staple' })).json();
    const owner = await register('owner@example.com'), member = await register('maya@example.com'), peer = await register('peer@example.com'), foreignOwner = await register('foreign@example.com');
    const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
    const foreign = await (await api.call('households', { name: 'Other family' }, foreignOwner.token)).json();
    const base = `households/${household.id}`;
    for (const person of [member, peer]) {
      const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
      assert.equal((await api.call('invites/redeem', { code: invite.code }, person.token)).status, 200);
    }
    const current = async token => (await (await api.call('households/current', undefined, token)).json()).household.budget.entries;
    for (const income of [false, true]) {
      const created = await (await api.call(`${base}/${income ? 'incomes' : 'expenses'}`, { id: randomUUID(), amountMinor: 10000, category: income ? 'Salary' : 'Groceries', occurredOn: '2026-11-15', authorName: 'Maya Taylor', note: 'Original' }, member.token)).json();
      const path = `${base}/transactions/${created.id}`;
      const edit = { revision: created.revision, amountMinor: 15000, category: created.category, occurredOn: created.occurredOn, note: 'Owner correction' };
      assert.equal((await (await api.call(path, undefined, owner.token)).json()).canEdit, true);
      assert.equal((await (await api.call(path, undefined, peer.token)).json()).canEdit, false);
      for (const person of [peer, foreignOwner]) {
        assert.equal((await api.call(`${path}/edit`, edit, person.token)).status, 403);
        assert.equal((await api.call(`${path}/delete`, { revision: created.revision }, person.token)).status, 403);
      }
      // US-09B: a regular household member cannot bypass the read-only screen,
      // including by submitting unchanged values or spoofing author/owner fields.
      const beforeDeniedRequests = await current(owner.token);
      const deniedEdit = await api.call(`${path}/edit`, {
        ...edit, amountMinor: Math.abs(created.amountMinor), note: created.description,
        authorAccountId: peer.user.id, role: 'Owner', canEdit: true,
      }, peer.token);
      assert.equal(deniedEdit.status, 403);
      const deniedDelete = await api.call(`${path}/delete`, {
        revision: created.revision, authorAccountId: peer.user.id, role: 'Owner',
      }, peer.token);
      assert.equal(deniedDelete.status, 403);
      assert.deepEqual(await current(owner.token), beforeDeniedRequests);
      const peerDetails = await (await api.call(path, undefined, peer.token)).json();
      assert.equal(peerDetails.canEdit, false);
      assert.equal(peerDetails.entry.authorAccountId, member.user.id);
      assert.equal(peerDetails.entry.authorName, 'Maya Taylor');
      assert.equal((await api.call(`households/${foreign.id}/transactions/${created.id}/edit`, edit, foreignOwner.token)).status, 404);
      assert.equal((await api.call(`households/${foreign.id}/transactions/${created.id}/delete`, { revision: created.revision }, foreignOwner.token)).status, 404);
      const response = await api.call(`${path}/edit`, edit, owner.token);
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.authorAccountId, member.user.id);
      assert.equal(updated.authorName, 'Maya Taylor');
      assert.equal(updated.amountMinor, income ? 15000 : -15000);
      assert.deepEqual(await current(member.token), await current(owner.token));
      assert.equal(monthlyBalance(await current(peer.token), '2026-11'), updated.amountMinor);
      assert.equal((await api.call(`${path}/edit`, { ...edit, amountMinor: 20000 }, member.token)).status, 409);
      assert.equal((await api.call(`${path}/delete`, { revision: created.revision }, owner.token)).status, 409);
      if (income) {
        await api.call(`${base}/members/${member.user.id}/remove`, {}, owner.token);
        const corrected = await (await api.call(`${path}/edit`, { ...edit, revision: updated.revision, amountMinor: 16000 }, owner.token)).json();
        assert.equal(corrected.authorName, 'Maya Taylor');
        assert.equal(corrected.authorAccountId, member.user.id);
        assert.equal(corrected.amountMinor, 16000);
        updated.revision = corrected.revision;
      }
      assert.equal((await api.call(`${path}/delete`, { revision: updated.revision }, owner.token)).status, 204);
      assert.equal(monthlyBalance(await current(peer.token), '2026-11'), 0);
      assert.equal((await current(owner.token)).length, 0);
    }
  } finally { await api.dispose(); }
});
